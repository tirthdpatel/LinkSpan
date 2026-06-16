/**
 * DeviceIdentity — a stable, local-only identity for this browser/device.
 *
 * Used by the receive-confirmation workflow (Feature 4): the sender announces its
 * device id + human name in BATCH_META so the receiver can show "who is sending"
 * and optionally remember the device for auto-approval. The id is a random opaque
 * token minted once per browser profile and persisted in localStorage — it is NOT
 * a cryptographic credential and carries no authority on its own (a malicious peer
 * can spoof any id), so "remember this device" is a convenience gated behind the
 * one-time SAS/MITM check, never a security boundary by itself.
 *
 * All access is defensive: localStorage may be unavailable (private mode, SSR,
 * Node test env), in which case we fall back to an in-memory ephemeral identity.
 */

import { DEVICE_TYPE } from '@shared/constants.js';

const ID_KEY = 'linkspan-device-id';
const NAME_KEY = 'linkspan-device-name';

let _memoryId = null;
let _memoryName = null;

function safeGet(key) {
    try {
        if (typeof localStorage === 'undefined') return null;
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function safeSet(key, value) {
    try {
        if (typeof localStorage === 'undefined') return false;
        localStorage.setItem(key, value);
        return true;
    } catch {
        return false;
    }
}

function randomId() {
    const arr = new Uint8Array(16);
    (globalThis.crypto || crypto).getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A friendly default device name derived from the platform/user agent. */
function defaultDeviceName() {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
    let os = 'Device';
    if (/Windows/i.test(ua)) os = 'Windows PC';
    else if (/iPhone/i.test(ua)) os = 'iPhone';
    else if (/iPad/i.test(ua)) os = 'iPad';
    else if (/Mac/i.test(ua)) os = 'Mac';
    else if (/Android/i.test(ua)) os = 'Android';
    else if (/Linux/i.test(ua)) os = 'Linux';

    let browser = '';
    if (/Edg\//i.test(ua)) browser = 'Edge';
    else if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) browser = 'Chrome';
    else if (/Firefox\//i.test(ua)) browser = 'Firefox';
    else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = 'Safari';

    return browser ? `${os} · ${browser}` : os;
}

/** Detect a coarse device class (Feature 12) from the user agent. Cosmetic only. */
export function detectDeviceType(ua = (typeof navigator !== 'undefined' ? navigator.userAgent || '' : '')) {
    if (/iPad/i.test(ua) || (/Tablet/i.test(ua)) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) {
        return DEVICE_TYPE.TABLET;
    }
    if (/iPhone|iPod|Android.*Mobile|Mobile.*Firefox|Windows Phone/i.test(ua)) {
        return DEVICE_TYPE.MOBILE;
    }
    if (/Windows|Macintosh|Mac OS X|Linux|CrOS|X11/i.test(ua)) {
        return DEVICE_TYPE.DESKTOP;
    }
    return DEVICE_TYPE.UNKNOWN;
}

/** Detect the platform/OS label (Feature 12) from the user agent. */
export function detectPlatform(ua = (typeof navigator !== 'undefined' ? navigator.userAgent || '' : '')) {
    if (/Windows/i.test(ua)) return 'Windows';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
    if (/Mac/i.test(ua)) return 'macOS';
    if (/CrOS/i.test(ua)) return 'ChromeOS';
    if (/Android/i.test(ua)) return 'Android';
    if (/Linux/i.test(ua)) return 'Linux';
    return 'Unknown';
}

/** Clamp a user-supplied device name to something safe to render and transmit. */
export function sanitizeDeviceName(name) {
    return String(name ?? '')
        // strip control characters that could corrupt the UI or logs
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 64) || 'Unknown device';
}

/** Get (minting once) this device's stable id. */
export function getDeviceId() {
    let id = safeGet(ID_KEY);
    if (id && /^[0-9a-f]{8,}$/.test(id)) return id;
    if (_memoryId) return _memoryId;
    id = randomId();
    if (!safeSet(ID_KEY, id)) _memoryId = id;
    return id;
}

/** Get this device's display name (user-set or platform default). */
export function getDeviceName() {
    const stored = safeGet(NAME_KEY) ?? _memoryName;
    if (stored) return sanitizeDeviceName(stored);
    const def = defaultDeviceName();
    if (!safeSet(NAME_KEY, def)) _memoryName = def;
    return def;
}

/** Persist a user-chosen device name. Returns the sanitized value actually stored. */
export function setDeviceName(name) {
    const clean = sanitizeDeviceName(name);
    if (!safeSet(NAME_KEY, clean)) _memoryName = clean;
    return clean;
}

/** Get this device's coarse type (mobile / tablet / desktop / unknown). */
export function getDeviceType() {
    return detectDeviceType();
}

/** Get this device's platform/OS label. */
export function getPlatform() {
    return detectPlatform();
}

/**
 * Compute a stable, non-reversible device fingerprint (Feature 12).
 *
 * Hashes the device's stable id together with coarse environment attributes
 * (platform, language, timezone, screen geometry) into a short hex digest. This
 * gives a human-comparable "this is the same device" signal across sessions
 * WITHOUT exposing the raw id. It is NOT a security credential — like the device
 * id it is spoofable — and is used only for recognizability in the contacts UI.
 *
 * @returns {Promise<string>} 16-hex-char fingerprint (truncated SHA-256)
 */
export async function computeFingerprint() {
    const parts = [
        getDeviceId(),
        getPlatform(),
        typeof navigator !== 'undefined' ? (navigator.language || '') : '',
        (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } })(),
        typeof screen !== 'undefined' ? `${screen.width || 0}x${screen.height || 0}x${screen.colorDepth || 0}` : '',
    ];
    const data = new TextEncoder().encode(parts.join('|'));
    const subtle = (globalThis.crypto || crypto).subtle;
    const digest = await subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(digest).slice(0, 8);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Full device metadata (Feature 12): a recognizable, persistent description of
 * this device for display across sessions and for the contact a peer records.
 * @returns {{ deviceId, deviceName, deviceType, platform }}
 */
export function getDeviceMetadata() {
    return {
        deviceId: getDeviceId(),
        deviceName: getDeviceName(),
        deviceType: getDeviceType(),
        platform: getPlatform(),
    };
}

/**
 * The identity to embed in BATCH_META. Includes the coarse device type + platform
 * (Feature 12) so the receiver can show a recognizable contact and remember it with
 * useful metadata. Kept synchronous (no fingerprint) so it never blocks send start.
 */
export function getLocalIdentity() {
    return {
        deviceId: getDeviceId(),
        deviceName: getDeviceName(),
        deviceType: getDeviceType(),
        platform: getPlatform(),
    };
}
