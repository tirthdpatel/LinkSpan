#!/usr/bin/env node
/**
 * Mint a signed LinkSpan REST API key.
 *
 * Usage:
 *   API_KEY_SECRET=... node scripts/issue-api-key.mjs <ownerId> [scope ...] [--expires <dur>]
 *
 * Scopes default to ['*']. Common scopes: links:write links:read sessions:write.
 * --expires accepts a duration like 30d, 12h, 90m, or raw milliseconds. Omit for a
 * non-expiring key (prefer an expiry for externally distributed keys so a leak self-limits).
 * The same API_KEY_SECRET (or TOKEN_SECRET) must be set on the server for the key to
 * verify. Print and store the key securely — it cannot be recovered.
 *
 * Example:
 *   API_KEY_SECRET=$(openssl rand -hex 32) node scripts/issue-api-key.mjs alice links:write --expires 30d
 */

import { ApiKeyManager } from '../src/api/ApiKeyManager.js';

const argv = process.argv.slice(2);
let expiresInMs;
const rest = [];
for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--expires') { expiresInMs = parseDuration(argv[++i]); continue; }
    rest.push(argv[i]);
}
const [ownerId, ...scopes] = rest;

function parseDuration(s) {
    const m = /^(\d+)(ms|s|m|h|d)?$/.exec(String(s || '').trim());
    if (!m) { console.error(`Invalid --expires "${s}". Use e.g. 30d, 12h, 90m, or milliseconds.`); process.exit(1); }
    const n = Number(m[1]);
    const unit = { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] || 'ms'];
    return n * unit;
}

if (!ownerId) {
    console.error('Usage: node scripts/issue-api-key.mjs <ownerId> [scope ...] [--expires <dur>]');
    process.exit(1);
}

if (!process.env.API_KEY_SECRET && !process.env.TOKEN_SECRET) {
    console.error('Refusing to mint a key with an ephemeral secret.');
    console.error('Set API_KEY_SECRET (or TOKEN_SECRET) to the value the server uses, e.g.:');
    console.error('  API_KEY_SECRET=$(openssl rand -hex 32) node scripts/issue-api-key.mjs <ownerId>');
    process.exit(1);
}

const mgr = new ApiKeyManager();
const key = mgr.issue({ ownerId, scopes: scopes.length ? scopes : ['*'], expiresInMs });

console.log(key);
if (expiresInMs) console.error(`# expires ${new Date(Date.now() + expiresInMs).toISOString()}`);
