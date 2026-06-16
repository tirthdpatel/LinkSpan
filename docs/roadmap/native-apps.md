# Native & Mobile Apps — Architecture & Roadmap

**Status: planned. No code lives in this web repo yet — by design.** Desktop and mobile
shells will be **separate packages** that reuse this repo's shared protocol, signaling,
encryption, and transfer libraries. Keeping them out of the web app avoids bloating the
browser bundle and lets each shell evolve on its own release/signing cadence.

## Why native shells at all

The browser app is the product. Native shells add only what a browser cannot do:

- **True LAN auto-discovery** (mDNS / DNS-SD) — see [lan-discovery.md](./lan-discovery.md).
- **Background transfers** that survive the app being backgrounded or the screen locking.
- **First-class filesystem access** without the File System Access API's prompts/limits,
  including resumable writes to arbitrary paths.
- **OS share-sheet / "Open with LinkSpan" / drag-and-drop** integration.
- **Deep-link / custom-scheme handling** (`linkspan://pair?code=…`) registered with the OS.
- **Persistent identity & notifications** (a stable device key, push for incoming transfers).

## Technology choices

| Target | Shell | Rationale |
|--------|-------|-----------|
| Desktop (macOS/Windows/Linux) | **Tauri** | Tiny binaries, Rust core for mDNS + filesystem + a bundled TURN-less LAN path; reuses the existing web UI as the renderer. |
| Mobile (iOS/Android) | **Capacitor** | Wraps the existing React UI; native plugins for mDNS (`NSNetService`/`NsdManager`), background tasks, share sheet, and notifications. |

Both render the **same React client** from `client/`, so the UI is built once.

## What is reused vs. native-only

Reused **unchanged** from this repo (published as small internal packages or a git
submodule):

- `shared/constants.js` — protocol, message types, limits, `PROTOCOL_VERSION`.
- `client/src/core/*` — `SignalingClient`, `PeerConnection`, `ChannelManager`, `CryptoEngine`
  (ECDH + SAS), `RoomConnection`.
- `client/src/transfer/*` — chunking, `Sender`/`Receiver`, `BatchSender`/`BatchReceiver`,
  `SwarmScheduler`, manifest/integrity.
- `sdk/` — `@linkspan/sdk` for share-link/REST/account/webhook calls.

Native-only modules (live in the native repos, behind a thin interface the web app stubs):

- `discovery` — mDNS/DNS-SD advertise + browse (Tauri: Rust `mdns-sd`; Capacitor: platform
  Bonjour/NSD plugin).
- `fs` — resumable native file writes (replaces the `StorageManager` FSAPI/OPFS tier).
- `deeplink` / `share` / `notifications` — OS integration.

The web `StorageManager` and discovery code already sit behind interfaces, so the native
shells provide alternative implementations rather than forking the transfer engine.

## Proposed repo layout (future)

```
linkspan/                  (this repo — web client, server, sdk, cli)
linkspan-desktop/          (Tauri; depends on @linkspan/client + @linkspan/shared)
linkspan-mobile/           (Capacitor; same dependencies + native plugins)
```

To enable this cleanly, a follow-up in *this* repo should publish `shared/` and the reusable
`client/src/core` + `client/src/transfer` modules as versioned packages (e.g.
`@linkspan/shared`, `@linkspan/client-core`) so the native repos consume stable artifacts
instead of reaching into source paths.

## Phased delivery

1. **Extract reusable packages** (in this repo): `@linkspan/shared`, `@linkspan/client-core`.
   Add an explicit `Discovery` and `Storage` interface boundary.
2. **Tauri desktop MVP**: bundle the web UI, implement native `fs` + `deeplink`. Ship LAN
   discovery (Phase 1 of [lan-discovery.md](./lan-discovery.md)).
3. **Capacitor mobile MVP**: bundle the web UI, implement share-sheet + background transfer +
   notifications; add mobile mDNS.
4. **Signing/store pipelines**: Apple notarization, Windows code signing, Play/App Store
   submission, auto-update (Tauri updater / store delivery).

Each step needs a build/signing toolchain that is out of scope for the web repo, which is
why this is a specification rather than scaffold code.
