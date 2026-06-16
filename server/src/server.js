import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import helmet from 'helmet';
import { v4 as uuidv4 } from 'uuid';
import { createSessionManager } from './SessionManagerFactory.js';
import { createGuards } from './GuardsFactory.js';
import { InputValidator } from './InputValidator.js';
import { TokenManager } from './TokenManager.js';
import { collector as metricsCollector } from './metrics/MetricsCollector.js';
import { PrometheusExporter } from './metrics/PrometheusExporter.js';
import { telemetryAggregator } from './telemetry/TelemetryAggregator.js';
import { auditLogger } from './database/AuditLogger.js';
import { createStorageBackend } from './share/StorageBackend.js';
import { createShareLinkStore } from './share/ShareLinkStore.js';
import { ShareLinkManager } from './share/ShareLinkManager.js';
import { ApiKeyManager } from './api/ApiKeyManager.js';
import { HttpRateLimiter } from './api/HttpRateLimiter.js';
import { createApiRouter } from './api/ShareLinkRoutes.js';
import { createWebhookStore } from './webhooks/WebhookStore.js';
import { WebhookManager } from './webhooks/WebhookManager.js';
import { createAccountStore } from './accounts/AccountStore.js';
import { AccountManager } from './accounts/AccountManager.js';
import { createOAuthProviders } from './accounts/OAuthProviders.js';
import { RoomManager } from './rooms/RoomManager.js';
import { ChunkAvailabilityRegistry } from './rooms/ChunkAvailabilityRegistry.js';
import {
    MSG,
    SWARM_MSG,
    MAX_MESSAGE_SIZE,
    MAX_RELAY_FRAME_SIZE,
    API_BASE_PATH,
    ERR,
} from '../../shared/constants.js';

const PORT = process.env.PORT || 10000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
// Where a human-facing /s/:id share link should land (the client app's viewer). When
// unset, /s/:id redirects to the raw API download endpoint.
const SHARE_VIEW_URL = (process.env.SHARE_VIEW_URL || '').replace(/\/+$/, '');

// ── Express Setup ──────────────────────────────────────────────
const app = express();
app.use(helmet());
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: '16kb' }));

// ── Prometheus Metrics ─────────────────────────────────────────
const prometheusExporter = new PrometheusExporter(metricsCollector);

// ── Server-level objects (initialized in bootstrap) ────────────
let sessionManager;
let server;  // http.Server — populated by bootstrap()
let wss;     // WebSocketServer — populated by bootstrap()
let rateLimiter; // populated by bootstrap() — Redis-backed when clustered
let bruteForce;  // populated by bootstrap() — Redis-backed when clustered
let shareLinks;  // ShareLinkManager — populated by bootstrap()
let webhooks;    // WebhookManager — populated by bootstrap()
const tokenManager = new TokenManager();

// Group rooms (N-peer) are a parallel, in-memory subsystem to the 2-peer SessionManager.
// The server only coordinates (roster + signaling routing + chunk availability); file bytes
// move peer-to-peer. Cross-instance rooms would mirror RedisSessionManager's routing.
const roomManager = new RoomManager();
const chunkRegistry = new ChunkAvailabilityRegistry();

// Map internal audit event names → public webhook event types. Only mapped events are
// delivered to subscribers; unmapped audit events (rate-limit hits, etc.) are not exposed.
const WEBHOOK_EVENT_MAP = {
    SHARE_LINK_CREATED: 'share.created',
    SHARE_LINK_UPLOADED: 'share.uploaded',
    SHARE_LINK_DOWNLOADED: 'share.downloaded',
    SHARE_LINK_REVOKED: 'share.revoked',
    SHARE_LINKS_SWEPT: 'share.expired',
    SESSION_CREATED: 'session.created',
    ACCOUNT_CREATED: 'account.created',
    ROOM_CREATED: 'room.created',
    ROOM_PEER_JOINED: 'room.peer_joined',
};

/** Drop fields that must never leave the server in an outbound webhook payload. */
const WEBHOOK_SENSITIVE_FIELDS = ['ip', 'password', 'secret', 'ownerToken', 'token'];
function sanitizeWebhookDetail(detail) {
    if (!detail || typeof detail !== 'object') return {};
    const safe = { ...detail };
    for (const field of WEBHOOK_SENSITIVE_FIELDS) delete safe[field];
    return safe;
}

/** Audit + (if mapped) dispatch a webhook for a server-side event. */
function recordAudit(event, detail) {
    auditLogger.log({ eventType: event, ip: detail?.ip, detail }).catch(() => {});
    const webhookEvent = WEBHOOK_EVENT_MAP[event];
    if (webhookEvent && webhooks) {
        webhooks.dispatch(webhookEvent, sanitizeWebhookDetail(detail)).catch(() => {});
    }
}

// ── Utility: Proxy-aware client IP extraction ──────────────────
/**
 * Extract the real client IP using configurable proxy trust.
 *
 * TRUSTED_PROXY_COUNT=0  → use socket address directly (default; no proxy)
 * TRUSTED_PROXY_COUNT=1  → trust the last 1 hop in X-Forwarded-For (single nginx)
 * TRUSTED_PROXY_COUNT=2  → trust the last 2 hops (e.g. CDN + nginx)
 *
 * This prevents clients from spoofing their IP via forged X-Forwarded-For headers,
 * which would bypass all rate limiting and brute-force defenses.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {string}
 */
function getClientIp(req) {
    const trustedProxies = parseInt(process.env.TRUSTED_PROXY_COUNT || '0', 10);

    if (trustedProxies > 0) {
        const forwarded = req.headers['x-forwarded-for'];
        if (forwarded) {
            const ips = forwarded.split(',').map((s) => s.trim()).filter(Boolean);
            // The real client IP is at index: total_hops - trusted_proxies
            // e.g. with 1 trusted proxy and header "1.2.3.4, 10.0.0.1":
            //   ips[max(0, 2 - 1)] = ips[1] = "10.0.0.1" (the proxy's view of the client)
            // This means client must control ALL IPs from the left up to that index.
            const idx = Math.max(0, ips.length - trustedProxies);
            return ips[idx] || req.socket.remoteAddress || '0.0.0.0';
        }
    }

    return req.socket.remoteAddress || '0.0.0.0';
}

/**
 * Send a JSON message to a WebSocket (no-op if not open).
 */
function sendJson(ws, data) {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(data));
    }
}

/**
 * Send a structured error message to a WebSocket.
 */
function sendError(ws, code, message) {
    sendJson(ws, { type: MSG.SESSION_ERROR, error: { code, message } });
}

// ── Metrics endpoint auth middleware ────────────────────────────
/**
 * Protect /metrics and /stats with an optional bearer token.
 *
 * If METRICS_TOKEN env var is set, requests must include:
 *   Authorization: Bearer <METRICS_TOKEN>
 *
 * If METRICS_TOKEN is not set, access is unrestricted (dev mode).
 * In production, always set METRICS_TOKEN or restrict via network policy.
 */
function requireMetricsAuth(req, res, next) {
    const METRICS_TOKEN = process.env.METRICS_TOKEN;
    if (METRICS_TOKEN) {
        const auth = req.headers['authorization'];
        if (auth === `Bearer ${METRICS_TOKEN}`) {
            return next();
        }
        return res.status(401).json({ error: 'Unauthorized. Provide Authorization: Bearer <METRICS_TOKEN>.' });
    }

    // No token configured. Fail OPEN only outside production (dev) or when the operator
    // has explicitly opted in (METRICS_PUBLIC=true) for a network-isolated deployment
    // where /metrics is reachable only by an internal scraper. Otherwise fail CLOSED:
    // /stats and /metrics leak session counts, relay byte volumes, and IP-derived data,
    // so they must never be world-readable in production by default. (Mirrors the
    // fail-closed CORS check in bootstrap().)
    if (process.env.NODE_ENV === 'production' && process.env.METRICS_PUBLIC !== 'true') {
        return res.status(403).json({
            error: 'Metrics are disabled. Set METRICS_TOKEN to require a bearer token, ' +
                'or METRICS_PUBLIC=true if access is restricted by network policy.',
        });
    }
    return next();
}

// ── SDP / ICE payload validators ───────────────────────────────

function isValidSdpPayload(payload, expectedType) {
    if (!payload || typeof payload !== 'object') return false;
    if (payload.type !== expectedType) return false;
    if (typeof payload.sdp !== 'string') return false;
    if (payload.sdp.length > 32 * 1024) return false; // 32 KB max
    return true;
}

function isValidIcePayload(payload) {
    if (!payload || typeof payload !== 'object') return false;
    if (payload.candidate === null) return true; // end-of-candidates
    if (typeof payload.candidate !== 'string') return false;
    if (payload.candidate.length > 2048) return false;
    return true;
}

// ── HTTP Routes ────────────────────────────────────────────────
// (Registered before bootstrap so Express can accept health probes
//  as soon as the process starts, even while waiting for Redis.)

app.get('/', (_req, res) => {
    res.json({ status: 'ok', service: 'linkspan-signaling' });
});

app.get('/health', (_req, res) => {
    if (!sessionManager) {
        return res.status(503).json({ status: 'starting' });
    }
    // getStats may be async (Redis backend) — handle both sync and async
    Promise.resolve(sessionManager.getStats()).then((stats) => {
        res.json({ status: 'ok', ...stats });
    }).catch(() => {
        res.status(503).json({ status: 'degraded' });
    });
});

app.get('/stats', requireMetricsAuth, (_req, res) => {
    if (!sessionManager) {
        return res.status(503).json({ status: 'starting' });
    }
    Promise.resolve(sessionManager.getStats()).then((stats) => {
        const bfStats = bruteForce.getStats();
        const relayStats = sessionManager.getRelayStats();
        const snap = metricsCollector.snapshot();
        res.json({ ...stats, ...bfStats, ...relayStats, metrics: snap });
    }).catch(() => {
        res.status(503).json({ status: 'error' });
    });
});

app.get('/metrics', requireMetricsAuth, (_req, res) => {
    res.set('Content-Type', PrometheusExporter.CONTENT_TYPE);
    // Server metrics + opt-in client aggregate telemetry (counts only, no PII).
    res.send(prometheusExporter.render() + telemetryAggregator.render());
});

// ── Bootstrap ──────────────────────────────────────────────────
/**
 * Bootstrap the server asynchronously.
 *
 * CRITICAL: createSessionManager() is async (may connect to Redis).
 * The original code did NOT await this, causing sessionManager to hold
 * a Promise object. Every subsequent call to sessionManager.createSession(),
 * addPeer(), etc. would call methods on a Promise — returning undefined.
 * This was a silent total failure of all WebSocket session handling.
 *
 * Fixed: entire server setup is inside this async function, sessionManager
 * is resolved before the HTTP server binds and WebSocket handlers run.
 */
async function bootstrap() {
    // ── Startup checks ─────────────────────────────────────────
    if (process.env.NODE_ENV === 'production' && !process.env.TOKEN_SECRET) {
        throw new Error(
            '[LinkSpan] TOKEN_SECRET is required in production. ' +
            'Generate one with: openssl rand -hex 32'
        );
    }
    if (!process.env.TOKEN_SECRET) {
        console.warn(
            '[LinkSpan] TOKEN_SECRET not set — using ephemeral random secret. ' +
            'Set TOKEN_SECRET in production or tokens will not survive restarts.'
        );
    }
    // Fail closed on a wildcard CORS origin in production — never serve the
    // signaling API to arbitrary origins in a deployed environment.
    if (process.env.NODE_ENV === 'production' && CORS_ORIGIN === '*') {
        throw new Error(
            '[LinkSpan] CORS_ORIGIN must be an explicit origin in production ' +
            '(refusing to run with "*"). Set CORS_ORIGIN to your client URL.'
        );
    }

    // Validate the proxy-trust setting and warn about the common footgun: when the server
    // runs behind a reverse proxy / ingress (the documented deploy) but TRUSTED_PROXY_COUNT
    // is left at 0, getClientIp() returns the *proxy's* address for every request — so all
    // per-IP rate limiting and brute-force defenses collapse onto one shared identity.
    const trustedProxies = process.env.TRUSTED_PROXY_COUNT;
    if (trustedProxies !== undefined) {
        const n = Number(trustedProxies);
        if (!Number.isInteger(n) || n < 0) {
            throw new Error(
                `[LinkSpan] TRUSTED_PROXY_COUNT must be a non-negative integer (got "${trustedProxies}").`
            );
        }
    } else if (process.env.NODE_ENV === 'production') {
        console.warn(
            '[LinkSpan] TRUSTED_PROXY_COUNT is not set (defaulting to 0). If this server is ' +
            'behind a reverse proxy/ingress, set it to the number of trusted hops or per-IP ' +
            'rate limiting will treat all clients as the proxy. Set to 0 explicitly to silence.'
        );
    }

    // ── Session manager (sync or Redis-backed) ─────────────────
    // MUST be awaited — createSessionManager() is async.
    sessionManager = await createSessionManager();
    console.log('[LinkSpan] Session manager initialized.');

    // Rate limiter + brute-force guard (Redis-backed when REDIS_URL is set so
    // limits aggregate across instances; in-memory otherwise).
    ({ rateLimiter, bruteForce } = await createGuards());

    // ── Share links + REST API (Features 14/15/17) ─────────────
    // Additive subsystem: server-stored, downloadable links. The blob store and
    // metadata store are independently pluggable (filesystem/memory, memory/Redis) so
    // this scales the same way signaling does. The live P2P/relay path is untouched.
    // Webhooks: outbound HMAC-signed event delivery (created before share links so the
    // share-link audit hook can dispatch from the first event).
    const webhookStore = await createWebhookStore();
    webhooks = new WebhookManager({ store: webhookStore });
    console.log(`[LinkSpan] Webhooks ready (store=${webhookStore.backend}).`);

    const storageBackend = await createStorageBackend();
    const shareLinkStore = await createShareLinkStore();
    shareLinks = new ShareLinkManager({
        store: shareLinkStore,
        storage: storageBackend,
        baseUrl: PUBLIC_BASE_URL,
        onAudit: ({ event, detail }) => recordAudit(event, detail),
    });
    shareLinks.startSweeper();
    console.log(`[LinkSpan] Share links ready (storage=${storageBackend.kind}, meta=${shareLinkStore.backend}).`);

    const apiKeys = new ApiKeyManager();
    const httpLimiter = new HttpRateLimiter({ redisClient: rateLimiter?.redisClient || null });

    // Accounts/auth (optional ownership layer). The account store is Prisma-backed when
    // DATABASE_URL is set, else in-memory. OAuth providers are enabled per configured creds.
    const accountStore = await createAccountStore();
    const accountManager = new AccountManager({ store: accountStore, apiKeys });
    const oauthProviders = createOAuthProviders();
    console.log(`[LinkSpan] Accounts ready (store=${accountStore.backend}, oauth=[${Object.keys(oauthProviders).join(',')}]).`);

    // Attach the trusted client IP for HTTP rate limiting (mirrors WS getClientIp).
    app.use((req, _res, next) => { req.clientIp = getClientIp(req); next(); });

    app.use(API_BASE_PATH, createApiRouter({
        shareLinks,
        apiKeys,
        httpLimiter,
        sessionManager,
        tokenManager,
        webhooks,
        accountManager,
        oauthProviders,
        telemetry: telemetryAggregator,
        baseUrl: PUBLIC_BASE_URL,
        audit: (event, detail) => recordAudit(event, detail),
    }));

    // Human-facing share URL: redirect to the client app's viewer if configured, else
    // straight to the raw download endpoint. The id is validated to a 32-hex token.
    app.get('/s/:id', (req, res) => {
        const id = String(req.params.id);
        if (!/^[a-f0-9]{32}$/.test(id)) return res.status(404).json({ error: 'Not found' });
        const target = SHARE_VIEW_URL ? `${SHARE_VIEW_URL}/s/${id}` : `${API_BASE_PATH}/links/${id}/download`;
        res.redirect(302, target);
    });

    // ── WebSocket Server ────────────────────────────────────────────────
    // Assign to module-level lets so they are accessible for export
    server = http.createServer(app);
    // maxPayload must fit a relay-chunk frame (base64 of a ~256 KB chunk ≈ 350 KB).
    // Control/signaling messages are separately capped at MAX_MESSAGE_SIZE below.
    wss = new WebSocketServer({ server, maxPayload: MAX_RELAY_FRAME_SIZE });

    // ── WebSocket Connection Handler ───────────────────────────
    wss.on('connection', async (ws, req) => {
        const ip = getClientIp(req);

        const peerId = uuidv4();
        let boundSessionId = null;
        let boundRoomId = null;

        // ── Room helpers (closure over ws/peerId/boundRoomId) ──
        // Verify the caller presented a valid member token for the room it's bound to.
        const verifyRoomToken = (data) => {
            const claims = tokenManager.verify(data.token);
            return Boolean(claims && claims.roomId === boundRoomId && claims.peerId === peerId);
        };
        // Push the current roster + derived topology to every member (membership changed).
        const broadcastRoster = (roomId) => {
            const peers = roomManager.roster(roomId);
            const topology = roomManager.topology(roomId);
            for (const { peerId: pid } of peers) {
                roomManager.sendToPeer(roomId, pid, { type: MSG.ROOM_ROSTER, roomId, topology, peers });
            }
        };
        // Route a targeted N-peer signaling message (offer/answer/ice) to `data.to`.
        const forwardRoomSignal = (data) => {
            if (!verifyRoomToken(data)) { sendError(ws, ERR.UNAUTHORIZED, 'Invalid or expired room token.'); return; }
            const to = data.to;
            if (typeof to !== 'string' || !roomManager.validatePeer(boundRoomId, to)) {
                sendError(ws, ERR.INVALID_MESSAGE, 'Invalid target peer.'); return;
            }
            roomManager.sendToPeer(boundRoomId, to, { type: data.type, from: peerId, payload: data.payload });
        };

        // Admission gate. The connection rate-limit check below is async (a real
        // Redis round-trip on the clustered backend). The message listener MUST be
        // attached before awaiting it — otherwise a client that sends a frame
        // immediately after the socket opens can have it dropped (ws discards
        // 'message' events that have no listener yet). Frames that arrive before the
        // admission decision are queued here, then drained once admitted (or
        // discarded if the connection is rejected).
        let admitted = null; // null = pending · true = allowed · false = rejected
        const pendingFrames = [];

        const handleMessage = async (raw) => {
            // Rate-limit messages
            const msgAllowed = await rateLimiter.allowMessage(ip);
            if (!msgAllowed) {
                sendError(ws, ERR.RATE_LIMITED, 'Message rate exceeded.');
                return;
            }

            // Frame-size policy: only relay-chunk frames may use the large maxPayload
            // budget. Everything else (signaling/control) is held to MAX_MESSAGE_SIZE
            // so the relay allowance can't be abused for control-message flooding.
            const rawLen = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length;

            let data;
            try {
                const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
                data = JSON.parse(text);
            } catch {
                sendError(ws, ERR.INVALID_MESSAGE, 'Invalid JSON.');
                return;
            }

            if (!data || typeof data.type !== 'string') {
                sendError(ws, ERR.INVALID_MESSAGE, 'Missing or invalid message type.');
                return;
            }

            if (data.type !== MSG.RELAY_CHUNK && rawLen > MAX_MESSAGE_SIZE) {
                sendError(ws, ERR.INVALID_MESSAGE, 'Control message too large.');
                return;
            }

            // Centralized input validation
            const validation = InputValidator.validate(data);
            if (!validation.valid) {
                sendError(ws, ERR.INVALID_MESSAGE, validation.reason || 'Invalid message.');
                return;
            }

            switch (data.type) {
                // ── Create Session ───────────────────────────────────────
                case MSG.CREATE_SESSION: {
                    const canCreate = await rateLimiter.allowSessionCreation(ip);
                    if (!canCreate) {
                        metricsCollector.recordRateLimitHit();
                        auditLogger.rateLimitHit(ip, { action: 'CREATE_SESSION' });
                        sendError(ws, ERR.RATE_LIMITED, 'Session creation limit reached.');
                        return;
                    }

                    if (boundSessionId) {
                        sendError(ws, ERR.INVALID_MESSAGE, 'Already in a session.');
                        return;
                    }

                    // AWAIT: createSession is async on the Redis backend
                    const { sessionId, pairingCode } = await sessionManager.createSession();

                    // Issue a signed HMAC token binding this peer to this session
                    const token = tokenManager.sign({ sessionId, peerId, role: 'sender' });

                    // AWAIT: addPeer is async on the Redis backend
                    await sessionManager.addPeer(sessionId, peerId, ws, 'sender');
                    boundSessionId = sessionId;

                    metricsCollector.recordSessionCreated();
                    metricsCollector.incrementActiveSessions();
                    auditLogger.sessionCreated(ip, sessionId);

                    sendJson(ws, {
                        type: MSG.SESSION_CREATED,
                        sessionId,
                        pairingCode,
                        token,
                    });
                    break;
                }

                // ── Join Session ─────────────────────────────────────────
                case MSG.JOIN_SESSION: {
                    const { pairingCode } = data;

                    // Brute-force lockout check
                    if (await bruteForce.isLocked(ip)) {
                        const remaining = Math.ceil((await bruteForce.getLockoutRemaining(ip)) / 60000);
                        auditLogger.bruteForceLockout(ip, { remaining });
                        sendError(
                            ws,
                            ERR.BRUTE_FORCE_LOCKED,
                            `Too many failed attempts. Locked for ${remaining} more minute(s).`
                        );
                        return;
                    }

                    const canJoin = await rateLimiter.allowJoinAttempt(ip);
                    if (!canJoin) {
                        metricsCollector.recordRateLimitHit();
                        auditLogger.rateLimitHit(ip, { action: 'JOIN_SESSION' });
                        sendError(ws, ERR.RATE_LIMITED, 'Too many join attempts. Please wait.');
                        return;
                    }

                    // AWAIT: joinSession is async on the Redis backend
                    const result = await sessionManager.joinSession(pairingCode);
                    if (!result) {
                        const { attempts } = await bruteForce.recordFailure(ip);
                        auditLogger.sessionJoinFailed(ip, { attempts });
                        sendError(
                            ws,
                            ERR.SESSION_NOT_FOUND,
                            `Session not found or already full. (Attempt ${attempts})`
                        );
                        return;
                    }

                    const { sessionId } = result;

                    // Issue a signed HMAC token binding this peer to this session
                    const token = tokenManager.sign({ sessionId, peerId, role: 'receiver' });

                    // AWAIT: addPeer is async on the Redis backend
                    const added = await sessionManager.addPeer(sessionId, peerId, ws, 'receiver');
                    if (!added) {
                        sendError(ws, ERR.SESSION_FULL, 'Session is full.');
                        return;
                    }

                    await bruteForce.recordSuccess(ip);
                    boundSessionId = sessionId;
                    auditLogger.sessionJoined(ip, sessionId, peerId);

                    sendJson(ws, { type: MSG.SESSION_CREATED, sessionId, token });

                    // Notify the other peer (possibly on another instance).
                    await sessionManager.sendToOtherPeer(sessionId, peerId, {
                        type: MSG.PEER_JOINED,
                        sessionId,
                    });
                    break;
                }

                // ── Relay: Offer ─────────────────────────────────────────
                case MSG.OFFER: {
                    if (boundRoomId) { forwardRoomSignal(data); break; }
                    if (!boundSessionId) {
                        sendError(ws, ERR.INVALID_MESSAGE, 'Not in a session.');
                        return;
                    }

                    // Enforce HMAC token — prevents any peer from injecting offers
                    // into sessions they don't legitimately belong to
                    const offerClaims = tokenManager.verify(data.token);
                    if (
                        !offerClaims ||
                        offerClaims.sessionId !== boundSessionId ||
                        offerClaims.peerId !== peerId
                    ) {
                        auditLogger.tokenValidationFailed?.(ip, boundSessionId, { action: 'OFFER' });
                        sendError(ws, ERR.UNAUTHORIZED, 'Invalid or expired session token.');
                        return;
                    }

                    if (!isValidSdpPayload(data.payload, 'offer')) {
                        sendError(ws, ERR.INVALID_MESSAGE, 'Invalid offer payload.');
                        return;
                    }

                    await sessionManager.sendToOtherPeer(boundSessionId, peerId, {
                        type: MSG.OFFER,
                        payload: data.payload,
                    });
                    break;
                }

                // ── Relay: Answer ─────────────────────────────────────────
                case MSG.ANSWER: {
                    if (boundRoomId) { forwardRoomSignal(data); break; }
                    if (!boundSessionId) {
                        sendError(ws, ERR.INVALID_MESSAGE, 'Not in a session.');
                        return;
                    }

                    const answerClaims = tokenManager.verify(data.token);
                    if (
                        !answerClaims ||
                        answerClaims.sessionId !== boundSessionId ||
                        answerClaims.peerId !== peerId
                    ) {
                        auditLogger.tokenValidationFailed?.(ip, boundSessionId, { action: 'ANSWER' });
                        sendError(ws, ERR.UNAUTHORIZED, 'Invalid or expired session token.');
                        return;
                    }

                    if (!isValidSdpPayload(data.payload, 'answer')) {
                        sendError(ws, ERR.INVALID_MESSAGE, 'Invalid answer payload.');
                        return;
                    }

                    await sessionManager.sendToOtherPeer(boundSessionId, peerId, {
                        type: MSG.ANSWER,
                        payload: data.payload,
                    });
                    break;
                }

                // ── Relay: ICE Candidate ──────────────────────────────────
                case MSG.ICE_CANDIDATE: {
                    if (boundRoomId) { forwardRoomSignal(data); break; }
                    if (!boundSessionId) {
                        sendError(ws, ERR.INVALID_MESSAGE, 'Not in a session.');
                        return;
                    }

                    const iceClaims = tokenManager.verify(data.token);
                    if (
                        !iceClaims ||
                        iceClaims.sessionId !== boundSessionId ||
                        iceClaims.peerId !== peerId
                    ) {
                        auditLogger.tokenValidationFailed?.(ip, boundSessionId, { action: 'ICE_CANDIDATE' });
                        sendError(ws, ERR.UNAUTHORIZED, 'Invalid or expired session token.');
                        return;
                    }

                    if (!isValidIcePayload(data.payload)) {
                        sendError(ws, ERR.INVALID_MESSAGE, 'Invalid ICE candidate payload.');
                        return;
                    }

                    await sessionManager.sendToOtherPeer(boundSessionId, peerId, {
                        type: MSG.ICE_CANDIDATE,
                        payload: data.payload,
                    });
                    break;
                }

                // ── Cancel (relay to peer) ────────────────────────────────
                case 'cancel': {
                    if (!boundSessionId) return;
                    // Cancel doesn't need token — it's a session-scoped signal
                    // and the peer is already validated as being in the session
                    if (!sessionManager.validatePeer(boundSessionId, peerId)) return;
                    await sessionManager.sendToOtherPeer(boundSessionId, peerId, { type: 'cancel' });
                    break;
                }

                // ── Relay Request (activate WS relay fallback) ────────────
                case MSG.RELAY_REQUEST: {
                    if (!boundSessionId) {
                        sendError(ws, ERR.INVALID_MESSAGE, 'Not in a session.');
                        return;
                    }

                    // Token required for relay activation
                    const relayClaims = tokenManager.verify(data.token);
                    if (
                        !relayClaims ||
                        relayClaims.sessionId !== boundSessionId ||
                        relayClaims.peerId !== peerId
                    ) {
                        sendError(ws, ERR.UNAUTHORIZED, 'Invalid or expired session token.');
                        return;
                    }

                    await sessionManager.activateRelay(boundSessionId);
                    metricsCollector.recordRelayActivation();
                    auditLogger.relayActivated(boundSessionId, { peerId });

                    sendJson(ws, { type: MSG.RELAY_READY, sessionId: boundSessionId });
                    await sessionManager.sendToOtherPeer(boundSessionId, peerId, {
                        type: MSG.RELAY_READY,
                        sessionId: boundSessionId,
                    });
                    break;
                }

                // ── Relay Chunk (forward to other peer) ───────────────────
                case MSG.RELAY_CHUNK: {
                    if (!boundSessionId) {
                        sendError(ws, ERR.INVALID_MESSAGE, 'Not in a session.');
                        return;
                    }

                    // Token required for each relay chunk (prevents injection)
                    const chunkClaims = tokenManager.verify(data.token);
                    if (
                        !chunkClaims ||
                        chunkClaims.sessionId !== boundSessionId ||
                        chunkClaims.peerId !== peerId
                    ) {
                        sendError(ws, ERR.UNAUTHORIZED, 'Invalid or expired session token.');
                        return;
                    }

                    // Compute the byte count SERVER-SIDE — never trust the client's
                    // `size` field (a forged size:0 would otherwise evade the relay
                    // byte cap). For binary frames, derive the original size from the
                    // base64 length (≈ 3/4); for text frames, use the string length.
                    const chunkBytes = data.isText
                        ? (data.payload?.length ?? 0)
                        : Math.floor((data.b64?.length ?? 0) * 3 / 4);

                    // Atomically require relay-active and enforce the per-session byte
                    // cap (Redis-backed when clustered, so the cap holds across instances).
                    const { ok, reason } = await sessionManager.accountRelay(boundSessionId, chunkBytes);
                    if (!ok) {
                        sendError(ws, ERR.INVALID_MESSAGE, reason || 'Relay limit exceeded.');
                        break;
                    }

                    // Strip the token before forwarding — receiver doesn't need it
                    const { token: _t, ...forwardData } = data;
                    await sessionManager.sendToOtherPeer(boundSessionId, peerId, {
                        type: MSG.RELAY_CHUNK,
                        ...forwardData,
                    });
                    break;
                }

                // ── Relay Complete ────────────────────────────────────────
                case MSG.RELAY_COMPLETE: {
                    if (boundSessionId) {
                        await sessionManager.deactivateRelay(boundSessionId);
                    }
                    break;
                }

                // ── Disconnect ───────────────────────────────────────────
                case MSG.DISCONNECT: {
                    if (boundSessionId) {
                        await sessionManager.sendToOtherPeer(boundSessionId, peerId, {
                            type: MSG.SESSION_CLOSED,
                            reason: 'peer-disconnected',
                        });
                        // AWAIT: removePeer is async on Redis backend
                        await sessionManager.removePeer(boundSessionId, peerId);
                        boundSessionId = null;
                    }
                    break;
                }

                // ── Create Room (N-peer) ──────────────────────────────────
                case MSG.CREATE_ROOM: {
                    if (!(await rateLimiter.allowSessionCreation(ip))) {
                        metricsCollector.recordRateLimitHit();
                        sendError(ws, ERR.RATE_LIMITED, 'Room creation limit reached.');
                        return;
                    }
                    if (boundSessionId || boundRoomId) {
                        sendError(ws, ERR.INVALID_MESSAGE, 'Already in a session or room.');
                        return;
                    }
                    const { roomId, joinCode } = roomManager.createRoom();
                    const token = tokenManager.sign({ roomId, peerId, role: 'member' });
                    roomManager.addPeer(roomId, peerId, ws, typeof data.name === 'string' ? data.name : null);
                    boundRoomId = roomId;
                    recordAudit('ROOM_CREATED', { id: roomId, ip });
                    sendJson(ws, {
                        type: MSG.ROOM_CREATED, roomId, joinCode, peerId, token,
                        topology: roomManager.topology(roomId),
                    });
                    broadcastRoster(roomId);
                    break;
                }

                // ── Join Room ─────────────────────────────────────────────
                case MSG.JOIN_ROOM: {
                    if (await bruteForce.isLocked(ip)) {
                        const remaining = Math.ceil((await bruteForce.getLockoutRemaining(ip)) / 60000);
                        sendError(ws, ERR.BRUTE_FORCE_LOCKED, `Too many failed attempts. Locked for ${remaining} more minute(s).`);
                        return;
                    }
                    if (!(await rateLimiter.allowJoinAttempt(ip))) {
                        metricsCollector.recordRateLimitHit();
                        sendError(ws, ERR.RATE_LIMITED, 'Too many join attempts. Please wait.');
                        return;
                    }
                    if (boundSessionId || boundRoomId) {
                        sendError(ws, ERR.INVALID_MESSAGE, 'Already in a session or room.');
                        return;
                    }
                    const result = roomManager.joinByCode(data.joinCode);
                    if (!result) {
                        const { attempts } = await bruteForce.recordFailure(ip);
                        sendError(ws, ERR.SESSION_NOT_FOUND, `Room not found or full. (Attempt ${attempts})`);
                        return;
                    }
                    const { roomId } = result;
                    const name = typeof data.name === 'string' ? data.name : null;
                    const token = tokenManager.sign({ roomId, peerId, role: 'member' });
                    roomManager.addPeer(roomId, peerId, ws, name);
                    await bruteForce.recordSuccess(ip);
                    boundRoomId = roomId;
                    recordAudit('ROOM_PEER_JOINED', { id: roomId, peerId, ip });
                    sendJson(ws, {
                        type: MSG.ROOM_CREATED, roomId, peerId, token,
                        topology: roomManager.topology(roomId),
                    });
                    roomManager.broadcast(roomId, peerId, { type: MSG.ROOM_PEER_JOINED, peerId, name });
                    broadcastRoster(roomId);
                    break;
                }

                // ── Leave Room ────────────────────────────────────────────
                case MSG.LEAVE_ROOM: {
                    if (boundRoomId) {
                        const roomId = boundRoomId;
                        chunkRegistry.prunePeer(roomId, peerId);
                        roomManager.removePeer(roomId, peerId);
                        boundRoomId = null;
                        roomManager.broadcast(roomId, peerId, { type: MSG.ROOM_PEER_LEFT, peerId });
                        broadcastRoster(roomId);
                    }
                    break;
                }

                // ── Swarm: announce a file manifest ───────────────────────
                case SWARM_MSG.ANNOUNCE: {
                    if (!boundRoomId || !verifyRoomToken(data)) {
                        sendError(ws, ERR.UNAUTHORIZED, 'Invalid or expired room token.');
                        return;
                    }
                    chunkRegistry.announce(boundRoomId, peerId, data.fileId, data.totalChunks, { origin: data.origin === true });
                    roomManager.broadcast(boundRoomId, peerId, {
                        type: SWARM_MSG.ANNOUNCE, from: peerId, fileId: data.fileId, totalChunks: data.totalChunks,
                    });
                    break;
                }

                // ── Swarm: peer now holds chunk(s) ────────────────────────
                case SWARM_MSG.HAVE: {
                    if (!boundRoomId || !verifyRoomToken(data)) {
                        sendError(ws, ERR.UNAUTHORIZED, 'Invalid or expired room token.');
                        return;
                    }
                    chunkRegistry.have(boundRoomId, peerId, data.fileId, data.indices);
                    roomManager.broadcast(boundRoomId, peerId, {
                        type: SWARM_MSG.HAVE, from: peerId, fileId: data.fileId, indices: data.indices,
                    });
                    break;
                }

                // ── Swarm: who has this chunk? ────────────────────────────
                case SWARM_MSG.NEED: {
                    if (!boundRoomId || !verifyRoomToken(data)) {
                        sendError(ws, ERR.UNAUTHORIZED, 'Invalid or expired room token.');
                        return;
                    }
                    const peers = chunkRegistry.peersFor(boundRoomId, data.fileId, data.index).filter((p) => p !== peerId);
                    sendJson(ws, { type: SWARM_MSG.PEERS, fileId: data.fileId, index: data.index, peers });
                    break;
                }

                default:
                    sendError(ws, ERR.INVALID_MESSAGE, `Unknown message type: ${data.type}`);
            }
        };

        // Attach the listener synchronously (see admission-gate note above).
        ws.on('message', (raw) => {
            if (admitted === false) return;          // rejected connection — drop
            if (admitted === null) { pendingFrames.push(raw); return; } // not yet decided
            handleMessage(raw);
        });

        // Remove this peer from any room it's in and tell the others.
        const leaveRoomOnDisconnect = () => {
            if (!boundRoomId) return;
            const roomId = boundRoomId;
            boundRoomId = null;
            chunkRegistry.prunePeer(roomId, peerId);
            roomManager.removePeer(roomId, peerId);
            roomManager.broadcast(roomId, peerId, { type: MSG.ROOM_PEER_LEFT, peerId });
            broadcastRoster(roomId);
        };

        ws.on('close', async () => {
            leaveRoomOnDisconnect();
            if (boundSessionId) {
                // Notify the peer before removing ourselves from the session.
                await sessionManager.sendToOtherPeer(boundSessionId, peerId, {
                    type: MSG.SESSION_CLOSED,
                    reason: 'peer-disconnected',
                });
                metricsCollector.decrementActiveSessions();
                auditLogger.sessionClosed(boundSessionId, { peerId, reason: 'close' });
                // AWAIT: removePeer is async on Redis backend
                await sessionManager.removePeer(boundSessionId, peerId);
                boundSessionId = null;
            }
        });

        ws.on('error', async () => {
            leaveRoomOnDisconnect();
            if (boundSessionId) {
                metricsCollector.decrementActiveSessions();
                await sessionManager.removePeer(boundSessionId, peerId);
                boundSessionId = null;
            }
        });

        // All listeners attached — now run the async connection admission check.
        const allowed = await rateLimiter.allowConnection(ip);
        if (!allowed) {
            admitted = false;
            pendingFrames.length = 0;
            sendError(ws, ERR.RATE_LIMITED, 'Too many connections. Try again later.');
            ws.close();
            return;
        }
        admitted = true;
        // Drain any frames that arrived during the admission check, in order.
        const queued = pendingFrames.splice(0);
        for (const raw of queued) handleMessage(raw);
    });

    // ── Graceful Shutdown ──────────────────────────────────────
    function shutdown() {
        console.log('[LinkSpan] Shutting down gracefully...');
        // shutdown may be async on Redis backend
        Promise.resolve(sessionManager.shutdown()).catch(() => {});
        Promise.resolve(bruteForce.shutdown()).catch(() => {});
        roomManager.shutdown();
        if (shareLinks) shareLinks.stopSweeper();
        wss.close(() => {
            server.close(() => {
                process.exit(0);
            });
        });
    }

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    // ── Start listening ────────────────────────────────────────
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`[LinkSpan] Signaling server running on port ${PORT}`);
    });
}

// ── Entry point ────────────────────────────────────────────────
await bootstrap().catch((err) => {
    console.error('[LinkSpan] Fatal startup error:', err.message);
    process.exit(1);
});

// Export the Express app and populated refs for tests
export { app, server, wss, sessionManager, shareLinks };

