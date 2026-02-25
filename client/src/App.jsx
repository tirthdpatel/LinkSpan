import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Header } from './components/Header';
import { SendView } from './components/SendView';
import { ReceiveView } from './components/ReceiveView';
import { TransferProgress } from './components/TransferProgress';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { ErrorNotification } from './components/ErrorNotification';
import { SolarSystem } from './components/SolarSystem';
import { InteractiveCard, GlowIcon } from './components/InteractiveElements';
import { SignalingClient } from './core/SignalingClient';
import { PeerConnection } from './core/PeerConnection';
import { ChannelManager } from './core/ChannelManager';
import { Sender } from './transfer/Sender';
import { Receiver } from './transfer/Receiver';
import { StorageManager } from './storage/StorageManager';
import { ResumeManager } from './storage/ResumeManager';
import { TRANSFER_MSG } from '@shared/constants.js';

const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL || 'ws://localhost:10000';

export default function App() {
    const [darkMode, setDarkMode] = useState(() => {
        if (typeof window !== 'undefined') {
            return localStorage.getItem('linkspan-dark') === 'true' ||
                window.matchMedia('(prefers-color-scheme: dark)').matches;
        }
        return false;
    });

    const [view, setView] = useState('home'); // home | send | receive | transferring
    const [pairingCode, setPairingCode] = useState('');
    const [sessionId, setSessionId] = useState('');
    const [connectionState, setConnectionState] = useState('disconnected');
    const [error, setError] = useState(null);

    // Transfer state
    const [transferProgress, setTransferProgress] = useState({
        sentChunks: 0,
        totalChunks: 0,
        speed: 0,
        role: null, // 'sender' | 'receiver'
        fileName: '',
        fileSize: 0,
        complete: false,
    });

    // Diagnostics
    const [diagnostics, setDiagnostics] = useState({
        channelStats: [],
        rtt: null,
        retryCount: 0,
        verifiedChunks: 0,
        storageMode: '',
    });

    // Refs for engine instances
    const signalingRef = useRef(null);
    const peerRef = useRef(null);
    const channelManagerRef = useRef(null);
    const senderRef = useRef(null);
    const receiverRef = useRef(null);
    const storageManagerRef = useRef(null);
    const resumeManagerRef = useRef(null);
    const diagIntervalRef = useRef(null);

    // Toggle dark mode
    useEffect(() => {
        document.documentElement.classList.toggle('dark', darkMode);
        localStorage.setItem('linkspan-dark', darkMode);
    }, [darkMode]);

    // Diagnostics polling
    useEffect(() => {
        if (view === 'transferring') {
            diagIntervalRef.current = setInterval(async () => {
                const cm = channelManagerRef.current;
                const pc = peerRef.current;
                if (cm && pc) {
                    const channelStats = cm.getChannelStats();
                    const pcStats = await pc.getStats();
                    setDiagnostics((prev) => ({
                        ...prev,
                        channelStats,
                        rtt: pcStats?.rtt,
                    }));
                    cm.resetStats();
                }
            }, 1000);
        }
        return () => {
            if (diagIntervalRef.current) clearInterval(diagIntervalRef.current);
        };
    }, [view]);

    // Cleanup on unmount
    useEffect(() => {
        return () => cleanup();
    }, []);

    const cleanup = () => {
        if (diagIntervalRef.current) clearInterval(diagIntervalRef.current);
        senderRef.current?.stop();
        receiverRef.current?.stop();
        channelManagerRef.current?.closeAll();
        peerRef.current?.close();
        signalingRef.current?.disconnect();
    };

    // ── Initialize Signaling + Peer Connection ────────────────

    const initConnection = useCallback(async (role, code = null) => {
        try {
            setConnectionState('connecting');
            setError(null);

            const signaling = new SignalingClient(SIGNALING_URL);
            signalingRef.current = signaling;

            const channelManager = new ChannelManager();
            channelManagerRef.current = channelManager;

            const peer = new PeerConnection({
                onIceCandidate: (candidate) => signaling.sendIceCandidate(candidate),
                onChannel: () => { },
                onConnectionStateChange: (state) => {
                    setConnectionState(state);
                    if (state === 'failed' || state === 'disconnected') {
                        setError({ message: 'Peer connection lost. Refresh to retry.' });
                    }
                },
            });
            peerRef.current = peer;
            peer.init();

            // Setup signaling handlers
            signaling.on('session-created', (data) => {
                setSessionId(data.sessionId);
                if (data.pairingCode) {
                    setPairingCode(data.pairingCode);
                }
            });

            signaling.on('peer-joined', async () => {
                // Sender creates the offer when peer joins
                if (role === 'sender') {
                    peer.createChannels((ch, i) => {
                        if (i === 0) {
                            // All channels use negotiated IDs, so they open on both sides
                        }
                    });
                    channelManager.setChannels(peer.channels);

                    const offer = await peer.createOffer();
                    signaling.sendOffer(offer);
                }
            });

            signaling.on('offer', async (offer) => {
                await peer.setRemoteDescription(offer);
                // Receiver creates channels (negotiated, same IDs)
                peer.createChannels(() => { });
                channelManager.setChannels(peer.channels);

                const answer = await peer.createAnswer();
                signaling.sendAnswer(answer);
            });

            signaling.on('answer', async (answer) => {
                await peer.setRemoteDescription(answer);
            });

            signaling.on('ice-candidate', async (candidate) => {
                await peer.addIceCandidate(candidate);
            });

            signaling.on('error', (err) => {
                setError(err);
                setConnectionState('disconnected');
            });

            signaling.on('session-closed', () => {
                setError({ message: 'Session closed by the other peer.' });
                setConnectionState('disconnected');
            });

            signaling.on('disconnected', () => {
                if (connectionState !== 'connected') {
                    setConnectionState('reconnecting');
                }
            });

            // Connect
            await signaling.connect();

            if (role === 'sender') {
                signaling.createSession();
            } else {
                signaling.joinSession(code);
            }
        } catch (err) {
            setError({ message: err.message || 'Failed to connect.' });
            setConnectionState('disconnected');
        }
    }, []);

    // ── Send File ─────────────────────────────────────────────

    const handleSendFile = useCallback(async (file) => {
        setView('send');
        await initConnection('sender');

        // Wait for channels to be ready, then start sender
        const waitForChannels = setInterval(() => {
            const cm = channelManagerRef.current;
            if (cm && cm.getReadyCount() >= 1) {
                clearInterval(waitForChannels);

                const sender = new Sender(file, cm, (sent, total, speed) => {
                    setTransferProgress({
                        sentChunks: sent,
                        totalChunks: total,
                        speed,
                        role: 'sender',
                        fileName: file.name,
                        fileSize: file.size,
                        complete: sent === total,
                    });
                });
                senderRef.current = sender;

                // Send file metadata via first channel
                const meta = sender.getFileMeta();
                const metaMsg = JSON.stringify({ type: TRANSFER_MSG.FILE_META, ...meta });
                cm.send(0, metaMsg).then(() => {
                    sender.start();
                    setView('transferring');
                    setTransferProgress((prev) => ({
                        ...prev,
                        totalChunks: meta.totalChunks,
                        fileName: file.name,
                        fileSize: file.size,
                        role: 'sender',
                    }));
                });
            }
        }, 200);
    }, [initConnection]);

    // ── Receive File ──────────────────────────────────────────

    const handleReceive = useCallback(async (code) => {
        setView('receive');
        await initConnection('receiver', code);

        const cm = channelManagerRef.current;
        const storage = new StorageManager();
        storageManagerRef.current = storage;
        const resume = new ResumeManager();
        resumeManagerRef.current = resume;

        setDiagnostics((prev) => ({ ...prev, storageMode: storage.getMode() }));

        // Wait for file metadata from sender
        const waitForMeta = setInterval(() => {
            if (cm && cm.isConnected()) {
                clearInterval(waitForMeta);

                cm.onMessage(async (rawData) => {
                    if (typeof rawData === 'string') {
                        try {
                            const msg = JSON.parse(rawData);
                            if (msg.type === TRANSFER_MSG.FILE_META) {
                                // Got file meta — start receiver
                                const receiver = new Receiver(
                                    msg,
                                    cm,
                                    storage,
                                    (received, total, speed) => {
                                        setTransferProgress({
                                            sentChunks: received,
                                            totalChunks: total,
                                            speed,
                                            role: 'receiver',
                                            fileName: msg.fileName,
                                            fileSize: msg.fileSize,
                                            complete: received === total,
                                        });
                                        resume.markChunkReceived(msg.fileId, received - 1);
                                    },
                                    async (blob) => {
                                        // Transfer complete — trigger download
                                        downloadBlob(blob, msg.fileName);
                                        setTransferProgress((prev) => ({ ...prev, complete: true }));
                                        await resume.clear(msg.fileId);
                                    },
                                    (err) => {
                                        setError({ message: err.message });
                                    }
                                );
                                receiverRef.current = receiver;
                                await receiver.start();
                                setView('transferring');
                            }
                        } catch { /* not JSON */ }
                    }
                });
            }
        }, 200);
    }, [initConnection]);

    // ── Download Helper ───────────────────────────────────────

    const downloadBlob = (blob, fileName) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    // ── Render ────────────────────────────────────────────────

    return (
        <div className="min-h-screen flex flex-col relative" style={{ background: 'var(--bg-primary)' }}>
            <SolarSystem
                darkMode={darkMode}
                transferProgress={transferProgress.totalChunks > 0 ? transferProgress.sentChunks / transferProgress.totalChunks : 0}
                isTransferring={view === 'transferring' && !transferProgress.complete}
            />
            <Header darkMode={darkMode} onToggleDark={() => setDarkMode((d) => !d)} />

            <main className="flex-1 flex flex-col items-center justify-center px-4 py-8 relative z-10">
                {error && (
                    <ErrorNotification
                        error={error}
                        onDismiss={() => setError(null)}
                    />
                )}

                {view === 'home' && (
                    <div className="w-full max-w-2xl space-y-8 animate-fade-in">
                        {/* Hero */}
                        <div className="text-center space-y-4">
                            <h1 className="text-5xl md:text-6xl font-extrabold tracking-tight">
                                <span className="gradient-text">LinkSpan</span>
                            </h1>
                            <p className="text-lg md:text-xl" style={{ color: 'var(--text-secondary)' }}>
                                Free, encrypted, peer-to-peer file transfer.
                                <br />
                                No signup. No cloud. No limits.
                            </p>
                        </div>

                        {/* Action Cards — 3D tilt + glow border + glare */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 stagger-children">
                            {/* Send Card */}
                            <InteractiveCard
                                id="send-card"
                                onClick={() => setView('send')}
                                className="p-8 text-left animate-fade-in"
                                tiltOpts={{ maxTilt: 8, scale: 1.12 }}
                            >
                                <GlowIcon>
                                    <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                                    </svg>
                                </GlowIcon>
                                <h2 className="text-xl font-bold mb-2 mt-4" style={{ color: 'var(--text-primary)' }}>Send Files</h2>
                                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                                    Select files and share via QR code or pairing code
                                </p>
                            </InteractiveCard>

                            {/* Receive Card */}
                            <InteractiveCard
                                id="receive-card"
                                onClick={() => setView('receive')}
                                className="p-8 text-left animate-fade-in"
                                tiltOpts={{ maxTilt: 8, scale: 1.12 }}
                            >
                                <GlowIcon color="#40c057">
                                    <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                    </svg>
                                </GlowIcon>
                                <h2 className="text-xl font-bold mb-2 mt-4" style={{ color: 'var(--text-primary)' }}>Receive Files</h2>
                                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                                    Scan QR code or enter pairing code to receive
                                </p>
                            </InteractiveCard>
                        </div>

                        {/* Features — dock-style magnification */}
                        <div className="dock-container pt-4">
                            {[
                                { icon: '🔒', label: 'E2E Encrypted' },
                                { icon: '⚡', label: '7× Parallel' },
                                { icon: '📱', label: 'Mobile Ready' },
                                { icon: '♻️', label: 'Resume Support' },
                            ].map((f) => (
                                <div key={f.label} className="dock-item stat-card text-center py-3 px-5 animate-fade-in">
                                    <div className="text-2xl mb-1">{f.icon}</div>
                                    <div className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>{f.label}</div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {view === 'send' && (
                    <SendView
                        pairingCode={pairingCode}
                        connectionState={connectionState}
                        onFileSelect={handleSendFile}
                        onBack={() => { cleanup(); setView('home'); }}
                    />
                )}

                {view === 'receive' && (
                    <ReceiveView
                        connectionState={connectionState}
                        onSubmitCode={handleReceive}
                        onBack={() => { cleanup(); setView('home'); }}
                    />
                )}

                {view === 'transferring' && (
                    <div className="w-full max-w-2xl space-y-6 animate-fade-in">
                        <TransferProgress {...transferProgress} />
                        <DiagnosticsPanel {...diagnostics} />
                    </div>
                )}
            </main>

            {/* Footer */}
            <footer className="text-center py-4 text-xs relative z-10" style={{ color: 'var(--text-muted)' }}>
                LinkSpan — Open source, zero cost, peer-to-peer.{' '}
                <a
                    href="https://github.com/linkspan"
                    className="underline hover:no-underline"
                    style={{ color: 'var(--gradient-start)' }}
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    GitHub
                </a>
            </footer>
        </div>
    );
}
