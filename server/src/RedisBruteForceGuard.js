/**
 * RedisBruteForceGuard — Redis-backed progressive lockout for pairing-code
 * brute-force attacks, shared across all server instances.
 *
 * Mirrors the in-memory BruteForceGuard interface (but async, since every method
 * touches Redis). Thresholds match the single-instance guard:
 *   - 10 fails  → 5 minute lockout
 *   - 20 fails  → 30 minute lockout
 *   - 30+ fails → 24 hour lockout
 *
 * Key scheme (per IP):
 *   bf:attempts:{ip} → failure counter (TTL 24h, refreshed on first failure)
 *   bf:locked:{ip}   → lockout marker; its TTL *is* the remaining lockout, so
 *                      isLocked()/getLockoutRemaining() are a single EXISTS/PTTL
 *                      and expiry is handled by Redis (no sweeper needed).
 */
const ATTEMPTS_TTL_SEC = 24 * 60 * 60;

export class RedisBruteForceGuard {
    /**
     * @param {import('redis').RedisClientType} client - a connected redis client
     */
    constructor(client) {
        this._client = client;
    }

    _attemptsKey(ip) { return `bf:attempts:${ip}`; }
    _lockedKey(ip) { return `bf:locked:${ip}`; }

    /**
     * @param {string} ip
     * @returns {Promise<boolean>}
     */
    async isLocked(ip) {
        return (await this._client.exists(this._lockedKey(ip))) === 1;
    }

    /**
     * Record a failed attempt and apply a progressive lockout if a threshold is hit.
     * @param {string} ip
     * @returns {Promise<{ attempts: number, lockedUntil: number }>}
     */
    async recordFailure(ip) {
        const attempts = await this._client.incr(this._attemptsKey(ip));
        if (attempts === 1) {
            await this._client.expire(this._attemptsKey(ip), ATTEMPTS_TTL_SEC);
        }

        let lockMs = 0;
        if (attempts >= 30) lockMs = 24 * 60 * 60 * 1000;
        else if (attempts >= 20) lockMs = 30 * 60 * 1000;
        else if (attempts >= 10) lockMs = 5 * 60 * 1000;

        let lockedUntil = 0;
        if (lockMs > 0) {
            lockedUntil = Date.now() + lockMs;
            // PX sets the marker's TTL to the lockout window; each new failure while
            // over the threshold refreshes it (matching the in-memory behaviour).
            await this._client.set(this._lockedKey(ip), String(lockedUntil), { PX: lockMs });
        }

        return { attempts, lockedUntil };
    }

    /**
     * Clear an IP's failure state on a successful join.
     * @param {string} ip
     */
    async recordSuccess(ip) {
        await this._client.del([this._attemptsKey(ip), this._lockedKey(ip)]);
    }

    /**
     * @param {string} ip
     * @returns {Promise<number>} remaining lockout in ms (0 if not locked)
     */
    async getLockoutRemaining(ip) {
        const ttl = await this._client.pTTL(this._lockedKey(ip));
        return ttl > 0 ? ttl : 0;
    }

    /**
     * Stats are not aggregated across instances (would need a key scan); report
     * zeros so /stats keys stay consistent with the in-memory guard.
     */
    getStats() {
        return { trackedIPs: 0, lockedIPs: 0 };
    }

    /**
     * Disconnect the dedicated guard client.
     */
    async shutdown() {
        try {
            await this._client.quit();
        } catch { /* noop */ }
    }
}
