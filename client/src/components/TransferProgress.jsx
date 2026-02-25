import React from 'react';

export function TransferProgress({ sentChunks, totalChunks, speed, role, fileName, fileSize, complete }) {
    const progress = totalChunks > 0 ? (sentChunks / totalChunks) * 100 : 0;

    const formatSize = (bytes) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    const formatSpeed = (bytesPerSec) => {
        return formatSize(bytesPerSec) + '/s';
    };

    const estimateETA = () => {
        if (speed <= 0 || complete) return '--';
        const remaining = ((totalChunks - sentChunks) * 256 * 1024); // approximate
        const seconds = remaining / speed;
        if (seconds < 60) return `${Math.ceil(seconds)}s`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`;
        return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
    };

    return (
        <div className="glass-card p-6 space-y-5 animate-fade-in">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${complete ? 'bg-green-500/10' : 'gradient-bg'}`}>
                        {complete ? (
                            <svg className="w-5 h-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                        ) : (
                            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d={role === 'sender'
                                    ? 'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12'
                                    : 'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4'
                                } />
                            </svg>
                        )}
                    </div>
                    <div>
                        <h3 className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                            {complete ? 'Transfer Complete!' : role === 'sender' ? 'Sending...' : 'Receiving...'}
                        </h3>
                        <p className="text-sm truncate max-w-48" style={{ color: 'var(--text-muted)' }}>{fileName}</p>
                    </div>
                </div>
                <span className={complete ? 'chip-success' : 'chip-info'}>
                    {complete ? 'Done' : `${progress.toFixed(1)}%`}
                </span>
            </div>

            {/* Progress Bar */}
            <div className="space-y-2">
                <div className="progress-bar-track">
                    <div
                        className="progress-bar-fill"
                        style={{ width: `${Math.min(progress, 100)}%` }}
                    />
                </div>

                <div className="flex items-center justify-between text-xs" style={{ color: 'var(--text-muted)' }}>
                    <span>{sentChunks.toLocaleString()} / {totalChunks.toLocaleString()} chunks</span>
                    <span>{formatSize(fileSize)}</span>
                </div>
            </div>

            {/* Stats Row */}
            <div className="grid grid-cols-3 gap-3">
                <div className="stat-card text-center">
                    <div className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                        {formatSpeed(speed)}
                    </div>
                    <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Speed</div>
                </div>
                <div className="stat-card text-center">
                    <div className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                        {estimateETA()}
                    </div>
                    <div className="text-xs" style={{ color: 'var(--text-muted)' }}>ETA</div>
                </div>
                <div className="stat-card text-center">
                    <div className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                        {progress.toFixed(1)}%
                    </div>
                    <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Progress</div>
                </div>
            </div>
        </div>
    );
}
