# Deploying LinkSpan

LinkSpan has two deployable pieces with very different hosting needs:

| Piece | What it is | Where it can run |
| --- | --- | --- |
| **Client** (`client/`) | Static Vite SPA | Vercel, Netlify, any static host / CDN |
| **Signaling server** (`server/`) | Stateful Node + `ws` WebSocket server | A long-running host (Render, Fly.io, Railway, a VM/k8s) — **not** Vercel |

> The signaling server holds in-memory/Redis session state and long-lived WebSocket
> connections, so it cannot run on Vercel's serverless functions. Deploy it on a
> platform that supports persistent processes and WebSockets.

## Client → Vercel

The client is a standard Vite SPA. A [`client/vercel.json`](../client/vercel.json) is
included with SPA rewrites, cache headers, and the same security headers as the nginx
image (`script-src 'self'`, etc.).

1. **Import the repo** into Vercel.
2. Set **Root Directory** to `client`.
   - Vercel checks out the whole repository, so the `@shared` → `../shared` import
     still resolves at build time; Vite bundles `shared/constants.js` into the output,
     so there is no runtime dependency on files outside `client/`.
3. Vercel auto-detects the Vite framework (`buildCommand: npm run build`,
   `outputDirectory: dist` are also pinned in `vercel.json`).
4. Set the **environment variable** so the client knows where the signaling server is:
   - `VITE_SIGNALING_URL = wss://your-signaling-host.example.com`
   - This is read at build time (`import.meta.env.VITE_SIGNALING_URL`), so a redeploy
     is required after changing it.
   - Do **not** set `VITE_FORCE_RELAY` in production — it is a local-only test switch.
5. Deploy.

## Signaling server (separate host)

Deploy `server/` as a normal Node service (see `server/Dockerfile`). Required env:

- `TOKEN_SECRET` — HMAC secret (`openssl rand -hex 32`); **required** in production.
- `CORS_ORIGIN` — your Vercel client URL, e.g. `https://linkspan.vercel.app`. The
  server **refuses to start** in production with the default `*`.
- `REDIS_URL` — optional; enables multi-instance session routing, cross-instance rate
  limiting, and brute-force lockouts. Omit for a single node.
- `METRICS_TOKEN` — optional bearer token gating `/stats` and `/metrics`.
- `TRUSTED_PROXY_COUNT` — number of trusted proxy hops for `X-Forwarded-For` (e.g. `1`
  behind a single load balancer) so client IPs can't be spoofed.

After both are up, the client (`VITE_SIGNALING_URL`) and server (`CORS_ORIGIN`) must
point at each other's URLs.
