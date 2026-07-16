/**
 * ShareLinkStore — persistence for share-link *metadata* (not the blob bytes).
 *
 * Mirrors the SessionManager memory/Redis split so share links scale horizontally the
 * same way sessions do. Two implementations behind one interface:
 *   - MemoryShareLinkStore — single-node, in-process Map with a manual expiry sweep.
 *   - RedisShareLinkStore  — multi-instance; records live in Redis with a native TTL so
 *                            expiry is enforced by Redis and shared across all nodes.
 *
 * A "record" is a plain JSON object (see ShareLinkManager for the shape). The store only
 * persists/queries it; all policy (password, download limits, revocation) lives in the
 * manager so both backends behave identically.
 *
 * @typedef {Object} ShareLinkStore
 * @property {(id: string, record: object, ttlMs: number) => Promise<void>} create
 * @property {(id: string) => Promise<object|null>} get
 * @property {(id: string, record: object) => Promise<void>} update  (preserves remaining TTL)
 * @property {(id: string) => Promise<void>} delete
 * @property {(ownerId: string) => Promise<object[]>} listByOwner
 * @property {() => Promise<object[]>} sweepExpired  Returns the removed records so the
 *           caller can delete their blobs (memory only; Redis expires metadata itself).
 * @property {() => Promise<{ shareLinks: number }>} stats
 * @property {() => Promise<void>} shutdown
 */

const KEY = (id) => `share:link:${id}`;
const OWNER_KEY = (ownerId) => `share:owner:${ownerId}`;

export class MemoryShareLinkStore {
    constructor() {
        this._records = new Map();        // id → { record, expiresAt }
        this._byOwner = new Map();        // ownerId → Set<id>
        this.backend = 'memory';
    }

    async create(id, record, ttlMs) {
        const expiresAt = Date.now() + ttlMs;
        this._records.set(id, { record, expiresAt });
        if (record.ownerId) {
            if (!this._byOwner.has(record.ownerId)) this._byOwner.set(record.ownerId, new Set());
            this._byOwner.get(record.ownerId).add(id);
        }
    }

    async get(id) {
        const entry = this._records.get(id);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) return null; // lazily expired; sweeper reclaims
        return entry.record;
    }

    async update(id, record) {
        const entry = this._records.get(id);
        if (!entry) return;
        entry.record = record; // keep original expiresAt (store TTL unchanged)
    }

    async delete(id) {
        const entry = this._records.get(id);
        if (entry?.record?.ownerId) this._byOwner.get(entry.record.ownerId)?.delete(id);
        this._records.delete(id);
    }

    async listByOwner(ownerId) {
        const ids = this._byOwner.get(ownerId);
        if (!ids) return [];
        const now = Date.now();
        const out = [];
        for (const id of ids) {
            const entry = this._records.get(id);
            if (entry && now <= entry.expiresAt) out.push(entry.record);
        }
        return out;
    }

    async sweepExpired() {
        const now = Date.now();
        const removed = [];
        for (const [id, entry] of this._records) {
            if (now > entry.expiresAt) {
                removed.push(entry.record);
                if (entry.record?.ownerId) this._byOwner.get(entry.record.ownerId)?.delete(id);
                this._records.delete(id);
            }
        }
        return removed;
    }

    async stats() {
        return { shareLinks: this._records.size };
    }

    async shutdown() {
        this._records.clear();
        this._byOwner.clear();
    }
}

export class RedisShareLinkStore {
    /** @param {import('redis').RedisClientType} client A connected redis client. */
    constructor(client) {
        this._client = client;
        this.backend = 'redis';
    }

    async create(id, record, ttlMs) {
        const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
        await this._client.set(KEY(id), JSON.stringify(record), { EX: ttlSec });
        if (record.ownerId) {
            // Owner index entry; expire it well after the link so listing stays cheap.
            await this._client.sAdd(OWNER_KEY(record.ownerId), id);
            await this._client.expire(OWNER_KEY(record.ownerId), ttlSec + 86400);
        }
    }

    async get(id) {
        const raw = await this._client.get(KEY(id));
        return raw ? JSON.parse(raw) : null;
    }

    async update(id, record) {
        // KEEPTTL preserves the link's remaining lifetime across metadata updates
        // (e.g. incrementing downloadCount) so a download never extends expiry.
        const ttl = await this._client.pTTL(KEY(id));
        if (ttl < 0) return; // key gone or no TTL — nothing to update
        await this._client.set(KEY(id), JSON.stringify(record), { KEEPTTL: true });
    }

    async delete(id) {
        const raw = await this._client.get(KEY(id));
        if (raw) {
            const rec = JSON.parse(raw);
            if (rec.ownerId) await this._client.sRem(OWNER_KEY(rec.ownerId), id);
        }
        await this._client.del(KEY(id));
    }

    async listByOwner(ownerId) {
        const ids = await this._client.sMembers(OWNER_KEY(ownerId));
        if (!ids.length) return [];
        const out = [];
        for (const id of ids) {
            const raw = await this._client.get(KEY(id));
            if (raw) out.push(JSON.parse(raw));
            else await this._client.sRem(OWNER_KEY(ownerId), id); // prune expired index entry
        }
        return out;
    }

    async sweepExpired() {
        // Redis evicts expired keys natively; nothing to do. Blob GC is handled
        // separately by the manager scanning for orphaned blobs.
        return [];
    }

    async stats() {
        // Approximate: count link keys. SCAN avoids blocking on large keyspaces.
        let count = 0;
        for await (const _ of this._client.scanIterator({ MATCH: 'share:link:*', COUNT: 100 })) {
            count++;
        }
        return { shareLinks: count };
    }

    async shutdown() {
        // The redis client lifecycle is owned by the caller/factory.
    }
}

/**
 * Factory: Redis-backed when REDIS_URL is set, else in-memory. Reuses the same redis
 * client wiring style as the session/guards factories.
 */
export async function createShareLinkStore(env = process.env) {
    if (env.REDIS_URL) {
        try {
            const { createClient } = await import('redis');
            const client = createClient({ url: env.REDIS_URL, pingInterval: 30_000 });
            // Without an 'error' listener, a dropped Redis socket emits an
            // unhandled 'error' event and crashes the whole process.
            client.on('error', (err) => console.error('[ShareLinkStore Redis] Error:', err.message));
            await client.connect();
            console.log('[ShareLinkStore] Using Redis metadata store');
            return new RedisShareLinkStore(client);
        } catch (err) {
            console.error('[ShareLinkStore] Redis unavailable, using in-memory:', err.message);
        }
    }
    console.log('[ShareLinkStore] Using in-memory metadata store');
    return new MemoryShareLinkStore();
}
