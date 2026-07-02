import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
    resolveIceServers,
    getCachedIceServers,
    _resetIceServerCache,
} from '../core/IceServers.js';

const CF_SERVER = {
    urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
    username: 'ephemeral-user',
    credential: 'ephemeral-cred',
};

const okResponse = (body) => ({ ok: true, json: async () => body });

describe('IceServers', () => {
    beforeEach(() => _resetIceServerCache());

    test('merges server-minted TURN credentials after the STUN defaults', async () => {
        const fetchImpl = vi.fn(async () => okResponse({ iceServers: [CF_SERVER], ttl: 7200 }));
        const servers = await resolveIceServers({ fetchImpl });

        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(fetchImpl.mock.calls[0][0]).toMatch(/\/api\/v1\/turn-credentials$/);
        // STUN defaults first, then the ephemeral TURN entry
        expect(servers[0].urls).toMatch(/^stun:/);
        expect(servers).toContainEqual(CF_SERVER);
    });

    test('caches the resolved list and serves the sync getter from it', async () => {
        const fetchImpl = vi.fn(async () => okResponse({ iceServers: [CF_SERVER], ttl: 7200 }));
        const first = await resolveIceServers({ fetchImpl });
        const second = await resolveIceServers({ fetchImpl });

        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(second).toBe(first);
        expect(getCachedIceServers()).toBe(first);
    });

    test('empty iceServers (TURN not configured server-side) falls back to STUN-only', async () => {
        const fetchImpl = vi.fn(async () => okResponse({ iceServers: [], ttl: 0 }));
        const servers = await resolveIceServers({ fetchImpl });

        expect(servers.every((s) => String(s.urls).startsWith('stun:'))).toBe(true);
        // Fallback is not cached as "ephemeral" — a later call re-asks the server.
        await resolveIceServers({ fetchImpl });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    test('fetch failure never throws — returns the static fallback', async () => {
        const fetchImpl = vi.fn(async () => { throw new Error('network down'); });
        const servers = await resolveIceServers({ fetchImpl });
        expect(servers.length).toBeGreaterThan(0);
        expect(servers.every((s) => String(s.urls).startsWith('stun:'))).toBe(true);
    });

    test('non-2xx response falls back to the static list', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: false, status: 404 }));
        const servers = await resolveIceServers({ fetchImpl });
        expect(servers.every((s) => String(s.urls).startsWith('stun:'))).toBe(true);
    });

    test('getCachedIceServers without a warm cache returns the static fallback', () => {
        const servers = getCachedIceServers();
        expect(servers.length).toBeGreaterThanOrEqual(2);
        expect(servers[0].urls).toMatch(/^stun:/);
    });

    test('concurrent resolves share one fetch', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const fetchImpl = vi.fn(async () => {
            await gate;
            return okResponse({ iceServers: [CF_SERVER], ttl: 7200 });
        });
        const both = Promise.all([
            resolveIceServers({ fetchImpl }),
            resolveIceServers({ fetchImpl }),
        ]);
        release();
        const [a, b] = await both;
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(a).toBe(b);
    });
});
