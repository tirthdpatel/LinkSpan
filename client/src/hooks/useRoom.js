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
import { RoomConnection } from '../core/RoomConnection.js';

const SIGNALING_URL = import.meta.env?.VITE_SIGNALING_URL || 'ws://localhost:10000';

// Data-channel id reserved for room control traffic (chat). Channels are negotiated
// with fixed ids on both sides, so id 0 refers to the same channel on every peer.
const CHAT_CHANNEL_ID = 0;

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

    const _teardown = useCallback(() => {
        try { roomRef.current?.close(); } catch { /* ignore */ }
        try { signalingRef.current?.disconnect(); } catch { /* ignore */ }
        roomRef.current = null;
        signalingRef.current = null;
        chatChannelsRef.current = new Map();
        seenMsgRef.current = new Set();
        selfIdRef.current = null;
    }, []);

    useEffect(() => () => _teardown(), [_teardown]);

    // Append an incoming/own chat message, de-duplicated by id (a mesh delivers the
    // same broadcast from multiple peers; we keep the first and drop repeats).
    const _ingestChat = useCallback((msg, self) => {
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
        }]);
    }, []);

    const _buildRoom = useCallback((selfId, token, signaling) => {
        selfIdRef.current = selfId;

        // Wire the chat/control channel for a peer: store it and parse inbound chat.
        const wireChatChannel = (remoteId, channel) => {
            if (channel.id !== CHAT_CHANNEL_ID) return; // only the control channel
            chatChannelsRef.current.set(remoteId, channel);
            channel.onmessage = (event) => {
                if (typeof event.data !== 'string') return; // ignore binary (file) frames
                let msg;
                try { msg = JSON.parse(event.data); } catch { return; }
                _ingestChat(msg, false);
            };
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
    }, [_ingestChat]);

    const _connect = useCallback(async () => {
        const signaling = new SignalingClient(SIGNALING_URL);
        signalingRef.current = signaling;
        signaling.on('error', (e) => { setError(e?.message || 'Signaling error'); setStatus('error'); });
        await signaling.connect();
        return signaling;
    }, []);

    const createRoom = useCallback(async (name) => {
        setStatus('connecting'); setError(null); setMessages([]);
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
    // Returns false if no peer channel is open yet (nothing was sent).
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
        const frame = JSON.stringify(msg);
        let delivered = 0;
        for (const channel of chatChannelsRef.current.values()) {
            if (channel.readyState === 'open') {
                try { channel.send(frame); delivered++; } catch { /* peer dropped */ }
            }
        }
        // Echo locally regardless so the sender sees their own message immediately.
        _ingestChat(msg, true);
        return delivered > 0;
    }, [_ingestChat]);

    const leaveRoom = useCallback(() => {
        try { signalingRef.current?.leaveRoom(); } catch { /* ignore */ }
        _teardown();
        setStatus('idle'); setJoinCode(null); setRoster([]); setTopology('direct'); setMessages([]);
    }, [_teardown]);

    return { status, joinCode, roster, topology, error, messages, createRoom, joinRoom, leaveRoom, sendMessage };
}
