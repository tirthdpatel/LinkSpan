import { describe, test, expect } from 'vitest';
import { Sender } from '../transfer/Sender.js';

// Regression: on a lossy link the receiver NACKs chunks it missed, and the
// sender re-sends them. Progress must count *unique* chunks delivered, not raw
// send operations — otherwise sentChunks climbs past totalChunks and the UI
// shows >100% with a negative ETA (observed: 21,048 / 19,751 → 106.6%).

/** A no-op channel endpoint: reports one open channel, swallows every send. */
function makeSink() {
    return {
        onMessage() {},
        onFirstMessage() {},
        offFirstMessage() {},
        async send() {},
        async sendAny() { return 0; },
        getChannelStats() { return [{ index: 0, state: 'open', bufferedAmount: 0, throughput: 0 }]; },
        resetStats() {},
        closeAll() {},
    };
}

describe('Sender progress under retransmits', () => {
    test('re-sending an already-delivered chunk does not inflate sentChunks', async () => {
        const file = new File([new Uint8Array(600 * 1024)], 'f.bin');

        const progress = [];
        const sender = new Sender(
            file, makeSink(),
            (sent, total) => progress.push({ sent, total }),
        );
        const { totalChunks } = sender.getFileMeta();
        expect(totalChunks).toBeGreaterThan(1);

        sender.start();

        // Deliver every chunk once, then request each a second time as a NACK
        // retransmit — exactly what a lossy connection triggers.
        for (let i = 0; i < totalChunks; i++) await sender._handleChunkRequest(i);
        for (let i = 0; i < totalChunks; i++) await sender._handleChunkRequest(i, true);

        expect(sender._sentChunks).toBe(totalChunks);
        // No progress report ever exceeded 100%.
        for (const { sent, total } of progress) expect(sent).toBeLessThanOrEqual(total);
    });
});
