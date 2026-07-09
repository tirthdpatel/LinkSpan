import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Header } from './components/Header';
import { SendView } from './components/SendView';
import { ReceiveView } from './components/ReceiveView';
import { TransferProgress } from './components/TransferProgress';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { ConnectionMode } from './components/ConnectionMode';
import { SasVerification } from './components/SasVerification';
import { ReceiveConfirmation } from './components/ReceiveConfirmation';
import { TextPreview } from './components/TextPreview';
import { LinkPreview } from './components/LinkPreview';
import { HistoryView } from './components/HistoryView';
import { ContactsView } from './components/ContactsView';
import { RoomView } from './components/RoomView';
import { ShareLinkView } from './components/ShareLinkView';
import { parseShareViewerUrl } from './share/ShareLinkClient.js';
import { ErrorNotification } from './components/ErrorNotification';
import { SolarSystem } from './components/SolarSystem';
import { InteractiveCard, GlowIcon } from './components/InteractiveElements';
import { useConnection } from './hooks/useConnection';
import { EventLoopLoadMonitor, classifyBottleneck } from './transfer/BottleneckMonitor.js';
import { extractText } from './transfer/TextPayload';
import { parseLinkPayload, extractLinkText } from './transfer/LinkPayload';
import { TRANSFER_STATE, TRANSFER_TYPE } from '@shared/constants.js';

// ── Initial State ──────────────────────────────────────────────
const INITIAL_PROGRESS = {
    sentChunks: 0,
    totalChunks: 0,
    speed: 0,
    role: null,
    fileName: '',
    fileSize: 0,
    complete: false,
    paused: false,
    cancelled: false,
    // Batch/folder transfer aggregate fields
    totalFiles: 0,
    currentFileIndex: 0,
    batchTotalBytes: 0,
    batchBytesSent: 0,
    batchBytesReceived: 0,
};

const INITIAL_DIAGNOSTICS = {
    channelStats: [],
    rtt: null,
    retryCount: 0,
    verifiedChunks: 0,
    storageMode: '',
    stalled: false,
    relayMode: false,
    transport: null, // 'direct' | 'turn' | null — how the P2P connection is routed
    encrypted: false, // true once the ECDH session key is agreed (app-layer E2E)
    throughput: 0, // aggregate bytes/sec across all channels, sampled each second
    cpuLoad: 0, // main-thread busy fraction [0,1] — high ⇒ encryption/hashing bound
    lossRate: 0, // retransmit fraction [0,1] — high ⇒ lossy/high-latency path
    bottleneck: { verdict: 'idle', reason: '' }, // which lever would actually help
};

export default function App() {
    // ── Theme ─────────────────────────────────────────────────
    const [darkMode, setDarkMode] = useState(() => {
        if (typeof window !== 'undefined') {
            return (
                localStorage.getItem('linkspan-dark') === 'true' ||
                window.matchMedia('(prefers-color-scheme: dark)').matches
            );
        }
        return false;
    });

    // ── UI State ─────────────────────────────────────────────
    const [view, setView] = useState('home'); // home | send | receive | transferring | sharelink-create | sharelink-receive
    // When the page is opened as a share link (?s=<id>#k=<key>), hold the parsed reference.
    const [shareRef, setShareRef] = useState(null);
    const [pairingCode, setPairingCode] = useState('');
    const [sessionId, setSessionId] = useState('');
    const [transferState, setTransferState] = useState(TRANSFER_STATE.IDLE);
    const [error, setError] = useState(null);
    const [transferProgress, setTransferProgress] = useState(INITIAL_PROGRESS);
    const [diagnostics, setDiagnostics] = useState(INITIAL_DIAGNOSTICS);
    const [currentFileIndex, setCurrentFileIndex] = useState(0);
    // Short Authentication String pending user verification (null when none).
    const [sasCode, setSasCode] = useState(null);
    // Pending incoming-transfer approval request (Feature 4); null when none.
    const [receiveRequest, setReceiveRequest] = useState(null);
    // Received text payload awaiting preview (Feature 7); null when none.
    const [textPreview, setTextPreview] = useState(null);
    // Received link payload awaiting preview (Feature 9); null when none.
    const [linkPreview, setLinkPreview] = useState(null);
    // History panel visibility (Feature 6).
    const [showHistory, setShowHistory] = useState(false);
    // Contacts/saved-devices panel visibility (Feature 11).
    const [showContacts, setShowContacts] = useState(false);
    const [showRoom, setShowRoom] = useState(false);

    // Completed transfer — for download trigger
    const [completedBlob, setCompletedBlob] = useState(null);
    const [completedFileName, setCompletedFileName] = useState('');

    const diagIntervalRef = useRef(null);

    // ── Connection Hook ───────────────────────────────────────
    // All protocol/session/transfer logic lives here.
    // App.jsx is purely a UI coordinator.
    const {
        cleanup,
        handleSendFile: _handleSendFile,
        handleReceive: _handleReceive,
        handlePause,
        handleResume,
        handleCancel: _handleCancel,
        confirmSas,
        rejectSas,
        acceptReceive,
        declineReceive,
        chooseDestination,
        clearDestination,
        destinationSupported,
        history,
        remembered,
        getDiagnosticSnapshot,
        channelManagerRef,
        peerRef,
    } = useConnection({
        setTransferState,
        setTransferProgress,
        setDiagnostics,
        setError,
        setPairingCode,
        setSessionId,
        setView,
        setCurrentFileIndex,
        setSasCode,
        setReceiveRequest,
        onTransferComplete: async (blob, fileName, info = {}) => {
            // Text payloads open a preview (copy / save) instead of downloading.
            if (info.transferType === TRANSFER_TYPE.TEXT && blob) {
                try {
                    const text = await extractText(blob);
                    setTextPreview({ text, format: info.textFormat, fileName });
                    return;
                } catch { /* fall through to download */ }
            }
            // Link payloads open a link preview (open / copy) instead of downloading.
            if (info.transferType === TRANSFER_TYPE.LINK && blob) {
                try {
                    const link = parseLinkPayload(await extractLinkText(blob));
                    if (link) { setLinkPreview(link); return; }
                } catch { /* fall through to download */ }
            }
            // Written straight to the chosen folder (Feature 5) — nothing to download.
            if (info.writtenToDisk || !blob) return;
            setCompletedBlob(blob);
            setCompletedFileName(fileName);
        },
    });

    // ── Effects ───────────────────────────────────────────────

    useEffect(() => {
        document.documentElement.classList.toggle('dark', darkMode);
        localStorage.setItem('linkspan-dark', darkMode);
    }, [darkMode]);

    // Opened as a share link? Switch to the receive-share view. Runs once on mount.
    useEffect(() => {
        const ref = parseShareViewerUrl();
        if (ref) { setShareRef(ref); setView('sharelink-receive'); }
    }, []);

    // Trigger file download when a transfer completes
    useEffect(() => {
        if (completedBlob) {
            downloadBlob(completedBlob, completedFileName);
            setCompletedBlob(null);
        }
    }, [completedBlob, completedFileName]);

    // Diagnostics polling — only active during transfers. Also samples main-thread
    // load so the readout can name the bottleneck (CPU vs loss vs link) rather than
    // just show a speed the user can't interpret.
    useEffect(() => {
        if (view === 'transferring') {
            const cpuMonitor = new EventLoopLoadMonitor();
            cpuMonitor.start();
            diagIntervalRef.current = setInterval(async () => {
                const snap = await getDiagnosticSnapshot();
                if (snap) {
                    // channelStats throughput is bytes since the last reset (~1 s) per
                    // channel; summed it is the current aggregate bytes/sec.
                    const throughput = snap.channelStats.reduce((s, ch) => s + (ch.throughput || 0), 0);
                    const cpuLoad = cpuMonitor.load;
                    const lossRate = snap.lossRate ?? 0;
                    const bottleneck = classifyBottleneck({ throughputBps: throughput, lossRate, cpuLoad });
                    setDiagnostics((prev) => ({
                        ...prev,
                        channelStats: snap.channelStats,
                        rtt: snap.rtt ?? prev.rtt,
                        transport: snap.transport ?? prev.transport,
                        throughput,
                        cpuLoad,
                        lossRate,
                        bottleneck,
                    }));
                    channelManagerRef.current?.resetStats();
                }
            }, 1000);
            return () => {
                cpuMonitor.stop();
                if (diagIntervalRef.current) clearInterval(diagIntervalRef.current);
            };
        }
        return () => {
            if (diagIntervalRef.current) clearInterval(diagIntervalRef.current);
        };
    }, [view, getDiagnosticSnapshot, channelManagerRef]);

    // Cleanup on unmount
    useEffect(() => {
        return () => cleanup();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Action Wrappers ───────────────────────────────────────

    // Accepts a batch descriptor (see FileTree.buildBatch): { files, directories,
    // totalFiles, totalBytes, name }. SendView builds it from the file/folder input
    // or a drag-and-drop, so App stays a pure coordinator.
    const handleSendFile = useCallback(async (batch, sendOptions = {}) => {
        setCurrentFileIndex(0);
        setTransferProgress({ ...INITIAL_PROGRESS, totalFiles: batch.totalFiles });
        setDiagnostics(INITIAL_DIAGNOSTICS);
        await _handleSendFile(batch, sendOptions);
    }, [_handleSendFile]);

    const handleReceive = useCallback(async (code) => {
        setTransferProgress(INITIAL_PROGRESS);
        setDiagnostics(INITIAL_DIAGNOSTICS);
        await _handleReceive(code);
    }, [_handleReceive]);

    const handleCancel = useCallback(() => {
        _handleCancel();
        setTimeout(() => setView('home'), 2000);
    }, [_handleCancel]);

    const handleBack = useCallback(() => {
        cleanup();
        setView('home');
        setPairingCode('');
        setTransferState(TRANSFER_STATE.IDLE);
        setError(null);
        setTransferProgress(INITIAL_PROGRESS);
        setDiagnostics(INITIAL_DIAGNOSTICS);
        setReceiveRequest(null);
        setTextPreview(null);
        setLinkPreview(null);
    }, [cleanup]);

    // Feature 4 — receive-approval decisions.
    const handleAcceptReceive = useCallback((remember) => {
        acceptReceive(remember);
    }, [acceptReceive]);

    const handleDeclineReceive = useCallback(() => {
        declineReceive();
        setView('home');
        setPairingCode('');
        setTransferState(TRANSFER_STATE.IDLE);
    }, [declineReceive]);

    const handleTextDone = useCallback(() => {
        setTextPreview(null);
        setView('home');
        setTransferState(TRANSFER_STATE.IDLE);
    }, []);

    const handleLinkDone = useCallback(() => {
        setLinkPreview(null);
        setView('home');
        setTransferState(TRANSFER_STATE.IDLE);
    }, []);

    // User reported the security codes don't match — abort and return home.
    const handleSasReject = useCallback(() => {
        rejectSas();
        setError({ message: 'Security code did not match — transfer aborted for your safety.' });
        setView('home');
        setPairingCode('');
        setTransferState(TRANSFER_STATE.IDLE);
    }, [rejectSas]);

    // ── Download Helper ───────────────────────────────────────

    const formatBytes = (bytes) => {
        if (!bytes || bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
    };

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

    // ── Derived State ─────────────────────────────────────────

    const isTransferring =
        transferState === TRANSFER_STATE.TRANSFERRING ||
        transferState === TRANSFER_STATE.RESUMING;

    const isPeerConnected =
        transferState === TRANSFER_STATE.CONNECTED ||
        transferState === TRANSFER_STATE.TRANSFERRING ||
        transferState === TRANSFER_STATE.RESUMING;

    const isTransferComplete = transferProgress.complete;

    // Overall batch byte progress (sender uses batchBytesSent, receiver batchBytesReceived).
    const batchBytesDone = transferProgress.role === 'receiver'
        ? (transferProgress.batchBytesReceived || 0)
        : (transferProgress.batchBytesSent || 0);
    const batchPercent = transferProgress.batchTotalBytes > 0
        ? Math.min(100, Math.round((batchBytesDone / transferProgress.batchTotalBytes) * 100))
        : 0;

    // ── Render ────────────────────────────────────────────────

    return (
        <div
            className="min-h-screen flex flex-col relative"
            style={{ background: 'var(--bg-primary)' }}
            data-testid="app-root"
        >
            <SolarSystem
                darkMode={darkMode}
                transferProgress={
                    transferProgress.totalChunks > 0
                        ? transferProgress.sentChunks / transferProgress.totalChunks
                        : 0
                }
                isTransferring={isTransferring && !isTransferComplete}
            />
            <Header darkMode={darkMode} onToggleDark={() => setDarkMode((d) => !d)} />

            <main className="flex-1 flex flex-col items-center justify-center px-4 py-8 relative z-10">
                {error && (
                    <ErrorNotification
                        error={error}
                        onDismiss={() => setError(null)}
                        data-testid="error-notification"
                    />
                )}

                {/* ── SAS verification overlay (MITM defence) ───────── */}
                {sasCode && (
                    <SasVerification
                        code={sasCode}
                        onConfirm={confirmSas}
                        onReject={handleSasReject}
                    />
                )}

                {/* ── Receive confirmation overlay (Feature 4) ──────── */}
                {receiveRequest && !sasCode && (
                    <ReceiveConfirmation
                        request={receiveRequest}
                        onAccept={handleAcceptReceive}
                        onReject={handleDeclineReceive}
                    />
                )}

                {/* ── Transfer history panel (Feature 6) ────────────── */}
                {showHistory && (
                    <HistoryView history={history} onClose={() => setShowHistory(false)} />
                )}

                {/* ── Saved devices / contacts panel (Feature 11) ───── */}
                {showContacts && (
                    <ContactsView remembered={remembered} onClose={() => setShowContacts(false)} />
                )}

                {/* ── Group room (Phase 4: hybrid swarm, beta) ──────── */}
                {showRoom && (
                    <RoomView onClose={() => setShowRoom(false)} />
                )}

                {/* ── Home ──────────────────────────────────────────── */}
                {view === 'home' && (
                    <div className="w-full max-w-2xl space-y-8 animate-fade-in">
                        <div className="text-center space-y-4">
                            <h1 className="text-5xl md:text-6xl font-extrabold tracking-tight">
                                <span className="gradient-text">LinkSpan</span>
                            </h1>
                            <p className="text-lg md:text-xl" style={{ color: 'var(--text-secondary)' }}>
                                Free, encrypted, peer-to-peer file transfer.
                                <br />
                                No signup. No cloud storage on the default path.
                            </p>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 stagger-children">
                            <InteractiveCard
                                id="send-card"
                                onClick={() => setView('send')}
                                className="p-8 text-left animate-fade-in"
                                tiltOpts={{ maxTilt: 8, scale: 1.12 }}
                                data-testid="send-tab"
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

                            <InteractiveCard
                                id="receive-card"
                                onClick={() => setView('receive')}
                                className="p-8 text-left animate-fade-in"
                                tiltOpts={{ maxTilt: 8, scale: 1.12 }}
                                data-testid="receive-tab"
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

                        <div className="text-center flex items-center justify-center gap-6">
                            <button
                                type="button"
                                onClick={() => setShowHistory(true)}
                                data-testid="open-history"
                                className="text-sm font-medium underline hover:no-underline"
                                style={{ color: 'var(--text-muted)' }}
                            >
                                📜 Transfer history
                            </button>
                            <button
                                type="button"
                                onClick={() => setShowContacts(true)}
                                data-testid="open-contacts"
                                className="text-sm font-medium underline hover:no-underline"
                                style={{ color: 'var(--text-muted)' }}
                            >
                                💻 Saved devices
                            </button>
                            <button
                                type="button"
                                onClick={() => setShowRoom(true)}
                                data-testid="open-room"
                                className="text-sm font-medium underline hover:no-underline"
                                style={{ color: 'var(--text-muted)' }}
                            >
                                👥 Group room
                            </button>
                            <button
                                type="button"
                                onClick={() => setView('sharelink-create')}
                                data-testid="open-sharelink"
                                className="text-sm font-medium underline hover:no-underline"
                                style={{ color: 'var(--text-muted)' }}
                            >
                                🔗 Share link
                            </button>
                        </div>
                    </div>
                )}

                {/* ── Share link: create (async upload, no live peer) ─ */}
                {view === 'sharelink-create' && (
                    <div className="w-full max-w-2xl animate-fade-in" data-testid="sharelink-create-view">
                        <ShareLinkView mode="create" onClose={() => setView('home')} />
                    </div>
                )}

                {/* ── Share link: receive (opened from ?s=<id>#k=<key>) ─ */}
                {view === 'sharelink-receive' && shareRef && (
                    <div className="w-full max-w-2xl animate-fade-in" data-testid="sharelink-receive-view">
                        <ShareLinkView
                            mode="receive"
                            shareRef={shareRef}
                            onClose={() => { setShareRef(null); setView('home'); }}
                        />
                    </div>
                )}

                {/* ── Send ──────────────────────────────────────────── */}
                {view === 'send' && (
                    <div data-testid="send-view">
                        {/* data-testid on pairing code is rendered inside SendView */}
                        <SendView
                            pairingCode={pairingCode}
                            connectionState={transferState}
                            onFileSelect={handleSendFile}
                            onBack={handleBack}
                            peerConnected={isPeerConnected}
                        />
                    </div>
                )}

                {/* ── Receive ───────────────────────────────────────── */}
                {view === 'receive' && (
                    <div data-testid="receive-view">
                        <ReceiveView
                            connectionState={transferState}
                            onSubmitCode={handleReceive}
                            onBack={handleBack}
                            destinationSupported={destinationSupported}
                            onChooseDestination={chooseDestination}
                            onClearDestination={clearDestination}
                        />
                    </div>
                )}

                {/* ── Transferring ───────────────────────────────────── */}
                {view === 'transferring' && (
                    <div
                        className="w-full max-w-2xl space-y-6 animate-fade-in"
                        data-testid="transfer-view"
                    >
                        {/* Connection mode — explicit, honest routing + encryption status */}
                        {isPeerConnected && (
                            <div data-testid="peer-connected">
                                <ConnectionMode
                                    relayMode={diagnostics.relayMode}
                                    transport={diagnostics.transport}
                                    encrypted={diagnostics.encrypted}
                                />
                            </div>
                        )}

                        {/* Multi-file / folder batch indicator + overall progress */}
                        {transferProgress.totalFiles > 1 && (
                            <div
                                className="space-y-2 py-3 px-4 rounded-2xl"
                                style={{ background: 'var(--bg-secondary)' }}
                                data-testid="file-queue-indicator"
                            >
                                <div className="flex items-center justify-between text-sm" style={{ color: 'var(--text-muted)' }}>
                                    <span>File {Math.min(currentFileIndex + 1, transferProgress.totalFiles)} of {transferProgress.totalFiles}</span>
                                    <span>{formatBytes(batchBytesDone)} / {formatBytes(transferProgress.batchTotalBytes)}</span>
                                </div>
                                <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--border-color)' }}>
                                    <div
                                        className="h-full gradient-bg transition-all duration-300"
                                        style={{ width: `${batchPercent}%` }}
                                        data-testid="batch-progress-bar"
                                    />
                                </div>
                            </div>
                        )}

                        <TransferProgress
                            {...transferProgress}
                            transferState={transferState}
                            onPause={handlePause}
                            onResume={handleResume}
                            onCancel={handleCancel}
                            data-testid="transfer-progress"
                        />

                        {/* Received text preview (Feature 7) */}
                        {textPreview && (
                            <TextPreview
                                text={textPreview.text}
                                format={textPreview.format}
                                fileName={textPreview.fileName}
                                onDone={handleTextDone}
                            />
                        )}

                        {/* Received link preview (Feature 9) */}
                        {linkPreview && (
                            <LinkPreview link={linkPreview} onDone={handleLinkDone} />
                        )}

                        {/* Transfer complete indicator for E2E tests */}
                        {isTransferComplete && !textPreview && !linkPreview && (
                            <div
                                className="text-center py-4 rounded-xl space-y-3"
                                style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                                data-testid="transfer-complete"
                            >
                                <div>
                                    {transferProgress.savedToDisk
                                        ? `✅ Transfer complete — saved to ${transferProgress.savedLocation || 'your folder'}`
                                        : '✅ Transfer complete — file downloaded'}
                                </div>
                                <button
                                    type="button"
                                    onClick={handleBack}
                                    data-testid="transfer-complete-home"
                                    className="rounded-lg px-5 py-2 font-medium gradient-bg"
                                    style={{ color: '#fff' }}
                                >
                                    Back to home
                                </button>
                            </div>
                        )}

                        <DiagnosticsPanel {...diagnostics} />
                    </div>
                )}
            </main>

            <footer
                className="text-center py-4 text-xs relative z-10"
                style={{ color: 'var(--text-muted)' }}
            >
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
