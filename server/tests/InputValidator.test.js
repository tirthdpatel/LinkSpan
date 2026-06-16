/**
 * InputValidator.test.js — Unit tests for centralized message validation.
 *
 * Covers:
 *   - All valid message types pass
 *   - All invalid shapes are rejected
 *   - Filename sanitization (path traversal, null bytes)
 *   - Oversized payload rejection
 *   - Unknown fields in strict mode
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { InputValidator } from '../src/InputValidator.js';

// ── CREATE_SESSION ─────────────────────────────────────────────────────────

describe('InputValidator — CREATE_SESSION', () => {
    test('accepts minimal valid message', () => {
        const r = InputValidator.validate({ type: 'create-session' });
        assert.equal(r.valid, true);
    });

    test('rejects extra unknown fields', () => {
        const r = InputValidator.validate({ type: 'create-session', evil: 'xss' });
        assert.equal(r.valid, false);
    });
});

// ── JOIN_SESSION ───────────────────────────────────────────────────────────

describe('InputValidator — JOIN_SESSION', () => {
    test('accepts valid 6-digit pairing code', () => {
        const r = InputValidator.validate({ type: 'join-session', pairingCode: '123456' });
        assert.equal(r.valid, true);
    });

    test('rejects 5-digit code', () => {
        const r = InputValidator.validate({ type: 'join-session', pairingCode: '12345' });
        assert.equal(r.valid, false);
    });

    test('rejects 7-digit code', () => {
        const r = InputValidator.validate({ type: 'join-session', pairingCode: '1234567' });
        assert.equal(r.valid, false);
    });

    test('rejects alpha characters', () => {
        const r = InputValidator.validate({ type: 'join-session', pairingCode: 'abc123' });
        assert.equal(r.valid, false);
    });

    test('rejects missing pairing code', () => {
        const r = InputValidator.validate({ type: 'join-session' });
        assert.equal(r.valid, false);
    });

    test('rejects null pairing code', () => {
        const r = InputValidator.validate({ type: 'join-session', pairingCode: null });
        assert.equal(r.valid, false);
    });
});

// ── OFFER / ANSWER ─────────────────────────────────────────────────────────

describe('InputValidator — OFFER', () => {
    const validOffer = {
        type: 'offer',
        payload: { type: 'offer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n' },
    };

    test('accepts valid offer', () => {
        const r = InputValidator.validate(validOffer);
        assert.equal(r.valid, true);
    });

    test('rejects offer with wrong payload type', () => {
        const r = InputValidator.validate({
            type: 'offer',
            payload: { type: 'answer', sdp: 'v=0\r\n' },
        });
        assert.equal(r.valid, false);
    });

    test('rejects offer with non-string sdp', () => {
        const r = InputValidator.validate({
            type: 'offer',
            payload: { type: 'offer', sdp: 12345 },
        });
        assert.equal(r.valid, false);
    });

    test('rejects offer with oversized sdp (>32KB)', () => {
        const r = InputValidator.validate({
            type: 'offer',
            payload: { type: 'offer', sdp: 'a'.repeat(33 * 1024) },
        });
        assert.equal(r.valid, false);
    });

    test('rejects offer with missing payload', () => {
        const r = InputValidator.validate({ type: 'offer' });
        assert.equal(r.valid, false);
    });
});

describe('InputValidator — ANSWER', () => {
    test('accepts valid answer', () => {
        const r = InputValidator.validate({
            type: 'answer',
            payload: { type: 'answer', sdp: 'v=0\r\n' },
        });
        assert.equal(r.valid, true);
    });

    test('rejects answer with offer type in payload', () => {
        const r = InputValidator.validate({
            type: 'answer',
            payload: { type: 'offer', sdp: 'v=0\r\n' },
        });
        assert.equal(r.valid, false);
    });
});

// ── ICE_CANDIDATE ─────────────────────────────────────────────────────────

describe('InputValidator — ICE_CANDIDATE', () => {
    test('accepts valid ICE candidate', () => {
        const r = InputValidator.validate({
            type: 'ice-candidate',
            payload: {
                candidate: 'candidate:1 1 udp 2122260223 192.168.0.1 54321 typ host',
                sdpMid: '0',
                sdpMLineIndex: 0,
            },
        });
        assert.equal(r.valid, true);
    });

    test('accepts null candidate (end-of-candidates)', () => {
        const r = InputValidator.validate({
            type: 'ice-candidate',
            payload: { candidate: null },
        });
        assert.equal(r.valid, true);
    });

    test('rejects candidate longer than 2048 chars', () => {
        const r = InputValidator.validate({
            type: 'ice-candidate',
            payload: { candidate: 'x'.repeat(2049) },
        });
        assert.equal(r.valid, false);
    });

    test('rejects missing payload', () => {
        const r = InputValidator.validate({ type: 'ice-candidate' });
        assert.equal(r.valid, false);
    });
});

// ── FILE_META ─────────────────────────────────────────────────────────────

describe('InputValidator — FILE_META (filename sanitization)', () => {
    test('accepts normal filename', () => {
        const r = InputValidator.validate({
            type: 'file-meta',
            payload: { fileName: 'document.pdf', fileSize: 1024 * 1024, totalChunks: 4, chunkSize: 262144 },
        });
        assert.equal(r.valid, true);
    });

    test('rejects path traversal: ../etc/passwd', () => {
        const r = InputValidator.validate({
            type: 'file-meta',
            payload: { fileName: '../etc/passwd', fileSize: 100, totalChunks: 1, chunkSize: 131072 },
        });
        assert.equal(r.valid, false);
    });

    test('rejects absolute path /etc/passwd', () => {
        const r = InputValidator.validate({
            type: 'file-meta',
            payload: { fileName: '/etc/passwd', fileSize: 100, totalChunks: 1, chunkSize: 131072 },
        });
        assert.equal(r.valid, false);
    });

    test('sanitizes null byte in filename (strips, does not reject)', () => {
        // Null bytes are stripped from filenames rather than outright rejected.
        // The resulting sanitized name is still valid.
        const r = InputValidator.validate({
            type: 'file-meta',
            payload: { fileName: 'file\x00.txt', fileSize: 100, totalChunks: 1, chunkSize: 131072 },
        });
        // After stripping null byte: 'file.txt' — valid, so valid: true
        assert.equal(r.valid, true);
    });

    test('rejects fileSize > 100GB', () => {
        const r = InputValidator.validate({
            type: 'file-meta',
            payload: {
                fileName: 'big.bin',
                fileSize: 101 * 1024 * 1024 * 1024,
                totalChunks: 400000,
                chunkSize: 262144,
            },
        });
        assert.equal(r.valid, false);
    });

    test('rejects zero totalChunks', () => {
        const r = InputValidator.validate({
            type: 'file-meta',
            payload: { fileName: 'a.txt', fileSize: 0, totalChunks: 0, chunkSize: 131072 },
        });
        assert.equal(r.valid, false);
    });

    test('rejects missing fileName', () => {
        const r = InputValidator.validate({
            type: 'file-meta',
            payload: { fileSize: 100, totalChunks: 1, chunkSize: 131072 },
        });
        assert.equal(r.valid, false);
    });
});

// ── Unknown type ──────────────────────────────────────────────────────────

describe('InputValidator — unknown type', () => {
    test('rejects unknown type (strict schema enforcement)', () => {
        // By design, the validator rejects unknown message types to prevent
        // injection of unrecognized protocol messages.
        const r = InputValidator.validate({ type: 'custom-extension' });
        assert.equal(r.valid, false);
    });
});
