import { describe, test, expect } from 'vitest';
import { DeepLinkRegistry } from '../core/DeepLinkRegistry.js';

/** A minimal in-memory store for injection (mirrors the localStorage shape used). */
function memStore() {
    let v = null;
    return { get: () => v, set: (x) => { v = x; } };
}

describe('DeepLinkRegistry — expiry, single-use, revocation (Feature 13)', () => {
    test('a freshly issued token is usable until it expires', () => {
        const reg = new DeepLinkRegistry(memStore());
        const now = 1000;
        reg.issue('tok-a', { expiresAt: now + 5000, now });
        expect(reg.isUsable('tok-a', now + 1)).toBe(true);
        expect(reg.isUsable('tok-a', now + 6000)).toBe(false); // expired
        expect(reg.isUsable('unknown')).toBe(false);
    });

    test('single-use token is consumed exactly once', () => {
        const reg = new DeepLinkRegistry(memStore());
        const now = 1000;
        reg.issue('tok-b', { expiresAt: now + 10_000, singleUse: true, now });
        expect(reg.consume('tok-b', now + 1)).toBe(true);
        expect(reg.consume('tok-b', now + 2)).toBe(false); // already used
        expect(reg.isUsable('tok-b', now + 2)).toBe(false);
    });

    test('a multi-use token can be consumed repeatedly until expiry', () => {
        const reg = new DeepLinkRegistry(memStore());
        const now = 0;
        reg.issue('tok-c', { expiresAt: now + 10_000, singleUse: false, now });
        expect(reg.consume('tok-c', 100)).toBe(true);
        expect(reg.consume('tok-c', 200)).toBe(true);
        expect(reg.consume('tok-c', 20_000)).toBe(false); // expired
    });

    test('revoke makes a token immediately unusable', () => {
        const reg = new DeepLinkRegistry(memStore());
        const now = 0;
        reg.issue('tok-d', { expiresAt: now + 10_000, now });
        reg.revoke('tok-d', now);
        expect(reg.isUsable('tok-d', now + 1)).toBe(false);
        expect(reg.consume('tok-d', now + 1)).toBe(false);
    });

    test('list omits expired tokens and clear empties the store', () => {
        const reg = new DeepLinkRegistry(memStore());
        reg.issue('live', { expiresAt: 10_000, now: 0 });
        reg.issue('dead', { expiresAt: 100, now: 0 });
        const live = reg.list(1000);
        expect(live.map((r) => r.token)).toContain('live');
        expect(live.map((r) => r.token)).not.toContain('dead');
        reg.clear();
        expect(reg.list(1000)).toEqual([]);
    });
});
