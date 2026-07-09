/**
 * IceServers — resolves the ICE server list used by every RTCPeerConnection.
 *
 * Priority order:
 *   1. Ephemeral TURN credentials fetched from the signaling server's
 *      GET /api/v1/turn-credentials (minted server-side — Cloudflare or coturn
 *      static-secret — so no TURN secret ships in this bundle). Cached in-module
 *      until 75% of the server-reported TTL has elapsed.
 *   2. Static VITE_TURN_DOMAIN/VITE_TURN_USERNAME/VITE_TURN_CREDENTIAL env
 *      (legacy metered.ca-style config; the credentials are public in the bundle).
 *   3. STUN only — direct P2P still works for most NATs, and the app has its own
 *      WebSocket relay fallback when it doesn't.
 *
 * Two entry points because not every construction site can await:
 *   - resolveIceServers(): async, fetches (or reuses cache) — use before creating
 *     a 1:1 transfer connection.
 *   - getCachedIceServers(): sync, returns whatever is cached now (else the static
 *     fallback) — used by PeerConnection's constructor and the room mesh, where
 *     peers are created synchronously. Call prefetchIceServers() early so the
 *     cache is warm by the time it's read.
 */

// Dual-stack (IPv6-capable) public STUN servers. The browser gathers IPv6 host
// and server-reflexive (srflx) candidates automatically when the OS has IPv6 —
// querying STUN over a dual-stack server lets peers discover their IPv6 srflx
// address, and since IPv6 typically has no NAT, two peers on different networks
// can often form a DIRECT connection over IPv6 without ever touching a TURN relay.
// Keep these reachable over both A/AAAA so candidate gathering isn't stuck on IPv4.
const STUN_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.nextcloud.com:443' },
];

const FETCH_TIMEOUT_MS = 3000;   // pairing shouldn't stall on a slow credential fetch
const CACHE_FRACTION = 0.75;

let _cache = null;               // { servers, expiresAt }
let _pending = null;             // in-flight resolve, deduped

function env() {
    return (typeof import.meta !== 'undefined' && import.meta.env) || {};
}

/** REST base derived the same way as ShareLinkClient: ws→http, wss→https. */
function apiBase() {
    const e = env();
    if (e.VITE_API_URL) return e.VITE_API_URL.replace(/\/+$/, '');
    const sig = e.VITE_SIGNALING_URL || 'ws://localhost:10000';
    return sig.replace(/^ws/, 'http').replace(/\/+$/, '') + '/api/v1';
}

/** Static env-var TURN config (legacy) appended to the STUN defaults. */
function staticFallback() {
    const e = env();
    const servers = [...STUN_SERVERS];
    const turnDomain = e.VITE_TURN_DOMAIN || 'global.relay.metered.ca';
    const turnUser = e.VITE_TURN_USERNAME;
    const turnCred = e.VITE_TURN_CREDENTIAL;
    if (turnUser && turnCred) {
        servers.push(
            { urls: `turn:${turnDomain}:80`, username: turnUser, credential: turnCred },
            { urls: `turn:${turnDomain}:443`, username: turnUser, credential: turnCred },
            { urls: `turns:${turnDomain}:443`, username: turnUser, credential: turnCred },
        );
    }
    return servers;
}

/**
 * Synchronous snapshot: cached ephemeral servers if fresh, else the static fallback.
 * @returns {RTCIceServer[]}
 */
export function getCachedIceServers() {
    if (_cache && Date.now() < _cache.expiresAt) return _cache.servers;
    return staticFallback();
}

/**
 * Resolve the best ICE server list, fetching ephemeral TURN credentials when the
 * server offers them. Never rejects — every failure path returns a usable list.
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<RTCIceServer[]>}
 */
export function resolveIceServers({ fetchImpl } = {}) {
    if (_cache && Date.now() < _cache.expiresAt) return Promise.resolve(_cache.servers);
    if (_pending) return _pending;

    const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    if (!doFetch) return Promise.resolve(staticFallback());

    _pending = (async () => {
        try {
            const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const timer = ctrl ? setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS) : null;
            const res = await doFetch(`${apiBase()}/turn-credentials`, {
                signal: ctrl?.signal,
            });
            if (timer) clearTimeout(timer);
            if (!res.ok) throw new Error(`turn-credentials responded ${res.status}`);
            const body = await res.json();
            const turn = Array.isArray(body.iceServers) ? body.iceServers.filter((s) => s && s.urls) : [];
            if (!turn.length || !body.ttl) return staticFallback();

            // STUN first (cheapest candidates), then the minted TURN servers.
            const servers = [...STUN_SERVERS, ...turn];
            _cache = { servers, expiresAt: Date.now() + body.ttl * 1000 * CACHE_FRACTION };
            return servers;
        } catch {
            // Endpoint missing/down/slow — TURN is an optimization, not a requirement.
            return staticFallback();
        } finally {
            _pending = null;
        }
    })();
    return _pending;
}

/**
 * Fire-and-forget cache warm-up for synchronous construction sites (room mesh).
 */
export function prefetchIceServers() {
    resolveIceServers().catch(() => {});
}

/** Test hook: clear module cache between cases. */
export function _resetIceServerCache() {
    _cache = null;
    _pending = null;
}
