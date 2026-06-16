/**
 * AccountStore — persistence for user accounts, refresh tokens, and account-issued API key
 * records. Mirrors the memory/Redis(/Prisma) split used elsewhere.
 *
 *   - MemoryAccountStore  — in-process Maps. The default; fully exercised by tests.
 *   - PrismaAccountStore  — Postgres via the existing Prisma schema (Account/Device) plus
 *                           RefreshToken/ApiKeyRecord models. Lazily loaded only when
 *                           DATABASE_URL is set (requires `prisma generate` + migrations).
 *
 * Refresh tokens and API key secrets are NEVER stored in the clear — only their SHA-256
 * hashes — so a store compromise can't mint sessions or keys.
 *
 * @typedef {Object} Account { id, email, passwordHash?, passwordSalt?, provider?, providerId?, createdAt, active }
 */

import crypto from 'node:crypto';

export class MemoryAccountStore {
    constructor() {
        this._byId = new Map();
        this._byEmail = new Map();          // lowercased email → id
        this._byProvider = new Map();       // `${provider}:${providerId}` → id
        this._refresh = new Map();          // tokenHash → { accountId, expiresAt }
        this._apiKeys = new Map();          // jti → record
        this._revokedJti = new Set();
        this.backend = 'memory';
    }

    async createAccount(account) {
        this._byId.set(account.id, account);
        this._byEmail.set(account.email.toLowerCase(), account.id);
        if (account.provider && account.providerId) {
            this._byProvider.set(`${account.provider}:${account.providerId}`, account.id);
        }
        return account;
    }

    async getById(id) { return this._byId.get(id) || null; }
    async getByEmail(email) {
        const id = this._byEmail.get(String(email).toLowerCase());
        return id ? this._byId.get(id) : null;
    }
    async getByProvider(provider, providerId) {
        const id = this._byProvider.get(`${provider}:${providerId}`);
        return id ? this._byId.get(id) : null;
    }
    async updateAccount(id, patch) {
        const a = this._byId.get(id);
        if (!a) return null;
        Object.assign(a, patch);
        return a;
    }

    async saveRefreshToken(tokenHash, accountId, expiresAt) {
        this._refresh.set(tokenHash, { accountId, expiresAt });
    }
    async getRefreshToken(tokenHash) {
        const r = this._refresh.get(tokenHash);
        if (!r) return null;
        if (Date.now() > r.expiresAt) { this._refresh.delete(tokenHash); return null; }
        return r;
    }
    async deleteRefreshToken(tokenHash) { this._refresh.delete(tokenHash); }
    async deleteAccountRefreshTokens(accountId) {
        for (const [h, r] of this._refresh) if (r.accountId === accountId) this._refresh.delete(h);
    }

    async saveApiKey(record) { this._apiKeys.set(record.id, record); }
    async listApiKeys(accountId) {
        return [...this._apiKeys.values()]
            .filter((k) => k.accountId === accountId && !this._revokedJti.has(k.id));
    }
    async revokeApiKey(accountId, jti) {
        const rec = this._apiKeys.get(jti);
        if (!rec || rec.accountId !== accountId) return false;
        this._revokedJti.add(jti);
        return true;
    }
    isApiKeyRevoked(jti) { return this._revokedJti.has(jti); }

    async stats() { return { accounts: this._byId.size }; }
    async shutdown() { /* nothing to release */ }
}

/**
 * Factory: Prisma-backed when DATABASE_URL is set, else in-memory. The Prisma path is
 * loaded lazily (its client is heavy and optional) and requires the generated client +
 * applied migrations; the in-memory store is the default and the one tests run against.
 */
export async function createAccountStore(env = process.env) {
    if (env.DATABASE_URL) {
        try {
            const { PrismaAccountStore } = await import('./PrismaAccountStore.js');
            const store = await PrismaAccountStore.connect();
            console.log('[AccountStore] Using Prisma (Postgres) store');
            return store;
        } catch (err) {
            console.error('[AccountStore] Prisma unavailable, using in-memory:', err.message);
        }
    }
    return new MemoryAccountStore();
}

/** Hash a refresh token / API key secret for at-rest storage. */
export function hashToken(raw) {
    return crypto.createHash('sha256').update(String(raw)).digest('hex');
}
