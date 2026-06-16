/**
 * Integration test — verifies the full signaling server session flow:
 * 1. Server bootstrap health check (tests the async startup fix)
 * 2. HTTP health check
 * 3. WebSocket connection
 * 4. Session creation (gets pairing code + HMAC token)
 * 5. Second peer joins via pairing code (gets their own token)
 * 6. Offer/answer/ICE relay with token enforcement
 * 7. Token rejection test (unauthorized message)
 * 8. Session cleanup on disconnect
 *
 * The token enforcement tests (6 + 7) directly verify that the P0 security fix
 * (server.js: enforce TokenManager.verify() on privileged messages) is working.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';

const SERVER_URL = `http://127.0.0.1:${process.env.PORT || 10000}`;
const WS_URL = `ws://127.0.0.1:${process.env.PORT || 10000}`;

// ── Helpers ────────────────────────────────────────────────────

function httpGet(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch {
                    resolve({ status: res.statusCode, data });
                }
            });
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

function waitForMessage(ws, type, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`Timeout waiting for "${type}" (${timeout}ms)`)),
            timeout
        );
        const handler = (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                if (msg.type === type) {
                    clearTimeout(timer);
                    ws.removeListener('message', handler);
                    resolve(msg);
                }
            } catch { /* ignore non-JSON */ }
        };
        ws.on('message', handler);
    });
}

function send(ws, msg) {
    ws.send(JSON.stringify(msg));
}

// ── Tests ──────────────────────────────────────────────────────

describe('Signaling Server Integration', () => {
    let sender;
    let receiver;
    let senderToken;
    let receiverToken;
    let sessionId;
    let pairingCode;

    after(() => {
        if (sender && sender.readyState === WebSocket.OPEN) sender.close();
        if (receiver && receiver.readyState === WebSocket.OPEN) receiver.close();
    });

    // ── Boot / Health ──────────────────────────────────────────

    it('server bootstraps and /health responds within 3 seconds', async () => {
        // This test directly catches the fatal P0 bug:
        // if createSessionManager() was not awaited, sessionManager would be a
        // Promise object and /health would throw calling .getStats() on it,
        // returning a 503 or crashing.
        const start = Date.now();
        let res;
        let attempts = 0;
        while (Date.now() - start < 3000) {
            try {
                res = await httpGet(`${SERVER_URL}/health`);
                if (res.status === 200) break;
            } catch {
                // Server may not be ready yet — retry
            }
            await new Promise((r) => setTimeout(r, 100));
            attempts++;
        }
        assert.ok(res, 'Server must respond within 3 seconds');
        assert.equal(res.status, 200, `/health returned status ${res.status} after ${attempts} attempts`);
        assert.equal(res.data.status, 'ok', '/health body.status must be "ok"');
    });

    it('stats endpoint returns session count', async () => {
        const res = await httpGet(`${SERVER_URL}/stats`);
        assert.equal(res.status, 200);
        assert.ok('activeSessions' in res.data, 'stats must include activeSessions');
    });

    it('metrics endpoint returns Prometheus text', async () => {
        const res = await httpGet(`${SERVER_URL}/metrics`);
        assert.equal(res.status, 200);
        assert.ok(
            typeof res.data === 'string' && res.data.includes('linkspan_'),
            'metrics must include linkspan_ metrics'
        );
    });

    // ── Session Lifecycle ──────────────────────────────────────

    it('full session flow: create → join → offer+token → answer+token → ICE', async () => {
        // 1. Sender connects
        sender = await connectWs();
        assert.ok(sender, 'Sender WebSocket connected');

        // 2. Sender creates session → receives token
        send(sender, { type: 'create-session' });
        const created = await waitForMessage(sender, 'session-created');
        assert.ok(created.sessionId, 'Got sessionId');
        assert.ok(created.pairingCode, 'Got pairingCode');
        assert.match(created.pairingCode, /^\d{6}$/, 'Pairing code is 6 digits');
        assert.ok(created.token, 'Session creation must return an HMAC token');

        senderToken = created.token;
        sessionId = created.sessionId;
        pairingCode = created.pairingCode;
        console.log(`  Session: ${sessionId}, code: ${pairingCode}`);

        // 3. Receiver connects and joins → receives their own token
        receiver = await connectWs();
        send(receiver, { type: 'join-session', pairingCode });

        const [joinedSender, joinedReceiver] = await Promise.all([
            waitForMessage(sender, 'peer-joined'),
            waitForMessage(receiver, 'session-created'),
        ]);
        assert.ok(joinedSender, 'Sender notified of peer joining');
        assert.ok(joinedReceiver.sessionId, 'Receiver got session info');
        assert.ok(joinedReceiver.token, 'Join must return an HMAC token for receiver');

        receiverToken = joinedReceiver.token;
        console.log('  Peer joined, tokens issued ✓');

        // 4. Sender sends offer WITH token → relayed to receiver
        const mockOffer = { type: 'offer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' };
        send(sender, { type: 'offer', payload: mockOffer, token: senderToken });
        const relayedOffer = await waitForMessage(receiver, 'offer');
        assert.deepEqual(relayedOffer.payload, mockOffer, 'Offer relayed correctly');
        console.log('  Offer relayed with token ✓');

        // 5. Receiver sends answer WITH token → relayed to sender
        const mockAnswer = { type: 'answer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' };
        send(receiver, { type: 'answer', payload: mockAnswer, token: receiverToken });
        const relayedAnswer = await waitForMessage(sender, 'answer');
        assert.deepEqual(relayedAnswer.payload, mockAnswer, 'Answer relayed correctly');
        console.log('  Answer relayed with token ✓');

        // 6. ICE candidates relayed both ways, each with token
        const mockIce1 = { candidate: 'candidate:1 1 UDP 2130706431 192.168.1.1 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 };
        send(sender, { type: 'ice-candidate', payload: mockIce1, token: senderToken });
        const relayedIce1 = await waitForMessage(receiver, 'ice-candidate');
        assert.deepEqual(relayedIce1.payload, mockIce1, 'ICE relayed sender→receiver');
        console.log('  ICE sender→receiver ✓');

        const mockIce2 = { candidate: 'candidate:2 1 UDP 2130706431 192.168.1.2 54322 typ host', sdpMid: '0', sdpMLineIndex: 0 };
        send(receiver, { type: 'ice-candidate', payload: mockIce2, token: receiverToken });
        const relayedIce2 = await waitForMessage(sender, 'ice-candidate');
        assert.deepEqual(relayedIce2.payload, mockIce2, 'ICE relayed receiver→sender');
        console.log('  ICE receiver→sender ✓');
    });

    // ── Token Enforcement ──────────────────────────────────────

    it('rejects OFFER without a token', async () => {
        // Open a new pair to test token rejection without disrupting the above session
        const ws1 = await connectWs();
        const ws2 = await connectWs();

        send(ws1, { type: 'create-session' });
        const c = await waitForMessage(ws1, 'session-created');

        send(ws2, { type: 'join-session', pairingCode: c.pairingCode });
        await waitForMessage(ws1, 'peer-joined');

        // Send offer WITHOUT token — should be rejected
        const mockOffer = { type: 'offer', sdp: 'v=0\r\n' };
        send(ws1, { type: 'offer', payload: mockOffer }); // no token field

        const err = await waitForMessage(ws1, 'session-error', 3000);
        assert.ok(err.error, 'Missing token must produce an error');
        console.log('  Tokenless OFFER rejected ✓');

        ws1.close();
        ws2.close();
    });

    it('rejects OFFER with a forged/invalid token', async () => {
        const ws1 = await connectWs();
        const ws2 = await connectWs();

        send(ws1, { type: 'create-session' });
        const c = await waitForMessage(ws1, 'session-created');

        send(ws2, { type: 'join-session', pairingCode: c.pairingCode });
        await waitForMessage(ws1, 'peer-joined');

        // Send offer with a random forged token
        const fakeToken = 'dGhpcyBpcyBub3QgYSB2YWxpZCB0b2tlbg==.deadbeefcafe';
        const mockOffer = { type: 'offer', sdp: 'v=0\r\n' };
        send(ws1, { type: 'offer', payload: mockOffer, token: fakeToken });

        const err = await waitForMessage(ws1, 'session-error', 3000);
        assert.ok(err.error, 'Forged token must be rejected');
        console.log('  Forged token OFFER rejected ✓');

        ws1.close();
        ws2.close();
    });

    // ── Cleanup ────────────────────────────────────────────────

    it('session closes when peer disconnects', async () => {
        if (!receiver || receiver.readyState !== WebSocket.OPEN) {
            console.log('  Skipped: receiver already disconnected');
            return;
        }
        receiver.close();
        const closed = await waitForMessage(sender, 'session-closed');
        assert.ok(closed, 'Sender notified of session close');
        console.log('  Session cleanup on disconnect ✓');
    });

    it('rejects invalid pairing code', async () => {
        const ws = await connectWs();
        send(ws, { type: 'join-session', pairingCode: '000000' });
        const err = await waitForMessage(ws, 'session-error');
        assert.ok(err.error, 'Got error response for invalid code');
        ws.close();
        console.log('  Invalid pairing code rejected ✓');
    });
});
