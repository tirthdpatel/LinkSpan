import { describe, test, expect } from 'vitest';
import { PeerConnection } from '../core/PeerConnection.js';
import { MAX_CHANNELS, primaryChannelConfig } from '@shared/constants.js';

// Channel 0 carries FILE_META and must stay ordered; every other primary channel
// only carries chunks, so it is unordered to avoid head-of-line blocking.

function peerWithFakePc() {
    const peer = new PeerConnection({}, []);
    peer.pc = { createDataChannel: (label, opts) => ({ label, ...opts }) };
    return peer;
}

describe('primary channel config', () => {
    test('channel 0 is ordered, the rest are unordered', () => {
        const peer = peerWithFakePc();
        peer.createChannels(() => {}, MAX_CHANNELS, primaryChannelConfig);

        expect(peer.channels).toHaveLength(MAX_CHANNELS);
        expect(peer.channels[0].ordered).toBe(true);
        for (const ch of peer.channels.slice(1)) expect(ch.ordered).toBe(false);
        // Negotiated ids still match the index on both sides.
        peer.channels.forEach((ch, i) => {
            expect(ch.id).toBe(i);
            expect(ch.negotiated).toBe(true);
        });
    });

    test('a plain config object still applies to every channel', () => {
        const peer = peerWithFakePc();
        peer.createChannels(() => {}, 2, { ordered: false });
        expect(peer.channels.map((c) => c.ordered)).toEqual([false, false]);
    });
});
