import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { entriesFromInput, entriesFromDataTransfer, buildBatch } from '../transfer/FileTree';
import { buildTextBatch } from '../transfer/TextPayload';
import { buildLinkBatch } from '../transfer/LinkPayload';
import { readClipboard, clipboardItemsToBatch, isClipboardReadSupported } from '../transfer/ClipboardPayload';
import { buildDeepLink } from '../core/DeepLink';
import { TEXT_FORMAT, DEEP_LINK_ACTION } from '@shared/constants.js';

function formatSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function SendView({ pairingCode, connectionState, onFileSelect, onBack }) {
    const [mode, setMode] = useState('files'); // 'files' | 'text'
    const [batch, setBatch] = useState(null);
    const [isDragging, setIsDragging] = useState(false);
    const [validationError, setValidationError] = useState(null);
    const [textValue, setTextValue] = useState('');
    const [textFormat, setTextFormat] = useState(TEXT_FORMAT.PLAIN);
    const [linkValue, setLinkValue] = useState('');
    const [linkTitle, setLinkTitle] = useState('');
    const fileInputRef = useRef(null);
    const folderInputRef = useRef(null);
    const clipboardSupported = isClipboardReadSupported();

    // Directory-selection attributes aren't part of React's JSX prop set, so apply
    // them imperatively. All three flavors are set for cross-browser coverage.
    useEffect(() => {
        const el = folderInputRef.current;
        if (el) {
            el.setAttribute('webkitdirectory', '');
            el.setAttribute('directory', '');
            el.setAttribute('mozdirectory', '');
        }
    }, []);

    // Turn raw entries into a validated batch, surface it, and start the transfer.
    const commitBatch = useCallback((raw) => {
        setValidationError(null);
        try {
            const built = buildBatch(raw);
            if (built.totalFiles === 0 && built.directories.length === 0) {
                setValidationError('No files were found in that selection.');
                return;
            }
            setBatch(built);
            onFileSelect(built);
        } catch (err) {
            setValidationError(err.message || 'That selection could not be sent.');
        }
    }, [onFileSelect]);

    const handleDrop = useCallback(async (e) => {
        e.preventDefault();
        setIsDragging(false);
        // Prefer the Entries API (supports folders); fall back to the flat file list.
        const dt = e.dataTransfer;
        try {
            if (dt.items && dt.items.length > 0 && dt.items[0].webkitGetAsEntry) {
                const raw = await entriesFromDataTransfer(dt.items);
                commitBatch(raw);
            } else if (dt.files && dt.files.length > 0) {
                commitBatch(entriesFromInput(dt.files));
            }
        } catch (err) {
            setValidationError(err.message || 'Could not read the dropped items.');
        }
    }, [commitBatch]);

    const handleFileChange = (e) => {
        if (e.target.files && e.target.files.length > 0) {
            commitBatch(entriesFromInput(e.target.files));
        }
    };

    // Compose-and-send a text payload (Feature 7). Rides the same engine as files.
    const sendText = useCallback(() => {
        setValidationError(null);
        try {
            const built = buildTextBatch(textValue, textFormat);
            setBatch(built);
            onFileSelect(built, { transferType: 'text', textFormat });
        } catch (err) {
            setValidationError(err.message || 'That text could not be sent.');
        }
    }, [textValue, textFormat, onFileSelect]);

    // Compose-and-send a link payload (Feature 9). The URL is validated/sanitized in
    // buildLinkBatch; only http/https links are ever accepted.
    const sendLink = useCallback(() => {
        setValidationError(null);
        try {
            const built = buildLinkBatch(linkValue, { title: linkTitle });
            setBatch(built);
            onFileSelect(built, { transferType: 'link' });
        } catch (err) {
            setValidationError(err.message || 'That link could not be sent.');
        }
    }, [linkValue, linkTitle, onFileSelect]);

    // Paste-and-send from the system clipboard (Feature 8). Text → text transfer,
    // images/files → a files batch. Falls back gracefully when the read is blocked.
    const sendClipboard = useCallback(async () => {
        setValidationError(null);
        try {
            const items = await readClipboard();
            const { batch: built, sendOptions } = clipboardItemsToBatch(items);
            setBatch(built);
            onFileSelect(built, sendOptions);
        } catch (err) {
            setValidationError(err.message || 'Could not read the clipboard. Try pasting into the text box instead.');
        }
    }, [onFileSelect]);

    const fileCount = batch?.totalFiles ?? 0;
    const folderCount = batch?.directories.length ?? 0;

    // Deep link carries the pairing code plus an expiring token (Feature 13), so a
    // leaked/over-the-shoulder QR stops working after the session window. Memoized
    // per code so the QR is stable across re-renders.
    const deepLink = useMemo(
        () => (pairingCode ? buildDeepLink({ code: pairingCode, action: DEEP_LINK_ACTION.PAIR }) : null),
        [pairingCode]
    );
    const qrUrl = deepLink?.url || '';

    return (
        <div className="w-full max-w-lg space-y-6 animate-slide-up">
            {/* Back Button */}
            <button onClick={onBack} className="flex items-center gap-2 text-sm font-medium hover:opacity-70 transition-opacity" style={{ color: 'var(--text-muted)' }}>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
                Back
            </button>

            <h2 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                {mode === 'text' ? 'Send Text' : mode === 'link' ? 'Send a Link' : 'Send Files & Folders'}
            </h2>

            {/* Mode toggle (Files / Text / Link) — hidden once a transfer is staged */}
            {!batch && (
                <div className="grid grid-cols-3 gap-2 p-1 rounded-xl" style={{ background: 'var(--bg-secondary)' }}>
                    {[
                        { id: 'files', label: 'Files' },
                        { id: 'text', label: 'Text' },
                        { id: 'link', label: 'Link' },
                    ].map((m) => (
                        <button
                            key={m.id}
                            type="button"
                            onClick={() => { setMode(m.id); setValidationError(null); }}
                            data-testid={`send-mode-${m.id}`}
                            className="py-2 rounded-lg text-sm font-semibold transition-colors"
                            style={mode === m.id
                                ? { background: 'var(--gradient-start, #4c6ef5)', color: '#fff' }
                                : { color: 'var(--text-muted)' }}
                        >
                            {m.label}
                        </button>
                    ))}
                </div>
            )}

            {/* Text composer */}
            {!batch && mode === 'text' && (
                <div className="space-y-3" data-testid="text-composer">
                    <div className="flex gap-2">
                        {[
                            { id: TEXT_FORMAT.PLAIN, label: 'Plain' },
                            { id: TEXT_FORMAT.MARKDOWN, label: 'Markdown' },
                            { id: TEXT_FORMAT.CODE, label: 'Code' },
                        ].map((f) => (
                            <button
                                key={f.id}
                                type="button"
                                onClick={() => setTextFormat(f.id)}
                                data-testid={`text-format-${f.id}`}
                                className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                                style={textFormat === f.id
                                    ? { background: 'var(--gradient-start, #4c6ef5)', color: '#fff' }
                                    : { background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}
                            >
                                {f.label}
                            </button>
                        ))}
                    </div>
                    <textarea
                        value={textValue}
                        onChange={(e) => setTextValue(e.target.value)}
                        placeholder={textFormat === TEXT_FORMAT.CODE ? 'Paste a code snippet…' : 'Type or paste text, links, or Markdown…'}
                        rows={10}
                        data-testid="text-input"
                        className="w-full rounded-xl p-4 outline-none resize-y font-mono text-sm"
                        style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}
                    />
                    <div className="flex items-center justify-between">
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            {new TextEncoder().encode(textValue).length.toLocaleString()} bytes
                        </span>
                        <button
                            type="button"
                            onClick={sendText}
                            disabled={textValue.length === 0}
                            data-testid="text-send-btn"
                            className="btn-primary disabled:opacity-50"
                        >
                            Send text
                        </button>
                    </div>
                    {validationError && (
                        <p className="text-sm text-center" style={{ color: 'var(--danger, #e03131)' }} data-testid="send-validation-error">
                            {validationError}
                        </p>
                    )}
                </div>
            )}

            {/* Link composer (Feature 9) */}
            {!batch && mode === 'link' && (
                <div className="space-y-3" data-testid="link-composer">
                    <input
                        type="url"
                        inputMode="url"
                        value={linkValue}
                        onChange={(e) => setLinkValue(e.target.value)}
                        placeholder="https://example.com/article"
                        data-testid="link-input"
                        className="w-full rounded-xl p-4 outline-none text-sm"
                        style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}
                    />
                    <input
                        type="text"
                        value={linkTitle}
                        onChange={(e) => setLinkTitle(e.target.value)}
                        placeholder="Optional title or note"
                        data-testid="link-title-input"
                        maxLength={256}
                        className="w-full rounded-xl p-4 outline-none text-sm"
                        style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}
                    />
                    <div className="flex items-center justify-between">
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            Only http/https links are shared
                        </span>
                        <button
                            type="button"
                            onClick={sendLink}
                            disabled={linkValue.trim().length === 0}
                            data-testid="link-send-btn"
                            className="btn-primary disabled:opacity-50"
                        >
                            Send link
                        </button>
                    </div>
                    {validationError && (
                        <p className="text-sm text-center" style={{ color: 'var(--danger, #e03131)' }} data-testid="send-validation-error">
                            {validationError}
                        </p>
                    )}
                </div>
            )}

            {/* Drop Zone */}
            {!batch && mode === 'files' && (
                <>
                    <div
                        id="drop-zone"
                        className={`drop-zone ${isDragging ? 'active' : ''}`}
                        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                        onDragLeave={() => setIsDragging(false)}
                        onDrop={handleDrop}
                        onClick={() => fileInputRef.current?.click()}
                        data-testid="drop-zone"
                    >
                        <input
                            ref={fileInputRef}
                            type="file"
                            multiple
                            className="hidden"
                            onChange={handleFileChange}
                            id="file-input"
                        />
                        {/* webkitdirectory enables whole-folder selection */}
                        <input
                            ref={folderInputRef}
                            type="file"
                            className="hidden"
                            onChange={handleFileChange}
                            id="folder-input"
                            // React lowercases these; set via ref attributes below.
                        />
                        <div className="animate-float">
                            <svg className="w-16 h-16 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}
                                style={{ color: 'var(--gradient-start)' }}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                            </svg>
                        </div>
                        <p className="text-base font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                            Drop files or folders here
                        </p>
                        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                            or use the buttons below • any type • nested folders supported
                        </p>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => fileInputRef.current?.click()}
                            data-testid="select-files-btn"
                        >
                            Select files
                        </button>
                        <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => folderInputRef.current?.click()}
                            data-testid="select-folder-btn"
                        >
                            Select folder
                        </button>
                    </div>

                    {/* Paste from clipboard (Feature 8) — text, images, or files */}
                    {clipboardSupported && (
                        <button
                            type="button"
                            className="btn-secondary w-full flex items-center justify-center gap-2"
                            onClick={sendClipboard}
                            data-testid="paste-clipboard-btn"
                        >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                            </svg>
                            Paste from clipboard
                        </button>
                    )}

                    {validationError && (
                        <p className="text-sm text-center" style={{ color: 'var(--danger, #e03131)' }} data-testid="send-validation-error">
                            {validationError}
                        </p>
                    )}
                </>
            )}

            {/* Selected Batch Summary */}
            {batch && (
                <div className="glass-card p-5 space-y-3" data-testid="batch-summary">
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-xl gradient-bg flex items-center justify-center flex-shrink-0">
                            <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                            </svg>
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{batch.name}</p>
                            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                                {fileCount} file{fileCount === 1 ? '' : 's'}
                                {folderCount > 0 ? ` • ${folderCount} folder${folderCount === 1 ? '' : 's'}` : ''}
                                {' • '}{formatSize(batch.totalBytes)}
                            </p>
                        </div>
                        <div className={`chip ${connectionState === 'connected' ? 'chip-success' : 'chip-warning'}`}>
                            {connectionState === 'connected' ? 'Connected' : 'Waiting...'}
                        </div>
                    </div>
                </div>
            )}

            {/* Pairing Code + QR */}
            {pairingCode && (
                <div className="glass-card p-6 text-center space-y-4">
                    <p className="text-sm font-medium" style={{ color: 'var(--text-muted)' }}>Share this code with the receiver</p>

                    <div
                        className="flex items-center justify-center gap-2"
                        data-testid="pairing-code"
                        aria-label="Pairing code"
                    >
                        {pairingCode.split('').map((digit, i) => (
                            <span
                                key={i}
                                className="w-12 h-14 flex items-center justify-center rounded-xl text-2xl font-bold"
                                style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}
                            >
                                {digit}
                            </span>
                        ))}
                    </div>

                    <div className="pt-2">
                        <div className="inline-block p-4 rounded-2xl" style={{ background: '#ffffff' }}>
                            <QRCodeSVG
                                value={qrUrl}
                                size={180}
                                level="M"
                                fgColor="#212529"
                                bgColor="#ffffff"
                            />
                        </div>
                    </div>

                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        Or scan this QR code from the receiving device
                    </p>

                    <div
                        className="flex items-center justify-center gap-2 pt-2"
                        data-testid={connectionState === 'connected' ? 'peer-connected' : undefined}
                    >
                        <span className={`w-2 h-2 rounded-full ${connectionState === 'connected' ? 'bg-green-500' : 'bg-yellow-500 animate-pulse'}`} />
                        <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
                            {connectionState === 'connected'
                                ? 'Peer connected'
                                : 'Waiting for peer to connect...'}
                        </span>
                    </div>
                </div>
            )}
        </div>
    );
}
