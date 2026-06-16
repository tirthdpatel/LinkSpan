import React, { useState, useEffect, useCallback } from 'react';
import { isTelemetryEnabled, setTelemetryEnabled } from '../telemetry/Telemetry';

function formatSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}
function formatDuration(ms) {
    if (!ms || ms < 1000) return '<1s';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
}

const STATE_BADGE = {
    success: { label: 'Done', color: '#40c057' },
    failed: { label: 'Failed', color: '#e03131' },
    cancelled: { label: 'Cancelled', color: '#f59f00' },
    rejected: { label: 'Rejected', color: '#f59f00' },
};

/**
 * HistoryView — searchable, filterable, sortable transfer history (Feature 6).
 *
 * Reads from the local IndexedDB-backed HistoryManager. Supports full-text search,
 * direction/state filters, sort by date/size/name, per-row delete, clear-all,
 * JSON export, and a privacy toggle that disables future recording.
 *
 * @param {object} props
 * @param {() => import('../storage/HistoryManager').HistoryManager} props.history
 *        lazily-resolved HistoryManager accessor (shared with the connection hook)
 * @param {() => void} props.onClose
 */
export function HistoryView({ history, onClose }) {
    const mgr = history();
    const [rows, setRows] = useState([]);
    const [search, setSearch] = useState('');
    const [direction, setDirection] = useState('');
    const [stateFilter, setStateFilter] = useState('');
    const [sortBy, setSortBy] = useState('date');
    const [enabled, setEnabled] = useState(mgr.isEnabled());
    const [telemetry, setTelemetry] = useState(isTelemetryEnabled());
    const [loading, setLoading] = useState(true);

    const reload = useCallback(async () => {
        setLoading(true);
        try {
            const list = await mgr.list({ search, direction, state: stateFilter, sortBy, order: 'desc' });
            setRows(list);
        } catch {
            setRows([]);
        } finally {
            setLoading(false);
        }
    }, [mgr, search, direction, stateFilter, sortBy]);

    useEffect(() => { reload(); }, [reload]);

    const clearAll = async () => {
        if (!window.confirm('Delete all transfer history? This cannot be undone.')) return;
        await mgr.clear();
        reload();
    };
    const deleteOne = async (id) => { await mgr.delete(id); reload(); };
    const exportHistory = async () => {
        const json = await mgr.export();
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `linkspan-history-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };
    const toggleEnabled = () => setEnabled(mgr.setEnabled(!enabled));

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center px-4"
            style={{ background: 'rgba(0,0,0,0.6)' }}
            role="dialog"
            aria-modal="true"
            aria-label="Transfer history"
            data-testid="history-view"
        >
            <div
                className="w-full max-w-3xl rounded-2xl p-6 space-y-4 animate-fade-in"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
            >
                <div className="flex items-center justify-between">
                    <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Transfer history</h2>
                    <button type="button" onClick={onClose} data-testid="history-close" className="text-2xl leading-none" style={{ color: 'var(--text-muted)' }}>×</button>
                </div>

                {/* Controls */}
                <div className="flex flex-wrap gap-2">
                    <input
                        type="search"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search files, folders, devices…"
                        data-testid="history-search"
                        className="flex-1 min-w-[180px] rounded-lg px-3 py-2 text-sm outline-none"
                        style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}
                    />
                    <select value={direction} onChange={(e) => setDirection(e.target.value)} data-testid="history-direction" className="rounded-lg px-2 py-2 text-sm" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}>
                        <option value="">All</option>
                        <option value="send">Sent</option>
                        <option value="receive">Received</option>
                    </select>
                    <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} data-testid="history-state" className="rounded-lg px-2 py-2 text-sm" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}>
                        <option value="">Any status</option>
                        <option value="success">Done</option>
                        <option value="failed">Failed</option>
                        <option value="cancelled">Cancelled</option>
                        <option value="rejected">Rejected</option>
                    </select>
                    <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} data-testid="history-sort" className="rounded-lg px-2 py-2 text-sm" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}>
                        <option value="date">Newest</option>
                        <option value="size">Largest</option>
                        <option value="name">Name</option>
                    </select>
                </div>

                {/* List */}
                <div className="overflow-auto flex-1 space-y-2" style={{ minHeight: '120px' }}>
                    {loading ? (
                        <p className="text-center text-sm py-8" style={{ color: 'var(--text-muted)' }}>Loading…</p>
                    ) : rows.length === 0 ? (
                        <p className="text-center text-sm py-8" style={{ color: 'var(--text-muted)' }} data-testid="history-empty">No transfers yet.</p>
                    ) : (
                        rows.map((r) => {
                            const badge = STATE_BADGE[r.state] || STATE_BADGE.success;
                            return (
                                <div key={r.id} className="flex items-center gap-3 p-3 rounded-xl" style={{ background: 'var(--bg-primary)' }} data-testid="history-row">
                                    <div className="text-xl">{r.direction === 'receive' ? '⬇️' : '⬆️'}</div>
                                    <div className="flex-1 min-w-0">
                                        <p className="font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                                            {r.name || (r.fileNames?.[0]) || 'Transfer'}
                                            {r.fileCount > 1 ? ` (${r.fileCount} files)` : ''}
                                        </p>
                                        <p className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                                            {new Date(r.timestamp).toLocaleString()} · {formatSize(r.totalBytes)} · {formatDuration(r.durationMs)}
                                            {r.peerName ? ` · ${r.peerName}` : ''}
                                        </p>
                                    </div>
                                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ color: '#fff', background: badge.color }}>{badge.label}</span>
                                    <button type="button" onClick={() => deleteOne(r.id)} data-testid="history-delete" className="text-sm" style={{ color: 'var(--text-muted)' }} aria-label="Delete entry">🗑️</button>
                                </div>
                            );
                        })
                    )}
                </div>

                {/* Footer actions */}
                <div className="flex flex-wrap items-center gap-2 pt-2" style={{ borderTop: '1px solid var(--border-color)' }}>
                    <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                        <input type="checkbox" checked={enabled} onChange={toggleEnabled} data-testid="history-enabled" className="w-4 h-4" />
                        Record history
                    </label>
                    <label className="flex items-center gap-2 text-sm cursor-pointer mr-auto" style={{ color: 'var(--text-secondary)' }} title="Share anonymous, aggregate-only stats (outcome + coarse size/duration buckets). No filenames, sizes, or identities are ever sent.">
                        <input type="checkbox" checked={telemetry} onChange={() => setTelemetry(setTelemetryEnabled(!telemetry))} data-testid="telemetry-enabled" className="w-4 h-4" />
                        Share anonymous stats
                    </label>
                    <button type="button" onClick={exportHistory} className="btn-secondary text-sm" data-testid="history-export">Export</button>
                    <button type="button" onClick={clearAll} className="btn-secondary text-sm" data-testid="history-clear" style={{ color: '#e03131' }}>Clear all</button>
                </div>
            </div>
        </div>
    );
}
