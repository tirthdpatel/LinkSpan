/**
 * ShareLinkClient.test.js — browser share-link create/download with client-side encryption.
 *
 * Uses a tiny in-memory fake of the REST API (so no server is needed) plus the REAL
 * CryptoEngine, to prove: the server only ever receives ciphertext, and the round-trip
 * (encrypt → upload → download → decrypt) reproduces the original bytes.
 */

import { describe, test, expect } from 'vitest';
import { ShareLinkClient, parseShareViewerUrl } from '../share/ShareLinkClient.js';

// Minimal fake of /api/v1: create reserves a link, content stores raw bytes, download
// returns them. Mirrors the real server's shapes closely enough for the client.
function makeFakeApi() {
    const links = new Map();
    let n = 0;
    const id32 = () => (n++).toString(16).padStart(32, '0');

    const fetchImpl = async (url, init = {}) => {
        const u = new URL(url);
        const path = u.pathname;
        const method = (init.method || 'GET').toUpperCase();
        const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

        if (path.endsWith('/links') && method === 'POST') {
            const body = JSON.parse(init.body);
            const id = id32();
            const rec = { id, ...body, bytes: null, uploadToken: 'utok-' + id, ownerToken: 'otok-' + id,
                downloadUrl: `http://api/api/v1/links/${id}/download`, expiresAt: Date.now() + 3600_000,
                passwordProtected: !!body.password, status: 'pending' };
            links.set(id, rec);
            return json(201, rec);
        }
        const mContent = path.match(/\/links\/([a-f0-9]{32})\/content$/);
        if (mContent && method === 'PUT') {
            const rec = links.get(mContent[1]);
            if (!rec) return json(404, { error: { code: 'NOT_FOUND' } });
            rec.bytes = new Uint8Array(init.body instanceof ArrayBuffer ? init.body : init.body);
            rec.status = 'ready';
            return json(200, { id: rec.id, status: 'ready', size: rec.bytes.byteLength });
        }
        const mDl = path.match(/\/links\/([a-f0-9]{32})\/download$/);
        if (mDl && method === 'GET') {
            const rec = links.get(mDl[1]);
            if (!rec || !rec.bytes) return json(404, { error: { code: 'NOT_FOUND' } });
            if (rec.password && init.headers?.['x-share-password'] !== rec.password) {
                return json(401, { error: { code: 'PASSWORD_REQUIRED' } });
            }
            return new Response(rec.bytes, { status: 200, headers: { 'content-type': rec.contentType || 'application/octet-stream' } });
        }
        const mMeta = path.match(/\/links\/([a-f0-9]{32})$/);
        if (mMeta && method === 'GET') {
            const rec = links.get(mMeta[1]);
            if (!rec) return json(404, { error: { code: 'NOT_FOUND' } });
            return json(200, { id: rec.id, filename: rec.filename, size: rec.bytes?.byteLength ?? rec.size,
                contentType: rec.contentType, status: rec.status, passwordProtected: rec.passwordProtected,
                metadata: rec.metadata });
        }
        return json(404, { error: { code: 'NOT_FOUND' } });
    };

    return { fetchImpl, links };
}

const opts = (api) => ({ apiBase: 'http://api/api/v1', fetchImpl: api.fetchImpl, viewerOrigin: 'http://app/' });

describe('ShareLinkClient', () => {
    test('encrypts by default: server stores ciphertext; round-trip restores plaintext', async () => {
        const api = makeFakeApi();
        const client = new ShareLinkClient(opts(api));
        const original = 'browser share-link secret 🔒';
        const blob = new Blob([new TextEncoder().encode(original)], { type: 'text/plain' });

        const link = await client.createShare(blob, { filename: 'note.txt' });
        expect(link.key).toBeTruthy();
        expect(link.shareUrl).toMatch(/\?s=[a-f0-9]{32}#k=/);

        // The bytes the server received must NOT be the plaintext.
        const stored = [...api.links.values()][0].bytes;
        expect(new TextDecoder().decode(stored)).not.toEqual(original);
        expect(stored.byteLength).toBeGreaterThan(new TextEncoder().encode(original).byteLength); // IV+tag

        // Downloading with the key restores the original.
        const { blob: got, filename } = await client.download(link.id, { key: link.key });
        expect(filename).toBe('note.txt');
        expect(await got.text()).toBe(original);
    });

    test('wrong key fails to decrypt (GCM auth)', async () => {
        const api = makeFakeApi();
        const client = new ShareLinkClient(opts(api));
        const link = await client.createShare(new Blob([new Uint8Array([1, 2, 3])]), { filename: 'b.bin' });
        // Tamper the key.
        const badKey = link.key.slice(0, -2) + (link.key.endsWith('A') ? 'BB' : 'AA');
        await expect(client.download(link.id, { key: badKey })).rejects.toThrow();
    });

    test('--no-encrypt path uploads plaintext (server-readable)', async () => {
        const api = makeFakeApi();
        const client = new ShareLinkClient(opts(api));
        const link = await client.createShare(new Blob([new TextEncoder().encode('public data')]), { filename: 'p.txt', encrypt: false });
        expect(link.key).toBeNull();
        expect(link.shareUrl).not.toMatch(/#k=/);
        const stored = [...api.links.values()][0].bytes;
        expect(new TextDecoder().decode(stored)).toBe('public data');
    });

    test('parseShareViewerUrl extracts id + key', () => {
        const id = 'a'.repeat(32);
        expect(parseShareViewerUrl(`http://app/?s=${id}#k=ABC-_123`)).toEqual({ id, key: 'ABC-_123' });
        expect(parseShareViewerUrl(`http://app/?s=${id}`)).toEqual({ id, key: null });
        expect(parseShareViewerUrl('http://app/?s=nope')).toBeNull();
    });
});
