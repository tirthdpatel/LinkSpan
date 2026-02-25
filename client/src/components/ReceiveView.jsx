import React, { useState, useRef, useEffect } from 'react';

export function ReceiveView({ connectionState, onSubmitCode, onBack }) {
    const [code, setCode] = useState(['', '', '', '', '', '']);
    const [useScanner, setUseScanner] = useState(false);
    const inputRefs = useRef([]);
    const scannerRef = useRef(null);
    const scannerInstanceRef = useRef(null);

    useEffect(() => {
        // Focus first input on mount
        inputRefs.current[0]?.focus();
    }, []);

    useEffect(() => {
        // Check URL params for code (from QR code link)
        const params = new URLSearchParams(window.location.search);
        const urlCode = params.get('code');
        if (urlCode && urlCode.length === 6) {
            const digits = urlCode.split('');
            setCode(digits);
            onSubmitCode(urlCode);
            // Clean URL
            window.history.replaceState({}, document.title, window.location.pathname);
        }
    }, []);

    const handleDigitChange = (index, value) => {
        if (!/^\d*$/.test(value)) return;

        const newCode = [...code];
        newCode[index] = value.slice(-1);
        setCode(newCode);

        // Auto-advance to next input
        if (value && index < 5) {
            inputRefs.current[index + 1]?.focus();
        }

        // Auto-submit when all digits entered
        if (newCode.every((d) => d !== '') && newCode.join('').length === 6) {
            setTimeout(() => onSubmitCode(newCode.join('')), 100);
        }
    };

    const handleKeyDown = (index, e) => {
        if (e.key === 'Backspace' && !code[index] && index > 0) {
            inputRefs.current[index - 1]?.focus();
        }
    };

    const handlePaste = (e) => {
        const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
        if (pasted.length === 6) {
            const digits = pasted.split('');
            setCode(digits);
            setTimeout(() => onSubmitCode(pasted), 100);
        }
    };

    const startScanner = async () => {
        setUseScanner(true);
        try {
            const { Html5Qrcode } = await import('html5-qrcode');
            const scanner = new Html5Qrcode('qr-reader');
            scannerInstanceRef.current = scanner;

            await scanner.start(
                { facingMode: 'environment' },
                { fps: 10, qrbox: { width: 250, height: 250 } },
                (decodedText) => {
                    // Extract code from URL or raw code
                    let extractedCode = decodedText;
                    try {
                        const url = new URL(decodedText);
                        extractedCode = url.searchParams.get('code') || decodedText;
                    } catch { /* not a URL */ }

                    if (/^\d{6}$/.test(extractedCode)) {
                        scanner.stop().catch(() => { });
                        setCode(extractedCode.split(''));
                        onSubmitCode(extractedCode);
                    }
                },
                () => { } // QR scan error (expected on each non-QR frame)
            );
        } catch (err) {
            console.error('[ReceiveView] Scanner error:', err);
            setUseScanner(false);
        }
    };

    const stopScanner = async () => {
        if (scannerInstanceRef.current) {
            try { await scannerInstanceRef.current.stop(); } catch { /* noop */ }
        }
        setUseScanner(false);
    };

    return (
        <div className="w-full max-w-lg space-y-6 animate-slide-up">
            {/* Back Button */}
            <button onClick={() => { stopScanner(); onBack(); }} className="flex items-center gap-2 text-sm font-medium hover:opacity-70 transition-opacity" style={{ color: 'var(--text-muted)' }}>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
                Back
            </button>

            <h2 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Receive a File</h2>

            {/* Manual Code Entry */}
            <div className="glass-card p-6 space-y-4">
                <p className="text-sm font-medium text-center" style={{ color: 'var(--text-muted)' }}>Enter the 6-digit pairing code</p>

                <div className="flex items-center justify-center gap-2" onPaste={handlePaste}>
                    {code.map((digit, i) => (
                        <input
                            key={i}
                            ref={(el) => (inputRefs.current[i] = el)}
                            type="text"
                            inputMode="numeric"
                            maxLength={1}
                            value={digit}
                            onChange={(e) => handleDigitChange(i, e.target.value)}
                            onKeyDown={(e) => handleKeyDown(i, e)}
                            className="w-12 h-14 text-center text-2xl font-bold rounded-xl outline-none transition-all duration-200"
                            style={{
                                background: 'var(--bg-secondary)',
                                color: 'var(--text-primary)',
                                border: `1.5px solid ${digit ? 'var(--gradient-start)' : 'var(--border-color)'}`,
                            }}
                            id={`code-digit-${i}`}
                            aria-label={`Digit ${i + 1}`}
                        />
                    ))}
                </div>

                {/* Connection Status */}
                {connectionState !== 'disconnected' && (
                    <div className="flex items-center justify-center gap-2 pt-2">
                        <span className={`w-2 h-2 rounded-full ${connectionState === 'connected' ? 'bg-green-500' : 'bg-yellow-500 animate-pulse'}`} />
                        <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
                            {connectionState === 'connecting'
                                ? 'Connecting...'
                                : connectionState === 'connected'
                                    ? 'Connected! Waiting for file...'
                                    : connectionState}
                        </span>
                    </div>
                )}
            </div>

            {/* QR Scanner */}
            <div className="text-center">
                <div className="inline-flex items-center gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                    <span className="h-px w-8" style={{ background: 'var(--border-color)' }} />
                    or
                    <span className="h-px w-8" style={{ background: 'var(--border-color)' }} />
                </div>
            </div>

            {!useScanner ? (
                <button
                    id="scan-qr-btn"
                    onClick={startScanner}
                    className="btn-secondary w-full flex items-center justify-center gap-3"
                >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 9V5a2 2 0 012-2h4M21 9V5a2 2 0 00-2-2h-4M3 15v4a2 2 0 002 2h4M21 15v4a2 2 0 01-2 2h-4" />
                    </svg>
                    Scan QR Code
                </button>
            ) : (
                <div className="glass-card p-4 space-y-3">
                    <div id="qr-reader" ref={scannerRef} className="rounded-xl overflow-hidden" />
                    <button
                        onClick={stopScanner}
                        className="btn-secondary w-full text-sm"
                    >
                        Cancel Scan
                    </button>
                </div>
            )}
        </div>
    );
}
