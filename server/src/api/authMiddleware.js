/**
 * createApiAuth — unified REST authentication: a request is authenticated by EITHER an API
 * key (signed or static, via ApiKeyManager) OR a logged-in account's access JWT (via
 * AccountManager). Both resolve to the same `req.principal = { ownerId, scopes }` shape so
 * the existing scope checks and owner-scoped routes (share links, webhooks) work unchanged.
 *
 * This is a drop-in replacement for `apiKeys.middleware()` that additionally understands
 * account access tokens; when no AccountManager is supplied it behaves exactly like the
 * plain API-key middleware. Account-issued API keys carry a `jti` and are checked against
 * the account's revocation list so an individual key can be revoked without rotating others.
 */
export function createApiAuth({ apiKeys, accountManager }) {
    return async (req, res, next) => {
        const header = req.headers['authorization'] || '';
        const m = /^Bearer\s+(.+)$/i.exec(header);
        const token = m ? m[1].trim() : String(req.headers['x-api-key'] || '').trim();

        if (!token) {
            if (apiKeys.allowAnonymous) { req.principal = null; return next(); }
            return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'API key required.' } });
        }

        // 1. API key (signed or static).
        const principal = apiKeys.authenticate(token);
        if (principal) {
            if (principal.jti && accountManager && await accountManager.isApiKeyRevoked(principal.jti)) {
                return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'API key revoked.' } });
            }
            req.principal = principal;
            return next();
        }

        // 2. Account access token.
        if (accountManager) {
            const acct = accountManager.verifyAccessToken(token);
            if (acct) {
                req.principal = { ownerId: acct.accountId, scopes: ['*'], account: true };
                return next();
            }
        }

        return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key.' } });
    };
}
