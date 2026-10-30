import { describe, test, expect } from 'vitest';
import { ChannelManager } from '../core/ChannelManager.js';
import { Sender } from '../transfer/Sender.js';

// Tests for the channel pool — in particular addChannels(), which appends a
// secondary peer connection's channels mid-transfer without disturbing existing
// indices or the shared message handler.

function makeFakeChannel({ open = true, bufferedAmount = 0 } = {}) {
    return {
        readyState: open ? 'open' : 'connecting',
        bufferedAmount,
        sent: [],
        send(data) { this.sent.push(data); },
        close() { this.readyState = 'closed'; },
    };
}

describe('ChannelManager.addChannels', () => {
    test('appends channels without disturbing existing indices', async () => {
        const cm = new ChannelManager();
        const first = [makeFakeChannel(), makeFakeChannel()];
        cm.setChannels(first);

        const extra = [makeFakeChannel(), makeFakeChannel()];
        cm.addChannels(extra);

        expect(cm.channels).toHaveLength(4);
        expect(cm.channels[0]).toBe(first[0]);
        expect(cm.channels[2]).toBe(extra[0]);
        await cm.send(3, 'hello');
        expect(extra[1].sent).toEqual(['hello']);
    });

    test('appended channels dispatch into the already-registered message handler', () => {
        const cm = new ChannelManager();
        cm.setChannels([makeFakeChannel()]);

        const seen = [];
        cm.onMessage((data, i) => seen.push([data, i]));

        const extra = makeFakeChannel();
        cm.addChannels([extra]);
        extra.onmessage({ data: 'from-secondary' });

        expect(seen).toEqual([['from-secondary', 1]]);
    });

    test('sendAny stripes to the least-buffered open channel across the whole pool', async () => {
        const cm = new ChannelManager();
        const busy = makeFakeChannel({ bufferedAmount: 500_000 });
        cm.setChannels([busy]);

        const idle = makeFakeChannel({ bufferedAmount: 0 });
        cm.addChannels([idle]);

        const used = await cm.sendAny('chunk');
        expect(used).toBe(1);
        expect(idle.sent).toEqual(['chunk']);
        expect(busy.sent).toEqual([]);
    });

    test('not-yet-open appended channels are skipped by sendAny', async () => {
        const cm = new ChannelManager();
        const open = makeFakeChannel({ bufferedAmount: 100 });
        cm.setChannels([open]);
        cm.addChannels([makeFakeChannel({ open: false })]);

        const used = await cm.sendAny('x');
        expect(used).toBe(0);
        expect(open.sent).toEqual(['x']);
    });

    test('setChannels resets the pool completely', () => {
        const cm = new ChannelManager();
        cm.setChannels([makeFakeChannel(), makeFakeChannel()]);
        cm.addChannels([makeFakeChannel()]);
        cm.setChannels([makeFakeChannel()]);
        expect(cm.channels).toHaveLength(1);
        expect(cm.ready).toHaveLength(1);
        expect(cm.stats).toHaveLength(1);
    });
});

describe('ChannelManager throughput stats', () => {
    test('counts bytes sent, not only bytes received', async () => {
        const cm = new ChannelManager();
        cm.setChannels([makeFakeChannel(), makeFakeChannel()]);

        await cm.send(1, new ArrayBuffer(1000));
        await cm.send(1, 'abcd');

        expect(cm.stats[0].bytes).toBe(0);
        expect(cm.stats[1].bytes).toBe(1004);
    });
});

describe('ChannelManager connections and wire throughput', () => {
    test('each setChannels/addChannels call is one connection', () => {
        const cm = new ChannelManager();
        cm.setChannels([makeFakeChannel(), makeFakeChannel()]);
        cm.addChannels([makeFakeChannel()]);
        cm.addChannels([makeFakeChannel(), makeFakeChannel()]);
        expect(cm.getChannelStats().map((s) => s.connection)).toEqual([0, 0, 1, 2, 2]);
    });

    test('throughput counts bytes that left, not bytes still queued', async () => {
        const cm = new ChannelManager();
        const ch = makeFakeChannel();
        cm.setChannels([ch]);
        cm.stats[0].timestamp = Date.now() - 1000; // one second of sampling

        await cm.send(0, new ArrayBuffer(1000));
        ch.bufferedAmount = 600; // 600 of the 1000 bytes are still queued
        expect(cm.getChannelStats()[0].throughput).toBeCloseTo(400, -1);

        // After a reset the still-queued bytes draining out count as throughput.
        cm.resetStats();
        cm.stats[0].timestamp = Date.now() - 1000;
        ch.bufferedAmount = 0;
        expect(cm.getChannelStats()[0].throughput).toBeCloseTo(600, -1);
    });
});

describe('Sender channel picking', () => {
    test('balances by connection: a backed-up 7-channel connection loses to a lighter one', () => {
        const stats = [];
        // Primary: 7 channels × 300 KB queued = 2.1 MB on one congestion window.
        for (let i = 0; i < 7; i++) stats.push({ index: i, connection: 0, state: 'open', bufferedAmount: 300_000 });
        // Secondary: 2 channels × 400 KB = 0.8 MB — each channel fuller, connection lighter.
        stats.push({ index: 7, connection: 1, state: 'open', bufferedAmount: 400_000 });
        stats.push({ index: 8, connection: 1, state: 'open', bufferedAmount: 350_000 });
        stats.push({ index: 9, connection: 2, state: 'closed', bufferedAmount: 0 });

        const sender = new Sender(new File([new Uint8Array(10)], 'x'), { getChannelStats: () => stats }, () => {});
        expect(sender._pickBestChannel()).toBe(8);
    });
});
