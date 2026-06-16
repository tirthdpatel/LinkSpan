/**
 * WebhookManager — register endpoints and deliver HMAC-signed event notifications with
 * retries. All policy lives here; the WebhookStore only persists.
 *
 * Delivery: a JSON envelope { id, type, createdAt, data } is POSTed to the endpoint URL
 * with headers:
 *   X-LinkSpan-Event:     the event type
 *   X-LinkSpan-Delivery:  the delivery id (idempotency key for the receiver)
 *   X-LinkSpan-Signature: t=<unixSeconds>,v1=<hex hmac-sha256(secret, `${t}.${rawBody}`)>
 * A 2xx response is success; anything else (or a network/timeout error) is retried with
 * exponential backoff up to WEBHOOK_MAX_ATTEMPTS. Outcomes are recorded in a bounded log.
 *
 * SSRF: registration rejects non-http(s) URLs and (unless allowPrivate) URLs whose host
 * is a loopback/private/link-local IP literal or `localhost`. This blocks the common SSRF
 * vector; DNS-rebinding to an internal address is a documented residual limitation.
 *
 * Timers and fetch are injectable so retries/backoff are deterministically testable.
 */

import crypto from 'node:crypto';
import {
    WEBHOOK_EVENTS,
    WEBHOOK_MAX_ATTEMPTS,
    WEBHOOK_RETRY_BASE_MS,
    WEBHOOK_TIMEOUT_MS,
    WEBHOOK_MAX_DELIVERIES_STORED,
    WEBHOOK_MAX_PER_OWNER,
    WEBHOOK_SECRET_BYTES,
} from '../../../shared/constants.js';

export class WebhookError extends Error {
    constructor(code, message, httpStatus = 400) {
        super(message);
        this.name = 'WebhookError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

/** Compute the signature header value for a raw JSON body. Exported for tests. */
export function signPayload(secret, rawBody, timestampSec = Math.floor(Date.now() / 1000)) {
    const mac = crypto.createHmac('sha256', secret).update(`${timestampSec}.${rawBody}`).digest('hex');
    return `t=${timestampSec},v1=${mac}`;
}

const PRIVATE_V4 = [
    /^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^0\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
];

function isPrivateHost(host) {
    const h = host.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
    if (h === '::1' || h === '::' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
    if (PRIVATE_V4.some((re) => re.test(h))) return true;
    return false;
}

export class WebhookManager {
    /**
     * @param {object} opts
     * @param {import('./WebhookStore.js').WebhookStore} opts.store
     * @param {typeof fetch} [opts.fetchImpl]
     * @param {(fn: Function, ms: number) => any} [opts.setTimeoutImpl]
     * @param {() => number} [opts.now]
     * @param {boolean} [opts.allowPrivate]   allow private/loopback URLs (dev/self-host)
     * @param {number} [opts.maxAttempts]
     */
    constructor({ store, fetchImpl, setTimeoutImpl, now, allowPrivate, maxAttempts } = {}) {
        if (!store) throw new Error('WebhookManager requires a store');
        this._store = store;
        this._fetch = fetchImpl || globalThis.fetch;
        this._setTimeout = setTimeoutImpl || ((fn, ms) => setTimeout(fn, ms));
        this._now = now || Date.now;
        this._maxAttempts = maxAttempts || WEBHOOK_MAX_ATTEMPTS;
        this._allowPrivate = allowPrivate ?? (
            process.env.WEBHOOK_ALLOW_PRIVATE === 'true' || process.env.NODE_ENV !== 'production'
        );
    }

    _validateUrl(url) {
        let parsed;
        try { parsed = new URL(url); } catch { throw new WebhookError('INVALID_URL', 'Invalid webhook URL'); }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new WebhookError('INVALID_URL', 'Webhook URL must be http(s)');
        }
        if (!this._allowPrivate && isPrivateHost(parsed.hostname)) {
            throw new WebhookError('FORBIDDEN_URL', 'Webhook URL targets a private/loopback address', 400);
        }
        return parsed.toString();
    }

    _validateEvents(events) {
        if (!Array.isArray(events) || events.length === 0) {
            throw new WebhookError('INVALID_EVENTS', 'events must be a non-empty array');
        }
        const allowed = new Set([...WEBHOOK_EVENTS, '*']);
        for (const e of events) {
            if (!allowed.has(e)) throw new WebhookError('INVALID_EVENTS', `Unknown event: ${e}`);
        }
        return [...new Set(events)];
    }

    /**
     * Register a webhook endpoint. Returns the public record INCLUDING the secret (shown
     * once at creation so the caller can verify signatures); subsequent reads omit it.
     */
    async register({ ownerId, url, events, secret }) {
        if (!ownerId) throw new WebhookError('UNAUTHORIZED', 'ownerId required', 401);
        const existing = await this._store.listByOwner(ownerId);
        if (existing.length >= WEBHOOK_MAX_PER_OWNER) {
            throw new WebhookError('LIMIT', `Webhook limit reached (${WEBHOOK_MAX_PER_OWNER})`, 429);
        }
        const cleanUrl = this._validateUrl(url);
        const cleanEvents = this._validateEvents(events);
        const record = {
            id: crypto.randomBytes(16).toString('hex'),
            ownerId,
            url: cleanUrl,
            secret: secret || crypto.randomBytes(WEBHOOK_SECRET_BYTES).toString('hex'),
            events: cleanEvents,
            active: true,
            createdAt: this._now(),
            deliveryCount: 0,
        };
        await this._store.create(record);
        return this.toPublic(record, { includeSecret: true });
    }

    async list(ownerId) {
        const records = await this._store.listByOwner(ownerId);
        return records.map((r) => this.toPublic(r));
    }

    async get(ownerId, id) {
        const r = await this._store.get(id);
        if (!r || r.ownerId !== ownerId) throw new WebhookError('NOT_FOUND', 'Webhook not found', 404);
        return this.toPublic(r);
    }

    async delete(ownerId, id) {
        const r = await this._store.get(id);
        if (!r || r.ownerId !== ownerId) throw new WebhookError('NOT_FOUND', 'Webhook not found', 404);
        await this._store.delete(id);
    }

    async listDeliveries(ownerId, id) {
        await this.get(ownerId, id); // ownership check
        return this._store.listDeliveries(id);
    }

    /** Send a synthetic `ping` to one endpoint (returns the delivery outcome). */
    async test(ownerId, id) {
        const r = await this._store.get(id);
        if (!r || r.ownerId !== ownerId) throw new WebhookError('NOT_FOUND', 'Webhook not found', 404);
        return this._deliver(r, this._envelope('ping', { message: 'LinkSpan webhook test' }), { awaitResult: true });
    }

    /**
     * Dispatch an event to every active endpoint subscribed to it (or to '*'). Returns the
     * number of endpoints matched. Deliveries run in the background (fire-and-forget) unless
     * `awaitAll` is set (used in tests) — dispatch never blocks the caller's request.
     */
    async dispatch(event, data, { awaitAll = false } = {}) {
        const endpoints = await this._store.listAll();
        const matched = endpoints.filter((e) => e.active && (e.events.includes(event) || e.events.includes('*')));
        const envelope = this._envelope(event, data);
        const runs = matched.map((e) => this._deliver(e, envelope));
        if (awaitAll) await Promise.all(runs);
        return matched.length;
    }

    _envelope(event, data) {
        return {
            id: crypto.randomBytes(12).toString('hex'),
            type: event,
            createdAt: new Date(this._now()).toISOString(),
            data: data || {},
        };
    }

    /**
     * Deliver one envelope to one endpoint with bounded exponential-backoff retries.
     * Records the final outcome in the store. Resolves to the outcome when `awaitResult`,
     * otherwise resolves once the first attempt is scheduled (background retries continue).
     */
    async _deliver(endpoint, envelope, { awaitResult = false } = {}) {
        const rawBody = JSON.stringify(envelope);
        const run = async () => {
            let lastError = null;
            let statusCode = 0;
            for (let attempt = 1; attempt <= this._maxAttempts; attempt++) {
                try {
                    const tsSec = Math.floor(this._now() / 1000);
                    const res = await this._post(endpoint, rawBody, envelope.type, envelope.id, tsSec);
                    statusCode = res.status;
                    if (res.status >= 200 && res.status < 300) {
                        await this._record(endpoint, envelope, 'success', attempt, statusCode);
                        return { ok: true, attempts: attempt, statusCode };
                    }
                    lastError = `HTTP ${res.status}`;
                } catch (err) {
                    lastError = String(err?.message || err);
                }
                if (attempt < this._maxAttempts) await this._backoff(attempt);
            }
            await this._record(endpoint, envelope, 'failed', this._maxAttempts, statusCode, lastError);
            return { ok: false, attempts: this._maxAttempts, statusCode, error: lastError };
        };

        if (awaitResult) return run();
        // Fire-and-forget; swallow errors so a bad endpoint never crashes the dispatcher.
        run().catch(() => {});
        return { ok: null, scheduled: true };
    }

    async _post(endpoint, rawBody, event, deliveryId, tsSec) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
        try {
            return await this._fetch(endpoint.url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'X-LinkSpan-Event': event,
                    'X-LinkSpan-Delivery': deliveryId,
                    'X-LinkSpan-Signature': signPayload(endpoint.secret, rawBody, tsSec),
                },
                body: rawBody,
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timer);
        }
    }

    _backoff(attempt) {
        const ms = WEBHOOK_RETRY_BASE_MS * 2 ** (attempt - 1);
        return new Promise((resolve) => this._setTimeout(resolve, ms));
    }

    async _record(endpoint, envelope, status, attempts, statusCode, error) {
        const delivery = {
            id: envelope.id,
            event: envelope.type,
            status,
            attempts,
            statusCode: statusCode || null,
            error: error || null,
            at: new Date(this._now()).toISOString(),
        };
        await this._store.pushDelivery(endpoint.id, delivery, WEBHOOK_MAX_DELIVERIES_STORED).catch(() => {});
        endpoint.deliveryCount = (endpoint.deliveryCount || 0) + 1;
        await this._store.update(endpoint).catch(() => {});
    }

    toPublic(record, { includeSecret = false } = {}) {
        const pub = {
            id: record.id,
            url: record.url,
            events: record.events,
            active: record.active,
            createdAt: record.createdAt,
            deliveryCount: record.deliveryCount || 0,
        };
        if (includeSecret) pub.secret = record.secret;
        return pub;
    }
}
