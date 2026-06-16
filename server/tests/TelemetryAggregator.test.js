/**
 * TelemetryAggregator unit tests — aggregate counts only, bounded cardinality,
 * strict enum validation, no PII ever stored.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TelemetryAggregator } from '../src/telemetry/TelemetryAggregator.js';

const valid = { outcome: 'success', mode: 'p2p', sizeBucket: '1to10mb', durationBucket: '1to10s' };

describe('TelemetryAggregator', () => {
    it('pre-seeds every label combination to zero (stable cardinality)', () => {
        const snap = new TelemetryAggregator().snapshot();
        // 2 outcomes × 2 modes = 4 transfer series; 5 size buckets; 5 duration buckets.
        assert.equal(Object.keys(snap.transfers).length, 4);
        assert.equal(Object.keys(snap.sizes).length, 5);
        assert.equal(Object.keys(snap.durations).length, 5);
        assert.equal(snap.total, 0);
        for (const v of Object.values(snap.transfers)) assert.equal(v, 0);
    });

    it('records a valid event into the right buckets', () => {
        const agg = new TelemetryAggregator();
        assert.equal(agg.record(valid), true);
        const snap = agg.snapshot();
        assert.equal(snap.total, 1);
        assert.equal(snap.transfers['success|p2p'], 1);
        assert.equal(snap.sizes['1to10mb'], 1);
        assert.equal(snap.durations['1to10s'], 1);
        // Other series untouched.
        assert.equal(snap.transfers['failure|relay'], 0);
    });

    it('rejects unknown enum values without recording (no label injection)', () => {
        const agg = new TelemetryAggregator();
        const bad = [
            { ...valid, outcome: 'maybe' },
            { ...valid, mode: 'carrier-pigeon' },
            { ...valid, sizeBucket: '9000tb' },
            { ...valid, durationBucket: 'eternity' },
            { ...valid, outcome: undefined },
            {},
            null,
            'not-an-object',
        ];
        for (const b of bad) assert.equal(agg.record(b), false);
        const snap = agg.snapshot();
        assert.equal(snap.total, 0);
        assert.equal(snap.rejected, bad.length);
        // No new keys leaked into any map.
        assert.equal(Object.keys(snap.transfers).length, 4);
        assert.equal(Object.keys(snap.sizes).length, 5);
    });

    it('ignores extra/PII-looking fields, recording only the enum dimensions', () => {
        const agg = new TelemetryAggregator();
        agg.record({ ...valid, filename: 'taxes.pdf', ip: '1.2.3.4', bytes: 123456, peerId: 'abc' });
        const snap = agg.snapshot();
        assert.equal(snap.total, 1);
        // Snapshot exposes only bucketed counts — no place for the extra fields to land.
        const serialized = JSON.stringify(snap);
        assert.ok(!serialized.includes('taxes'));
        assert.ok(!serialized.includes('1.2.3.4'));
        assert.ok(!serialized.includes('123456'));
    });

    it('renders bounded Prometheus series with no PII', () => {
        const agg = new TelemetryAggregator();
        agg.record(valid);
        agg.record({ outcome: 'failure', mode: 'relay', sizeBucket: 'gt1gb', durationBucket: 'gt5m' });
        const text = agg.render();

        assert.match(text, /# TYPE linkspan_client_transfers_total counter/);
        assert.match(text, /linkspan_client_transfers_total\{outcome="success",mode="p2p"\} 1/);
        assert.match(text, /linkspan_client_transfers_total\{outcome="failure",mode="relay"\} 1/);
        assert.match(text, /linkspan_client_transfer_size_total\{bucket="gt1gb"\} 1/);
        assert.match(text, /linkspan_client_transfer_duration_total\{bucket="gt5m"\} 1/);
        // Exactly the bounded series: 4 transfer + 5 size + 5 duration = 14 sample lines.
        const sampleLines = text.split('\n').filter((l) => l && !l.startsWith('#'));
        assert.equal(sampleLines.length, 14);
    });
});
