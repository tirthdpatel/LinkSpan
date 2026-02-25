# LinkSpan Protocol Specification v1.0.0

## Overview

LinkSpan uses a hybrid architecture: a stateless WebSocket signaling server for WebRTC negotiation, and direct peer-to-peer DataChannels for file transfer.

---

## 1. Signaling Protocol (WebSocket)

All signaling messages are JSON-encoded.

### Client → Server

| Type | Payload | Description |
|------|---------|-------------|
| `create-session` | — | Create a new session |
| `join-session` | `{ pairingCode: string }` | Join via 6-digit code |
| `offer` | `{ payload: RTCSessionDescription }` | WebRTC SDP offer |
| `answer` | `{ payload: RTCSessionDescription }` | WebRTC SDP answer |
| `ice-candidate` | `{ payload: RTCIceCandidate }` | ICE candidate |
| `disconnect` | — | Leave session |

### Server → Client

| Type | Payload | Description |
|------|---------|-------------|
| `session-created` | `{ sessionId, pairingCode, token }` | Session ready |
| `peer-joined` | `{ sessionId }` | Other peer connected |
| `session-error` | `{ error: { code, message } }` | Error occurred |
| `session-closed` | `{ reason: string }` | Session ended |

### Negotiation Flow

```
Sender                    Server                   Receiver
  |                         |                         |
  |-- create-session ------>|                         |
  |<-- session-created -----|                         |
  |                         |                         |
  |                         |<-- join-session --------|
  |                         |--- session-created ---->|
  |<-- peer-joined ---------|                         |
  |                         |                         |
  |-- offer --------------->|--- offer -------------->|
  |                         |<-- answer --------------|
  |<-- answer --------------|                         |
  |                         |                         |
  |-- ice-candidate ------->|--- ice-candidate ------>|
  |<-- ice-candidate -------|<-- ice-candidate -------|
  |                         |                         |
  [===== DataChannel established (P2P) =====]
```

---

## 2. Transfer Protocol (DataChannel)

Once WebRTC DataChannels are established, 7 channels carry file data.

### Message Types

Control messages are JSON strings. Binary data uses the chunk format.

| Type | Direction | Payload |
|------|-----------|---------|
| `file-meta` | Sender → Receiver | `{ fileId, fileName, fileSize, fileType, chunkSize, totalChunks }` |
| `chunk-request` | Receiver → Sender | `{ index: number }` |
| `chunk-data` | Sender → Receiver | JSON: `{ index, hash, size }` followed by binary |
| `transfer-complete` | Receiver → Sender | `{ fileId }` |
| `resume-request` | Receiver → Sender | `{ fileId, receivedChunks: number[] }` |

### Binary Chunk Format

```
[4 bytes: chunk index (Uint32 big-endian)] [N bytes: chunk data]
```

### Transfer Flow (Receiver-Driven Pull)

```
Sender                                     Receiver
  |                                           |
  |-- file-meta (JSON, channel 0) ----------->|
  |                                           |
  |<-- chunk-request { index: 0 } ------------|
  |<-- chunk-request { index: 1 } ------------|
  |<-- chunk-request { index: 2 } ------------|
  |     ... (up to 7 concurrent)              |
  |                                           |
  |-- chunk-data meta { index: 0, hash } ---->|
  |-- chunk binary [0][data] ---------------->|  ← SHA-256 verify
  |                                           |
  |<-- chunk-request { index: 7 } ------------|  ← next chunk on verify
  |     ...                                   |
  |                                           |
  |<-- transfer-complete ---------------------|
```

### Integrity Verification

- **Per chunk**: SHA-256 hash computed by sender, verified by receiver
- **Retry**: Up to 5 retries on hash mismatch
- **Full file**: SHA-256 of assembled file (triggered by receiver on completion)

---

## 3. Resume Protocol

### Within Same Session

```
Receiver                                   Sender
  |                                           |
  | [reconnect to same session]               |
  |                                           |
  |-- resume-request { fileId,                |
  |     receivedChunks: [0,1,3,4] } --------->|
  |                                           |
  |<-- chunk-request for missing [2,5,6...] --|
  |     ... normal transfer continues ...     |
```

Resume state is stored in IndexedDB and memory. Only session-scoped.

---

## 4. Error Codes

| Code | Description |
|------|-------------|
| `SESSION_NOT_FOUND` | No session with that pairing code |
| `SESSION_FULL` | Session already has 2 peers |
| `INVALID_PAIRING_CODE` | Code format invalid |
| `RATE_LIMITED` | Too many requests from this IP |
| `INVALID_MESSAGE` | Malformed message |
| `INTEGRITY_FAILED` | Chunk hash mismatch |
| `TRANSFER_FAILED` | Unrecoverable transfer error |
| `STORAGE_ERROR` | Browser storage failure |
| `CONNECTION_FAILED` | WebRTC connection failed |

---

## 5. Versioning

Protocol version is `1.0.0`, included in `shared/constants.js`. Breaking changes increment the major version.
