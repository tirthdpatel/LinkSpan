/**
 * useRoom — React hook for the N-peer group-room flow (Phase 4, hybrid swarm).
 *
 * Wires SignalingClient ↔ RoomConnection: create/join a room, maintain the roster + topology,
 * and establish a WebRTC mesh (one PeerConnection per other member, reusing the existing
 * PeerConnection class with its negotiated data channels). The per-peer channels are the
 * substrate SwarmScheduler pulls chunks over for the SWARM topology.
 *
 * NOTE: the multi-browser room/swarm experience is not yet verified end-to-end in real
 * browsers (it needs ≥3 peers); the underlying scheduling/choreography is unit-tested
 * (SwarmScheduler/RoomConnection) and the server coordination plane is integration-tested.
 * Exposed in the UI as "beta".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { SignalingClient } from '../core/SignalingClient.js';
import { PeerConnection } from '../core/PeerConnection.js';
import { prefetchIceServers } from '../core/IceServers.js';
import { RoomConnection } from '../core/RoomConnection.js';

const SIGNALING_URL = import.meta.env?.VITE_SIGNALING_URL || 'ws://localhost:10000';

// Data-channel id reserved for room control traffic (chat + file frames). Channels are
// negotiated with fixed ids on both sides, so id 0 refers to the same channel everywhere.
// Chat/control travel as JSON strings; file chunks travel as binary ArrayBuffers, so the
// two are told apart by `typeof event.data` in the receive handler.
const CHAT_CHANNEL_ID = 0;

// File broadcast: 64 KB chunks (safely under every browser's data-channel message cap)
// and pause when a channel buffers more than this so we don't blow up memory.
const ROOM_FILE_CHUNK = 64 * 1024;
const ROOM_FILE_BUFFER_LIMIT = 1 * 1024 * 1024; // 1 MB

// Binary chunk wire format: [u16 fileId-length][fileId utf8][u32 index][payload bytes].
function frameFileChunk(fileId, index, payload) {
    const idBytes = new TextEncoder().encode(fileId);
    const out = new Uint8Array(2 + idBytes.length + 4 + payload.byteLength);
    const dv = new DataView(out.buffer);
    dv.setUint16(0, idBytes.length);
    out.set(idBytes, 2);
    dv.setUint32(2 + idBytes.length, index);
    out.set(new Uint8Array(payload), 2 + idBytes.length + 4);
    return out.buffer;
}

function parseFileChunk(buffer) {
    const dv = new DataView(buffer);
    const idLen = dv.getUint16(0);
    const fileId = new TextDecoder().decode(new Uint8Array(buffer, 2, idLen));
    const index = dv.getUint32(2 + idLen);
    const payload = buffer.slice(2 + idLen + 4);
    return { fileId, index, payload };
}

// Pause until a channel has drained below the buffer limit (backpressure).
function waitForDrain(channel) {
    if (channel.bufferedAmount <= ROOM_FILE_BUFFER_LIMIT) return Promise.resolve();
    return new Promise((resolve) => {
        const check = () => {
            if (channel.readyState !== 'open' || channel.bufferedAmount <= ROOM_FILE_BUFFER_LIMIT) {
                channel.removeEventListener('bufferedamountlow', check);
                resolve();
            }
        };
        channel.addEventListener('bufferedamountlow', check);
        setTimeout(check, 100); // safety poll in case the event is missed
    });
}

export function useRoom() {
    const [status, setStatus] = useState('idle'); // idle | connecting | in-room | error
    const [joinCode, setJoinCode] = useState(null);
    const [roster, setRoster] = useState([]);
    const [topology, setTopology] = useState('direct');
    const [error, setError] = useState(null);
    const [messages, setMessages] = useState([]); // { id, from, name, text, ts, self }

    const signalingRef = useRef(null);
    const roomRef = useRef(null);
    const chatChannelsRef = useRef(new Map()); // remoteId → RTCDataChannel (chat/control)
    const selfIdRef = useRef(null);
    const selfNameRef = useRef('');
    const seenMsgRef = useRef(new Set()); // dedupe by message id (mesh broadcast)
    const outboxRef = useRef([]); // own messages not yet delivered to any peer (offline queue)
    const incomingFilesRef = useRef(new Map()); // fileId → { name, mime, size, chunks, parts[], received }

    const _teardown = useCallback(() => {
        try { roomRef.current?.close(); } catch { /* ignore */ }
        try { signalingRef.current?.disconnect(); } catch { /* ignore */ }
        roomRef.current = null;
        signalingRef.current = null;
        chatChannelsRef.current = new Map();
        seenMsgRef.current = new Set();
        outboxRef.current = [];
        incomingFilesRef.current = new Map();
        selfIdRef.current = null;
    }, []);

    useEffect(() => () => _teardown(), [_teardown]);

    // Append an incoming/own chat message, de-duplicated by id (a mesh delivers the
    // same broadcast from multiple peers; we keep the first and drop repeats).
    // `status` ('queued' | 'sent') is tracked for own messages so the UI can show
    // delivery state and an offline-queued message can flip to sent on flush.
    const _ingestChat = useCallback((msg, self, status) => {
        if (!msg || msg.kind !== 'chat' || !msg.id) return;
        if (seenMsgRef.current.has(msg.id)) return;
        seenMsgRef.current.add(msg.id);
        setMessages((prev) => [...prev, {
            id: msg.id,
            from: msg.from,
            name: msg.name || (msg.from ? msg.from.slice(0, 8) : 'peer'),
            text: String(msg.text ?? ''),
            ts: msg.ts || Date.now(),
            self: Boolean(self),
            status: self ? (status || 'queued') : undefined,
        }]);
    }, []);

    // Send a frame to every open peer channel. Returns the number of peers reached.
    const _deliver = useCallback((msg) => {
        const frame = JSON.stringify(msg);
        let n = 0;
        for (const channel of chatChannelsRef.current.values()) {
            if (channel.readyState === 'open') {
                try { channel.send(frame); n++; } catch { /* peer dropped */ }
            }
        }
        return n;
    }, []);

    const _markSent = useCallback((id) => {
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, status: 'sent' } : m)));
    }, []);

    // Try to deliver any queued (offline) messages. Called when a peer channel opens,
    // when the browser reports it's back online, and on a periodic retry tick.
    const _flushOutbox = useCallback(() => {
        if (!outboxRef.current.length) return;
        const remaining = [];
        for (const msg of outboxRef.current) {
            if (_deliver(msg) > 0) _markSent(msg.id);
            else remaining.push(msg);
        }
        outboxRef.current = remaining;
    }, [_deliver, _markSent]);

    // Insert/update a "file" entry in the chat log (shared by sender + receiver views).
    const _upsertFileMessage = useCallback((fileId, patch, base) => {
        setMessages((prev) => {
            const i = prev.findIndex((m) => m.id === fileId);
            if (i === -1) {
                if (!base) return prev;
                return [...prev, { id: fileId, ts: Date.now(), ...base, file: { ...base.file, ...patch } }];
            }
            const next = prev.slice();
            next[i] = { ...next[i], file: { ...next[i].file, ...patch } };
            return next;
        });
    }, []);

    // Receiver: a peer announced a file. Allocate the reassembly buffer and a log entry.
    const _handleFileMeta = useCallback((msg) => {
        if (!msg.fileId || incomingFilesRef.current.has(msg.fileId)) return;
        incomingFilesRef.current.set(msg.fileId, {
            name: msg.name, mime: msg.mime || 'application/octet-stream',
            size: msg.size || 0, chunks: msg.chunks || 0, parts: new Array(msg.chunks || 0), received: 0,
        });
        _upsertFileMessage(msg.fileId, {}, {
            self: false, name: msg.senderName || (msg.from ? msg.from.slice(0, 8) : 'peer'),
            file: { name: msg.name, size: msg.size || 0, progress: 0, status: 'receiving', direction: 'in' },
        });
    }, [_upsertFileMessage]);

    // Receiver: a binary chunk arrived. Store it; assemble + expose a download when complete.
    const _handleFileChunk = useCallback((buffer) => {
        const { fileId, index, payload } = parseFileChunk(buffer);
        const entry = incomingFilesRef.current.get(fileId);
        if (!entry || entry.parts[index] !== undefined) return; // unknown or duplicate
        entry.parts[index] = payload;
        entry.received++;
        const progress = entry.chunks ? Math.round((entry.received / entry.chunks) * 100) : 0;
        if (entry.received >= entry.chunks) {
            const blob = new Blob(entry.parts, { type: entry.mime });
            const url = URL.createObjectURL(blob);
            incomingFilesRef.current.delete(fileId);
            _upsertFileMessage(fileId, { progress: 100, status: 'complete', url });
        } else {
            _upsertFileMessage(fileId, { progress });
        }
    }, [_upsertFileMessage]);

    const _buildRoom = useCallback((selfId, token, signaling) => {
        selfIdRef.current = selfId;

        // Wire the chat/control channel for a peer: store it and parse inbound chat.
        const wireChatChannel = (remoteId, channel) => {
            if (channel.id !== CHAT_CHANNEL_ID) return; // only the control channel
            chatChannelsRef.current.set(remoteId, channel);
            channel.onmessage = (event) => {
                if (typeof event.data !== 'string') { _handleFileChunk(event.data); return; } // binary = file chunk
                let msg;
                try { msg = JSON.parse(event.data); } catch { return; }
                if (msg.kind === 'file-meta') _handleFileMeta(msg);
                else _ingestChat(msg, false);
            };
            // This channel is wired at open time (negotiated channels call back on
            // open) — a peer just became reachable, so drain any queued messages.
            _flushOutbox();
        };

        const createPeer = (remoteId) => {
            const peer = new PeerConnection({
                onIceCandidate: (candidate) =>
                    signaling.sendRoom({ type: 'ice-candidate', to: remoteId, token, payload: candidate }),
                onChannel: (channel) => { wireChatChannel(remoteId, channel); },
                onConnectionStateChange: () => {},
            });
            peer.init();
            // Negotiated channels are created on both sides (matches the 1:1 path).
            peer.createChannels((channel) => { wireChatChannel(remoteId, channel); });
            return peer;
        };

        const room = new RoomConnection({
            selfId,
            token,
            send: (msg) => signaling.sendRoom(msg),
            createPeer,
            onRoster: (peers, topo) => { setRoster(peers); setTopology(topo); },
        });
        roomRef.current = room;

        signaling.on('room-roster', (data) => room.handleRoster(data));
        signaling.on('room-signal', (data) => room.handleSignal(data));
        signaling.on('room-peer-left', (data) => room.handlePeerLeft(data));
        signaling.on('room-peer-joined', () => {});
        return room;
    }, [_ingestChat, _flushOutbox, _handleFileMeta, _handleFileChunk]);

    // Retry the offline queue: on a timer (covers ICE-restart reconnects where a
    // channel re-opens without a fresh callback) and when the OS reports it's online.
    useEffect(() => {
        if (status !== 'in-room') return undefined;
        const iv = setInterval(() => _flushOutbox(), 3000);
        const onOnline = () => _flushOutbox();
        window.addEventListener('online', onOnline);
        return () => { clearInterval(iv); window.removeEventListener('online', onOnline); };
    }, [status, _flushOutbox]);

    const _connect = useCallback(async () => {
        // Warm the ICE-server cache now: mesh peers are constructed synchronously
        // (createPeer), so they read the cached credentials rather than awaiting.
        prefetchIceServers();
        const signaling = new SignalingClient(SIGNALING_URL);
        signalingRef.current = signaling;
        signaling.on('error', (e) => { setError(e?.message || 'Signaling error'); setStatus('error'); });
        await signaling.connect();
        return signaling;
    }, []);

    const createRoom = useCallback(async (name) => {
        setStatus('connecting'); setError(null); setMessages([]);
        seenMsgRef.current = new Set(); outboxRef.current = [];
        selfNameRef.current = name || '';
        try {
            const signaling = await _connect();
            signaling.on('room-created', (data) => {
                _buildRoom(data.peerId, data.token, signaling);
                if (data.joinCode) setJoinCode(data.joinCode);
                setTopology(data.topology || 'direct');
                setStatus('in-room');
            });
            signaling.createRoom(name);
        } catch (e) { setError(e.message); setStatus('error'); }
    }, [_connect, _buildRoom]);

    const joinRoom = useCallback(async (code, name) => {
        setStatus('connecting'); setError(null); setMessages([]);
        seenMsgRef.current = new Set(); outboxRef.current = [];
        selfNameRef.current = name || '';
        try {
            const signaling = await _connect();
            signaling.on('room-created', (data) => {
                _buildRoom(data.peerId, data.token, signaling);
                setTopology(data.topology || 'direct');
                setStatus('in-room');
            });
            signaling.joinRoom(code, name);
        } catch (e) { setError(e.message); setStatus('error'); }
    }, [_connect, _buildRoom]);

    // Broadcast a chat message to every connected room peer over the control channel.
    // If no peer is reachable (offline / nobody connected yet) the message is queued
    // and retried automatically when connectivity returns. Returns true if delivered.
    const sendMessage = useCallback((text) => {
        const body = String(text ?? '').trim();
        if (!body || !selfIdRef.current) return false;
        const msg = {
            kind: 'chat',
            id: `${selfIdRef.current}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
            from: selfIdRef.current,
            name: selfNameRef.current || selfIdRef.current.slice(0, 8),
            text: body,
            ts: Date.now(),
        };
        const delivered = _deliver(msg) > 0;
        // Echo locally immediately, marked sent or queued so the UI reflects state.
        _ingestChat(msg, true, delivered ? 'sent' : 'queued');
        if (!delivered) outboxRef.current.push(msg); // flushed on reconnect
        return delivered;
    }, [_ingestChat, _deliver]);

    // Broadcast a file to every connected room peer over the mesh. Unlike chat, a file
    // can't be meaningfully queued offline, so it requires at least one open peer channel.
    // Chunks are streamed with backpressure; the data is DTLS-encrypted in transit.
    const sendFile = useCallback(async (file) => {
        if (!file || !selfIdRef.current) return false;
        const openChannels = () => [...chatChannelsRef.current.values()].filter((c) => c.readyState === 'open');
        if (openChannels().length === 0) {
            setError('No connected peers yet — wait for someone to join before sending a file.');
            return false;
        }
        setError(null);
        const fileId = `f:${selfIdRef.current}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        const chunks = Math.max(1, Math.ceil(file.size / ROOM_FILE_CHUNK));
        const senderName = selfNameRef.current || selfIdRef.current.slice(0, 8);

        // Announce, then add a local outgoing entry to the chat log.
        const meta = { kind: 'file-meta', fileId, from: selfIdRef.current, senderName, name: file.name, mime: file.type, size: file.size, chunks };
        _deliver(meta);
        _upsertFileMessage(fileId, {}, {
            self: true, name: senderName,
            file: { name: file.name, size: file.size, progress: 0, status: 'sending', direction: 'out' },
        });

        try {
            for (let i = 0; i < chunks; i++) {
                const slice = file.slice(i * ROOM_FILE_CHUNK, (i + 1) * ROOM_FILE_CHUNK);
                const payload = await slice.arrayBuffer();
                const frame = frameFileChunk(fileId, i, payload);
                for (const channel of openChannels()) {
                    try { channel.send(frame); await waitForDrain(channel); } catch { /* peer dropped mid-transfer */ }
                }
                _upsertFileMessage(fileId, { progress: Math.round(((i + 1) / chunks) * 100) });
            }
            _upsertFileMessage(fileId, { progress: 100, status: 'complete' });
            return true;
        } catch (e) {
            _upsertFileMessage(fileId, { status: 'failed' });
            setError(`File send failed: ${e.message}`);
            return false;
        }
    }, [_deliver, _upsertFileMessage]);

    const leaveRoom = useCallback(() => {
        try { signalingRef.current?.leaveRoom(); } catch { /* ignore */ }
        _teardown();
        setStatus('idle'); setJoinCode(null); setRoster([]); setTopology('direct'); setMessages([]);
    }, [_teardown]);

    return { status, joinCode, roster, topology, error, messages, createRoom, joinRoom, leaveRoom, sendMessage, sendFile };
}
