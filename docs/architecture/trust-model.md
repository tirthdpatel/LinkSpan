# LinkSpan Trust Model

**Status:** Authoritative. This document describes what each party can and cannot
observe in every transfer mode. Where the current implementation falls short of the
goal, that gap is stated explicitly rather than hidden. Honesty about the threat
model is a release requirement, not a nicety.

Last reviewed against code: `client/src/core/RelayChannel.js`,
`server/src/RelayTransfer.js`, `client/src/core/PeerConnection.js`,
`client/src/hooks/useConnection.js`.

---

## 1. Parties

| Party | Description |
|-------|-------------|
| **Sender** | The browser selecting and transmitting files. |
| **Receiver** | The browser requesting and reassembling files. |
| **Signaling server** | LinkSpan's WebSocket server. Brokers session creation, pairing, and WebRTC negotiation. In one mode it also forwards file data (see §4). |
| **TURN server** | Third-party (Metered.ca by default) media relay used only for NAT traversal. |
| **Network observer** | Anyone able to watch traffic on the wire (ISP, Wi-Fi operator, etc.). |

---

## 2. Transfer Modes

LinkSpan attempts the most private route first and falls back as needed:

```
1. Direct P2P            WebRTC DataChannel, host/srflx candidates
        │ (NAT blocks direct path)
        ▼
2. P2P via TURN          WebRTC DataChannel relayed by a TURN server
        │ (WebRTC fails entirely)
        ▼
3. Server relay          File bytes forwarded through the signaling server
```

The active mode is now surfaced to the user in the UI (`ConnectionMode` component)
and in the diagnostics panel. Selection logic lives in
`client/src/hooks/useConnection.js`; candidate-type detection is in
`PeerConnection.getStats()` (`transport: 'direct' | 'turn'`).

---

## 3. Direct P2P  (and P2P via TURN)

This is the default and covers the large majority of transfers.

**What the signaling server sees:**

- Session id and pairing code
- That two peers paired and exchanged SDP/ICE
- WebRTC SDP offers/answers and ICE candidates (IP/port metadata)
- Connection timing and coarse session metadata

**What the signaling server does NOT see:**

- File bytes — they never traverse the server
- File names, sizes, hashes, or the transfer manifest

**What a TURN server sees (mode 2 only):**

- Encrypted DTLS packets. WebRTC DataChannels are DTLS-encrypted end-to-end
  per spec, so a TURN relay forwards **ciphertext only** and cannot read contents.

**What a network observer sees:**

- DTLS-encrypted P2P traffic (opaque), plus WSS-encrypted signaling metadata.

**Net:** In modes 1 and 2, no intermediary can read file contents. This is the
property the marketing copy ("E2E Encrypted", "No cloud") relies on, and it holds.

---

## 4. Server Relay  (fallback)

When WebRTC cannot be established at all, LinkSpan falls back to relaying file data
through the signaling server itself (`RelayChannel` → `RelayTransfer`). This keeps
transfers working on hostile networks.

**Application-layer encryption (always on) makes this safe.** Before any file data is
sent — in every mode — the two peers run an **ECDH (P-256) key agreement** over the
channel and derive a shared **AES-256-GCM** key (`CryptoEngine`,
`useConnection.performKeyExchange`). Every chunk is encrypted by the sender
(`Sender`) and decrypted by the receiver (`Receiver`). Because the relay fallback can
trigger mid-transfer, encryption is not optional and not mode-dependent.

**What the signaling server sees in relay mode:**

- **Ciphertext only.** Relayed chunks are AES-256-GCM-encrypted before they reach the
  server; it forwards opaque bytes (`server/src/RelayTransfer.js`) and **cannot read
  file contents**.
- The ECDH public keys (which are public by design) and file *metadata* (name, size,
  chunk hashes) carried in `file-meta`. Metadata is not yet encrypted — see §6.
- The server still does not persist relayed bytes, and relay is capped
  (`MAX_RELAY_SESSION_BYTES`, `MAX_RELAY_DURATION_MS`).

> **Active MITM — mitigated by SAS.** ECDH over the server-brokered channel defends
> against a *passive* server and any network observer. A *malicious, active* server
> could substitute its own keys to MITM the exchange, since ECDH alone is not
> authenticated. To catch this, after the handshake both peers display a **Short
> Authentication String** (a 6-digit code derived from a hash of *both* public keys,
> `CryptoEngine.computeSAS`) and must confirm it matches before any file data flows.
> Under a MITM the two sides derive the code from different keys, so the codes differ
> and the users abort. The code carries ~20 bits, so a MITM has only a ~1-in-10⁶
> chance of inducing a match. Residual: the comparison is only as strong as the
> out-of-band channel the users use to compare (e.g. looking at both screens, a
> phone call). Pinning to the DTLS fingerprint in pure-P2P mode remains future work.

---

## 5. What LinkSpan never does (all modes)

- No accounts, no persistent identity, no analytics on file contents.
- Sessions are ephemeral and in-memory on the server; closing the session discards it.
- No file data is written to durable storage on the server.

---

## 6. Threats explicitly out of scope

- **Malicious peer.** Pairing implies trust of the other party; LinkSpan does not
  defend a sender against a receiver they chose to share with (or vice versa).
- **Compromised endpoint.** A browser running malware can read files regardless.
- **TURN provider correlation.** A TURN provider can see who relayed to whom (IP
  metadata), though not contents.

---

## 7. Summary table

| | Direct P2P | P2P via TURN | Server relay |
|---|:---:|:---:|:---:|
| Server sees file *bytes* (readable) | ✗ | ✗ | ✗ |
| Server forwards file bytes (as ciphertext) | ✗ | ✗ | ✓ (opaque) |
| Server sees file *metadata* | ✗ | ✗ | **✓ (gap — not yet encrypted)** |
| TURN sees file bytes | n/a | ✗ (ciphertext) | n/a |
| DTLS end-to-end | ✓ | ✓ | ✗ |
| App-layer E2E encryption (AES-256-GCM) | ✓ always-on | ✓ always-on | ✓ always-on |
| MITM-checked key exchange (SAS gate) | ✓ | ✓ | ✓ |
| User is told which mode is active | ✓ | ✓ | ✓ |

> **Status note (corrected):** application-layer AES-256-GCM is **implemented and
> always-on** in every mode (`CryptoEngine`, gated by SAS confirmation in
> `useConnection.js` before any file data flows). Earlier drafts of this table listed it
> as "planned (Phase 2.1)" — that was stale. In relay mode the server forwards
> **ciphertext only** and cannot read file contents; the one remaining gap is that file
> *metadata* (name, size, chunk hashes in `file-meta`) is not yet encrypted (see §6).

---

## 8. Share links  (server-stored, asynchronous)

A **share link** is a fundamentally different mode from the live transfers above: there is
no second peer online. The sender uploads bytes to the server's blob store
(`server/src/share/StorageBackend.js`) and the recipient downloads them later. This means
**the server necessarily handles the content** — so confidentiality depends entirely on
whether the *client* encrypted before uploading. Be explicit about this; it does **not**
inherit the P2P trust properties.

**Two cases:**

| | Encrypted upload (default in CLI/SDK with `encrypt`) | Plaintext upload (`--no-encrypt`) |
|---|:---:|:---:|
| Server can read content | ✗ (ciphertext only) | **✓ (server sees plaintext)** |
| Key location | client only; carried in the URL **#fragment** (never sent to the server) | n/a |
| At-rest exposure if disk is seized | ciphertext | **plaintext** |

- **CLI (`linkspan send`)** encrypts with a fresh AES-256-GCM key **by default**. The key
  is appended to the share link as a URL `#k=...` fragment; fragments are never transmitted
  to the server, so the operator never sees the key. `linkspan receive <full-link>`
  auto-decrypts. Opt out with `--no-encrypt`.
- **SDK (`createShare(data, { encrypt: true })`)** generates a key, encrypts before upload,
  sets `metadata.encrypted = 'aes-256-gcm'`, and returns the key as `encryptionKey`. The
  caller chooses how to convey it. Without `encrypt`, the SDK uploads the bytes as-is.
- **Server** stores whatever bytes it is given; it performs **no** server-side encryption
  and treats `metadata.encrypted` as an opaque hint. Password protection (scrypt) gates
  *download*, but a password is **not** content encryption — a passworded plaintext link is
  still readable by the operator.

**Residual:** the key in the URL fragment is only as private as the link itself — anyone
you give the full link to (or who finds it in, e.g., a chat log) can decrypt. For
distribution to an untrusted audience, combine encryption with a download password and/or
single-use + short expiry.
