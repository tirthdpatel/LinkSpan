import { describe, test, expect } from 'vitest';
import {
    initialWindowForRtt,
    pickChunkSize,
    MAX_IN_FLIGHT,
    DEFAULT_CHUNK_SIZE,
    GCM_OVERHEAD_BYTES,
    CHUNK_HEADER_BYTES,
} from '@shared/constants.js';

const MB = 1024 * 1024;
const MAX_PLAINTEXT = DEFAULT_CHUNK_SIZE - GCM_OVERHEAD_BYTES - CHUNK_HEADER_BYTES;

describe('initialWindowForRtt', () => {
    test('returns default for LAN / unknown RTT', () => {
        expect(initialWindowForRtt(0)).toBe(MAX_IN_FLIGHT);
        expect(initialWindowForRtt(-1)).toBe(MAX_IN_FLIGHT);
        expect(initialWindowForRtt(NaN)).toBe(MAX_IN_FLIGHT);
        expect(initialWindowForRtt(undefined)).toBe(MAX_IN_FLIGHT);
        expect(initialWindowForRtt(5)).toBe(MAX_IN_FLIGHT);
        expect(initialWindowForRtt(40)).toBe(MAX_IN_FLIGHT);
    });

    test('scales up for moderate RTT (40-100ms)', () => {
        expect(initialWindowForRtt(41)).toBe(32);
        expect(initialWindowForRtt(80)).toBe(32);
        expect(initialWindowForRtt(100)).toBe(32);
    });

    test('scales up for cross-region RTT (100-200ms)', () => {
        expect(initialWindowForRtt(101)).toBe(64);
        expect(initialWindowForRtt(150)).toBe(64);
        expect(initialWindowForRtt(200)).toBe(64);
    });

    test('uses maximum for intercontinental RTT (>200ms)', () => {
        expect(initialWindowForRtt(201)).toBe(128);
        expect(initialWindowForRtt(300)).toBe(128);
        expect(initialWindowForRtt(500)).toBe(128);
    });

    test('window sizes are in strictly increasing order', () => {
        const lan = initialWindowForRtt(5);
        const moderate = initialWindowForRtt(50);
        const crossRegion = initialWindowForRtt(150);
        const intercontinental = initialWindowForRtt(250);
        expect(moderate).toBeGreaterThan(lan);
        expect(crossRegion).toBeGreaterThan(moderate);
        expect(intercontinental).toBeGreaterThan(crossRegion);
    });
});

describe('pickChunkSize with RTT parameter', () => {
    test('backwards compatible: no rttMs behaves identically to before', () => {
        // Small file → 64 KB regardless of RTT
        expect(pickChunkSize(200 * 1024)).toBe(64 * 1024);
        // Medium file → ~256 KB (default behavior)
        expect(pickChunkSize(10 * MB)).toBe(Math.min(256 * 1024, MAX_PLAINTEXT));
        // Large file → max
        expect(pickChunkSize(5 * 1024 * MB)).toBe(MAX_PLAINTEXT);
    });

    test('high RTT upgrades medium files to max chunk size', () => {
        // 10 MB file: normally uses 256 KB-ish chunks, but at 200ms RTT uses max
        const defaultSize = pickChunkSize(10 * MB, true, 0);
        const highRttSize = pickChunkSize(10 * MB, true, 200);
        expect(highRttSize).toBe(MAX_PLAINTEXT);
        expect(highRttSize).toBeGreaterThanOrEqual(defaultSize);
    });

    test('small files remain 64 KB even on high-RTT paths', () => {
        // Progress granularity matters more than round-trip savings for tiny files
        expect(pickChunkSize(200 * 1024, true, 200)).toBe(64 * 1024);
        expect(pickChunkSize(500 * 1024, true, 300)).toBe(64 * 1024);
    });

    test('RTT <= 100ms does not affect medium file chunking', () => {
        const defaultSize = pickChunkSize(10 * MB, true, 0);
        const lowRttSize = pickChunkSize(10 * MB, true, 50);
        expect(lowRttSize).toBe(defaultSize);
    });

    test('framed ciphertext stays within 256 KB limit at all RTT values', () => {
        const rtts = [0, 50, 100, 200, 500];
        const sizes = [1024, MB, 10 * MB, 100 * MB, 1024 * MB];
        for (const rtt of rtts) {
            for (const s of sizes) {
                const plaintext = pickChunkSize(s, true, rtt);
                const framed = CHUNK_HEADER_BYTES + GCM_OVERHEAD_BYTES + plaintext;
                expect(framed).toBeLessThanOrEqual(DEFAULT_CHUNK_SIZE);
                expect(plaintext).toBeGreaterThan(0);
            }
        }
    });
});
