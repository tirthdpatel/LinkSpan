# LinkSpan — Architecture & Research Decisions

## 1. Hosting Platform for Signaling Server

### Research Summary

| Platform | Free Tier | WebSocket | Spin-Down | HTTPS | Credit Card | Notes |
|----------|-----------|-----------|-----------|-------|-------------|-------|
| **Render** | 750 hrs/mo, free web service | ✅ Full support | 15 min idle → ~1 min spin-up | ✅ Auto TLS | ❌ Not required | Best option for real-time signaling |
| Fly.io | ❌ No free tier (new users) | ✅ | N/A | ✅ | ✅ Required | Pay-as-you-go only since Oct 2024 |
| Railway | $5 one-time trial credit | ✅ | N/A | ✅ | ✅ Required for Hobby | Not truly free; $5/mo Hobby plan |
| Koyeb | ❌ Starts at $10/mo | ✅ | N/A | ✅ | ✅ Required | Enterprise-focused pricing |
| Glitch | ✅ Free plan | ✅ (limited) | 5 min idle | ✅ | ❌ | 1000 hrs/mo, 512MB RAM, can be unreliable |

### Decision: **Render (Free Tier)**

**Rationale:**
- Render offers 750 free instance hours/month — enough for a signaling server that spins down when idle.
- Full WebSocket support including message-based keep-alive detection.
- Auto HTTPS with managed TLS certificates.
- Custom domain support on free tier.
- No credit card required.
- Spins down after 15 min idle (acceptable for signaling: peers will reconnect and WebRTC connections survive once established).
- The signaling server is stateless (in-memory sessions) so spin-down-and-restart is tolerable.
- The front-end (static React app) can be deployed as a free static site on Render or on GitHub Pages/Cloudflare Pages.

**Sources:**
- [Render Free Tier Docs](https://render.com/docs/free) — Verified: 750 hrs/mo, 15-min spin-down, no credit card, WebSocket support, ephemeral filesystem.
- [Fly.io Pricing](https://fly.io/docs/about/pricing/) — Verified: No free tier for new customers, credit card required.
- [Railway Pricing](https://docs.railway.com/reference/pricing/plans) — Verified: $5 one-time trial credit, then $5/mo minimum.
- [Koyeb Pricing](https://www.koyeb.com/pricing) — Verified: $10/mo included compute minimum.

**Spin-Down Mitigation Strategy:**
- The client app will detect WebSocket disconnection and auto-reconnect.
- Signaling is only needed briefly (for WebRTC negotiation); once the peer-to-peer DataChannel is established, the signaling server is no longer needed.
- A "connecting" UI state will be shown during the ~1 min spin-up period.
- Optional: an external cron/uptime service (like UptimeRobot free tier) can ping the server to keep it warm.

---

## 2. TURN Server Strategy

### Research Summary

**Why TURN is needed:** STUN alone handles ~80-85% of NAT scenarios. For symmetric NAT or restrictive firewalls, a TURN relay server is required.

**Options evaluated:**

| Option | Feasibility | Cost | Reliability |
|--------|------------|------|-------------|
| Self-hosted coturn on Render free | ❌ | Free | Very low — Render only allows HTTP port binding; no UDP relay; ephemeral filesystem |
| Self-hosted coturn on Fly.io | ❌ | Requires credit card | Needs UDP ports; Fly charges for compute |
| Metered.ca free tier | ✅ | 500MB/mo free TURN | High — global infrastructure, 31+ regions |
| Google STUN only | ✅ | Free | Works for ~85% of NAT scenarios |
| Xirsys free | May have free trial | Limited | Moderate |

### Decision: **Metered.ca free tier + Google STUN**

**Rationale:**
- Self-hosting coturn on free-tier platforms is **not feasible** because:
  - Render only allows HTTP port binding (no UDP relay ports).
  - Free tiers lack the CPU/network resources for UDP media relay.
  - Ephemeral filesystems make state management impossible.
- **Metered.ca offers 500MB/mo free TURN** — no credit card required, REST API access, global TURN server infrastructure across 31+ regions.
- 500MB of TURN relay is adequate because:
  - TURN is a fallback; most connections use direct P2P (STUN-only).
  - Only restricted NAT peers will route through TURN.
  - For a personal/open-source project, 500MB/mo of TURN relay covers reasonable usage.
- Google's public STUN servers (stun:stun.l.google.com:19302) are free and highly available.

**ICE Configuration:**
```javascript
const iceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: 'turn:global.relay.metered.ca:80',
    username: '<from-metered-api>',
    credential: '<from-metered-api>'
  },
  {
    urls: 'turn:global.relay.metered.ca:443',
    username: '<from-metered-api>',
    credential: '<from-metered-api>'
  },
  {
    urls: 'turns:global.relay.metered.ca:443',
    username: '<from-metered-api>',
    credential: '<from-metered-api>'
  }
];
```

**NAT Compatibility Tradeoffs:**
- ~85% of connections will work with STUN only (direct P2P).
- ~15% of connections behind symmetric NAT will use TURN relay.
- 500MB/mo TURN limit means ~500 files of 1MB via relay, or roughly 5 large file transfers via relay per month — adequate for an open-source project.
- Users can self-host coturn and configure their own TURN credentials via environment variables.

**Sources:**
- [webrtc.org TURN docs](https://webrtc.org/getting-started/turn-server) — Confirmed coturn is the recommended open-source TURN server.
- [Metered.ca TURN pricing](https://www.metered.ca/stun-turn) — Confirmed 500MB/mo free, no credit card required, global infrastructure.

---

## 3. Encryption Strategy

### Research Summary

| Approach | Security Level | Performance Overhead | Latency Impact | Complexity |
|----------|---------------|---------------------|----------------|------------|
| WebRTC DTLS only | Strong (mandatory) | None (built-in) | None | None |
| DTLS + AES-256-GCM app layer | Very strong | 5-15% throughput reduction | +1-3ms per chunk | Moderate |
| DTLS + ChaCha20 app layer | Very strong | 3-8% overhead | +0.5-2ms per chunk | Moderate |

### Decision (revised): **DTLS baseline + always-on application-layer AES-256-GCM**

> **Update (Phase 2.1).** The original decision below was *DTLS-only, no app-layer
> encryption*. That reasoning holds for pure P2P, but it ignored LinkSpan's
> server-relay fallback (`RelayChannel`/`RelayTransfer`), where DTLS does **not**
> apply and the server would otherwise see plaintext. Because the relay fallback can
> trigger mid-transfer, encryption cannot be conditional. LinkSpan now performs an
> **ECDH (P-256) handshake** to derive a shared **AES-256-GCM** session key and
> encrypts every chunk before it leaves the sender, in all modes. The throughput cost
> is accepted as the price of an honest "no server can read your files" guarantee.
> See [trust-model.md](architecture/trust-model.md). The original DTLS-only rationale
> is preserved below for context.

**Original rationale (superseded for the relay path):**
1. **WebRTC DataChannels are encrypted by specification.** The transport uses DTLS 1.2+ (mandatory per WebRTC spec). All data sent over RTCDataChannel is automatically encrypted end-to-end between peers.

2. **No intermediate server can read data.** In P2P modes, DTLS means even a TURN relay sees only ciphertext. In the server-relay fallback (`RelayChannel` → `RelayTransfer`), DTLS does not apply — so LinkSpan adds application-layer AES-256-GCM (see the revised decision below) and the signaling server forwards ciphertext only. See [trust-model.md](architecture/trust-model.md) §4.

3. **AES-256-GCM application-layer encryption would add overhead with minimal security gain:**
   - Per-chunk SubtleCrypto.encrypt() adds 5-15% throughput overhead (verified via MDN SubtleCrypto docs — GCM mode includes authentication tag computation).
   - The per-chunk latency penalty of 1-3ms compounds across thousands of chunks in a large file transfer.
   - For a 5GB file at 1MB chunks, that's 5,120 encryption operations — adds ~5-15 seconds total.

4. **DTLS already provides:** confidentiality (AES-128-GCM or AES-256-GCM), integrity (HMAC), and authentication (certificate fingerprint exchange during signaling).

5. **Key management complexity:** Application-layer encryption would require a key exchange mechanism (adding latency to connection setup) and secure key destruction.

**Security Measures (Without App-Layer Encryption):**
- Verify DTLS fingerprints during signaling (prevent MITM).
- Use secure WebSocket (WSS) for signaling to protect SDP exchange.
- Ephemeral sessions — all keys destroyed on disconnect.
- No file metadata persisted server-side.

**Optional Enhancement:** We expose a configuration flag (`ENABLE_APP_ENCRYPTION`) so users who want the additional layer can opt-in. This is disabled by default for maximum throughput.

**Sources:**
- [MDN SubtleCrypto encrypt()](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/encrypt) — AES-GCM is an "authenticated" mode with built-in integrity checks.
- [MDN RTCDataChannel](https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel) — DataChannel uses DTLS/SCTP transport, encrypted by spec.

---

## 4. Large File Handling & Browser Limits

### Research Summary

**Storage Quotas (from MDN):**

| Browser | IndexedDB/OPFS Quota | Notes |
|---------|---------------------|-------|
| Chrome/Edge | 60% of total disk | e.g., 600GB on 1TB disk |
| Firefox | Min of (10% disk, 10GiB group limit) | 10GiB practical limit for best-effort mode |
| Safari | ~60% of disk (macOS 14+/iOS 17+) | Earlier versions: 1GiB initial, then prompt |

**Key storage APIs:**

| API | Support | Good For | Limitations |
|-----|---------|----------|-------------|
| File System Access API (showSaveFilePicker) | Chrome, Edge ✅; Firefox ❌; Safari ❌ | Direct write to user's filesystem | Not cross-browser |
| OPFS (Origin Private File System) | Chrome ✅, Firefox ✅, Safari ✅ | High-perf streaming writes, large files >1GB | Not user-visible; need to export |
| IndexedDB | All browsers ✅ | Chunk storage, resume tracking | Subject to storage quotas; slower for large data |
| Blob + createObjectURL | All browsers ✅ | Final file download | Must fit in memory for construction |

### Decision: **Tiered Storage Strategy**

**Primary: File System Access API (when available)**
- Chrome/Edge: Use `showSaveFilePicker()` to get a writable file handle.
- Write chunks directly to the user's chosen location via `FileSystemWritableFileStream`.
- Zero memory overhead for assembly — sequential write to disk.
- Supports files >5GB with no memory constraints.

**Fallback 1: OPFS (Origin Private File System)**
- Firefox, Safari, and other browsers: Use OPFS for in-browser streaming writes.
- Write chunks sequentially to an OPFS file, then export for download.
- MDN confirms OPFS supports large files (>1GB) with in-place write access.
- High performance — "highly optimized for performance."

**Fallback 2: IndexedDB Chunk Collection + Blob Assembly**
- For browsers without OPFS or File System Access API support.
- Store each chunk in IndexedDB keyed by chunk index.
- Assemble final file by reading chunks sequentially into a Blob.
- Constrained by available storage quota.

### Chunk Size Decision: **256KB**

**Rationale:**
- RTCDataChannel message size varies by browser (Chrome: 256KB max message size; Firefox: 256KB; Safari: 64KB for some older versions).
- Using 256KB chunk size (262,144 bytes) provides:
  - Compatibility with all modern browsers.
  - Low-latency per-chunk transmission (~0.5ms on fast LAN, ~10ms on average broadband).
  - SHA-256 hash computation per chunk is fast (~0.1ms for 256KB via SubtleCrypto).
  - 7 parallel channels × 256KB = ~1.75MB in-flight — effective for throughput.
  - For 5GB file: ~20,480 chunks (manageable for tracking).
- Smaller chunks mean faster error recovery (re-send failed 256KB vs 1MB).
- bufferedAmountLowThreshold can be tuned per channel for optimal backpressure.

**Note:** Chunk size is configurable. 256KB is the default; advanced users can increase to 512KB-1MB for high-bandwidth LAN scenarios.

### Dynamic chunking & memory budget (Phase 4)

- **4.1 Streaming (zero-copy):** the sender reads one chunk at a time via `Blob.slice`
  (`ChunkManager.getChunk`) and the receiver seek-writes each chunk to disk
  (`StorageManager`); the full file is never held in memory. Only the final
  `assembleFile()` materialises a `Blob`/file handle.
- **4.2 Memory budget:** working set is bounded to a small number of in-flight chunks
  (`MAX_IN_FLIGHT` × chunk size), independent of file size. The Phase 4.4 benchmark
  shows ~5 MB heap while processing a simulated 256 MB transfer.
- **4.3 Dynamic chunking:** `pickChunkSize(fileSize, encrypted)` scales the plaintext
  chunk (64 KB for ≤1 MB files up to the max for large files). The size is always
  capped so the framed ciphertext `[4-byte header][12-byte IV][plaintext][16-byte tag]`
  stays within the 256 KB DataChannel message limit. `fileMeta.chunkSize` carries the
  chosen size to the receiver, keeping storage offsets and manifest re-hashing consistent.
- **4.4 Benchmark:** `client/benchmarks/crypto-bench.mjs` measures the hot path.
  Representative local numbers (Node 18): AES-256-GCM ~3.4 GB/s encrypt / ~3.3 GB/s
  decrypt, SHA-256 ~2.4 GB/s, ECDH handshake ~2 ms one-time. The crypto layer is far
  from the bottleneck — network throughput dominates.

**Sources:**
- [MDN Storage Quotas](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Browser_storage_limits_and_eviction_criteria) — Chrome: 60% disk, Firefox: 10GiB, Safari: 60% disk.
- [MDN File System API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API) — OPFS supports large files, in-place write, all major browsers.
- [MDN RTCDataChannel](https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel) — bufferedAmount and backpressure properties confirmed.

---

## 5. Monorepo vs Multi-Repo

### Decision: **Monorepo**

**Rationale:**
1. **Single deployment entity:** The signaling server and client are tightly coupled — they share protocol definitions, message types, and versioning.
2. **Shared code:** Constants (chunk sizes, error codes, protocol version) are shared between server and client.
3. **Simplified CI/CD:** One GitHub Actions workflow tests and deploys everything.
4. **Easier contribution:** Contributors clone one repo, not two.
5. **Industry standard:** Projects like PeerJS, ShareDrop, and SnapDrop all use monorepos.

**Structure:**
```
LinkSpan/
├── server/          # Node.js signaling server
│   ├── src/
│   ├── package.json
│   └── Dockerfile
├── client/          # React + Vite + TailwindCSS
│   ├── src/
│   ├── package.json
│   └── index.html
├── shared/          # Shared constants, types, protocol definitions
│   └── constants.js
├── docs/
│   ├── architecture.md
│   └── protocol.md
├── docker-compose.yml
├── .github/
│   ├── workflows/ci.yml
│   └── ISSUE_TEMPLATE/
├── README.md
├── LICENSE
├── CONTRIBUTING.md
├── SECURITY.md
└── .gitignore
```

---

## 6. High-Level Architecture

```
┌─────────────────────────────────────────────────────┐
│                    CLIENT (Browser)                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ React UI │  │ QR Code  │  │ Diagnostics Panel│  │
│  └────┬─────┘  └────┬─────┘  └────────┬─────────┘  │
│       │              │                 │             │
│  ┌────▼──────────────▼─────────────────▼─────────┐  │
│  │            WebRTC Engine                       │  │
│  │  ┌─────────────────────────────────────────┐   │  │
│  │  │  7× RTCDataChannel (parallel transfer)  │   │  │
│  │  └─────────────────────────────────────────┘   │  │
│  │  ┌──────────┐ ┌──────────────┐ ┌───────────┐  │  │
│  │  │ Chunker  │ │ Integrity    │ │ Resume    │  │  │
│  │  │ Manager  │ │ Verifier     │ │ Manager   │  │  │
│  │  └──────────┘ └──────────────┘ └───────────┘  │  │
│  │  ┌──────────────────────────────────────────┐  │  │
│  │  │ Storage Layer (FSAA → OPFS → IndexedDB)  │  │  │
│  │  └──────────────────────────────────────────┘  │  │
│  └────────────────────┬──────────────────────────┘  │
│                       │ WSS                          │
└───────────────────────┼──────────────────────────────┘
                        │
                ┌───────▼───────┐
                │   Signaling   │
                │   Server      │
                │  (Render)     │
                │  WebSocket    │
                │  In-Memory    │
                └───────────────┘
```

- **Data flow:** Files travel directly peer-to-peer via WebRTC DataChannels.
- **Signaling:** Only used for initial WebRTC negotiation (SDP offer/answer + ICE candidates).
- **No file data ever passes through the server** (except the encrypted relay fallback, which sees ciphertext only — see [trust-model.md](architecture/trust-model.md)).

### Batch / folder layer

Folder and multi-file transfers add a thin **batch coordinator** above the per-file
engine, so encryption, chunking, resume and integrity verification are reused
unchanged:

- `FileTree` normalizes a file `<input>`, a `webkitdirectory` folder, or a
  drag-and-drop `DataTransfer` (walking dropped directory trees, capturing empty
  folders) into a validated batch descriptor.
- `PathSanitizer` canonicalizes every relative path and rejects traversal / absolute
  / drive-letter / NUL / Windows-reserved inputs — applied on **both** sender and
  receiver so a malicious peer can't drive a path-traversal write.
- `BatchSender` / `BatchReceiver` own the channel and drive the existing
  `Sender`/`Receiver` per file (sequential, ack'd via `file-complete`), the receiver
  reconstructing the exact tree and packaging it with `ZipBuilder` (STORE + ZIP64).

See [protocol.md §2.2](protocol.md) for the wire protocol.

### Product layer (consent, history, text, destinations)

Four product features sit on top of the batch substrate without touching the
per-file engine:

- **Receive confirmation** — `batch-meta` doubles as an offer (sender identity +
  type + counts + size). `BatchSender` blocks on `receive-accept`/`receive-reject`
  (60 s expiry); `BatchReceiver` resolves the decision through a `requestApproval`
  policy that auto-accepts **remembered devices** (`storage/RememberedDevices`,
  IndexedDB) — after the SAS check — or surfaces the offer to the UI
  (`components/ReceiveConfirmation`). Device identity (`core/DeviceIdentity`) is a
  local, spoofable, non-credential token. See [protocol.md §2.3](protocol.md).
- **Download location** — `storage/DestinationManager` wraps the File System Access
  API: pick a directory, persist it as the default (handle in IndexedDB,
  re-permissioned on reuse), and `writeTree` the reconstructed tree to disk with
  per-segment traversal re-validation. `BatchReceiver` writes-to-disk when a
  destination is available, else falls back to the `ZipBuilder` path.
- **Transfer history** — `storage/HistoryManager` (IndexedDB, indexed on
  timestamp/direction/state) records one bounded row per transfer on both peers; the
  connection hook writes it fire-and-forget. `components/HistoryView` gives search /
  filter / sort / delete / clear / JSON export and a privacy toggle.
- **Text sharing** — `transfer/TextPayload` wraps composed text in a one-file batch
  (`transferType: text`) and renders received Markdown through an escape-first,
  tag-whitelist, link-protocol-restricted renderer (XSS-safe); `components/TextPreview`
  shows copy / save / render.
- **Clipboard sharing** — `transfer/ClipboardPayload` reads the system clipboard
  (cross-browser, with paste-event/`readText` fallbacks) and maps it onto the existing
  substrate: text → a `text` transfer, images/files → a `files` batch. Pure
  `clipboardItemsToBatch` keeps the mapping unit-testable; the DOM reader never throws
  on a denied permission.
- **Link sharing** — `transfer/LinkPayload` ships a `{ url, title, … }` JSON document
  as a one-file batch (`transferType: link`). It is the trust boundary on the receiver:
  the URL is **re-validated** to http/https only and every field HTML-escaped before
  `components/LinkPreview` renders the domain/title + one-click Open.
- **Persistent identity & contacts** — `core/DeviceIdentity` adds device type /
  platform / a non-reversible fingerprint; `storage/RememberedDevices` (IndexedDB v2)
  is now a full contact store (trust / rename / favorite / search / note / last-seen /
  remove) surfaced by `components/ContactsView`. Designed flat so a future account/sync
  layer can adopt the records directly.
- **QR deep links** — `core/DeepLink` builds/parses share links carrying the pairing
  code plus an expiring, optionally single-use token; `core/DeepLinkRegistry` is the
  issuer-side ledger that enforces expiry / single-use / revocation. The signaling
  server's short-lived session remains the real join authority.

See [protocol.md §2.3–§2.8](protocol.md).

---

## 6b. Share links & REST API (server-stored transfers)

Share links are the one path where the server **does** store content — a deliberate,
additive complement to the live P2P/relay path, for when sender and recipient are not
online at the same time. The live transfer engine is untouched.

```
   POST /api/v1/links            PUT …/content            GET …/download
   (reserve + uploadToken)  →    (stream bytes)     →     (validate + stream)
        │                            │                          │
   ShareLinkManager  ──────────►  StorageBackend  ◄──────────  ShareLinkManager
   (metadata + policy)            (blob bytes)                 (expiry/password/
        │                            │                          limit/single-use)
   ShareLinkStore                 filesystem | memory
   (memory | Redis, TTL)          (S3/GCS via the same interface)
```

Layering mirrors the session subsystem so it scales the same way:

- **`server/src/share/StorageBackend.js`** — pluggable blob storage behind a five-method
  interface (`put/get/delete/size/exists`). `FilesystemStorageBackend` (default, confined,
  atomic-rename publish, streamed with a byte ceiling) and `MemoryStorageBackend` (tests).
  Cloud object stores are a drop-in: implement the interface, return it from
  `createStorageBackend`. Blob ids are server-generated 128-bit hex → no path traversal.
- **`server/src/share/ShareLinkStore.js`** — metadata persistence with the same
  memory/Redis split as sessions (`createShareLinkStore` picks via `REDIS_URL`). Redis
  records carry a native TTL so expiry is enforced and shared across instances.
- **`server/src/share/ShareLinkManager.js`** — lifecycle + all policy in one place:
  two-phase upload (reserve → attach), scrypt password hashing, validation (revoked /
  expired / download-limit / single-use / password), download accounting with reaping, and
  a periodic sweeper that deletes expired **metadata and blobs**.
- **`server/src/api/`** — the REST layer: `ShareLinkRoutes` (versioned `/api/v1` router),
  `ApiKeyManager` (HMAC-signed or static keys + anonymous capability tokens, scopes),
  `HttpRateLimiter` (per-IP, Redis-capable), and `openapi.js` (served live + exported to
  `docs/api/`). `inMemoryApp.js` builds the whole app over in-memory stores for tests and
  embedding.

Clients: **`@linkspan/sdk`** (`sdk/`) wraps the API for JS/TS/Node; **`@linkspan/cli`**
(`cli/`) is a terminal client built on the SDK (it sends via share links so it works across
NAT without a live peer). Both are tested against the *real* router via `inMemoryApp`.

See [docs/api/README.md](api/README.md), the [SDK](../sdk/README.md), and the
[CLI](../cli/README.md). Security properties are catalogued in
[SECURITY.md](../SECURITY.md#share-links--rest-api).

---

## 7. Observability (Phase 6)

- **Structured logging (6.2):** `AuditLogger` emits one JSON line per event to
  stdout/stderr — `{ ts, event, severity, ip?, sessionId?, peerId?, detail? }` —
  **always**, independent of whether a database is configured. Set
  `AUDIT_LOG_STDOUT=false` to ship only to the DB. Lifecycle messages remain plain
  strings; all security/transfer events are structured.
- **Transfer tracing (6.1):** events carry `sessionId` (and `peerId` where relevant),
  so a transfer's lifecycle — `SESSION_CREATED → SESSION_JOINED → RELAY_ACTIVATED? →
  TRANSFER_STARTED → TRANSFER_COMPLETED/FAILED → SESSION_CLOSED` — is reconstructable
  by filtering on `sessionId`.
- **Metrics (6.3):** `MetricsCollector` + `PrometheusExporter` expose success/failure,
  relay activations, active sessions, etc. at `/metrics` (Prometheus format) and
  `/stats` (JSON), optionally bearer-token protected. `monitoring/` ships Prometheus
  + Grafana provisioning.
