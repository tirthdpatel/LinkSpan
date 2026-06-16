import React, { useState } from 'react';
import { useRoom } from '../hooks/useRoom.js';

const TOPOLOGY_LABEL = {
    direct: 'Direct P2P (2 peers)',
    mesh: 'Mesh (every peer ↔ every peer)',
    swarm: 'Swarm (BitTorrent-style distribution)',
};

/**
 * RoomView — create or join an N-peer group room (Phase 4, hybrid swarm). BETA: the
 * multi-browser swarm transfer is not yet verified end-to-end (needs ≥3 real browsers);
 * the scheduling/choreography and the server coordination plane are unit/integration tested.
 *
 * @param {{ onClose: () => void }} props
 */
export function RoomView({ onClose }) {
    const { status, joinCode, roster, topology, error, createRoom, joinRoom, leaveRoom } = useRoom();
    const [code, setCode] = useState('');
    const [name, setName] = useState('');

    const inRoom = status === 'in-room';

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center px-4"
            style={{ background: 'rgba(0,0,0,0.6)' }}
            role="dialog"
            aria-modal="true"
            aria-label="Group room"
            data-testid="room-view"
        >
            <div
                className="w-full max-w-lg rounded-2xl p-6 space-y-4 animate-fade-in"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
            >
                <div className="flex items-center justify-between">
                    <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
                        Group room <span className="text-xs font-normal" style={{ color: 'var(--text-muted)' }}>beta</span>
                    </h2>
                    <button type="button" onClick={() => { leaveRoom(); onClose(); }} data-testid="room-close" className="text-2xl leading-none" style={{ color: 'var(--text-muted)' }}>×</button>
                </div>

                {error && <p className="text-sm" role="alert" style={{ color: 'var(--error, #e55)' }}>{error}</p>}

                {!inRoom && (
                    <div className="space-y-3">
                        <input
                            type="text" value={name} onChange={(e) => setName(e.target.value)}
                            placeholder="Your name (optional)" data-testid="room-name"
                            className="w-full rounded-lg px-3 py-2 text-sm outline-none"
                            style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}
                        />
                        <button
                            type="button" data-testid="room-create" onClick={() => createRoom(name)}
                            disabled={status === 'connecting'}
                            className="w-full rounded-lg px-4 py-2 font-medium"
                            style={{ background: 'var(--accent, #4f8cff)', color: '#fff' }}
                        >
                            {status === 'connecting' ? 'Connecting…' : 'Create a room'}
                        </button>
                        <div className="flex gap-2">
                            <input
                                type="text" inputMode="numeric" value={code}
                                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                placeholder="Enter 6-digit code" data-testid="room-code-input"
                                className="flex-1 rounded-lg px-3 py-2 text-sm outline-none tracking-widest"
                                style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}
                            />
                            <button
                                type="button" data-testid="room-join" onClick={() => joinRoom(code, name)}
                                disabled={code.length !== 6 || status === 'connecting'}
                                className="rounded-lg px-4 py-2 font-medium"
                                style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}
                            >Join</button>
                        </div>
                    </div>
                )}

                {inRoom && (
                    <div className="space-y-4">
                        {joinCode && (
                            <div className="text-center">
                                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Share this code:</p>
                                <p className="text-3xl font-mono font-bold tracking-widest" data-testid="room-joincode" style={{ color: 'var(--text-primary)' }}>{joinCode}</p>
                            </div>
                        )}
                        <p className="text-sm" data-testid="room-topology" style={{ color: 'var(--text-muted)' }}>
                            Topology: <strong style={{ color: 'var(--text-primary)' }}>{TOPOLOGY_LABEL[topology] || topology}</strong>
                        </p>
                        <div>
                            <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>Members ({roster.length})</p>
                            <ul className="space-y-1" data-testid="room-roster">
                                {roster.map((p) => (
                                    <li key={p.peerId} className="text-sm flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                                        <span aria-hidden>🟢</span>{p.name || p.peerId.slice(0, 8)}
                                    </li>
                                ))}
                            </ul>
                        </div>
                        <button
                            type="button" data-testid="room-leave" onClick={() => { leaveRoom(); onClose(); }}
                            className="w-full rounded-lg px-4 py-2 font-medium"
                            style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}
                        >Leave room</button>
                    </div>
                )}
            </div>
        </div>
    );
}
