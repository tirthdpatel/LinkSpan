import React from 'react';

/**
 * SasVerification — modal overlay shown on both peers after the ECDH handshake.
 *
 * Displays the Short Authentication String (SAS) and asks the user to compare it
 * with the other device before any file data flows. Matching codes prove there is
 * no active man-in-the-middle on the (otherwise unauthenticated) key exchange;
 * different codes mean someone substituted keys and the transfer must be aborted.
 *
 * @param {object} props
 * @param {string} props.code - the 6-digit SAS, e.g. "123 456"
 * @param {Function} props.onConfirm - user asserts the codes match
 * @param {Function} props.onReject - user asserts they differ / aborts
 */
export function SasVerification({ code, onConfirm, onReject }) {
    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center px-4"
            style={{ background: 'rgba(0,0,0,0.6)' }}
            data-testid="sas-verification"
            role="dialog"
            aria-modal="true"
            aria-label="Verify security code"
        >
            <div
                className="w-full max-w-md rounded-2xl p-8 space-y-6 animate-fade-in"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color, rgba(255,255,255,0.1))' }}
            >
                <div className="text-center space-y-2">
                    <div className="text-3xl">🔐</div>
                    <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
                        Verify security code
                    </h2>
                    <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                        Compare this code with the other device. Confirm <strong>only</strong> if they
                        match — a mismatch means the connection may be intercepted.
                    </p>
                </div>

                <div
                    className="text-center py-6 rounded-xl select-all"
                    style={{ background: 'var(--bg-primary)' }}
                    data-testid="sas-code"
                >
                    <span
                        className="text-4xl font-mono font-extrabold tracking-[0.2em]"
                        style={{ color: 'var(--text-primary)' }}
                    >
                        {code}
                    </span>
                </div>

                <div className="grid grid-cols-2 gap-3">
                    <button
                        type="button"
                        onClick={onReject}
                        data-testid="sas-reject"
                        className="py-3 px-4 rounded-xl font-semibold transition-colors"
                        style={{ background: 'var(--bg-primary)', color: 'var(--text-secondary)' }}
                    >
                        Codes differ
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        data-testid="sas-confirm"
                        className="py-3 px-4 rounded-xl font-semibold text-white transition-transform hover:scale-[1.02]"
                        style={{ background: 'var(--gradient-start, #4c6ef5)' }}
                    >
                        Codes match
                    </button>
                </div>
            </div>
        </div>
    );
}
