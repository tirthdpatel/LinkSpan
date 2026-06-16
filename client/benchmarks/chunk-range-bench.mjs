/**
 * chunk-range-bench.mjs — Control-frame overhead of range-list chunk requests
 * (CHUNK_REQUEST_RANGE, proto 1.7.0) vs the per-chunk CHUNK_REQUEST baseline.
 *
 * The request side is the only thing that changes, so the metric that matters is how
 * many control frames (and how many control bytes) the receiver puts on the wire to
 * pull a transfer. Chunk-data responses are identical in both modes and excluded.
 *
 * Run:  node client/benchmarks/chunk-range-bench.mjs
 * (Standalone — the codec has no bundler-alias imports.)
 */
import { chunksToRanges } from '../../shared/chunkRanges.js';

const MAX_IN_FLIGHT = 7; // mirrors shared/constants.js
const CHUNK_SIZE = 262112; // ~256 KB plaintext (encrypted ceiling)

function perChunkFrame(index) {
    return JSON.stringify({ type: 'chunk-request', index });
}
function rangeFrame(ranges) {
    return JSON.stringify({ type: 'chunk-request-range', ranges });
}

/**
 * Simulate the receiver's windowed pull (MAX_IN_FLIGHT chunks per refill) over a set
 * of missing indices, counting frames + bytes for each mode.
 */
function simulate(missing) {
    let perChunkFrames = 0, perChunkBytes = 0;
    let rangeFrames = 0, rangeBytes = 0;

    for (let i = 0; i < missing.length; i += MAX_IN_FLIGHT) {
        const window = missing.slice(i, i + MAX_IN_FLIGHT);

        for (const idx of window) {
            perChunkFrames++;
            perChunkBytes += Buffer.byteLength(perChunkFrame(idx));
        }

        const ranges = chunksToRanges(window);
        rangeFrames++;
        rangeBytes += Buffer.byteLength(rangeFrame(ranges));
    }

    return { perChunkFrames, perChunkBytes, rangeFrames, rangeBytes };
}

function pct(base, now) { return ((1 - now / base) * 100).toFixed(1); }

function report(label, missing) {
    const r = simulate(missing);
    console.log(`\n${label}  (${missing.length} chunks to pull)`);
    console.log(`  per-chunk : ${r.perChunkFrames.toLocaleString()} frames, ` +
        `${r.perChunkBytes.toLocaleString()} bytes`);
    console.log(`  range     : ${r.rangeFrames.toLocaleString()} frames, ` +
        `${r.rangeBytes.toLocaleString()} bytes`);
    console.log(`  reduction : ${pct(r.perChunkFrames, r.rangeFrames)}% fewer frames, ` +
        `${pct(r.perChunkBytes, r.rangeBytes)}% fewer request bytes`);
}

function main() {
    for (const gb of [1, 10, 100]) {
        const bytes = gb * 1024 ** 3;
        const total = Math.ceil(bytes / CHUNK_SIZE);
        const contiguous = Array.from({ length: total }, (_, i) => i);
        report(`${gb} GB contiguous`, contiguous);
    }

    // Sparse case: a post-reload resume where half the chunks are already present.
    const total = Math.ceil((10 * 1024 ** 3) / CHUNK_SIZE);
    const sparse = [];
    for (let i = 0; i < total; i++) if (i % 2 === 0) sparse.push(i); // worst case: alternating
    report('10 GB worst-case sparse (every other chunk missing)', sparse);

    // CPU: cost of building ranges for a large contiguous pull.
    const t0 = performance.now();
    let acc = 0;
    for (let r = 0; r < 50; r++) acc += chunksToRanges(Array.from({ length: total }, (_, i) => i)).length;
    const t1 = performance.now();
    console.log(`\nCPU: chunksToRanges over ${total.toLocaleString()} indices × 50 = ` +
        `${((t1 - t0) / 50).toFixed(2)} ms/call (acc=${acc})`);
}

main();
