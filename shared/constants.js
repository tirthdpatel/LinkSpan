/**
 * LinkSpan — Shared Constants
 * Used by both signaling server and client.
 */

export const PROTOCOL_VERSION = '1.7.0';

// ── Transfer ───────────────────────────────────────────────────
export const DEFAULT_CHUNK_SIZE = 256 * 1024; // 256 KB

// ── Encryption (application-layer E2E, always on) ──────────────
// AES-256-GCM adds a 12-byte IV + 16-byte auth tag per chunk. To keep the
// on-the-wire ciphertext within the 256 KB DataChannel message limit, the
// plaintext chunk size is reduced by this overhead when encryption is active.
export const GCM_OVERHEAD_BYTES = 12 + 16; // IV + tag
export const ENCRYPTED_CHUNK_SIZE = DEFAULT_CHUNK_SIZE - GCM_OVERHEAD_BYTES; // 262116 B plaintext

/**
 * Dynamic chunking (Phase 4.3): choose the plaintext chunk size for a transfer.
 *
 * The hard ceiling is the WebRTC DataChannel message limit (256 KB). The framed
 * message is `[4-byte index header][IV+ciphertext+tag]`, so the largest plaintext
 * that still fits is DEFAULT_CHUNK_SIZE minus the header and GCM overhead. We never
 * exceed that. Below the ceiling we scale the chunk size down for small files so
 * that progress/retry granularity stays reasonable (a 200 KB file shouldn't be a
 * single all-or-nothing chunk), and use the max for large files to minimise
 * per-chunk control-message and round-trip overhead.
 *
 * @param {number} fileSize - total file size in bytes
 * @param {boolean} [encrypted=true] - whether app-layer encryption is active
 * @returns {number} plaintext chunk size in bytes
 */
export const CHUNK_HEADER_BYTES = 4; // packChunk Uint32 index prefix
export function pickChunkSize(fileSize, encrypted = true) {
    const overhead = CHUNK_HEADER_BYTES + (encrypted ? GCM_OVERHEAD_BYTES : 0);
    const max = DEFAULT_CHUNK_SIZE - overhead; // largest plaintext that frames ≤ 256 KB
    if (!Number.isFinite(fileSize) || fileSize <= 0) return max;
    if (fileSize <= 1 * 1024 * 1024) return Math.min(64 * 1024, max);   // ≤ 1 MB  → 64 KB
    if (fileSize <= 100 * 1024 * 1024) return Math.min(256 * 1024, max); // ≤ 100 MB → ~256 KB (capped)
    return max;                                                          // large    → max
}
export const MAX_CHANNELS = 7;
// Parallel RTCPeerConnections per transfer (multi-connection striping). All data
// channels on one RTCPeerConnection share a single SCTP association — and one
// congestion window — so on high-RTT paths a lone connection caps throughput no
// matter how many channels it carries. Extra connections each get their own
// congestion window, multiplying steady-state throughput roughly by their count.
// The capability is negotiated in-band (answer payload `multiConn`) and the extra
// connections are multiplexed over the same signaling session via a `pcIndex`
// field inside SDP/ICE payloads, so old peers and old servers are unaffected.
export const EXTRA_PEER_CONNECTIONS = 3; // secondaries; total = 1 + this
// Data channels per SECONDARY connection. Channels on one association share its
// congestion window, so extra channels add head-of-line relief, not bandwidth;
// a couple per secondary keeps meta+binary pairs flowing without the setup cost
// of another 7.
export const SECONDARY_PC_CHANNELS = 2;
// Receiver pull-window: how many chunks may be requested but not yet received at
// once. This is the bandwidth-delay-product lever — throughput is roughly
// (MAX_IN_FLIGHT × chunkSize) / RTT, so a window of 7 × 256 KB = 1.75 MB caps a
// high-RTT (TURN/relayed) path well below the link's capacity. 24 × 256 KB = 6 MB
// keeps the pipe full on those paths while staying a bounded amount of receiver
// memory. Direct-LAN transfers were never window-limited, so this doesn't hurt them.
export const MAX_IN_FLIGHT = 24;
// Ceiling for the ADAPTIVE receiver window (see Receiver._updateWindow). The window
// starts at MAX_IN_FLIGHT and grows toward measured-BDP on long fat pipes; the cap
// bounds receiver memory for requested-but-unarrived chunks (128 × 256 KB = 32 MB)
// and the bufferbloat feedback loop (queuing delay inflates measured RTT, which
// would otherwise grow the window without bound).
export const MAX_IN_FLIGHT_CAP = 128;
// How many chunks the sender prepares (read → hash → encrypt) and sends
// concurrently when serving a range request. The previous strictly-serial loop
// left the CPU idle during each chunk's async crypto and the channels idle during
// each other's sends; a small worker pool overlaps that work across the parallel
// data channels. Kept modest so crypto/CPU contention and channel backpressure
// stay bounded.
export const SENDER_CONCURRENCY = 4;
export const MAX_RETRY_COUNT = 5;
export const STALL_TIMEOUT_MS = 10_000; // 10 s — no chunk received → stalled

// ── Bottleneck classification ──────────────────────────────────
// Thresholds the diagnostics readout uses to guess WHY a transfer is at its
// current speed — so the user (and we) can tell which lever actually helps
// before investing in multi-PC striping or worker-based parallelism.
//   - cpu   → main thread is pinned (encryption/hashing); Web Workers help.
//   - loss  → retransmits are eating throughput (lossy/high-latency path);
//             more independent congestion windows (multi-PC) help.
//   - link  → nothing else is obviously constraining → the physical link is
//             the ceiling; parallelism buys little. (Level-5 "well flow rate".)
export const BOTTLENECK_CPU_LOAD = 0.8;    // main-thread busy fraction → CPU-bound
export const BOTTLENECK_LOSS_RATE = 0.02;  // ≥2% retransmits → congestion-bound
export const BOTTLENECK_IDLE_BPS = 64 * 1024; // below this throughput → treat as idle, don't guess

// ── Batch / Folder Transfer ────────────────────────────────────
// A "batch" is one or more files and/or directories sent in a single transfer
// session (a folder, a multi-file selection, or a mix). The sender announces the
// batch with a BATCH_META preamble; each file is then streamed with the existing
// per-file FILE_META → chunk-pull → MANIFEST protocol, carrying a sanitized
// `relativePath` so the receiver can reconstruct the directory tree exactly.
//
// These limits bound receiver memory/CPU/disk against a hostile or buggy sender
// (DoS, disk exhaustion, manifest blow-up). They are validated on BOTH peers.
export const MAX_BATCH_FILES = 10_000;            // max entries in one batch
export const MAX_BATCH_DIRECTORIES = 10_000;      // max distinct directories
export const MAX_BATCH_BYTES = 50 * 1024 * 1024 * 1024; // 50 GB aggregate ceiling
export const MAX_RELATIVE_PATH_LENGTH = 4096;     // bytes, matches common FS limits
export const MAX_PATH_DEPTH = 64;                  // max nesting depth of a path
export const MAX_PATH_SEGMENT_LENGTH = 255;        // per-segment (filename) limit

// ── Transfer Type (carried in BATCH_META; drives receiver UX) ──
// What kind of payload a batch represents. The receiver uses this for the approval
// summary (Feature 4) and to decide how to present a completed transfer (e.g. a
// text payload opens a preview instead of triggering a download — Feature 7).
export const TRANSFER_TYPE = {
    FILES: 'files',       // one or more loose files
    FOLDER: 'folder',     // a directory tree (contains directories)
    TEXT: 'text',         // a single text/clipboard/code/markdown payload
    LINK: 'link',         // a single shared URL with optional preview metadata
    MIXED: 'mixed',       // files + directories together
};

// ── Receive Confirmation (Feature 4) ───────────────────────────
// The sender announces the batch (BATCH_META) and then BLOCKS until the receiver
// explicitly accepts. No file data is requested or sent before acceptance. If the
// receiver does not respond within this window, the sender aborts the offer so a
// silent/absent peer can't pin an open transfer indefinitely.
export const RECEIVE_APPROVAL_TIMEOUT_MS = 60 * 1000; // 60 s to accept/reject

// ── Text Sharing (Feature 7) ───────────────────────────────────
// A text payload is streamed as an ordinary single-file batch (so it inherits
// encryption, integrity and resume) but flagged so the receiver shows a preview.
export const TEXT_FORMAT = {
    PLAIN: 'plain',
    MARKDOWN: 'markdown',
    CODE: 'code',
};
// Upper bound on an interactively composed text payload. Larger text should be sent
// as a file. Bounds receiver preview memory and keeps the compose box responsive.
export const MAX_TEXT_PAYLOAD_BYTES = 16 * 1024 * 1024; // 16 MB

// ── Link Sharing (Feature 9) ───────────────────────────────────
// A shared link rides the same single-file batch engine as text, flagged
// TRANSFER_TYPE.LINK. The payload is a small JSON document { url, title,
// description, siteName } that is re-validated and re-sanitized on the receiver.
// Only http/https URLs are ever accepted or rendered as clickable — javascript:,
// data:, file:, blob: and any other scheme is rejected to prevent XSS / local-file
// disclosure when the receiver one-click-opens the link.
export const SAFE_URL_PROTOCOLS = ['http:', 'https:'];
export const MAX_URL_LENGTH = 2048;            // generous but bounded (matches browser norms)
export const MAX_LINK_TITLE_LENGTH = 256;
export const MAX_LINK_DESCRIPTION_LENGTH = 1024;
export const MAX_LINK_SITENAME_LENGTH = 128;

// ── Clipboard Sharing (Feature 8) ──────────────────────────────
// Clipboard content is a *source*, not a distinct wire type: pasted text becomes a
// TEXT transfer and pasted images/files become an ordinary FILES batch. These
// caps bound how much pasted binary content is staged in memory before sending.
export const MAX_CLIPBOARD_ITEMS = 64;
export const MAX_CLIPBOARD_ITEM_BYTES = 64 * 1024 * 1024; // 64 MB per pasted blob

// ── Device Identity (Feature 12) ───────────────────────────────
// A coarse device class derived from the user agent, announced alongside the
// device id/name so the receiver can show a recognizable icon and organize
// contacts. Purely cosmetic / organizational — never a security signal.
export const DEVICE_TYPE = {
    DESKTOP: 'desktop',
    MOBILE: 'mobile',
    TABLET: 'tablet',
    UNKNOWN: 'unknown',
};

// ── QR Deep Links (Feature 13) ─────────────────────────────────
// A deep link encodes everything a scanning device needs to auto-join: the action,
// the pairing code, and an expiring (optionally single-use) token. The token bounds
// the window in which a leaked/over-the-shoulder QR is useful and lets the issuer
// revoke it. True single-use enforcement is anchored at the signaling server's
// session TTL (a code maps to one short-lived session); the token adds client-side
// expiry + revocation on top.
export const DEEP_LINK_ACTION = {
    PAIR: 'pair',         // join a live pairing session (default)
    TRANSFER: 'transfer', // join and immediately begin a staged transfer
    PUBLIC: 'public',     // a durable public share link
    TEMP: 'temp',         // a short-lived temporary share link
};
export const DEEP_LINK_TOKEN_BYTES = 16;                  // 128-bit opaque token
export const DEEP_LINK_DEFAULT_TTL_MS = 15 * 60 * 1000;   // 15 min — aligns with SESSION_TOKEN_TTL_MS
// Query-string parameter names used in a deep link URL. `code` is kept verbatim for
// backward compatibility with the original `?code=NNNNNN` QR/share links.
export const DEEP_LINK_PARAM = {
    ACTION: 'a',
    CODE: 'code',
    TOKEN: 't',
    EXPIRES: 'exp',
    SINGLE_USE: 'su',
};

// ── Session ────────────────────────────────────────────────────
export const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
export const MAX_PEERS_PER_SESSION = 2;

// ── Group Rooms (hybrid swarm) ─────────────────────────────────
// A "room" is a multi-peer session (the classic 2-peer flow stays a plain session). The
// server is a coordination plane only — it routes signaling, maintains the roster, and
// tracks which peer holds which chunk; file bytes always move peer-to-peer (or via the
// existing relay fallback). Topology is chosen by room size:
//   2 peers      → DIRECT  (the existing 1:1 P2P path)
//   3..MESH      → MESH    (every peer connects to every other; sender pushes to each)
//   > MESH       → SWARM   (BitTorrent-style: peers pull rarest-first from each other and
//                           re-share received chunks, so the origin isn't the only source)
export const ROOM_TOPOLOGY = { DIRECT: 'direct', MESH: 'mesh', SWARM: 'swarm' };
export const ROOM_MESH_THRESHOLD = 5;     // ≤ this many peers → mesh; above → swarm
export const MAX_ROOM_PEERS = 16;         // hard ceiling per room
export const ROOM_CODE_LENGTH = 6;
export const ROOM_TIMEOUT_MS = 30 * 60 * 1000; // 30 min idle → room reclaimed

/** Choose a topology for a given peer count. */
export function pickRoomTopology(peerCount) {
    if (peerCount <= 2) return ROOM_TOPOLOGY.DIRECT;
    if (peerCount <= ROOM_MESH_THRESHOLD) return ROOM_TOPOLOGY.MESH;
    return ROOM_TOPOLOGY.SWARM;
}
export const PAIRING_CODE_LENGTH = 6;
export const SESSION_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

// ── Storage ────────────────────────────────────────────────────
/**
 * Stable IndexedDB schema version.
 * Increment only on breaking schema changes; never use Date.now().
 * v4: StorageManager chunk storage moved from per-file object stores (which needed
 *     a version bump per file and silently lost data when a store was missing) to a
 *     single `chunks` store keyed by the compound [fileId, index].
 */
export const DB_VERSION = 4;
/**
 * Largest file the receiver can assemble on the IndexedDB fallback, which is the only path
 * that still materializes the whole file in memory (StorageManager._assembleIDB). The FSAPI
 * path streams to disk and OPFS returns a disk-backed File (StorageManager._assembleOPFS),
 * so both handle files larger than RAM; IDB is reached only on browsers lacking *both* APIs.
 * For that fallback we refuse an over-large transfer up front with a clear error rather than
 * letting the tab OOM. 2 GB also stays under the ArrayBuffer size ceiling in several engines.
 */
export const MAX_INMEMORY_ASSEMBLY_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
export const RESUME_FLUSH_DEBOUNCE_MS = 16; // one animation frame
/**
 * Upper bound on how long the resume ledger may lag behind storage under a
 * sustained chunk burst. The 16ms debounce reschedules on every chunk, so without
 * a ceiling a fast transfer could go a long time without persisting — and a crash
 * would then force re-downloading everything since the last quiet moment. This caps
 * the worst-case re-download window after a crash.
 */
export const RESUME_FLUSH_MAX_WAIT_MS = 1000;

// ── Rate Limiting ──────────────────────────────────────────────
export const MAX_CONNECTIONS_PER_MIN = 10;
export const MAX_SESSIONS_PER_HOUR = 5;
export const MAX_MESSAGES_PER_SEC = 100;
// Relay-chunk frames get their own, much larger budget than signaling/control
// messages: a real transfer legitimately sends two frames (hash + binary) per
// chunk, hundreds of times per second, and gating that on the same 100/sec
// bucket as signaling chatter throttled the server-relay fallback path well
// below what the socket could actually carry.
export const MAX_RELAY_CHUNKS_PER_SEC = 500;
export const MAX_JOIN_ATTEMPTS_PER_MIN = 10;
export const MAX_MESSAGE_SIZE = 64 * 1024; // 64 KB cap for control/signaling messages

// ── Relay ──────────────────────────────────────────────────────
export const MAX_RELAY_SESSION_BYTES = 100 * 1024 * 1024; // 100 MB cap per relay session
export const MAX_RELAY_DURATION_MS = 30 * 60 * 1000; // 30 minutes max relay
/**
 * Max size of a single relay-chunk frame. A relayed binary chunk is base64-encoded
 * (≈ 4/3 inflation) inside a JSON envelope, so a 256 KB ciphertext chunk frames to
 * ~350 KB. The WebSocket maxPayload must accommodate this; control/signaling messages
 * are still held to the much smaller MAX_MESSAGE_SIZE at the application layer.
 * 512 KB leaves headroom while bounding per-frame memory.
 */
export const MAX_RELAY_FRAME_SIZE = 512 * 1024;

// ── Share Links (Features 14 + 15): server-stored, downloadable links ──
// Unlike the live P2P/relay path (sender and receiver online at the same time),
// a share link uploads the (client-encrypted) bytes to the server's blob store so
// a recipient can download later. Two visibilities share one mechanism:
//   TEMP   — short-lived, typically single-use or download-limited, for quick handoffs.
//   PUBLIC — a durable, shareable URL (still expiring + revocable) for distribution.
// These ceilings bound disk/memory against abuse (disk exhaustion, public-link abuse).
export const SHARE_VISIBILITY = {
    TEMP: 'temp',
    PUBLIC: 'public',
};

// Allowed expiry presets (ms). Custom values are clamped to [MIN, MAX].
export const SHARE_EXPIRY_PRESETS = {
    '5m': 5 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
};
export const SHARE_MIN_EXPIRY_MS = 60 * 1000;                 // 1 min floor
export const SHARE_MAX_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;  // 30 day ceiling
export const SHARE_DEFAULT_EXPIRY_MS = SHARE_EXPIRY_PRESETS['24h'];

// Per-link and global storage ceilings (disk-exhaustion defense).
export const SHARE_MAX_BLOB_BYTES = 5 * 1024 * 1024 * 1024;   // 5 GB per link
export const SHARE_MAX_FILENAME_LENGTH = 255;
export const SHARE_MAX_DOWNLOADS_CAP = 1_000_000;             // sanity cap on maxDownloads
// A download password is verified server-side (scrypt). Brute force is bounded by the
// per-IP HTTP rate limiter; these bound the password value itself.
export const SHARE_MIN_PASSWORD_LENGTH = 1;
export const SHARE_MAX_PASSWORD_LENGTH = 256;

// Token byte lengths (opaque, server-generated → never user-controlled paths).
export const SHARE_LINK_ID_BYTES = 16;     // 128-bit public link id (hex → 32 chars)
export const SHARE_BLOB_ID_BYTES = 16;     // 128-bit storage object id
export const SHARE_UPLOAD_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h to finish uploading

// ── Accounts / Auth ────────────────────────────────────────────
// Optional user accounts: email/password (scrypt) or OAuth (Google/GitHub), with short-lived
// access JWTs and long-lived, rotated refresh tokens. Accounts are an *ownership* layer over
// the existing capability-token model — share links / webhooks created while authenticated
// are owned by the account, enabling listing/management; anonymous use is unchanged.
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;        // 15 min
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;
export const MAX_EMAIL_LENGTH = 254;
export const OAUTH_PROVIDERS = ['google', 'github'];
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;         // CSRF state validity

// ── Webhooks ───────────────────────────────────────────────────
// Outbound, HMAC-signed event notifications. A subscriber registers a URL + a set of
// event types; the server POSTs a signed JSON envelope when those events occur, retrying
// with exponential backoff. The catalog below is the set of subscribable event types;
// '*' subscribes to all. Payloads never include secrets (download passwords, owner tokens).
export const WEBHOOK_EVENTS = [
    'share.created',
    'share.uploaded',
    'share.downloaded',
    'share.revoked',
    'share.expired',
    'session.created',
    'account.created',
    'room.created',
    'room.peer_joined',
];
export const WEBHOOK_SIGNATURE_HEADER = 'X-LinkSpan-Signature';
export const WEBHOOK_EVENT_HEADER = 'X-LinkSpan-Event';
export const WEBHOOK_DELIVERY_HEADER = 'X-LinkSpan-Delivery';
export const WEBHOOK_MAX_ATTEMPTS = 5;               // initial try + retries
export const WEBHOOK_RETRY_BASE_MS = 1000;           // backoff = base * 2^(attempt-1)
export const WEBHOOK_TIMEOUT_MS = 10 * 1000;         // per-delivery HTTP timeout
export const WEBHOOK_MAX_DELIVERIES_STORED = 50;     // bounded per-endpoint delivery log
export const WEBHOOK_MAX_PER_OWNER = 50;             // cap endpoints per owner
export const WEBHOOK_SECRET_BYTES = 24;

// ── REST API (Feature 17) ──────────────────────────────────────
export const API_VERSION = 'v1';
export const API_BASE_PATH = `/api/${API_VERSION}`;
// HTTP rate limits (per IP) for the REST surface. Independent of the WS limits.
export const API_MAX_REQUESTS_PER_MIN = 120;     // general API calls
export const API_MAX_UPLOADS_PER_HOUR = 60;      // link creations / uploads
export const API_MAX_DOWNLOAD_ATTEMPTS_PER_MIN = 30; // also bounds password brute force

// ── Signaling Message Types ────────────────────────────────────
export const MSG = {
    // Client → Server
    CREATE_SESSION: 'create-session',
    JOIN_SESSION: 'join-session',
    OFFER: 'offer',
    ANSWER: 'answer',
    ICE_CANDIDATE: 'ice-candidate',
    DISCONNECT: 'disconnect',
    RELAY_REQUEST: 'relay-request',
    RELAY_CHUNK: 'relay-chunk',
    RELAY_COMPLETE: 'relay-complete',

    // Server → Client
    SESSION_CREATED: 'session-created',
    PEER_JOINED: 'peer-joined',
    SESSION_ERROR: 'session-error',
    SESSION_CLOSED: 'session-closed',
    RELAY_READY: 'relay-ready',

    // ── Group rooms (N-peer) ──
    // Client → Server
    CREATE_ROOM: 'create-room',
    JOIN_ROOM: 'join-room',
    LEAVE_ROOM: 'leave-room',
    // Server → Client
    ROOM_CREATED: 'room-created',     // { roomId, joinCode, peerId, token, topology }
    ROOM_ROSTER: 'room-roster',       // { roomId, topology, peers: [{ peerId, name }] }
    ROOM_PEER_JOINED: 'room-peer-joined', // { peerId, name }
    ROOM_PEER_LEFT: 'room-peer-left',     // { peerId }
    // N-peer signaling carries an explicit target peer id (`to`) so OFFER/ANSWER/ICE can be
    // routed to a specific member rather than "the other peer".
};

// ── Swarm coordination (over the signaling channel, metadata only) ──
// The server tracks chunk availability so peers can discover where to pull each chunk; no
// file bytes ever pass through these messages (bytes move over the P2P DataChannels).
export const SWARM_MSG = {
    ANNOUNCE: 'swarm-announce',   // peer announces a file manifest { fileId, totalChunks }
    HAVE: 'swarm-have',           // peer now holds chunk(s) { fileId, indices: [...] }
    NEED: 'swarm-need',           // peer asks who has a chunk { fileId, index }
    PEERS: 'swarm-peers',         // server reply { fileId, index, peers: [peerId,...] } (rarest-first)
};

// ── Transfer Protocol Message Types (over DataChannel / Relay) ─
export const TRANSFER_MSG = {
    // ECDH public-key exchange — sent by both peers before FILE_META (M2)
    KEY_EXCHANGE: 'key-exchange',
    // Batch/folder transfer (M4): sender announces the whole batch before any file
    // data, so the receiver can size buffers, show an accurate summary, and (future)
    // gate the transfer behind explicit approval. FILE_COMPLETE acks each file so the
    // sender advances strictly sequentially; BATCH_COMPLETE ends the batch.
    BATCH_META: 'batch-meta',
    // Receive confirmation (Feature 4): after BATCH_META the sender waits for the
    // receiver to explicitly approve the offer before any file data flows. The
    // receiver replies with exactly one of these.
    RECEIVE_ACCEPT: 'receive-accept',
    RECEIVE_REJECT: 'receive-reject',
    FILE_COMPLETE: 'file-complete',
    BATCH_COMPLETE: 'batch-complete',
    FILE_META: 'file-meta',
    CHUNK_REQUEST: 'chunk-request',
    // Range-list chunk request (M-range, proto 1.7.0): the receiver coalesces the
    // chunks it wants into `ranges: [{start, count}]` and pulls them in a single
    // control frame instead of one CHUNK_REQUEST per chunk. The sender validates +
    // expands the ranges and serves each chunk with the usual CHUNK_DATA + binary
    // response (responses are unchanged — only the request side is coalesced).
    // Capability-negotiated: a range-capable sender advertises `supportsRangeRequest`
    // in FILE_META; receivers fall back to per-chunk CHUNK_REQUEST when it's absent,
    // and senders still accept per-chunk CHUNK_REQUEST from old receivers.
    CHUNK_REQUEST_RANGE: 'chunk-request-range',
    CHUNK_DATA: 'chunk-data',
    CHUNK_ACK: 'chunk-ack',
    // CHUNK_NACK stays single-index (one rejected chunk → one immediate re-send).
    CHUNK_NACK: 'chunk-nack',
    // Whole-file verification (M3): receiver asks for the manifest root once all
    // chunks are in; sender replies with the root hash of all plaintext chunk hashes.
    MANIFEST_REQUEST: 'manifest-request',
    MANIFEST: 'manifest',
    TRANSFER_COMPLETE: 'transfer-complete',
    RESUME_REQUEST: 'resume-request',
    RESUME_RESPONSE: 'resume-response',
    // New in M1
    CANCEL: 'cancel',
    PAUSE: 'pause',
    RESUME: 'resume',
    RESUME_ACK: 'resume-ack',
};

// ── Opt-in aggregate telemetry (privacy-first; default OFF) ────
//
// When (and ONLY when) the user opts in, the client may report a single, fully
// anonymized, pre-bucketed event about a COMPLETED transfer. The categories below are
// the entire vocabulary — no filename, no byte count, no duration value, no peer/device
// identity, no room membership, no IP, and no per-transfer id ever leave the client.
// The server keeps aggregate COUNTS only. The fixed enums bound metric cardinality so a
// hostile client can't inject arbitrary labels.
export const TELEMETRY_OUTCOME = Object.freeze(['success', 'failure']);
export const TELEMETRY_MODE = Object.freeze(['p2p', 'relay']);
export const TELEMETRY_SIZE_BUCKET = Object.freeze([
    'lt1mb', '1to10mb', '10to100mb', '100mbto1gb', 'gt1gb',
]);
export const TELEMETRY_DURATION_BUCKET = Object.freeze([
    'lt1s', '1to10s', '10to60s', '1to5m', 'gt5m',
]);

/** Map a raw byte count to a coarse size bucket (client-side, before anything is sent). */
export function telemetrySizeBucket(bytes) {
    const MB = 1024 * 1024, GB = 1024 * MB;
    if (!Number.isFinite(bytes) || bytes < 0) return null;
    if (bytes < MB) return 'lt1mb';
    if (bytes < 10 * MB) return '1to10mb';
    if (bytes < 100 * MB) return '10to100mb';
    if (bytes < GB) return '100mbto1gb';
    return 'gt1gb';
}

/** Map a raw duration (ms) to a coarse duration bucket (client-side). */
export function telemetryDurationBucket(ms) {
    if (!Number.isFinite(ms) || ms < 0) return null;
    if (ms < 1000) return 'lt1s';
    if (ms < 10_000) return '1to10s';
    if (ms < 60_000) return '10to60s';
    if (ms < 300_000) return '1to5m';
    return 'gt5m';
}

// ── Transfer State Machine States ──────────────────────────────
export const TRANSFER_STATE = {
    IDLE: 'IDLE',
    PAIRING: 'PAIRING',
    CONNECTING: 'CONNECTING',
    CONNECTED: 'CONNECTED',
    TRANSFERRING: 'TRANSFERRING',
    PAUSED: 'PAUSED',
    RESUMING: 'RESUMING',
    VERIFYING: 'VERIFYING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
    CANCELLED: 'CANCELLED',
};

// ── Error Codes ────────────────────────────────────────────────
export const ERR = {
    SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
    SESSION_FULL: 'SESSION_FULL',
    INVALID_PAIRING_CODE: 'INVALID_PAIRING_CODE',
    RATE_LIMITED: 'RATE_LIMITED',
    INVALID_MESSAGE: 'INVALID_MESSAGE',
    INTEGRITY_FAILED: 'INTEGRITY_FAILED',
    TRANSFER_FAILED: 'TRANSFER_FAILED',
    STORAGE_ERROR: 'STORAGE_ERROR',
    CONNECTION_FAILED: 'CONNECTION_FAILED',
    UNAUTHORIZED: 'UNAUTHORIZED',
    BRUTE_FORCE_LOCKED: 'BRUTE_FORCE_LOCKED',
};

// ── DataChannel Config ─────────────────────────────────────────
// `ordered: true` gives SCTP in-order delivery, which causes head-of-line blocking:
// one delayed/retransmitted packet stalls everything behind it on that channel — a real
// throughput cap on lossy or high-latency (relay/cross-network) paths. LinkSpan reassembles
// by explicit chunk index and the Receiver now buffers a binary frame that outruns its
// metadata, so it no longer depends on ordering. Flipping this to `false` (reliable but
// UNORDERED) removes the HOL stall; do it once measured against the live Bottleneck readout,
// since the win only shows on paths with actual loss/latency.
export const CHANNEL_CONFIG = {
    ordered: true,
};

export const BUFFERED_AMOUNT_LOW_THRESHOLD = 64 * 1024; // 64 KB
// High-water mark for per-channel send backpressure. send() blocks once a
// channel's bufferedAmount exceeds this, then resumes on bufferedamountlow. At
// 256 KB chunks the old limit (BUFFERED_AMOUNT_LOW_THRESHOLD × 4 = 256 KB) drained
// after a single buffered chunk, so a fast link kept stalling between chunks. 1 MB
// lets a channel hold a few chunks in its send buffer and stay saturated.
export const SEND_HIGH_WATER_MARK = 1024 * 1024; // 1 MB
