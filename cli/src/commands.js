/**
 * CLI command implementations (Feature 16).
 *
 * Each command is a pure-ish async function taking a context:
 *   { client, args, flags, config, io, fsapi }
 * where `io` abstracts stdout/stderr and `fsapi` abstracts the filesystem, so commands are
 * unit-testable without touching real I/O. cli.js wires the real client/io/fs.
 *
 * Transport model: the CLI sends via *share links* (upload to server, recipient downloads
 * later). This works across NAT without a live peer, which is the right model for a CLI —
 * unlike the browser app's live P2P/relay path. `pair` still bridges to live signaling so
 * a CLI user can hand a pairing code to the browser app.
 */

import path from 'node:path';
import { buildZip } from './zip.js';

const EXPIRY_PRESETS = ['5m', '1h', '24h', '7d'];

/** Walk a directory into { name, data } zip entries (relative, forward-slash paths). */
async function collectDir(fsapi, root) {
    const entries = [];
    const base = path.basename(root.replace(/[/\\]+$/, '')) || 'folder';
    async function walk(dir, prefix) {
        const items = await fsapi.readdir(dir, { withFileTypes: true });
        for (const it of items) {
            const full = path.join(dir, it.name);
            const rel = prefix ? `${prefix}/${it.name}` : it.name;
            if (it.isDirectory()) await walk(full, rel);
            else if (it.isFile()) entries.push({ name: `${base}/${rel}`, data: await fsapi.readFile(full) });
        }
    }
    await walk(root, '');
    return entries;
}

/** Resolve send inputs (files/dirs/text/stdin) into { data, filename, contentType }. */
async function resolvePayload({ args, flags, fsapi, io }) {
    // Text mode: --text "..." or piped stdin via --stdin
    if (flags.text != null) {
        return { data: Buffer.from(String(flags.text), 'utf8'), filename: flags.name || 'message.txt', contentType: 'text/plain; charset=utf-8' };
    }
    if (flags.stdin) {
        const data = await io.readStdin();
        return { data, filename: flags.name || 'stdin.txt', contentType: 'text/plain; charset=utf-8' };
    }
    if (!args.length) throw new CliError('Nothing to send. Provide file(s)/folder, --text, or --stdin.');

    // Single file → send as-is.
    if (args.length === 1) {
        const stat = await fsapi.stat(args[0]);
        if (stat.isFile()) {
            return { data: await fsapi.readFile(args[0]), filename: flags.name || path.basename(args[0]), contentType: 'application/octet-stream' };
        }
    }

    // Multiple inputs or a directory → pack into a ZIP.
    const entries = [];
    for (const p of args) {
        const stat = await fsapi.stat(p);
        if (stat.isDirectory()) entries.push(...await collectDir(fsapi, p));
        else if (stat.isFile()) entries.push({ name: path.basename(p), data: await fsapi.readFile(p) });
    }
    if (!entries.length) throw new CliError('No readable files in the given paths.');
    const zipName = flags.name || (args.length === 1 ? `${path.basename(args[0].replace(/[/\\]+$/, ''))}.zip` : 'bundle.zip');
    io.info(`Packing ${entries.length} file(s) into ${zipName} ...`);
    return { data: buildZip(entries), filename: zipName, contentType: 'application/zip' };
}

export class CliError extends Error {}

function expiry(flags) {
    if (flags.expires == null) return undefined;
    if (EXPIRY_PRESETS.includes(flags.expires)) return flags.expires;
    const n = Number(flags.expires);
    if (Number.isFinite(n) && n > 0) return n; // milliseconds
    throw new CliError(`Invalid --expires "${flags.expires}". Use one of ${EXPIRY_PRESETS.join(', ')} or milliseconds.`);
}

// ── send ───────────────────────────────────────────────────────
export async function send({ client, args, flags, io, fsapi, recordHistory }) {
    const { data, filename, contentType } = await resolvePayload({ args, flags, fsapi, io });

    // Encrypt client-side BY DEFAULT so the server stores ciphertext it cannot read. The
    // key is returned by the SDK and carried in the link's URL #fragment below — fragments
    // are never sent to the server, so the operator never sees the key. Opt out with
    // --no-encrypt (e.g. a public download anyone should be able to open from the id alone).
    const encrypt = flags.encrypt !== false && flags['no-encrypt'] !== true;

    const link = await client.createShare(data, {
        filename,
        contentType,
        visibility: flags.public ? 'public' : 'temp',
        expiresIn: expiry(flags),
        password: flags.password || undefined,
        maxDownloads: flags['max-downloads'] != null ? Number(flags['max-downloads']) : undefined,
        singleUse: Boolean(flags['single-use']),
        encrypt,
    });

    const baseLink = link.url || link.downloadUrl;
    // Append the key as a URL fragment so `linkspan receive <url>` auto-decrypts.
    const shareLink = link.encryptionKey ? `${baseLink}#k=${link.encryptionKey}` : baseLink;
    await recordHistory({ direction: 'sent', id: link.id, filename, size: data.length, url: shareLink });

    io.out('');
    io.out(`  ✓ Shared ${filename} (${formatBytes(data.length)})`);
    io.out(`  Link:     ${shareLink}`);
    io.out(`  Download: ${link.downloadUrl}`);
    io.out(`  Encryption: ${link.encryptionKey ? 'AES-256-GCM (key in link fragment — keep the link private)' : 'none (--no-encrypt; server can read content)'}`);
    io.out(`  Expires:  ${new Date(link.expiresAt).toISOString()}`);
    if (link.passwordProtected) io.out('  Password: required');
    if (link.singleUse) io.out('  Single-use: yes');
    else if (link.maxDownloads != null) io.out(`  Max downloads: ${link.maxDownloads}`);
    if (link.ownerToken) io.out(`  Owner token (to revoke): ${link.ownerToken}`);
    return link;
}

// ── receive ────────────────────────────────────────────────────
export async function receive({ client, args, flags, io, fsapi, recordHistory }) {
    const ref = args[0];
    if (!ref) throw new CliError('Usage: linkspan receive <id|url> [-o output] [--key <k>]');
    const id = parseLinkId(ref);
    const decryptionKey = parseKey(ref, flags);
    const meta = await client.getLink(id).catch(() => null);

    // If the link is marked encrypted but we have no key, fail with a clear message rather
    // than silently saving undecryptable ciphertext.
    if (meta?.metadata?.encrypted && !decryptionKey) {
        throw new CliError(
            'This link is encrypted but no key was provided. Use the full share link ' +
            '(including the #k=... fragment) or pass --key <key>.'
        );
    }

    let data;
    try {
        data = await client.download(id, { password: flags.password, decryptionKey });
    } catch (err) {
        if (decryptionKey) {
            throw new CliError(`Download/decrypt failed (wrong key or corrupted data): ${err.message}`);
        }
        throw err;
    }
    const filename = flags.output || (meta && meta.filename) || `${id}.bin`;
    await fsapi.writeFile(filename, data);
    await recordHistory({ direction: 'received', id, filename, size: data.length });
    io.out(`  ✓ Saved ${filename} (${formatBytes(data.length)})${decryptionKey ? ' (decrypted)' : ''}`);
    return { filename, size: data.length };
}

// ── list ───────────────────────────────────────────────────────
export async function list({ client, io }) {
    const { links, count } = await client.listLinks();
    if (!count) { io.out('No active links.'); return; }
    io.out(`${count} active link(s):`);
    for (const l of links) {
        io.out(`  ${l.id}  ${l.filename.padEnd(24)} ${formatBytes(l.size).padStart(9)}  ` +
            `${l.visibility}  exp ${new Date(l.expiresAt).toISOString()}  dl ${l.downloadCount}` +
            `${l.maxDownloads != null ? `/${l.maxDownloads}` : ''}`);
    }
}

// ── revoke ─────────────────────────────────────────────────────
export async function revoke({ client, args, flags, io }) {
    const id = parseLinkId(args[0] || '');
    await client.revoke(id, { ownerToken: flags['owner-token'] });
    io.out(`  ✓ Revoked ${id}`);
}

// ── status ─────────────────────────────────────────────────────
export async function status({ client, config, io }) {
    const info = await client.info();
    const health = await client.health();
    io.out(`Server:   ${config.baseUrl}`);
    io.out(`API:      ${info.name} ${info.version}`);
    io.out(`Health:   ${health.status}`);
    io.out(`Storage:  ${info.capabilities?.storageBackend || 'unknown'}`);
    io.out(`Auth:     ${config.apiKey ? 'API key configured' : (info.capabilities?.anonymous ? 'anonymous allowed' : 'API key required')}`);
}

// ── pair (bridge to live signaling) ────────────────────────────
export async function pair({ client, config, io }) {
    const session = await client.createSession();
    io.out('  ✓ Pairing session created. Enter this code in the LinkSpan app to connect:');
    io.out('');
    io.out(`      ${session.pairingCode}`);
    io.out('');
    io.out(`  Or open: ${config.baseUrl}/?code=${session.pairingCode}`);
    io.out(`  Session: ${session.sessionId}`);
    return session;
}

// ── history (local) ────────────────────────────────────────────
export async function history({ io, loadHistory }) {
    const list = loadHistory();
    if (!list.length) { io.out('No transfer history.'); return; }
    io.out(`${list.length} record(s):`);
    for (const h of list.slice(0, 50)) {
        io.out(`  ${new Date(h.at).toISOString()}  ${h.direction.padEnd(8)} ${String(h.filename).padEnd(24)} ` +
            `${formatBytes(h.size).padStart(9)}  ${h.id}`);
    }
}

// ── accounts (login/logout/whoami) ─────────────────────────────
export async function login({ client, args, flags, io, saveConfig }) {
    const email = flags.email || args[0];
    const password = flags.password || args[1];
    if (!email || !password) throw new CliError('Usage: linkspan login --email <email> --password <password> [--register]');
    const session = flags.register ? await client.register({ email, password }) : await client.login({ email, password });
    await saveConfig({ accessToken: session.accessToken, refreshToken: session.refreshToken });
    io.out(`✓ ${flags.register ? 'Registered and logged in' : 'Logged in'} as ${session.account.email}`);
    return session;
}

export async function logout({ client, config, io, saveConfig }) {
    if (config.refreshToken) await client.logout(config.refreshToken).catch(() => {});
    await saveConfig({ accessToken: '', refreshToken: '' });
    io.out('✓ Logged out');
}

export async function whoami({ client, io }) {
    const { account } = await client.me();
    io.out(`${account.email} (${account.id})${account.provider ? ` via ${account.provider}` : ''}`);
}

// ── helpers ────────────────────────────────────────────────────
const LINK_ID_RE = /^[a-f0-9]{32}$/;
export function parseLinkId(ref) {
    const s = String(ref).trim();
    if (LINK_ID_RE.test(s)) return s;
    // Accept a full URL containing /s/<id> or /links/<id>...
    const m = s.match(/[a-f0-9]{32}/);
    if (m && LINK_ID_RE.test(m[0])) return m[0];
    throw new CliError(`Not a valid link id or URL: ${ref}`);
}

/**
 * Extract the content-decryption key for `receive`, preferring an explicit --key flag and
 * otherwise reading it from the share link's URL fragment (#k=<key>). The fragment is the
 * by-default carrier written by `send`. Returns undefined when there is no key.
 */
export function parseKey(ref, flags = {}) {
    if (flags.key) return String(flags.key);
    const m = String(ref).match(/[#&]k=([A-Za-z0-9_-]+)/);
    return m ? m[1] : undefined;
}

export function formatBytes(n) {
    if (!Number.isFinite(n)) return '?';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

export const COMMANDS = { send, receive, list, revoke, status, pair, history, login, logout, whoami };
