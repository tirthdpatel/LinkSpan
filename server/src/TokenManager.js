import crypto from 'node:crypto';

const TOKEN_SECRET = process.env.TOKEN_SECRET || crypto.randomBytes(32).toString('hex');

/**
 * TokenManager — Issues and verifies HMAC-SHA256 signed session tokens.
 *
 * Token structure: base64url({ sessionId, peerId, role, iat, exp }) + "." + HMAC
 *
 * Tokens are issued per-join and validated before any SDP/ICE relay,
 * preventing spoofed relay attacks where an unauthorized peer injects
 * offer/answer/ICE messages into a session they don't belong to.
 */
export class TokenManager {
    constructor(secret = TOKEN_SECRET, ttlMs = 15 * 60 * 1000) {
        this._secret = secret;
        this._ttlMs = ttlMs;
    }

    /**
     * Sign a session token.
     * @param {{ sessionId: string, peerId: string, role: string }} payload
     * @returns {string} signed token
     */
    sign(payload) {
        const now = Date.now();
        const claims = {
            // A token binds a peer to either a 2-peer session OR an N-peer room.
            ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
            ...(payload.roomId ? { roomId: payload.roomId } : {}),
            peerId: payload.peerId,
            role: payload.role || 'unknown',
            iat: now,
            exp: now + this._ttlMs,
        };

        const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
        const signature = this._hmac(encoded);
        return `${encoded}.${signature}`;
    }

    /**
     * Verify a token. Returns the decoded payload or null if invalid/expired.
     * @param {string} token
     * @returns {{ sessionId: string, peerId: string, role: string, iat: number, exp: number } | null}
     */
    verify(token) {
        if (!token || typeof token !== 'string') return null;

        const parts = token.split('.');
        if (parts.length !== 2) return null;

        const [encoded, signature] = parts;

        // Timing-safe comparison
        const expectedSig = this._hmac(encoded);
        const expected = Buffer.from(expectedSig);
        const provided = Buffer.from(signature);

        if (expected.length !== provided.length) return null;
        if (!crypto.timingSafeEqual(expected, provided)) return null;

        let claims;
        try {
            claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        } catch {
            return null;
        }

        // Check expiry
        if (!claims.exp || Date.now() > claims.exp) return null;

        // Validate required fields: a peer id, and exactly one scope (session or room).
        if (!claims.peerId || (!claims.sessionId && !claims.roomId)) return null;

        return claims;
    }

    /**
     * Compute HMAC-SHA256 of a string.
     * @param {string} data
     * @returns {string} hex digest
     */
    _hmac(data) {
        return crypto
            .createHmac('sha256', this._secret)
            .update(data)
            .digest('hex');
    }
}
