import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
    isTelemetryEnabled,
    setTelemetryEnabled,
    buildTelemetryEvent,
    reportTransfer,
} from '../telemetry/Telemetry.js';

// Telemetry is opt-in (default OFF) and only ever sends anonymized, pre-bucketed data.

beforeEach(() => {
    try { localStorage.clear(); } catch { /* jsdom provides localStorage */ }
});

describe('opt-in flag', () => {
    test('defaults to off', () => {
        expect(isTelemetryEnabled()).toBe(false);
    });
    test('can be enabled and disabled', () => {
        expect(setTelemetryEnabled(true)).toBe(true);
        expect(isTelemetryEnabled()).toBe(true);
        expect(setTelemetryEnabled(false)).toBe(false);
        expect(isTelemetryEnabled()).toBe(false);
    });
});

describe('buildTelemetryEvent', () => {
    test('buckets size and duration into coarse categories', () => {
        expect(buildTelemetryEvent({ success: true, relay: false, totalBytes: 5 * 1024 * 1024, durationMs: 3000 }))
            .toEqual({ outcome: 'success', mode: 'p2p', sizeBucket: '1to10mb', durationBucket: '1to10s' });
        expect(buildTelemetryEvent({ success: false, relay: true, totalBytes: 2 * 1024 * 1024 * 1024, durationMs: 600000 }))
            .toEqual({ outcome: 'failure', mode: 'relay', sizeBucket: 'gt1gb', durationBucket: 'gt5m' });
    });
    test('returns null for unbucketable input (never sends garbage)', () => {
        expect(buildTelemetryEvent({ success: true, relay: false, totalBytes: -1, durationMs: 0 })).toBeNull();
        expect(buildTelemetryEvent({ success: true, relay: false, totalBytes: NaN, durationMs: 1 })).toBeNull();
    });
    test('event carries ONLY the four bounded fields — no PII', () => {
        const ev = buildTelemetryEvent({ success: true, relay: false, totalBytes: 100, durationMs: 100 });
        expect(Object.keys(ev).sort()).toEqual(['durationBucket', 'mode', 'outcome', 'sizeBucket']);
    });
});

describe('reportTransfer', () => {
    const facts = { success: true, relay: false, totalBytes: 50 * 1024 * 1024, durationMs: 20000 };

    test('does nothing when the user has not opted in', async () => {
        const fetchImpl = vi.fn();
        const sent = await reportTransfer(facts, { fetchImpl, apiBase: 'http://x/api/v1' });
        expect(sent).toBe(false);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('POSTs an anonymized bucketed event when opted in', async () => {
        setTelemetryEnabled(true);
        const fetchImpl = vi.fn().mockResolvedValue({ status: 204 });
        const sent = await reportTransfer(facts, { fetchImpl, apiBase: 'http://x/api/v1' });
        expect(sent).toBe(true);
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe('http://x/api/v1/telemetry');
        expect(init.method).toBe('POST');
        const body = JSON.parse(init.body);
        expect(body).toEqual({ outcome: 'success', mode: 'p2p', sizeBucket: '10to100mb', durationBucket: '10to60s' });
        // No identifying fields whatsoever.
        for (const k of ['filename', 'fileName', 'name', 'bytes', 'size', 'ip', 'peerId', 'id']) {
            expect(body).not.toHaveProperty(k);
        }
    });

    test('never throws even if the network fails', async () => {
        setTelemetryEnabled(true);
        const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
        const sent = await reportTransfer(facts, { fetchImpl, apiBase: 'http://x/api/v1' });
        expect(sent).toBe(false); // swallowed
    });

    test('does not send when data is unbucketable, even if opted in', async () => {
        setTelemetryEnabled(true);
        const fetchImpl = vi.fn();
        const sent = await reportTransfer({ success: true, relay: false, totalBytes: -5, durationMs: 1 }, { fetchImpl });
        expect(sent).toBe(false);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
