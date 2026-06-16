import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ShareLinkClient } from '../share/ShareLinkClient.js';

/**
 * ShareLinkView — browser UI for the asynchronous share-link transport (upload now, the
 * recipient downloads later; no live peer). Content is encrypted client-side by default
 * (AES-256-GCM via CryptoEngine) and the key rides the share URL #fragment, so the server
 * stores ciphertext only. See docs/architecture/trust-model.md §8.
 *
 * Two modes in one component:
 *   - mode="create"  → pick a file, choose options, get a shareable link.
 *   - mode="receive" → opened from `?s=<id>#k=<key>`; downloads, decrypts and saves.
 */
export function ShareLinkView({ mode, shareRef, onClose }) {
    const clientRef = useRef(null);
    if (!clientRef.current) clientRef.current = new ShareLinkClient();

    return mode === 'receive'
        ? <ReceiveShare client={clientRef.current} shareRef={shareRef} onClose={onClose} />
        : <CreateShare client={clientRef.current} onClose={onClose} />;
}

// ── Create ──────────────────────────────────────────────────────
function CreateShare({ client, onClose }) {
    const [file, setFile] = useState(null);
    const [expiresIn, setExpiresIn] = useState('24h');
    const [password, setPassword] = useState('');
    const [singleUse, setSingleUse] = useState(false);
    const [encrypt, setEncrypt] = useState(true);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);
    const [copied, setCopied] = useState(false);

    const create = useCallback(async () => {
        if (!file) return;
        setBusy(true); setError(null);
        try {
            const link = await client.createShare(file, {
                filename: file.name,
                expiresIn,
                password: password || undefined,
                singleUse,
                encrypt,
            });
            setResult(link);
        } catch (err) {
            setError(err.message || 'Failed to create share link');
        } finally {
            setBusy(false);
        }
    }, [client, file, expiresIn, password, singleUse, encrypt]);

    const copy = useCallback(() => {
        if (!result) return;
        navigator.clipboard?.writeText(result.shareUrl).then(() => {
            setCopied(true); setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
    }, [result]);

    if (result) {
        return (
            <div data-testid="sharelink-result" className="max-w-xl mx-auto p-6 space-y-4">
                <h2 className="text-xl font-semibold">Share link ready</h2>
                <p className="text-sm opacity-80">
                    {result.key
                        ? 'Encrypted end-to-end. The decryption key is in the link — anyone with the full link can open it, so share it privately.'
                        : 'Unencrypted — the server can read this content. Anyone with the link can open it.'}
                </p>
                <div className="flex gap-2">
                    <input data-testid="sharelink-url" readOnly value={result.shareUrl}
                        className="flex-1 px-3 py-2 rounded border bg-transparent text-sm" />
                    <button data-testid="sharelink-copy" onClick={copy} className="px-3 py-2 rounded bg-blue-600 text-white text-sm">
                        {copied ? 'Copied' : 'Copy'}
                    </button>
                </div>
                <p className="text-xs opacity-70">Expires {new Date(result.expiresAt).toLocaleString()}.
                    {result.ownerToken ? ' Keep the owner token to revoke it later.' : ''}</p>
                <button onClick={onClose} className="text-sm underline opacity-80">Done</button>
            </div>
        );
    }

    return (
        <div data-testid="sharelink-create" className="max-w-xl mx-auto p-6 space-y-4">
            <h2 className="text-xl font-semibold">Create a share link</h2>
            <p className="text-sm opacity-80">Upload a file for someone to download later — no need for both of you to be online.</p>

            <input data-testid="sharelink-file" type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} />

            <div className="grid grid-cols-2 gap-3 text-sm">
                <label className="flex flex-col gap-1">
                    Expires
                    <select value={expiresIn} onChange={(e) => setExpiresIn(e.target.value)} className="px-2 py-1 rounded border bg-transparent">
                        <option value="5m">5 minutes</option>
                        <option value="1h">1 hour</option>
                        <option value="24h">24 hours</option>
                        <option value="7d">7 days</option>
                    </select>
                </label>
                <label className="flex flex-col gap-1">
                    Password (optional)
                    <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                        className="px-2 py-1 rounded border bg-transparent" autoComplete="new-password" />
                </label>
            </div>
            <div className="flex gap-4 text-sm">
                <label className="flex items-center gap-2">
                    <input type="checkbox" checked={singleUse} onChange={(e) => setSingleUse(e.target.checked)} /> Single use
                </label>
                <label className="flex items-center gap-2">
                    <input data-testid="sharelink-encrypt" type="checkbox" checked={encrypt} onChange={(e) => setEncrypt(e.target.checked)} /> Encrypt (recommended)
                </label>
            </div>

            {error && <p data-testid="sharelink-error" className="text-sm text-red-500">{error}</p>}

            <div className="flex gap-3">
                <button data-testid="sharelink-create-btn" disabled={!file || busy} onClick={create}
                    className="px-4 py-2 rounded bg-blue-600 text-white text-sm disabled:opacity-50">
                    {busy ? 'Uploading…' : 'Create link'}
                </button>
                <button onClick={onClose} className="text-sm underline opacity-80">Cancel</button>
            </div>
        </div>
    );
}

// ── Receive ─────────────────────────────────────────────────────
function ReceiveShare({ client, shareRef, onClose }) {
    const [meta, setMeta] = useState(null);
    const [status, setStatus] = useState('loading'); // loading | need-password | ready | downloading | done | error
    const [password, setPassword] = useState('');
    const [error, setError] = useState(null);
    const [savedName, setSavedName] = useState(null);

    useEffect(() => {
        let cancelled = false;
        client.getMeta(shareRef.id)
            .then((m) => { if (!cancelled) { setMeta(m); setStatus(m.passwordProtected ? 'need-password' : 'ready'); } })
            .catch((err) => { if (!cancelled) { setError(err.message); setStatus('error'); } });
        return () => { cancelled = true; };
    }, [client, shareRef.id]);

    const download = useCallback(async () => {
        setStatus('downloading'); setError(null);
        try {
            const { blob, filename } = await client.download(shareRef.id, { key: shareRef.key, password: password || undefined });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 10_000);
            setSavedName(filename); setStatus('done');
        } catch (err) {
            setError(err.message || 'Download failed');
            setStatus(meta?.passwordProtected ? 'need-password' : 'error');
        }
    }, [client, shareRef, password, meta]);

    return (
        <div data-testid="sharelink-receive" className="max-w-xl mx-auto p-6 space-y-4">
            <h2 className="text-xl font-semibold">Shared file</h2>
            {status === 'loading' && <p className="text-sm opacity-80">Loading…</p>}
            {meta && (
                <p className="text-sm opacity-80">
                    <strong>{meta.filename}</strong>{typeof meta.size === 'number' ? ` · ${formatBytes(meta.size)}` : ''}
                    {shareRef.key ? ' · encrypted' : ''}
                </p>
            )}
            {status === 'need-password' && (
                <label className="flex flex-col gap-1 text-sm">
                    Password required
                    <input data-testid="sharelink-pw" type="password" value={password}
                        onChange={(e) => setPassword(e.target.value)} className="px-2 py-1 rounded border bg-transparent" />
                </label>
            )}
            {error && <p data-testid="sharelink-recv-error" className="text-sm text-red-500">{error}</p>}
            {status === 'done'
                ? <p data-testid="sharelink-done" className="text-sm text-green-500">Saved {savedName}.</p>
                : (status !== 'loading' && status !== 'error') && (
                    <button data-testid="sharelink-download" disabled={status === 'downloading'} onClick={download}
                        className="px-4 py-2 rounded bg-blue-600 text-white text-sm disabled:opacity-50">
                        {status === 'downloading' ? 'Downloading…' : 'Download'}
                    </button>
                )}
            <div><button onClick={onClose} className="text-sm underline opacity-80">Close</button></div>
        </div>
    );
}

function formatBytes(n) {
    if (!Number.isFinite(n)) return '';
    const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${i === 0 ? v : v.toFixed(1)} ${u[i]}`;
}
