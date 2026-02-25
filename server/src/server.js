import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import helmet from 'helmet';
import { v4 as uuidv4 } from 'uuid';
import { SessionManager } from './SessionManager.js';
import { RateLimiter } from './RateLimiter.js';
import {
    MSG,
    MAX_MESSAGE_SIZE,
    ERR,
} from '../../shared/constants.js';

const PORT = process.env.PORT || 10000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// ── Express Setup ──────────────────────────────────────────────
const app = express();
app.use(helmet());
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// Health check endpoint (keeps Render from marking as unhealthy)
app.get('/', (_req, res) => {
    res.json({ status: 'ok', service: 'linkspan-signaling' });
});

app.get('/health', (_req, res) => {
    const stats = sessionManager.getStats();
    res.json({ status: 'ok', ...stats });
});

// ── Signaling Core ─────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_SIZE });
const sessionManager = new SessionManager();
const rateLimiter = new RateLimiter();

/**
 * Extract client IP from request, handling proxies.
 */
function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress || '0.0.0.0';
}

/**
 * Send a JSON message to a WebSocket.
 */
function sendJson(ws, data) {
    if (ws.readyState === 1) {
        ws.send(JSON.stringify(data));
    }
}

/**
 * Send an error message to a WebSocket.
 */
function sendError(ws, code, message) {
    sendJson(ws, { type: MSG.SESSION_ERROR, error: { code, message } });
}

// ── WebSocket Connection Handler ───────────────────────────────
wss.on('connection', async (ws, req) => {
    const ip = getClientIp(req);

    // Rate-limit connections
    const allowed = await rateLimiter.allowConnection(ip);
    if (!allowed) {
        sendError(ws, ERR.RATE_LIMITED, 'Too many connections. Try again later.');
        ws.close();
        return;
    }

    // Assign a unique peer ID to this connection
    const peerId = uuidv4();
    let boundSessionId = null;

    ws.on('message', async (raw) => {
        // Rate-limit messages
        const msgAllowed = await rateLimiter.allowMessage(ip);
        if (!msgAllowed) {
            sendError(ws, ERR.RATE_LIMITED, 'Message rate exceeded.');
            return;
        }

        let data;
        try {
            const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
            data = JSON.parse(text);
        } catch {
            sendError(ws, ERR.INVALID_MESSAGE, 'Invalid JSON.');
            return;
        }

        if (!data || !data.type) {
            sendError(ws, ERR.INVALID_MESSAGE, 'Missing message type.');
            return;
        }

        switch (data.type) {
            // ── Create Session ───────────────────────────────────────
            case MSG.CREATE_SESSION: {
                const canCreate = await rateLimiter.allowSessionCreation(ip);
                if (!canCreate) {
                    sendError(ws, ERR.RATE_LIMITED, 'Session creation limit reached.');
                    return;
                }

                const { sessionId, pairingCode, token } =
                    sessionManager.createSession();
                sessionManager.addPeer(sessionId, peerId, ws);
                boundSessionId = sessionId;

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
                if (
                    !pairingCode ||
                    typeof pairingCode !== 'string' ||
                    pairingCode.length !== 6
                ) {
                    sendError(ws, ERR.INVALID_PAIRING_CODE, 'Invalid pairing code.');
                    return;
                }

                const result = sessionManager.joinSession(pairingCode);
                if (!result) {
                    sendError(
                        ws,
                        ERR.SESSION_NOT_FOUND,
                        'Session not found or already full.'
                    );
                    return;
                }

                const { sessionId, token } = result;
                const added = sessionManager.addPeer(sessionId, peerId, ws);
                if (!added) {
                    sendError(ws, ERR.SESSION_FULL, 'Session is full.');
                    return;
                }

                boundSessionId = sessionId;

                // Notify the joiner
                sendJson(ws, {
                    type: MSG.SESSION_CREATED,
                    sessionId,
                    token,
                });

                // Notify the other peer that someone joined
                const otherWs = sessionManager.getOtherPeer(sessionId, peerId);
                if (otherWs) {
                    sendJson(otherWs, {
                        type: MSG.PEER_JOINED,
                        sessionId,
                    });
                }
                break;
            }

            // ── Relay: Offer ─────────────────────────────────────────
            case MSG.OFFER:
            case MSG.ANSWER:
            case MSG.ICE_CANDIDATE: {
                if (!boundSessionId) {
                    sendError(ws, ERR.INVALID_MESSAGE, 'Not in a session.');
                    return;
                }

                const otherWs = sessionManager.getOtherPeer(
                    boundSessionId,
                    peerId
                );
                if (otherWs) {
                    sendJson(otherWs, {
                        type: data.type,
                        payload: data.payload,
                    });
                }
                break;
            }

            // ── Disconnect ───────────────────────────────────────────
            case MSG.DISCONNECT: {
                if (boundSessionId) {
                    const otherWs = sessionManager.getOtherPeer(
                        boundSessionId,
                        peerId
                    );
                    if (otherWs) {
                        sendJson(otherWs, {
                            type: MSG.SESSION_CLOSED,
                            reason: 'peer-disconnected',
                        });
                    }
                    sessionManager.removePeer(boundSessionId, peerId);
                    boundSessionId = null;
                }
                break;
            }

            default:
                sendError(ws, ERR.INVALID_MESSAGE, `Unknown message type: ${data.type}`);
        }
    });

    ws.on('close', () => {
        if (boundSessionId) {
            const otherWs = sessionManager.getOtherPeer(boundSessionId, peerId);
            if (otherWs) {
                sendJson(otherWs, {
                    type: MSG.SESSION_CLOSED,
                    reason: 'peer-disconnected',
                });
            }
            sessionManager.removePeer(boundSessionId, peerId);
        }
    });

    ws.on('error', () => {
        if (boundSessionId) {
            sessionManager.removePeer(boundSessionId, peerId);
        }
    });
});

// ── Graceful Shutdown ──────────────────────────────────────────
function shutdown() {
    console.log('Shutting down...');
    sessionManager.shutdown();
    wss.close(() => {
        server.close(() => {
            process.exit(0);
        });
    });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ── Start ──────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
    console.log(`LinkSpan signaling server running on port ${PORT}`);
});

export { app, server, wss, sessionManager };
