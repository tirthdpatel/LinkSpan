/**
 * SwarmScheduler tests — exercise the rarest-first, multi-source chunk scheduling against a
 * simulated peer mesh (no real WebRTC). Proves: (1) a peer reconstructs a file byte-exact by
 * pulling from multiple sources, (2) received chunks are re-announced so a peer becomes a
 * source for others, and (3) rarest chunks are fetched first.
 */
import { describe, it, expect } from 'vitest';
import { SwarmScheduler } from '../transfer/SwarmScheduler.js';

/** A simulated swarm: each peer holds a set of chunk indices of a shared file. */
function makeWorld(totalChunks) {
    const fileBytes = Array.from({ length: totalChunks }, (_, i) => 100 + i); // distinct per chunk
    const held = new Map(); // peerId → Set<index>
    const give = (peerId, indices) => {
        if (!held.has(peerId)) held.set(peerId, new Set());
        for (const i of indices) held.get(peerId).add(i);
    };
    const requestChunk = async (peerId, index) => {
        if (!held.get(peerId)?.has(index)) throw new Error(`peer ${peerId} lacks chunk ${index}`);
        return fileBytes[index];
    };
    return { fileBytes, held, give, requestChunk, all: Array.from({ length: totalChunks }, (_, i) => i) };
}

describe('SwarmScheduler', () => {
    it('reconstructs a file byte-exact by pulling from multiple peers', async () => {
        const total = 12;
        const world = makeWorld(total);
        world.give('origin', world.all);
        world.give('seedB', [0, 1, 2, 3, 4, 5]); // a partial seed for half the file

        const received = new Map();
        const usedSources = new Set();
        const sched = new SwarmScheduler({
            totalChunks: total,
            maxParallel: 3,
            requestChunk: async (peerId, index) => {
                usedSources.add(peerId);
                return world.requestChunk(peerId, index);
            },
            onChunk: (index, bytes) => received.set(index, bytes),
        });
        sched.noteHave('origin', world.all);
        sched.noteHave('seedB', [0, 1, 2, 3, 4, 5]);

        await sched.start();

        // Every chunk present and byte-exact.
        expect(received.size).toBe(total);
        for (let i = 0; i < total; i++) expect(received.get(i)).toBe(world.fileBytes[i]);
        // Pulled from more than just the origin (swarm sourcing, load-balanced).
        expect(usedSources.has('seedB')).toBe(true);
        expect(usedSources.size).toBeGreaterThan(1);
    });

    it('re-announces received chunks so a later peer can source from a downloader', async () => {
        const total = 6;
        const world = makeWorld(total);
        world.give('origin', world.all);

        // Peer B downloads fully from origin, announcing HAVE as it goes.
        const bHave = [];
        const b = new SwarmScheduler({
            totalChunks: total,
            maxParallel: 2,
            requestChunk: world.requestChunk,
            onChunk: (i) => world.give('B', [i]),   // B now physically holds chunk i
            onHave: (indices) => bHave.push(...indices),
        });
        b.noteHave('origin', world.all);
        await b.start();
        expect(bHave.sort((x, y) => x - y)).toEqual(world.all);

        // Peer C can now pull EXCLUSIVELY from B (origin not offered to C), proving the
        // downloader became a usable source.
        const cReceived = new Map();
        const c = new SwarmScheduler({
            totalChunks: total,
            requestChunk: world.requestChunk,
            onChunk: (i, bytes) => cReceived.set(i, bytes),
        });
        c.noteHave('B', bHave); // C only knows about B
        await c.start();
        for (let i = 0; i < total; i++) expect(cReceived.get(i)).toBe(world.fileBytes[i]);
    });

    it('fetches rarest chunks first', async () => {
        const total = 4;
        const world = makeWorld(total);
        // Craft availability so holder-counts are: chunk2→1, chunk0→2, chunk3→2, chunk1→3.
        world.give('p1', [0, 1, 2, 3]);
        world.give('p2', [0, 1, 3]);
        world.give('p3', [1]);

        const order = [];
        const sched = new SwarmScheduler({
            totalChunks: total,
            maxParallel: 1, // serialize so the request order is deterministic
            requestChunk: async (peerId, index) => { order.push(index); return world.requestChunk(peerId, index); },
        });
        sched.noteHave('p1', [0, 1, 2, 3]);
        sched.noteHave('p2', [0, 1, 3]);
        sched.noteHave('p3', [1]);
        await sched.start();

        // Rarest-first: 2 (count1), then 0 or 3 (count2), then the rest, 1 (count3) last.
        expect(order[0]).toBe(2);
        expect(order[order.length - 1]).toBe(1);
    });
});
