# LinkSpan Platform Roadmap

Status of the six "platform-grade" features. This session shipped the four that are fully
buildable + testable inside this repo today, and specified the two that require a native
build toolchain / product sign-off.

## Shipped this session ✅

### 1. S3 / GCS storage backends
Cloud blob storage for share links behind the existing `StorageBackend` interface
(`SHARE_STORAGE=s3|gcs`). Streamed uploads with a byte ceiling, HTTP Range reads,
server-generated object keys (no traversal surface). Cloud SDKs are lazy `optionalDependencies`.
Hermetic contract tests run the same suite against memory + S3 + GCS via an injected fake driver.
→ `server/src/share/{S3,Gcs,Object}StorageBackend.js`.

### 2. Webhooks
Outbound HMAC-signed event delivery (`share.*`, `session.created`, `account.created`,
`room.*`) with exponential-backoff retries, a bounded delivery log, and an SSRF guard.
REST CRUD under `/api/v1/webhooks` (scoped), SDK methods + `verifyWebhookSignature`.
Memory + Redis stores. → `server/src/webhooks/*`.

### 3. Accounts / Auth (+ OAuth)
Email/password (scrypt) **and** Google/GitHub OAuth, zero-dep HMAC access JWTs + rotated
refresh tokens, account-scoped API keys (issue/list/revoke). Authenticated requests own
their share links/webhooks; anonymous capability-token use is unchanged. Memory store
default, Prisma/Postgres when `DATABASE_URL` is set. REST `/api/v1/auth/*`, SDK
`register`/`login`/…, CLI `login`/`logout`/`whoami`. → `server/src/accounts/*`,
`server/src/api/{AuthRoutes,authMiddleware}.js`.

### 4. Group rooms — hybrid swarm (protocol 1.6.0)
N-peer rooms; topology adapts by size (direct ≤2, mesh ≤5, swarm 6+). Server is a
coordination plane only (roster + targeted signaling + chunk availability); bytes stay P2P.
Client rarest-first multi-source `SwarmScheduler` + mesh `RoomConnection` + `RoomView` (beta).
Server plane integration-tested; client scheduling/choreography unit-tested.
→ `server/src/rooms/*`, `client/src/{core/RoomConnection,transfer/SwarmScheduler,hooks/useRoom,components/RoomView}`.
See [architecture/swarm.md](../architecture/swarm.md).

## Specified, not coded in this repo (by design) 📐

### 5. Native & mobile apps
Tauri (desktop) + Capacitor (mobile) shells as **separate packages** reusing this repo's
shared protocol/crypto/transfer libraries. Needs a build/signing/store toolchain out of
scope here. → [native-apps.md](./native-apps.md).

### 6. LAN auto-discovery
Real mDNS/DNS-SD only works in a native helper (browsers can't multicast); a privacy-bounded,
opt-in server "same-network hint" can serve browser users but needs a privacy sign-off.
→ [lan-discovery.md](./lan-discovery.md).

## Honest verification notes

- Cloud backends are tested via injected in-memory fake drivers (hermetic), **not** against
  live AWS/GCP — point `SHARE_STORAGE=s3` at a real bucket / MinIO to validate the wire path.
- The group-room **swarm** is verified via simulated multi-peer harnesses + the server
  coordination plane; it is **not yet run with ≥3 real browsers** (the UI is marked beta).
- Accounts' Prisma store path requires `prisma generate` + applied migrations; the in-memory
  store is the one exercised by the test suite.

## Suggested next steps

1. Validate S3/GCS against a real bucket (or MinIO in CI) end-to-end.
2. Multi-browser room/swarm verification (extend the Playwright harness to ≥3 contexts).
3. Extract `@linkspan/shared` + `@linkspan/client-core` packages to unblock the native shells.
4. Wire `account.created` / `room.*` further into the webhook event surface as product needs grow.
