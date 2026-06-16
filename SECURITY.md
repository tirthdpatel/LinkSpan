# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | ✅        |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public GitHub issue
2. Email security concerns to the repository maintainers
3. Include a detailed description and steps to reproduce
4. Allow reasonable time for a fix before public disclosure

## Security Model

- **Transport encryption**: WebRTC DataChannels use mandatory DTLS 1.2+; on top of that,
  an always-on application-layer AES-256-GCM layer (ECDH P-256 key agreement) encrypts every chunk
- **No server-side storage on the live transfer path**: For live P2P/relay transfers the
  server never stores files. On the direct P2P path it never sees file data at all. If WebRTC
  cannot connect, the encrypted **relay fallback** forwards AES-256-GCM ciphertext chunks
  through the server — it relays the bytes but cannot decrypt them.
  (Residual risk: the ECDH handshake is not yet authenticated against active MITM — see
  [docs/architecture/trust-model.md](docs/architecture/trust-model.md).)
- **Share links store bytes by design** (opt-in): the temporary/public **share-link** feature
  deliberately uploads bytes to the server's blob store so a recipient can download later. The
  browser app encrypts content end-to-end before upload, so the server stores ciphertext; the
  REST API/SDK/CLI upload whatever bytes the caller provides. See the share-link section below.
- **Ephemeral sessions**: Session data is in-memory (or in Redis with a TTL when clustered) and
  auto-expires after 10 minutes of inactivity
- **Rate limiting**: Per-IP connection throttling, session creation limits, and message rate limiting
- **Input validation**: All signaling messages are validated before processing
- **CSP**: Content Security Policy headers on all responses
- **CORS**: Configurable cross-origin resource sharing
- **Receiver consent**: No transfer begins until the receiver explicitly accepts the
  offer (`batch-meta`); the pull-based protocol guarantees no chunk is requested or
  sent before acceptance, and offers expire after 60 s. "Remember device" is a UX
  convenience gated behind the per-session SAS/MITM check — a device id is spoofable
  and is never trusted as an authentication credential on its own.
- **Path-traversal defence (write side)**: Received relative paths are sanitized on
  both peers and re-validated at write time (File System Access API destination and
  ZIP entry naming) — `.`/`..`/absolute/drive-letter/NUL/control segments are rejected,
  so a crafted sender cannot escape the chosen directory (no arbitrary file write).
- **XSS-safe text preview**: Shared text/Markdown is rendered with an escape-first,
  fixed-tag-whitelist renderer; links are restricted to `http`/`https`/`mailto`, so
  sender-controlled text can never inject script or markup into the receiver's DOM.
- **Safe link sharing**: A shared URL is **re-validated on the receiver** (independent
  of the sender's claim) to `http`/`https` only — `javascript:`/`data:`/`file:`/`blob:`
  and any other scheme are rejected — and every preview field is HTML-escaped. The
  one-click "Open" uses the re-parsed URL as the href with `rel="noopener noreferrer
  nofollow"`, so a malicious link can neither run script nor disclose local files.
- **Expiring QR deep links**: QR / share links carry an expiring (optionally
  single-use, revocable) token on top of the pairing code, so a leaked or
  over-the-shoulder QR stops working after the session window; expired scans are
  rejected rather than joining a dead session. The signaling server's short-lived
  session remains the authoritative join credential.
- **Local-only history**: Transfer history and remembered devices are stored only in
  the user's browser (IndexedDB), never transmitted; history can be disabled and
  cleared, and is bounded to cap storage growth.
- **DoS/exhaustion ceilings**: Batch file-count, directory-count, total-byte and text
  payload limits bound receiver memory/disk against a hostile or buggy sender.

### Share links & REST API

- **No path traversal / arbitrary read+write**: blob, link, and upload ids are
  server-generated 128-bit hex tokens — never derived from user input. The filesystem
  backend additionally re-checks that every resolved path stays inside its confinement
  root, so a caller bug can never escape it. Download filenames are sanitized to a
  basename and sent only via `Content-Disposition` (with a restrictive
  `default-src 'none'; sandbox` CSP and `X-Content-Type-Options: nosniff`), so stored
  content can never render inline as a page (no stored XSS).
- **Memory & disk exhaustion**: uploads stream straight to the storage backend (never the
  whole blob in memory) and are cut off at a per-blob byte ceiling. Per-link size limits,
  expiry, the automatic sweeper (metadata **and** blob cleanup), and download limits bound
  total disk use. Link creation and uploads are rate limited per IP.
- **Public-link abuse**: every link expires (1 min–30 day bound), can require a password,
  can cap total downloads, can be single-use (reaped after one download), and can be
  revoked — which deletes the blob and metadata immediately.
- **Brute force**: download passwords are stored as `scrypt(salt)` and compared in constant
  time; the per-IP download rate limit (30/min) bounds online password guessing. Upload
  tokens, owner capability tokens, and API keys are likewise constant-time compared.
- **Auth & authz**: management endpoints require an API key (HMAC-signed or static); links
  are owned by the key's owner (or a per-link capability `ownerToken` when anonymous), and
  revoke/list enforce ownership. Anonymous creation can be disabled in production.
- **CSRF**: the API is token-authenticated (Bearer/headers), not cookie/session based, so
  it is not exercisable cross-site via ambient credentials. Downloads are GETs of opaque,
  unguessable ids.
- **SSRF**: the server performs no outbound requests on behalf of a caller for share links,
  so there is no SSRF surface in this subsystem.
- **Audit logging**: link create / upload / download / revoke / sweep and session creation
  emit structured audit events (the same JSON stream as signaling events).

### Telemetry & privacy

- **Opt-in and off by default.** No analytics are collected unless the user explicitly
  enables "Share anonymous stats". The flag lives in `localStorage`; doing nothing sends
  nothing.
- **Aggregate-only, no PII.** When enabled, a completed transfer produces a single event
  carrying only four bounded categories: outcome (success/failure), transport mode
  (p2p/relay), a coarse size bucket, and a coarse duration bucket. The client buckets the
  values before anything is sent — no filename, exact byte count, exact duration, peer or
  device identity, room membership, IP, or per-transfer id is ever transmitted or stored.
  The server keeps only running counts (Prometheus series); there is no per-transfer row.
- **Hardened endpoint.** `POST /api/v1/telemetry` is unauthenticated (anonymous opt-in) but
  rate limited per IP, strictly validates every field against a fixed enum (so a hostile
  client cannot inject labels or blow up metric cardinality), and always returns 204 so it
  cannot be used as an oracle. Reporting is fire-and-forget and never affects a transfer.
