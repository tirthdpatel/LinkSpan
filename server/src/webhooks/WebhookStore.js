/**
 * WebhookStore — persistence for webhook endpoints and their (bounded) delivery logs.
 *
 * Mirrors the ShareLinkStore memory/Redis split so webhooks scale horizontally the same
 * way the rest of the system does. The manager owns all policy (signing, retries, SSRF);
 * the store only persists/queries, so both backends behave identically.
 *
 * A "record" is a plain JSON object:
 *   { id, ownerId, url, secret, events: string[], active, createdAt, deliveryCount }
 *
 * @typedef {Object} WebhookStore
 * @property {(record: object) => Promise<void>} create
 * @property {(id: string) => Promise<object|null>} get
 * @property {(ownerId: string) => Promise<object[]>} listByOwner
 * @property {() => Promise<object[]>} listAll   used by dispatch to find subscribers
 * @property {(record: object) => Promise<void>} update
 * @property {(id: string) => Promise<void>} delete
 * @property {(id: string, delivery: object, max: number) => Promise<void>} pushDelivery
 * @property {(id: string) => Promise<object[]>} listDeliveries
 * @property {() => Promise<{ webhooks: number }>} stats
 * @property {() => Promise<void>} shutdown
 */

const KEY = (id) => `webhook:ep:${id}`;
const OWNER_KEY = (ownerId) => `webhook:owner:${ownerId}`;
const ALL_KEY = 'webhook:all';
const DELIV_KEY = (id) => `webhook:deliv:${id}`;

export class MemoryWebhookStore {
    constructor() {
        this._records = new Map();   // id → record
        this._deliveries = new Map(); // id → delivery[] (most recent first)
        this.backend = 'memory';
    }

    async create(record) {
        this._records.set(record.id, record);
    }

    async get(id) {
        return this._records.get(id) || null;
    }

    async listByOwner(ownerId) {
        return [...this._records.values()].filter((r) => r.ownerId === ownerId);
    }

    async listAll() {
        return [...this._records.values()];
    }

    async update(record) {
        if (this._records.has(record.id)) this._records.set(record.id, record);
    }

    async delete(id) {
        this._records.delete(id);
        this._deliveries.delete(id);
    }

    async pushDelivery(id, delivery, max) {
        const list = this._deliveries.get(id) || [];
        list.unshift(delivery);
        if (list.length > max) list.length = max;
        this._deliveries.set(id, list);
    }

    async listDeliveries(id) {
        return this._deliveries.get(id) || [];
    }

    async stats() {
        return { webhooks: this._records.size };
    }

    async shutdown() {
        this._records.clear();
        this._deliveries.clear();
    }
}

export class RedisWebhookStore {
    /** @param {import('redis').RedisClientType} client A connected redis client. */
    constructor(client) {
        this._client = client;
        this.backend = 'redis';
    }

    async create(record) {
        await this._client.set(KEY(record.id), JSON.stringify(record));
        await this._client.sAdd(ALL_KEY, record.id);
        if (record.ownerId) await this._client.sAdd(OWNER_KEY(record.ownerId), record.id);
    }

    async get(id) {
        const raw = await this._client.get(KEY(id));
        return raw ? JSON.parse(raw) : null;
    }

    async listByOwner(ownerId) {
        const ids = await this._client.sMembers(OWNER_KEY(ownerId));
        return this._loadMany(ids, OWNER_KEY(ownerId));
    }

    async listAll() {
        const ids = await this._client.sMembers(ALL_KEY);
        return this._loadMany(ids, ALL_KEY);
    }

    async _loadMany(ids, indexKey) {
        const out = [];
        for (const id of ids) {
            const raw = await this._client.get(KEY(id));
            if (raw) out.push(JSON.parse(raw));
            else await this._client.sRem(indexKey, id); // prune dangling index entry
        }
        return out;
    }

    async update(record) {
        if (!(await this._client.exists(KEY(record.id)))) return;
        await this._client.set(KEY(record.id), JSON.stringify(record));
    }

    async delete(id) {
        const raw = await this._client.get(KEY(id));
        if (raw) {
            const rec = JSON.parse(raw);
            if (rec.ownerId) await this._client.sRem(OWNER_KEY(rec.ownerId), id);
        }
        await this._client.sRem(ALL_KEY, id);
        await this._client.del(KEY(id));
        await this._client.del(DELIV_KEY(id));
    }

    async pushDelivery(id, delivery, max) {
        await this._client.lPush(DELIV_KEY(id), JSON.stringify(delivery));
        await this._client.lTrim(DELIV_KEY(id), 0, max - 1);
    }

    async listDeliveries(id) {
        const raw = await this._client.lRange(DELIV_KEY(id), 0, -1);
        return raw.map((s) => JSON.parse(s));
    }

    async stats() {
        return { webhooks: await this._client.sCard(ALL_KEY) };
    }

    async shutdown() {
        // The redis client lifecycle is owned by the caller/factory.
    }
}

/**
 * Factory: Redis-backed when REDIS_URL is set, else in-memory. Mirrors createShareLinkStore.
 */
export async function createWebhookStore(env = process.env) {
    if (env.REDIS_URL) {
        try {
            const { createClient } = await import('redis');
            const client = createClient({ url: env.REDIS_URL });
            await client.connect();
            console.log('[WebhookStore] Using Redis store');
            return new RedisWebhookStore(client);
        } catch (err) {
            console.error('[WebhookStore] Redis unavailable, using in-memory:', err.message);
        }
    }
    return new MemoryWebhookStore();
}
