import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';
import {
    MAX_CONNECTIONS_PER_MIN,
    MAX_SESSIONS_PER_HOUR,
    MAX_MESSAGES_PER_SEC,
    MAX_JOIN_ATTEMPTS_PER_MIN,
} from '../../shared/constants.js';

export class RateLimiter {
    /**
     * @param {object} [opts]
     * @param {import('redis').RedisClientType} [opts.redisClient] - when provided,
     *   limits are stored in Redis so they aggregate across all server instances.
     *   Each limiter keeps a per-instance memory `insuranceLimiter` so a transient
     *   Redis outage degrades to local limiting rather than failing open entirely.
     */
    constructor(opts = {}) {
        const redisClient = opts.redisClient || null;
        // Exposed so other Redis-backed limiters (e.g. the HTTP API limiter) can share
        // the same connection rather than opening a second one.
        this.redisClient = redisClient;

        const make = ({ points, duration, keyPrefix }) => {
            if (redisClient) {
                return new RateLimiterRedis({
                    storeClient: redisClient,
                    points,
                    duration,
                    keyPrefix,
                    insuranceLimiter: new RateLimiterMemory({ points, duration }),
                });
            }
            return new RateLimiterMemory({ points, duration, keyPrefix });
        };

        // Connection rate limiter: max connections per minute per IP
        this.connectionLimiter = make({
            points: opts.maxConnectionsPerMin || MAX_CONNECTIONS_PER_MIN,
            duration: 60,
            keyPrefix: 'conn',
        });

        // Session creation limiter: max sessions per hour per IP
        this.sessionLimiter = make({
            points: opts.maxSessionsPerHour || MAX_SESSIONS_PER_HOUR,
            duration: 3600,
            keyPrefix: 'sess',
        });

        // Message rate limiter: max messages per second per IP
        this.messageLimiter = make({
            points: opts.maxMessagesPerSec || MAX_MESSAGES_PER_SEC,
            duration: 1,
            keyPrefix: 'msg',
        });

        // Join attempt limiter: stricter — prevents pairing code brute-force
        this.joinLimiter = make({
            points: opts.maxJoinAttemptsPerMin || MAX_JOIN_ATTEMPTS_PER_MIN,
            duration: 60,
            keyPrefix: 'join',
        });

        this.backend = redisClient ? 'redis' : 'memory';
    }

    /**
     * Check if a new connection from this IP is allowed.
     * @param {string} ip
     * @returns {Promise<boolean>}
     */
    async allowConnection(ip) {
        try {
            await this.connectionLimiter.consume(ip);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Check if session creation from this IP is allowed.
     * @param {string} ip
     * @returns {Promise<boolean>}
     */
    async allowSessionCreation(ip) {
        try {
            await this.sessionLimiter.consume(ip);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Check if a message from this IP is allowed.
     * @param {string} ip
     * @returns {Promise<boolean>}
     */
    async allowMessage(ip) {
        try {
            await this.messageLimiter.consume(ip);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Check if a join attempt from this IP is allowed.
     * Stricter limit to prevent pairing code brute-force.
     * @param {string} ip
     * @returns {Promise<boolean>}
     */
    async allowJoinAttempt(ip) {
        try {
            await this.joinLimiter.consume(ip);
            return true;
        } catch {
            return false;
        }
    }
}
