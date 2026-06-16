import React, { useEffect, useState } from 'react';

export function ErrorNotification({ error, onDismiss, ...rest }) {
    const [visible, setVisible] = useState(true);

    useEffect(() => {
        const timer = setTimeout(() => {
            setVisible(false);
            setTimeout(onDismiss, 300);
        }, 8000);
        return () => clearTimeout(timer);
    }, [onDismiss]);

    const message = typeof error === 'string' ? error : error?.message || 'An error occurred';

    return (
        <div
            role="alert"
            className={`fixed top-4 right-4 z-50 max-w-sm transition-all duration-300 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4'
                }`}
            {...rest}
        >
            <div className="glass-card p-4 flex items-start gap-3"
                style={{ borderColor: 'rgba(250, 82, 82, 0.3)', boxShadow: '0 4px 24px rgba(250, 82, 82, 0.15)' }}>
                <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(250, 82, 82, 0.1)' }}>
                    <svg className="w-4 h-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                    </svg>
                </div>
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Error</p>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{message}</p>
                </div>
                <button
                    onClick={() => { setVisible(false); setTimeout(onDismiss, 300); }}
                    className="flex-shrink-0 hover:opacity-70 transition-opacity"
                    aria-label="Dismiss error"
                >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} style={{ color: 'var(--text-muted)' }}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
            </div>
        </div>
    );
}
