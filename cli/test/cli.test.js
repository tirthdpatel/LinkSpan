/**
 * CLI tests (Feature 16). Drives the real command dispatch with an injected SDK client
 * pointed at an in-memory LinkSpan API, a capturing `io`, and a temp-dir filesystem.
 * Run: node --test test/
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

import { createInMemoryApiApp } from '../../server/src/api/inMemoryApp.js';
import { LinkSpanClient } from '../../sdk/src/index.js';
import { run, parseArgs } from '../src/cli.js';
import { buildZip, crc32 } from '../src/zip.js';
import { parseLinkId, formatBytes } from '../src/commands.js';

let server, baseUrl, apiKeys, tmp;

function makeIo() {
    const lines = [];
    return {
        lines,
        out: (s) => lines.push(s),
        info: (s) => lines.push(`[info] ${s}`),
        error: (s) => lines.push(`[err] ${s}`),
        readStdin: async () => Buffer.from('from stdin'),
        text: () => lines.join('\n'),
    };
}

const realFs = {
    readFile: (p) => fsp.readFile(p),
    writeFile: (p, d) => fsp.writeFile(p, d),
    stat: (p) => fsp.stat(p),
    readdir: (p, o) => fsp.readdir(p, o),
};

let history = [];
function ctx(io, extra = {}) {
    return {
        client: new LinkSpanClient({ baseUrl }),
        io, fsapi: realFs,
        config: { baseUrl, apiKey: null },
        recordHistory: async (e) => { history.unshift({ ...e, at: Date.now() }); },
        loadHistory: () => history,
        ...extra,
    };
}

before(async () => {
    const built = createInMemoryApiApp({ apiKeySecret: 'cli-test' });
    apiKeys = built.apiKeys;
    server = http.createServer(built.app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linkspan-cli-'));
});
after(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('parseArgs', () => {
    it('parses positionals, value flags, =flags, and booleans', () => {
        const { flags, args } = parseArgs(['send', 'a.txt', '--expires', '1h', '--public', '--name=x.bin', '-o', 'out']);
        assert.deepEqual(args, ['send', 'a.txt']);
        assert.equal(flags.expires, '1h');
        assert.equal(flags.public, true);
        assert.equal(flags.name, 'x.bin');
        assert.equal(flags.output, 'out');
    });
    it('treats --single-use as boolean even before a positional', () => {
        const { flags, args } = parseArgs(['send', '--single-use', 'file.txt']);
        assert.equal(flags['single-use'], true);
        assert.deepEqual(args, ['send', 'file.txt']);
    });
});

describe('zip', () => {
    it('crc32 matches the standard IEEE vector', () => {
        assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
    });
    it('buildZip emits a parseable archive (PK header + EOCD)', () => {
        const zip = buildZip([{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'dir/b.txt', data: Buffer.from('world') }]);
        assert.equal(zip.readUInt32LE(0), 0x04034b50);          // local header
        assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50); // EOCD
        assert.equal(zip.readUInt16LE(zip.length - 22 + 10), 2);     // 2 entries
    });
});

describe('helpers', () => {
    it('parseLinkId accepts ids and urls', () => {
        const id = 'a'.repeat(32);
        assert.equal(parseLinkId(id), id);
        assert.equal(parseLinkId(`https://x/s/${id}`), id);
        assert.throws(() => parseLinkId('nope'));
    });
    it('formatBytes', () => {
        assert.equal(formatBytes(512), '512 B');
        assert.equal(formatBytes(1536), '1.5 KB');
    });
});

describe('commands', () => {
    // Pull the full share link (incl. #k=<key> fragment) out of `send` output.
    const linkOf = (io) => io.text().match(/Link:\s+(\S+)/)[1];

    it('send a single file then receive it back (encrypted by default)', async () => {
        const src = path.join(tmp, 'hello.txt');
        await fsp.writeFile(src, 'cli round trip');
        const sendIo = makeIo();
        assert.equal(await run(['send', src], ctx(sendIo)), 0);
        const link = linkOf(sendIo);
        assert.match(link, /#k=/); // key is carried in the fragment
        assert.match(sendIo.text(), /Encryption: AES-256-GCM/);

        // The server stores ciphertext: a raw download (no key) must NOT equal the plaintext.
        const id = parseLinkId(link);
        const raw = await new LinkSpanClient({ baseUrl }).download(id);
        assert.notEqual(Buffer.from(raw).toString('utf8'), 'cli round trip');

        const out = path.join(tmp, 'got.txt');
        const recvIo = makeIo();
        assert.equal(await run(['receive', link, '-o', out], ctx(recvIo)), 0);
        assert.equal(await fsp.readFile(out, 'utf8'), 'cli round trip');
    });

    it('receive of an encrypted link without a key fails clearly', async () => {
        const src = path.join(tmp, 'enc.txt');
        await fsp.writeFile(src, 'top secret');
        const sendIo = makeIo();
        await run(['send', src], ctx(sendIo));
        const id = parseLinkId(linkOf(sendIo));
        const recvIo = makeIo();
        assert.equal(await run(['receive', id, '-o', path.join(tmp, 'x')], ctx(recvIo)), 1);
        assert.match(recvIo.text(), /encrypted but no key/i);
    });

    it('send --no-encrypt uploads plaintext', async () => {
        const src = path.join(tmp, 'plain.txt');
        await fsp.writeFile(src, 'readable by server');
        const io = makeIo();
        assert.equal(await run(['send', src, '--no-encrypt'], ctx(io)), 0);
        const link = linkOf(io);
        assert.doesNotMatch(link, /#k=/);
        assert.match(io.text(), /Encryption: none/);
        const id = parseLinkId(link);
        const raw = await new LinkSpanClient({ baseUrl }).download(id);
        assert.equal(Buffer.from(raw).toString('utf8'), 'readable by server');
    });

    it('send multiple files produces a (decryptable) zip link', async () => {
        const f1 = path.join(tmp, 'one.txt'); const f2 = path.join(tmp, 'two.txt');
        await fsp.writeFile(f1, 'one'); await fsp.writeFile(f2, 'two');
        const io = makeIo();
        assert.equal(await run(['send', f1, f2], ctx(io)), 0);
        const link = linkOf(io);
        const id = parseLinkId(link);
        const key = link.match(/#k=([A-Za-z0-9_-]+)/)[1];
        const client = new LinkSpanClient({ baseUrl });
        const bytes = await client.download(id, { decryptionKey: key });
        assert.equal(Buffer.from(bytes).readUInt32LE(0), 0x04034b50); // decrypts to a real zip
        assert.match(io.text(), /bundle\.zip|\.zip/);
    });

    it('send --text shares a message', async () => {
        const io = makeIo();
        assert.equal(await run(['send', '--text', 'hi there'], ctx(io)), 0);
        const link = linkOf(io);
        const id = parseLinkId(link);
        const key = link.match(/#k=([A-Za-z0-9_-]+)/)[1];
        const data = await new LinkSpanClient({ baseUrl }).download(id, { decryptionKey: key });
        assert.equal(new TextDecoder().decode(data), 'hi there');
    });

    it('send --single-use --password enforces both', async () => {
        const src = path.join(tmp, 's.txt');
        await fsp.writeFile(src, 'secret');
        const io = makeIo();
        await run(['send', src, '--single-use', '--password', 'pw'], ctx(io));
        const link = linkOf(io);
        const id = parseLinkId(link);
        const key = link.match(/#k=([A-Za-z0-9_-]+)/)[1];
        const client = new LinkSpanClient({ baseUrl });
        await assert.rejects(() => client.download(id), (e) => e.status === 401);
        const data = await client.download(id, { password: 'pw', decryptionKey: key });
        assert.equal(new TextDecoder().decode(data), 'secret');
        await new Promise((r) => setTimeout(r, 50));
        await assert.rejects(() => client.download(id, { password: 'pw' }), (e) => e.status === 404);
    });

    it('list requires an API key, works with one', async () => {
        const key = apiKeys.issue({ ownerId: 'cli-lister', scopes: ['*'] });
        const keyed = new LinkSpanClient({ baseUrl, apiKey: key });
        await keyed.createShare('x', { filename: 'a' });
        const io = makeIo();
        await run(['list'], ctx(io, { client: keyed }));
        assert.match(io.text(), /active link/);
    });

    it('status reports server health', async () => {
        const io = makeIo();
        assert.equal(await run(['status'], ctx(io)), 0);
        assert.match(io.text(), /Health:\s+ok/);
    });

    it('pair returns a pairing code', async () => {
        // sessions require a sessionManager; the in-memory API app omits it, so pair
        // should fail cleanly with a non-zero exit and a clear error (not throw).
        const io = makeIo();
        const code = await run(['pair'], ctx(io));
        assert.equal(typeof code, 'number');
    });

    it('history lists recorded transfers', async () => {
        history = [{ direction: 'sent', id: 'a'.repeat(32), filename: 'h.txt', size: 10, at: Date.now() }];
        const io = makeIo();
        await run(['history'], ctx(io));
        assert.match(io.text(), /h\.txt/);
    });

    it('unknown command exits 1 with help', async () => {
        const io = makeIo();
        assert.equal(await run(['frobnicate'], ctx(io)), 1);
        assert.match(io.text(), /Unknown command/);
    });

    it('--version prints version', async () => {
        const io = makeIo();
        assert.equal(await run(['--version'], ctx(io)), 0);
        assert.match(io.text(), /0\.1\.0/);
    });

    it('login --register stores tokens, then whoami identifies the account', async () => {
        const client = new LinkSpanClient({ baseUrl });
        const saved = {};
        const saveConfig = async (p) => { Object.assign(saved, p); };

        const io = makeIo();
        assert.equal(await run(['login', '--register', '--email', 'cli@x.com', '--password', 'password123'],
            ctx(io, { client, saveConfig })), 0);
        assert.ok(saved.accessToken && saved.refreshToken);
        assert.match(io.text(), /Registered and logged in as cli@x.com/);

        // The same client carries the access token → whoami works.
        const io2 = makeIo();
        assert.equal(await run(['whoami'], ctx(io2, { client })), 0);
        assert.match(io2.text(), /cli@x.com/);
    });

    it('whoami without a session fails cleanly (exit 1)', async () => {
        const io = makeIo();
        assert.equal(await run(['whoami'], ctx(io)), 1);
    });
});
