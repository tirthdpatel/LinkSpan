import React, { useState, useMemo } from 'react';
import { TEXT_FORMAT } from '@shared/constants.js';
import { renderMarkdownSafe, escapeHtml, textFileName } from '../transfer/TextPayload';

/**
 * TextPreview — receiver-side preview for a shared text payload (Feature 7).
 *
 * Shows the received text with format-aware rendering (plain, Markdown, or code),
 * and offers Copy-to-clipboard and Save-as-file. Markdown is rendered via the
 * XSS-safe renderer in TextPayload (all input escaped before any tag is emitted),
 * and code/plain are shown as escaped, preformatted text — sender-controlled text
 * can never inject markup or script here.
 *
 * @param {object} props
 * @param {string} props.text - the received text
 * @param {string} [props.format] - one of TEXT_FORMAT
 * @param {string} [props.fileName]
 * @param {() => void} [props.onDone]
 */
export function TextPreview({ text, format = TEXT_FORMAT.PLAIN, fileName, onDone }) {
    const [copied, setCopied] = useState(false);
    const [rendered, setRendered] = useState(format === TEXT_FORMAT.MARKDOWN);

    const html = useMemo(() => {
        if (format === TEXT_FORMAT.MARKDOWN && rendered) return renderMarkdownSafe(text);
        return `<pre class="ls-text-pre">${escapeHtml(text)}</pre>`;
    }, [text, format, rendered]);

    const copy = async () => {
        try {
            if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch { /* clipboard blocked — user can select manually */ }
    };

    const save = () => {
        const ext = format === TEXT_FORMAT.MARKDOWN ? 'text/markdown' : 'text/plain';
        const blob = new Blob([text], { type: ext });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName || textFileName(format);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const bytes = new TextEncoder().encode(text).length;

    return (
        <div className="w-full max-w-2xl space-y-4 animate-fade-in" data-testid="text-preview">
            <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                    Received text
                    <span className="ml-2 text-xs font-normal px-2 py-0.5 rounded-full"
                        style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}>
                        {format}
                    </span>
                </h3>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{bytes.toLocaleString()} bytes</span>
            </div>

            <div
                className="glass-card p-5 overflow-auto ls-text-content"
                style={{ maxHeight: '50vh', color: 'var(--text-primary)' }}
                data-testid="text-preview-body"
                // Safe: `html` is produced exclusively by TextPayload's escape-first
                // renderer; no sender-controlled markup can reach the DOM here.
                dangerouslySetInnerHTML={{ __html: html }}
            />

            <div className="flex flex-wrap gap-3">
                <button type="button" onClick={copy} className="btn-primary" data-testid="text-copy">
                    {copied ? 'Copied!' : 'Copy'}
                </button>
                <button type="button" onClick={save} className="btn-secondary" data-testid="text-save">
                    Save as file
                </button>
                {format === TEXT_FORMAT.MARKDOWN && (
                    <button
                        type="button"
                        onClick={() => setRendered((r) => !r)}
                        className="btn-secondary"
                        data-testid="text-toggle-render"
                    >
                        {rendered ? 'View source' : 'Render Markdown'}
                    </button>
                )}
                {onDone && (
                    <button type="button" onClick={onDone} className="btn-secondary ml-auto" data-testid="text-done">
                        Done
                    </button>
                )}
            </div>
        </div>
    );
}
