#!/usr/bin/env node
/**
 * Example: create a password-protected, single-use share link and download it back.
 *
 *   LINKSPAN_URL=https://share.example node examples/share-a-file.mjs ./photo.jpg
 *
 * With an API key (so you can also list/manage your links):
 *   LINKSPAN_URL=... LINKSPAN_API_KEY=lk1... node examples/share-a-file.mjs ./photo.jpg
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { LinkSpanClient } from '../src/index.js';

const baseUrl = process.env.LINKSPAN_URL || 'http://127.0.0.1:10000';
const apiKey = process.env.LINKSPAN_API_KEY;
const file = process.argv[2];

if (!file) {
    console.error('Usage: node examples/share-a-file.mjs <path-to-file>');
    process.exit(1);
}

const client = new LinkSpanClient({ baseUrl, apiKey });

const bytes = await readFile(file);
const filename = path.basename(file);

console.log(`Uploading ${filename} (${bytes.length} bytes) to ${baseUrl} ...`);
const link = await client.createShare(bytes, {
    filename,
    visibility: 'public',
    expiresIn: '24h',
    password: 'demo-password',
    singleUse: true,
});

console.log('\n✓ Share link created');
console.log('  URL:        ', link.url || `${baseUrl}/s/${link.id}`);
console.log('  Download:   ', link.downloadUrl);
console.log('  Expires at: ', new Date(link.expiresAt).toISOString());
console.log('  Password:    demo-password (single-use)');
if (link.ownerToken) console.log('  ownerToken: ', link.ownerToken, '(needed to revoke)');

// Download it straight back to prove it works (consumes the single use).
const data = await client.download(link.id, { password: 'demo-password' });
console.log(`\n✓ Downloaded ${data.length} bytes back (matches: ${data.length === bytes.length}).`);
