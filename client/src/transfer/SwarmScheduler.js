/**
 * SwarmScheduler — BitTorrent-style chunk scheduling for the SWARM room topology.
 *
 * Given a set of peers and what each currently holds (learned from SWARM_HAVE gossip via
 * `noteHave`), it pulls the file's chunks in parallel from multiple peers, **rarest-first**
 * (the chunk held by the fewest peers is fetched first, so scarce chunks replicate quickly
 * and the swarm converges), and re-announces each received chunk so a peer that just got a
 * chunk immediately becomes a source for it — the property that stops the origin from being
 * the sole uploader.
 *
 * Transport is fully injected (`requestChunk(peerId, index) → Promise<bytes>`,
 * `onHave(indices)` to gossip, `onChunk(index, bytes)` to store), so the scheduling
 * algorithm is testable against a simulated multi-peer mesh with no real WebRTC.
 */
export class SwarmScheduler {
    /**
     * @param {object} opts
     * @param {number} opts.totalChunks
     * @param {(peerId: string, index: number) => Promise<any>} opts.requestChunk
     * @param {(index: number, bytes: any) => void} [opts.onChunk]
     * @param {(indices: number[]) => void} [opts.onHave]    gossip newly-held chunk(s)
     * @param {(index: number) => void} [opts.onProgress]
     * @param {number} [opts.maxParallel]
     * @param {number} [opts.maxAttemptsPerChunk]
     */
    constructor({ totalChunks, requestChunk, onChunk, onHave, onProgress, maxParallel = 4, maxAttemptsPerChunk = 5 }) {
        this.totalChunks = totalChunks;
        this._requestChunk = requestChunk;
        this._onChunk = onChunk || (() => {});
        this._onHave = onHave || (() => {});
        this._onProgress = onProgress || (() => {});
        this._maxParallel = maxParallel;
        this._maxAttempts = maxAttemptsPerChunk;

        this.have = new Set();                 // indices we hold
        this._availability = new Map();        // peerId → Set<index> they hold
        this._inFlight = new Map();            // index → peerId currently fetching it
        this._peerLoad = new Map();            // peerId → in-flight count (load balancing)
        this._attempts = new Map();            // index → attempts so far
        this._donePromise = null;
        this._resolveDone = null;
        this._failed = false;
    }

    /** Record that a peer holds the given chunk indices (from SWARM_HAVE / SWARM_PEERS). */
    noteHave(peerId, indices) {
        let set = this._availability.get(peerId);
        if (!set) { set = new Set(); this._availability.set(peerId, set); }
        for (const i of indices) set.add(i);
        if (this._resolveDone) this._pump();
    }

    /** Drop a peer that left/failed; its chunks are no longer sourced from it. */
    removePeer(peerId) {
        this._availability.delete(peerId);
        this._peerLoad.delete(peerId);
    }

    /** Begin scheduling. Resolves when every chunk is held; rejects if a chunk is unfetchable. */
    start() {
        if (!this._donePromise) {
            this._donePromise = new Promise((resolve, reject) => {
                this._resolveDone = resolve;
                this._rejectDone = reject;
            });
            this._pump();
        }
        return this._donePromise;
    }

    get progress() { return this.totalChunks ? this.have.size / this.totalChunks : 1; }

    // ── Scheduling core ────────────────────────────────────────
    _holdersOf(index) {
        const holders = [];
        for (const [peerId, set] of this._availability) if (set.has(index)) holders.push(peerId);
        return holders;
    }

    /** Missing, not-in-flight chunks that some peer holds, ordered rarest-first. */
    _rarestActionable() {
        const candidates = [];
        for (let i = 0; i < this.totalChunks; i++) {
            if (this.have.has(i) || this._inFlight.has(i)) continue;
            const count = this._holdersOf(i).length;
            if (count > 0) candidates.push({ index: i, count });
        }
        candidates.sort((a, b) => (a.count - b.count) || (a.index - b.index));
        return candidates;
    }

    /** Pick the least-loaded holder of a chunk (balances load across sources). */
    _pickPeer(index) {
        const holders = this._holdersOf(index);
        let best = null; let bestLoad = Infinity;
        for (const p of holders) {
            const load = this._peerLoad.get(p) || 0;
            if (load < bestLoad) { best = p; bestLoad = load; }
        }
        return best;
    }

    _pump() {
        if (this._failed) return;
        if (this.have.size === this.totalChunks) { this._finish(); return; }

        const rarest = this._rarestActionable();
        for (const { index } of rarest) {
            if (this._inFlight.size >= this._maxParallel) break;
            if (this._inFlight.has(index)) continue;
            const peerId = this._pickPeer(index);
            if (!peerId) continue;
            this._fetch(peerId, index);
        }
    }

    _fetch(peerId, index) {
        this._inFlight.set(index, peerId);
        this._peerLoad.set(peerId, (this._peerLoad.get(peerId) || 0) + 1);

        Promise.resolve()
            .then(() => this._requestChunk(peerId, index))
            .then((bytes) => {
                this._release(peerId, index);
                if (this.have.has(index)) return; // raced; ignore duplicate
                this.have.add(index);
                this._onChunk(index, bytes);
                this._onProgress(index);
                // We are now a source for this chunk — gossip it so others can pull from us.
                this._onHave([index]);
                this._pump();
            })
            .catch(() => {
                this._release(peerId, index);
                // That peer failed for this chunk; don't try it again for this index.
                this._availability.get(peerId)?.delete(index);
                const n = (this._attempts.get(index) || 0) + 1;
                this._attempts.set(index, n);
                if (n >= this._maxAttempts && this._holdersOf(index).length === 0) {
                    this._fail(new Error(`Chunk ${index} unfetchable after ${n} attempts`));
                    return;
                }
                this._pump();
            });
    }

    _release(peerId, index) {
        this._inFlight.delete(index);
        const load = (this._peerLoad.get(peerId) || 1) - 1;
        this._peerLoad.set(peerId, Math.max(0, load));
    }

    _finish() {
        if (this._resolveDone) { this._resolveDone(); this._resolveDone = null; }
    }

    _fail(err) {
        this._failed = true;
        if (this._rejectDone) { this._rejectDone(err); this._rejectDone = null; this._resolveDone = null; }
    }
}
