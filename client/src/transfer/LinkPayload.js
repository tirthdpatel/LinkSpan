import {
    TRANSFER_TYPE,
    SAFE_URL_PROTOCOLS,
    MAX_URL_LENGTH,
    MAX_LINK_TITLE_LENGTH,
    MAX_LINK_DESCRIPTION_LENGTH,
    MAX_LINK_SITENAME_LENGTH,
} from '@shared/constants.js';
import { escapeHtml } from './TextPayload.js';

/**
 * LinkPayload — dedicated URL/link sharing (Feature 9).
 *
 * A shared link rides the exact same encrypted, integrity-verified transfer engine
 * as a file: we wrap a small JSON document describing the link in a single synthetic
 * file and ship it as a one-file batch flagged `transferType: 'link'`. The receiver
 * detects the flag, RE-VALIDATES the URL (never trusting the sender's claim), and
 * shows a preview with the domain, title and metadata plus a one-click "Open".
 *
 * Security model (this module is the trust boundary on the receiver):
 *   - Only http/https URLs are ever accepted or rendered clickable. javascript:,
 *     data:, file:, blob:, vbscript:, etc. are rejected outright — there is no path
 *     by which a malicious sender can get the receiver to navigate to a dangerous
 *     scheme or to inject markup.
 *   - Every displayed field (title, description, site name, the URL itself) is
 *     HTML-escaped before rendering; the href is the parsed, re-validated URL only.
 *   - All inputs are length-bounded to keep the preview cheap and non-abusive.
 *
 * The module is pure (no DOM, no network): it builds the batch, parses the payload
 * back out, validates URLs, and produces safe display fields — all unit-testable.
 */

const LINK_FILE_NAME = 'shared-link.json';

/** Strip control characters and clamp a free-text metadata field. */
function clampField(value, max) {
    if (typeof value !== 'string') return '';
    return value
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, max);
}

/**
 * Validate and canonicalize a URL for sharing.
 *
 * Accepts only absolute http/https URLs within the length cap. A bare host like
 * "example.com" is upgraded to "https://example.com" for convenience. Returns the
 * canonical href on success; `null` (with a reason) on rejection.
 *
 * @param {string} raw
 * @returns {{ ok: boolean, url: string|null, reason: string|null }}
 */
export function validateUrl(raw) {
    const input = String(raw ?? '').trim();
    if (!input) return { ok: false, url: null, reason: 'empty' };
    if (input.length > MAX_URL_LENGTH) return { ok: false, url: null, reason: 'too-long' };
    // Reject anything with whitespace or control characters embedded — these are a
    // classic vector for URL-parsing confusion / header injection.
    // eslint-disable-next-line no-control-regex
    if (/[\s\u0000-\u001f\u007f]/.test(input)) return { ok: false, url: null, reason: 'invalid-characters' };

    // Upgrade a scheme-less host (no "://") to https. We deliberately do NOT treat a
    // leading "//" as scheme-relative — that would inherit the page's scheme and is
    // ambiguous; require an explicit host.
    const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input) ? input : `https://${input}`;

    let parsed;
    try {
        parsed = new URL(candidate);
    } catch {
        return { ok: false, url: null, reason: 'unparseable' };
    }

    if (!SAFE_URL_PROTOCOLS.includes(parsed.protocol)) {
        return { ok: false, url: null, reason: 'unsupported-scheme' };
    }
    if (!parsed.hostname) return { ok: false, url: null, reason: 'no-host' };

    const href = parsed.href;
    if (href.length > MAX_URL_LENGTH) return { ok: false, url: null, reason: 'too-long' };
    return { ok: true, url: href, reason: null };
}

/** Extract the registrable-ish domain (hostname without a leading "www."). */
export function linkDomain(url) {
    try {
        return new URL(url).hostname.replace(/^www\./i, '');
    } catch {
        return '';
    }
}

/**
 * Build a one-file batch carrying a link payload, ready for BatchSender.
 *
 * @param {string} url - the URL to share (validated/canonicalized here)
 * @param {{ title?: string, description?: string, siteName?: string }} [meta]
 * @returns {{ files, directories, totalFiles, totalBytes, name }}
 * @throws {Error} if the URL is missing or not a safe http/https URL
 */
export function buildLinkBatch(url, meta = {}) {
    const { ok, url: canonical, reason } = validateUrl(url);
    if (!ok) {
        if (reason === 'empty') throw new Error('Nothing to send — enter a URL.');
        if (reason === 'unsupported-scheme') throw new Error('Only http and https links can be shared.');
        if (reason === 'too-long') throw new Error('That URL is too long to share.');
        throw new Error('That does not look like a valid URL.');
    }

    const payload = {
        v: 1,
        url: canonical,
        title: clampField(meta.title, MAX_LINK_TITLE_LENGTH),
        description: clampField(meta.description, MAX_LINK_DESCRIPTION_LENGTH),
        siteName: clampField(meta.siteName, MAX_LINK_SITENAME_LENGTH),
    };
    const json = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(json);
    const file = new File([bytes], LINK_FILE_NAME, { type: 'application/json' });

    return {
        files: [{ file, relativePath: LINK_FILE_NAME, size: file.size }],
        directories: [],
        totalFiles: 1,
        totalBytes: file.size,
        name: linkDomain(canonical) || 'shared link',
    };
}

/**
 * Parse a received link-payload blob/string back into safe display fields.
 *
 * Defensive: the URL is RE-VALIDATED here (the sender is untrusted), and every
 * display field is returned both raw (clamped) and HTML-escaped. Returns `null` if
 * the payload is malformed or the URL is not a safe http/https URL — callers should
 * treat a null result as "not a renderable link".
 *
 * @param {string} text - the JSON payload text (see extractLinkText)
 * @returns {null | {
 *   url: string, safeHref: string, domain: string,
 *   title: string, description: string, siteName: string,
 *   titleHtml: string, descriptionHtml: string, siteNameHtml: string, domainHtml: string
 * }}
 */
export function parseLinkPayload(text) {
    let obj;
    try {
        obj = JSON.parse(String(text ?? ''));
    } catch {
        return null;
    }
    if (!obj || typeof obj !== 'object') return null;

    const { ok, url } = validateUrl(obj.url);
    if (!ok) return null;

    const title = clampField(obj.title, MAX_LINK_TITLE_LENGTH);
    const description = clampField(obj.description, MAX_LINK_DESCRIPTION_LENGTH);
    const siteName = clampField(obj.siteName, MAX_LINK_SITENAME_LENGTH);
    const domain = linkDomain(url);

    return {
        url,
        safeHref: url, // already validated to http/https; safe as an href
        domain,
        title,
        description,
        siteName,
        titleHtml: escapeHtml(title),
        descriptionHtml: escapeHtml(description),
        siteNameHtml: escapeHtml(siteName),
        domainHtml: escapeHtml(domain),
    };
}

/** Read a received link-payload blob into its raw JSON string. */
export async function extractLinkText(blob) {
    if (!blob) return '';
    if (typeof blob.text === 'function') return blob.text();
    const buf = await blob.arrayBuffer();
    return new TextDecoder().decode(buf);
}

export { TRANSFER_TYPE };
