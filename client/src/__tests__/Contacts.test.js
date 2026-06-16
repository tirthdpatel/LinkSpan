import { describe, test, expect, beforeEach } from 'vitest';
import { RememberedDevices } from '../storage/RememberedDevices.js';

// fake-indexeddb persists across tests in a file; clear the shared store first.
beforeEach(async () => { await new RememberedDevices().clear(); });

describe('RememberedDevices — contact management (Features 10 & 11)', () => {
    test('stores device type + platform and lists them', async () => {
        const r = new RememberedDevices();
        await r.remember({ deviceId: 'c1', deviceName: 'Alice Mac', deviceType: 'desktop', platform: 'macOS' });
        const rec = await r.get('c1');
        expect(rec.deviceType).toBe('desktop');
        expect(rec.platform).toBe('macOS');
        const list = await r.list();
        expect(list[0].favorite).toBe(false);
    });

    test('rename changes the friendly name', async () => {
        const r = new RememberedDevices();
        await r.remember({ deviceId: 'c2', deviceName: 'Old' });
        await r.rename('c2', 'New Name');
        expect((await r.get('c2')).deviceName).toBe('New Name');
    });

    test('favorites sort first and are preserved across remember()', async () => {
        const r = new RememberedDevices();
        await r.remember({ deviceId: 'a', deviceName: 'A' });
        await r.remember({ deviceId: 'b', deviceName: 'B' });
        await r.setFavorite('b', true);
        // Re-remembering must not clear the favorite flag.
        await r.remember({ deviceId: 'b', deviceName: 'B' });
        const list = await r.list();
        expect(list[0].deviceId).toBe('b');
        expect(list[0].favorite).toBe(true);
    });

    test('search filters by name, platform or type', async () => {
        const r = new RememberedDevices();
        await r.remember({ deviceId: 'p1', deviceName: 'Work Laptop', platform: 'Windows', deviceType: 'desktop' });
        await r.remember({ deviceId: 'p2', deviceName: 'My Phone', platform: 'iOS', deviceType: 'mobile' });
        expect((await r.search('phone')).map((d) => d.deviceId)).toEqual(['p2']);
        expect((await r.search('windows')).map((d) => d.deviceId)).toEqual(['p1']);
        expect((await r.search('mobile')).map((d) => d.deviceId)).toEqual(['p2']);
    });

    test('forget removes a device and its auto-approval', async () => {
        const r = new RememberedDevices();
        await r.remember({ deviceId: 'g1', deviceName: 'G' });
        expect(await r.isRemembered('g1')).toBe(true);
        await r.forget('g1');
        expect(await r.isRemembered('g1')).toBe(false);
    });

    test('touch refreshes lastSeen without re-trusting', async () => {
        const r = new RememberedDevices();
        await r.remember({ deviceId: 't1', deviceName: 'T' });
        const before = (await r.get('t1')).lastSeen;
        await new Promise((res) => setTimeout(res, 5));
        await r.touch('t1');
        expect((await r.get('t1')).lastSeen).toBeGreaterThanOrEqual(before);
    });
});
