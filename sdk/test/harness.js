/**
 * Test harness: start a real LinkSpan REST API backed by in-memory stores, on an
 * ephemeral port. Reuses the server's own app factory (createInMemoryApiApp) so the SDK
 * is tested against the actual API implementation, not a mock. The factory lives under
 * server/src, so its express/rate-limiter imports resolve against the server's
 * node_modules without the SDK package needing those dependencies.
 */

import http from 'node:http';
import { createInMemoryApiApp } from '../../server/src/api/inMemoryApp.js';

export async function startTestServer() {
    const { app, apiKeys, shareLinks } = createInMemoryApiApp({ apiKeySecret: 'sdk-test-secret' });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    return { server, baseUrl, apiKeys, shareLinks, stop: () => new Promise((r) => server.close(r)) };
}
