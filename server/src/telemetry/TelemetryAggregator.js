/**
 * TelemetryAggregator — opt-in, privacy-first AGGREGATE counters for completed
 * transfers (Item 1's optional half). This is deliberately NOT a per-transfer row:
 * it only ever holds COUNTS bucketed by a small fixed vocabulary (outcome, transport
 * mode, size bucket, duration bucket). No filename, byte count, duration value, peer
 * or device identity, room membership, IP, or per-transfer id is accepted or stored —
 * the route layer never passes them and `record()` would ignore them anyway.
 *
 * Cardinality is bounded by the shared enums (pre-seeded to zero), so the exported
 * Prometheus series are stable and a hostile client can't inject arbitrary labels.
 */
import {
    TELEMETRY_OUTCOME,
    TELEMETRY_MODE,
    TELEMETRY_SIZE_BUCKET,
    TELEMETRY_DURATION_BUCKET,
} from '../../../shared/constants.js';

export class TelemetryAggregator {
    constructor() {
        this._transfers = new Map(); // `${outcome}|${mode}` → count
        this._sizes = new Map();     // sizeBucket → count
        this._durations = new Map(); // durationBucket → count
        this._total = 0;
        this._rejected = 0;

        // Pre-seed every label combination to 0 so /metrics always emits the full,
        // stable series set (and division/rate queries never see gaps).
        for (const outcome of TELEMETRY_OUTCOME) {
            for (const mode of TELEMETRY_MODE) this._transfers.set(`${outcome}|${mode}`, 0);
        }
        for (const b of TELEMETRY_SIZE_BUCKET) this._sizes.set(b, 0);
        for (const b of TELEMETRY_DURATION_BUCKET) this._durations.set(b, 0);
    }

    /**
     * Record one anonymized, pre-bucketed transfer event. Every field must be a known
     * enum value; anything else (missing, unknown, or extra-typed) is rejected wholesale
     * so no arbitrary label can enter the metrics.
     * @param {{outcome?: string, mode?: string, sizeBucket?: string, durationBucket?: string}} event
     * @returns {boolean} true if recorded, false if rejected as invalid
     */
    record(event) {
        const e = event && typeof event === 'object' ? event : {};
        const { outcome, mode, sizeBucket, durationBucket } = e;

        if (
            !TELEMETRY_OUTCOME.includes(outcome) ||
            !TELEMETRY_MODE.includes(mode) ||
            !TELEMETRY_SIZE_BUCKET.includes(sizeBucket) ||
            !TELEMETRY_DURATION_BUCKET.includes(durationBucket)
        ) {
            this._rejected++;
            return false;
        }

        const key = `${outcome}|${mode}`;
        this._transfers.set(key, this._transfers.get(key) + 1);
        this._sizes.set(sizeBucket, this._sizes.get(sizeBucket) + 1);
        this._durations.set(durationBucket, this._durations.get(durationBucket) + 1);
        this._total++;
        return true;
    }

    /** @returns {{total:number, rejected:number, transfers:object, sizes:object, durations:object}} */
    snapshot() {
        return {
            total: this._total,
            rejected: this._rejected,
            transfers: Object.fromEntries(this._transfers),
            sizes: Object.fromEntries(this._sizes),
            durations: Object.fromEntries(this._durations),
        };
    }

    /**
     * Render these aggregate counters as Prometheus text (appended to /metrics).
     * @returns {string}
     */
    render() {
        const lines = [];

        lines.push('# HELP linkspan_client_transfers_total Opt-in client-reported completed transfers');
        lines.push('# TYPE linkspan_client_transfers_total counter');
        for (const [key, count] of this._transfers) {
            const [outcome, mode] = key.split('|');
            lines.push(`linkspan_client_transfers_total{outcome="${outcome}",mode="${mode}"} ${count}`);
        }

        lines.push('# HELP linkspan_client_transfer_size_total Opt-in client-reported transfers by size bucket');
        lines.push('# TYPE linkspan_client_transfer_size_total counter');
        for (const [bucket, count] of this._sizes) {
            lines.push(`linkspan_client_transfer_size_total{bucket="${bucket}"} ${count}`);
        }

        lines.push('# HELP linkspan_client_transfer_duration_total Opt-in client-reported transfers by duration bucket');
        lines.push('# TYPE linkspan_client_transfer_duration_total counter');
        for (const [bucket, count] of this._durations) {
            lines.push(`linkspan_client_transfer_duration_total{bucket="${bucket}"} ${count}`);
        }

        return lines.join('\n') + '\n';
    }
}

// Singleton — shared across the server process.
export const telemetryAggregator = new TelemetryAggregator();
