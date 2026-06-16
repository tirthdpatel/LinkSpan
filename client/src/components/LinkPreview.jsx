import React from 'react';

/**
 * LinkPreview — receiver-side preview for a shared URL (Feature 9).
 *
 * Renders the domain, title and metadata of a received link and offers a one-click
 * "Open" plus copy-to-clipboard. The `link` object comes from
 * LinkPayload.parseLinkPayload, which has already RE-VALIDATED the URL to be a safe
 * http/https URL and HTML-escaped every field — so `safeHref` is safe to use as an
 * anchor target and the text fields are safe to render. If parsing failed (null),
 * the caller should not render this component.
 *
 * @param {object} props
 * @param {ReturnType<typeof import('../transfer/LinkPayload').parseLinkPayload>} props.link
 * @param {() => void} [props.onDone]
 */
export function LinkPreview({ link, onDone }) {
    const [copied, setCopied] = React.useState(false);
    if (!link) return null;

    const copy = async () => {
        try {
            if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(link.url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch { /* clipboard blocked — user can copy the visible URL */ }
    };

    const title = link.title || link.siteName || link.domain;

    return (
        <div className="w-full max-w-2xl space-y-4 animate-fade-in" data-testid="link-preview">
            <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                Received link
                <span className="ml-2 text-xs font-normal px-2 py-0.5 rounded-full"
                    style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}>
                    {link.domain}
                </span>
            </h3>

            <a
                href={link.safeHref}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="glass-card p-5 block space-y-2 hover:opacity-90 transition-opacity"
                data-testid="link-open"
            >
                <p className="font-semibold truncate" style={{ color: 'var(--text-primary)' }} data-testid="link-title">
                    {title}
                </p>
                {link.description && (
                    <p className="text-sm line-clamp-3" style={{ color: 'var(--text-secondary)' }} data-testid="link-description">
                        {link.description}
                    </p>
                )}
                <p className="text-xs truncate flex items-center gap-1" style={{ color: 'var(--gradient-start)' }} data-testid="link-url">
                    🔗 {link.url}
                </p>
            </a>

            <div className="flex flex-wrap gap-3">
                <a
                    href={link.safeHref}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="btn-primary"
                    data-testid="link-open-btn"
                >
                    Open link
                </a>
                <button type="button" onClick={copy} className="btn-secondary" data-testid="link-copy">
                    {copied ? 'Copied!' : 'Copy URL'}
                </button>
                {onDone && (
                    <button type="button" onClick={onDone} className="btn-secondary ml-auto" data-testid="link-done">
                        Done
                    </button>
                )}
            </div>
        </div>
    );
}
