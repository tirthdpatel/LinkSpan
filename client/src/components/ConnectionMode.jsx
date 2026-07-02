import React from 'react';

/**
 * ConnectionMode — Honest, explicit display of how the active transfer is routed
 * and what that means for who can read the data.
 *
 * This is deliberately not cosmetic: the security properties of LinkSpan differ
 * sharply between modes, and the user is entitled to know which one is in effect.
 * See docs/architecture/trust-model.md for the full threat model.
 *
 * Modes (most → least private):
 *   direct       Peer-to-peer DataChannel, DTLS-encrypted. Server saw only signaling.
 *   turn         Routed through a TURN relay, still DTLS end-to-end — relay sees ciphertext.
 *   server-relay Fallback through the LinkSpan signaling server. Chunks are encrypted
 *                with an ECDH-derived AES-256-GCM key before they leave the sender, so
 *                the server forwards ciphertext only and cannot read file contents.
 *
 * All modes carry application-layer E2E encryption (`encrypted`), which is what makes
 * the server-relay fallback safe. If the key handshake has not completed yet,
 * `encrypted` is false and we say so rather than over-claiming.
 *
 * @param {object} props
 * @param {boolean} props.relayMode  - server-relay fallback is active
 * @param {'direct'|'turn'|null} props.transport - selected ICE candidate type (P2P only)
 * @param {boolean} props.encrypted - app-layer session key has been agreed
 */
export function ConnectionMode({ relayMode = false, transport = null, encrypted = false }) {
    const mode = relayMode
        ? 'server-relay'
        : transport === 'turn'
            ? 'turn'
            : transport === 'direct'
                ? 'direct'
                : 'connecting';

    const config = {
        direct: {
            color: '#40c057',
            icon: '✓',
            title: 'Direct P2P',
            detail: 'Peer-to-peer, DTLS-encrypted. The server only handled signaling — no file data passed through it.',
            // Fastest path — no performance caveat.
            perf: null,
        },
        turn: {
            color: '#3b82f6',
            icon: '✓',
            title: 'Direct P2P · via TURN',
            detail: 'Routed through a TURN relay for NAT traversal, but DTLS-encrypted end-to-end. The relay sees only ciphertext.',
            perf: {
                level: 'limited',
                text: 'Speed may be limited by the TURN relay. For full-speed transfers, put both devices on the same network so they can connect directly.',
            },
        },
        'server-relay': {
            color: '#f59e0b',
            icon: '⚠',
            title: 'Relayed — slow path',
            detail: encrypted
                ? 'WebRTC was unavailable, so data is passing through the LinkSpan server — but it is end-to-end encrypted (AES-256-GCM). The server forwards ciphertext only and cannot read your files.'
                : 'WebRTC was unavailable. Data is passing through the LinkSpan server and the encryption handshake has not completed — do not send sensitive files until this clears.',
            perf: {
                level: 'slow',
                text: 'This is the fallback route and it is slow — typically a few hundred KB/s. Put both devices on the same Wi-Fi/network, or enable a TURN server, to get full-speed direct P2P.',
            },
        },
        connecting: {
            color: 'var(--text-muted)',
            icon: '○',
            title: 'Establishing connection…',
            detail: 'Negotiating the most direct route available.',
            perf: null,
        },
    }[mode];

    return (
        <div
            className="rounded-xl px-4 py-3 flex items-start gap-3"
            style={{ background: 'var(--bg-secondary)', border: `1px solid ${config.color}33` }}
            data-testid="connection-mode"
            data-mode={mode}
        >
            <span className="text-lg leading-none mt-0.5" style={{ color: config.color }}>
                {config.icon}
            </span>
            <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold" style={{ color: config.color }}>
                    {config.title}
                </div>
                <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    {config.detail}
                </div>
                {config.perf && (
                    <div
                        className="text-xs mt-2 px-2 py-1.5 rounded-lg font-medium flex items-start gap-1.5"
                        style={{
                            background: `${config.color}1a`,
                            color: config.color,
                        }}
                        data-testid="connection-perf-note"
                        data-perf={config.perf.level}
                    >
                        <span aria-hidden="true">{config.perf.level === 'slow' ? '🐌' : '⚡'}</span>
                        <span>{config.perf.text}</span>
                    </div>
                )}
                {mode !== 'connecting' && (
                    <div className="text-xs mt-1 font-medium" style={{ color: encrypted ? '#40c057' : 'var(--text-muted)' }}>
                        {encrypted ? '🔒 End-to-end encrypted · AES-256-GCM (ECDH session key)' : '🔓 Encryption handshake in progress…'}
                    </div>
                )}
            </div>
        </div>
    );
}
