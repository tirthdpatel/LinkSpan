/**
 * PrometheusExporter — Formats MetricsCollector snapshots as Prometheus text.
 *
 * Prometheus text format reference:
 *   https://prometheus.io/docs/instrumenting/exposition_formats/#text-format-details
 *
 * Usage:
 *   import { PrometheusExporter } from './metrics/PrometheusExporter.js';
 *   const exporter = new PrometheusExporter(collector);
 *   app.get('/metrics', (req, res) => {
 *     res.set('Content-Type', PrometheusExporter.CONTENT_TYPE);
 *     res.send(exporter.render());
 *   });
 */

import { collector as defaultCollector } from './MetricsCollector.js';

export class PrometheusExporter {
  static CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

  /**
   * @param {import('./MetricsCollector.js').MetricsCollector} [metricsCollector]
   */
  constructor(metricsCollector) {
    this._collector = metricsCollector ?? defaultCollector;
  }

  /**
   * Renders the current metrics snapshot as a Prometheus text document.
   * @returns {string}
   */
  render() {
    const snap  = this._collector.snapshot();
    const lines = [];

    // ── Active sessions gauge ──────────────────────────────────────────────
    lines.push('# HELP linkspan_active_sessions Number of currently active sessions');
    lines.push('# TYPE linkspan_active_sessions gauge');
    lines.push(`linkspan_active_sessions ${snap.activeSessions}`);

    // ── Counters ───────────────────────────────────────────────────────────
    const counterMeta = {
      sessions_created:  ['Total sessions created',             'counter'],
      bytes_transferred: ['Total bytes transferred via relay',  'counter'],
      transfer_failures: ['Total transfer failures',            'counter'],
      relay_activations: ['Total relay fallback activations',   'counter'],
      rate_limit_hits:   ['Total rate limit rejections',        'counter'],
      ice_restarts:      ['Total ICE restart attempts',         'counter'],
    };

    for (const [key, [help, type]] of Object.entries(counterMeta)) {
      const metricName = `linkspan_${key}_total`;
      lines.push(`# HELP ${metricName} ${help}`);
      lines.push(`# TYPE ${metricName} ${type}`);
      lines.push(`${metricName} ${snap.counters[key] ?? 0}`);
    }

    // ── Session duration histogram ─────────────────────────────────────────
    lines.push('# HELP linkspan_session_duration_seconds Session lifetime in seconds');
    lines.push('# TYPE linkspan_session_duration_seconds histogram');

    const { buckets, counts, sum, count } = snap.duration;
    let cumulativeCount = 0;
    for (let i = 0; i < buckets.length; i++) {
      cumulativeCount += counts[i];
      const le = buckets[i] === Infinity ? '+Inf' : buckets[i];
      lines.push(`linkspan_session_duration_seconds_bucket{le="${le}"} ${cumulativeCount}`);
    }
    lines.push(`linkspan_session_duration_seconds_sum ${sum}`);
    lines.push(`linkspan_session_duration_seconds_count ${count}`);

    // Prometheus requires a trailing newline
    return lines.join('\n') + '\n';
  }
}
