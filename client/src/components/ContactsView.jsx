import React, { useState, useEffect, useCallback } from 'react';

/** Relative "last seen" label. */
function lastSeenLabel(ts) {
    if (!ts) return 'never';
    const diff = Date.now() - ts;
    const s = Math.round(diff / 1000);
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.round(h / 24);
    return `${d}d ago`;
}

const TYPE_ICON = {
    desktop: '🖥️',
    mobile: '📱',
    tablet: '📟',
    unknown: '❓',
};

/**
 * ContactsView — the trusted-device / contact list (Features 10 & 11).
 *
 * Reads from the local IndexedDB-backed RememberedDevices store (shared with the
 * connection hook's auto-approve gate). Supports search, favorite, inline rename,
 * and remove. An optional `onlineIds` set lights up devices currently connected in
 * this session. Removing a device here also revokes its auto-approval.
 *
 * @param {object} props
 * @param {() => import('../storage/RememberedDevices').RememberedDevices} props.remembered
 * @param {Set<string>} [props.onlineIds] - device ids currently online this session
 * @param {() => void} props.onClose
 */
export function ContactsView({ remembered, onlineIds = new Set(), onClose }) {
    const mgr = remembered();
    const [rows, setRows] = useState([]);
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(true);
    const [editingId, setEditingId] = useState(null);
    const [editName, setEditName] = useState('');

    const reload = useCallback(async () => {
        setLoading(true);
        try {
            setRows(await mgr.list({ search }));
        } catch {
            setRows([]);
        } finally {
            setLoading(false);
        }
    }, [mgr, search]);

    useEffect(() => { reload(); }, [reload]);

    const toggleFavorite = async (d) => { await mgr.setFavorite(d.deviceId, !d.favorite); reload(); };
    const remove = async (d) => {
        if (!window.confirm(`Remove "${d.deviceName}"? It will no longer be auto-approved.`)) return;
        await mgr.forget(d.deviceId);
        reload();
    };
    const startRename = (d) => { setEditingId(d.deviceId); setEditName(d.deviceName); };
    const commitRename = async (d) => {
        await mgr.rename(d.deviceId, editName);
        setEditingId(null);
        reload();
    };

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center px-4"
            style={{ background: 'rgba(0,0,0,0.6)' }}
            role="dialog"
            aria-modal="true"
            aria-label="Saved devices"
            data-testid="contacts-view"
        >
            <div
                className="w-full max-w-2xl rounded-2xl p-6 space-y-4 animate-fade-in"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
            >
                <div className="flex items-center justify-between">
                    <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Saved devices</h2>
                    <button type="button" onClick={onClose} data-testid="contacts-close" className="text-2xl leading-none" style={{ color: 'var(--text-muted)' }}>×</button>
                </div>

                <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search devices…"
                    data-testid="contacts-search"
                    className="rounded-lg px-3 py-2 text-sm outline-none"
                    style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}
                />

                <div className="overflow-auto flex-1 space-y-2" style={{ minHeight: '120px' }}>
                    {loading ? (
                        <p className="text-center text-sm py-8" style={{ color: 'var(--text-muted)' }}>Loading…</p>
                    ) : rows.length === 0 ? (
                        <p className="text-center text-sm py-8" style={{ color: 'var(--text-muted)' }} data-testid="contacts-empty">
                            No saved devices yet. Accept &amp; remember a sender to add one.
                        </p>
                    ) : (
                        rows.map((d) => {
                            const online = onlineIds.has(d.deviceId);
                            return (
                                <div key={d.deviceId} className="flex items-center gap-3 p-3 rounded-xl" style={{ background: 'var(--bg-primary)' }} data-testid="contact-row">
                                    <div className="text-xl relative">
                                        {TYPE_ICON[d.deviceType] || TYPE_ICON.unknown}
                                        <span
                                            className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ${online ? 'bg-green-500' : ''}`}
                                            style={online ? {} : { background: 'var(--border-color)' }}
                                            title={online ? 'Online' : `Last seen ${lastSeenLabel(d.lastSeen)}`}
                                        />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        {editingId === d.deviceId ? (
                                            <input
                                                autoFocus
                                                value={editName}
                                                onChange={(e) => setEditName(e.target.value)}
                                                onBlur={() => commitRename(d)}
                                                onKeyDown={(e) => { if (e.key === 'Enter') commitRename(d); }}
                                                data-testid="contact-rename-input"
                                                className="w-full rounded px-2 py-1 text-sm outline-none"
                                                style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--gradient-start)' }}
                                            />
                                        ) : (
                                            <p className="font-medium truncate" style={{ color: 'var(--text-primary)' }} data-testid="contact-name">
                                                {d.deviceName}
                                            </p>
                                        )}
                                        <p className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                                            {d.platform || d.deviceType}{' · '}
                                            {online ? 'Online now' : `Last seen ${lastSeenLabel(d.lastSeen)}`}
                                        </p>
                                    </div>
                                    <button type="button" onClick={() => toggleFavorite(d)} data-testid="contact-favorite" aria-label="Favorite" className="text-lg">
                                        {d.favorite ? '⭐' : '☆'}
                                    </button>
                                    <button type="button" onClick={() => startRename(d)} data-testid="contact-rename" aria-label="Rename" className="text-sm" style={{ color: 'var(--text-muted)' }}>✏️</button>
                                    <button type="button" onClick={() => remove(d)} data-testid="contact-remove" aria-label="Remove" className="text-sm" style={{ color: 'var(--text-muted)' }}>🗑️</button>
                                </div>
                            );
                        })
                    )}
                </div>
            </div>
        </div>
    );
}
