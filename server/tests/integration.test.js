/**
 * Integration test — verifies the full signaling server session flow:
 * 1. HTTP health check
 * 2. WebSocket connection
 * 3. Session creation (gets pairing code)
 * 4. Second peer joins via pairing code
 * 5. Offer/answer/ICE relay between peers
 * 6. Session cleanup on disconnect
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';

const SERVER_URL = 'http://127.0.0.1:10000';
const WS_URL = 'ws://127.0.0.1:10000';

function httpGet(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data) }));
        }).on('error', reject);
    });
}

function connectWs() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(WS_URL);
        ws.on('open', () => resolve(ws));
        ws.on('error', reject);
    });
}

function waitForMessage(ws, type, timeout = 3000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${type}"`)), timeout);
        const handler = (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.type === type) {
                clearTimeout(timer);
                ws.removeListener('message', handler);
                resolve(msg);
            }
        };
        ws.on('message', handler);
    });
}

function send(ws, msg) {
    ws.send(JSON.stringify(msg));
}

describe('Signaling Server Integration', () => {
    let sender;
    let receiver;

    after(() => {
        if (sender && sender.readyState === WebSocket.OPEN) sender.close();
        if (receiver && receiver.readyState === WebSocket.OPEN) receiver.close();
    });

    it('health endpoint returns ok', async () => {
        const res = await httpGet(`${SERVER_URL}/health`);
        assert.equal(res.status, 200);
        assert.equal(res.data.status, 'ok');
    });

    it('stats endpoint returns session count', async () => {
        const res = await httpGet(`${SERVER_URL}/stats`);
        assert.equal(res.status, 200);
        assert.ok('activeSessions' in res.data);
    });

    it('full session flow: create → join → offer → answer → ICE relay', async () => {
        // 1. Sender connects
        sender = await connectWs();
        assert.ok(sender, 'Sender WebSocket connected');

        // 2. Sender creates session
        send(sender, { type: 'create-session' });
        const created = await waitForMessage(sender, 'session-created');
        assert.ok(created.sessionId, 'Got sessionId');
        assert.ok(created.pairingCode, 'Got pairingCode');
        assert.match(created.pairingCode, /^\d{6}$/, 'Pairing code is 6 digits');
        console.log(`  Session created: ${created.sessionId}, code: ${created.pairingCode}`);

        // 3. Receiver connects and joins
        receiver = await connectWs();
        send(receiver, { type: 'join-session', pairingCode: created.pairingCode });

        // Both sides should get notifications
        const [joinedSender, joinedReceiver] = await Promise.all([
            waitForMessage(sender, 'peer-joined'),
            waitForMessage(receiver, 'session-created'),
        ]);
        assert.ok(joinedSender, 'Sender notified of peer joining');
        assert.ok(joinedReceiver.sessionId, 'Receiver got session info');
        console.log('  Peer joined successfully');

        // 4. Sender sends offer → relayed to receiver
        const mockOffer = { type: 'offer', sdp: 'mock-sdp-offer-data' };
        send(sender, { type: 'offer', payload: mockOffer });
        const relayedOffer = await waitForMessage(receiver, 'offer');
        assert.deepEqual(relayedOffer.payload, mockOffer, 'Offer relayed correctly');
        console.log('  Offer relayed ✓');

        // 5. Receiver sends answer → relayed to sender
        const mockAnswer = { type: 'answer', sdp: 'mock-sdp-answer-data' };
        send(receiver, { type: 'answer', payload: mockAnswer });
        const relayedAnswer = await waitForMessage(sender, 'answer');
        assert.deepEqual(relayedAnswer.payload, mockAnswer, 'Answer relayed correctly');
        console.log('  Answer relayed ✓');

        // 6. ICE candidates relayed both ways
        const mockIce1 = { candidate: 'candidate1', sdpMid: '0', sdpMLineIndex: 0 };
        send(sender, { type: 'ice-candidate', payload: mockIce1 });
        const relayedIce1 = await waitForMessage(receiver, 'ice-candidate');
        assert.deepEqual(relayedIce1.payload, mockIce1, 'ICE relayed sender→receiver');
        console.log('  ICE (sender→receiver) relayed ✓');

        const mockIce2 = { candidate: 'candidate2', sdpMid: '0', sdpMLineIndex: 0 };
        send(receiver, { type: 'ice-candidate', payload: mockIce2 });
        const relayedIce2 = await waitForMessage(sender, 'ice-candidate');
        assert.deepEqual(relayedIce2.payload, mockIce2, 'ICE relayed receiver→sender');
        console.log('  ICE (receiver→sender) relayed ✓');
    });

    it('session closes when peer disconnects', async () => {
        // Receiver closes
        receiver.close();

        // Sender should be notified
        const closed = await waitForMessage(sender, 'session-closed');
        assert.ok(closed, 'Sender notified of session close');
        console.log('  Session cleanup on disconnect ✓');
    });

    it('rejects invalid pairing code', async () => {
        const ws = await connectWs();
        send(ws, { type: 'join-session', pairingCode: '000000' });
        const err = await waitForMessage(ws, 'session-error');
        assert.ok(err.error, 'Got error response');
        ws.close();
        console.log('  Invalid code rejected ✓');
    });
});
