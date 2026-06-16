import { buildTextBatch } from './TextPayload.js';
import {
    TEXT_FORMAT,
    MAX_CLIPBOARD_ITEMS,
    MAX_CLIPBOARD_ITEM_BYTES,
} from '@shared/constants.js';

/**
 * ClipboardPayload — clipboard sharing (Feature 8).
 *
 * The clipboard is a *source*, not a new wire type: pasted plain text becomes a
 * TEXT transfer (riding the same engine + XSS-safe preview as Feature 7), and pasted
 * images/files become an ordinary FILES batch (same encrypted, verified, resumable
 * per-file engine). This keeps clipboard sharing fully end-to-end-encrypted and
 * preview-before-accept with zero new protocol surface.
 *
 * This module splits cleanly into:
 *   - `readClipboard()` — the small, defensive DOM/browser-API reader with graceful
 *     fallbacks across browsers (async clipboard `read()` for images, `readText()`
 *     for text), normalizing everything into a plain `items` array; and
 *   - `clipboardItemsToBatch(items)` — a PURE, unit-testable function that turns that
 *     normalized array into a transfer batch.
 *
 * A normalized clipboard item is one of:
 *   { kind: 'text', text: string }
 *   { kind: 'image', blob: Blob, name?: string, type?: string }
 *   { kind: 'file',  file: File }
 */

const IMAGE_EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
};

function imageExtFor(type) {
    return IMAGE_EXT[type] || (typeof type === 'string' && type.startsWith('image/')
        ? type.slice('image/'.length).replace(/[^a-z0-9]/gi, '') || 'bin'
        : 'bin');
}

/** Is the clipboard read API usable in this environment? (capability probe) */
export function isClipboardReadSupported() {
    return typeof navigator !== 'undefined'
        && !!navigator.clipboard
        && (typeof navigator.clipboard.read === 'function'
            || typeof navigator.clipboard.readText === 'function');
}

/**
 * Read the system clipboard into a normalized `items` array (Feature 8).
 *
 * Cross-browser strategy:
 *   1. Prefer the async `navigator.clipboard.read()` (Chromium, Safari) which can
 *      yield images and rich content as ClipboardItems.
 *   2. Always also try `readText()` so plain-text clipboards work everywhere the
 *      Clipboard API exists (e.g. Firefox, where `read()` is gated/absent).
 *   3. A passed-in `ClipboardEvent` (from an onPaste handler) is honored as a
 *      fallback for browsers that block programmatic reads without a user gesture.
 *
 * Never throws: on any permission/unsupported error it returns an empty array, so
 * the caller can show a "couldn't read clipboard — paste manually" hint.
 *
 * @param {ClipboardEvent} [pasteEvent] - optional paste event for the gesture path
 * @returns {Promise<Array<object>>} normalized items (possibly empty)
 */
export async function readClipboard(pasteEvent) {
    const items = [];

    // Path A: a real paste event (most permissive, no extra permission prompt).
    if (pasteEvent?.clipboardData) {
        const dt = pasteEvent.clipboardData;
        for (const file of Array.from(dt.files || [])) {
            items.push(file.type.startsWith('image/')
                ? { kind: 'image', blob: file, type: file.type, name: file.name }
                : { kind: 'file', file });
        }
        if (items.length === 0) {
            const text = dt.getData('text/plain');
            if (text) items.push({ kind: 'text', text });
        }
        if (items.length > 0) return items.slice(0, MAX_CLIPBOARD_ITEMS);
    }

    // Path B: async Clipboard API (images + rich content).
    if (typeof navigator !== 'undefined' && navigator.clipboard?.read) {
        try {
            const clipboardItems = await navigator.clipboard.read();
            for (const ci of clipboardItems) {
                const imageType = ci.types.find((t) => t.startsWith('image/'));
                if (imageType) {
                    const blob = await ci.getType(imageType);
                    items.push({ kind: 'image', blob, type: imageType });
                } else if (ci.types.includes('text/plain')) {
                    const blob = await ci.getType('text/plain');
                    items.push({ kind: 'text', text: await blob.text() });
                }
            }
            if (items.length > 0) return items.slice(0, MAX_CLIPBOARD_ITEMS);
        } catch { /* permission denied or unsupported — fall through to text */ }
    }

    // Path C: plain-text only (Firefox and any browser without read()).
    if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
        try {
            const text = await navigator.clipboard.readText();
            if (text) items.push({ kind: 'text', text });
        } catch { /* permission denied — caller will hint manual paste */ }
    }

    return items.slice(0, MAX_CLIPBOARD_ITEMS);
}

/** Human-readable summary of clipboard contents for a confirm-before-send UI. */
export function summarizeClipboard(items) {
    const texts = items.filter((i) => i.kind === 'text').length;
    const images = items.filter((i) => i.kind === 'image').length;
    const files = items.filter((i) => i.kind === 'file').length;
    const parts = [];
    if (texts) parts.push(`${texts} text snippet${texts === 1 ? '' : 's'}`);
    if (images) parts.push(`${images} image${images === 1 ? '' : 's'}`);
    if (files) parts.push(`${files} file${files === 1 ? '' : 's'}`);
    return parts.join(' · ') || 'nothing';
}

/**
 * Convert a normalized clipboard `items` array into a transfer batch (PURE).
 *
 * Rules:
 *   - A single text item → a TEXT batch (preview-friendly, like Feature 7).
 *   - Otherwise → a FILES batch: each image becomes a named image file, each file is
 *     included as-is, and any text items are written as `clipboard-text-N.txt`.
 *
 * Per-item size and count ceilings bound how much pasted content is staged in memory.
 *
 * @param {Array<object>} items - normalized clipboard items
 * @returns {{ batch: object, sendOptions: object }} batch + send options
 * @throws {Error} if there is nothing usable, or an item exceeds the size cap
 */
export function clipboardItemsToBatch(items) {
    const list = Array.isArray(items) ? items.slice(0, MAX_CLIPBOARD_ITEMS) : [];
    if (list.length === 0) throw new Error('The clipboard is empty or could not be read.');

    // Fast path: a single plain-text clipboard → a previewable text transfer.
    if (list.length === 1 && list[0].kind === 'text') {
        const batch = buildTextBatch(list[0].text, TEXT_FORMAT.PLAIN);
        return { batch, sendOptions: { transferType: 'text', textFormat: TEXT_FORMAT.PLAIN } };
    }

    // Otherwise: build a files batch from images / files / extra text snippets.
    const files = [];
    let imageN = 0;
    let textN = 0;
    for (const item of list) {
        if (item.kind === 'image' && item.blob) {
            if (item.blob.size > MAX_CLIPBOARD_ITEM_BYTES) throw new Error('A pasted image is too large to send.');
            imageN += 1;
            const ext = imageExtFor(item.type || item.blob.type);
            const name = item.name || `clipboard-image-${imageN}.${ext}`;
            const file = item.blob instanceof File
                ? item.blob
                : new File([item.blob], name, { type: item.type || item.blob.type || 'application/octet-stream' });
            files.push({ file, relativePath: file.name || name, size: file.size });
        } else if (item.kind === 'file' && item.file) {
            if (item.file.size > MAX_CLIPBOARD_ITEM_BYTES) throw new Error('A pasted file is too large to send.');
            files.push({ file: item.file, relativePath: item.file.name, size: item.file.size });
        } else if (item.kind === 'text' && item.text) {
            textN += 1;
            const bytes = new TextEncoder().encode(item.text);
            if (bytes.byteLength > MAX_CLIPBOARD_ITEM_BYTES) throw new Error('A pasted text snippet is too large to send.');
            const name = `clipboard-text-${textN}.txt`;
            const file = new File([bytes], name, { type: 'text/plain' });
            files.push({ file, relativePath: name, size: file.size });
        }
    }

    if (files.length === 0) throw new Error('Nothing on the clipboard could be sent.');

    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    const name = files.length === 1 ? files[0].relativePath : `clipboard (${files.length} items)`;
    return {
        batch: { files, directories: [], totalFiles: files.length, totalBytes, name },
        sendOptions: { transferType: 'files' },
    };
}
