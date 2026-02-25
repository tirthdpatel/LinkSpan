import React, { useState, useRef, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';

export function SendView({ pairingCode, connectionState, onFileSelect, onBack }) {
    const [selectedFile, setSelectedFile] = useState(null);
    const [isDragging, setIsDragging] = useState(false);
    const inputRef = useRef(null);

    const handleDrop = useCallback((e) => {
        e.preventDefault();
        setIsDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) {
            setSelectedFile(file);
            onFileSelect(file);
        }
    }, [onFileSelect]);

    const handleFileChange = (e) => {
        const file = e.target.files[0];
        if (file) {
            setSelectedFile(file);
            onFileSelect(file);
        }
    };

    const formatSize = (bytes) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    const qrUrl = pairingCode
        ? `${window.location.origin}?code=${pairingCode}`
        : '';

    return (
        <div className="w-full max-w-lg space-y-6 animate-slide-up">
            {/* Back Button */}
            <button onClick={onBack} className="flex items-center gap-2 text-sm font-medium hover:opacity-70 transition-opacity" style={{ color: 'var(--text-muted)' }}>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
                Back
            </button>

            <h2 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Send a File</h2>

            {/* File Drop Zone */}
            {!selectedFile && (
                <div
                    id="drop-zone"
                    className={`drop-zone ${isDragging ? 'active' : ''}`}
                    onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={handleDrop}
                    onClick={() => inputRef.current?.click()}
                >
                    <input
                        ref={inputRef}
                        type="file"
                        className="hidden"
                        onChange={handleFileChange}
                        id="file-input"
                    />
                    <div className="animate-float">
                        <svg className="w-16 h-16 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}
                            style={{ color: 'var(--gradient-start)' }}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                        </svg>
                    </div>
                    <p className="text-base font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                        Drop your file here
                    </p>
                    <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                        or click to browse • any file type • up to browser limit
                    </p>
                </div>
            )}

            {/* Selected File Info */}
            {selectedFile && (
                <div className="glass-card p-5 flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl gradient-bg flex items-center justify-center flex-shrink-0">
                        <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                        <p className="font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{selectedFile.name}</p>
                        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{formatSize(selectedFile.size)}</p>
                    </div>
                    <div className={`chip ${connectionState === 'connected' ? 'chip-success' : 'chip-warning'}`}>
                        {connectionState === 'connected' ? 'Connected' : 'Waiting...'}
                    </div>
                </div>
            )}

            {/* Pairing Code + QR */}
            {pairingCode && (
                <div className="glass-card p-6 text-center space-y-4">
                    <p className="text-sm font-medium" style={{ color: 'var(--text-muted)' }}>Share this code with the receiver</p>

                    <div className="flex items-center justify-center gap-2">
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

                    {/* Connection Status */}
                    <div className="flex items-center justify-center gap-2 pt-2">
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
