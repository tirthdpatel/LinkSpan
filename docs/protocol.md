# LinkSpan Protocol Specification v1.7.0

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
| `relay-request` | — | Request server-relay fallback (WebRTC failed) |
| `relay-chunk` | `{ channelIndex, isText, payload? , b64?, size? }` | Relayed transfer frame (see §5) |
| `relay-complete` | `{ fileId }` | Relay transfer finished |
| `disconnect` | — | Leave session |

### Server → Client

| Type | Payload | Description |
|------|---------|-------------|
| `session-created` | `{ sessionId, pairingCode, token }` | Session ready |
| `peer-joined` | `{ sessionId }` | Other peer connected |
| `session-error` | `{ error: { code, message } }` | Error occurred |
| `session-closed` | `{ reason: string }` | Session ended |
| `relay-ready` | — | Server-relay activated for this session |

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
| `key-exchange` | Both → peer | `{ pub: base64url }` — ECDH P-256 public key (sent first, see §2.1) |
| `batch-meta` | Sender → Receiver | `{ batchId, name, totalFiles, totalBytes, fileCount, folderCount, transferType, textFormat, senderName, senderDeviceId, senderDeviceType, senderPlatform, directories: string[], files: [{ relativePath, size }] }` — batch preamble + offer (see §2.2, §2.3). `transferType` ∈ `files` \| `folder` \| `text` \| `link` \| `mixed`. `senderDeviceType`/`senderPlatform` (v1.5.0) are cosmetic recognizability hints recorded with a remembered device (see §2.6) |
| `receive-accept` | Receiver → Sender | — receiver approved the offer; sender begins streaming (see §2.3) |
| `receive-reject` | Receiver → Sender | — receiver declined; sender aborts, no data sent |
| `file-meta` | Sender → Receiver | `{ fileId, fileName, fileSize, fileType, chunkSize, totalChunks, relativePath, batchId, fileIndex, isLast, supportsRangeRequest? }` — `supportsRangeRequest: true` (v1.7.0) advertises that the sender accepts `chunk-request-range` |
| `file-complete` | Receiver → Sender | `{ fileId }` — one file verified & assembled; sender advances to the next |
| `batch-complete` | Sender → Receiver | `{ batchId }` — all files sent |
| `chunk-request` | Receiver → Sender | `{ index: number }` — request a single chunk |
| `chunk-request-range` | Receiver → Sender | `{ ranges: [{ start, count }] }` (v1.7.0) — request a coalesced set of chunks in one frame; see §2.9 |
| `chunk-data` | Sender → Receiver | JSON: `{ index, hash, size }` followed by binary |
| `manifest-request` | Receiver → Sender | — (sent once all chunks are in) |
| `manifest` | Sender → Receiver | `{ rootHash, totalChunks }` — whole-file commitment |
| `transfer-complete` | Receiver → Sender | `{ fileId }` |
| `resume-request` | Receiver → Sender | `{ fileId, receivedChunks: number[] }` |

### 2.1 Session Key Agreement (before any file data)

As soon as a channel (P2P or relay) is ready, both peers exchange ECDH P-256 public
keys via `key-exchange` and independently derive a shared **AES-256-GCM** session key.
The private keys never leave the browser and the derived key is never transmitted, so
no intermediary — including the relay server — can decrypt the transfer. `file-meta`
and all chunk data follow only after this completes.

### Binary Chunk Format

```
[4 bytes: chunk index (Uint32 big-endian)] [N bytes: AES-256-GCM ciphertext]
```

The ciphertext is `[12-byte IV][encrypted chunk][16-byte GCM tag]`. To keep the framed
message within the 256 KB DataChannel limit, plaintext chunks are sized to
`ENCRYPTED_CHUNK_SIZE` (256 KB − 28 B). The per-chunk SHA-256 in `chunk-data` is over
the **plaintext**, so the receiver verifies decrypted bytes.

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

- **Per chunk**: SHA-256 of the plaintext, computed by the sender, verified by the receiver after decryption.
- **Retry**: Up to 5 retries on hash mismatch (a GCM auth failure counts as a mismatch).
- **Whole file (manifest)**: once every chunk is received, the receiver sends `manifest-request`. The sender replies with `manifest { rootHash }`, the root over all plaintext chunk hashes. The receiver re-hashes the **assembled file** and compares — so verification holds even across a resume — and only then completes. A mismatch fails the transfer rather than delivering a corrupt file.

### 2.2 Batch / Folder Transfer

A **batch** is one or more files and/or directories sent in a single session (a
folder, a multi-file selection, or a mix). The batch layer sits *above* the per-file
protocol (§2): each file is still streamed with its own `file-meta` → chunk pull →
`manifest`, fully encrypted, resumable and verified. The batch layer only adds
sequencing and a directory manifest.

```
Sender                                     Receiver
  |-- batch-meta { totalFiles, totalBytes, |
  |     directories[], files[] } --------->|   ← receiver sizes/validates the batch
  |                                         |
  |   for each file, in order:             |
  |-- file-meta { relativePath, ... } ---->|
  |       ... §2 chunk pull + manifest ...  |
  |<------------------- file-complete ------|   ← file verified & assembled
  |                                         |
  |-- batch-complete ---------------------->|   ← receiver reconstructs the tree
```

- **Sequential, ack'd.** The sender streams the next file only after the receiver's
  `file-complete` for the current one, so one channel serves the whole batch in order.
- **Relative paths.** Every `relativePath` (and every entry in `directories`,
  including **empty** ones) is **sanitized on both peers** — traversal (`..`),
  absolute paths, drive letters, NUL/control chars, and Windows reserved names are
  rejected. A crafted sender cannot cause a path-traversal write on the receiver.
- **Ceilings.** `batch-meta` is validated against hard limits — `MAX_BATCH_FILES`
  (10 000), `MAX_BATCH_DIRECTORIES` (10 000), `MAX_BATCH_BYTES` (50 GB) — to bound
  receiver memory/disk against a hostile or buggy sender.
- **Reconstruction.** A single loose file is delivered as-is. Anything else (multiple
  files and/or any directory) is either **written directly into a user-chosen
  directory** (File System Access API — see §2.5) preserving the exact tree, or
  packaged by the receiver into a single **ZIP** (STORE method, ZIP64 for large/many-entry
  archives) that unpacks to the exact tree, empty directories included.

### 2.3 Receive Confirmation (approval before any data)

After the secure handshake (§2.1) the sender transmits `batch-meta` — which now
doubles as a **transfer offer** carrying the sender's announced identity
(`senderName`, `senderDeviceId`), the `transferType` (`files` | `folder` | `mixed` |
`text`), `fileCount`, `folderCount` and `totalBytes` — and then **blocks**. No
`file-meta` and no chunk are sent until the receiver replies:

```
Sender                                     Receiver
  |-- batch-meta (offer) ----------------->|   ← shows sender, type, counts, size
  |                                         |   ┌ user: Accept / Reject /
  |                                         |   └        Accept & remember device
  |<-- receive-accept ----------------------|   → sender starts streaming (§2.2)
  |        ...  OR  ...                      |
  |<-- receive-reject ----------------------|   → sender aborts, nothing transferred
```

- **No data before approval.** The protocol is receiver-pull, and the receiver does
  not create any per-file receiver (hence sends no `chunk-request`) until it accepts.
- **Expiration.** The sender's offer expires after `RECEIVE_APPROVAL_TIMEOUT_MS`
  (60 s); a silent/absent receiver cannot pin an offer open. The receiver UI counts
  down in lockstep and auto-declines on expiry.
- **Remembered devices.** "Accept and remember" stores the sender's `senderDeviceId`
  locally (IndexedDB). Future offers from that id auto-accept — but only *after* the
  per-session SAS/MITM check (§2.1) still passes. A device id is spoofable, so this is
  a convenience, never a security boundary on its own.
- **Approval logging.** Every decision (accept / auto-accept / decline) is logged
  locally with sender, type, counts and size.

### 2.4 Text Sharing

A composed text/clipboard payload (plain, Markdown, or code) is sent as an ordinary
**single-file batch** — it inherits encryption, integrity and resume unchanged — with
`transferType: "text"` and a `textFormat` in `batch-meta`. The receiver detects the
flag and opens a **preview** (copy / save-as-file / render-Markdown) instead of
downloading. Markdown is rendered through an escape-first, tag-whitelist renderer with
http/https/mailto-only links, so sender-controlled text can never inject markup (XSS).
The interactive payload ceiling is `MAX_TEXT_PAYLOAD_BYTES` (16 MB); larger text
should be sent as a file.

### 2.5 Download Location (receiver)

Where the File System Access API is available, the receiver may choose a destination
directory (and optionally persist it as the default, re-permissioned on reuse). A
received tree is then written into that directory preserving structure, relative paths
and filenames — no ZIP, no unpack step. Every path segment is re-validated at write
time (no `.`/`..`/absolute/control-char segments), so a crafted entry can never escape
the chosen directory. Browsers without the API fall back to the ZIP/single-file
download path; the wire protocol is identical either way.

### 2.6 Clipboard & Link Sharing

Both ride the same single-file-batch substrate as text (§2.4); neither adds wire
surface beyond the additive `transferType` value.

- **Clipboard** (`ClipboardPayload`) is a *source*, not a wire type. Pasted text is
  sent as a `text` transfer; pasted images/files are sent as an ordinary `files`
  batch. The reader degrades gracefully across browsers (async `clipboard.read()` for
  images, `readText()` everywhere, and a paste-event path when programmatic reads are
  blocked) and never throws on a denied permission.
- **Link** (`transferType: "link"`, `LinkPayload`) carries a small JSON document
  `{ v, url, title, description, siteName }`. The URL is validated to **http/https
  only** on the sender and **re-validated** on the receiver (javascript:/data:/file:/
  blob:/etc. rejected); all display fields are HTML-escaped; the one-click "Open" uses
  the re-parsed URL as the href. There is no path by which a malicious sender can get
  the receiver to navigate a dangerous scheme or inject markup.

### 2.7 Persistent Device Identity & Contacts

Each browser mints a stable, local-only device id + friendly name (`DeviceIdentity`),
and announces a coarse `senderDeviceType` (mobile/tablet/desktop) + `senderPlatform`
in `batch-meta`. The receiver may **trust/remember** a sender (`RememberedDevices`,
IndexedDB) to auto-approve it next time — gated behind the per-session SAS check, which
still runs every connection, so this is convenience, never a security boundary (a
device id is spoofable). Remembered devices form a searchable **contact list** with
rename / favorite / note / last-seen / remove. A non-reversible device **fingerprint**
(`computeFingerprint`) provides cross-session recognizability without exposing the raw
id.

### 2.8 QR Deep Links

A QR / share link (`DeepLink`) is an https URL carrying the pairing `code`, an
`a`(ction), an opaque `t`(oken) and an `exp`(iry); single-use links also set `su=1`.
The token bounds how long a leaked/over-the-shoulder QR is useful and lets the
**issuer** revoke a specific link or mark a single-use link consumed
(`DeepLinkRegistry`). Real join authority still rests with the signaling server's
short-lived session (the `code`); the token is a client-side expiry/revocation layer
on top. A bare `?code=NNNNNN` link (the original format) still parses, so old QR codes
keep working. Expired scans are rejected with a hint rather than joining a dead
session.

### 2.9 Range-list chunk requests (v1.7.0)

The receiver drives the pull, so requesting a contiguous window of N chunks costs N
`chunk-request` frames. `chunk-request-range` coalesces them: the receiver merges the
chunks it wants into the minimal list of `{ start, count }` ranges and pulls them in a
single control frame. **Only the request side changes** — the sender still answers each
chunk with the usual `chunk-data` (JSON `{ index, hash, size }`) + binary, so responses,
per-chunk verification, retries, and resume are all unchanged.

- **Capability negotiation.** A range-capable sender advertises `supportsRangeRequest:
  true` in `file-meta`. A receiver uses `chunk-request-range` **only** when it sees that
  flag; otherwise it falls back to per-chunk `chunk-request`. A range-capable sender also
  still serves plain `chunk-request`, so old↔new pairings work in both directions.
  Negotiation is modelled as a capability *set* (`TRANSFER_CAPABILITY` in
  `shared/chunkRanges.js`) so a future `supportsBitfield` can be added without another
  redesign. `chunk-nack` stays single-index.
- **Window cap.** `MAX_IN_FLIGHT` (7) remains the cap on the *expanded* chunk count, not
  the number of frames — sparse post-reload gaps simply produce more, shorter ranges.
- **Sender validation (before expansion).** Every incoming range is validated against the
  real `totalChunks`: non-integer/negative `start`, zero/negative `count`, out-of-bounds
  (`start + count > totalChunks`), and overlapping ranges are all rejected outright; an
  invalid frame is ignored (the receiver re-requests / stall-recovers) rather than
  expanded. Adjacent ranges are normalized into one. The shared codec
  (`chunksToRanges` / `rangesToChunks` / `validateRanges`) is pure and reused by both
  peers and the future swarm scheduler, which can hand each peer a **disjoint** subset of
  ranges.

```
  Receiver                                  Sender
  |-- chunk-request-range {[{0,3},{5,2}]} ->|   (chunks 0,1,2,5,6 in one frame)
  |<-- chunk-data {0} + binary -------------|
  |<-- chunk-data {1} + binary -------------|
  |<-- chunk-data {2} + binary -------------|
  |<-- chunk-data {5} + binary -------------|
  |<-- chunk-data {6} + binary -------------|
```

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

Resume state is a per-chunk **ledger** (a `Uint8Array` bitset) persisted in IndexedDB
plus memory. Durability guarantees:

- **Crash-safe ordering.** The receiver writes a chunk to storage *before* marking it
  in the ledger, so a crash can only ever cause a redundant re-download — never a
  ledger that claims a chunk the file is missing (which would corrupt the result).
- **Bounded lag.** Ledger persistence is debounced (16 ms) with a hard ceiling
  (`RESUME_FLUSH_MAX_WAIT_MS`, 1 s) so a sustained burst cannot leave the durable
  ledger arbitrarily far behind storage. A deliberate `pause()` flushes immediately.
- **Verified completion.** On resume, the whole-file manifest (§2.1 / Integrity
  Verification) is re-checked against the assembled file before completing, so a
  resumed transfer is held to the same integrity bar as a fresh one.

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

## 5. Server-Relay Fallback Protocol

When WebRTC cannot be established (neither direct P2P nor TURN succeeds), the client
falls back to relaying transfer frames through the signaling server. The transfer
protocol (§2) is unchanged — `file-meta`, `chunk-request`, `chunk-data`, and binary
chunks are simply tunneled inside `relay-chunk` envelopes instead of riding a
DataChannel.

### Activation

```
Peer A                     Server                     Peer B
  |-- relay-request ------->|                           |
  |<-- relay-ready ---------|                           |
  |                         |-- relay-ready ----------->|   (both peers enabled)
```

### Frame Format

All relay frames are JSON (binary chunks are base64-encoded to avoid a metadata/binary
two-frame race). Every frame carries the session token, which the server validates
before forwarding to the other peer.

```jsonc
// Text control frame (file-meta, chunk-request, …)
{ "type": "relay-chunk", "channelIndex": 0, "isText": true,  "payload": "<json string>" }

// Binary chunk frame
{ "type": "relay-chunk", "channelIndex": 0, "isText": false, "b64": "<base64>", "size": 262144 }
```

### Limits

- `MAX_RELAY_SESSION_BYTES` (default 100 MB) per session — exceeding it deactivates relay.
- `MAX_RELAY_DURATION_MS` (default 30 min) per session.

### Security note

In relay mode the server forwards **AES-256-GCM ciphertext** (base64-framed for
transport). Combined with the §2.1 ECDH session key, the server cannot read file
contents. Frames are additionally WSS-protected in transit. The remaining residual
risk (an active MITM by the server during key exchange) is documented in
[architecture/trust-model.md](architecture/trust-model.md) §4.

---

## 5b. Group rooms & swarm (N-peer)

Multi-peer rooms layer on top of the signaling protocol. The 2-peer session flow above is
unchanged; rooms add `create-room`/`join-room`/`leave-room`, a roster
(`room-created`/`room-roster`/`room-peer-joined`/`room-peer-left`), N-peer signaling
(`offer`/`answer`/`ice-candidate` carry a `to` target and the server stamps `from`), and a
swarm coordination plane (`swarm-announce`/`swarm-have`/`swarm-need` → `swarm-peers`). The
server tracks chunk availability but never relays file bytes (those move peer-to-peer).
Topology adapts to room size (direct ≤2, mesh ≤5, swarm beyond). See
[architecture/swarm.md](architecture/swarm.md) for the full design.

---

## 6. Versioning

Protocol version is `1.7.0`, included in `shared/constants.js` as `PROTOCOL_VERSION`. The
ECDH key exchange (§2.1) and always-on chunk encryption were introduced in 1.2.0 and are
required — a 1.2.0+ peer will not interoperate with a pre-encryption peer. Subsequent
minor versions added batch/folder transfer + receive confirmation (1.3.0–1.4.0), the
`link` transfer type plus `senderDeviceType`/`senderPlatform` in `batch-meta` (1.5.0),
N-peer group rooms + swarm coordination (1.6.0, §5b), and range-list chunk requests
(`chunk-request-range` + the `supportsRangeRequest` capability, 1.7.0, §2.9). All
`batch-meta` additions, the room/swarm messages, and `chunk-request-range` are additive
and backward-tolerant (unknown fields/types ignored; range requests are capability-gated),
so mixed-version peers interoperate. Breaking changes increment the major version.
