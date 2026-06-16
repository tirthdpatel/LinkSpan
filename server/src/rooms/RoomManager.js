import crypto from 'node:crypto';
import { MAX_ROOM_PEERS, ROOM_TIMEOUT_MS, pickRoomTopology } from '../../../shared/constants.js';

/**
 * RoomManager — N-peer "rooms", a parallel subsystem to the strict 2-peer SessionManager
 * (which is left untouched so existing flows/tests are unaffected).
 *
 * The server is a *coordination plane* only: it owns the roster and routes signaling between
 * members. It never sees file bytes — those move peer-to-peer over WebRTC DataChannels (or
 * the existing relay fallback). Chunk availability for the swarm topology is tracked
 * separately by ChunkAvailabilityRegistry.
 *
 * Topology is derived from peer count (pickRoomTopology): 2 → direct, ≤5 → mesh, more →
 * swarm. `sendToPeer`/`broadcast` are the routing primitives; a Redis-backed subclass can
 * override them for cross-instance fan-out exactly as RedisSessionManager does for sessions.
 */
export class RoomManager {
    constructor() {
        /** @type {Map<string, Room>} roomId → room */
        this.rooms = new Map();
        /** @type {Map<string, string>} joinCode → roomId */
        this.joinCodes = new Map();
        this._startTime = Date.now();
        this._cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    }

    createRoom() {
        const roomId = crypto.randomUUID();
        const joinCode = this._generateJoinCode();
        const room = {
            roomId,
            joinCode,
            owner: null,
            peers: new Map(), // peerId → { ws, name }
            createdAt: Date.now(),
            lastActivity: Date.now(),
        };
        this.rooms.set(roomId, room);
        this.joinCodes.set(joinCode, roomId);
        return { roomId, joinCode };
    }

    /** Resolve a join code to a room that still has capacity. */
    joinByCode(joinCode) {
        const roomId = this.joinCodes.get(joinCode);
        if (!roomId) return null;
        const room = this.rooms.get(roomId);
        if (!room) return null;
        if (room.peers.size >= MAX_ROOM_PEERS) return null;
        room.lastActivity = Date.now();
        return { roomId };
    }

    addPeer(roomId, peerId, ws, name = null) {
        const room = this.rooms.get(roomId);
        if (!room) return false;
        if (room.peers.size >= MAX_ROOM_PEERS) return false;
        room.peers.set(peerId, { ws, name });
        if (!room.owner) room.owner = peerId;
        room.lastActivity = Date.now();
        return true;
    }

    removePeer(roomId, peerId) {
        const room = this.rooms.get(roomId);
        if (!room) return;
        room.peers.delete(peerId);
        room.lastActivity = Date.now();
        if (room.peers.size === 0) this.destroyRoom(roomId);
    }

    validatePeer(roomId, peerId) {
        const room = this.rooms.get(roomId);
        return Boolean(room && room.peers.has(peerId));
    }

    getRoom(roomId) {
        const room = this.rooms.get(roomId);
        if (room) room.lastActivity = Date.now();
        return room || null;
    }

    topology(roomId) {
        const room = this.rooms.get(roomId);
        return room ? pickRoomTopology(room.peers.size) : null;
    }

    /** Roster as a plain array (no ws handles). */
    roster(roomId) {
        const room = this.rooms.get(roomId);
        if (!room) return [];
        return [...room.peers.entries()].map(([peerId, p]) => ({ peerId, name: p.name || null }));
    }

    // ── Routing primitives ─────────────────────────────────────
    /** Deliver a message to one specific peer. @returns {boolean} delivered */
    sendToPeer(roomId, toPeerId, message) {
        const room = this.rooms.get(roomId);
        const peer = room && room.peers.get(toPeerId);
        if (peer && peer.ws.readyState === 1) {
            peer.ws.send(JSON.stringify(message));
            return true;
        }
        return false;
    }

    /** Deliver a message to every peer except the sender. @returns {number} recipients */
    broadcast(roomId, fromPeerId, message) {
        const room = this.rooms.get(roomId);
        if (!room) return 0;
        const raw = JSON.stringify(message);
        let n = 0;
        for (const [peerId, peer] of room.peers) {
            if (peerId === fromPeerId) continue;
            if (peer.ws.readyState === 1) { peer.ws.send(raw); n++; }
        }
        return n;
    }

    destroyRoom(roomId) {
        const room = this.rooms.get(roomId);
        if (!room) return;
        this.joinCodes.delete(room.joinCode);
        this.rooms.delete(roomId);
    }

    cleanup() {
        const now = Date.now();
        for (const [roomId, room] of this.rooms) {
            if (now - room.lastActivity > ROOM_TIMEOUT_MS) {
                for (const peer of room.peers.values()) {
                    try { peer.ws.send(JSON.stringify({ type: 'session-closed', reason: 'timeout' })); peer.ws.close(); } catch { /* gone */ }
                }
                this.destroyRoom(roomId);
            }
        }
    }

    getStats() {
        let peers = 0;
        for (const room of this.rooms.values()) peers += room.peers.size;
        return { activeRooms: this.rooms.size, roomPeers: peers };
    }

    shutdown() {
        clearInterval(this._cleanupInterval);
        for (const [roomId] of this.rooms) this.destroyRoom(roomId);
    }

    _generateJoinCode() {
        let code;
        let attempts = 0;
        do {
            code = crypto.randomInt(100000, 1000000).toString();
            if (++attempts > 1000) throw new Error('Failed to generate unique room code');
        } while (this.joinCodes.has(code));
        return code;
    }
}
