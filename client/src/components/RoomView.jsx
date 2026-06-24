import React, { useEffect, useRef, useState } from 'react';
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
const formatBytes = (n) => {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(n) / Math.log(1024));
    return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};

export function RoomView({ onClose }) {
    const { status, joinCode, roster, topology, error, messages, createRoom, joinRoom, leaveRoom, sendMessage, sendFile } = useRoom();
    const [code, setCode] = useState('');
    const [name, setName] = useState('');
    const [draft, setDraft] = useState('');

    const inRoom = status === 'in-room';

    // Auto-scroll the chat log to the newest message.
    const logRef = useRef(null);
    const fileInputRef = useRef(null);
    useEffect(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    }, [messages]);

    const submitChat = (e) => {
        e.preventDefault();
        if (!draft.trim()) return;
        sendMessage(draft);
        setDraft('');
    };

    const onPickFile = (e) => {
        const file = e.target.files?.[0];
        if (file) sendFile(file);
        e.target.value = ''; // allow re-sending the same file
    };

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

                        {/* Group chat — messages travel peer-to-peer over the room mesh
                            (DTLS-encrypted; the server never sees them). */}
                        <div className="flex flex-col" style={{ minHeight: 0 }}>
                            <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>Chat</p>
                            <div
                                ref={logRef}
                                data-testid="room-chat-log"
                                className="rounded-lg p-3 space-y-2 overflow-y-auto text-sm"
                                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', height: '180px' }}
                            >
                                {messages.length === 0 && (
                                    <p style={{ color: 'var(--text-muted)' }}>No messages yet. Say hello 👋</p>
                                )}
                                {messages.map((m) => (
                                    <div key={m.id} className={m.self ? 'text-right' : 'text-left'}>
                                        {!m.self && (
                                            <span className="block text-xs font-medium" style={{ color: 'var(--text-muted)' }}>{m.name}</span>
                                        )}
                                        {m.file ? (
                                            <span
                                                className="inline-block rounded-lg px-3 py-2 text-left"
                                                data-testid="room-file-message"
                                                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', maxWidth: '85%', minWidth: '200px' }}
                                            >
                                                <span className="flex items-center gap-2">
                                                    <span aria-hidden>📎</span>
                                                    <span className="font-medium break-all">{m.file.name}</span>
                                                </span>
                                                <span className="block text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{formatBytes(m.file.size)}</span>
                                                {m.file.status !== 'complete' && (
                                                    <span className="block mt-1">
                                                        <span className="block h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border-color)' }}>
                                                            <span className="block h-full gradient-bg" style={{ width: `${m.file.progress || 0}%` }} />
                                                        </span>
                                                        <span className="block text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                                                            {m.file.status === 'failed' ? 'Failed' : `${m.file.direction === 'out' ? 'Sending' : 'Receiving'}… ${m.file.progress || 0}%`}
                                                        </span>
                                                    </span>
                                                )}
                                                {m.file.status === 'complete' && m.file.direction === 'in' && m.file.url && (
                                                    <a
                                                        href={m.file.url} download={m.file.name} data-testid="room-file-download"
                                                        className="inline-block mt-1 text-sm font-medium underline"
                                                        style={{ color: 'var(--accent, #4f8cff)' }}
                                                    >⬇ Download</a>
                                                )}
                                                {m.file.status === 'complete' && m.file.direction === 'out' && (
                                                    <span className="block text-xs mt-1" style={{ color: 'var(--text-muted)' }}>✓ Sent</span>
                                                )}
                                            </span>
                                        ) : (
                                            <>
                                                <span
                                                    className="inline-block rounded-lg px-3 py-1.5 break-words"
                                                    style={{
                                                        background: m.self ? 'var(--accent, #4f8cff)' : 'var(--bg-secondary)',
                                                        color: m.self ? '#fff' : 'var(--text-primary)',
                                                        border: m.self ? 'none' : '1px solid var(--border-color)',
                                                        maxWidth: '85%',
                                                    }}
                                                >{m.text}</span>
                                                {m.self && (
                                                    <span
                                                        className="block text-xs mt-0.5"
                                                        data-testid="room-chat-status"
                                                        title={m.status === 'sent' ? 'Sent' : 'Waiting to send — will deliver when reconnected'}
                                                        style={{ color: 'var(--text-muted)' }}
                                                    >{m.status === 'sent' ? '✓ Sent' : '🕓 Queued'}</span>
                                                )}
                                            </>
                                        )}
                                    </div>
                                ))}
                            </div>
                            <form onSubmit={submitChat} className="flex gap-2 mt-2">
                                <input
                                    ref={fileInputRef} type="file" className="hidden" data-testid="room-file-input"
                                    onChange={onPickFile}
                                />
                                <button
                                    type="button" data-testid="room-file-send" title="Send a file to the room"
                                    onClick={() => fileInputRef.current?.click()}
                                    className="rounded-lg px-3 py-2 font-medium"
                                    style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}
                                >📎</button>
                                <input
                                    type="text" value={draft} onChange={(e) => setDraft(e.target.value)}
                                    placeholder="Type a message" data-testid="room-chat-input" maxLength={2000}
                                    className="flex-1 rounded-lg px-3 py-2 text-sm outline-none"
                                    style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}
                                />
                                <button
                                    type="submit" data-testid="room-chat-send" disabled={!draft.trim()}
                                    className="rounded-lg px-4 py-2 font-medium"
                                    style={{ background: 'var(--accent, #4f8cff)', color: '#fff' }}
                                >Send</button>
                            </form>
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
