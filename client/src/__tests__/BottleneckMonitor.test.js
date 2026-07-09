import { describe, test, expect } from 'vitest';
import {
    classifyBottleneck,
    EventLoopLoadMonitor,
} from '../transfer/BottleneckMonitor.js';
import {
    BOTTLENECK_CPU_LOAD,
    BOTTLENECK_LOSS_RATE,
    BOTTLENECK_IDLE_BPS,
} from '@shared/constants.js';

describe('classifyBottleneck', () => {
    test('idle when there is barely any traffic and CPU is calm', () => {
        expect(classifyBottleneck({ throughputBps: BOTTLENECK_IDLE_BPS - 1 }).verdict).toBe('idle');
    });

    test('CPU wins over everything when the main thread is pinned', () => {
        // High loss AND high CPU → CPU, because a saturated main thread masks the link.
        const r = classifyBottleneck({
            throughputBps: 10 * 1024 * 1024,
            lossRate: 0.5,
            cpuLoad: BOTTLENECK_CPU_LOAD,
        });
        expect(r.verdict).toBe('cpu');
    });

    test('CPU is reported even while throughput is idle (thread too busy to send)', () => {
        const r = classifyBottleneck({ throughputBps: 0, cpuLoad: 0.95 });
        expect(r.verdict).toBe('cpu');
    });

    test('loss when retransmits are high but CPU is calm', () => {
        const r = classifyBottleneck({
            throughputBps: 5 * 1024 * 1024,
            lossRate: BOTTLENECK_LOSS_RATE,
            cpuLoad: 0.1,
        });
        expect(r.verdict).toBe('loss');
    });

    test('link when pushing bytes with no loss and low CPU', () => {
        const r = classifyBottleneck({
            throughputBps: 50 * 1024 * 1024,
            lossRate: 0,
            cpuLoad: 0.1,
        });
        expect(r.verdict).toBe('link');
    });

    test('handles missing input without throwing', () => {
        expect(classifyBottleneck().verdict).toBe('idle');
    });
});

describe('EventLoopLoadMonitor', () => {
    // Drive it with injected timers + clock so we can simulate timer drift deterministically.
    function harness() {
        let cb = null;
        let clock = 0;
        const m = new EventLoopLoadMonitor({
            setInterval: (fn) => { cb = fn; return 1; },
            clearInterval: () => { cb = null; },
            now: () => clock,
        });
        return {
            monitor: m,
            tick(advanceMs) { clock += advanceMs; cb?.(); },
        };
    }

    test('reads ~0 load when timers fire on schedule', () => {
        const h = harness();
        h.monitor.start();
        for (let i = 0; i < 10; i++) h.tick(250); // exactly on the 250ms cadence
        expect(h.monitor.load).toBeLessThan(0.05);
    });

    test('climbs toward 1 when timers fire late (thread blocked)', () => {
        const h = harness();
        h.monitor.start();
        for (let i = 0; i < 10; i++) h.tick(500); // 250ms of drift every window → full load
        expect(h.monitor.load).toBeGreaterThan(0.8);
    });

    test('stop() resets load and detaches the timer', () => {
        const h = harness();
        h.monitor.start();
        h.tick(500);
        h.monitor.stop();
        expect(h.monitor.load).toBe(0);
    });
});
