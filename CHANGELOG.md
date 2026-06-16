# Changelog

All notable changes to LinkSpan are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the project's
on-the-wire protocol is versioned separately as `PROTOCOL_VERSION` in
`shared/constants.js`.

## [Unreleased]

### Added
- **Opt-in aggregate telemetry (privacy-first, default OFF).** When — and only when — the
  user ticks "Share anonymous stats" (in the History panel), the client POSTs a single
  anonymized, pre-bucketed event per completed transfer to `POST /api/v1/telemetry`: just
  the outcome (success/failure), transport mode (p2p/relay), a coarse size bucket, and a
  coarse duration bucket. No filename, byte count, duration value, peer/device identity,
  room membership, IP, or per-transfer id ever leaves the client. The server keeps
  aggregate COUNTS only (`server/src/telemetry/TelemetryAggregator.js`), exposed as bounded
  Prometheus series (`linkspan_client_transfers_total`, `..._transfer_size_total`,
  `..._transfer_duration_total`) on `/metrics`. The endpoint is rate-limited, needs no auth,
  always returns 204 (invalid events are silently dropped, never an oracle), and strict enum
  validation bounds metric cardinality. Reporting is fire-and-forget and never affects a
  transfer. This is the optional half of the analytics item — per-transfer rows remain
  client-side only (IndexedDB `HistoryManager`).
- **Range-list chunk requests (protocol 1.7.0).** The receiver now coalesces the chunks it
  wants into `{ start, count }` ranges and pulls them in a single `chunk-request-range`
  control frame instead of one `chunk-request` per chunk — ~85% fewer request frames and
  ~75% fewer request bytes on contiguous transfers, with negligible CPU. Capability-
  negotiated: a range-capable sender advertises `supportsRangeRequest` in `file-meta`,
  receivers fall back to per-chunk requests against old senders, and senders still serve
  per-chunk requests from old receivers (mixed-version peers interoperate). The sender
  validates every range against the real chunk count (rejecting negative/zero/out-of-bounds/
  overlapping) before expanding. New shared, swarm-agnostic, bitmap-ready codec
  `shared/chunkRanges.js` (`chunksToRanges`/`rangesToChunks`/`validateRanges`); responses,
  per-chunk verification, retries, and resume are unchanged. Verified by unit tests
  (contiguous/sparse/resume/invalid/old↔new compat) and a two-browser e2e run. See protocol
  §2.9.

### Changed
- **CI: Trivy scan is now a blocking gate covering CVEs *and* IaC misconfiguration**
  (`exit-code: 1`, `scanners: vuln,secret,misconfig`). Suppressions are documented, dated,
  and path-scoped in `.trivyignore.yaml` (dev-only build-toolchain CVEs; coturn's required
  `hostNetwork`/`hostPort`; the nginx-image `USER` gap that k8s enforces non-root for);
  runtime CVEs and fixable hardening gaps are never suppressed.

### Security
- **Hardened all Kubernetes workloads** so they pass Trivy's HIGH/CRITICAL misconfiguration
  checks: every container now runs with `readOnlyRootFilesystem: true`, `drop: [ALL]`
  capabilities, `allowPrivilegeEscalation: false`, and a non-root pod security context
  (postgres, redis, the nginx client, coturn, and both backup CronJobs — the signaling
  deployment already was). Writable paths are provided via `emptyDir` scratch mounts.
  coturn keeps `hostNetwork`/`hostPort` (architecturally required for TURN relay
  allocation), documented and suppressed rather than disabled.

### Fixed
- **Prisma init migration synced with the schema.** `server/src/database/migrations/20240101000000_init.sql`
  had drifted from `schema.prisma` (missing the `accounts` OAuth columns `password_salt`/
  `provider`/`provider_id` and the nullable `password_hash`, the unique
  `(provider, provider_id)` index, and the entire `refresh_tokens` and `api_key_records`
  tables with their indexes + cascade FKs). Regenerated from the schema via
  `prisma migrate diff` and verified byte-for-byte against the schema; the `Transfer`
  table stays absent by design.

### Removed
- **Orphaned `Transfer` Prisma model + `TransferStatus` enum.** They were never wired to any
  code path; per-transfer analytics are intentionally not persisted server-side — the
  client's IndexedDB `HistoryManager` is the source of truth for a user's transfer history.
  The unused `AuditLogger.transfer{Started,Completed,Failed}` wrappers were removed too (the
  `AuditEvent.TRANSFER_*` taxonomy is kept).

- **Group rooms — hybrid swarm (protocol 1.6.0).** Multi-peer rooms alongside the classic
  2-peer session. Topology adapts to room size: 2 → direct P2P, 3–5 → mesh (every peer ↔
  every peer), 6+ → **swarm** (BitTorrent-style: peers pull chunks rarest-first from each
  other and re-share what they receive, so the origin stops being the sole uploader). The
  server is a coordination plane only — roster, targeted N-peer signaling, and a chunk
  availability registry; file bytes always move peer-to-peer. New server:
  `server/src/rooms/{RoomManager,ChunkAvailabilityRegistry}.js`, room/swarm message types +
  validators, `MSG.{CREATE,JOIN,LEAVE}_ROOM` / `SWARM_MSG.*`. New client:
  `core/RoomConnection.js` (mesh signaling choreography), `transfer/SwarmScheduler.js`
  (rarest-first multi-source scheduling), `hooks/useRoom.js`, `components/RoomView.jsx`
  (a "Group room" beta entry). The scheduling/choreography and server plane are
  unit/integration tested; the ≥3-browser swarm experience is not yet verified end-to-end.
- **User accounts & authentication (optional).** Email/password (scrypt + constant-time
  compare) or **OAuth (Google / GitHub)**, with short-lived HMAC access JWTs (zero new
  dependencies) and long-lived **rotated** refresh tokens (stored only as hashes). Accounts
  are an ownership layer over the existing capability-token model: an authenticated request
  owns the share links/webhooks it creates (enabling list/revoke) and an account access
  token works anywhere an API key does. Account-scoped API keys can be minted, listed, and
  individually revoked (`jti` + denylist). New REST surface `/api/v1/auth/*`
  (`register`/`login`/`refresh`/`logout`/`me`/`oauth/:provider`/`api-keys`), SDK methods
  (`register`/`login`/`refresh`/`me`/`createApiKey`/…), and CLI `login`/`logout`/`whoami`.
  Store is in-memory by default, Prisma/Postgres when `DATABASE_URL` is set (Account model
  extended; new `RefreshToken`/`ApiKeyRecord` models). New: `server/src/accounts/*`,
  `server/src/api/{AuthRoutes,authMiddleware}.js`.
- **S3 / GCS storage backends.** Share-link blobs can now live on Amazon S3 (and any
  S3-compatible store — Cloudflare R2, Backblaze B2, MinIO via `S3_ENDPOINT`) or Google
  Cloud Storage, selected with `SHARE_STORAGE=s3|gcs`. Both implement the existing
  `StorageBackend` interface (streamed uploads with a byte ceiling, HTTP Range reads,
  server-generated object keys — no traversal surface). The cloud SDKs are
  `optionalDependencies`, lazily imported only on the selected path so the server still
  boots without them. New: `server/src/share/{S3,Gcs}StorageBackend.js`,
  `ObjectStorageBackend.js`; hermetic contract tests over an injected fake driver.
- **Webhooks.** Subscribe a URL to events (`share.created`, `share.uploaded`,
  `share.downloaded`, `share.revoked`, `share.expired`, `session.created`, …). Deliveries
  carry an HMAC-SHA256 `X-LinkSpan-Signature: t=…,v1=…` over the raw body, retry with
  exponential backoff (bounded attempts), and are recorded in a bounded per-endpoint log.
  Registration is SSRF-guarded (rejects non-http(s) and private/loopback hosts unless
  `WEBHOOK_ALLOW_PRIVATE`). Managed via `/api/v1/webhooks` (API-key scoped:
  `webhooks:read`/`webhooks:write`), the SDK (`createWebhook`/`listWebhooks`/`deleteWebhook`/
  `testWebhook`/`webhookDeliveries`), and verifiable with the SDK's
  `verifyWebhookSignature`. New: `server/src/webhooks/*`. Memory + Redis stores.
- **Temporary & public share links.** Upload (client-encrypted) bytes to the server for a
  download link a recipient opens later — no live peer required. Expiry presets
  (5 m / 1 h / 24 h / 7 d) or custom (clamped 1 min–30 days), optional password
  (scrypt + constant-time compare), download limits, single-use (reaped after one
  download), multi-use, and revocation. An automatic sweeper cleans up expired metadata
  **and** blobs. Pluggable blob storage (filesystem default, memory for tests, cloud
  object stores via the `StorageBackend` interface) and pluggable metadata store
  (memory / Redis with native TTL for horizontal scaling). New: `server/src/share/*`.
- **REST API (`/api/v1`).** Versioned HTTP API for share links and sessions, with API-key
  authentication (HMAC-signed or static keys, scopes, anonymous capability tokens),
  per-IP rate limiting (Redis-capable), audit logging, and an OpenAPI 3.1 spec (served at
  `/api/v1/openapi.json`, exported to `docs/api/`). New: `server/src/api/*`,
  `server/scripts/issue-api-key.mjs`, `docs/api/`.
- **`@linkspan/sdk`.** Official JS/TS/Node client (zero deps, browser + Node 18+) wrapping
  the REST API, with first-class TypeScript types, an example app, and tests against the
  real API. New: `sdk/`.
- **`@linkspan/cli`.** Cross-platform terminal client (`linkspan send/receive/list/revoke/
  status/pair/history`) built on the SDK; multi-file/folder sends are packed into a ZIP by
  a dependency-free writer. New: `cli/`.
- **DevOps.** Blob storage wired into Docker (persistent `blob_data` volume, non-root
  ownership), docker-compose, and Kubernetes (`k8s/blobs-pvc.yaml`, RWX for multi-replica).
- **Clipboard sharing.** "Paste from clipboard" stages whatever is on the system
  clipboard — plain text, images, or files — and sends it. Text becomes a previewable
  text transfer; images/files become a normal encrypted files batch. The reader is
  cross-browser with graceful fallbacks (async `clipboard.read()` for images,
  `readText()` everywhere, paste-event path when programmatic reads are blocked) and
  never throws on a denied permission. New: `transfer/ClipboardPayload`.
- **Link sharing.** A dedicated "Link" mode shares a URL with optional title; the
  receiver gets a preview showing the domain, title and a one-click **Open**. URLs are
  validated to **http/https only** (javascript:/data:/file:/blob: rejected), every
  field is HTML-escaped, and the receiver **re-validates** the URL independently of the
  sender's claim. New transfer type `link`; new `transfer/LinkPayload`,
  `components/LinkPreview`.
- **Persistent device identities.** The local device identity now carries a coarse
  device type (mobile/tablet/desktop) and platform (announced in `batch-meta`), plus a
  stable, non-reversible **fingerprint** for cross-session recognizability. New:
  `DeviceIdentity.getDeviceMetadata` / `computeFingerprint` / `detectDeviceType` /
  `detectPlatform`.
- **Saved devices & contact list.** Remembered/trusted devices are now a full contact
  list: trust, **rename**, **favorite** (favorites never evicted and sort first),
  search (by name/platform/type), per-device notes, last-seen, and remove (which also
  revokes auto-approval). New: `components/ContactsView`; `RememberedDevices` extended
  (IndexedDB schema v2, backward-compatible) — designed to back a future account/sync
  layer.
- **QR deep links.** QR / share links now encode the pairing code plus an **expiring,
  optionally single-use token** so a leaked or over-the-shoulder QR stops working after
  the session window; expired scans are rejected with a hint instead of joining a dead
  session. The issuer can revoke a specific link. Bare `?code=NNNNNN` links stay
  supported (backward compatible). New: `core/DeepLink`, `core/DeepLinkRegistry`.
  Protocol bumped to `1.5.0` (additive `batch-meta` fields `senderDeviceType` /
  `senderPlatform`; new `link` transfer type).
- **Receive confirmation workflow.** The receiver now explicitly approves every
  incoming transfer before any data flows. `batch-meta` doubles as an offer carrying
  the sender's announced identity (device name + id), transfer type, file/folder
  count and total size; the sender blocks on `receive-accept` / `receive-reject`. The
  offer **expires** after 60 s (silent peers can't pin it open), declines abort with
  no data sent, and "Accept & remember this device" auto-accepts that device next time
  (after the SAS check still passes). Every decision is logged locally. New:
  `core/DeviceIdentity`, `storage/RememberedDevices`, `components/ReceiveConfirmation`.
  Protocol bumped to `1.4.0`.
- **Download-location selection.** Where the File System Access API is available, the
  receiver can choose a destination folder (and save it as the default,
  re-permissioned on reuse). A received tree is written straight to disk preserving
  structure, relative paths and filenames — no ZIP — with every path segment
  re-validated at write time against traversal. Browsers without the API keep the ZIP
  fallback. New: `storage/DestinationManager`.
- **Transfer history.** Persistent, local-only, searchable history of every transfer
  (date, peer, type, file/folder names, size, duration, success/failure) in IndexedDB
  with indexed queries. Search, filter (direction/status), sort (date/size/name),
  per-row delete, clear-all, JSON export, and a privacy toggle that disables recording.
  New: `storage/HistoryManager`, `components/HistoryView`.
- **Text sharing.** A dedicated "Send Text" mode (plain / Markdown / code) ships the
  payload as a single-file batch — inheriting encryption, integrity and resume — and
  the receiver gets a preview with copy / save-as-file / safe-Markdown rendering.
  Markdown is rendered escape-first with an http/https/mailto link whitelist (XSS-safe).
  New: `transfer/TextPayload`, `components/TextPreview`.
- **Folder & multi-file transfer.** Send whole directory trees (nested + empty
  folders), multiple files, or a mix — by drag-and-drop or the file/folder pickers.
  A `batch-meta` preamble announces the batch; each file streams with the existing
  encrypted, resumable, manifest-verified per-file protocol and is ack'd
  (`file-complete`) so the sender advances sequentially. The receiver reconstructs
  the exact tree — preserving relative paths and empty directories — and packages it
  into a single ZIP (a lone file still downloads as-is). New modules:
  `transfer/PathSanitizer`, `transfer/FileTree`, `transfer/ZipBuilder`,
  `transfer/BatchSender`, `transfer/BatchReceiver`. Protocol bumped to `1.3.0`.
  - Sender-supplied paths are sanitized on **both** peers (traversal, absolute,
    drive-letter, NUL/control, Windows-reserved names rejected), and batches are
    bounded by file-count / directory-count / total-byte ceilings — preventing
    path-traversal writes and memory/disk exhaustion from a hostile sender.
  - Fixes a pre-existing bug where a multi-file send delivered only the first file
    (the sender fired every `file-meta` without awaiting completion and the receiver
    intercepted `file-meta` only once).
- **Authenticated key exchange (SAS).** After the ECDH handshake both peers display
  a 6-digit Short Authentication String derived from both public keys and must
  confirm it matches before any file data flows, defeating an active MITM on the
  otherwise-unauthenticated exchange (`CryptoEngine.computeSAS`, `SasVerification`).
- **Multi-instance support.** Redis-backed session store now routes signaling across
  instances via pub/sub (peers on different nodes can pair), and rate limiting +
  brute-force lockouts are shared across instances (`RedisSessionManager`,
  `RedisBruteForceGuard`, `GuardsFactory`).
- **Vercel deployment config** for the client (`client/vercel.json`) plus
  `docs/deployment-vercel.md`.
- Prometheus alerting rules (`monitoring/alerts.yml`).
- `StorageManager` IndexedDB tests backed by a real in-memory IDB (`fake-indexeddb`).

### Changed
- IndexedDB chunk storage moved from per-file object stores to a single `chunks`
  store keyed by `[fileId, index]` (DB schema v4), removing the dynamic
  store-creation path that could silently drop writes.
- Tightened nginx/Vercel CSP `script-src` to `'self'` (no `'unsafe-inline'`).
- Active-session count in the Redis backend now uses an expiry-scored sorted set,
  so the count no longer drifts upward as sessions expire by TTL.

### Fixed
- **Dropped-first-frame race:** the WebSocket handler now attaches its message
  listener before the async connection rate-limit check, so a client that sends a
  frame immediately after the socket opens is no longer dropped (surfaced under the
  Redis-backed rate limiter; frames are queued until admission).
- Relay byte-cap is computed server-side and `relay-chunk` frames are validated, so
  a forged `size` can no longer bypass the per-session cap.
- coturn config no longer relies on shell/`${VAR}` expansion it never performed;
  the public IP and shared secret are injected via a runtime entrypoint.
- Server fails closed on a wildcard `CORS_ORIGIN` in production.

### Removed
- Orphaned modules: `TransferStateMachine`, `database/TransferHistory`, and the
  broken CommonJS `RedisRateLimiter`.

## [1.2.0] — Application-layer end-to-end encryption

### Added
- Always-on AES-256-GCM encryption with an ECDH P-256 session key agreed over the
  channel, so the relay forwards ciphertext only.
- Whole-file integrity verification via a manifest root hash, plus per-chunk
  SHA-256.
- Crash-safe resume with a bounded-latency persistence ledger.

## [1.0.0] — Initial release

- Browser-to-browser WebRTC file transfer with a WebSocket signaling server,
  6-digit pairing codes / QR, parallel DataChannels, streaming I/O, and a
  server-relay fallback.
