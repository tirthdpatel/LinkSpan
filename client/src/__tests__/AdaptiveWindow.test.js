import { describe, test, expect } from 'vitest';
import { Receiver } from '../transfer/Receiver.js';
import { MAX_IN_FLIGHT, MAX_IN_FLIGHT_CAP } from '@shared/constants.js';

// Unit tests for the adaptive pull window (Phase 4): the window tracks the measured
// bandwidth-delay product, clamped to [MAX_IN_FLIGHT, MAX_IN_FLIGHT_CAP].

const CHUNK = 256 * 1024;

function makeReceiver() {
    // The constructor only stores its dependencies; window logic needs no start().
    return new Receiver(
        { fileId: 'f', totalChunks: 1000, chunkSize: CHUNK },
        /* channelManager */ {},
        /* storageManager */ {},
        /* resumeManager */ {},
        () => {}, () => {}, () => {}
    );
}

describe('Receiver adaptive window', () => {
    test('starts at the fixed MAX_IN_FLIGHT floor', () => {
        expect(makeReceiver()._window).toBe(MAX_IN_FLIGHT);
    });

    test('stays at the floor without an RTT sample or throughput', () => {
        const r = makeReceiver();
        r._updateWindow(0);
        expect(r._window).toBe(MAX_IN_FLIGHT);
        r._rttEwma = null;
        r._updateWindow(10_000_000);
        expect(r._window).toBe(MAX_IN_FLIGHT);
    });

    test('slow/short paths never shrink below the floor', () => {
        const r = makeReceiver();
        r._rttEwma = 10; // 10 ms LAN
        r._updateWindow(1_000_000); // 1 MB/s → BDP ≪ floor
        expect(r._window).toBe(MAX_IN_FLIGHT);
    });

    test('grows to ~1.5× the measured BDP on a long fat pipe', () => {
        const r = makeReceiver();
        r._rttEwma = 200; // cross-continent
        const bytesPerSec = 30_000_000; // 240 Mbps — BDP 6 MB ≈ 23 chunks
        r._updateWindow(bytesPerSec);
        const expected = Math.ceil(((bytesPerSec * 0.2) / CHUNK) * 1.5);
        expect(r._window).toBe(expected);
        expect(r._window).toBeGreaterThan(MAX_IN_FLIGHT);
        expect(r._window).toBeLessThan(MAX_IN_FLIGHT_CAP);
    });

    test('is capped at MAX_IN_FLIGHT_CAP however large the BDP', () => {
        const r = makeReceiver();
        r._rttEwma = 500;
        r._updateWindow(1_000_000_000); // 8 Gbps × 500 ms
        expect(r._window).toBe(MAX_IN_FLIGHT_CAP);
    });

    test('RTT samples feed an EWMA on chunk arrival', () => {
        const r = makeReceiver();
        r._requestedAt.set(7, Date.now() - 100);
        // Simulate just the sampling part of _handleChunkData:
        const requestedAt = r._requestedAt.get(7);
        r._requestedAt.delete(7);
        const sample = Date.now() - requestedAt;
        r._rttEwma = r._rttEwma === null ? sample : 0.8 * r._rttEwma + 0.2 * sample;
        expect(r._rttEwma).toBeGreaterThanOrEqual(100);
        expect(r._requestedAt.has(7)).toBe(false);
    });
});
