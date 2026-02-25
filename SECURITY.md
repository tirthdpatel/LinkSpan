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

- **Transport encryption**: All WebRTC DataChannels use mandatory DTLS 1.2+ encryption
- **No server-side file storage**: Files transfer peer-to-peer; the signaling server never sees file data
- **Ephemeral sessions**: All session data is in-memory and auto-expires after 10 minutes of inactivity
- **Rate limiting**: Per-IP connection throttling, session creation limits, and message rate limiting
- **Input validation**: All signaling messages are validated before processing
- **CSP**: Content Security Policy headers on all responses
- **CORS**: Configurable cross-origin resource sharing
