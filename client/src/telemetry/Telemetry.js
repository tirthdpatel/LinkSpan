/**
 * Telemetry — opt-in, privacy-first AGGREGATE reporting (default OFF).
 *
 * When (and only when) the user has explicitly opted in, a single anonymized,
 * pre-bucketed event is POSTed to the server's /api/v1/telemetry endpoint after a
 * transfer completes. What is sent is bounded to four coarse categories — outcome
 * (success/failure), transport mode (p2p/relay), a size bucket, and a duration bucket.
 *
 * Never sent: filename, byte count, duration value, peer/device identity, room
 * membership, IP, share-link id, or any per-transfer identifier. The opt-in flag lives
 * in localStorage and defaults to off, so doing nothing means reporting nothing.
 *
 * The POST is strictly fire-and-forget: it never throws and never blocks or affects a
 * transfer. If the user hasn't opted in, no request is made at all.
 */
import {
    telemetrySizeBucket,
    telemetryDurationBucket,
} from '@shared/constants.js';

const ENABLED_KEY = 'linkspan-telemetry-enabled';

function readFlag() {
    try {
        return typeof localStorage !== 'undefined' && localStorage.getItem(ENABLED_KEY) === 'true';
    } catch {
        return false;
    }
}

/** @returns {boolean} whether the user has opted in (default false). */
export function isTelemetryEnabled() {
    return readFlag();
}

/**
 * Set the opt-in flag.
 * @param {boolean} on
 * @returns {boolean} the new state
 */
export function setTelemetryEnabled(on) {
    try {
        if (typeof localStorage !== 'undefined') {
            if (on) localStorage.setItem(ENABLED_KEY, 'true');
            else localStorage.removeItem(ENABLED_KEY);
        }
    } catch { /* ignore storage failures */ }
    return readFlag();
}

function defaultApiBase() {
    const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};
    if (env.VITE_API_URL) return env.VITE_API_URL.replace(/\/+$/, '');
    const sig = env.VITE_SIGNALING_URL || 'ws://localhost:10000';
    return sig.replace(/^ws/, 'http').replace(/\/+$/, '') + '/api/v1';
}

/**
 * Build the anonymized event from raw transfer facts. Returns null if the data can't be
 * bucketed (so nothing is ever sent for a malformed input). Exported for testing.
 * @param {{ success: boolean, relay: boolean, totalBytes: number, durationMs: number }} facts
 * @returns {{outcome:string, mode:string, sizeBucket:string, durationBucket:string}|null}
 */
export function buildTelemetryEvent({ success, relay, totalBytes, durationMs }) {
    const sizeBucket = telemetrySizeBucket(totalBytes);
    const durationBucket = telemetryDurationBucket(durationMs);
    if (!sizeBucket || !durationBucket) return null;
    return {
        outcome: success ? 'success' : 'failure',
        mode: relay ? 'relay' : 'p2p',
        sizeBucket,
        durationBucket,
    };
}

/**
 * Report a completed transfer — a no-op unless the user has opted in. Fire-and-forget.
 * @param {{ success: boolean, relay: boolean, totalBytes: number, durationMs: number }} facts
 * @param {{ apiBase?: string, fetchImpl?: typeof fetch }} [opts] - injectable for tests
 * @returns {Promise<boolean>} true if a report was sent, false otherwise
 */
export async function reportTransfer(facts, opts = {}) {
    if (!isTelemetryEnabled()) return false;

    const event = buildTelemetryEvent(facts);
    if (!event) return false;

    const fetchImpl = opts.fetchImpl
        || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    if (!fetchImpl) return false;

    const apiBase = (opts.apiBase || defaultApiBase()).replace(/\/+$/, '');
    try {
        await fetchImpl(`${apiBase}/telemetry`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(event),
            keepalive: true, // best-effort delivery even as the page unloads
        });
        return true;
    } catch {
        return false; // telemetry must never surface an error to the user
    }
}
