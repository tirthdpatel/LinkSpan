/**
 * HttpRateLimiter — per-IP rate limiting for the REST API surface (Feature 17).
 *
 * Independent of the WebSocket RateLimiter so API abuse can't starve signaling and vice
 * versa. Redis-backed when a client is supplied (limits aggregate across instances), with
 * a per-instance memory insurance limiter so a Redis blip degrades to local limiting.
 *
 * Three buckets:
 *   - api:      general API calls (API_MAX_REQUESTS_PER_MIN)
 *   - upload:   link creation / content upload (API_MAX_UPLOADS_PER_HOUR)
 *   - download: download attempts — also bounds password brute force
 *               (API_MAX_DOWNLOAD_ATTEMPTS_PER_MIN)
 */

import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';
import {
    API_MAX_REQUESTS_PER_MIN,
    API_MAX_UPLOADS_PER_HOUR,
    API_MAX_DOWNLOAD_ATTEMPTS_PER_MIN,
} from '../../../shared/constants.js';

export class HttpRateLimiter {
    constructor({ redisClient = null } = {}) {
        const make = ({ points, duration, keyPrefix }) =>
            redisClient
                ? new RateLimiterRedis({
                    storeClient: redisClient, points, duration, keyPrefix,
                    insuranceLimiter: new RateLimiterMemory({ points, duration }),
                })
                : new RateLimiterMemory({ points, duration, keyPrefix });

        this._api = make({ points: API_MAX_REQUESTS_PER_MIN, duration: 60, keyPrefix: 'http:api' });
        this._upload = make({ points: API_MAX_UPLOADS_PER_HOUR, duration: 3600, keyPrefix: 'http:up' });
        this._download = make({ points: API_MAX_DOWNLOAD_ATTEMPTS_PER_MIN, duration: 60, keyPrefix: 'http:dl' });
        this.backend = redisClient ? 'redis' : 'memory';
    }

    /**
     * Express middleware factory.
     * @param {'api'|'upload'|'download'} bucket
     * @param {(req:any)=>string} keyFn  Defaults to client IP.
     */
    middleware(bucket, keyFn) {
        const limiter = bucket === 'upload' ? this._upload
            : bucket === 'download' ? this._download : this._api;
        return async (req, res, next) => {
            const key = keyFn ? keyFn(req) : (req.clientIp || req.ip || '0.0.0.0');
            try {
                await limiter.consume(key);
                next();
            } catch (rej) {
                const retry = Math.ceil((rej?.msBeforeNext || 1000) / 1000);
                res.set('Retry-After', String(retry));
                res.status(429).json({
                    error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down.' },
                });
            }
        };
    }
}
