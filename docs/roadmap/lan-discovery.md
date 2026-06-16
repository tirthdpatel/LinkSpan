# LAN Auto-Discovery — Architecture & Roadmap

**Status: planned. No code in the web repo.** Browsers cannot do mDNS/DNS-SD, so true
zero-config "see devices on your network" discovery requires a native helper (see
[native-apps.md](./native-apps.md)). This document specifies the approach for both the
native path (real LAN discovery) and a privacy-bounded server-assisted path for
browser-only users.

## The constraint

A web page has no API to multicast on the local network — it cannot advertise itself or
browse for peers via Bonjour/NSD. Anything that claims "LAN discovery" in a pure browser is
actually using a server hint, not the LAN. So discovery is split into two tiers.

## Tier 1 — Native mDNS / DNS-SD (real LAN discovery)

In the Tauri/Capacitor shells:

- **Advertise** a service `_linkspan._tcp` (or `_udp`) with TXT records carrying the device
  name, device type, a short-lived rotating discovery id, and the SAS-relevant public-key
  fingerprint — *not* a pairing code (so a passive listener can't auto-join).
- **Browse** the same service to list nearby devices, then connect via the normal WebRTC
  flow using host candidates (no STUN/TURN needed on a shared LAN).
- **Security**: discovery only reveals *presence*; an actual transfer still requires the
  receiver to accept (the existing receive-confirmation gate) and the SAS code to match, so
  a discovered device cannot push files without consent. The advertised id rotates so a
  device isn't trackable across networks/time.

Implementations: Tauri → Rust `mdns-sd`; iOS → `NSNetService`/`NWBrowser`; Android →
`NsdManager`. These expose results to the shared web UI through the `Discovery` interface
that the web app stubs out (returns "not supported in browser").

## Tier 2 — Server-assisted "same-network" hint (browser fallback)

For browser-only users, an **opt-in** server hint approximates LAN discovery:

- Peers that opt in register a presence beacon with the signaling server. The server groups
  beacons by a **coarse network key** (e.g. the public egress IP, optionally salted per day)
  and tells a peer "N other LinkSpan users appear to share your network."
- Discovery still reveals only presence + a display name; pairing requires the usual
  accept + SAS.

**Privacy caveats (must be explicit and opt-in):**

- Grouping by public IP is approximate — corporate NAT/CGNAT can group strangers; VPNs can
  split a household. It is a *hint*, never an identity.
- The egress IP is already visible to the server from the connection; the beacon only adds
  the user's *intent to be discoverable* and a display name. Default is **off**.
- Beacons are short-lived and rotated; the server stores only a hashed, daily-salted network
  key, never raw IP↔identity mappings, and never cross-network history.

This tier is a thin, optional server feature (a presence map keyed by `hash(salt ∥ egressIP)`
with TTL) that can be added to the existing signaling server without touching the transfer
path — but it ships behind an explicit opt-in and a clear privacy explanation, so it is
deferred until the product decision and UX copy are signed off.

## Phased delivery

1. **Native Tier 1** alongside the Tauri desktop MVP — the real feature.
2. **Mobile Tier 1** with the Capacitor app.
3. **Tier 2 server hint** (optional, opt-in) for browser users, gated on a privacy review.

Tier 1 cannot run in this web repo (no mDNS in browsers); Tier 2 is intentionally deferred
behind opt-in + privacy sign-off. Hence: specification now, code with the native shells.
