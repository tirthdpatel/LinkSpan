/**
 * ChunkAvailabilityRegistry — the swarm coordination plane (metadata only; never file bytes).
 *
 * For each room+file it tracks which peers hold which chunk indices, so a peer that needs a
 * chunk can be told who currently has it and pick a source — the BitTorrent property that
 * lets the origin stop being the sole uploader. It also answers "rarest-first": which chunks
 * are held by the fewest peers, so the swarm replicates scarce chunks first and converges.
 *
 * Two indexes are kept per file for O(1) updates and pruning:
 *   byChunk: Map<index, Set<peerId>>   — who has chunk i
 *   byPeer:  Map<peerId, Set<index>>   — what peer p has (for fast prune on disconnect)
 */
export class ChunkAvailabilityRegistry {
    constructor() {
        /** @type {Map<string, Map<string, FileAvail>>} roomId → (fileId → availability) */
        this._rooms = new Map();
    }

    _file(roomId, fileId, totalChunks) {
        let room = this._rooms.get(roomId);
        if (!room) { room = new Map(); this._rooms.set(roomId, room); }
        let file = room.get(fileId);
        if (!file) {
            file = { totalChunks: totalChunks || 0, byChunk: new Map(), byPeer: new Map() };
            room.set(fileId, file);
        } else if (totalChunks && !file.totalChunks) {
            file.totalChunks = totalChunks;
        }
        return file;
    }

    /** Register a file manifest. If `origin`, the announcing peer is recorded as holding all chunks. */
    announce(roomId, peerId, fileId, totalChunks, { origin = false } = {}) {
        const file = this._file(roomId, fileId, totalChunks);
        if (origin && totalChunks) {
            this.have(roomId, peerId, fileId, range(totalChunks));
        }
        return file.totalChunks;
    }

    /** Record that `peerId` now holds the given chunk indices of `fileId`. */
    have(roomId, peerId, fileId, indices) {
        const file = this._file(roomId, fileId);
        let pset = file.byPeer.get(peerId);
        if (!pset) { pset = new Set(); file.byPeer.set(peerId, pset); }
        for (const i of indices) {
            if (file.totalChunks && (i < 0 || i >= file.totalChunks)) continue; // ignore out-of-range
            pset.add(i);
            let cset = file.byChunk.get(i);
            if (!cset) { cset = new Set(); file.byChunk.set(i, cset); }
            cset.add(peerId);
        }
    }

    /** Peers currently holding chunk `index`, fewest-other-chunks first is not needed here —
     *  return them in stable insertion order; the requester load-balances. */
    peersFor(roomId, fileId, index) {
        const file = this._rooms.get(roomId)?.get(fileId);
        const cset = file?.byChunk.get(index);
        return cset ? [...cset] : [];
    }

    /** All chunk indices a peer is still missing, ordered rarest-first (fewest holders first). */
    rarestMissing(roomId, fileId, peerId) {
        const file = this._rooms.get(roomId)?.get(fileId);
        if (!file || !file.totalChunks) return [];
        const have = file.byPeer.get(peerId) || new Set();
        const missing = [];
        for (let i = 0; i < file.totalChunks; i++) {
            if (have.has(i)) continue;
            missing.push({ index: i, count: file.byChunk.get(i)?.size || 0 });
        }
        // Rarest first; only chunks that exist somewhere are actionable.
        return missing
            .filter((m) => m.count > 0)
            .sort((a, b) => a.count - b.count)
            .map((m) => m.index);
    }

    /** Fraction of the file that has reached full replication across the swarm (diagnostics). */
    completion(roomId, fileId) {
        const file = this._rooms.get(roomId)?.get(fileId);
        if (!file || !file.totalChunks) return 0;
        let present = 0;
        for (let i = 0; i < file.totalChunks; i++) if ((file.byChunk.get(i)?.size || 0) > 0) present++;
        return present / file.totalChunks;
    }

    /** Remove a peer from every file in a room (call on disconnect/leave). */
    prunePeer(roomId, peerId) {
        const room = this._rooms.get(roomId);
        if (!room) return;
        for (const file of room.values()) {
            const pset = file.byPeer.get(peerId);
            if (!pset) continue;
            for (const i of pset) file.byChunk.get(i)?.delete(peerId);
            file.byPeer.delete(peerId);
        }
    }

    removeRoom(roomId) { this._rooms.delete(roomId); }
}

function range(n) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = i;
    return out;
}
