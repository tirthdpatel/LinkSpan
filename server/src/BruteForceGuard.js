/**
 * BruteForceGuard — Progressive lockout for pairing code brute-force attacks.
 *
 * After N failed join attempts from an IP:
 *   - 10 fails  → 5 minute lockout
 *   - 20 fails  → 30 minute lockout
 *   - 30+ fails → 24 hour lockout
 *
 * Lockout state is in-memory (evicted after 24h to prevent unbounded growth).
 * For multi-instance deployments, use RedisSessionManager (Milestone 5)
 * which supports Redis-backed BruteForce tracking.
 */
export class BruteForceGuard {
    constructor() {
        /** @type {Map<string, { attempts: number, lockedUntil: number, firstAttempt: number }>} */
        this._records = new Map();

        // Evict stale records every 30 minutes
        this._cleanupInterval = setInterval(() => this._evictStale(), 30 * 60 * 1000);
    }

    /**
     * Check if an IP is currently locked out.
     * @param {string} ip
     * @returns {boolean}
     */
    isLocked(ip) {
        const record = this._records.get(ip);
        if (!record) return false;
        if (record.lockedUntil === 0) return false;
        if (Date.now() < record.lockedUntil) return true;

        // Lockout expired — reset
        record.lockedUntil = 0;
        return false;
    }

    /**
     * Record a failed join attempt and apply lockout if threshold reached.
     * @param {string} ip
     * @returns {{ attempts: number, lockedUntil: number }}
     */
    recordFailure(ip) {
        const record = this._records.get(ip) || {
            attempts: 0,
            lockedUntil: 0,
            firstAttempt: Date.now(),
        };

        record.attempts++;
        this._records.set(ip, record);

        // Apply progressive lockout
        if (record.attempts >= 30) {
            record.lockedUntil = Date.now() + 24 * 60 * 60 * 1000; // 24h
        } else if (record.attempts >= 20) {
            record.lockedUntil = Date.now() + 30 * 60 * 1000; // 30 min
        } else if (record.attempts >= 10) {
            record.lockedUntil = Date.now() + 5 * 60 * 1000; // 5 min
        }

        return { attempts: record.attempts, lockedUntil: record.lockedUntil };
    }

    /**
     * Reset failure count for an IP on successful join.
     * @param {string} ip
     */
    recordSuccess(ip) {
        this._records.delete(ip);
    }

    /**
     * Get remaining lockout duration in milliseconds.
     * @param {string} ip
     * @returns {number} ms remaining (0 if not locked)
     */
    getLockoutRemaining(ip) {
        const record = this._records.get(ip);
        if (!record || record.lockedUntil === 0) return 0;
        return Math.max(0, record.lockedUntil - Date.now());
    }

    /**
     * Get stats for monitoring.
     */
    getStats() {
        let locked = 0;
        for (const [, record] of this._records) {
            if (record.lockedUntil > Date.now()) locked++;
        }
        return { trackedIPs: this._records.size, lockedIPs: locked };
    }

    /**
     * Shutdown — clear the eviction interval.
     */
    shutdown() {
        clearInterval(this._cleanupInterval);
    }

    /**
     * Evict records older than 24 hours that are no longer locked.
     */
    _evictStale() {
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        for (const [ip, record] of this._records) {
            if (record.firstAttempt < cutoff && record.lockedUntil < Date.now()) {
                this._records.delete(ip);
            }
        }
    }
}
