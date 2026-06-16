import React, { useState, useEffect } from 'react';
import { TRANSFER_TYPE, RECEIVE_APPROVAL_TIMEOUT_MS } from '@shared/constants.js';

function formatSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

const TYPE_LABEL = {
    [TRANSFER_TYPE.FILES]: 'Files',
    [TRANSFER_TYPE.FOLDER]: 'Folder',
    [TRANSFER_TYPE.MIXED]: 'Files & folders',
    [TRANSFER_TYPE.TEXT]: 'Text',
};
const TYPE_ICON = {
    [TRANSFER_TYPE.FILES]: '📄',
    [TRANSFER_TYPE.FOLDER]: '📁',
    [TRANSFER_TYPE.MIXED]: '🗂️',
    [TRANSFER_TYPE.TEXT]: '📝',
};

/**
 * ReceiveConfirmation — approval modal shown to the receiver after the secure
 * handshake, BEFORE any file data is requested (Feature 4).
 *
 * Surfaces who is sending, the device name, what's being sent (type, file/folder
 * count, total size) and lets the user Accept, Reject, or "Accept and remember this
 * device" for frictionless future transfers. The request auto-expires (mirroring
 * the sender's timeout) so a forgotten prompt can't hang an offer forever.
 *
 * @param {object} props
 * @param {object} props.request - the BATCH_META descriptor (sender + contents)
 * @param {(remember: boolean) => void} props.onAccept
 * @param {() => void} props.onReject
 */
export function ReceiveConfirmation({ request, onAccept, onReject }) {
    const [remember, setRemember] = useState(false);
    const [remaining, setRemaining] = useState(Math.round(RECEIVE_APPROVAL_TIMEOUT_MS / 1000));

    // Countdown + auto-decline on expiry, kept in lockstep with the sender timeout.
    useEffect(() => {
        const started = Date.now();
        const id = setInterval(() => {
            const left = Math.max(0, Math.round((RECEIVE_APPROVAL_TIMEOUT_MS - (Date.now() - started)) / 1000));
            setRemaining(left);
            if (left <= 0) { clearInterval(id); onReject(); }
        }, 1000);
        return () => clearInterval(id);
    }, [onReject]);

    if (!request) return null;
    const type = request.transferType || TRANSFER_TYPE.FILES;
    const fileCount = request.fileCount ?? request.totalFiles ?? 0;
    const folderCount = request.folderCount ?? (request.directories?.length ?? 0);

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center px-4"
            style={{ background: 'rgba(0,0,0,0.6)' }}
            data-testid="receive-confirmation"
            role="dialog"
            aria-modal="true"
            aria-label="Incoming transfer request"
        >
            <div
                className="w-full max-w-md rounded-2xl p-8 space-y-6 animate-fade-in"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color, rgba(255,255,255,0.1))' }}
            >
                <div className="text-center space-y-2">
                    <div className="text-3xl">{TYPE_ICON[type] || '📦'}</div>
                    <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
                        Incoming transfer
                    </h2>
                    <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                        <strong data-testid="rc-sender">{request.senderName || 'Unknown device'}</strong>
                        {' '}wants to send you {TYPE_LABEL[type]?.toLowerCase() || 'files'}.
                    </p>
                </div>

                <dl
                    className="rounded-xl divide-y text-sm"
                    style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-color)' }}
                    data-testid="rc-summary"
                >
                    <Row label="Type" value={TYPE_LABEL[type] || 'Files'} />
                    {type !== TRANSFER_TYPE.TEXT && (
                        <Row label="Files" value={String(fileCount)} testid="rc-files" />
                    )}
                    {folderCount > 0 && <Row label="Folders" value={String(folderCount)} testid="rc-folders" />}
                    <Row label="Total size" value={formatSize(request.totalBytes)} testid="rc-size" />
                </dl>

                <label className="flex items-center gap-3 text-sm cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                    <input
                        type="checkbox"
                        checked={remember}
                        onChange={(e) => setRemember(e.target.checked)}
                        data-testid="rc-remember"
                        className="w-4 h-4"
                    />
                    Accept and remember this device (auto-accept next time)
                </label>

                <div className="grid grid-cols-2 gap-3">
                    <button
                        type="button"
                        onClick={onReject}
                        data-testid="rc-reject"
                        className="py-3 px-4 rounded-xl font-semibold transition-colors"
                        style={{ background: 'var(--bg-primary)', color: 'var(--text-secondary)' }}
                    >
                        Reject
                    </button>
                    <button
                        type="button"
                        onClick={() => onAccept(remember)}
                        data-testid="rc-accept"
                        className="py-3 px-4 rounded-xl font-semibold text-white transition-transform hover:scale-[1.02]"
                        style={{ background: 'var(--gradient-start, #4c6ef5)' }}
                    >
                        Accept
                    </button>
                </div>
                <p className="text-center text-xs" style={{ color: 'var(--text-muted)' }}>
                    Expires in {remaining}s
                </p>
            </div>
        </div>
    );
}

function Row({ label, value, testid }) {
    return (
        <div className="flex items-center justify-between px-4 py-3">
            <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
            <dd className="font-medium" style={{ color: 'var(--text-primary)' }} data-testid={testid}>{value}</dd>
        </div>
    );
}
