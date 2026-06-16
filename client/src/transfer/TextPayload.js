import { TEXT_FORMAT, MAX_TEXT_PAYLOAD_BYTES } from '@shared/constants.js';

/**
 * TextPayload — dedicated text/clipboard sharing (Feature 7).
 *
 * A text payload rides the exact same encrypted, integrity-verified, resumable
 * transfer engine as a file: we wrap the composed text in a single synthetic File
 * and ship it as a one-file batch, flagged `transferType: 'text'` with a
 * `textFormat`. The receiver detects the flag and shows a preview (copy / save)
 * instead of triggering a download.
 *
 * This module is pure (no DOM, no network) so it is fully unit-testable: it builds
 * the batch, extracts the text back out on the receiver, and renders Markdown to a
 * SAFE HTML string for preview. The Markdown renderer escapes ALL input first and
 * only ever emits a fixed whitelist of tags, with link hrefs restricted to
 * http/https/mailto — there is no path by which sender-controlled text can inject
 * script or arbitrary HTML (XSS-safe).
 */

const FILE_NAMES = {
    [TEXT_FORMAT.PLAIN]: 'shared-text.txt',
    [TEXT_FORMAT.MARKDOWN]: 'shared-text.md',
    [TEXT_FORMAT.CODE]: 'shared-snippet.txt',
};
const MIME_TYPES = {
    [TEXT_FORMAT.PLAIN]: 'text/plain',
    [TEXT_FORMAT.MARKDOWN]: 'text/markdown',
    [TEXT_FORMAT.CODE]: 'text/plain',
};

/** A friendly default filename for a given text format. */
export function textFileName(format) {
    return FILE_NAMES[format] || FILE_NAMES[TEXT_FORMAT.PLAIN];
}

/**
 * Build a one-file batch carrying a text payload, ready for BatchSender.
 * @param {string} text
 * @param {string} [format=TEXT_FORMAT.PLAIN]
 * @returns {{ files, directories, totalFiles, totalBytes, name }}
 * @throws {Error} on empty or oversize text
 */
export function buildTextBatch(text, format = TEXT_FORMAT.PLAIN) {
    const value = String(text ?? '');
    if (value.length === 0) throw new Error('Nothing to send — the text is empty.');

    const bytes = new TextEncoder().encode(value);
    if (bytes.byteLength > MAX_TEXT_PAYLOAD_BYTES) {
        throw new Error('Text is too large — send it as a file instead.');
    }

    const fmt = Object.values(TEXT_FORMAT).includes(format) ? format : TEXT_FORMAT.PLAIN;
    const fileName = textFileName(fmt);
    const file = new File([bytes], fileName, { type: MIME_TYPES[fmt] });

    return {
        files: [{ file, relativePath: fileName, size: file.size }],
        directories: [],
        totalFiles: 1,
        totalBytes: file.size,
        name: fileName,
    };
}

/** Read a received text payload blob back into a string. */
export async function extractText(blob) {
    if (!blob) return '';
    if (typeof blob.text === 'function') return blob.text();
    const buf = await blob.arrayBuffer();
    return new TextDecoder().decode(buf);
}

// ── Safe Markdown rendering ─────────────────────────────────────

/** Escape the five HTML-significant characters. Always called before formatting. */
export function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Only allow safe link protocols; everything else becomes inert text. */
function safeHref(url) {
    const trimmed = String(url).trim();
    if (/^(https?:|mailto:)/i.test(trimmed) && !/[\s"'<>]/.test(trimmed)) {
        // Already inside an escaped context; escape again defensively.
        return escapeHtml(trimmed);
    }
    return null;
}

/** Apply inline Markdown (code, bold, italic, links) to an ALREADY-escaped line. */
function renderInline(escaped) {
    let out = escaped;
    // Inline code first so its contents aren't further formatted.
    out = out.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
    // Links: [text](url) — url validated against a protocol whitelist.
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, url) => {
        const href = safeHref(url);
        if (!href) return label; // drop unsafe links, keep their text
        return `<a href="${href}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`;
    });
    // Bold then italic.
    out = out.replace(/\*\*([^*]+)\*\*/g, (_m, t) => `<strong>${t}</strong>`);
    out = out.replace(/(^|[^*])\*([^*]+)\*/g, (_m, pre, t) => `${pre}<em>${t}</em>`);
    return out;
}

/**
 * Render a Markdown string to a SAFE HTML string. Supports headings, bold, italic,
 * inline code, fenced code blocks, unordered lists, and whitelisted links. Every
 * character of input is HTML-escaped before any tag is emitted, so the output can
 * never contain attacker-controlled markup.
 * @param {string} md
 * @returns {string} safe HTML
 */
export function renderMarkdownSafe(md) {
    const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n');
    const html = [];
    let inCode = false;
    let codeBuf = [];
    let inList = false;

    const closeList = () => { if (inList) { html.push('</ul>'); inList = false; } };

    for (const raw of lines) {
        const fence = raw.match(/^```/);
        if (fence) {
            if (inCode) {
                html.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
                codeBuf = [];
                inCode = false;
            } else {
                closeList();
                inCode = true;
            }
            continue;
        }
        if (inCode) { codeBuf.push(raw); continue; }

        const heading = raw.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
            closeList();
            const level = heading[1].length;
            html.push(`<h${level}>${renderInline(escapeHtml(heading[2]))}</h${level}>`);
            continue;
        }

        const listItem = raw.match(/^\s*[-*+]\s+(.*)$/);
        if (listItem) {
            if (!inList) { html.push('<ul>'); inList = true; }
            html.push(`<li>${renderInline(escapeHtml(listItem[1]))}</li>`);
            continue;
        }

        if (raw.trim() === '') { closeList(); continue; }

        closeList();
        html.push(`<p>${renderInline(escapeHtml(raw))}</p>`);
    }

    if (inCode) html.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
    closeList();
    return html.join('\n');
}
