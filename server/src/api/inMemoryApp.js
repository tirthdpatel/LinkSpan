/**
 * inMemoryApp — build a fully-functional LinkSpan REST API Express app backed entirely by
 * in-memory stores (no Redis, no disk, no signaling server).
 *
 * Used by the server's own API integration tests and re-exported for the SDK's test
 * harness, so both exercise the *real* router rather than a mock. Because this module
 * lives under server/src, its `express` / rate-limiter imports resolve against the
 * server's node_modules — callers in other packages (e.g. the SDK) can import it without
 * needing those dependencies themselves.
 *
 * Not just for tests: it's also a minimal embedding example for hosting the API inside an
 * existing Express server.
 */

import express from 'express';
import { MemoryStorageBackend } from '../share/StorageBackend.js';
import { MemoryShareLinkStore } from '../share/ShareLinkStore.js';
import { ShareLinkManager } from '../share/ShareLinkManager.js';
import { ApiKeyManager } from './ApiKeyManager.js';
import { HttpRateLimiter } from './HttpRateLimiter.js';
import { createApiRouter } from './ShareLinkRoutes.js';
import { MemoryWebhookStore } from '../webhooks/WebhookStore.js';
import { WebhookManager } from '../webhooks/WebhookManager.js';
import { TelemetryAggregator } from '../telemetry/TelemetryAggregator.js';
import { MemoryAccountStore } from '../accounts/AccountStore.js';
import { AccountManager } from '../accounts/AccountManager.js';
import { API_BASE_PATH } from '../../../shared/constants.js';

/**
 * @param {object} [opts]
 * @param {string} [opts.apiKeySecret]
 * @param {boolean} [opts.allowAnonymous]
 * @param {string} [opts.baseUrl]
 * @returns {{ app: import('express').Express, apiKeys: ApiKeyManager, shareLinks: ShareLinkManager }}
 */
export function createInMemoryApiApp(opts = {}) {
    const { apiKeySecret = 'in-memory-secret', allowAnonymous = true, baseUrl = '', webhooks, oauthProviders, turnCredentials } = opts;

    const app = express();
    app.use(express.json({ limit: '16kb' }));
    app.use((req, _res, next) => { req.clientIp = req.clientIp || '127.0.0.1'; next(); });

    const apiKeys = new ApiKeyManager({ secret: apiKeySecret, allowAnonymous });
    const accountManager = new AccountManager({
        store: new MemoryAccountStore(),
        jwtSecret: `${apiKeySecret}-jwt`,
        apiKeys,
    });
    const shareLinks = new ShareLinkManager({
        store: new MemoryShareLinkStore(),
        storage: new MemoryStorageBackend(),
        baseUrl,
    });
    // Tests may inject a WebhookManager (e.g. with a mock fetch + allowPrivate); otherwise
    // build a default in-memory one so the webhook routes are exercised.
    const webhookManager = webhooks || new WebhookManager({ store: new MemoryWebhookStore(), allowPrivate: true });
    const telemetry = new TelemetryAggregator();

    app.use(API_BASE_PATH, createApiRouter({
        shareLinks,
        apiKeys,
        httpLimiter: new HttpRateLimiter({}),
        webhooks: webhookManager,
        accountManager,
        oauthProviders: oauthProviders || {},
        telemetry,
        turnCredentials,
        baseUrl,
    }));

    return { app, apiKeys, shareLinks, webhooks: webhookManager, accountManager, telemetry };
}
