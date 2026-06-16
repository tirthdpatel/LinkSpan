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

export function useRoom() {
    const [status, setStatus] = useState('idle'); // idle | connecting | in-room | error
    const [joinCode, setJoinCode] = useState(null);
    const [roster, setRoster] = useState([]);
    const [topology, setTopology] = useState('direct');
    const [error, setError] = useState(null);

    const signalingRef = useRef(null);
    const roomRef = useRef(null);
    const channelsRef = useRef(new Map()); // remoteId → RTCDataChannel

    const _teardown = useCallback(() => {
        try { roomRef.current?.close(); } catch { /* ignore */ }
        try { signalingRef.current?.disconnect(); } catch { /* ignore */ }
        roomRef.current = null;
        signalingRef.current = null;
        channelsRef.current = new Map();
    }, []);

    useEffect(() => () => _teardown(), [_teardown]);

    const _buildRoom = useCallback((selfId, token, signaling) => {
        const createPeer = (remoteId) => {
            const peer = new PeerConnection({
                onIceCandidate: (candidate) =>
                    signaling.sendRoom({ type: 'ice-candidate', to: remoteId, token, payload: candidate }),
                onChannel: (channel) => { channelsRef.current.set(remoteId, channel); },
                onConnectionStateChange: () => {},
            });
            peer.init();
            // Negotiated channels are created on both sides (matches the 1:1 path).
            peer.createChannels((channel) => { channelsRef.current.set(remoteId, channel); });
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
    }, []);

    const _connect = useCallback(async () => {
        const signaling = new SignalingClient(SIGNALING_URL);
        signalingRef.current = signaling;
        signaling.on('error', (e) => { setError(e?.message || 'Signaling error'); setStatus('error'); });
        await signaling.connect();
        return signaling;
    }, []);

    const createRoom = useCallback(async (name) => {
        setStatus('connecting'); setError(null);
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
        setStatus('connecting'); setError(null);
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

    const leaveRoom = useCallback(() => {
        try { signalingRef.current?.leaveRoom(); } catch { /* ignore */ }
        _teardown();
        setStatus('idle'); setJoinCode(null); setRoster([]); setTopology('direct');
    }, [_teardown]);

    return { status, joinCode, roster, topology, error, createRoom, joinRoom, leaveRoom };
}
