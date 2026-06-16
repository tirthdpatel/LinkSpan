import { describe, test, expect } from 'vitest';
import {
    detectDeviceType,
    detectPlatform,
    sanitizeDeviceName,
    getDeviceId,
    getLocalIdentity,
    getDeviceMetadata,
    computeFingerprint,
} from '../core/DeviceIdentity.js';
import { DEVICE_TYPE } from '@shared/constants.js';

const UA = {
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Mobile/15E148 Safari/604',
    ipad: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605 Safari/604',
    androidPhone: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Mobile) AppleWebKit/537 Chrome/120 Mobile Safari/537',
    androidTablet: 'Mozilla/5.0 (Linux; Android 14; Tab) AppleWebKit/537 Chrome/120 Safari/537',
    windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537 Chrome/120 Safari/537',
    mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605 Safari/605',
};

describe('DeviceIdentity — device type / platform detection (Feature 12)', () => {
    test('detects mobile, tablet and desktop classes', () => {
        expect(detectDeviceType(UA.iphone)).toBe(DEVICE_TYPE.MOBILE);
        expect(detectDeviceType(UA.androidPhone)).toBe(DEVICE_TYPE.MOBILE);
        expect(detectDeviceType(UA.ipad)).toBe(DEVICE_TYPE.TABLET);
        expect(detectDeviceType(UA.androidTablet)).toBe(DEVICE_TYPE.TABLET);
        expect(detectDeviceType(UA.windows)).toBe(DEVICE_TYPE.DESKTOP);
        expect(detectDeviceType(UA.mac)).toBe(DEVICE_TYPE.DESKTOP);
        expect(detectDeviceType('something weird')).toBe(DEVICE_TYPE.UNKNOWN);
    });

    test('detects platform labels', () => {
        expect(detectPlatform(UA.iphone)).toBe('iOS');
        expect(detectPlatform(UA.androidPhone)).toBe('Android');
        expect(detectPlatform(UA.windows)).toBe('Windows');
        expect(detectPlatform(UA.mac)).toBe('macOS');
    });

    test('sanitizeDeviceName strips control chars and clamps length', () => {
        expect(sanitizeDeviceName('  My Phone  ')).toBe('My Phone');
        expect(sanitizeDeviceName('a'.repeat(200)).length).toBe(64);
        expect(sanitizeDeviceName('')).toBe('Unknown device');
    });
});

describe('DeviceIdentity — stable identity & metadata (Feature 12)', () => {
    test('device id is stable across calls within a session', () => {
        const id1 = getDeviceId();
        const id2 = getDeviceId();
        expect(id1).toBe(id2);
        expect(id1).toMatch(/^[0-9a-f]{8,}$/);
    });

    test('local identity carries id, name, type and platform', () => {
        const id = getLocalIdentity();
        expect(id.deviceId).toBeTruthy();
        expect(id.deviceName).toBeTruthy();
        expect(typeof id.deviceType).toBe('string');
        expect(typeof id.platform).toBe('string');
        const meta = getDeviceMetadata();
        expect(meta.deviceId).toBe(id.deviceId);
    });

    test('fingerprint is a stable 16-hex digest', async () => {
        const f1 = await computeFingerprint();
        const f2 = await computeFingerprint();
        expect(f1).toMatch(/^[0-9a-f]{16}$/);
        expect(f1).toBe(f2);
    });
});
