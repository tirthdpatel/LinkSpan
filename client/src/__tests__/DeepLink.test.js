import { describe, test, expect } from 'vitest';
import {
    buildDeepLink,
    parseDeepLink,
    mintToken,
    isExpired,
} from '../core/DeepLink.js';
import { DEEP_LINK_ACTION } from '@shared/constants.js';

const ORIGIN = 'https://linkspan.test';

describe('DeepLink — build & parse (Feature 13)', () => {
    test('builds a pairing deep link with an expiring token', () => {
        const now = 1_000_000;
        const dl = buildDeepLink({ code: '123456', origin: ORIGIN, now, ttlMs: 60_000 });
        expect(dl.token).toBeTruthy();
        expect(dl.expiresAt).toBe(now + 60_000);
        expect(dl.url).toContain('code=123456');
        expect(dl.url).toContain('exp=' + (now + 60_000));

        const parsed = parseDeepLink(dl.url, now + 1);
        expect(parsed.ok).toBe(true);
        expect(parsed.code).toBe('123456');
        expect(parsed.action).toBe(DEEP_LINK_ACTION.PAIR);
        expect(parsed.expired).toBe(false);
        expect(parsed.token).toBe(dl.token);
    });

    test('marks an expired link as expired', () => {
        const now = 5_000;
        const dl = buildDeepLink({ code: '654321', origin: ORIGIN, now, ttlMs: 1000 });
        const parsed = parseDeepLink(dl.url, now + 2000);
        expect(parsed.ok).toBe(true);
        expect(parsed.expired).toBe(true);
        expect(isExpired(parsed, now + 2000)).toBe(true);
    });

    test('a bare 6-digit code parses as a pairing action (backward compatible)', () => {
        const parsed = parseDeepLink('482913');
        expect(parsed.ok).toBe(true);
        expect(parsed.code).toBe('482913');
        expect(parsed.action).toBe(DEEP_LINK_ACTION.PAIR);
        expect(parsed.expired).toBe(false);
    });

    test('a legacy ?code= URL still parses', () => {
        const parsed = parseDeepLink(`${ORIGIN}/?code=111222`);
        expect(parsed.ok).toBe(true);
        expect(parsed.code).toBe('111222');
    });

    test('single-use flag round-trips', () => {
        const dl = buildDeepLink({ code: '777888', origin: ORIGIN, singleUse: true });
        expect(parseDeepLink(dl.url).singleUse).toBe(true);
    });

    test('rejects an invalid code and unknown action', () => {
        expect(() => buildDeepLink({ code: 'abc', origin: ORIGIN })).toThrow();
        expect(parseDeepLink(`${ORIGIN}/?code=99`).ok).toBe(false);
        expect(parseDeepLink(`${ORIGIN}/?a=bogus&code=123456`).ok).toBe(false);
        expect(parseDeepLink('not a url').ok).toBe(false);
        expect(parseDeepLink('').ok).toBe(false);
    });

    test('mintToken returns a 32-hex-char (128-bit) token', () => {
        const t = mintToken();
        expect(t).toMatch(/^[0-9a-f]{32}$/);
        expect(mintToken()).not.toBe(t);
    });
});
