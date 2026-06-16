/**
 * OAuthProviders — Google and GitHub social login.
 *
 * Each provider exposes three steps, all pure except for the network calls (which use an
 * injectable `fetch`, so the authorization-code → identity flow is fully unit-testable
 * without a live IdP):
 *   authorizeUrl(state, redirectUri) → string         where to send the user to consent
 *   exchangeCode(code, redirectUri)  → { accessToken } trade the code for a token
 *   getIdentity(accessToken)         → { providerId, email, emailVerified }
 *
 * Configuration is per-provider via env (client id/secret); a provider is only enabled when
 * both are present. Redirect URIs are derived from the request/base URL by AuthRoutes.
 */

export class OAuthError extends Error {
    constructor(code, message, httpStatus = 400) {
        super(message);
        this.name = 'OAuthError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

function makeGoogle({ clientId, clientSecret, fetchImpl }) {
    return {
        name: 'google',
        authorizeUrl(state, redirectUri) {
            const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
            u.searchParams.set('client_id', clientId);
            u.searchParams.set('redirect_uri', redirectUri);
            u.searchParams.set('response_type', 'code');
            u.searchParams.set('scope', 'openid email profile');
            u.searchParams.set('state', state);
            return u.toString();
        },
        async exchangeCode(code, redirectUri) {
            const res = await fetchImpl('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
                body: new URLSearchParams({
                    code, client_id: clientId, client_secret: clientSecret,
                    redirect_uri: redirectUri, grant_type: 'authorization_code',
                }).toString(),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json.access_token) throw new OAuthError('OAUTH_EXCHANGE', 'Token exchange failed', 502);
            return { accessToken: json.access_token };
        },
        async getIdentity(accessToken) {
            const res = await fetchImpl('https://www.googleapis.com/oauth2/v3/userinfo', {
                headers: { authorization: `Bearer ${accessToken}` },
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json.sub) throw new OAuthError('OAUTH_PROFILE', 'Failed to fetch profile', 502);
            return { providerId: String(json.sub), email: json.email || null, emailVerified: json.email_verified === true };
        },
    };
}

function makeGithub({ clientId, clientSecret, fetchImpl }) {
    return {
        name: 'github',
        authorizeUrl(state, redirectUri) {
            const u = new URL('https://github.com/login/oauth/authorize');
            u.searchParams.set('client_id', clientId);
            u.searchParams.set('redirect_uri', redirectUri);
            u.searchParams.set('scope', 'read:user user:email');
            u.searchParams.set('state', state);
            return u.toString();
        },
        async exchangeCode(code, redirectUri) {
            const res = await fetchImpl('https://github.com/login/oauth/access_token', {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri }),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json.access_token) throw new OAuthError('OAUTH_EXCHANGE', 'Token exchange failed', 502);
            return { accessToken: json.access_token };
        },
        async getIdentity(accessToken) {
            const headers = { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json', 'user-agent': 'linkspan' };
            const userRes = await fetchImpl('https://api.github.com/user', { headers });
            const user = await userRes.json().catch(() => ({}));
            if (!userRes.ok || user.id == null) throw new OAuthError('OAUTH_PROFILE', 'Failed to fetch profile', 502);
            // The /user email may be null when private; fetch the verified primary explicitly.
            let email = user.email || null;
            let emailVerified = false;
            try {
                const emailsRes = await fetchImpl('https://api.github.com/user/emails', { headers });
                if (emailsRes.ok) {
                    const emails = await emailsRes.json();
                    const primary = Array.isArray(emails) && emails.find((e) => e.primary && e.verified);
                    if (primary) { email = primary.email; emailVerified = true; }
                }
            } catch { /* email scope may be unavailable; proceed without */ }
            return { providerId: String(user.id), email, emailVerified };
        },
    };
}

/**
 * Build the set of configured OAuth providers from the environment.
 * @returns {Record<string, object>} e.g. { google, github } — only fully-configured ones.
 */
export function createOAuthProviders(env = process.env, fetchImpl = globalThis.fetch) {
    const providers = {};
    if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
        providers.google = makeGoogle({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, fetchImpl });
    }
    if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
        providers.github = makeGithub({ clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET, fetchImpl });
    }
    return providers;
}

export const __test__ = { makeGoogle, makeGithub };
