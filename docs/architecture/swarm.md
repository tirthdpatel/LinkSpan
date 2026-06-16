# Group Rooms & Hybrid Swarm Distribution

*Protocol 1.6.0.* This document describes the multi-peer ("group room") subsystem and the
hybrid topology that scales from 2 peers to a small swarm.

## Why

The classic LinkSpan flow connects exactly two peers. Sending one file to *N* recipients
with that model means the sender uploads the file *N* times — its uplink is the bottleneck,
and a relay-only design would just move that cost onto the server. A swarm spreads the work:
once a peer has a chunk it becomes a source for that chunk, so total upload capacity grows
with the number of participants (the property that made BitTorrent scale).

## Topology decision tree

Topology is derived purely from the current peer count (`pickRoomTopology` in
`shared/constants.js`), so it adapts as members join and leave:

| Peers | Topology | Behavior |
|------:|----------|----------|
| 2 | `direct` | The existing 1:1 WebRTC path (unchanged). |
| 3–5 | `mesh` | Every peer holds a DataChannel to every other; the sender pushes to each. Simple, low coordination, fine for small groups. |
| 6+ | `swarm` | Peers pull chunks **rarest-first** from whichever peers already hold them and **re-announce** each received chunk, so downloaders become uploaders. |
| any (P2P fails) | relay fallback | The existing server relay forwards ciphertext for a pair whose ICE fails. |

`ROOM_MESH_THRESHOLD = 5`, `MAX_ROOM_PEERS = 16`.

## Control plane vs. data plane

The server is a **coordination plane only** — it never sees file bytes:

- **RoomManager** (`server/src/rooms/RoomManager.js`) — roster, join codes, lifecycle, and
  the routing primitives `sendToPeer` (targeted) and `broadcast`. A Redis-backed subclass
  would mirror `RedisSessionManager`'s cross-instance pub/sub for horizontal scaling.
- **ChunkAvailabilityRegistry** (`server/src/rooms/ChunkAvailabilityRegistry.js`) — tracks
  which peer holds which chunk index of which file, answers "who has chunk *i*?"
  (`SWARM_NEED` → `SWARM_PEERS`), and computes rarest-first ordering. Metadata only.

The **data plane** is the WebRTC mesh: `core/RoomConnection.js` keeps one `PeerConnection`
per other member (negotiated data channels, reusing the 1:1 building blocks) with
deterministic glare avoidance (the lexicographically smaller peer id is the offerer).
`transfer/SwarmScheduler.js` runs on top, pulling chunks rarest-first in parallel from
multiple sources and re-announcing each one via `SWARM_HAVE`.

## Signaling

N-peer signaling reuses `offer`/`answer`/`ice-candidate` with an added `to` (target peer id);
the server routes by id and stamps `from`. Room lifecycle and swarm coordination add:

```
Client → Server: create-room | join-room | leave-room
                 swarm-announce {fileId,totalChunks,origin} | swarm-have {fileId,indices}
                 swarm-need {fileId,index}
Server → Client: room-created {roomId,joinCode,peerId,token,topology}
                 room-roster {peers,topology} | room-peer-joined | room-peer-left
                 swarm-announce/swarm-have (gossiped) | swarm-peers {fileId,index,peers}
```

Every room/swarm message is bound to a room member token (HMAC, same scheme as session
tokens) verified server-side, and validated by `InputValidator` before processing.

## Encryption & key distribution

In a swarm a chunk may arrive from a peer that is **not** the original sender, so a per-pair
session key (as used in the 1:1 path) can't decrypt it. Instead the room **owner generates a
single symmetric room key and wraps it to each peer over that peer's authenticated ECDH
channel** (the existing SAS-verified pairing authenticates the wrap). Every chunk is
encrypted under the room key, so any peer's copy decrypts for any other member, while the
server — which only ever sees ciphertext via the relay fallback — cannot read it.

## Status

The server coordination plane (`RoomManager`, `ChunkAvailabilityRegistry`) is
integration-tested, and the client scheduling/choreography (`SwarmScheduler`,
`RoomConnection`) is unit-tested against simulated multi-peer meshes (byte-exact
reconstruction, multi-source sourcing, rarest-first ordering, glare avoidance). The full
≥3-real-browser swarm transfer is **not yet verified end-to-end** and the UI is marked beta.
