/**
 * multiconn.spec.ts — Multi-connection striping E2E (Phase 3).
 *
 * A plain transfer passing does NOT prove the secondary RTCPeerConnections came up
 * (a silent negotiation failure still transfers everything over the primary). This
 * spec listens to both pages' consoles for the explicit
 * "[MultiConnection] Secondary connection N connected" log and requires it on BOTH
 * peers before the transfer completes — proving capability negotiation, pcIndex
 * multiplexing over live signaling, and real ICE for the secondaries.
 */

import { test, expect, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

function createTestFile(sizeBytes: number, name = 'multiconn-test.bin'): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkspan-e2e-'));
    const filePath = path.join(tmpDir, name);
    const buffer = Buffer.allocUnsafe(sizeBytes);
    for (let i = 0; i < sizeBytes; i++) buffer[i] = (i * 31) % 256;
    fs.writeFileSync(filePath, buffer);
    return filePath;
}

function watchSecondaries(page: Page): Set<number> {
    const connected = new Set<number>();
    page.on('console', (msg) => {
        const m = msg.text().match(/\[MultiConnection\] Secondary connection (\d+) connected/);
        if (m) connected.add(Number(m[1]));
    });
    return connected;
}

async function waitFor(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 250));
    }
}

test.describe('Transfer — Multi-connection striping', () => {
    let testFilePath: string;

    test.beforeAll(async () => {
        // Large enough that the transfer is still running while secondaries connect.
        testFilePath = createTestFile(8 * 1024 * 1024);
    });

    test.afterAll(async () => {
        if (testFilePath) fs.rmSync(path.dirname(testFilePath), { recursive: true, force: true });
    });

    test('secondary connections come up on both peers and the transfer completes', async ({ browser }) => {
        const senderCtx = await browser.newContext();
        const receiverCtx = await browser.newContext();
        const senderPage = await senderCtx.newPage();
        const receiverPage = await receiverCtx.newPage();
        const senderSecondaries = watchSecondaries(senderPage);
        const receiverSecondaries = watchSecondaries(receiverPage);

        try {
            await Promise.all([senderPage.goto('/'), receiverPage.goto('/')]);

            // Sender: pick file → pairing code appears.
            await senderPage.locator('[data-testid="send-tab"]').click();
            await senderPage.locator('[data-testid="send-view"]').waitFor({ state: 'visible', timeout: 5_000 });
            await senderPage.locator('#file-input').setInputFiles(testFilePath);
            const codeEl = senderPage.locator('[data-testid="pairing-code"]');
            await codeEl.waitFor({ state: 'visible', timeout: 15_000 });
            const code = (await codeEl.textContent())?.trim().replace(/\s/g, '') ?? '';
            expect(code).toMatch(/^\d{6}$/);

            // Receiver: join, then both confirm SAS, then accept the incoming batch.
            await receiverPage.locator('[data-testid="receive-tab"]').click();
            await receiverPage.locator('[data-testid="receive-view"]').waitFor({ state: 'visible', timeout: 5_000 });
            for (let i = 0; i < 6; i++) {
                await receiverPage.locator(`#code-digit-${i}`).fill(code[i]);
            }
            await receiverPage.locator('[data-testid="join-button"]').click({ timeout: 2_000 }).catch(() => {});
            for (const page of [senderPage, receiverPage]) {
                const btn = page.locator('[data-testid="sas-confirm"]');
                await btn.waitFor({ state: 'visible', timeout: 20_000 });
                await btn.click();
            }
            const accept = receiverPage.locator('[data-testid="rc-accept"]');
            await accept.waitFor({ state: 'visible', timeout: 15_000 });
            await accept.click();

            // The proof: at least one secondary must reach 'connected' on BOTH peers.
            await waitFor(() => senderSecondaries.size > 0, 30_000, 'sender secondary connection');
            await waitFor(() => receiverSecondaries.size > 0, 30_000, 'receiver secondary connection');

            // And the striped transfer still completes, byte-verified by the app's
            // own manifest-root check before transfer-complete is shown.
            await expect(
                receiverPage.locator('[data-testid="transfer-complete"]')
            ).toBeVisible({ timeout: 60_000 });
        } finally {
            await senderPage.close();
            await receiverPage.close();
            await senderCtx.close();
            await receiverCtx.close();
        }
    });
});
