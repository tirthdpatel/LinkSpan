# LinkSpan

**Free, encrypted, peer-to-peer file transfer in your browser.**

No signup. No cloud storage on the default path. Files transfer directly between browsers using WebRTC.

### 🚀 [Try it live → link-span-rosy.vercel.app](https://link-span-rosy.vercel.app/)

Open the link on two devices, pair them, and send — nothing to install.

[![CI](https://github.com/linkspan/linkspan/actions/workflows/ci.yml/badge.svg)](https://github.com/linkspan/linkspan/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Features

- 🔒 **End-to-end encrypted** — always-on AES-256-GCM (ECDH key agreement) plus WebRTC DTLS; for direct transfers no file data touches the server
- 📁 **Files & folders** — Send whole directory trees, multiple files, or a mix; drag-and-drop folders or pick them. Structure (incl. empty folders) is preserved and rebuilt on the receiver
- ✅ **Receive confirmation** — The receiver sees who's sending (device name), what (type, file/folder count, size) and must Accept before any data flows; reject, or "Accept & remember device" to auto-accept next time. Offers expire after 60 s
- 📂 **Choose where files land** — Pick a destination folder (File System Access API); received trees are written straight to disk preserving structure, or downloaded as a ZIP on browsers without the API
- 📝 **Text & snippets** — Dedicated text mode (plain / Markdown / code) with copy, save-as-file and safe Markdown preview on the receiver
- 📋 **Clipboard sharing** — "Paste from clipboard" sends text, images or files straight from your clipboard, cross-browser with graceful fallbacks
- 🔗 **Link sharing** — Share a URL with title; the receiver gets a domain/title preview and one-click open. http/https only, re-validated and escaped (XSS-safe)
- 💻 **Saved devices** — Trust, rename, favorite and search devices you've received from; remembered devices auto-approve next time (after the security check still passes)
- 📜 **Transfer history** — Local, searchable, exportable history of every transfer; filter, sort, clear, or disable recording entirely
- 🔕 **Privacy by default** — No analytics unless you opt in. "Share anonymous stats" sends only aggregate, bucketed counts (outcome, p2p/relay, coarse size/duration) — never filenames, sizes, identities, or per-transfer data
- ⚡ **7× parallel channels** — Maximum throughput via concurrent DataChannels
- 📲 **QR code pairing** — Scan to connect from any device; QR deep links carry an expiring (optionally single-use, revocable) token
- ⏳ **Share links** — Upload to the server for a download link the recipient opens later (no live peer needed). Temporary or public, with expiry (5 m / 1 h / 24 h / 7 d / custom), optional password, download limits, single-use, and revocation. Automatic expiry cleanup
- 🛠️ **REST API + SDK + CLI** — A versioned [REST API](docs/api/README.md) (OpenAPI 3.1, API keys, rate limiting, audit logging), an [`@linkspan/sdk`](sdk/README.md) JS/TS/Node client, and a [`linkspan`](cli/README.md) command-line tool
- 👥 **Group rooms (beta)** — Share with several people at once. Rooms adapt by size: 2 → direct P2P, 3–5 → mesh, 6+ → **swarm** (BitTorrent-style — peers pull rarest-first from each other and re-share, so one sender isn't the bottleneck). The server only coordinates; file bytes stay peer-to-peer. See [docs/architecture/swarm.md](docs/architecture/swarm.md)
- 👤 **Accounts (optional)** — Email/password (scrypt) or **Google/GitHub OAuth**, short-lived access JWTs + rotated refresh tokens. Logging in lets you own, list, and revoke your share links/webhooks and mint scoped API keys — anonymous use is unchanged. `linkspan login` from the CLI
- 🪝 **Webhooks** — Subscribe a URL to events (`share.created`, `share.downloaded`, `share.revoked`, …); deliveries are HMAC-signed (`X-LinkSpan-Signature`), retried with backoff, and verifiable with the SDK's `verifyWebhookSignature`. SSRF-guarded
- ☁️ **Pluggable storage** — Share-link blobs on local disk, **Amazon S3** (or R2/B2/MinIO), or **Google Cloud Storage** — same interface, drop-in via `SHARE_STORAGE`
- 🔄 **Resume support** — Resume interrupted transfers within the same session
- 📱 **Mobile responsive** — Works on desktop and mobile browsers
- 🌙 **Dark/light mode** — Automatic theme detection
- 🆓 **100% free** — Zero cost infrastructure, open-source dependencies only
- 🔍 **Diagnostics panel** — Real-time channel throughput, RTT, and integrity stats

## Architecture

```
Browser A ←──── WebRTC DataChannel (P2P) ────→ Browser B
    ↕                                              ↕
    └──── WebSocket (signaling + relay fallback) ──→ Server
```

- **Signaling server** relays WebRTC offers/answers/ICE candidates
- **Direct P2P:** file data never passes through the server (DTLS + AES-256-GCM)
- **Relay fallback:** if WebRTC can't connect, the server forwards **encrypted** chunks
  (AES-256-GCM ciphertext) between peers — it relays the bytes but cannot read them.
  See [docs/architecture/trust-model.md](docs/architecture/trust-model.md).
- Files are split into chunks (up to 256KB, dynamically sized) and sent over up to 7 parallel channels
- SHA-256 integrity verification per chunk and over the whole file (manifest root)
- **Receiver-approved:** `batch-meta` doubles as a transfer offer; the sender streams nothing until the receiver accepts (offer expires after 60 s). See [docs/protocol.md §2.3](docs/protocol.md)

## Quick Start

### Prerequisites
- Node.js 18+
- npm

### Development

```bash
# Clone
git clone https://github.com/linkspan/linkspan.git
cd linkspan

# Start signaling server
cd server
npm install
npm run dev

# In another terminal — start client
cd client
npm install
npm run dev
```

Open `http://localhost:5173` in two browser tabs to test.

### Docker

```bash
docker compose up --build
```

## Configuration

### Environment Variables

#### Signaling Server
| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `10000` | Server port |
| `CORS_ORIGIN` | `*` | Allowed CORS origin (must be explicit in production) |
| `TOKEN_SECRET` | random | HMAC secret for session tokens (set in production) |
| `REDIS_URL` | — | Enables Redis-backed sessions, rate limits, and share-link metadata (horizontal scaling) |

#### Share Links / REST API
| Variable | Default | Description |
|----------|---------|-------------|
| `SHARE_STORAGE` | `filesystem` | Blob backend: `filesystem`, `memory`, `s3`, or `gcs` |
| `SHARE_STORAGE_DIR` | `./.linkspan-blobs` | Filesystem blob directory (mount a volume in production) |
| `S3_BUCKET` / `S3_REGION` | — | S3 backend (`SHARE_STORAGE=s3`). Also `S3_ENDPOINT` (R2/B2/MinIO), `S3_PREFIX`, `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` (else SDK default chain) |
| `GCS_BUCKET` | — | GCS backend (`SHARE_STORAGE=gcs`). Also `GCS_PROJECT_ID`, `GCS_KEY_FILE`, `GCS_PREFIX` |
| `PUBLIC_BASE_URL` | — | Absolute base URL used in generated link/download URLs |
| `SHARE_VIEW_URL` | — | Where `/s/:id` redirects (the client app's viewer); falls back to the raw download URL |
| `API_KEY_SECRET` | `TOKEN_SECRET` | Secret for signing/verifying REST API keys |
| `API_ALLOW_ANONYMOUS` | `true` dev / `false` prod | Allow anonymous (capability-token) link creation |
| `LINKSPAN_API_KEYS` | — | Static keys: `secretA=ownerA,secretB=ownerB` |

#### Accounts / Auth (optional)
| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | Postgres URL → Prisma-backed accounts (else in-memory) |
| `AUTH_JWT_SECRET` | `TOKEN_SECRET` | Secret for signing account access tokens |
| `AUTH_SUCCESS_URL` | — | Where OAuth callback redirects with tokens in the URL fragment |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Enable Google OAuth login |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | — | Enable GitHub OAuth login |

#### Webhooks
| Variable | Default | Description |
|----------|---------|-------------|
| `WEBHOOK_ALLOW_PRIVATE` | `true` dev / `false` prod | Allow webhook URLs pointing at private/loopback hosts |

#### Client
| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_SIGNALING_URL` | `ws://localhost:10000` | Signaling server WebSocket URL |
| `VITE_TURN_DOMAIN` | `global.relay.metered.ca` | TURN server domain |
| `VITE_TURN_USERNAME` | — | TURN username (from Metered.ca) |
| `VITE_TURN_CREDENTIAL` | — | TURN credential |

### TURN Server Setup

For NAT-restricted networks, sign up for a free [Metered.ca](https://dashboard.metered.ca/signup?tool=stunturn) account (500MB/mo free, no credit card) and set the TURN env vars.

## Deployment

### Render (Recommended — Free)

1. Fork this repository
2. Create a **Web Service** on [Render](https://render.com) → connect your fork → set root directory to `server/`
3. Create a **Static Site** on Render → connect your fork → set root directory to `client/` → build command: `npm run build` → publish directory: `dist`
4. Set `VITE_SIGNALING_URL` to your Render web service URL (use `wss://`)

### Self-Hosted

```bash
docker compose up -d
```

Blob storage for share links persists in the `blob_data` volume (mounted at `/data/blobs`).
For Kubernetes, apply `k8s/blobs-pvc.yaml` (a ReadWriteMany volume so every replica serves
every link — see the file for alternatives) alongside the rest of `k8s/`.

### REST API, SDK & CLI

The server exposes a versioned REST API at `/api/v1` for share links and sessions
(OpenAPI: `GET /api/v1/openapi.json`). See [docs/api/README.md](docs/api/README.md).

```bash
# CLI — share a file and get a download link
npx @linkspan/cli send report.pdf --expires 24h --password hunter2

# SDK
import { LinkSpanClient } from '@linkspan/sdk';
const link = await new LinkSpanClient({ baseUrl }).createShare(bytes, { filename: 'x.bin' });
```

## Project Structure

```
LinkSpan/
├── server/              # Node.js signaling server + REST API
│   ├── src/server.js    # Express + WebSocket server
│   ├── src/SessionManager.js
│   ├── src/RateLimiter.js
│   ├── src/share/       # Share-link storage backends, metadata store, manager
│   ├── src/api/         # REST router, API keys, HTTP rate limiter, OpenAPI
│   └── Dockerfile
├── client/              # React + Vite + TailwindCSS
│   ├── src/core/        # WebRTC engine
│   ├── src/transfer/    # Chunk manager, sender, receiver
│   ├── src/storage/     # Tiered storage (FSAPI/OPFS/IDB)
│   └── src/components/  # React UI
├── sdk/                 # @linkspan/sdk — JS/TS/Node client
├── cli/                 # @linkspan/cli — command-line client
├── shared/              # Shared constants
├── docs/                # Architecture, protocol & API docs
└── docker-compose.yml
```

## Browser Compatibility

| Browser | Desktop | Mobile |
|---------|---------|--------|
| Chrome 80+ | ✅ | ✅ |
| Firefox 78+ | ✅ | ✅ |
| Edge 80+ | ✅ | ✅ |
| Safari 15+ | ✅ | ✅ |

## Security

- WebRTC DTLS encryption on all DataChannels
- No file data stored on any server
- Ephemeral sessions with auto-expiry
- Rate limiting and anti-abuse protections
- See [SECURITY.md](SECURITY.md) for vulnerability reporting

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT — see [LICENSE](LICENSE)
