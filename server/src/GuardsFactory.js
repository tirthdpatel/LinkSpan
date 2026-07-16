import { createClient } from 'redis';
import { RateLimiter } from './RateLimiter.js';
import { BruteForceGuard } from './BruteForceGuard.js';
import { RedisBruteForceGuard } from './RedisBruteForceGuard.js';

/**
 * GuardsFactory — builds the rate limiter and brute-force guard.
 *
 * - If REDIS_URL is set: both are Redis-backed and share a single dedicated
 *   connection, so limits and lockouts aggregate across every server instance.
 * - Otherwise: per-instance in-memory implementations (single-node deployments).
 *
 * Mirrors SessionManagerFactory so the same server.js works in both modes via
 * environment configuration alone.
 *
 * Rate-limit thresholds may be overridden via env (handy for load/e2e testing
 * where many flows originate from a single IP):
 *   RL_MAX_CONNECTIONS_PER_MIN, RL_MAX_SESSIONS_PER_HOUR,
 *   RL_MAX_MESSAGES_PER_SEC, RL_MAX_JOIN_ATTEMPTS_PER_MIN, RL_MAX_RELAY_CHUNKS_PER_SEC
 *
 * @returns {Promise<{ rateLimiter: RateLimiter, bruteForce: object }>}
 */
function rateLimitOptsFromEnv() {
    const num = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
    const opts = {
        maxConnectionsPerMin: num(process.env.RL_MAX_CONNECTIONS_PER_MIN),
        maxSessionsPerHour: num(process.env.RL_MAX_SESSIONS_PER_HOUR),
        maxMessagesPerSec: num(process.env.RL_MAX_MESSAGES_PER_SEC),
        maxJoinAttemptsPerMin: num(process.env.RL_MAX_JOIN_ATTEMPTS_PER_MIN),
        maxRelayChunksPerSec: num(process.env.RL_MAX_RELAY_CHUNKS_PER_SEC),
    };
    // Drop undefined keys so RateLimiter falls back to its constant defaults.
    for (const k of Object.keys(opts)) if (opts[k] === undefined) delete opts[k];
    return opts;
}

export async function createGuards() {
    const envOpts = rateLimitOptsFromEnv();

    if (process.env.REDIS_URL) {
        try {
            // pingInterval: keep the connection alive through idle-reaping proxies.
            const client = createClient({ url: process.env.REDIS_URL, pingInterval: 30_000 });
            client.on('error', (err) => console.error('[Guards Redis] Error:', err.message));
            await client.connect();
            console.log('[GuardsFactory] Using Redis-backed rate limiting + brute-force');
            return {
                rateLimiter: new RateLimiter({ redisClient: client, ...envOpts }),
                bruteForce: new RedisBruteForceGuard(client),
            };
        } catch (err) {
            console.error(
                '[GuardsFactory] Redis unavailable, using per-instance guards:',
                err.message
            );
        }
    }

    console.log('[GuardsFactory] Using in-memory rate limiting + brute-force');
    return { rateLimiter: new RateLimiter(envOpts), bruteForce: new BruteForceGuard() };
}
