import React from 'react';

export function Header({ darkMode, onToggleDark, onHome }) {
    return (
        <header className="w-full px-6 py-4 flex items-center justify-between relative z-10"
            style={{ borderBottom: '1px solid var(--border-color)' }}>
            <button
                onClick={onHome}
                className="flex items-center gap-3 transition-opacity hover:opacity-80"
                aria-label="Go to home page"
            >
                <div className="w-9 h-9 rounded-xl gradient-bg flex items-center justify-center">
                    <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                    </svg>
                </div>
                <span className="text-lg font-bold tracking-tight" style={{ color: 'var(--text-primary)' }}>
                    LinkSpan
                </span>
            </button>

            <button
                id="dark-mode-toggle"
                onClick={onToggleDark}
                className="w-10 h-10 rounded-xl flex items-center justify-center transition-all hover:scale-105"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}
                aria-label="Toggle dark mode"
            >
                {darkMode ? (
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} style={{ color: 'var(--text-primary)' }}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                    </svg>
                ) : (
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} style={{ color: 'var(--text-primary)' }}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                    </svg>
                )}
            </button>
        </header>
    );
}
