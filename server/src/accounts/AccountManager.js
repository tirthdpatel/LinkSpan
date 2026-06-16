/**
 * AccountManager — user accounts with email/password (scrypt) and OAuth, short-lived access
 * JWTs and long-lived rotated refresh tokens, plus account-scoped API keys.
 *
 * Tokens:
 *   - Access token: a zero-dependency HMAC-SHA256 JWT (`header.payload.sig`), TTL
 *     ACCESS_TOKEN_TTL_MS, verified statelessly. Carries { sub: accountId, email }.
 *   - Refresh token: an opaque 256-bit random string; only its SHA-256 hash is stored, with
 *     an expiry. Refreshing ROTATES it (old hash deleted, new issued) so a stolen refresh
 *     token is single-use against the legitimate client.
 *
 * Passwords: scrypt(password, per-user salt) → constant-time compare (mirrors ShareLinkManager).
 *
 * All policy lives here; the AccountStore only persists. The manager never returns a
 * password hash/salt or token secret in its public account shape.
 */

import crypto from 'node:crypto';
import {
    ACCESS_TOKEN_TTL_MS,
    REFRESH_TOKEN_TTL_MS,
    MIN_PASSWORD_LENGTH,
    MAX_PASSWORD_LENGTH,
    MAX_EMAIL_LENGTH,
} from '../../../shared/constants.js';
import { hashToken } from './AccountStore.js';

const scrypt = (password, salt) =>
    new Promise((resolve, reject) =>
        crypto.scrypt(password, salt, 32, (err, dk) => (err ? reject(err) : resolve(dk)))
    );

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export class AccountError extends Error {
    constructor(code, message, httpStatus = 400) {
        super(message);
        this.name = 'AccountError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

export class AccountManager {
    /**
     * @param {object} opts
     * @param {import('./AccountStore.js').MemoryAccountStore} opts.store
     * @param {string} [opts.jwtSecret]
     * @param {import('../api/ApiKeyManager.js').ApiKeyManager} [opts.apiKeys]  for account API keys
     * @param {() => number} [opts.now]
     */
    constructor({ store, jwtSecret, apiKeys, now } = {}) {
        if (!store) throw new Error('AccountManager requires a store');
        this._store = store;
        this._secret = jwtSecret
            || process.env.AUTH_JWT_SECRET
            || process.env.TOKEN_SECRET
            || crypto.randomBytes(32).toString('hex');
        this._apiKeys = apiKeys || null;
        this._now = now || Date.now;
    }

    // ── Registration / login ───────────────────────────────────
    async register({ email, password }) {
        const e = this._normalizeEmail(email);
        this._validatePassword(password);
        if (await this._store.getByEmail(e)) {
            throw new AccountError('EMAIL_TAKEN', 'An account with this email already exists', 409);
        }
        const salt = crypto.randomBytes(16).toString('hex');
        const passwordHash = (await scrypt(password, salt)).toString('hex');
        const account = await this._store.createAccount({
            id: `acct_${crypto.randomBytes(12).toString('hex')}`,
            email: e,
            passwordHash,
            passwordSalt: salt,
            provider: null,
            providerId: null,
            createdAt: this._now(),
            active: true,
        });
        return this._issueSession(account);
    }

    async login({ email, password }) {
        const e = this._normalizeEmail(email);
        const account = await this._store.getByEmail(e);
        // Always run scrypt to avoid leaking account existence via timing.
        const salt = account?.passwordSalt || 'no-such-salt';
        const computed = (await scrypt(String(password ?? ''), salt)).toString('hex');
        if (!account || !account.passwordHash || !account.active
            || !timingSafeStrEqual(computed, account.passwordHash)) {
            throw new AccountError('INVALID_CREDENTIALS', 'Invalid email or password', 401);
        }
        return this._issueSession(account);
    }

    // ── OAuth ───────────────────────────────────────────────────
    /**
     * Find or create an account from a verified OAuth identity, then issue a session. Links
     * by provider id first, then by (verified) email, else creates a passwordless account.
     */
    async findOrCreateByOAuth({ provider, providerId, email }) {
        let account = await this._store.getByProvider(provider, providerId);
        if (!account && email) {
            const existing = await this._store.getByEmail(email);
            if (existing) {
                account = await this._store.updateAccount(existing.id, { provider, providerId });
            }
        }
        if (!account) {
            account = await this._store.createAccount({
                id: `acct_${crypto.randomBytes(12).toString('hex')}`,
                email: email ? this._normalizeEmail(email) : `${provider}_${providerId}@oauth.local`,
                passwordHash: null,
                passwordSalt: null,
                provider,
                providerId,
                createdAt: this._now(),
                active: true,
            });
        }
        return this._issueSession(account);
    }

    // ── Sessions (access + refresh) ─────────────────────────────
    async _issueSession(account) {
        const accessToken = this._signJwt({ sub: account.id, email: account.email });
        const refreshToken = crypto.randomBytes(32).toString('hex');
        await this._store.saveRefreshToken(hashToken(refreshToken), account.id, this._now() + REFRESH_TOKEN_TTL_MS);
        return { account: this.toPublic(account), accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_MS };
    }

    /** Rotate a refresh token → a new access + refresh pair. The old refresh token is consumed. */
    async refresh(rawRefreshToken) {
        const h = hashToken(rawRefreshToken || '');
        const entry = await this._store.getRefreshToken(h);
        if (!entry) throw new AccountError('INVALID_REFRESH', 'Invalid or expired refresh token', 401);
        await this._store.deleteRefreshToken(h); // rotation: single-use
        const account = await this._store.getById(entry.accountId);
        if (!account || !account.active) throw new AccountError('INVALID_REFRESH', 'Account unavailable', 401);
        return this._issueSession(account);
    }

    async logout(rawRefreshToken) {
        if (rawRefreshToken) await this._store.deleteRefreshToken(hashToken(rawRefreshToken));
    }

    /** Verify an access JWT. Returns { accountId, email } or null. */
    verifyAccessToken(token) {
        const claims = this._verifyJwt(token);
        if (!claims || !claims.sub) return null;
        return { accountId: claims.sub, email: claims.email };
    }

    async me(accountId) {
        const a = await this._store.getById(accountId);
        return a ? this.toPublic(a) : null;
    }

    // ── Account-scoped API keys ─────────────────────────────────
    async issueApiKey(accountId, { scopes = ['*'], label, expiresInMs } = {}) {
        if (!this._apiKeys) throw new AccountError('UNSUPPORTED', 'API keys are not configured', 500);
        const jti = crypto.randomBytes(12).toString('hex');
        const key = this._apiKeys.issue({ ownerId: accountId, scopes, expiresInMs, jti });
        const record = {
            id: jti, accountId, label: label || null, scopes,
            createdAt: this._now(),
            expiresAt: expiresInMs ? this._now() + expiresInMs : null,
        };
        await this._store.saveApiKey(record);
        return { ...record, key }; // key shown once
    }
    listApiKeys(accountId) { return this._store.listApiKeys(accountId); }
    revokeApiKey(accountId, jti) { return this._store.revokeApiKey(accountId, jti); }
    isApiKeyRevoked(jti) { return this._store.isApiKeyRevoked(jti); }

    // ── OAuth CSRF state (stateless, signed) ────────────────────
    /** Sign a short-lived state token binding the OAuth flow to a provider. */
    signOAuthState(provider) {
        const payload = b64url(JSON.stringify({ p: provider, n: crypto.randomBytes(8).toString('hex'), exp: this._now() + 10 * 60 * 1000 }));
        return `${payload}.${this._jwtSig(payload)}`;
    }
    /** Verify a state token; returns the provider it was issued for, or null. */
    verifyOAuthState(state) {
        if (typeof state !== 'string' || !state.includes('.')) return null;
        const [payload, sig] = state.split('.');
        if (!timingSafeStrEqual(sig, this._jwtSig(payload))) return null;
        let claims;
        try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
        if (!claims.exp || this._now() > claims.exp) return null;
        return claims.p;
    }

    toPublic(account) {
        return {
            id: account.id,
            email: account.email,
            provider: account.provider || null,
            createdAt: account.createdAt,
        };
    }

    // ── Validation ──────────────────────────────────────────────
    _normalizeEmail(email) {
        const e = String(email || '').trim().toLowerCase();
        if (!e || e.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(e)) {
            throw new AccountError('INVALID_EMAIL', 'A valid email is required', 400);
        }
        return e;
    }
    _validatePassword(password) {
        const p = String(password ?? '');
        if (p.length < MIN_PASSWORD_LENGTH || p.length > MAX_PASSWORD_LENGTH) {
            throw new AccountError('WEAK_PASSWORD', `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters`, 400);
        }
    }

    // ── Minimal HMAC JWT (no dependency) ────────────────────────
    _signJwt(claims) {
        const iat = Math.floor(this._now() / 1000);
        const exp = Math.floor((this._now() + ACCESS_TOKEN_TTL_MS) / 1000);
        const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
        const payload = b64url(JSON.stringify({ ...claims, iat, exp }));
        const sig = this._jwtSig(`${header}.${payload}`);
        return `${header}.${payload}.${sig}`;
    }
    _verifyJwt(token) {
        if (typeof token !== 'string') return null;
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const [header, payload, sig] = parts;
        if (!timingSafeStrEqual(sig, this._jwtSig(`${header}.${payload}`))) return null;
        let claims;
        try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
        if (claims.exp != null && Math.floor(this._now() / 1000) > claims.exp) return null;
        return claims;
    }
    _jwtSig(data) {
        return crypto.createHmac('sha256', this._secret).update(data).digest('base64url');
    }
}

function b64url(s) { return Buffer.from(s).toString('base64url'); }

function timingSafeStrEqual(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) { crypto.timingSafeEqual(ba, ba); return false; }
    return crypto.timingSafeEqual(ba, bb);
}
