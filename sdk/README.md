# @linkspan/sdk

Official JavaScript / TypeScript / Node.js SDK for the [LinkSpan](../README.md) share-link
REST API. Zero runtime dependencies. Works in Node.js ≥ 18 and modern browsers (uses the
global `fetch`).

## Install

```bash
npm install @linkspan/sdk
```

## Quick start

```js
import { LinkSpanClient } from '@linkspan/sdk';

const client = new LinkSpanClient({
  baseUrl: 'https://share.example',   // your LinkSpan server
  apiKey: 'lk1...',                    // optional; needed for listLinks() and sessions
});

// Create a public, password-protected link that expires in 24h.
const link = await client.createShare(fileBytes, {
  filename: 'report.pdf',
  visibility: 'public',
  expiresIn: '24h',
  password: 'hunter2',
  maxDownloads: 5,
});

console.log(link.url);          // shareable URL
console.log(link.downloadUrl);  // direct download URL

// Download it back.
const bytes = await client.download(link.id, { password: 'hunter2' });
```

`createShare` accepts a `Uint8Array`, `ArrayBuffer`, `Blob`, `Buffer`, or `string`.

## API

| Method | Description |
| --- | --- |
| `info()` / `health()` | API metadata and health. |
| `createLink(options)` | Reserve a link; returns `{ id, uploadToken, ownerToken?, ... }`. |
| `uploadContent(id, uploadToken, data)` | Upload bytes to a reserved link. |
| `createShare(data, options)` | Create + upload in one call. |
| `getLink(id)` | Public metadata. |
| `download(id, { password })` | Download bytes → `Uint8Array`. |
| `downloadStream(id, { password })` | Download as a `Response` for streaming. |
| `revoke(id, { ownerToken })` | Revoke a link (owner key or capability token). |
| `listLinks()` | List the API key's links (requires `apiKey`). |
| `createSession()` / `getSession(id)` | Bridge to live WebRTC signaling sessions. |

### Options (`CreateLinkOptions`)

| Field | Type | Notes |
| --- | --- | --- |
| `filename` | string | Sanitized server-side. |
| `visibility` | `'temp' \| 'public'` | Default `temp`. |
| `expiresIn` | `'5m'\|'1h'\|'24h'\|'7d'` or ms | Custom values clamped to server bounds. |
| `password` | string | Optional download password. |
| `maxDownloads` | number | Multi-use cap; omit for unlimited. |
| `singleUse` | boolean | Reaped after the first download. |
| `metadata` | object | Opaque client metadata, e.g. `{ encrypted: true }`. |

## End-to-end encryption

LinkSpan's browser app encrypts content **before** upload, so the server only ever stores
ciphertext. The SDK uploads whatever bytes you give it — if you need confidentiality,
encrypt before `createShare` and decrypt after `download`, and tag the link with
`metadata: { encrypted: true }`.

## Errors

All failures throw a `LinkSpanError` with `.code`, `.status` (HTTP status), and `.body`.

```js
import { LinkSpanError } from '@linkspan/sdk';
try {
  await client.download(id, { password: 'wrong' });
} catch (err) {
  if (err instanceof LinkSpanError && err.status === 403) console.log('Wrong password');
}
```

## Versioning

Semantic versioning. The current public surface is stable as of `0.1.0`; breaking changes
bump the major version. See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
