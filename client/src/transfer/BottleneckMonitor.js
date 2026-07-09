/**
 * BottleneckMonitor — tells you WHY a transfer is at its current speed.
 *
 * Parallelism (more DataChannels, multi-PC striping, Web Workers) only helps the
 * specific bottleneck you actually have. This module surfaces the three signals that
 * distinguish them, so the diagnostics readout can name the limiter instead of guessing:
 *
 *   - cpu  — the main thread is pinned (per-chunk encryption + hashing). Workers help.
 *   - loss — retransmits are eating throughput on a lossy/high-latency path. More
 *            independent congestion windows (multi-PC striping) help.
 *   - link — nothing else is obviously constraining, so the physical link is the
 *            ceiling. A single flow already saturates it; parallelism buys little.
 *
 * `EventLoopLoadMonitor` estimates main-thread saturation the only way a browser page
 * can without native hooks: by scheduling a metronome timer and measuring how late it
 * fires. When the main thread is busy encrypting/hashing, timers drift; the drift
 * fraction is a decent proxy for "how CPU-bound are we right now."
 *
 * `classifyBottleneck` is pure (no timers, no DOM) so it is unit-testable in isolation.
 */
import {
    BOTTLENECK_CPU_LOAD,
    BOTTLENECK_LOSS_RATE,
    BOTTLENECK_IDLE_BPS,
} from '@shared/constants.js';

const SAMPLE_INTERVAL_MS = 250;

/**
 * Samples main-thread load by measuring timer drift. A timer asked to fire every
 * SAMPLE_INTERVAL_MS that instead fires late reveals the main thread was blocked;
 * `load` is the fraction of the last window the thread was unavailable, in [0, 1].
 */
export class EventLoopLoadMonitor {
    constructor({ setInterval: setIntervalImpl, clearInterval: clearIntervalImpl, now } = {}) {
        // Injectable for tests; default to the ambient timers/clock.
        this._setInterval = setIntervalImpl || ((fn, ms) => setInterval(fn, ms));
        this._clearInterval = clearIntervalImpl || ((id) => clearInterval(id));
        this._now = now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
        this._timer = null;
        this._last = 0;
        this._load = 0;
    }

    start() {
        if (this._timer) return;
        this._last = this._now();
        this._timer = this._setInterval(() => {
            const t = this._now();
            const drift = Math.max(0, t - this._last - SAMPLE_INTERVAL_MS);
            // drift beyond one full interval saturates to 1 (thread was fully busy).
            const load = Math.min(1, drift / SAMPLE_INTERVAL_MS);
            // Light EWMA so a single GC pause doesn't spike the reading.
            this._load = 0.6 * this._load + 0.4 * load;
            this._last = t;
        }, SAMPLE_INTERVAL_MS);
    }

    /** @returns {number} estimated main-thread busy fraction in [0, 1]. */
    get load() {
        return this._load;
    }

    stop() {
        if (this._timer) {
            this._clearInterval(this._timer);
            this._timer = null;
        }
        this._load = 0;
    }
}

/**
 * Name the most likely limiter from the live signals. Order matters: CPU saturation
 * masks everything downstream (a pinned main thread can't push more bytes regardless
 * of the link), so it wins; loss is next; otherwise the link is the ceiling.
 *
 * @param {object} s
 * @param {number} s.throughputBps - aggregate bytes/sec right now
 * @param {number} s.lossRate      - retransmits / total sends, in [0, 1]
 * @param {number} s.cpuLoad       - main-thread busy fraction, in [0, 1]
 * @returns {{ verdict: 'idle'|'cpu'|'loss'|'link', reason: string }}
 */
export function classifyBottleneck({ throughputBps = 0, lossRate = 0, cpuLoad = 0 } = {}) {
    if (throughputBps < BOTTLENECK_IDLE_BPS && cpuLoad < BOTTLENECK_CPU_LOAD) {
        return { verdict: 'idle', reason: 'Not enough traffic to measure yet' };
    }
    if (cpuLoad >= BOTTLENECK_CPU_LOAD) {
        return { verdict: 'cpu', reason: 'Main thread is saturated — Web Workers would help' };
    }
    if (lossRate >= BOTTLENECK_LOSS_RATE) {
        return { verdict: 'loss', reason: 'Retransmits from a lossy/high-latency path — multiple connections would help' };
    }
    return { verdict: 'link', reason: 'Link appears saturated — parallelism buys little here' };
}
