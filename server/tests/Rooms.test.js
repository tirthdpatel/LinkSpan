/**
 * Group-room coordination plane: RoomManager (roster, topology, routing, lifecycle) and
 * ChunkAvailabilityRegistry (swarm chunk tracking + rarest-first + pruning).
 *
 * Pure in-memory with fake WebSockets (a capturing `send`). Run: node --test tests/
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { RoomManager } from '../src/rooms/RoomManager.js';
import { ChunkAvailabilityRegistry } from '../src/rooms/ChunkAvailabilityRegistry.js';
import { ROOM_TOPOLOGY } from '../../shared/constants.js';

function fakeWs() {
    const sent = [];
    return { readyState: 1, sent, send: (s) => sent.push(JSON.parse(s)) };
}

describe('RoomManager', () => {
    let mgr;
    afterEach(() => mgr?.shutdown());

    it('creates a room, joins by code, and reports the roster', () => {
        mgr = new RoomManager();
        const { roomId, joinCode } = mgr.createRoom();
        assert.ok(roomId && /^\d{6}$/.test(joinCode));
        mgr.addPeer(roomId, 'p1', fakeWs(), 'Alice');

        const join = mgr.joinByCode(joinCode);
        assert.equal(join.roomId, roomId);
        mgr.addPeer(roomId, 'p2', fakeWs(), 'Bob');

        const roster = mgr.roster(roomId);
        assert.deepEqual(roster.map((r) => r.name).sort(), ['Alice', 'Bob']);
    });

    it('derives topology from peer count', () => {
        mgr = new RoomManager();
        const { roomId } = mgr.createRoom();
        mgr.addPeer(roomId, 'a', fakeWs());
        mgr.addPeer(roomId, 'b', fakeWs());
        assert.equal(mgr.topology(roomId), ROOM_TOPOLOGY.DIRECT); // 2
        mgr.addPeer(roomId, 'c', fakeWs());
        assert.equal(mgr.topology(roomId), ROOM_TOPOLOGY.MESH);   // 3
        for (const p of ['d', 'e', 'f']) mgr.addPeer(roomId, p, fakeWs());
        assert.equal(mgr.topology(roomId), ROOM_TOPOLOGY.SWARM);  // 6 > threshold
    });

    it('routes to one peer and broadcasts to the rest', () => {
        mgr = new RoomManager();
        const { roomId } = mgr.createRoom();
        const a = fakeWs(); const b = fakeWs(); const c = fakeWs();
        mgr.addPeer(roomId, 'a', a); mgr.addPeer(roomId, 'b', b); mgr.addPeer(roomId, 'c', c);

        assert.equal(mgr.sendToPeer(roomId, 'b', { type: 'x' }), true);
        assert.equal(b.sent.length, 1);
        assert.equal(a.sent.length, 0);

        const n = mgr.broadcast(roomId, 'a', { type: 'y' });
        assert.equal(n, 2);              // everyone except sender 'a'
        assert.equal(a.sent.length, 0);
        assert.equal(b.sent.length, 2);
        assert.equal(c.sent.length, 1);
    });

    it('destroys an empty room and enforces the peer ceiling', () => {
        mgr = new RoomManager();
        const { roomId, joinCode } = mgr.createRoom();
        mgr.addPeer(roomId, 'a', fakeWs());
        mgr.removePeer(roomId, 'a');
        assert.equal(mgr.getRoom(roomId), null, 'empty room reclaimed');
        assert.equal(mgr.joinByCode(joinCode), null, 'join code released');
    });

    it('validatePeer reflects membership', () => {
        mgr = new RoomManager();
        const { roomId } = mgr.createRoom();
        mgr.addPeer(roomId, 'a', fakeWs());
        assert.equal(mgr.validatePeer(roomId, 'a'), true);
        assert.equal(mgr.validatePeer(roomId, 'ghost'), false);
    });
});

describe('ChunkAvailabilityRegistry', () => {
    it('origin announce makes the origin hold all chunks', () => {
        const reg = new ChunkAvailabilityRegistry();
        reg.announce('r', 'origin', 'f1', 4, { origin: true });
        assert.deepEqual(reg.peersFor('r', 'f1', 0), ['origin']);
        assert.deepEqual(reg.peersFor('r', 'f1', 3), ['origin']);
    });

    it('tracks have() and answers peersFor()', () => {
        const reg = new ChunkAvailabilityRegistry();
        reg.announce('r', 'origin', 'f1', 3, { origin: true });
        reg.have('r', 'peerB', 'f1', [0, 2]);
        assert.deepEqual(reg.peersFor('r', 'f1', 0).sort(), ['origin', 'peerB']);
        assert.deepEqual(reg.peersFor('r', 'f1', 1), ['origin']);
    });

    it('rarestMissing orders a peer\'s missing chunks fewest-holders-first', () => {
        const reg = new ChunkAvailabilityRegistry();
        reg.announce('r', 'o', 'f1', 3, { origin: true }); // o has 0,1,2
        reg.have('r', 'x', 'f1', [1]);                     // chunk1 held by o,x (count 2)
        reg.have('r', 'y', 'f1', [1, 2]);                  // chunk2 held by o,y (count 2); chunk1 o,x,y (3)
        // Peer 'newbie' has nothing → missing 0,1,2. Counts: 0→1, 2→2, 1→3. Rarest = [0,2,1].
        assert.deepEqual(reg.rarestMissing('r', 'f1', 'newbie'), [0, 2, 1]);
    });

    it('prunePeer removes a disconnected peer from all chunks', () => {
        const reg = new ChunkAvailabilityRegistry();
        reg.announce('r', 'o', 'f1', 2, { origin: true });
        reg.have('r', 'b', 'f1', [0, 1]);
        reg.prunePeer('r', 'b');
        assert.deepEqual(reg.peersFor('r', 'f1', 0), ['o']);
        assert.deepEqual(reg.peersFor('r', 'f1', 1), ['o']);
    });

    it('reports swarm completion', () => {
        const reg = new ChunkAvailabilityRegistry();
        reg.announce('r', 'o', 'f1', 4);
        reg.have('r', 'o', 'f1', [0, 1]);
        assert.equal(reg.completion('r', 'f1'), 0.5);
    });
});
