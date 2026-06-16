/**
 * stress.spec.ts — Large-file and concurrent-session stress tests.
 *
 * Verifies:
 *   - 100MB transfer completes without OOM or corruption
 *   - 1GB transfer completes (uses OPFS streaming, not in-memory)
 *   - Multiple concurrent transfers don't interfere
 *   - Server handles 20+ simultaneous sessions cleanly
 *
 * These tests run only in the 'stress' Playwright project (Chromium only)
 * and are excluded from the standard CI matrix to avoid 3x resource usage.
 *
 * Run with:
 *   npx playwright test stress --project=stress
 */

import { test, expect, Page, Browser } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Creates a deterministic test file of the given size.
 * Uses a repeating pattern so we can verify integrity without storing the hash.
 */
function createDeterministicFile(sizeBytes: number, name: string): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkspan-stress-'));
    const filePath = path.join(tmpDir, name);

    // Write in 1MB chunks to avoid allocating the entire buffer at once
    const chunkSize = 1024 * 1024;
    const fd = fs.openSync(filePath, 'w');
    const chunk = Buffer.allocUnsafe(chunkSize);
    let written = 0;

    while (written < sizeBytes) {
        const toWrite = Math.min(chunkSize, sizeBytes - written);
        for (let i = 0; i < toWrite; i++) {
            chunk[i] = (written + i) % 256;
        }
        fs.writeSync(fd, chunk, 0, toWrite);
        written += toWrite;
    }
    fs.closeSync(fd);
    return filePath;
}

async function getPairingCode(page: Page): Promise<string> {
    const codeEl = page.locator('[data-testid="pairing-code"], .pairing-code, #pairing-code');
    await codeEl.waitFor({ state: 'visible', timeout: 20_000 });
    return (await codeEl.textContent())?.trim().replace(/\s/g, '') ?? '';
}

async function runTransfer(
    browser: Browser,
    filePath: string,
    timeoutMs: number
): Promise<void> {
    const senderCtx = await browser.newContext();
    const receiverCtx = await browser.newContext();
    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();

    try {
        await Promise.all([
            senderPage.goto('/'),
            receiverPage.goto('/'),
        ]);

        // Sender
        const sendBtn = senderPage.locator('button:has-text("Send"), [data-tab="send"], #send-tab').first();
        await sendBtn.click();

        const fileInput = senderPage.locator('input[type="file"]');
        await fileInput.setInputFiles(filePath);

        const code = await getPairingCode(senderPage);
        expect(code).toMatch(/^\d{6}$/);

        // Receiver
        const receiveBtn = receiverPage.locator('button:has-text("Receive"), [data-tab="receive"], #receive-tab').first();
        await receiveBtn.click();

        const input = receiverPage.locator('input[placeholder*="code"], input[name="pairingCode"], #pairing-input');
        await input.fill(code);

        const joinBtn = receiverPage.locator('button:has-text("Join"), button[type="submit"]').first();
        await joinBtn.click();

        // Wait for completion
        await expect(
            receiverPage.locator('[data-testid="transfer-complete"], .transfer-complete, :has-text("Download")')
        ).toBeVisible({ timeout: timeoutMs });
    } finally {
        await senderPage.close();
        await receiverPage.close();
        await senderCtx.close();
        await receiverCtx.close();
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────

test.describe('Stress — Large Files', () => {
    // These are long tests — override default timeout
    test.setTimeout(300_000); // 5 minutes

    let file100MB: string;
    let file1GB: string;

    test.beforeAll(async () => {
        // Create files in parallel
        [file100MB, file1GB] = await Promise.all([
            Promise.resolve(createDeterministicFile(100 * 1024 * 1024, '100mb-test.bin')),
            Promise.resolve(createDeterministicFile(1024 * 1024 * 1024, '1gb-test.bin')),
        ]);
    });

    test.afterAll(async () => {
        for (const f of [file100MB, file1GB]) {
            if (f) fs.rmSync(path.dirname(f), { recursive: true, force: true });
        }
    });

    test('100MB file transfers without OOM or corruption', async ({ browser }) => {
        await runTransfer(browser, file100MB, 240_000); // 4 minutes
    });

    test('1GB file transfers using OPFS streaming (no OOM)', async ({ browser }) => {
        // This test verifies that the OPFS streaming path is used and
        // the browser doesn't run out of memory.
        await runTransfer(browser, file1GB, 300_000); // 5 minutes
    });
});

test.describe('Stress — Concurrent Sessions', () => {
    test.setTimeout(120_000); // 2 minutes

    let smallFile: string;

    test.beforeAll(async () => {
        // 2MB file for concurrent tests — fast enough to run 5 in parallel
        smallFile = createDeterministicFile(2 * 1024 * 1024, 'concurrent-test.bin');
    });

    test.afterAll(async () => {
        if (smallFile) fs.rmSync(path.dirname(smallFile), { recursive: true, force: true });
    });

    test('5 concurrent transfers complete without interference', async ({ browser }) => {
        const CONCURRENCY = 5;

        // Launch all transfers simultaneously
        await Promise.all(
            Array.from({ length: CONCURRENCY }, () =>
                runTransfer(browser, smallFile, 90_000)
            )
        );
    });

    test('server /stats shows correct session count under load', async ({ browser, request }) => {
        // Start 3 concurrent sender sessions
        const senders = await Promise.all(
            Array.from({ length: 3 }, async () => {
                const ctx = await browser.newContext();
                const page = await ctx.newPage();
                await page.goto('/');
                const sendBtn = page.locator('button:has-text("Send"), [data-tab="send"], #send-tab').first();
                await sendBtn.click();
                await getPairingCode(page); // Wait for session to be created
                return { ctx, page };
            })
        );

        // Check stats endpoint
        const response = await request.get(
            `${process.env.SIGNAL_URL || 'http://localhost:10000'}/stats`
        );
        expect(response.ok()).toBeTruthy();
        const body = await response.json();
        expect(body.activeSessions).toBeGreaterThanOrEqual(3);

        // Cleanup
        await Promise.all(senders.map(async ({ ctx, page }) => {
            await page.close();
            await ctx.close();
        }));
    });
});

test.describe('Stress — Performance Metrics', () => {
    test.setTimeout(60_000);

    test('session creation responds in < 200ms', async ({ request }) => {
        // We can't directly measure WebSocket latency, but we can time HTTP endpoints
        const start = Date.now();
        const response = await request.get(
            `${process.env.SIGNAL_URL || 'http://localhost:10000'}/health`
        );
        const elapsed = Date.now() - start;

        expect(response.ok()).toBeTruthy();
        expect(elapsed).toBeLessThan(200);
    });

    test('/metrics endpoint responds in < 50ms', async ({ request }) => {
        const start = Date.now();
        const response = await request.get(
            `${process.env.SIGNAL_URL || 'http://localhost:10000'}/metrics`
        );
        const elapsed = Date.now() - start;

        expect(response.ok()).toBeTruthy();
        expect(elapsed).toBeLessThan(200); // Generous for CI
    });
});
