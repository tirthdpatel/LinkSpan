/**
 * AuthRoutes — account authentication endpoints, mounted at /api/v1/auth.
 *
 *   POST /auth/register          { email, password } → { account, accessToken, refreshToken }
 *   POST /auth/login             { email, password } → same
 *   POST /auth/refresh           { refreshToken }     → rotated { accessToken, refreshToken }
 *   POST /auth/logout            { refreshToken }     → { ok }
 *   GET  /auth/me                (access token)       → { account }
 *   GET  /auth/providers         list enabled OAuth providers
 *   GET  /auth/oauth/:provider             → 302 to the IdP consent screen (signed state)
 *   GET  /auth/oauth/:provider/callback    → validates state, exchanges code, issues a session
 *
 *   POST   /auth/api-keys        (access token) { scopes?, label?, expiresInMs? } → { key } once
 *   GET    /auth/api-keys        (access token) → list (no secrets)
 *   DELETE /auth/api-keys/:jti   (access token) → revoke a single key
 *
 * On OAuth callback success, if AUTH_SUCCESS_URL is configured the browser is redirected
 * there with tokens in the URL fragment (never sent to a server); otherwise tokens are
 * returned as JSON (used by tests and non-browser clients).
 */

import express from 'express';
import { API_BASE_PATH } from '../../../shared/constants.js';

export function createAuthRouter(deps) {
    const { accountManager, oauthProviders = {}, audit = () => {}, apiLimit, baseUrl = '', successUrl = '' } = deps;
    const router = express.Router();
    const limit = apiLimit || ((_req, _res, next) => next());

    const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => sendError(res, err));

    const requireAccount = (req, res, next) => {
        const header = req.headers['authorization'] || '';
        const m = /^Bearer\s+(.+)$/i.exec(header);
        const acct = m && accountManager.verifyAccessToken(m[1].trim());
        if (!acct) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Login required' } });
        req.account = acct;
        next();
    };

    // ── Email/password ─────────────────────────────────────────
    router.post('/register', limit, wrap(async (req, res) => {
        const { email, password } = req.body || {};
        const session = await accountManager.register({ email, password });
        audit('ACCOUNT_CREATED', { id: session.account.id, ip: req.clientIp });
        res.status(201).json(session);
    }));

    router.post('/login', limit, wrap(async (req, res) => {
        const { email, password } = req.body || {};
        res.json(await accountManager.login({ email, password }));
    }));

    router.post('/refresh', limit, wrap(async (req, res) => {
        const { refreshToken } = req.body || {};
        res.json(await accountManager.refresh(refreshToken));
    }));

    router.post('/logout', limit, wrap(async (req, res) => {
        await accountManager.logout((req.body || {}).refreshToken);
        res.json({ ok: true });
    }));

    router.get('/me', limit, requireAccount, wrap(async (req, res) => {
        const account = await accountManager.me(req.account.accountId);
        if (!account) return sendError(res, { code: 'NOT_FOUND', message: 'Account not found', httpStatus: 404 });
        res.json({ account });
    }));

    // ── OAuth ──────────────────────────────────────────────────
    router.get('/providers', (_req, res) => {
        res.json({ providers: Object.keys(oauthProviders) });
    });

    const redirectUriFor = (provider) => `${baseUrl}${API_BASE_PATH}/auth/oauth/${provider}/callback`;

    router.get('/oauth/:provider', limit, wrap(async (req, res) => {
        const provider = oauthProviders[req.params.provider];
        if (!provider) return sendError(res, { code: 'NOT_FOUND', message: 'Unknown OAuth provider', httpStatus: 404 });
        const state = accountManager.signOAuthState(req.params.provider);
        res.redirect(302, provider.authorizeUrl(state, redirectUriFor(req.params.provider)));
    }));

    router.get('/oauth/:provider/callback', limit, wrap(async (req, res) => {
        const name = req.params.provider;
        const provider = oauthProviders[name];
        if (!provider) return sendError(res, { code: 'NOT_FOUND', message: 'Unknown OAuth provider', httpStatus: 404 });
        const { code, state } = req.query;
        if (!code || accountManager.verifyOAuthState(state) !== name) {
            return sendError(res, { code: 'INVALID_STATE', message: 'Invalid OAuth state', httpStatus: 400 });
        }
        const { accessToken } = await provider.exchangeCode(String(code), redirectUriFor(name));
        const identity = await provider.getIdentity(accessToken);
        // Only trust the email for account linking when the provider says it's verified.
        const session = await accountManager.findOrCreateByOAuth({
            provider: name,
            providerId: identity.providerId,
            email: identity.emailVerified ? identity.email : null,
        });
        audit('ACCOUNT_CREATED', { id: session.account.id, ip: req.clientIp, via: name });

        if (successUrl) {
            const frag = new URLSearchParams({
                access_token: session.accessToken,
                refresh_token: session.refreshToken,
            }).toString();
            return res.redirect(302, `${successUrl}#${frag}`);
        }
        res.json(session);
    }));

    // ── Account-scoped API keys ────────────────────────────────
    router.post('/api-keys', limit, requireAccount, wrap(async (req, res) => {
        const { scopes, label, expiresInMs } = req.body || {};
        const issued = await accountManager.issueApiKey(req.account.accountId, { scopes, label, expiresInMs });
        res.status(201).json(issued); // includes `key` (shown once)
    }));

    router.get('/api-keys', limit, requireAccount, wrap(async (req, res) => {
        const keys = await accountManager.listApiKeys(req.account.accountId);
        res.json({ apiKeys: keys.map(({ id, label, scopes, createdAt, expiresAt }) => ({ id, label, scopes, createdAt, expiresAt })) });
    }));

    router.delete('/api-keys/:jti', limit, requireAccount, wrap(async (req, res) => {
        const ok = await accountManager.revokeApiKey(req.account.accountId, req.params.jti);
        if (!ok) return sendError(res, { code: 'NOT_FOUND', message: 'API key not found', httpStatus: 404 });
        res.json({ revoked: true, id: req.params.jti });
    }));

    return router;
}

function sendError(res, err) {
    if (res.headersSent) return;
    const status = typeof err.httpStatus === 'number' ? err.httpStatus : 500;
    const code = typeof err.code === 'string' ? err.code : 'INTERNAL';
    const message = status === 500 ? 'Internal server error' : (err.message || 'Error');
    if (status === 500) console.error('[auth] unhandled error:', err?.message);
    res.status(status).json({ error: { code, message } });
}
