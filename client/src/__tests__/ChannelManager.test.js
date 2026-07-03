import { describe, test, expect } from 'vitest';
import { ChannelManager } from '../core/ChannelManager.js';

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
