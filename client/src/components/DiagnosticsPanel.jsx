import React, { useState } from 'react';

export function DiagnosticsPanel({ channelStats = [], rtt, retryCount, verifiedChunks, storageMode }) {
    const [expanded, setExpanded] = useState(false);

    const formatThroughput = (bytesPerSec) => {
        if (bytesPerSec === 0) return '0 B/s';
        const k = 1024;
        const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
        const i = Math.floor(Math.log(bytesPerSec) / Math.log(k));
        return parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    };

    return (
        <div className="glass-card overflow-hidden animate-fade-in">
            {/* Toggle */}
            <button
                id="diagnostics-toggle"
                onClick={() => setExpanded(!expanded)}
                className="w-full px-6 py-4 flex items-center justify-between hover:opacity-80 transition-opacity"
            >
                <div className="flex items-center gap-2">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                        style={{ color: 'var(--gradient-start)' }}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                    </svg>
                    <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Diagnostics</span>
                </div>
                <svg
                    className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                    style={{ color: 'var(--text-muted)' }}
                >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
            </button>

            {expanded && (
                <div className="px-6 pb-5 space-y-4" style={{ borderTop: '1px solid var(--border-color)' }}>
                    {/* Overview Stats */}
                    <div className="grid grid-cols-3 gap-3 pt-4">
                        <div className="stat-card text-center">
                            <div className="text-sm font-bold font-mono" style={{ color: 'var(--text-primary)' }}>
                                {rtt !== null && rtt !== undefined ? `${(rtt * 1000).toFixed(0)}ms` : '--'}
                            </div>
                            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>RTT</div>
                        </div>
                        <div className="stat-card text-center">
                            <div className="text-sm font-bold font-mono" style={{ color: 'var(--text-primary)' }}>
                                {retryCount}
                            </div>
                            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Retries</div>
                        </div>
                        <div className="stat-card text-center">
                            <div className="text-sm font-bold font-mono" style={{ color: 'var(--text-primary)' }}>
                                {storageMode.toUpperCase() || '--'}
                            </div>
                            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Storage</div>
                        </div>
                    </div>

                    {/* Per-Channel Stats */}
                    {channelStats.length > 0 && (
                        <div>
                            <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-muted)' }}>Channel Throughput</p>
                            <div className="space-y-1.5">
                                {channelStats.map((ch) => (
                                    <div key={ch.index} className="flex items-center gap-2">
                                        <span className="text-xs font-mono w-6" style={{ color: 'var(--text-muted)' }}>
                                            #{ch.index}
                                        </span>
                                        <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-secondary)' }}>
                                            <div
                                                className="h-full rounded-full transition-all duration-300"
                                                style={{
                                                    width: `${Math.min((ch.throughput / (1024 * 1024)) * 10, 100)}%`,
                                                    background: ch.state === 'open'
                                                        ? 'linear-gradient(90deg, var(--gradient-start), var(--gradient-end))'
                                                        : 'var(--text-muted)',
                                                }}
                                            />
                                        </div>
                                        <span className="text-xs font-mono w-20 text-right" style={{ color: 'var(--text-muted)' }}>
                                            {formatThroughput(ch.throughput)}
                                        </span>
                                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${ch.state === 'open' ? 'bg-green-500' : 'bg-red-500'
                                            }`} />
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
