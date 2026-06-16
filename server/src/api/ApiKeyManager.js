/**
 * ApiKeyManager — authentication & authorization for the REST API (Feature 17).
 *
 * Two complementary key models, both stateless (no user database required):
 *
 *  1. Signed keys (recommended): an opaque, self-describing token
 *       lk1.<base64url(payload)>.<hmac-sha256>
 *     where payload = { sub: ownerId, scopes: [...], iat }. Verified with API_KEY_SECRET.
 *     Mint with issue() (e.g. from an admin CLI). No storage; revoke via key rotation or
 *     an optional denylist of ownerIds (API_KEY_DENYLIST).
 *
 *  2. Static keys: LINKSPAN_API_KEYS="secretA=ownerA,secretB=ownerB" — a small fixed set
 *     for simple/self-hosted deploys. Compared in constant time; owner scope is full.
 *
 * Anonymous capability mode: when no keys are configured and anonymous access is allowed
 * (default outside production), management calls run without an authenticated owner. Such
 * links are owned by a per-link capability secret (`ownerToken`) returned at creation, so
 * the creator can still revoke/manage them without an account. See ShareLinkRoutes.
 *
 * Scopes: 'links:write', 'links:read', 'sessions:write', or '*'. Enforced by requireScope().
 */

import crypto from 'node:crypto';

const SECRET = process.env.API_KEY_SECRET
    || process.env.TOKEN_SECRET
    || crypto.randomBytes(32).toString('hex');

const PREFIX = 'lk1.';

export class ApiKeyManager {
    /**
     * @param {object} [opts]
     * @param {string} [opts.secret]
     * @param {Record<string,string>} [opts.staticKeys]  secret → ownerId
     * @param {string[]} [opts.denylist]  ownerIds whose keys are rejected
     * @param {boolean} [opts.allowAnonymous]
     */
    constructor(opts = {}) {
        this._secret = opts.secret || SECRET;
        this._staticKeys = opts.staticKeys || parseStaticKeys(process.env.LINKSPAN_API_KEYS);
        this._denylist = new Set(opts.denylist || parseList(process.env.API_KEY_DENYLIST));
        this._allowAnonymous = opts.allowAnonymous ??
            (process.env.API_ALLOW_ANONYMOUS
                ? process.env.API_ALLOW_ANONYMOUS !== 'false'
                : process.env.NODE_ENV !== 'production');
    }

    get allowAnonymous() {
        return this._allowAnonymous;
    }

    /**
     * Mint a signed API key.
     *
     * Pass `expiresInMs` (or an absolute `exp` timestamp) to bound the key's lifetime; an
     * expired key is rejected by authenticate(). Omit both for a non-expiring key (the
     * historical behavior — still useful for static self-host keys, but prefer an expiry
     * for anything externally distributed so a leak is self-limiting).
     *
     * Pass a `jti` to make the key individually identifiable/revocable (e.g. account-issued
     * keys tracked in a store + denylist); it is echoed back on the authenticated principal.
     *
     * @param {{ ownerId: string, scopes?: string[], expiresInMs?: number, exp?: number, jti?: string }} params
     * @returns {string}
     */
    issue({ ownerId, scopes = ['*'], expiresInMs, exp, jti }) {
        if (!ownerId) throw new Error('ownerId required');
        const iat = Date.now();
        const expiry = exp ?? (Number.isFinite(expiresInMs) && expiresInMs > 0 ? iat + expiresInMs : undefined);
        const payload = { sub: ownerId, scopes, iat, ...(expiry ? { exp: expiry } : {}), ...(jti ? { jti } : {}) };
        const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
        return `${PREFIX}${encoded}.${this._hmac(encoded)}`;
    }

    /**
     * Authenticate a bearer key string.
     * @param {string} key
     * @returns {{ ownerId: string, scopes: string[] } | null}
     */
    authenticate(key) {
        if (!key || typeof key !== 'string') return null;

        // Static keys first (constant-time scan).
        for (const [secret, ownerId] of Object.entries(this._staticKeys)) {
            if (timingSafeStrEqual(key, secret)) {
                if (this._denylist.has(ownerId)) return null;
                return { ownerId, scopes: ['*'] };
            }
        }

        // Signed key.
        if (key.startsWith(PREFIX)) {
            const rest = key.slice(PREFIX.length);
            const parts = rest.split('.');
            if (parts.length !== 2) return null;
            const [encoded, sig] = parts;
            if (!timingSafeStrEqual(sig, this._hmac(encoded))) return null;
            let payload;
            try {
                payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
            } catch {
                return null;
            }
            if (!payload.sub || this._denylist.has(payload.sub)) return null;
            // Reject expired keys. Keys minted without `exp` never expire (back-compat).
            if (payload.exp != null && Date.now() > payload.exp) return null;
            return {
                ownerId: payload.sub,
                scopes: Array.isArray(payload.scopes) ? payload.scopes : ['*'],
                ...(payload.jti ? { jti: payload.jti } : {}),
            };
        }

        return null;
    }

    /** Whether a principal's scopes satisfy the required scope. */
    static hasScope(principal, scope) {
        if (!principal) return false;
        return principal.scopes.includes('*') || principal.scopes.includes(scope);
    }

    /**
     * Express middleware: extract + verify a Bearer key.
     * On success sets req.principal = { ownerId, scopes }.
     * If anonymous is allowed and no key is present, sets req.principal = null and continues.
     * Otherwise responds 401.
     */
    middleware() {
        return (req, res, next) => {
            const header = req.headers['authorization'] || '';
            const m = /^Bearer\s+(.+)$/i.exec(header);
            const key = m ? m[1].trim() : (req.headers['x-api-key'] || '').trim();

            if (!key) {
                if (this._allowAnonymous) {
                    req.principal = null;
                    return next();
                }
                return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'API key required.' } });
            }
            const principal = this.authenticate(key);
            if (!principal) {
                return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key.' } });
            }
            req.principal = principal;
            next();
        };
    }

    /** Express middleware: require a specific scope (must run after middleware()). */
    requireScope(scope) {
        return (req, res, next) => {
            // Anonymous principals are allowed through here only when anonymous is enabled;
            // the route then falls back to capability (ownerToken) authorization.
            if (req.principal == null && this._allowAnonymous) return next();
            if (!ApiKeyManager.hasScope(req.principal, scope)) {
                return res.status(403).json({ error: { code: 'FORBIDDEN', message: `Missing scope: ${scope}` } });
            }
            next();
        };
    }

    _hmac(data) {
        return crypto.createHmac('sha256', this._secret).update(data).digest('base64url');
    }
}

function parseStaticKeys(raw) {
    const out = {};
    if (!raw) return out;
    for (const pair of raw.split(',')) {
        const [secret, ownerId] = pair.split('=').map((s) => s && s.trim());
        if (secret && ownerId) out[secret] = ownerId;
    }
    return out;
}

function parseList(raw) {
    return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

function timingSafeStrEqual(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) {
        crypto.timingSafeEqual(ba, ba);
        return false;
    }
    return crypto.timingSafeEqual(ba, bb);
}
