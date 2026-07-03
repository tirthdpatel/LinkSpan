# Deploying LinkSpan on 100% Free Hosting

A complete, ₹0 / no-credit-card deployment for a portfolio or college project.

| Piece | Service | Free? | Card needed? |
| --- | --- | --- | --- |
| Frontend (Vite SPA) | **Vercel** | Yes | No |
| Signaling server (Node + WebSocket) | **Render** (web service) | Yes | No |
| Blob storage for share links | **Supabase Storage** (S3-compatible) | Yes (1 GB) | No |
| Redis (rate-limit / sessions) | **Upstash** | Yes | No |
| Postgres (optional accounts) | **Supabase Postgres** | Yes | No |
| TURN relay (NAT traversal) | **Cloudflare Realtime TURN** (ephemeral creds via server) | Yes (1 TB/month) | No |
| STUN | Google public STUN | Yes | No |

**Architecture is WebRTC-first:** actual file bytes move **peer-to-peer between
browsers** and never touch the server on the direct path. The server only does
signaling (matchmaking) + an optional capped relay fallback. That's what makes
free hosting viable even for large files.

> Order matters: provision the data services first (Supabase, Upstash, Metered),
> then deploy the server (Render), then the client (Vercel). The client and server
> each need the other's final URL.

---

## 0. Prerequisites

- The repo pushed to GitHub (Vercel and Render both deploy from GitHub).
- A way to generate secrets: `openssl rand -hex 32` (or any random 64-hex string).

---

## 1. Supabase — Storage (required) + Postgres (optional)

Create a free project at <https://supabase.com> (sign in with GitHub, no card).

### 1a. Storage bucket (required — this is the production blocker, see §8)

1. Project → **Storage** → **New bucket** → name it `linkspan-blobs`. Keep it
   **Private**.
2. Project → **Storage** → **Settings** (or **S3 Connection**) → enable the
   **S3 connection** and **create new access keys**. Copy:
   - **Endpoint** — looks like `https://<PROJECT_REF>.supabase.co/storage/v1/s3`
   - **Region** — e.g. `us-east-1` (whatever Supabase shows)
   - **Access key ID** and **Secret access key**
3. You'll paste these into Render as `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`,
   `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.

> ⚠️ **Region must match.** Supabase signs S3 requests with SigV4, which embeds
> the region in the credential scope — a mismatch returns **403 on every storage
> call**. `render.yaml` ships a default `S3_REGION` value, but Supabase assigns
> *your* project's region (e.g. `ap-northeast-2`). Use whatever the S3 Connection
> panel shows; override `S3_REGION` in `render.yaml` (or the Render dashboard) to
> match before deploying.

### 1b. Postgres (optional — only for persistent user accounts)

The app runs fully **without** Postgres (anonymous use works; accounts just live
in memory and reset on restart). Skip this unless you want logins to persist.
See §7 for the extra steps (it requires adding Prisma).

---

## 2. Upstash — Redis (recommended)

1. Create a free database at <https://upstash.com> (GitHub sign-in, no card).
   Pick a region close to your Render region (Oregon → US West).
2. On the database page, copy the **`rediss://`** connection URL (the TLS one,
   under "Node / ioredis"). It looks like:
   `rediss://default:<password>@<name>.upstash.io:6379`
3. Save it — it becomes `REDIS_URL` on Render.

Redis is optional: omit `REDIS_URL` and the server falls back to in-memory
(fine for a single Render instance). With it, rate-limits and share-link
metadata survive restarts.

---

## 3. TURN relay — Cloudflare Realtime TURN (recommended, free, no card)

The server can mint **ephemeral TURN credentials** at
`GET /api/v1/turn-credentials` (`server/src/api/TurnCredentials.js`); the client
fetches them at connection time (`client/src/core/IceServers.js`). No TURN
secret ships in the public JS bundle, and no `VITE_TURN_*` build-time env is
needed.

**No-card setup — ExpressTURN (recommended if you can't add billing info):**

Cloudflare's Realtime TURN has the biggest free quota (1 TB/month) but requires
billing details to activate. ExpressTURN's free tier needs only an email signup.

1. Sign up at <https://www.expressturn.com> (free) → dashboard shows your relay
   endpoint + **username** + **credential**.
2. Set on Render (see `render.yaml`):
   - `TURN_URLS` = e.g. `turn:relay1.expressturn.com:3480`
   - `TURN_USERNAME` = your ExpressTURN username
   - `TURN_CREDENTIAL` = your ExpressTURN credential
3. Done — the server serves these at `/api/v1/turn-credentials`. They're fixed
   (not ephemeral), but they live in server env instead of the client bundle, so
   rotating them is an env edit, not a redeploy. Zero-signup fallback: Metered's
   public Open Relay (`TURN_URLS=turn:openrelay.metered.ca:80,turn:openrelay.metered.ca:443`,
   username/credential `openrelayproject`) — best-effort, no SLA.

**Cloudflare setup (free tier: 1 TB/month relayed; requires billing info on file):**

1. Create a free Cloudflare account → dashboard → **Realtime → TURN** → create a
   TURN key. You get a **Key ID** and an **API token**.
2. Set on Render (see `render.yaml`):
   - `CLOUDFLARE_TURN_KEY_ID`
   - `CLOUDFLARE_TURN_API_TOKEN`
3. Done — the server caches minted credentials (default TTL 2 h, override with
   `TURN_CRED_TTL_SECONDS`) so the Cloudflare API is hit at most a few times per
   TTL window, and the client caches its fetched list per page session.

**Self-hosted alternative (coturn):** run the `coturn/` compose service with
`use-auth-secret`, then set `TURN_STATIC_SECRET` (same value as coturn's
`static-auth-secret`) and `TURN_URLS`
(e.g. `turn:turn.example.com:3478,turns:turn.example.com:5349`). Credentials are
computed locally per the TURN REST-API convention — no external API involved.

**Legacy static fallback:** if the endpoint is unreachable or returns empty, the
client falls back to `VITE_TURN_DOMAIN`/`VITE_TURN_USERNAME`/`VITE_TURN_CREDENTIAL`
build-time env (e.g. Metered's public Open Relay Project:
domain `openrelay.metered.ca`, username/credential `openrelayproject`), and
finally to STUN-only. Note that static creds baked into the bundle are public —
anyone can lift them, which is exactly why the ephemeral path exists.

Why TURN: STUN (free, Google) handles most NATs, but when both peers are behind
strict/symmetric NAT, direct P2P fails and the connection needs a TURN relay.
Without TURN those specific transfers fall back to the server relay (capped at
100 MB — see §6).

Security note: any TURN server is a blind packet relay below the encryption
layers. Files are encrypted twice — app-layer AES-256-GCM (key derived via ECDH
between the two browsers, never transmitted) and then WebRTC DTLS. The TURN
operator holds neither key and only ever sees doubly-encrypted ciphertext.

Running without TURN entirely is also fine for a demo: ~80–90% of peers connect
via STUN, and the rest use the WebSocket server relay (slower, size-capped).

---

## 4. Render — signaling server

The repo includes a [`render.yaml`](render.yaml) Blueprint.

1. <https://render.com> → sign in with GitHub (no card for the free web service).
2. **New +** → **Blueprint** → select your repo. Render reads `render.yaml`,
   creates the `linkspan-signaling` web service, and **auto-generates**
   `TOKEN_SECRET`, `AUTH_JWT_SECRET`, `METRICS_TOKEN`.
3. It will prompt for the `sync:false` values. Paste:
   - `CORS_ORIGIN` → your Vercel URL (you can use a placeholder now and update
     after step 5, then redeploy). e.g. `https://linkspan.vercel.app`
   - `PUBLIC_BASE_URL` → your Render URL, e.g.
     `https://linkspan-signaling.onrender.com`
   - `SHARE_VIEW_URL` → your Vercel URL
   - `REDIS_URL` → the Upstash `rediss://` URL from §2
   - `S3_BUCKET` = `linkspan-blobs`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`,
     `S3_SECRET_ACCESS_KEY` from §1a
4. **Apply** / **Create**. Wait for the build and the first health check on
   `/health` to go green.
5. Note the service URL (`https://<name>.onrender.com`). Its WebSocket URL is the
   same host with `wss://`.

> Don't have a Vercel URL yet? Render and Vercel reference each other. Deploy the
> client first with a placeholder `VITE_SIGNALING_URL`, or deploy the server with
> a placeholder `CORS_ORIGIN`, then come back and fix both + redeploy.

If the server fails to boot, read its logs — the production gate prints exactly
which variable is missing (see §8).

---

## 5. Vercel — client

The repo includes [`client/vercel.json`](client/vercel.json) (SPA rewrites,
security headers, CSP that already allows `wss:`).

1. <https://vercel.com> → **Add New** → **Project** → import the repo.
2. Set **Root Directory** to `client`. Vercel auto-detects Vite.
3. Add **Environment Variables** (Production):
   - `VITE_SIGNALING_URL` = `wss://<your-render-host>.onrender.com`  ← must be `wss://`
   - (optional legacy fallback — see §3; not needed when the server has
     Cloudflare TURN configured) `VITE_TURN_DOMAIN` / `VITE_TURN_USERNAME` /
     `VITE_TURN_CREDENTIAL`
4. **Deploy.** Copy the resulting URL (e.g. `https://linkspan.vercel.app`).
5. Go back to Render → set `CORS_ORIGIN` and `SHARE_VIEW_URL` to that exact URL
   (no trailing slash) → **Manual Deploy / Save**. The client and server now
   point at each other.

> `VITE_*` values are baked in at **build time**. Any change requires a Vercel
> redeploy.

---

## 6. Verify it works

1. Open the Vercel URL in two browser windows (ideally two devices/networks).
2. Send a file from one to the other. Accept the offer on the receiver.
3. In the connection indicator you should see **Direct P2P** (or "via TURN" if
   relayed). Files transfer browser-to-browser.
4. Test a **share link** (the "upload for later" feature) — this exercises the
   Supabase S3 storage path.

What to expect on free tier:
- **First request after idle is slow** (~50s) because Render free sleeps the
  service after 15 min. Subsequent requests are fast.
- **Large files**: fine over **direct P2P / TURN** (they never hit the server).
  The **server relay fallback is capped at 100 MB per session**
  (`MAX_RELAY_SESSION_BYTES`) — that path is only used when both P2P and TURN
  fail. Share-link uploads are capped at 5 GB per link by code, but Supabase
  free storage is **1 GB total**, so that's your real ceiling.

---

## 7. Optional: persistent accounts (Supabase Postgres)

Accounts/logins work in-memory by default (reset on restart). To persist them:

1. Add Prisma to the server (not currently a dependency):
   ```bash
   cd server
   npm install @prisma/client
   npm install --save-dev prisma
   ```
2. Point Prisma at the schema and apply the migration to Supabase:
   ```bash
   export DATABASE_URL="postgresql://postgres.<REF>:<PW>@aws-0-<REGION>.pooler.supabase.com:6543/postgres?pgbouncer=true"
   npx prisma generate --schema src/database/schema.prisma
   npx prisma migrate deploy --schema src/database/schema.prisma
   ```
3. In Render set `DATABASE_URL` to the Supabase **pooler** string (port 6543),
   and change `render.yaml` `buildCommand` to also run
   `npx prisma generate --schema server/src/database/schema.prisma`.
4. Redeploy. The server auto-detects `DATABASE_URL` and switches the account
   store to Postgres.

Use the **pooler** (port 6543, `pgbouncer=true`), not the direct 5432 connection
— Supabase free has a low direct-connection limit.

---

## 8. Known free-tier limitations & blockers

**Hard requirement (was a blocker, now solved):** the server's production gate
(`src/http/prodPrereqs.js`) **refuses to boot** with the filesystem or memory
blob backend when `NODE_ENV=production`. It demands `SHARE_STORAGE=s3` or `gcs`.
That's why Supabase Storage (S3-compatible) is wired in §1a — it satisfies the
gate for free. Do **not** set `NODE_ENV` to anything but `production` to dodge
this; that would disable the security hardening.

The gate also requires, and the configs above supply: `TOKEN_SECRET`,
`METRICS_TOKEN`, an explicit `CORS_ORIGIN` (not `*`), and `TRUSTED_PROXY_COUNT`.

Other limitations to be aware of:
- **Render free sleep** → ~50s cold start after 15 min idle. No always-on without
  a paid plan (or an external pinger, which only partly helps and can burn the
  monthly free hours).
- **Render free hours** are limited per month across all free services on the
  account.
- **Upstash free** has a monthly command quota; light demo traffic stays well
  within it.
- **Supabase free storage = 1 GB**; projects pause after ~1 week of total
  inactivity (just reopen the dashboard to resume).
- **Cloudflare Realtime TURN** free tier is 1 TB/month of relayed traffic — and
  only TURN-relayed connections consume it; direct P2P transfers don't touch it.
  Credentials are ephemeral (minted by the signaling server), so nothing to
  rotate if the repo or bundle leaks. (Metered's *account* TURN is now just a
  500 MB trial; their public Open Relay Project still works as the static
  fallback — see §3.)
- **No custom domain TLS work needed** — Vercel and Render both give HTTPS/WSS
  on their default domains automatically.

Nothing in this stack requires a credit card or a paid upgrade for a
portfolio-scale deployment.

---

## Quick reference — where each variable goes

**Render (server):** `NODE_ENV`, `TOKEN_SECRET`*, `AUTH_JWT_SECRET`*,
`METRICS_TOKEN`*, `CORS_ORIGIN`, `TRUSTED_PROXY_COUNT`, `PUBLIC_BASE_URL`,
`SHARE_VIEW_URL`, `REDIS_URL`, `SHARE_STORAGE=s3`, `S3_*`. (* auto-generated.)

**Vercel (client):** `VITE_SIGNALING_URL` (wss://), `VITE_TURN_USERNAME`,
`VITE_TURN_CREDENTIAL`, optional `VITE_TURN_DOMAIN`, optional `VITE_API_URL`.

See [`server/.env.example`](server/.env.example) and
[`client/.env.example`](client/.env.example) for the full annotated lists.
