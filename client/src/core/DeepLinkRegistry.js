import { DEEP_LINK_DEFAULT_TTL_MS } from '@shared/constants.js';

/**
 * DeepLinkRegistry — issuer-side tracking of QR / deep-link tokens (Feature 13).
 *
 * Lets the device that GENERATED a QR enforce three things the URL alone cannot:
 *   - expiry  — a token past its `expiresAt` is no longer usable;
 *   - single-use — a token marked single-use becomes unusable after one consume();
 *   - revocation — the issuer can invalidate a specific QR immediately.
 *
 * Scope of the guarantee: this is a LOCAL, issuer-side ledger (the join itself is
 * still gated by the signaling server's short-lived session + the per-connection
 * SAS/MITM check). It is the right place to gate "should I keep honoring this QR I
 * handed out" and to power a "revoke link" button. It is intentionally NOT a global
 * distributed nonce store — see docs for that limitation.
 *
 * Storage is injectable (default: localStorage with a safe in-memory fallback) so
 * the registry is fully unit-testable without a DOM. Expired entries are swept
 * lazily on read/write to keep the store bounded.
 */

const STORE_KEY = 'linkspan-deeplink-tokens';
const MAX_ENTRIES = 200;

/** A minimal localStorage-or-memory key/value store, defensive like DeviceIdentity. */
function defaultStore() {
    let mem = null;
    const useLs = (() => {
        try { return typeof localStorage !== 'undefined' && !!localStorage; } catch { return false; }
    })();
    return {
        get() {
            if (useLs) {
                try { return localStorage.getItem(STORE_KEY); } catch { /* fall through */ }
            }
            return mem;
        },
        set(value) {
            if (useLs) {
                try { localStorage.setItem(STORE_KEY, value); return; } catch { /* fall through */ }
            }
            mem = value;
        },
    };
}

export class DeepLinkRegistry {
    /** @param {{get,set}} [store] - injectable backing store (tests pass a fake) */
    constructor(store = defaultStore()) {
        this._store = store;
    }

    _read() {
        try {
            const raw = this._store.get();
            const obj = raw ? JSON.parse(raw) : {};
            return obj && typeof obj === 'object' ? obj : {};
        } catch {
            return {};
        }
    }

    _write(map) {
        try { this._store.set(JSON.stringify(map)); } catch { /* best-effort */ }
    }

    /** Drop expired entries and cap total size (oldest-expiring evicted first). */
    _sweep(map, now) {
        for (const [token, rec] of Object.entries(map)) {
            if (rec.expiresAt != null && now >= rec.expiresAt) delete map[token];
        }
        const tokens = Object.keys(map);
        if (tokens.length > MAX_ENTRIES) {
            tokens
                .sort((a, b) => (map[a].expiresAt ?? Infinity) - (map[b].expiresAt ?? Infinity))
                .slice(0, tokens.length - MAX_ENTRIES)
                .forEach((t) => delete map[t]);
        }
        return map;
    }

    /**
     * Record a freshly issued token.
     * @param {string} token
     * @param {{ expiresAt?: number|null, singleUse?: boolean, action?: string, code?: string, now?: number }} [meta]
     */
    issue(token, meta = {}) {
        if (!token) return;
        const now = meta.now ?? Date.now();
        const map = this._sweep(this._read(), now);
        map[token] = {
            issuedAt: now,
            expiresAt: meta.expiresAt ?? (now + DEEP_LINK_DEFAULT_TTL_MS),
            singleUse: !!meta.singleUse,
            action: meta.action || null,
            code: meta.code || null,
            used: false,
            revoked: false,
        };
        this._write(this._sweep(map, now));
    }

    /** Is a token currently usable (issued, not expired, not used-up, not revoked)? */
    isUsable(token, now = Date.now()) {
        if (!token) return false;
        const map = this._read();
        const rec = map[token];
        if (!rec) return false;
        if (rec.revoked) return false;
        if (rec.expiresAt != null && now >= rec.expiresAt) return false;
        if (rec.singleUse && rec.used) return false;
        return true;
    }

    /**
     * Atomically consume a token. Returns true if it WAS usable (and marks single-use
     * tokens used); false if it was expired/revoked/already-consumed/unknown.
     */
    consume(token, now = Date.now()) {
        if (!token) return false;
        const map = this._sweep(this._read(), now);
        const rec = map[token];
        if (!rec || rec.revoked) { this._write(map); return false; }
        if (rec.expiresAt != null && now >= rec.expiresAt) { delete map[token]; this._write(map); return false; }
        if (rec.singleUse && rec.used) { this._write(map); return false; }
        rec.used = true;
        rec.usedAt = now;
        this._write(map);
        return true;
    }

    /** Revoke a token immediately (the "revoke this QR" action). */
    revoke(token, now = Date.now()) {
        if (!token) return;
        const map = this._sweep(this._read(), now);
        if (map[token]) { map[token].revoked = true; this._write(map); }
    }

    /** List currently-tracked (non-expired) tokens, newest first. */
    list(now = Date.now()) {
        const map = this._sweep(this._read(), now);
        this._write(map);
        return Object.entries(map)
            .map(([token, rec]) => ({ token, ...rec }))
            .sort((a, b) => b.issuedAt - a.issuedAt);
    }

    /** Forget every issued token. */
    clear() {
        this._write({});
    }
}
