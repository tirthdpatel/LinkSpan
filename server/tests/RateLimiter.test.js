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
            maxRelayChunksPerSec: 3,
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

    describe('allowRelayChunk', () => {
        it('allows relay chunks within their own limit', async () => {
            for (let i = 0; i < 3; i++) {
                assert.equal(await limiter.allowRelayChunk('9.9.9.9'), true);
            }
        });

        it('blocks relay chunks over their own limit', async () => {
            for (let i = 0; i < 3; i++) {
                await limiter.allowRelayChunk('10.10.10.10');
            }
            assert.equal(await limiter.allowRelayChunk('10.10.10.10'), false);
        });

        it('is independent of the message limiter budget', async () => {
            // Exhaust the (lower) message budget for this IP...
            for (let i = 0; i < 5; i++) {
                await limiter.allowMessage('11.11.11.11');
            }
            assert.equal(await limiter.allowMessage('11.11.11.11'), false);
            // ...relay chunks for the same IP still have their own budget.
            assert.equal(await limiter.allowRelayChunk('11.11.11.11'), true);
        });
    });
});
