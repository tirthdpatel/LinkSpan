import { useCallback, useRef } from 'react';
import { SignalingClient } from '../core/SignalingClient';
import { PeerConnection } from '../core/PeerConnection';
import { ChannelManager } from '../core/ChannelManager';
import { RelayChannel } from '../core/RelayChannel';
import { BatchSender } from '../transfer/BatchSender';
import { BatchReceiver } from '../transfer/BatchReceiver';
import { StorageManager } from '../storage/StorageManager';
import { ResumeManager } from '../storage/ResumeManager';
import { RememberedDevices } from '../storage/RememberedDevices';
import { HistoryManager } from '../storage/HistoryManager';
import { DestinationManager, isFsAccessSupported } from '../storage/DestinationManager';
import { CryptoEngine } from '../crypto/CryptoEngine';
import { getLocalIdentity } from '../core/DeviceIdentity';
import { reportTransfer } from '../telemetry/Telemetry';
import { TRANSFER_MSG, TRANSFER_STATE, TRANSFER_TYPE } from '@shared/constants.js';

/**
 * Perform an ECDH key exchange over a channel (DataChannel or relay) and resolve
 * with the derived AES-256-GCM session key. Both peers run this symmetrically:
 * each sends its public key and derives the shared key from the peer's. The private
 * key never leaves the browser and the shared key is never transmitted, so an
 * intermediary (including the relay server) cannot read subsequent file chunks.
 *
 * The resolved value also carries a Short Authentication String (SAS) derived
 * from both public keys. The UI shows it on both peers so the users can compare
 * it out-of-band and detect an active MITM that substituted keys (the two sides
 * would then see different codes). See CryptoEngine.computeSAS.
 *
 * @param {{ onMessage: Function, sendAny: Function }} cm - channel manager or relay
 * @returns {Promise<{ key: CryptoKey, sas: string }>}
 */
function performKeyExchange(cm) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const fail = (err) => { if (!settled) { settled = true; reject(err); } };

        const timeout = setTimeout(() => fail(new Error('Key exchange timed out')), 15_000);

        CryptoEngine.generateECDHKeyPair()
            .then(async (keyPair) => {
                const ourPub = await CryptoEngine.exportPublicKey(keyPair);

                const handler = async (rawData) => {
                    if (settled || typeof rawData !== 'string') return;
                    let msg;
                    try { msg = JSON.parse(rawData); } catch { return; }
                    if (msg.type !== TRANSFER_MSG.KEY_EXCHANGE) return;
                    try {
                        const key = await CryptoEngine.deriveSharedKey(keyPair, msg.pub);
                        const sas = await CryptoEngine.computeSAS(ourPub, msg.pub);
                        settled = true;
                        clearTimeout(timeout);
                        cm.onMessage(null); // release the handshake handler
                        resolve({ key, sas });
                    } catch (err) {
                        clearTimeout(timeout);
                        fail(err);
                    }
                };
                cm.onMessage(handler);

                await cm.sendAny(JSON.stringify({ type: TRANSFER_MSG.KEY_EXCHANGE, pub: ourPub }));
            })
            .catch((err) => {
                clearTimeout(timeout);
                fail(err);
            });
    });
}

const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL || 'ws://localhost:10000';

// Dev/test switch: skip WebRTC and go straight to the server-relay path. On
// localhost, P2P always succeeds over loopback, so this is the only practical way
// to exercise (and manually verify) the encrypted relay fallback. Never enable in
// production — set VITE_FORCE_RELAY=true only for local relay testing.
const FORCE_RELAY = import.meta.env.VITE_FORCE_RELAY === 'true';

/**
 * useConnection — extracted connection and transfer orchestration hook.
 *
 * Moves all connection/session/transfer logic out of App.jsx so the component
 * becomes a pure UI coordinator. This reduces App.jsx from ~640 lines and
 * eliminates the coupling between UI state and transfer protocol details.
 *
 * @param {object} callbacks
 * @param {Function} callbacks.setTransferState
 * @param {Function} callbacks.setTransferProgress
 * @param {Function} callbacks.setDiagnostics
 * @param {Function} callbacks.setError
 * @param {Function} callbacks.setPairingCode
 * @param {Function} callbacks.setSessionId
 * @param {Function} callbacks.setView
 * @param {Function} callbacks.setCurrentFileIndex
 * @param {Function} callbacks.onTransferComplete   - (blob, fileName) => void
 */
export function useConnection({
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
    onTransferComplete,
}) {
    // ── Engine refs ─────────────────────────────────────────────
    const signalingRef = useRef(null);
    const peerRef = useRef(null);
    const channelManagerRef = useRef(null);
    const senderRef = useRef(null);
    const receiverRef = useRef(null);
    // Holds the {resolve, reject} of the in-flight SAS confirmation gate.
    const sasGateRef = useRef(null);
    // Holds the {resolve} of the in-flight receive-approval gate (Feature 4).
    const receiveGateRef = useRef(null);
    // Persistent stores (lazily reused across transfers in this session).
    const rememberedRef = useRef(null);
    const historyRef = useRef(null);
    const destManagerRef = useRef(null);
    // Per-transfer destination override (a directory handle) chosen by the user for
    // the next receive. Null → use saved default (or ZIP fallback).
    const destinationRef = useRef(null);
    // Start time of the active transfer, for history duration (Feature 6).
    const transferStartRef = useRef(0);
    // True once the transfer fell back to (or was forced onto) the server relay — used
    // only to tag opt-in aggregate telemetry as p2p vs relay.
    const relayActiveRef = useRef(false);

    const remembered = () => (rememberedRef.current ??= new RememberedDevices());
    const history = () => (historyRef.current ??= new HistoryManager());
    const destManager = () => (destManagerRef.current ??= new DestinationManager());

    // ── Cleanup ─────────────────────────────────────────────────

    const cleanup = useCallback(() => {
        senderRef.current?.stop();
        receiverRef.current?.stop();
        channelManagerRef.current?.closeAll();
        peerRef.current?.close();
        signalingRef.current?.disconnect();
        senderRef.current = null;
        receiverRef.current = null;
        channelManagerRef.current = null;
        peerRef.current = null;
        signalingRef.current = null;
        // Abort any pending SAS verification so its promise doesn't dangle.
        if (sasGateRef.current) {
            sasGateRef.current.reject(new Error('Connection closed.'));
            sasGateRef.current = null;
        }
        // Resolve any pending receive-approval gate as a decline.
        if (receiveGateRef.current) {
            const gate = receiveGateRef.current;
            receiveGateRef.current = null;
            gate.resolve({ accept: false });
        }
        setSasCode?.(null);
        setReceiveRequest?.(null);
    }, [setSasCode, setReceiveRequest]);

    // ── SAS verification gate ────────────────────────────────────

    /**
     * Show the Short Authentication String and block until the user confirms it
     * matches the other device. Rejects (aborting the transfer) if they decline.
     * @param {string} sas
     * @returns {Promise<void>}
     */
    const waitForSasConfirmation = useCallback((sas) => {
        return new Promise((resolve, reject) => {
            sasGateRef.current = { resolve, reject };
            setSasCode(sas);
        });
    }, [setSasCode]);

    const confirmSas = useCallback(() => {
        setSasCode(null);
        const gate = sasGateRef.current;
        sasGateRef.current = null;
        gate?.resolve();
    }, [setSasCode]);

    const rejectSas = useCallback(() => {
        const gate = sasGateRef.current;
        sasGateRef.current = null;
        setSasCode(null);
        gate?.reject(new Error('Security code did not match — transfer aborted.'));
        cleanup();
    }, [setSasCode, cleanup]);

    // ── Receive-approval gate (Feature 4) ────────────────────────
    // Surface the incoming-transfer offer to the UI and block the receiver until the
    // user decides. Auto-approval for remembered devices is handled in handleReceive
    // before this gate is ever opened.
    const waitForReceiveApproval = useCallback((meta) => {
        return new Promise((resolve) => {
            receiveGateRef.current = { resolve };
            setReceiveRequest(meta);
        });
    }, [setReceiveRequest]);

    /** Accept the pending incoming transfer. @param {boolean} remember */
    const acceptReceive = useCallback((remember = false) => {
        const gate = receiveGateRef.current;
        receiveGateRef.current = null;
        setReceiveRequest(null);
        gate?.resolve({ accept: true, remember: !!remember });
    }, [setReceiveRequest]);

    /** Decline the pending incoming transfer. */
    const declineReceive = useCallback(() => {
        const gate = receiveGateRef.current;
        receiveGateRef.current = null;
        setReceiveRequest(null);
        gate?.resolve({ accept: false });
    }, [setReceiveRequest]);

    // ── History recording (Feature 6) ────────────────────────────
    // Persist one record per completed/failed transfer. Fire-and-forget and fully
    // guarded: history must never block or break a transfer. Respects the user's
    // privacy toggle (HistoryManager no-ops when disabled).
    const _recordHistory = useCallback((direction, source, opts, state, errorMsg = null) => {
        try {
            const files = Array.isArray(source.files) ? source.files : [];
            const directories = Array.isArray(source.directories) ? source.directories : [];
            const transferType = opts?.transferType
                ?? source.transferType
                ?? (directories.length ? TRANSFER_TYPE.FOLDER : TRANSFER_TYPE.FILES);
            const record = {
                direction, // 'send' | 'receive'
                peerName: direction === 'receive' ? (source.senderName || null) : null,
                peerDeviceId: direction === 'receive' ? (source.senderDeviceId || null) : null,
                transferType,
                name: source.name || null,
                // Cap the stored name list so a huge batch can't bloat one record.
                fileNames: files.slice(0, 200).map((f) => f.relativePath),
                fileCount: source.totalFiles ?? files.length,
                folderNames: directories.slice(0, 200),
                folderCount: directories.length,
                totalBytes: source.totalBytes ?? 0,
                durationMs: transferStartRef.current ? Date.now() - transferStartRef.current : 0,
                state, // 'success' | 'failed' | 'cancelled' | 'rejected'
                error: errorMsg,
            };
            history().add(record).catch(() => { /* best-effort */ });

            // Opt-in aggregate telemetry (no-op unless the user enabled it). Only the
            // terminal outcomes; cancelled/rejected aren't transfer results. Fully
            // anonymized + bucketed inside reportTransfer; fire-and-forget.
            if (record.state === 'success' || record.state === 'failed') {
                reportTransfer({
                    success: record.state === 'success',
                    relay: relayActiveRef.current,
                    totalBytes: record.totalBytes,
                    durationMs: record.durationMs,
                }).catch(() => { /* telemetry never affects a transfer */ });
            }
        } catch { /* never let history break a transfer */ }
    }, []);

    // ── Download-location selection (Feature 5) ───────────────────
    const destinationSupported = isFsAccessSupported();

    /**
     * Prompt for a destination folder for the next received transfer.
     * @param {boolean} [asDefault] also persist it as the default destination
     * @returns {Promise<string|null>} the folder name, or null if cancelled
     */
    const chooseDestination = useCallback(async (asDefault = false) => {
        try {
            const handle = await destManager().pickDirectory();
            destinationRef.current = handle;
            if (asDefault) await destManager().saveDefault(handle).catch(() => {});
            return handle?.name ?? 'selected folder';
        } catch {
            return null; // user cancelled or unsupported
        }
    }, []);

    /** Clear the per-transfer destination override (revert to default/ZIP). */
    const clearDestination = useCallback(() => { destinationRef.current = null; }, []);

    // ── Connection Setup ─────────────────────────────────────────

    /**
     * Initialize signaling + peer connection.
     *
     * Tier-1: WebRTC DataChannels (10s timeout)
     * Tier-2: If WebRTC fails after ICE restart attempt, activate RelayChannel
     *
     * Returns a Promise that resolves with the active channel manager
     * (either ChannelManager or RelayChannel) once the first channel is ready.
     *
     * @param {'sender'|'receiver'} role
     * @param {string} [code] - pairing code (receiver only)
     * @returns {Promise<ChannelManager | RelayChannel>}
     */
    const initConnection = useCallback((role, code = null) => {
        // The executor wraps all of its async work in try/catch and routes every
        // failure through reject(), so the no-async-promise-executor footgun
        // (silently swallowed rejections) does not apply here.
        // eslint-disable-next-line no-async-promise-executor
        return new Promise(async (resolve, reject) => {
            try {
                setTransferState(TRANSFER_STATE.PAIRING);
                setError(null);

                const signaling = new SignalingClient(SIGNALING_URL);
                signalingRef.current = signaling;

                const channelManager = new ChannelManager();
                channelManagerRef.current = channelManager;

                // Event-driven channel-ready promise (no setInterval polling)
                let channelReadyResolve = null;
                const channelReadyPromise = new Promise((res) => {
                    channelReadyResolve = res;
                });

                // Switch the active channel to the server relay (fallback or forced).
                // Idempotent: only the first call resolves the channel-ready promise.
                let relayActivating = false;
                const activateRelay = async () => {
                    if (relayActivating || !channelReadyResolve) return;
                    relayActivating = true;
                    const relay = new RelayChannel(signaling);
                    await relay.activate();
                    channelManagerRef.current = relay;
                    relayActiveRef.current = true;
                    setDiagnostics((prev) => ({ ...prev, relayMode: true }));
                    if (channelReadyResolve) {
                        const res = channelReadyResolve;
                        channelReadyResolve = null;
                        res(relay);
                    }
                };

                const peer = new PeerConnection({
                    onIceCandidate: (candidate) => signaling.sendIceCandidate(candidate),

                    onChannel: (ch) => {
                        const resolve = channelReadyResolve;
                        if (!resolve) return;
                        if (ch.readyState === 'open') {
                            channelReadyResolve = null;
                            resolve(channelManager);
                        } else {
                            ch.addEventListener('open', () => {
                                if (channelReadyResolve) {
                                    channelReadyResolve = null;
                                    resolve(channelManager);
                                }
                            }, { once: true });
                        }
                    },

                    onConnectionStateChange: async (state) => {
                        setTransferState(
                            state === 'connected'    ? TRANSFER_STATE.CONNECTED :
                            state === 'connecting'   ? TRANSFER_STATE.CONNECTING :
                            state === 'failed'       ? TRANSFER_STATE.FAILED :
                                                       TRANSFER_STATE.CONNECTING
                        );

                        if (state === 'failed') {
                            // Tier-2: attempt relay fallback instead of giving up
                            console.warn('[useConnection] WebRTC failed — attempting relay fallback');
                            try {
                                await activateRelay();
                            } catch (relayErr) {
                                console.error('[useConnection] Relay fallback failed:', relayErr.message);
                                setError({ message: 'Peer connection and relay both failed. Check your network.' });
                                reject(relayErr);
                            }
                        }
                    },

                    onfailed: async () => {
                        // Distinct handling for permanent failure (vs transient disconnect)
                        console.warn('[useConnection] Permanent connection failure detected');
                    },
                });
                peerRef.current = peer;
                peer.init();

                // ── Signaling Handlers ──────────────────────────────────
                signaling.on('session-created', (data) => {
                    setSessionId(data.sessionId ?? '');
                    if (data.pairingCode) {
                        setPairingCode(data.pairingCode);
                    }
                    // Forced-relay receiver: activate here, where the session token is
                    // now stored (relay-request requires it). The sender activates on
                    // 'peer-joined'. The server sends relay-ready to both peers.
                    if (FORCE_RELAY && role === 'receiver') {
                        activateRelay().catch((e) => reject(e));
                    }
                });

                signaling.on('peer-joined', async () => {
                    if (role === 'sender') {
                        setTransferState(TRANSFER_STATE.CONNECTING);

                        if (FORCE_RELAY) {
                            // Dev/test: skip WebRTC entirely, go straight to relay.
                            await activateRelay().catch((e) => reject(e));
                            return;
                        }

                        peer.createChannels(() => {});
                        channelManager.setChannels(peer.channels);

                        // Negotiated data channels never fire pc.ondatachannel (so the
                        // generic onChannel callback won't resolve channel-ready), and
                        // ChannelManager.setChannels reassigns ch.onopen — clobbering the
                        // createChannels callback. Resolve channel-ready via
                        // addEventListener (which coexists with the onopen property),
                        // mirroring the receiver's offer handler below. Without this the
                        // sender deadlocks in initConnection and key exchange never starts.
                        for (const ch of peer.channels) {
                            if (ch.readyState === 'open') {
                                if (channelReadyResolve) {
                                    const res = channelReadyResolve;
                                    channelReadyResolve = null;
                                    res(channelManager);
                                }
                            } else {
                                ch.addEventListener('open', () => {
                                    if (channelReadyResolve) {
                                        const res = channelReadyResolve;
                                        channelReadyResolve = null;
                                        res(channelManager);
                                    }
                                }, { once: true });
                            }
                        }

                        const offer = await peer.createOffer();
                        signaling.sendOffer(offer);
                    }
                });

                signaling.on('offer', async (offer) => {
                    await peer.setRemoteDescription(offer);
                    peer.createChannels(() => {});
                    channelManager.setChannels(peer.channels);

                    // Wire channel open events for receiver side
                    for (const ch of peer.channels) {
                        if (ch.readyState === 'open') {
                            if (channelReadyResolve) {
                                channelReadyResolve = null;
                                resolve(channelManager);
                            }
                        } else {
                            ch.addEventListener('open', () => {
                                if (channelReadyResolve) {
                                    channelReadyResolve = null;
                                    resolve(channelManager);
                                }
                            }, { once: true });
                        }
                    }

                    const answer = await peer.createAnswer();
                    signaling.sendAnswer(answer);
                });

                signaling.on('answer', async (answer) => {
                    await peer.setRemoteDescription(answer);
                });

                signaling.on('ice-candidate', async (candidate) => {
                    await peer.addIceCandidate(candidate);
                });

                signaling.on('relay-ready', () => {
                    // Handled by RelayChannel.activate() — but also update diagnostics
                    relayActiveRef.current = true;
                    setDiagnostics((prev) => ({ ...prev, relayMode: true }));
                });

                signaling.on('error', (err) => {
                    setError(err);
                    setTransferState(TRANSFER_STATE.FAILED);
                    reject(new Error(err?.message || 'Signaling error'));
                });

                signaling.on('session-closed', () => {
                    setError({ message: 'Session closed by the other peer.' });
                    setTransferState(TRANSFER_STATE.FAILED);
                });

                signaling.on('disconnected', () => {
                    console.warn('[useConnection] Signaling disconnected — reconnecting...');
                });

                // Connect and create/join
                await signaling.connect();
                if (role === 'sender') {
                    signaling.createSession();
                } else {
                    signaling.joinSession(code);
                    // (forced-relay receiver activates in the 'session-created' handler,
                    //  once its session token is available)
                }

                // Wait for channel (WebRTC or relay)
                const cm = await channelReadyPromise;
                resolve(cm);
            } catch (err) {
                setError({ message: err.message || 'Failed to connect.' });
                setTransferState(TRANSFER_STATE.FAILED);
                reject(err);
            }
        });
    }, [setTransferState, setError, setSessionId, setPairingCode, setDiagnostics]);

    // ── Send Batch (files / folders) ─────────────────────────────

    /**
     * Send a batch descriptor (see FileTree.buildBatch): one or more files and/or
     * directories. The whole batch is announced up front (BATCH_META) and each file
     * streamed sequentially with the existing encrypted, resumable, verified
     * per-file protocol.
     * @param {{ files, directories, totalFiles, totalBytes, name }} batch
     * @param {{ transferType?: string, textFormat?: string }} [sendOptions]
     */
    const handleSendFile = useCallback(async (batch, sendOptions = {}) => {
        setView('send');
        transferStartRef.current = Date.now();
        relayActiveRef.current = false;

        try {
            const cm = await initConnection('sender');
            // Agree an end-to-end session key before any file data is sent.
            const { key: cryptoKey, sas } = await performKeyExchange(cm);
            setDiagnostics((prev) => ({ ...prev, encrypted: true }));
            // MITM defence: both peers must confirm the SAS matches before any
            // file data leaves this device.
            await waitForSasConfirmation(sas);

            const batchSender = new BatchSender(batch, cm, cryptoKey, {
                onFileProgress: (fileIndex, sent, total, speed, entry) => {
                    setCurrentFileIndex(fileIndex);
                    setTransferProgress((prev) => ({
                        ...prev,
                        sentChunks: sent,
                        totalChunks: total,
                        speed,
                        role: 'sender',
                        fileName: entry.relativePath,
                        fileSize: entry.size,
                        currentFileIndex: fileIndex,
                        totalFiles: batch.totalFiles,
                        complete: false,
                        paused: false,
                        cancelled: false,
                    }));
                },
                onBatchProgress: (bytesSent, totalBytes) => {
                    setTransferProgress((prev) => ({
                        ...prev,
                        batchBytesSent: bytesSent,
                        batchTotalBytes: totalBytes,
                    }));
                },
                onAwaitingApproval: () => {
                    // Offer delivered; waiting on the receiver's accept/decline.
                    setTransferState(TRANSFER_STATE.CONNECTED);
                    setTransferProgress((prev) => ({ ...prev, awaitingApproval: true }));
                },
                onRejected: () => {
                    setTransferProgress((prev) => ({ ...prev, awaitingApproval: false }));
                    setError({ message: 'The receiver declined the transfer.' });
                    setTransferState(TRANSFER_STATE.CANCELLED);
                    _recordHistory('send', batch, sendOptions, 'rejected');
                },
                onComplete: () => {
                    setTransferProgress((prev) => ({ ...prev, complete: true, awaitingApproval: false }));
                    setTransferState(TRANSFER_STATE.COMPLETED);
                    _recordHistory('send', batch, sendOptions, 'success');
                },
                onError: (err) => {
                    setError({ message: err.message });
                    setTransferState(TRANSFER_STATE.FAILED);
                    _recordHistory('send', batch, sendOptions, 'failed', err.message);
                },
                onCancel: () => {
                    setTransferProgress((prev) => ({ ...prev, cancelled: true }));
                    setTransferState(TRANSFER_STATE.CANCELLED);
                    _recordHistory('send', batch, sendOptions, 'cancelled');
                },
            }, {
                identity: getLocalIdentity(),
                transferType: sendOptions.transferType,
                textFormat: sendOptions.textFormat,
            });
            senderRef.current = batchSender;

            setTransferState(TRANSFER_STATE.TRANSFERRING);
            setView('transferring');
            setTransferProgress((prev) => ({
                ...prev,
                role: 'sender',
                totalFiles: batch.totalFiles,
                batchTotalBytes: batch.totalBytes,
            }));

            await batchSender.start();
        } catch (err) {
            if (err?.message) setError({ message: err.message });
        }
    }, [initConnection, setView, setCurrentFileIndex, setError, setDiagnostics, setTransferState, setTransferProgress, waitForSasConfirmation, _recordHistory]);

    // ── Receive Batch ────────────────────────────────────────────

    const handleReceive = useCallback(async (code) => {
        setView('receive');
        transferStartRef.current = Date.now();
        relayActiveRef.current = false;
        // Captured from BATCH_META so completion/error handlers can write history.
        let receivedMeta = null;

        try {
            const cm = await initConnection('receiver', code);

            // Batch receives never use the File System Access API per file (one
            // "Save As" dialog per file would be unusable for a folder); files are
            // assembled to blobs and packaged into one archive.
            setDiagnostics((prev) => ({
                ...prev,
                storageMode: new StorageManager({ allowFsApi: false }).getMode(),
            }));

            let batchReceiver = null;

            // Symmetric ECDH handshake. The session key is released to per-file
            // receivers only after the user confirms the SAS. The batch coordinator
            // installs its channel handler the moment the handshake frees it, so it
            // catches BATCH_META / FILE_META even while the SAS dialog is open (the
            // pull-based protocol means no file data flows until a receiver requests).
            const verifiedKeyPromise = performKeyExchange(cm).then(async ({ key, sas }) => {
                setDiagnostics((prev) => ({ ...prev, encrypted: true }));
                batchReceiver?.start();
                await waitForSasConfirmation(sas);
                return key;
            });
            verifiedKeyPromise.catch(() => {});

            batchReceiver = new BatchReceiver(
                cm,
                verifiedKeyPromise,
                {
                    // Approval policy (Feature 4): auto-accept remembered senders
                    // (after SAS still passes), otherwise surface the offer to the
                    // user. No file data is requested until this resolves accept.
                    requestApproval: async (meta) => {
                        receivedMeta = meta;
                        let decision;
                        let auto = false;
                        if (meta.senderDeviceId &&
                            await remembered().isRemembered(meta.senderDeviceId).catch(() => false)) {
                            decision = { accept: true, remember: false };
                            auto = true;
                        } else {
                            decision = await waitForReceiveApproval(meta);
                        }
                        if (decision.accept && decision.remember && meta.senderDeviceId) {
                            remembered().remember({
                                deviceId: meta.senderDeviceId,
                                deviceName: meta.senderName,
                                deviceType: meta.senderDeviceType,
                                platform: meta.senderPlatform,
                            }).catch(() => {});
                        } else if (decision.accept && meta.senderDeviceId) {
                            // Already-trusted sender: refresh its last-seen for the
                            // contact list without changing its trust state.
                            remembered().touch(meta.senderDeviceId).catch(() => {});
                        }
                        // Approval logging (Feature 4 requirement).
                        console.info('[LinkSpan] receive-approval', {
                            ts: new Date().toISOString(),
                            sender: meta.senderName,
                            deviceId: meta.senderDeviceId,
                            transferType: meta.transferType,
                            files: meta.fileCount,
                            folders: meta.folderCount,
                            bytes: meta.totalBytes,
                            decision: decision.accept ? (auto ? 'auto-accept' : 'accept') : 'decline',
                        });
                        if (!decision.accept) {
                            setError({ message: 'You declined the transfer.' });
                            setTransferState(TRANSFER_STATE.CANCELLED);
                        }
                        return decision;
                    },
                    onBatchMeta: (meta) => {
                        receivedMeta = meta;
                        setTransferState(TRANSFER_STATE.TRANSFERRING);
                        setView('transferring');
                        setTransferProgress((prev) => ({
                            ...prev,
                            role: 'receiver',
                            totalFiles: meta.totalFiles,
                            batchTotalBytes: meta.totalBytes,
                            fileName: meta.name,
                            transferType: meta.transferType,
                            textFormat: meta.textFormat,
                        }));
                    },
                    onRejected: (meta) => {
                        _recordHistory('receive', meta || receivedMeta || {}, null, 'rejected');
                    },
                    onFileProgress: (fileIndex, relPath, received, total, speed) => {
                        setCurrentFileIndex(fileIndex);
                        setTransferProgress((prev) => ({
                            ...prev,
                            sentChunks: received,
                            totalChunks: total,
                            speed,
                            role: 'receiver',
                            fileName: relPath,
                            currentFileIndex: fileIndex,
                            complete: false,
                            paused: false,
                            cancelled: false,
                        }));
                    },
                    onBatchProgress: (bytesReceived, totalBytes) => {
                        setTransferProgress((prev) => ({
                            ...prev,
                            batchBytesReceived: bytesReceived,
                            batchTotalBytes: totalBytes,
                        }));
                    },
                    onComplete: (blob, name, isArchive, diskInfo) => {
                        onTransferComplete(blob, name, {
                            transferType: receivedMeta?.transferType ?? null,
                            textFormat: receivedMeta?.textFormat ?? null,
                            isArchive: !!isArchive,
                            ...(diskInfo || {}),
                        });
                        setTransferProgress((prev) => ({
                            ...prev,
                            complete: true,
                            savedToDisk: diskInfo?.writtenToDisk || false,
                            savedLocation: diskInfo?.location || null,
                        }));
                        setTransferState(TRANSFER_STATE.COMPLETED);
                        _recordHistory('receive', receivedMeta || {}, null, 'success');
                    },
                    onError: (err) => {
                        setError({ message: err.message });
                        setTransferState(TRANSFER_STATE.FAILED);
                        _recordHistory('receive', receivedMeta || {}, null, 'failed', err.message);
                    },
                    onStalled: () => {
                        setDiagnostics((prev) => ({ ...prev, stalled: true }));
                        setTimeout(() => setDiagnostics((prev) => ({ ...prev, stalled: false })), 3000);
                    },
                },
                {
                    makeStorage: () => new StorageManager({ allowFsApi: false }),
                    makeResume: () => new ResumeManager(),
                    // Resolve the destination for this transfer: per-transfer override
                    // first, else the saved default (re-permissioned). Null → ZIP path.
                    getDestination: destinationSupported
                        ? async () => destinationRef.current || (await destManager().getDefault(false))
                        : null,
                    writeTree: destinationSupported
                        ? (handle, entries) => destManager().writeTree(handle, entries)
                        : null,
                }
            );
            receiverRef.current = batchReceiver;
        } catch (err) {
            if (err?.message) setError({ message: err.message });
        }
    }, [initConnection, setView, setDiagnostics, setTransferProgress, setTransferState, setCurrentFileIndex, setError, onTransferComplete, waitForSasConfirmation, waitForReceiveApproval, _recordHistory]);

    // ── Transfer Controls ────────────────────────────────────────

    const handlePause = useCallback(() => {
        receiverRef.current?.pause();
        senderRef.current?.stop();
        setTransferState(TRANSFER_STATE.PAUSED);
        setTransferProgress((prev) => ({ ...prev, paused: true }));
    }, [setTransferState, setTransferProgress]);

    const handleResume = useCallback(() => {
        receiverRef.current?.resume();
        setTransferState(TRANSFER_STATE.TRANSFERRING);
        setTransferProgress((prev) => ({ ...prev, paused: false }));
    }, [setTransferState, setTransferProgress]);

    const handleCancel = useCallback(() => {
        receiverRef.current?.cancel();
        senderRef.current?.stop();
        setTransferState(TRANSFER_STATE.CANCELLED);
        setTransferProgress((prev) => ({ ...prev, cancelled: true }));
        cleanup();
    }, [cleanup, setTransferState, setTransferProgress]);

    // ── Diagnostics (for polling interval in App) ─────────────────

    const getDiagnosticSnapshot = useCallback(async () => {
        const cm = channelManagerRef.current;
        const pc = peerRef.current;
        if (!cm || !pc) return null;
        const channelStats = cm.getChannelStats();
        const pcStats = await pc.getStats?.().catch(() => null);
        return { channelStats, rtt: pcStats?.rtt, transport: pcStats?.transport ?? null };
    }, []);

    return {
        cleanup,
        handleSendFile,
        handleReceive,
        handlePause,
        handleResume,
        handleCancel,
        confirmSas,
        rejectSas,
        acceptReceive,
        declineReceive,
        history,
        remembered,
        chooseDestination,
        clearDestination,
        destinationSupported,
        getDiagnosticSnapshot,
        // Expose refs for consumers that need direct access
        channelManagerRef,
        peerRef,
    };
}
