# Manual Verification — Live Encrypted Transfer (Two Browsers)

This is the smoke test that the automated suite cannot do: confirming the **live**
encrypted path between two real browsers, including the proof that the server-relay
fallback carries **ciphertext only**.

Time: ~10 minutes. You need a terminal and a Chromium-based browser (Chrome/Edge) for
the DevTools WebSocket inspector.

---

## 0. Prerequisites

```bash
cd LinkSpan
( cd server && npm install )
( cd client && npm install )
```

---

## 1. Start the two servers

**Terminal 1 — signaling server:**
```bash
cd server
PORT=10000 npm start
# → [LinkSpan] Signaling server running on port 10000
```

**Terminal 2 — client dev server:**
```bash
cd client
npm run dev
# → Local: http://localhost:5173
```

Open **two browser windows** (or two tabs; a normal tab + an Incognito window works
well so they don't share state) at `http://localhost:5173`.

> Throughout, keep DevTools open (F12) on **both** windows and watch the **Console** —
> the app logs connection/relay state there.

---

## 2. Make a test file with a known marker

A file full of a unique marker lets us later prove the server never sees plaintext.

```bash
# ~1.5 MB of a repeating, unmistakable marker (multiple chunks)
python3 -c "open('/tmp/ls_marker.txt','w').write('LINKSPAN_PLAINTEXT_MARKER_'*60000)"
ls -l /tmp/ls_marker.txt
```

Also note the marker's base64 form (what a naive "encode-don't-encrypt" relay would
leak). If THIS string never appears in relay frames either, encryption is real:

```bash
printf 'LINKSPAN_PLAINTEXT_MARKER_' | base64
# → TElOS1NQQU5fUExBSU5URVhUX01BUktFUl8=   (prefix: TElOS1NQQU5fUExBSU5U)
```

---

## 3. Test A — Direct P2P, encrypted (default mode)

1. **Window 1 (Sender):** click **Send Files** → choose `/tmp/ls_marker.txt`. A pairing
   code appears.
2. **Window 2 (Receiver):** click **Receive Files** → enter the pairing code.
3. Watch the transfer view in **both** windows.

**Pass criteria:**

- [ ] The **Connection Mode** card shows **✓ Direct P2P** (green) and the line
      **🔒 End-to-end encrypted · AES-256-GCM (ECDH session key)**.
- [ ] Progress reaches 100% and the receiver shows **✅ Transfer complete**.
- [ ] The file downloads on the receiver. Verify it is byte-identical:
      ```bash
      diff /tmp/ls_marker.txt ~/Downloads/ls_marker.txt && echo "IDENTICAL ✓"
      ```
- [ ] No errors in either Console.

> Why no wire inspection here: a P2P DataChannel isn't visible in the Network panel.
> To confirm it's genuinely peer-to-peer, open `chrome://webrtc-internals` in the
> sender — the selected candidate pair should be `host`/`srflx` (not `relay`), matching
> the "Direct P2P" the UI reported.

---

## 4. Test B — Server relay, encrypted (the critical path)

On localhost, P2P always succeeds, so we force the relay fallback with a dev switch.

**Stop the client dev server (Terminal 2) and restart it with the switch on:**
```bash
cd client
VITE_FORCE_RELAY=true npm run dev
```

Reload both browser windows. Repeat the send/receive from Test A.

**Pass criteria — behavior:**

- [ ] The **Connection Mode** card shows **⚠ Relayed** (amber) with
      **🔒 End-to-end encrypted (AES-256-GCM). The server forwards ciphertext only…**
- [ ] The transfer still completes and the downloaded file is byte-identical
      (`diff` as above).

**Pass criteria — PROOF the server sees only ciphertext** (do this in the **Sender**
window's DevTools):

1. Open **Network → WS** → click the `localhost:10000` connection → **Messages** tab.
2. You should see `key-exchange` frames first (each with a `pub` field — the ECDH
   public keys), then many `relay-chunk` frames.
3. In the Messages **filter box**, search for `LINKSPAN_PLAINTEXT_MARKER`:
   - [ ] **Zero matches.** The plaintext marker never appears in any frame.
4. Also search for the base64 prefix `TElOS1NQQU5fUExBSU5U`:
   - [ ] **Zero matches.** Not even base64-of-plaintext leaks — the `b64` payloads are
         AES-GCM ciphertext.
5. Click one `relay-chunk` frame with `isText: false` and confirm its `b64` value is
   opaque (changes every chunk; no readable structure).

If steps 3–4 find zero matches while the file still arrives intact, the relay is
provably carrying ciphertext only. ✅

---

## 5. Test C — Resume / crash recovery

1. Use a **larger** file so the transfer lasts a few seconds:
   ```bash
   head -c 60000000 /dev/urandom > /tmp/ls_big.bin   # 60 MB
   ```
2. Start a transfer (Test A, default P2P).
3. **Midway through**, in the **Receiver** window, hit **Reload** (or click **Pause**,
   wait, then resume).
4. Re-pair / let it reconnect and continue.

**Pass criteria:**

- [ ] After reload the receiver does **not** restart from 0% — it resumes near where it
      left off (the IndexedDB chunk ledger survived).
- [ ] The transfer completes and the file is byte-identical (`diff`/`cmp`).
- [ ] On completion the receiver Console shows no "manifest root mismatch" — whole-file
      verification passed on the resumed transfer.

> The ledger flushes immediately on **Pause** and is bounded to ≤1 s of lag during a
> burst, so a reload loses at most ~1 s of progress.

---

## 6. Test D — Tamper detection (optional, fast)

This confirms the integrity layer rejects corruption rather than delivering a bad file.
Easiest via the unit test that already encodes it:

```bash
cd client
npx vitest run src/__tests__/EncryptedTransfer.test.js
```

- [ ] `bytes on the wire are ciphertext, not plaintext` — passes
- [ ] `a wrong session key fails decryption (no silent corruption)` — passes
- [ ] `whole-file manifest mismatch is rejected (no corrupt completion)` — passes

(For a live tamper test you'd need a proxy to flip a relay frame; the unit test covers
the same code path deterministically.)

---

## 7. Cleanup

- Stop the dev server and **restart it WITHOUT** `VITE_FORCE_RELAY` (that switch is for
  testing only — never ship it enabled).
- Stop the signaling server (Ctrl-C in Terminal 1).
- `rm /tmp/ls_marker.txt /tmp/ls_big.bin`

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Receiver can't connect | Signaling server not running, or `VITE_SIGNALING_URL` mismatch (default `ws://localhost:10000`). |
| Test B still shows "Direct P2P" | Dev server wasn't restarted with `VITE_FORCE_RELAY=true`, or the tab wasn't reloaded. |
| "Relay limit exceeded" in Console | Test B file exceeds `MAX_RELAY_SESSION_BYTES` (100 MB). Use a smaller file for relay tests. |
| Connection Mode shows "🔓 handshake in progress" and stays | ECDH `key-exchange` didn't complete — check both Consoles for errors; confirm both tabs are on the same build. |
| Download didn't trigger | Some browsers block the auto-download; check the browser's download bar / popup blocker. |

---

## What this verifies (and what it doesn't)

**Verifies:** the live ECDH handshake completes between two real browsers; transfers
complete intact over both P2P and relay; the relay genuinely forwards ciphertext; resume
survives a reload; whole-file verification gates completion.

**Does not cover:** cross-network NAT traversal / real TURN usage (needs two machines on
different networks), the full browser matrix (Firefox/Safari/Edge — Phase 7), and active-
MITM resistance during key exchange (the documented residual risk in
[../architecture/trust-model.md](../architecture/trust-model.md) §4).
