/**
 * REST API router (Feature 17) — versioned at /api/v1.
 *
 * Surface:
 *   GET    /                      API info + capability discovery
 *   GET    /openapi.json          OpenAPI 3.1 specification
 *   GET    /health                liveness + share-link store stats
 *
 *   POST   /links                 create a share link (auth: links:write)         [upload limit]
 *   PUT    /links/:id/content     upload bytes (auth: X-Upload-Token)             [upload limit]
 *   GET    /links/:id             public metadata (no secrets)                    [api limit]
 *   GET    /links/:id/download    download bytes (password via header/query)      [download limit]
 *   DELETE /links/:id             revoke (auth: owner key OR X-Owner-Token)       [api limit]
 *   GET    /links                 list caller's links (auth: links:read)          [api limit]
 *
 *   POST   /sessions              create a signaling session (auth: sessions:write)
 *   GET    /sessions/:id          session status
 *
 * Authorization model:
 *   - With an API key, links are owned by the key's ownerId (enables listing).
 *   - Anonymously (self-host default), a link is owned by a per-link capability secret
 *     returned once as `ownerToken`; revoke requires presenting it via X-Owner-Token.
 *
 * Every mutating/abusable route is rate limited and audit logged. Errors are returned as
 * { error: { code, message } } with precise HTTP status codes.
 */

import express from 'express';
import crypto from 'node:crypto';
import { API_BASE_PATH, SHARE_MAX_BLOB_BYTES, WEBHOOK_EVENTS } from '../../../shared/constants.js';
import { ShareError } from '../share/ShareLinkManager.js';
import { buildOpenApiSpec } from './openapi.js';
import { createApiAuth } from './authMiddleware.js';
import { createAuthRouter } from './AuthRoutes.js';

const LINK_ID_RE = /^[a-f0-9]{32}$/;

/**
 * @param {object} deps
 * @param {import('../share/ShareLinkManager.js').ShareLinkManager} deps.shareLinks
 * @param {import('./ApiKeyManager.js').ApiKeyManager} deps.apiKeys
 * @param {import('./HttpRateLimiter.js').HttpRateLimiter} deps.httpLimiter
 * @param {object} [deps.sessionManager]
 * @param {object} [deps.tokenManager]
 * @param {import('../webhooks/WebhookManager.js').WebhookManager} [deps.webhooks]
 * @param {(event:string, detail:object)=>void} [deps.audit]
 * @param {string} [deps.baseUrl]
 * @returns {import('express').Router}
 */
export function createApiRouter(deps) {
    const { shareLinks, apiKeys, httpLimiter, sessionManager, tokenManager, webhooks,
        accountManager, oauthProviders, telemetry, turnCredentials,
        audit = () => {}, baseUrl = '' } = deps;
    const router = express.Router();

    const apiLimit = httpLimiter.middleware('api');
    const uploadLimit = httpLimiter.middleware('upload');
    const downloadLimit = httpLimiter.middleware('download');
    // Unified auth: API keys, and (when accounts are enabled) account access tokens too.
    const auth = accountManager ? createApiAuth({ apiKeys, accountManager }) : apiKeys.middleware();

    // Capture rejected payloads' validation errors as structured JSON.
    const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => sendError(res, err));

    // ── Discovery ──────────────────────────────────────────────
    router.get('/', (_req, res) => {
        res.json({
            name: 'LinkSpan REST API',
            version: 'v1',
            basePath: API_BASE_PATH,
            documentation: `${baseUrl}${API_BASE_PATH}/openapi.json`,
            capabilities: {
                shareLinks: true,
                temporaryLinks: true,
                publicLinks: true,
                passwordProtection: true,
                downloadLimits: true,
                singleUse: true,
                sessions: Boolean(sessionManager),
                webhooks: Boolean(webhooks),
                accounts: Boolean(accountManager),
                oauth: oauthProviders ? Object.keys(oauthProviders) : [],
                anonymous: apiKeys.allowAnonymous,
                turnCredentials: Boolean(turnCredentials?.enabled),
                storageBackend: shareLinks._storage?.kind,
            },
            ...(webhooks ? { webhookEvents: WEBHOOK_EVENTS } : {}),
        });
    });

    // ── Accounts / auth (mounted only when enabled) ────────────
    if (accountManager) {
        router.use('/auth', createAuthRouter({
            accountManager,
            oauthProviders,
            audit,
            apiLimit,
            baseUrl,
            successUrl: (process.env.AUTH_SUCCESS_URL || '').replace(/\/+$/, ''),
        }));
    }

    router.get('/openapi.json', (_req, res) => {
        res.json(buildOpenApiSpec({ baseUrl }));
    });

    router.get('/health', apiLimit, wrap(async (_req, res) => {
        const stats = await shareLinks.stats();
        res.json({ status: 'ok', ...stats });
    }));

    // ── Opt-in aggregate telemetry (no auth; privacy-first) ────
    // Accepts ONLY a pre-bucketed, identifier-free transfer event from clients that have
    // opted in. No PII is accepted or stored — see TelemetryAggregator. Rate-limited like
    // any anonymous API call. Always responds 204 (even on invalid input) so it can't be
    // used as an oracle; invalid events are silently dropped + counted server-side.
    router.post('/telemetry', apiLimit, (req, res) => {
        if (telemetry) {
            try { telemetry.record(req.body || {}); } catch { /* never throw on telemetry */ }
        }
        res.status(204).end();
    });

    // ── Ephemeral TURN credentials ─────────────────────────────
    // No auth: the WebRTC pairing flow runs before any account/API-key context exists,
    // and the credentials are already short-lived + rate-limited. When no TURN provider
    // is configured (or the upstream provider errors) this returns an empty list and the
    // client proceeds STUN-only — never a 5xx, because TURN is an optimization.
    router.get('/turn-credentials', apiLimit, wrap(async (_req, res) => {
        if (!turnCredentials?.enabled) {
            res.json({ iceServers: [], ttl: 0 });
            return;
        }
        const creds = await turnCredentials.getIceServers();
        // Cacheable client-side for a fraction of the TTL; never by shared caches.
        res.set('Cache-Control', 'private, max-age=60');
        res.json(creds);
    }));

    // ── Create link ────────────────────────────────────────────
    router.post('/links', auth, apiKeys.requireScope('links:write'), uploadLimit, wrap(async (req, res) => {
        const body = req.body || {};
        // Owner: an authenticated key's owner, or a fresh capability secret (anonymous).
        let ownerId = req.principal?.ownerId || null;
        let ownerToken = null;
        if (!ownerId) {
            ownerToken = crypto.randomBytes(24).toString('hex');
            ownerId = `cap:${crypto.createHash('sha256').update(ownerToken).digest('hex')}`;
        }

        const { record, uploadToken } = await shareLinks.create({
            filename: body.filename,
            size: body.size,
            contentType: body.contentType,
            visibility: body.visibility,
            expiresIn: body.expiresIn,
            password: body.password,
            maxDownloads: body.maxDownloads,
            singleUse: body.singleUse,
            metadata: body.metadata,
            ownerId,
        });

        audit('SHARE_LINK_CREATED', { id: record.id, ip: req.clientIp, visibility: record.visibility });

        res.status(201).json({
            ...shareLinks.toPublic(record),
            uploadToken,
            ...(ownerToken ? { ownerToken } : {}),
            upload: {
                method: 'PUT',
                url: `${baseUrl}${API_BASE_PATH}/links/${record.id}/content`,
                header: 'X-Upload-Token',
                maxBytes: SHARE_MAX_BLOB_BYTES,
            },
        });
    }));

    // ── Upload content ─────────────────────────────────────────
    // The raw request IS the blob. We stream `req` straight into the storage backend,
    // which enforces the byte ceiling chunk-by-chunk — never buffering the whole blob in
    // memory (the global express.json parser only consumes application/json bodies, so an
    // octet-stream body reaches here untouched as a readable stream).
    router.put('/links/:id/content', uploadLimit, wrap(async (req, res) => {
        const id = requireLinkId(req.params.id);
        const uploadToken = req.headers['x-upload-token'] || req.query.uploadToken;
        if (!uploadToken) throw new ShareError('UNAUTHORIZED', 'Missing upload token', 401);
        const pub = await shareLinks.attachContent(id, String(uploadToken), req);
        audit('SHARE_LINK_UPLOADED', { id, bytes: pub.size, ip: req.clientIp });
        res.json(pub);
    }));

    // ── Metadata ───────────────────────────────────────────────
    router.get('/links/:id', apiLimit, wrap(async (req, res) => {
        const id = requireLinkId(req.params.id);
        const record = await shareLinks.getRecord(id);
        if (!record || record.revoked) throw new ShareError('NOT_FOUND', 'Share link not found', 404);
        if (Date.now() > record.expiresAt) throw new ShareError('EXPIRED', 'Share link expired', 410);
        res.json(shareLinks.toPublic(record));
    }));

    // ── Download ───────────────────────────────────────────────
    router.get('/links/:id/download', downloadLimit, wrap(async (req, res) => {
        const id = requireLinkId(req.params.id);
        const password = req.headers['x-share-password'] || req.query.password;

        // Resolve size/validation up front so we can honor a Range request. validateDownload
        // applies all policy (revoked/expired/limit/password); it throws the precise error.
        const record = await shareLinks.validateDownload(id, password);
        const size = record.storedSize;

        const commonHeaders = () => {
            res.setHeader('Content-Type', record.contentType || 'application/octet-stream');
            res.setHeader('Content-Disposition', `attachment; filename="${asciiFilename(record.filename)}"; filename*=UTF-8''${encodeURIComponent(record.filename)}`);
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
            res.setHeader('Accept-Ranges', 'bytes');
        };

        const range = Number.isFinite(size) ? parseRange(req.headers['range'], size) : null;

        // ── Partial content (HTTP Range) ──
        if (range === 'invalid') {
            res.setHeader('Content-Range', `bytes */${size}`);
            return sendError(res, new ShareError('RANGE_NOT_SATISFIABLE', 'Requested range not satisfiable', 416));
        }
        if (range) {
            const { start, end } = range;
            const { stream } = await shareLinks.openDownloadRange(id, password, start, end);
            commonHeaders();
            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
            res.setHeader('Content-Length', String(end - start + 1));
            stream.on('error', () => { if (!res.headersSent) sendError(res, new ShareError('STREAM_ERROR', 'Read failed', 500)); else res.destroy(); });
            // Partial reads are not metered (don't consume single-use links on a seek).
            stream.pipe(res);
            return;
        }

        // ── Full content ──
        const { stream } = await shareLinks.openDownload(id, password);
        commonHeaders();
        if (Number.isFinite(size) && size >= 0) res.setHeader('Content-Length', String(size));

        let finished = false;
        stream.on('error', () => {
            if (!res.headersSent) sendError(res, new ShareError('STREAM_ERROR', 'Read failed', 500));
            else res.destroy();
        });
        res.on('close', async () => {
            // Account the download only if the response completed successfully.
            if (finished) {
                await shareLinks.recordDownload(id).catch(() => {});
                audit('SHARE_LINK_DOWNLOADED', { id, ip: req.clientIp });
            }
        });
        stream.on('end', () => { finished = true; });
        stream.pipe(res);
    }));

    // ── Revoke ─────────────────────────────────────────────────
    router.delete('/links/:id', auth, apiLimit, wrap(async (req, res) => {
        const id = requireLinkId(req.params.id);
        const ownerToken = req.headers['x-owner-token'];
        let ownerId = req.principal?.ownerId || null;
        if (!ownerId && ownerToken) {
            ownerId = `cap:${crypto.createHash('sha256').update(String(ownerToken)).digest('hex')}`;
        }
        if (!ownerId) throw new ShareError('UNAUTHORIZED', 'Provide an API key or X-Owner-Token', 401);
        await shareLinks.revoke(id, { ownerId });
        audit('SHARE_LINK_REVOKED', { id, ip: req.clientIp });
        res.json({ revoked: true, id });
    }));

    // ── List owner links ───────────────────────────────────────
    router.get('/links', auth, apiKeys.requireScope('links:read'), apiLimit, wrap(async (req, res) => {
        if (!req.principal?.ownerId) {
            // Anonymous capability links aren't enumerable (no account); require a key.
            throw new ShareError('UNAUTHORIZED', 'Listing requires an API key', 401);
        }
        const links = await shareLinks.listByOwner(req.principal.ownerId);
        res.json({ links, count: links.length });
    }));

    // ── Sessions (bridge to signaling) ─────────────────────────
    if (sessionManager && tokenManager) {
        router.post('/sessions', auth, apiKeys.requireScope('sessions:write'), apiLimit, wrap(async (req, res) => {
            const { sessionId, pairingCode } = await Promise.resolve(sessionManager.createSession());
            const peerId = crypto.randomUUID();
            const token = tokenManager.sign({ sessionId, peerId, role: 'sender' });
            audit('SESSION_CREATED', { id: sessionId, ip: req.clientIp, via: 'rest' });
            res.status(201).json({ sessionId, pairingCode, peerId, token });
        }));

        router.get('/sessions/:id', apiLimit, wrap(async (req, res) => {
            const id = String(req.params.id);
            const session = await Promise.resolve(sessionManager.getSession(id));
            if (!session) throw new ShareError('NOT_FOUND', 'Session not found', 404);
            res.json({
                sessionId: session.sessionId,
                active: true,
                peerCount: Array.isArray(session.peers) ? session.peers.length : (session.peerCount ?? 0),
                createdAt: session.createdAt,
            });
        }));
    }

    // ── Webhooks ───────────────────────────────────────────────
    if (webhooks) {
        // Webhooks require a real owner (an API key / account). Anonymous capability
        // tokens can't manage webhooks since there's no principal to scope them to.
        const requireOwner = (req) => {
            const ownerId = req.principal?.ownerId;
            if (!ownerId) throw new ShareError('UNAUTHORIZED', 'Webhooks require an API key', 401);
            return ownerId;
        };

        router.post('/webhooks', auth, apiKeys.requireScope('webhooks:write'), apiLimit, wrap(async (req, res) => {
            const ownerId = requireOwner(req);
            const body = req.body || {};
            const created = await webhooks.register({ ownerId, url: body.url, events: body.events, secret: body.secret });
            audit('WEBHOOK_CREATED', { id: created.id, ip: req.clientIp });
            res.status(201).json(created);
        }));

        router.get('/webhooks', auth, apiKeys.requireScope('webhooks:read'), apiLimit, wrap(async (req, res) => {
            const ownerId = requireOwner(req);
            const list = await webhooks.list(ownerId);
            res.json({ webhooks: list, count: list.length });
        }));

        router.get('/webhooks/:id', auth, apiKeys.requireScope('webhooks:read'), apiLimit, wrap(async (req, res) => {
            const ownerId = requireOwner(req);
            res.json(await webhooks.get(ownerId, requireWebhookId(req.params.id)));
        }));

        router.delete('/webhooks/:id', auth, apiKeys.requireScope('webhooks:write'), apiLimit, wrap(async (req, res) => {
            const ownerId = requireOwner(req);
            await webhooks.delete(ownerId, requireWebhookId(req.params.id));
            audit('WEBHOOK_DELETED', { id: req.params.id, ip: req.clientIp });
            res.json({ deleted: true, id: req.params.id });
        }));

        router.post('/webhooks/:id/test', auth, apiKeys.requireScope('webhooks:write'), apiLimit, wrap(async (req, res) => {
            const ownerId = requireOwner(req);
            const result = await webhooks.test(ownerId, requireWebhookId(req.params.id));
            res.json({ result });
        }));

        router.get('/webhooks/:id/deliveries', auth, apiKeys.requireScope('webhooks:read'), apiLimit, wrap(async (req, res) => {
            const ownerId = requireOwner(req);
            const deliveries = await webhooks.listDeliveries(ownerId, requireWebhookId(req.params.id));
            res.json({ deliveries, count: deliveries.length });
        }));
    }

    return router;
}

// ── Helpers ────────────────────────────────────────────────────

/**
 * Parse a single-range HTTP Range header against a known total size.
 * Returns { start, end } (inclusive), null when there's no Range to honor (serve full),
 * or 'invalid' when the range is unsatisfiable (→ 416). Multi-range is not supported and is
 * treated as no-range (serve full), which is a spec-compliant fallback.
 */
function parseRange(header, size) {
    if (!header || typeof header !== 'string') return null;
    const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!m) return null;                       // not a single byte-range → serve full
    const [, rawStart, rawEnd] = m;
    if (rawStart === '' && rawEnd === '') return 'invalid';
    let start; let end;
    if (rawStart === '') {
        // Suffix range: last N bytes.
        const n = Number(rawEnd);
        if (n <= 0) return 'invalid';
        start = Math.max(0, size - n);
        end = size - 1;
    } else {
        start = Number(rawStart);
        end = rawEnd === '' ? size - 1 : Number(rawEnd);
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)) return 'invalid';
    if (start > end || start < 0 || start >= size) return 'invalid';
    if (end >= size) end = size - 1;
    return { start, end };
}

function requireLinkId(id) {
    if (typeof id !== 'string' || !LINK_ID_RE.test(id)) {
        throw new ShareError('INVALID_ID', 'Malformed link id', 400);
    }
    return id;
}

function requireWebhookId(id) {
    if (typeof id !== 'string' || !LINK_ID_RE.test(id)) {
        throw new ShareError('INVALID_ID', 'Malformed webhook id', 400);
    }
    return id;
}

/** ASCII-only fallback filename for the legacy Content-Disposition filename= param. */
function asciiFilename(name) {
    return String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
}

function sendError(res, err) {
    if (res.headersSent) return;
    if (err instanceof ShareError) {
        return res.status(err.httpStatus).json({ error: { code: err.code, message: err.message } });
    }
    // WebhookError (and any error following the same { code, httpStatus } convention).
    if (err && typeof err.httpStatus === 'number' && typeof err.code === 'string') {
        return res.status(err.httpStatus).json({ error: { code: err.code, message: err.message } });
    }
    if (err && err.code === 'BLOB_TOO_LARGE') {
        return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: err.message } });
    }
    // express.raw size overflow surfaces as entity.too.large
    if (err && (err.type === 'entity.too.large' || err.status === 413)) {
        return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Upload exceeds maximum size' } });
    }
    console.error('[api] unhandled error:', err?.message);
    return res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
}
