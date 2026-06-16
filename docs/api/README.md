# LinkSpan REST API

The REST API (added in the share-link release) exposes **share links** and **signaling
sessions** over HTTP, alongside the existing WebSocket signaling protocol. It is versioned
at `/api/v1` and described by an [OpenAPI 3.1 spec](./openapi.json) (also served live at
`GET /api/v1/openapi.json`).

> The live P2P/relay WebRTC transfer path is unchanged. Share links are an **additive**
> capability: bytes are uploaded to the server's blob store so a recipient can download
> later, when the sender is offline.

## Base URL

```
https://<your-server>/api/v1
```

Set `PUBLIC_BASE_URL` on the server so generated `url`/`downloadUrl` fields are absolute.

## Authentication

Management endpoints (create/list/revoke links, create sessions) accept an **API key** as a
Bearer token:

```
Authorization: Bearer lk1...
```

Mint a signed key (the same `API_KEY_SECRET` must be set on the server):

```bash
API_KEY_SECRET=$(openssl rand -hex 32) \
  node server/scripts/issue-api-key.mjs alice links:write links:read
```

Static keys are also supported for simple deploys:
`LINKSPAN_API_KEYS="secretA=ownerA,secretB=ownerB"`.

**Anonymous capability mode** (default outside production, `API_ALLOW_ANONYMOUS`): you can
create links without a key. The response includes a one-time `ownerToken` — store it; it's
required (via `X-Owner-Token`) to revoke the link later. Anonymous links can't be listed
(no account to list under).

Scopes: `links:write`, `links:read`, `sessions:write`, or `*`.

## Rate limiting

Per-IP, independent of the WebSocket limits:

| Bucket | Limit | Applies to |
| --- | --- | --- |
| `api` | 120/min | general calls |
| `upload` | 60/hour | link creation + content upload |
| `download` | 30/min | downloads (also bounds password brute force) |

`429` responses include a `Retry-After` header.

## Endpoints

### Create a link — `POST /links`

```bash
curl -X POST https://share.example/api/v1/links \
  -H 'authorization: Bearer lk1...' \
  -H 'content-type: application/json' \
  -d '{
    "filename": "report.pdf",
    "size": 1048576,
    "visibility": "public",
    "expiresIn": "24h",
    "password": "hunter2",
    "maxDownloads": 5
  }'
```

Returns `201` with the link plus a one-time `uploadToken` (and `ownerToken` when
anonymous). `expiresIn` is a preset (`5m`, `1h`, `24h`, `7d`) or custom milliseconds
(clamped to `[1 min, 30 days]`).

### Upload content — `PUT /links/:id/content`

The request body **is** the file. Streamed straight to storage; never buffered whole.

```bash
curl -X PUT "https://share.example/api/v1/links/$ID/content" \
  -H "x-upload-token: $UPLOAD_TOKEN" \
  --data-binary @report.pdf
```

### Metadata — `GET /links/:id`

Public metadata (no secrets). `passwordProtected: true` signals a password is needed.

### Download — `GET /links/:id/download`

Password via `X-Share-Password` header or `?password=`. Enforces expiry, download limits,
and single-use; the response is sent with `Content-Disposition: attachment` and a
restrictive CSP so content can never render inline.

### Revoke — `DELETE /links/:id`

Authenticated by the owning API key, or `X-Owner-Token` for anonymous links. Deletes the
blob and metadata immediately.

### List — `GET /links`

Lists the API key owner's links. Requires a key.

### Sessions — `POST /sessions`, `GET /sessions/:id`

`POST /sessions` mints a pairing code + signed peer token for the live signaling flow; a
browser/app peer then joins via the WebSocket protocol. `GET /sessions/:id` returns status.

### Webhooks — `/webhooks` (API key required)

Subscribe a URL to server events. Requires an API key (anonymous capability tokens can't
own webhooks). Scopes: `webhooks:read`, `webhooks:write`.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/webhooks` | Register `{ url, events[], secret? }`. Returns the endpoint incl. the signing `secret` **once**. |
| `GET` | `/webhooks` | List the caller's endpoints. |
| `GET` | `/webhooks/:id` | Fetch one (no secret). |
| `DELETE` | `/webhooks/:id` | Delete one. |
| `POST` | `/webhooks/:id/test` | Send a synthetic `ping` delivery. |
| `GET` | `/webhooks/:id/deliveries` | Recent delivery attempts (bounded log). |

Events: `share.created`, `share.uploaded`, `share.downloaded`, `share.revoked`,
`share.expired`, `session.created`, `account.created`, `room.created`,
`room.peer_joined`, or `*` for all.

Each delivery is a `POST` of `{ id, type, createdAt, data }` with headers:

```
X-LinkSpan-Event:     share.created
X-LinkSpan-Delivery:  <delivery id>           # idempotency key
X-LinkSpan-Signature: t=<unixSeconds>,v1=<hex hmac-sha256(secret, `${t}.${rawBody}`)>
```

Verify with `verifyWebhookSignature(secret, header, rawBody, { toleranceSec })` from the
SDK (compute the HMAC over the **raw** body bytes, not re-serialized JSON). A non-2xx
response or network error is retried with exponential backoff up to 5 attempts.
Registration is SSRF-guarded: non-`http(s)` and private/loopback hosts are rejected unless
`WEBHOOK_ALLOW_PRIVATE=true`.

## Error format

```json
{ "error": { "code": "PASSWORD_INCORRECT", "message": "Incorrect password" } }
```

Status codes: `400` validation, `401` auth/password required, `403` wrong password / not
owner, `404` not found, `409` not ready, `410` expired / limit reached / revoked, `413`
too large, `429` rate limited.

## SDK & CLI

- [`@linkspan/sdk`](../../sdk/README.md) — JS/TS/Node client.
- [`@linkspan/cli`](../../cli/README.md) — `linkspan send/receive/list/...`.
