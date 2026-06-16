import { describe, test, expect } from 'vitest';
import {
    chunksToRanges,
    rangesToChunks,
    validateRanges,
    TRANSFER_CAPABILITY,
} from '@shared/chunkRanges.js';

// Pure unit tests for the shared chunk-range codec. No transfer, no channel — just
// the merge/expand/validate logic that both peers (and the future swarm) reuse.

describe('chunksToRanges', () => {
    test('contiguous indices collapse into a single range', () => {
        expect(chunksToRanges([0, 1, 2, 3, 4])).toEqual([{ start: 0, count: 5 }]);
    });

    test('sparse gaps produce multiple ranges', () => {
        expect(chunksToRanges([0, 1, 2, 5, 6, 9])).toEqual([
            { start: 0, count: 3 },
            { start: 5, count: 2 },
            { start: 9, count: 1 },
        ]);
    });

    test('a single index is a count-1 range', () => {
        expect(chunksToRanges([7])).toEqual([{ start: 7, count: 1 }]);
    });

    test('empty / non-array input yields no ranges', () => {
        expect(chunksToRanges([])).toEqual([]);
        expect(chunksToRanges(null)).toEqual([]);
        expect(chunksToRanges(undefined)).toEqual([]);
    });

    test('unsorted input with duplicates is sorted + de-duped', () => {
        expect(chunksToRanges([5, 1, 0, 2, 5, 1, 6])).toEqual([
            { start: 0, count: 3 },
            { start: 5, count: 2 },
        ]);
    });

    test('negative / non-integer indices are ignored defensively', () => {
        expect(chunksToRanges([-1, 0, 1, 2.5, 3])).toEqual([
            { start: 0, count: 2 },
            { start: 3, count: 1 },
        ]);
    });
});

describe('rangesToChunks', () => {
    test('expands ranges back to a flat index list', () => {
        expect(rangesToChunks([{ start: 0, count: 3 }, { start: 5, count: 2 }]))
            .toEqual([0, 1, 2, 5, 6]);
    });

    test('round-trips chunks → ranges → chunks for sparse sets', () => {
        const indices = [0, 1, 2, 4, 7, 8, 9, 15];
        expect(rangesToChunks(chunksToRanges(indices))).toEqual(indices);
    });

    test('non-array input yields empty', () => {
        expect(rangesToChunks(null)).toEqual([]);
    });
});

describe('validateRanges', () => {
    const TOTAL = 10;

    test('accepts valid ranges and returns them normalized (sorted)', () => {
        expect(validateRanges([{ start: 5, count: 2 }, { start: 0, count: 2 }], TOTAL))
            .toEqual([{ start: 0, count: 2 }, { start: 5, count: 2 }]);
    });

    test('merges adjacent ranges during normalization', () => {
        expect(validateRanges([{ start: 0, count: 2 }, { start: 2, count: 3 }], TOTAL))
            .toEqual([{ start: 0, count: 5 }]);
    });

    test('rejects a non-array', () => {
        expect(() => validateRanges('nope', TOTAL)).toThrow(/must be an array/);
    });

    test('rejects an empty list', () => {
        expect(() => validateRanges([], TOTAL)).toThrow(/must not be empty/);
    });

    test('rejects a bad totalChunks', () => {
        expect(() => validateRanges([{ start: 0, count: 1 }], 0)).toThrow(/positive integer/);
        expect(() => validateRanges([{ start: 0, count: 1 }], -5)).toThrow(/positive integer/);
    });

    test('rejects a non-object range entry', () => {
        expect(() => validateRanges([42], TOTAL)).toThrow(/not an object/);
    });

    test('rejects a negative start', () => {
        expect(() => validateRanges([{ start: -1, count: 2 }], TOTAL)).toThrow(/start must be/);
    });

    test('rejects a non-integer start', () => {
        expect(() => validateRanges([{ start: 1.5, count: 2 }], TOTAL)).toThrow(/start must be/);
    });

    test('rejects a zero count', () => {
        expect(() => validateRanges([{ start: 0, count: 0 }], TOTAL)).toThrow(/count must be/);
    });

    test('rejects a negative count', () => {
        expect(() => validateRanges([{ start: 0, count: -3 }], TOTAL)).toThrow(/count must be/);
    });

    test('rejects an out-of-bounds range (start+count > totalChunks)', () => {
        expect(() => validateRanges([{ start: 8, count: 5 }], TOTAL)).toThrow(/exceeds totalChunks/);
    });

    test('rejects overlapping ranges', () => {
        expect(() => validateRanges([{ start: 0, count: 4 }, { start: 2, count: 3 }], TOTAL))
            .toThrow(/overlapping/);
    });
});

describe('swarm split (codec stays swarm-agnostic)', () => {
    test('disjoint index subsets produce disjoint ranges that recombine to the whole', () => {
        // SwarmScheduler will hand each peer a disjoint subset; the codec must let
        // those be requested independently and recombine exactly.
        const all = Array.from({ length: 12 }, (_, i) => i);
        const peerA = all.filter((i) => i % 2 === 0); // 0,2,4,6,8,10
        const peerB = all.filter((i) => i % 2 === 1); // 1,3,5,7,9,11

        const fromA = rangesToChunks(chunksToRanges(peerA));
        const fromB = rangesToChunks(chunksToRanges(peerB));

        expect([...fromA, ...fromB].sort((a, b) => a - b)).toEqual(all);
        expect(fromA.filter((i) => fromB.includes(i))).toEqual([]); // disjoint
    });
});

describe('TRANSFER_CAPABILITY', () => {
    test('exposes the range-request capability flag name', () => {
        expect(TRANSFER_CAPABILITY.RANGE_REQUEST).toBe('supportsRangeRequest');
    });
});
