import { RateLimiterMemory } from 'rate-limiter-flexible';
import {
    MAX_CONNECTIONS_PER_MIN,
    MAX_SESSIONS_PER_HOUR,
    MAX_MESSAGES_PER_SEC,
} from '../../shared/constants.js';

export class RateLimiter {
    constructor(opts = {}) {
        // Connection rate limiter: max connections per minute per IP
        this.connectionLimiter = new RateLimiterMemory({
            points: opts.maxConnectionsPerMin || MAX_CONNECTIONS_PER_MIN,
            duration: 60,
            keyPrefix: 'conn',
        });

        // Session creation limiter: max sessions per hour per IP
        this.sessionLimiter = new RateLimiterMemory({
            points: opts.maxSessionsPerHour || MAX_SESSIONS_PER_HOUR,
            duration: 3600,
            keyPrefix: 'sess',
        });

        // Message rate limiter: max messages per second per IP
        this.messageLimiter = new RateLimiterMemory({
            points: opts.maxMessagesPerSec || MAX_MESSAGES_PER_SEC,
            duration: 1,
            keyPrefix: 'msg',
        });
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
}
