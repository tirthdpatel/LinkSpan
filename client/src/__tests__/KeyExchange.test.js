import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { performKeyExchange } from '../hooks/useConnection.js';

// Regression tests for the cross-continent relay handshake failure:
// on an uncoordinated relay fallback the two peers join the channel tens of
// seconds apart, and every frame sent before the late peer attaches is silently
// dropped. The handshake must retransmit (and echo on receive) so the exchange
// settles once both ends are finally listening.

/**
 * In-memory channel endpoint pair with realistic loss semantics: a frame
 * delivered while the peer has no onMessage handler is DROPPED (exactly what
 * happens to relay chunks before RelayChannel._startListening runs).
 */
function makeLossyPair() {
    const make = () => ({
        _onMessage: null,
        peer: null,
        onMessage(h) { this._onMessage = h; },
        async sendAny(data) {
            const peer = this.peer;
            queueMicrotask(() => { peer._onMessage?.(data); });
            return 0;
        },
    });
    const a = make();
    const b = make();
    a.peer = b;
    b.peer = a;
    return [a, b];
}

describe('performKeyExchange', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    test('settles immediately when both peers are listening', async () => {
        const [a, b] = makeLossyPair();
        const [resA, resB] = await Promise.all([
            performKeyExchange(a),
            performKeyExchange(b),
            vi.advanceTimersByTimeAsync(100),
        ]).then((r) => r.slice(0, 2));

        expect(resA.sas).toBe(resB.sas);
        expect(resA.sas).toMatch(/^\d{3} \d{3}$/);
        expect(resA.key).toBeTruthy();
    });

    test('bridges a late-joining peer via retransmission (cross-continent relay skew)', async () => {
        const [a, b] = makeLossyPair();

        // Peer A starts alone — its initial send and first retransmits are all
        // dropped because B has no handler yet (still waiting for its own ICE
        // to fail before switching onto the relay).
        const promiseA = performKeyExchange(a);
        promiseA.catch(() => {}); // avoid unhandled-rejection noise if it fails
        await vi.advanceTimersByTimeAsync(9_000);

        // B finally joins the relay 9s later.
        const promiseB = performKeyExchange(b);
        await vi.advanceTimersByTimeAsync(5_000);

        const [resA, resB] = await Promise.all([promiseA, promiseB]);
        expect(resA.sas).toBe(resB.sas);
    });

    test('times out when the peer never appears', async () => {
        const [a] = makeLossyPair();
        const promise = performKeyExchange(a);
        const outcome = promise.then(() => 'resolved', (e) => e.message);
        await vi.advanceTimersByTimeAsync(46_000);
        expect(await outcome).toBe('Key exchange timed out');
    });
});
