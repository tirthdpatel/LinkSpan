import { SessionManager } from './SessionManager.js';

/**
 * SessionManagerFactory — Returns the appropriate SessionManager implementation.
 *
 * - If REDIS_URL is set: returns RedisSessionManager (multi-instance safe)
 * - Otherwise: returns in-memory SessionManager (single instance)
 *
 * This allows the same server.js to work both locally and in production
 * without any code changes — just environment variable configuration.
 */
export async function createSessionManager() {
    if (process.env.REDIS_URL) {
        try {
            const { RedisSessionManager } = await import('./RedisSessionManager.js');
            const manager = new RedisSessionManager(process.env.REDIS_URL);
            await manager.connect();
            console.log('[SessionManagerFactory] Using Redis session store');
            return manager;
        } catch (err) {
            console.error(
                '[SessionManagerFactory] Redis unavailable, falling back to in-memory:',
                err.message
            );
        }
    }

    console.log('[SessionManagerFactory] Using in-memory session store');
    return new SessionManager();
}
