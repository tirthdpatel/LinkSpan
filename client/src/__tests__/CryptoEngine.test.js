/**
 * CryptoEngine.test.js — Unit tests for AES-256-GCM encryption engine.
 *
 * Uses the actual CryptoEngine static API:
 *   - generateKey()
 *   - exportKey(key) / importKey(b64)
 *   - encryptChunk(key, plaintext) → { ciphertext, iv }  (or Uint8Array with IV prepended)
 *   - decryptChunk(key, ivPlusCiphertext) → ArrayBuffer
 *   - deriveKeyFromPassword(password, salt)
 */

import { describe, test, expect } from 'vitest';
import { CryptoEngine } from '../crypto/CryptoEngine.js';

// crypto is available globally from setup.js (Node 18 WebCrypto)

describe('CryptoEngine', () => {

    // ── Key generation ────────────────────────────────────────────────────

    test('generateKey produces a CryptoKey', async () => {
        const key = await CryptoEngine.generateKey();
        expect(key).toBeTruthy();
        expect(key.type).toBe('secret');
        expect(key.algorithm.name).toBe('AES-GCM');
        expect(key.algorithm.length).toBe(256);
    });

    test('generateKey produces unique keys', async () => {
        const k1 = await CryptoEngine.generateKey();
        const k2 = await CryptoEngine.generateKey();
        const r1 = await globalThis.crypto.subtle.exportKey('raw', k1);
        const r2 = await globalThis.crypto.subtle.exportKey('raw', k2);
        expect(Buffer.from(r1).toString('hex')).not.toBe(
            Buffer.from(r2).toString('hex')
        );
    });

    // ── Export / Import round-trip ────────────────────────────────────────

    test('exportKey returns a base64 string', async () => {
        const key = await CryptoEngine.generateKey();
        const exported = await CryptoEngine.exportKey(key);
        expect(typeof exported).toBe('string');
        expect(exported.length).toBeGreaterThan(0);
    });

    test('exportKey → importKey round-trip produces equivalent key', async () => {
        const key = await CryptoEngine.generateKey();
        const exported = await CryptoEngine.exportKey(key);
        const imported = await CryptoEngine.importKey(exported);

        expect(imported.type).toBe('secret');
        expect(imported.algorithm.name).toBe('AES-GCM');

        // Both keys must decrypt data encrypted by the original
        const data = new TextEncoder().encode('Hello, LinkSpan!').buffer;
        const ct = await CryptoEngine.encryptChunk(key, data);
        const pt = await CryptoEngine.decryptChunk(imported, ct);
        expect(new TextDecoder().decode(pt)).toBe('Hello, LinkSpan!');
    });

    // ── Encrypt / Decrypt round-trip ──────────────────────────────────────

    test('encryptChunk → decryptChunk round-trip for 256KB', async () => {
        const key = await CryptoEngine.generateKey();
        // getRandomValues is limited to 65536 bytes per call — fill in 64KB chunks
        const data = new Uint8Array(256 * 1024);
        for (let offset = 0; offset < data.length; offset += 65536) {
            globalThis.crypto.getRandomValues(data.subarray(offset, offset + 65536));
        }

        const encrypted = await CryptoEngine.encryptChunk(key, data.buffer);
        const decrypted = await CryptoEngine.decryptChunk(key, encrypted);

        expect(new Uint8Array(decrypted)).toEqual(data);
    });

    test('decryptChunk with wrong key throws', async () => {
        const key1 = await CryptoEngine.generateKey();
        const key2 = await CryptoEngine.generateKey();
        const data = new TextEncoder().encode('secret data').buffer;

        const encrypted = await CryptoEngine.encryptChunk(key1, data);

        await expect(
            CryptoEngine.decryptChunk(key2, encrypted)
        ).rejects.toThrow();
    });

    test('decryptChunk with tampered ciphertext throws', async () => {
        const key = await CryptoEngine.generateKey();
        const data = new TextEncoder().encode('integrity check').buffer;

        const encrypted = await CryptoEngine.encryptChunk(key, data);

        // Flip the last byte
        const tampered = encrypted instanceof ArrayBuffer ? encrypted.slice(0) : encrypted;
        const view = new Uint8Array(tampered instanceof ArrayBuffer ? tampered : tampered);
        view[view.length - 1] ^= 0xff;

        await expect(
            CryptoEngine.decryptChunk(key, tampered)
        ).rejects.toThrow();
    });

    // ── IV uniqueness ─────────────────────────────────────────────────────

    test('encryptChunk with same plaintext produces different ciphertexts (random IV)', async () => {
        const key = await CryptoEngine.generateKey();
        const data = new TextEncoder().encode('same plaintext').buffer;

        const ct1 = await CryptoEngine.encryptChunk(key, data);
        const ct2 = await CryptoEngine.encryptChunk(key, data);

        // Different IVs produce different ciphertexts
        const b1 = ct1 instanceof ArrayBuffer ? new Uint8Array(ct1) : ct1;
        const b2 = ct2 instanceof ArrayBuffer ? new Uint8Array(ct2) : ct2;

        expect(Buffer.from(b1).toString('hex')).not.toBe(
            Buffer.from(b2).toString('hex')
        );
    });

    // ── Password-derived keys ─────────────────────────────────────────────

    test('deriveKeyFromPassword produces the same key with same inputs', async () => {
        const password = 'test-password-123';
        const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));

        const { key: k1 } = await CryptoEngine.deriveKeyFromPassword(password, salt);
        const { key: k2 } = await CryptoEngine.deriveKeyFromPassword(password, salt);

        const r1 = await globalThis.crypto.subtle.exportKey('raw', k1);
        const r2 = await globalThis.crypto.subtle.exportKey('raw', k2);

        expect(Buffer.from(r1).toString('hex')).toBe(
            Buffer.from(r2).toString('hex')
        );
    });

    test('deriveKeyFromPassword with different salts produces different keys', async () => {
        const password = 'same-password';
        const salt1 = globalThis.crypto.getRandomValues(new Uint8Array(16));
        const salt2 = globalThis.crypto.getRandomValues(new Uint8Array(16));

        const { key: k1 } = await CryptoEngine.deriveKeyFromPassword(password, salt1);
        const { key: k2 } = await CryptoEngine.deriveKeyFromPassword(password, salt2);

        const r1 = await globalThis.crypto.subtle.exportKey('raw', k1);
        const r2 = await globalThis.crypto.subtle.exportKey('raw', k2);

        expect(Buffer.from(r1).toString('hex')).not.toBe(
            Buffer.from(r2).toString('hex')
        );
    });

    test('deriveKeyFromPassword with different passwords produces different keys', async () => {
        const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));

        const { key: k1 } = await CryptoEngine.deriveKeyFromPassword('password1', salt);
        const { key: k2 } = await CryptoEngine.deriveKeyFromPassword('password2', salt);

        const r1 = await globalThis.crypto.subtle.exportKey('raw', k1);
        const r2 = await globalThis.crypto.subtle.exportKey('raw', k2);

        expect(Buffer.from(r1).toString('hex')).not.toBe(
            Buffer.from(r2).toString('hex')
        );
    });

    test('derived key can encrypt and decrypt data', async () => {
        const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
        const { key } = await CryptoEngine.deriveKeyFromPassword('my-password', salt);

        const plaintext = new TextEncoder().encode('secret message').buffer;
        const encrypted = await CryptoEngine.encryptChunk(key, plaintext);
        const decrypted = await CryptoEngine.decryptChunk(key, encrypted);

        expect(new TextDecoder().decode(decrypted)).toBe('secret message');
    });

    test('ECDH: both peers derive the same shared key (interoperable)', async () => {
        const kpA = await CryptoEngine.generateECDHKeyPair();
        const kpB = await CryptoEngine.generateECDHKeyPair();
        const keyA = await CryptoEngine.deriveSharedKey(kpA, await CryptoEngine.exportPublicKey(kpB));
        const keyB = await CryptoEngine.deriveSharedKey(kpB, await CryptoEngine.exportPublicKey(kpA));

        // A encrypts, B decrypts — only possible if the derived keys match.
        const plaintext = new TextEncoder().encode('shared secret').buffer;
        const encrypted = await CryptoEngine.encryptChunk(keyA, plaintext);
        const decrypted = await CryptoEngine.decryptChunk(keyB, encrypted);
        expect(new TextDecoder().decode(decrypted)).toBe('shared secret');
    });

    test('ECDH: an unrelated key pair cannot decrypt', async () => {
        const kpA = await CryptoEngine.generateECDHKeyPair();
        const kpB = await CryptoEngine.generateECDHKeyPair();
        const kpEve = await CryptoEngine.generateECDHKeyPair();

        const keyAB = await CryptoEngine.deriveSharedKey(kpA, await CryptoEngine.exportPublicKey(kpB));
        const keyEve = await CryptoEngine.deriveSharedKey(kpEve, await CryptoEngine.exportPublicKey(kpA));

        const encrypted = await CryptoEngine.encryptChunk(keyAB, new TextEncoder().encode('hi').buffer);
        await expect(CryptoEngine.decryptChunk(keyEve, encrypted)).rejects.toBeDefined();
    });
});

describe('CryptoEngine — Short Authentication String (SAS)', () => {
    test('both peers compute the same SAS regardless of argument order', async () => {
        const kpA = await CryptoEngine.generateECDHKeyPair();
        const kpB = await CryptoEngine.generateECDHKeyPair();
        const pubA = await CryptoEngine.exportPublicKey(kpA);
        const pubB = await CryptoEngine.exportPublicKey(kpB);

        // Peer A passes (ourPub=A, peerPub=B); peer B passes (ourPub=B, peerPub=A).
        const sasFromA = await CryptoEngine.computeSAS(pubA, pubB);
        const sasFromB = await CryptoEngine.computeSAS(pubB, pubA);
        expect(sasFromA).toBe(sasFromB);
    });

    test('SAS is a formatted 6-digit code', async () => {
        const kpA = await CryptoEngine.generateECDHKeyPair();
        const kpB = await CryptoEngine.generateECDHKeyPair();
        const sas = await CryptoEngine.computeSAS(
            await CryptoEngine.exportPublicKey(kpA),
            await CryptoEngine.exportPublicKey(kpB)
        );
        expect(sas).toMatch(/^\d{3} \d{3}$/);
    });

    test('a substituted key (MITM) yields a different SAS on each side', async () => {
        // Honest peers A and B; attacker M sits in the middle with its own key.
        const kpA = await CryptoEngine.generateECDHKeyPair();
        const kpB = await CryptoEngine.generateECDHKeyPair();
        const kpM = await CryptoEngine.generateECDHKeyPair();
        const pubA = await CryptoEngine.exportPublicKey(kpA);
        const pubB = await CryptoEngine.exportPublicKey(kpB);
        const pubM = await CryptoEngine.exportPublicKey(kpM);

        // A sees M's key as "the peer"; B sees M's key as "the peer".
        const sasSeenByA = await CryptoEngine.computeSAS(pubA, pubM);
        const sasSeenByB = await CryptoEngine.computeSAS(pubB, pubM);
        expect(sasSeenByA).not.toBe(sasSeenByB);
    });
});
