/**
 * bottleneck-bench.mjs — Find the CPU/crypto throughput ceiling of THIS machine and
 * show how the diagnostics classifier reads each regime.
 *
 * The transfer readout names its bottleneck live (see src/transfer/BottleneckMonitor.js),
 * but that needs two peers on a network. This standalone bench answers the one axis you
 * CAN measure without a peer — "how fast can a single thread encrypt+hash, and is that
 * the wall?" — by running the real per-chunk hot path and sampling event-loop load while
 * it does. Then it feeds representative numbers through the same classifier so you can see
 * which lever (Web Workers vs multi-PC vs nothing) each regime points to.
 *
 * Run:  node client/benchmarks/bottleneck-bench.mjs
 * (Standalone — CryptoEngine is alias-free; constants come from repo-root shared/.)
 */
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
import { CryptoEngine } from '../src/crypto/CryptoEngine.js';
import {
    BOTTLENECK_CPU_LOAD,
    BOTTLENECK_LOSS_RATE,
    BOTTLENECK_IDLE_BPS,
} from '../../shared/constants.js';

const CHUNK = 256 * 1024 - 28;   // ENCRYPTED_CHUNK_SIZE (plaintext ceiling)
const TOTAL_MB = 512;            // enough work to peg a core for a readable window
const N = Math.ceil((TOTAL_MB * 1024 * 1024) / CHUNK);

/**
 * Mirror of BottleneckMonitor.classifyBottleneck (kept in sync by importing the same
 * thresholds). Duplicated here only because that module imports the Vite `@shared` alias,
 * which plain `node` can't resolve — the numbers that matter are the shared constants.
 */
function classifyBottleneck({ throughputBps = 0, lossRate = 0, cpuLoad = 0 } = {}) {
    if (throughputBps < BOTTLENECK_IDLE_BPS && cpuLoad < BOTTLENECK_CPU_LOAD) {
        return { verdict: 'idle', reason: 'Not enough traffic to measure yet' };
    }
    if (cpuLoad >= BOTTLENECK_CPU_LOAD) {
        return { verdict: 'cpu', reason: 'Main thread saturated — Web Workers would help' };
    }
    if (lossRate >= BOTTLENECK_LOSS_RATE) {
        return { verdict: 'loss', reason: 'Retransmits on a lossy/high-latency path — multiple connections would help' };
    }
    return { verdict: 'link', reason: 'Link saturated — parallelism buys little here' };
}

function randomChunk() {
    const u = new Uint8Array(CHUNK);
    for (let o = 0; o < u.length; o += 65536) {
        crypto.getRandomValues(u.subarray(o, Math.min(o + 65536, u.length)));
    }
    return u.buffer;
}

/**
 * Sample event-loop load the same way EventLoopLoadMonitor does: a metronome timer whose
 * drift reveals how long the main thread was blocked. Returns peak load seen in [0,1].
 */
function startLoadSampler(intervalMs = 50) {
    let last = performance.now();
    let peak = 0;
    const timer = setInterval(() => {
        const t = performance.now();
        const drift = Math.max(0, t - last - intervalMs);
        peak = Math.max(peak, Math.min(1, drift / intervalMs));
        last = t;
    }, intervalMs);
    if (timer.unref) timer.unref();
    return { stop: () => { clearInterval(timer); return peak; } };
}

const MBps = (bytes, ms) => ((bytes / (1024 * 1024)) / (ms / 1000));

async function main() {
    console.log(`Bottleneck bench — ${N} chunks × ${(CHUNK / 1024).toFixed(0)} KB ≈ ${TOTAL_MB} MB`);
    console.log('Measuring the single-thread encrypt + hash ceiling (the CPU wall)…\n');

    const key = await CryptoEngine.generateKey();
    const sample = randomChunk();
    const totalBytes = N * CHUNK;

    // Real per-chunk send-side work: SHA-256 over plaintext, then AES-256-GCM encrypt.
    const sampler = startLoadSampler();
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
        // SHA-256 over plaintext (per-chunk integrity hash) + AES-256-GCM encrypt —
        // exactly the send-side work Sender does before a chunk leaves the peer.
        await crypto.subtle.digest('SHA-256', sample);
        await CryptoEngine.encryptChunk(key, sample);
    }
    const elapsedMs = performance.now() - t0;
    const cpuLoad = sampler.stop();

    const cryptoBps = (totalBytes / (elapsedMs / 1000));
    const offThread = cpuLoad < 0.2; // WebCrypto runs in a thread pool, not on the loop
    console.log(`Crypto pipeline : ${MBps(totalBytes, elapsedMs).toFixed(1)} MB/s serial (encrypt + SHA-256 per chunk)`);
    console.log(`                 ${elapsedMs.toFixed(0)} ms for ${TOTAL_MB} MB, main-thread (event-loop) load peaked at ${Math.round(cpuLoad * 100)}%`);
    if (offThread) {
        console.log('                 → WebCrypto executes OFF the main thread, so it barely loads the event loop.');
        console.log('                   Crypto is unlikely to be your bottleneck, and a Worker around it buys little —');
        console.log('                   the main-thread cost is JS glue (slicing, packChunk, JSON), not the crypto itself.\n');
    } else {
        console.log('                 → the main thread is carrying real crypto cost; Workers would offload it.\n');
    }

    // Show how the classifier reads each regime, using the measured ceiling as the anchor.
    console.log('Classifier verdicts by regime:');
    const scenarios = [
        {
            name: 'CPU-bound  (crypto pegging the thread)',
            s: { throughputBps: cryptoBps, lossRate: 0, cpuLoad: Math.max(cpuLoad, BOTTLENECK_CPU_LOAD) },
        },
        {
            name: 'Loss-bound (fast link, 3% retransmits)',
            s: { throughputBps: cryptoBps * 4, lossRate: 0.03, cpuLoad: 0.15 },
        },
        {
            name: 'Link-bound (fast link, clean, low CPU)',
            s: { throughputBps: cryptoBps * 4, lossRate: 0, cpuLoad: 0.15 },
        },
        {
            name: 'Idle       (barely any traffic)',
            s: { throughputBps: BOTTLENECK_IDLE_BPS / 2, lossRate: 0, cpuLoad: 0.05 },
        },
    ];
    for (const { name, s } of scenarios) {
        const v = classifyBottleneck(s);
        console.log(`  ${name.padEnd(40)} → ${v.verdict.toUpperCase().padEnd(5)} · ${v.reason}`);
    }

    console.log(`\nTakeaway: this machine's crypto hot path caps a single thread at ` +
        `~${MBps(totalBytes, elapsedMs).toFixed(0)} MB/s.`);
    console.log('  • If a real transfer approaches that and CPU reads high → CPU-bound, Web Workers help.');
    console.log('  • If it stays well below with loss climbing → congestion-bound, multi-PC striping helps.');
    console.log('  • If it plateaus near your link speed with no loss → link-bound, parallelism buys little.');
}

main();
