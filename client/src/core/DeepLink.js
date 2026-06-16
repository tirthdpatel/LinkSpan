import {
    DEEP_LINK_ACTION,
    DEEP_LINK_PARAM,
    DEEP_LINK_TOKEN_BYTES,
    DEEP_LINK_DEFAULT_TTL_MS,
    PAIRING_CODE_LENGTH,
} from '@shared/constants.js';

/**
 * DeepLink — build and parse QR / share deep links (Feature 13).
 *
 * A deep link is an ordinary https URL to the app carrying everything a scanning
 * device needs to auto-join: an action, the pairing `code`, and an expiring,
 * optionally single-use token. The QR encodes this URL; the receiver's scanner (or a
 * normal browser visit) parses it and auto-connects.
 *
 * Why a token + expiry on top of the pairing code:
 *   - The pairing code already maps to ONE short-lived signaling session (the server
 *     enforces SESSION_TOKEN_TTL_MS and at most two peers), so a code is the real
 *     join credential.
 *   - The token + `exp` let the ISSUER additionally (a) bound how long a leaked /
 *     over-the-shoulder QR stays useful and (b) REVOKE a specific QR locally
 *     ([[DeepLinkRegistry]]), and mark single-use QRs consumed after one scan.
 *
 * This module is pure (URL string in / structured data out). Single-use + revocation
 * enforcement lives in DeepLinkRegistry; expiry is checked here from `exp`.
 *
 * Backward compatibility: a bare `?code=NNNNNN` link (the original QR format) parses
 * as a PAIR action with no token/expiry, so existing QR codes keep working.
 */

const VALID_ACTIONS = new Set(Object.values(DEEP_LINK_ACTION));

/** Mint a random opaque token (hex). Cryptographically strong. */
export function mintToken(bytes = DEEP_LINK_TOKEN_BYTES) {
    const arr = new Uint8Array(bytes);
    (globalThis.crypto || crypto).getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

function resolveOrigin(origin) {
    if (origin) return String(origin).replace(/\/+$/, '');
    if (typeof window !== 'undefined' && window.location?.origin) {
        return window.location.origin.replace(/\/+$/, '');
    }
    return 'https://linkspan.app';
}

function isValidCode(code) {
    return typeof code === 'string' && new RegExp(`^\\d{${PAIRING_CODE_LENGTH}}$`).test(code);
}

/**
 * Build a deep-link URL string for a QR / share action (Feature 13).
 *
 * @param {object} opts
 * @param {string} opts.code - the 6-digit pairing code (required for pair/transfer)
 * @param {string} [opts.action=DEEP_LINK_ACTION.PAIR]
 * @param {string} [opts.token] - opaque token; minted if omitted and ttl>0
 * @param {number} [opts.ttlMs=DEEP_LINK_DEFAULT_TTL_MS] - lifetime; 0 = no expiry
 * @param {number} [opts.now=Date.now()] - clock injection for tests
 * @param {boolean} [opts.singleUse=false]
 * @param {string} [opts.origin] - base origin; defaults to window.location.origin
 * @returns {{ url: string, token: string|null, expiresAt: number|null, action: string, singleUse: boolean }}
 */
export function buildDeepLink({
    code,
    action = DEEP_LINK_ACTION.PAIR,
    token,
    ttlMs = DEEP_LINK_DEFAULT_TTL_MS,
    now = Date.now(),
    singleUse = false,
    origin,
} = {}) {
    if (!VALID_ACTIONS.has(action)) throw new Error(`Unknown deep-link action: ${action}`);
    if ((action === DEEP_LINK_ACTION.PAIR || action === DEEP_LINK_ACTION.TRANSFER) && !isValidCode(code)) {
        throw new Error('A valid 6-digit pairing code is required.');
    }

    const base = resolveOrigin(origin);
    const u = new URL(base + '/');
    const p = u.searchParams;

    // `code` kept verbatim for backward compatibility with old QR links.
    if (code) p.set(DEEP_LINK_PARAM.CODE, code);
    if (action !== DEEP_LINK_ACTION.PAIR) p.set(DEEP_LINK_PARAM.ACTION, action);

    let expiresAt = null;
    let usedToken = null;
    if (ttlMs > 0) {
        usedToken = token || mintToken();
        expiresAt = now + ttlMs;
        p.set(DEEP_LINK_PARAM.TOKEN, usedToken);
        p.set(DEEP_LINK_PARAM.EXPIRES, String(expiresAt));
        if (singleUse) p.set(DEEP_LINK_PARAM.SINGLE_USE, '1');
    }

    return { url: u.toString(), token: usedToken, expiresAt, action, singleUse: !!singleUse };
}

/**
 * Parse a scanned/visited deep link into structured, validated fields (Feature 13).
 *
 * Accepts either a full URL or a bare 6-digit code. Validates the action whitelist
 * and code format, and computes whether the link is expired (from `exp`). Returns a
 * normalized descriptor; callers gate on `ok` and `expired` before joining.
 *
 * @param {string} input - URL string or raw pairing code
 * @param {number} [now=Date.now()]
 * @returns {{
 *   ok: boolean, reason: string|null,
 *   action: string, code: string|null, token: string|null,
 *   expiresAt: number|null, singleUse: boolean, expired: boolean
 * }}
 */
export function parseDeepLink(input, now = Date.now()) {
    const fail = (reason) => ({
        ok: false, reason, action: DEEP_LINK_ACTION.PAIR,
        code: null, token: null, expiresAt: null, singleUse: false, expired: false,
    });

    const raw = String(input ?? '').trim();
    if (!raw) return fail('empty');

    // Bare pairing code (legacy QR / manual entry).
    if (isValidCode(raw)) {
        return {
            ok: true, reason: null, action: DEEP_LINK_ACTION.PAIR,
            code: raw, token: null, expiresAt: null, singleUse: false, expired: false,
        };
    }

    let u;
    try {
        u = new URL(raw);
    } catch {
        return fail('unparseable');
    }
    const p = u.searchParams;

    const action = p.get(DEEP_LINK_PARAM.ACTION) || DEEP_LINK_ACTION.PAIR;
    if (!VALID_ACTIONS.has(action)) return fail('unknown-action');

    const code = p.get(DEEP_LINK_PARAM.CODE);
    if ((action === DEEP_LINK_ACTION.PAIR || action === DEEP_LINK_ACTION.TRANSFER) && !isValidCode(code)) {
        return fail('invalid-code');
    }

    const token = p.get(DEEP_LINK_PARAM.TOKEN);
    const expRaw = p.get(DEEP_LINK_PARAM.EXPIRES);
    const expiresAt = expRaw && /^\d+$/.test(expRaw) ? Number(expRaw) : null;
    const singleUse = p.get(DEEP_LINK_PARAM.SINGLE_USE) === '1';
    const expired = expiresAt != null && now >= expiresAt;

    return {
        ok: true, reason: null,
        action, code: isValidCode(code) ? code : null,
        token, expiresAt, singleUse, expired,
    };
}

/** Convenience: is a parsed link past its expiry? */
export function isExpired(link, now = Date.now()) {
    return !!link && link.expiresAt != null && now >= link.expiresAt;
}
