# LinkSpan

**Free, encrypted, peer-to-peer file transfer in your browser.**

No signup. No cloud storage. No limits. Files transfer directly between browsers using WebRTC.

[![CI](https://github.com/linkspan/linkspan/actions/workflows/ci.yml/badge.svg)](https://github.com/linkspan/linkspan/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Features

- 🔒 **End-to-end encrypted** — WebRTC DTLS encryption, no data touches a server
- ⚡ **7× parallel channels** — Maximum throughput via concurrent DataChannels
- 📲 **QR code pairing** — Scan to connect from any device
- 🔄 **Resume support** — Resume interrupted transfers within the same session
- 📱 **Mobile responsive** — Works on desktop and mobile browsers
- 🌙 **Dark/light mode** — Automatic theme detection
- 🆓 **100% free** — Zero cost infrastructure, open-source dependencies only
- 🔍 **Diagnostics panel** — Real-time channel throughput, RTT, and integrity stats

## Architecture

```
Browser A ←──── WebRTC DataChannel (P2P) ────→ Browser B
    ↕                                              ↕
    └──── WebSocket (signaling only) ────→ Render Server
```

- **Signaling server** relays WebRTC offers/answers/ICE candidates only
- **No file data** ever passes through the server
- Files are split into 256KB chunks and sent over 7 parallel channels
- SHA-256 integrity verification per chunk and full file

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
| `CORS_ORIGIN` | `*` | Allowed CORS origin |

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

## Project Structure

```
LinkSpan/
├── server/              # Node.js signaling server
│   ├── src/server.js    # Express + WebSocket server
│   ├── src/SessionManager.js
│   ├── src/RateLimiter.js
│   └── Dockerfile
├── client/              # React + Vite + TailwindCSS
│   ├── src/core/        # WebRTC engine
│   ├── src/transfer/    # Chunk manager, sender, receiver
│   ├── src/storage/     # Tiered storage (FSAPI/OPFS/IDB)
│   └── src/components/  # React UI
├── shared/              # Shared constants
├── docs/                # Architecture & protocol docs
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
