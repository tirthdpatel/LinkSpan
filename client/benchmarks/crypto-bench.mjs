/**
 * crypto-bench.mjs — Throughput/latency benchmark for the encryption hot path
 * (Phase 4.4). Measures the per-chunk work that gates large-file transfer speed:
 * AES-256-GCM encrypt/decrypt, SHA-256 hashing, and the one-time ECDH handshake.
 *
 * Run:  node client/benchmarks/crypto-bench.mjs
 * (Standalone — CryptoEngine has no bundler-alias imports.)
 */
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
import { CryptoEngine } from '../src/crypto/CryptoEngine.js';

const CHUNK = 256 * 1024 - 28;     // ENCRYPTED_CHUNK_SIZE
const TOTAL_MB = 256;              // simulate a 256 MB transfer
const N = Math.ceil((TOTAL_MB * 1024 * 1024) / CHUNK);
const MBps = (bytes, ms) => ((bytes / (1024 * 1024)) / (ms / 1000)).toFixed(1);

function randomChunk() {
    const u = new Uint8Array(CHUNK);
    for (let o = 0; o < u.length; o += 65536) crypto.getRandomValues(u.subarray(o, Math.min(o + 65536, u.length)));
    return u.buffer;
}

async function main() {
    console.log(`Benchmark: ${N} chunks × ${(CHUNK / 1024).toFixed(0)} KB ≈ ${TOTAL_MB} MB\n`);
    const key = await CryptoEngine.generateKey();
    const sample = randomChunk();
    const totalBytes = N * CHUNK;

    // ECDH handshake (one-time per transfer)
    let t = performance.now();
    const kpA = await CryptoEngine.generateECDHKeyPair();
    const kpB = await CryptoEngine.generateECDHKeyPair();
    await CryptoEngine.deriveSharedKey(kpA, await CryptoEngine.exportPublicKey(kpB));
    console.log(`ECDH handshake (keygen ×2 + derive): ${(performance.now() - t).toFixed(1)} ms (one-time)`);

    // SHA-256 hashing (per chunk, both sides)
    t = performance.now();
    for (let i = 0; i < N; i++) await crypto.subtle.digest('SHA-256', sample);
    let ms = performance.now() - t;
    console.log(`SHA-256 hashing:  ${MBps(totalBytes, ms)} MB/s  (${ms.toFixed(0)} ms)`);

    // AES-256-GCM encrypt
    t = performance.now();
    let enc;
    for (let i = 0; i < N; i++) enc = await CryptoEngine.encryptChunk(key, sample);
    ms = performance.now() - t;
    console.log(`AES-256-GCM encrypt: ${MBps(totalBytes, ms)} MB/s  (${ms.toFixed(0)} ms)`);

    // AES-256-GCM decrypt
    t = performance.now();
    for (let i = 0; i < N; i++) await CryptoEngine.decryptChunk(key, enc);
    ms = performance.now() - t;
    console.log(`AES-256-GCM decrypt: ${MBps(totalBytes, ms)} MB/s  (${ms.toFixed(0)} ms)`);

    console.log(`\nPeak working set: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB heap` +
        ` (bounded — one chunk in flight, never the whole file)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
