# Deploying LinkSpan on 100% Free Hosting

A complete, ₹0 / no-credit-card deployment for a portfolio or college project.

| Piece | Service | Free? | Card needed? |
| --- | --- | --- | --- |
| Frontend (Vite SPA) | **Vercel** | Yes | No |
| Signaling server (Node + WebSocket) | **Render** (web service) | Yes | No |
| Blob storage for share links | **Supabase Storage** (S3-compatible) | Yes (1 GB) | No |
| Redis (rate-limit / sessions) | **Upstash** | Yes | No |
| Postgres (optional accounts) | **Supabase Postgres** | Yes | No |
| TURN relay (NAT traversal) | **Metered Open Relay Project** (public free TURN) | Yes (best-effort, no quota signup) | No |
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

## 3. TURN relay — Metered Open Relay Project (recommended, free)

> Note: Metered's **dashboard/account** TURN is now only a **500 MB free trial**,
> not the 50 GB it once offered. Use Metered's separate **Open Relay Project**
> instead — a public, always-free TURN with shared static credentials, no signup,
> no card, no quota gate. The client builds `turn:<domain>:80/443` + `turns:443`
> with static creds (`src/core/PeerConnection.js`), which is exactly what Open
> Relay expects, so it's a zero-code-change drop-in.

Set these on Vercel (no account needed — the credentials are public):

- `VITE_TURN_DOMAIN` = `openrelay.metered.ca`
- `VITE_TURN_USERNAME` = `openrelayproject`
- `VITE_TURN_CREDENTIAL` = `openrelayproject`

Why TURN: STUN (free, Google) handles most NATs, but when both peers are behind
strict/symmetric NAT, direct P2P fails and the connection needs a TURN relay.
Without TURN those specific transfers fall back to the server relay (capped at
100 MB — see §6).

Security note: Open Relay is a blind packet relay below the encryption layers.
Files are encrypted twice — app-layer AES-256-GCM (key derived via ECDH between
the two browsers, never transmitted) and then WebRTC DTLS. The TURN operator
holds neither key and only ever sees doubly-encrypted ciphertext.

Tradeoff: Open Relay is community/best-effort (no SLA). Fine for a portfolio/
demo. If you outgrow it, Cloudflare Realtime TURN has a larger free tier but
issues **short-lived dynamic** credentials via API — the client currently only
supports static creds baked at build time, so that path needs a code change.

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
   - `VITE_TURN_DOMAIN` = `openrelay.metered.ca`  (Open Relay Project — see §3)
   - `VITE_TURN_USERNAME` = `openrelayproject`
   - `VITE_TURN_CREDENTIAL` = `openrelayproject`
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
- **Open Relay Project TURN** is public/best-effort with no signup quota, but no
  SLA — it can be slow or briefly unavailable. Only relayed connections use it;
  direct P2P transfers don't touch it. (Metered's *account* TURN is now just a
  500 MB trial — see §3 for why Open Relay is used instead.)
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
