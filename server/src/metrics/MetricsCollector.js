/**
 * MetricsCollector — OpenTelemetry-compatible counters and histograms.
 *
 * If the optional `@opentelemetry/api` package is available, metrics are
 * recorded through the OTEL SDK. Otherwise they are kept in-process so
 * /metrics always returns valid Prometheus output even in minimal deploys.
 *
 * Exposed metrics:
 *   linkspan_active_sessions          (gauge)
 *   linkspan_sessions_created_total   (counter)
 *   linkspan_bytes_transferred_total  (counter)
 *   linkspan_transfer_failures_total  (counter)
 *   linkspan_relay_activations_total  (counter)
 *   linkspan_rate_limit_hits_total    (counter)
 *   linkspan_ice_restart_total        (counter)
 *   linkspan_session_duration_seconds (histogram)
 */

let otelMetrics;
let otelMeter;
try {
  // Dynamic import to keep OTEL fully optional — no crash if not installed
  const otelApi = await import('@opentelemetry/api');
  otelMetrics = otelApi.metrics;
  otelMeter   = otelMetrics.getMeter('linkspan', '1.0.0');
} catch {
  // OTEL not installed — use in-process counters only
}

export class MetricsCollector {
  constructor() {
    // In-process state (always kept in sync, used by PrometheusExporter)
    this._counters = {
      sessions_created:  0,
      bytes_transferred: 0,
      transfer_failures: 0,
      relay_activations: 0,
      rate_limit_hits:   0,
      ice_restarts:      0,
    };
    this._activeSessions = 0;

    // Histogram buckets: [0.5, 1, 5, 15, 30, 60, 120, 300, 600, 1800] seconds
    this._durationBuckets = [0.5, 1, 5, 15, 30, 60, 120, 300, 600, 1800, Infinity];
    this._durationCounts  = new Array(this._durationBuckets.length).fill(0);
    this._durationSum     = 0;
    this._durationTotal   = 0;

    // OTEL instruments (optional)
    if (otelMeter) {
      this._otelGauge    = otelMeter.createObservableGauge('linkspan_active_sessions');
      this._otelCounters = {};
      for (const name of Object.keys(this._counters)) {
        this._otelCounters[name] = otelMeter.createCounter(`linkspan_${name}_total`);
      }
      this._otelHistogram = otelMeter.createHistogram('linkspan_session_duration_seconds');
      this._otelGauge.addCallback((obs) => obs.observe(this._activeSessions));
    }
  }

  // ── Gauges ────────────────────────────────────────────────────────────────

  setActiveSessions(count) {
    this._activeSessions = count;
  }

  incrementActiveSessions() {
    this._activeSessions++;
  }

  decrementActiveSessions() {
    if (this._activeSessions > 0) this._activeSessions--;
  }

  // ── Counters ──────────────────────────────────────────────────────────────

  recordSessionCreated() {
    this._inc('sessions_created');
  }

  recordBytesTransferred(bytes) {
    this._add('bytes_transferred', bytes);
  }

  recordTransferFailure() {
    this._inc('transfer_failures');
  }

  recordRelayActivation() {
    this._inc('relay_activations');
  }

  recordRateLimitHit() {
    this._inc('rate_limit_hits');
  }

  recordIceRestart() {
    this._inc('ice_restarts');
  }

  // ── Histogram ─────────────────────────────────────────────────────────────

  /**
   * @param {number} durationSeconds  Session duration in fractional seconds
   */
  recordSessionDuration(durationSeconds) {
    this._durationSum += durationSeconds;
    this._durationTotal++;
    for (let i = 0; i < this._durationBuckets.length; i++) {
      if (durationSeconds <= this._durationBuckets[i]) {
        this._durationCounts[i]++;
        break;
      }
    }
    if (otelMeter && this._otelHistogram) {
      this._otelHistogram.record(durationSeconds);
    }
  }

  // ── Snapshot ──────────────────────────────────────────────────────────────

  /**
   * Returns a snapshot suitable for PrometheusExporter.
   */
  snapshot() {
    return {
      activeSessions: this._activeSessions,
      counters:       { ...this._counters },
      duration: {
        buckets: this._durationBuckets,
        counts:  [...this._durationCounts],
        sum:     this._durationSum,
        count:   this._durationTotal,
      },
    };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _inc(name, cost = 1) {
    this._counters[name] += cost;
    if (otelMeter && this._otelCounters?.[name]) {
      this._otelCounters[name].add(cost);
    }
  }

  _add(name, value) {
    this._counters[name] += value;
    if (otelMeter && this._otelCounters?.[name]) {
      this._otelCounters[name].add(value);
    }
  }
}

// Singleton — import once and share across the server process.
export const collector = new MetricsCollector();
