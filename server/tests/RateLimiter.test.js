import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/RateLimiter.js';

describe('RateLimiter', () => {
    let limiter;

    beforeEach(() => {
        limiter = new RateLimiter({
            maxConnectionsPerMin: 3,
            maxSessionsPerHour: 2,
            maxMessagesPerSec: 5,
        });
    });

    describe('allowConnection', () => {
        it('allows connections within limit', async () => {
            assert.equal(await limiter.allowConnection('1.1.1.1'), true);
            assert.equal(await limiter.allowConnection('1.1.1.1'), true);
            assert.equal(await limiter.allowConnection('1.1.1.1'), true);
        });

        it('blocks connections over limit', async () => {
            await limiter.allowConnection('2.2.2.2');
            await limiter.allowConnection('2.2.2.2');
            await limiter.allowConnection('2.2.2.2');
            assert.equal(await limiter.allowConnection('2.2.2.2'), false);
        });

        it('different IPs have independent limits', async () => {
            await limiter.allowConnection('3.3.3.3');
            await limiter.allowConnection('3.3.3.3');
            await limiter.allowConnection('3.3.3.3');
            assert.equal(await limiter.allowConnection('4.4.4.4'), true);
        });
    });

    describe('allowSessionCreation', () => {
        it('allows session creation within limit', async () => {
            assert.equal(await limiter.allowSessionCreation('5.5.5.5'), true);
            assert.equal(await limiter.allowSessionCreation('5.5.5.5'), true);
        });

        it('blocks session creation over limit', async () => {
            await limiter.allowSessionCreation('6.6.6.6');
            await limiter.allowSessionCreation('6.6.6.6');
            assert.equal(await limiter.allowSessionCreation('6.6.6.6'), false);
        });
    });

    describe('allowMessage', () => {
        it('allows messages within limit', async () => {
            for (let i = 0; i < 5; i++) {
                assert.equal(await limiter.allowMessage('7.7.7.7'), true);
            }
        });

        it('blocks messages over limit', async () => {
            for (let i = 0; i < 5; i++) {
                await limiter.allowMessage('8.8.8.8');
            }
            assert.equal(await limiter.allowMessage('8.8.8.8'), false);
        });
    });
});
