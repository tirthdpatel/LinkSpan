/**
 * RoomConnection tests — verify the N-peer mesh signaling choreography (deterministic glare
 * avoidance, offer/answer/ice routing, roster-driven connect/disconnect) using fake peers and
 * a capturing signaling sink. No real WebRTC.
 */
import { describe, it, expect, vi } from 'vitest';
import { RoomConnection } from '../core/RoomConnection.js';

/** Flush pending microtasks + a macrotask so async offer chains settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A fake PeerConnection capturing the choreography. */
function fakePeerFactory(log) {
    return (remoteId, { initiator }) => ({
        remoteId, initiator, closed: false,
        createOffer: vi.fn(async () => ({ type: 'offer', sdp: `offer-to-${remoteId}` })),
        createAnswer: vi.fn(async () => ({ type: 'answer', sdp: `answer-to-${remoteId}` })),
        setRemoteDescription: vi.fn(async (sdp) => log.push(['setRemote', remoteId, sdp.type])),
        addIceCandidate: vi.fn(async () => log.push(['ice', remoteId])),
        close() { this.closed = true; },
    });
}

function makeConn(selfId) {
    const sent = [];
    const log = [];
    const conn = new RoomConnection({
        selfId,
        token: 'tok',
        send: (msg) => sent.push(msg),
        createPeer: fakePeerFactory(log),
    });
    return { conn, sent, log };
}

describe('RoomConnection', () => {
    it('initiates an offer only toward higher-id peers (glare avoidance)', async () => {
        // selfId 'aaa' is smaller than 'zzz' → initiator; smaller than 'bbb' too.
        const { conn, sent } = makeConn('aaa');
        conn.handleRoster({ peers: [{ peerId: 'aaa' }, { peerId: 'zzz' }], topology: 'direct' });
        await flush();

        const offers = sent.filter((m) => m.type === 'offer');
        expect(offers).toHaveLength(1);
        expect(offers[0].to).toBe('zzz');
        expect(offers[0].token).toBe('tok');
    });

    it('does NOT initiate toward lower-id peers (the other side will)', async () => {
        const { conn, sent } = makeConn('zzz');
        conn.handleRoster({ peers: [{ peerId: 'zzz' }, { peerId: 'aaa' }], topology: 'direct' });
        await flush();
        expect(sent.filter((m) => m.type === 'offer')).toHaveLength(0);
        expect(conn.peerCount).toBe(0);
    });

    it('answers an inbound offer and routes the answer back to the sender', async () => {
        const { conn, sent } = makeConn('zzz');
        await conn.handleSignal({ type: 'offer', from: 'aaa', payload: { type: 'offer', sdp: 'x' } });
        const answers = sent.filter((m) => m.type === 'answer');
        expect(answers).toHaveLength(1);
        expect(answers[0].to).toBe('aaa');
        expect(conn.peerCount).toBe(1);
    });

    it('applies an inbound answer to the matching peer', async () => {
        const { conn, log } = makeConn('aaa');
        conn.handleRoster({ peers: [{ peerId: 'aaa' }, { peerId: 'zzz' }] });
        await flush();
        await conn.handleSignal({ type: 'answer', from: 'zzz', payload: { type: 'answer', sdp: 'y' } });
        expect(log).toContainEqual(['setRemote', 'zzz', 'answer']);
    });

    it('drops peers that leave the roster', async () => {
        const { conn } = makeConn('aaa');
        conn.handleRoster({ peers: [{ peerId: 'aaa' }, { peerId: 'zzz' }] });
        await flush();
        expect(conn.peerCount).toBe(1);
        conn.handleRoster({ peers: [{ peerId: 'aaa' }] }); // zzz left
        expect(conn.peerCount).toBe(0);
    });

    it('emits swarm coordination messages with the token', () => {
        const { conn, sent } = makeConn('aaa');
        conn.announce('f1', 10, true);
        conn.haveChunks('f1', [0, 1]);
        conn.needChunk('f1', 5);
        const types = sent.map((m) => m.type);
        expect(types).toEqual(['swarm-announce', 'swarm-have', 'swarm-need']);
        expect(sent.every((m) => m.token === 'tok')).toBe(true);
        expect(sent[0].origin).toBe(true);
    });
});
