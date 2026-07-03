import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { MultiConnection } from '../core/MultiConnection.js';
import { EXTRA_PEER_CONNECTIONS, SECONDARY_PC_CHANNELS } from '@shared/constants.js';

// Unit tests for secondary-connection negotiation: pcIndex tagging of SDP/ICE
// payloads, capability clamping, early-candidate buffering, and teardown — over a
// fake WebRTC surface (Node has no RTCPeerConnection).

class FakeRTCPeerConnection {
    static instances = [];
    constructor(config) {
        this.config = config;
        this.localDescription = null;
        this.remoteDescription = null;
        this.dataChannels = [];
        this.addedCandidates = [];
        this.closed = false;
        this.connectionState = 'new';
        FakeRTCPeerConnection.instances.push(this);
    }
    createDataChannel(label, opts) {
        const ch = {
            label,
            id: opts?.id,
            readyState: 'connecting',
            bufferedAmount: 0,
            close() { this.readyState = 'closed'; },
            addEventListener() {},
        };
        this.dataChannels.push(ch);
        return ch;
    }
    async createOffer() { return { type: 'offer', sdp: 'v=0 fake-offer' }; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0 fake-answer' }; }
    async setLocalDescription(d) {
        this.localDescription = { ...d, toJSON: () => ({ type: d.type, sdp: d.sdp }) };
    }
    async setRemoteDescription(d) { this.remoteDescription = d; }
    async addIceCandidate(c) { this.addedCandidates.push(c); }
    async getStats() { return new Map(); }
    close() { this.closed = true; }
}

function makeFakeSignaling() {
    return {
        offers: [],
        answers: [],
        candidates: [],
        sendOffer(p) { this.offers.push(p); },
        sendAnswer(p) { this.answers.push(p); },
        sendIceCandidate(p) { this.candidates.push(p); },
    };
}

function makeFakeChannelManager() {
    return {
        added: [],
        addChannels(chs) { this.added.push(...chs); },
    };
}

let signaling, channelManager, multi;

beforeEach(() => {
    FakeRTCPeerConnection.instances = [];
    globalThis.RTCPeerConnection = FakeRTCPeerConnection;
    globalThis.RTCSessionDescription = class { constructor(init) { Object.assign(this, init); } };
    globalThis.RTCIceCandidate = class { constructor(init) { Object.assign(this, init); } };
    signaling = makeFakeSignaling();
    channelManager = makeFakeChannelManager();
    multi = new MultiConnection({ signaling, channelManager, iceServers: [] });
});

afterEach(() => {
    multi.close();
    delete globalThis.RTCPeerConnection;
    delete globalThis.RTCSessionDescription;
    delete globalThis.RTCIceCandidate;
});

describe('MultiConnection.negotiatedCount', () => {
    test('clamps the remote advertisement to our own maximum', () => {
        expect(MultiConnection.negotiatedCount(99)).toBe(EXTRA_PEER_CONNECTIONS);
        expect(MultiConnection.negotiatedCount(1)).toBe(1);
    });
    test('treats missing/hostile values as unsupported', () => {
        expect(MultiConnection.negotiatedCount(undefined)).toBe(0);
        expect(MultiConnection.negotiatedCount(null)).toBe(0);
        expect(MultiConnection.negotiatedCount('3')).toBe(0);
        expect(MultiConnection.negotiatedCount(-2)).toBe(0);
        expect(MultiConnection.negotiatedCount(1.5)).toBe(0);
    });
});

describe('MultiConnection.isSecondaryPayload', () => {
    test('detects pcIndex-tagged payloads only', () => {
        expect(MultiConnection.isSecondaryPayload({ type: 'offer', sdp: 'x', pcIndex: 1 })).toBe(true);
        expect(MultiConnection.isSecondaryPayload({ type: 'offer', sdp: 'x' })).toBe(false);
        expect(MultiConnection.isSecondaryPayload(null)).toBe(false);
        expect(MultiConnection.isSecondaryPayload({ candidate: null })).toBe(false);
    });
});

describe('sender side', () => {
    test('openSecondaries sends one pcIndex-tagged offer per secondary and pools the channels', async () => {
        await multi.openSecondaries(2);

        expect(signaling.offers.map((o) => o.pcIndex)).toEqual([1, 2]);
        for (const offer of signaling.offers) {
            expect(offer.type).toBe('offer');
            expect(typeof offer.sdp).toBe('string');
        }
        expect(FakeRTCPeerConnection.instances).toHaveLength(2);
        expect(channelManager.added).toHaveLength(2 * SECONDARY_PC_CHANNELS);
    });

    test('outgoing ICE candidates are tagged with their pcIndex', async () => {
        await multi.openSecondaries(1);
        const pc = FakeRTCPeerConnection.instances[0];
        pc.onicecandidate({ candidate: { toJSON: () => ({ candidate: 'c1', sdpMid: '0' }) } });
        expect(signaling.candidates).toEqual([{ candidate: 'c1', sdpMid: '0', pcIndex: 1 }]);
    });

    test('handleAnswer applies the remote description to the matching secondary', async () => {
        await multi.openSecondaries(2);
        await multi.handleAnswer({ type: 'answer', sdp: 'v=0 remote', pcIndex: 2 });
        expect(FakeRTCPeerConnection.instances[1].remoteDescription.sdp).toBe('v=0 remote');
        expect(FakeRTCPeerConnection.instances[0].remoteDescription).toBeNull();
    });
});

describe('receiver side', () => {
    test('handleOffer creates the secondary, pools channels, and answers with pcIndex', async () => {
        await multi.handleOffer({ type: 'offer', sdp: 'v=0 remote-offer', pcIndex: 1 });

        expect(FakeRTCPeerConnection.instances).toHaveLength(1);
        expect(FakeRTCPeerConnection.instances[0].remoteDescription.sdp).toBe('v=0 remote-offer');
        expect(channelManager.added).toHaveLength(SECONDARY_PC_CHANNELS);
        expect(signaling.answers).toHaveLength(1);
        expect(signaling.answers[0].pcIndex).toBe(1);
        expect(signaling.answers[0].type).toBe('answer');
    });

    test('rejects out-of-range or malformed pcIndex offers', async () => {
        await multi.handleOffer({ type: 'offer', sdp: 'x', pcIndex: 0 });
        await multi.handleOffer({ type: 'offer', sdp: 'x', pcIndex: EXTRA_PEER_CONNECTIONS + 1 });
        await multi.handleOffer({ type: 'offer', sdp: 'x', pcIndex: 'evil' });
        expect(FakeRTCPeerConnection.instances).toHaveLength(0);
        expect(signaling.answers).toHaveLength(0);
    });

    test('a re-offer for an existing secondary (ICE restart) renegotiates without new channels', async () => {
        await multi.handleOffer({ type: 'offer', sdp: 'v=0 first', pcIndex: 1 });
        await multi.handleOffer({ type: 'offer', sdp: 'v=0 restart', pcIndex: 1 });

        expect(FakeRTCPeerConnection.instances).toHaveLength(1);
        expect(FakeRTCPeerConnection.instances[0].remoteDescription.sdp).toBe('v=0 restart');
        expect(channelManager.added).toHaveLength(SECONDARY_PC_CHANNELS); // not doubled
        expect(signaling.answers).toHaveLength(2);
    });
});

describe('ICE candidate routing', () => {
    test('buffers candidates that arrive before the secondary exists, then flushes on offer', async () => {
        await multi.handleCandidate({ candidate: 'early-1', sdpMid: '0', pcIndex: 1 });
        await multi.handleCandidate({ candidate: 'early-2', sdpMid: '0', pcIndex: 1 });
        expect(FakeRTCPeerConnection.instances).toHaveLength(0);

        await multi.handleOffer({ type: 'offer', sdp: 'v=0 o', pcIndex: 1 });
        const pc = FakeRTCPeerConnection.instances[0];
        expect(pc.addedCandidates.map((c) => c.candidate)).toEqual(['early-1', 'early-2']);
        // The pcIndex routing tag must not leak into the RTCIceCandidate.
        expect(pc.addedCandidates[0].pcIndex).toBeUndefined();
    });

    test('delivers candidates directly once the remote description is set', async () => {
        await multi.handleOffer({ type: 'offer', sdp: 'v=0 o', pcIndex: 1 });
        await multi.handleCandidate({ candidate: 'late', sdpMid: '0', pcIndex: 1 });
        expect(FakeRTCPeerConnection.instances[0].addedCandidates.map((c) => c.candidate)).toContain('late');
    });

    test('drops candidates with invalid pcIndex', async () => {
        await multi.handleCandidate({ candidate: 'x', pcIndex: 99 });
        await multi.handleOffer({ type: 'offer', sdp: 'v=0 o', pcIndex: 1 });
        expect(FakeRTCPeerConnection.instances[0].addedCandidates).toHaveLength(0);
    });
});

describe('lifecycle', () => {
    test('close() closes every secondary and further negotiation is ignored', async () => {
        await multi.openSecondaries(2);
        multi.close();
        expect(FakeRTCPeerConnection.instances.every((pc) => pc.closed)).toBe(true);

        await multi.handleOffer({ type: 'offer', sdp: 'x', pcIndex: 1 });
        expect(FakeRTCPeerConnection.instances).toHaveLength(2); // no new PCs
    });
});
