import { describe, test, expect } from 'vitest';
import { RememberedDevices } from '../storage/RememberedDevices.js';

describe('RememberedDevices (Feature 4 — accept & remember)', () => {
    test('remembers, recognises and forgets a device', async () => {
        const r = new RememberedDevices();
        expect(await r.isRemembered('dev-1')).toBe(false);

        await r.remember({ deviceId: 'dev-1', deviceName: 'Alice Mac' });
        expect(await r.isRemembered('dev-1')).toBe(true);

        const list = await r.list();
        expect(list.find((d) => d.deviceId === 'dev-1').deviceName).toBe('Alice Mac');

        await r.forget('dev-1');
        expect(await r.isRemembered('dev-1')).toBe(false);
    });

    test('remember is idempotent and refreshes the name', async () => {
        const r = new RememberedDevices();
        await r.remember({ deviceId: 'dev-2', deviceName: 'Old' });
        await r.remember({ deviceId: 'dev-2', deviceName: 'New' });
        const list = await r.list();
        expect(list.filter((d) => d.deviceId === 'dev-2').length).toBe(1);
        expect(list.find((d) => d.deviceId === 'dev-2').deviceName).toBe('New');
    });

    test('clear removes all remembered devices', async () => {
        const r = new RememberedDevices();
        await r.remember({ deviceId: 'a', deviceName: 'A' });
        await r.remember({ deviceId: 'b', deviceName: 'B' });
        await r.clear();
        expect((await r.list()).length).toBe(0);
    });

    test('an empty device id is never remembered', async () => {
        const r = new RememberedDevices();
        await r.remember({ deviceId: '', deviceName: 'X' });
        expect(await r.isRemembered('')).toBe(false);
    });
});
