/**
 * transfer.spec.ts — Full transfer flow E2E tests.
 *
 * Uses data-testid selectors that match the actual DOM — not fragile text matchers.
 * data-testid attributes are added in App.jsx, SendView, and ReceiveView.
 *
 * Tests the complete happy-path transfer lifecycle:
 *   1. Sender creates a session and gets a pairing code
 *   2. Receiver joins with the pairing code
 *   3. WebRTC connection is established
 *   4. File is transferred and verified on receiver side
 *
 * Runs across Chrome, Firefox, and WebKit (configured in playwright.config.ts).
 */

import { test, expect, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

// ── Helpers ────────────────────────────────────────────────────────────────

function createTestFile(sizeBytes: number, name = 'test-file.bin'): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkspan-e2e-'));
    const filePath = path.join(tmpDir, name);
    const buffer = Buffer.allocUnsafe(sizeBytes);
    for (let i = 0; i < sizeBytes; i++) buffer[i] = i % 256;
    fs.writeFileSync(filePath, buffer);
    return filePath;
}

/**
 * Click the Send card on the home view.
 * Uses data-testid="send-tab" which is set on the InteractiveCard in App.jsx.
 */
async function navigateToSend(page: Page): Promise<void> {
    await page.locator('[data-testid="send-tab"]').click();
    await page.locator('[data-testid="send-view"]').waitFor({ state: 'visible', timeout: 5_000 });
}

/**
 * Click the Receive card on the home view.
 * Uses data-testid="receive-tab" which is set on the InteractiveCard in App.jsx.
 */
async function navigateToReceive(page: Page): Promise<void> {
    await page.locator('[data-testid="receive-tab"]').click();
    await page.locator('[data-testid="receive-view"]').waitFor({ state: 'visible', timeout: 5_000 });
}

/**
 * Wait for the 6-digit pairing code to appear in SendView.
 * SendView renders the code in [data-testid="pairing-code"].
 */
async function getPairingCode(senderPage: Page): Promise<string> {
    const codeEl = senderPage.locator('[data-testid="pairing-code"]');
    await codeEl.waitFor({ state: 'visible', timeout: 15_000 });
    const text = (await codeEl.textContent())?.trim().replace(/\s/g, '') ?? '';
    expect(text).toMatch(/^\d{6}$/, 'Expected a 6-digit pairing code');
    return text;
}

/**
 * Enter a pairing code in ReceiveView and submit.
 * ReceiveView renders the input as [data-testid="pairing-input"]
 * and the submit button as [data-testid="join-button"].
 */
async function joinSession(receiverPage: Page, pairingCode: string): Promise<void> {
    // The pairing input is six individual digit boxes (#code-digit-0..5), not a
    // single field — fill each one. Entering the sixth digit auto-submits, so the
    // explicit join button is a fallback; tolerate it being intercepted by the SAS
    // overlay that pops the instant the connection establishes.
    const digits = pairingCode.padEnd(6, '').slice(0, 6).split('');
    for (let i = 0; i < 6; i++) {
        await receiverPage.locator(`#code-digit-${i}`).fill(digits[i] ?? '');
    }
    await receiverPage
        .locator('[data-testid="join-button"]')
        .click({ timeout: 2_000 })
        .catch(() => { /* sixth digit already auto-submitted */ });
}

/**
 * After SAS confirmation the receiver sees a receive-approval gate (Feature 4)
 * and must accept before any file data is requested. Honest e2e always accepts.
 */
async function acceptIncoming(receiverPage: Page): Promise<void> {
    const accept = receiverPage.locator('[data-testid="rc-accept"]');
    await accept.waitFor({ state: 'visible', timeout: 15_000 });
    await accept.click();
}

/**
 * After the ECDH handshake, both peers show the Short Authentication String
 * overlay and must confirm it matches before any file data flows. In e2e both
 * sides are honest (same code), so we click "Codes match" on each page.
 */
async function confirmSecurityCode(...pages: Page[]): Promise<void> {
    for (const page of pages) {
        const btn = page.locator('[data-testid="sas-confirm"]');
        await btn.waitFor({ state: 'visible', timeout: 20_000 });
        await btn.click();
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Transfer — Happy Path', () => {
    let senderPage: Page;
    let receiverPage: Page;
    let testFilePath: string;

    test.beforeAll(async () => {
        testFilePath = createTestFile(1024 * 1024, 'small-test.bin'); // 1 MB
    });

    test.afterAll(async () => {
        if (testFilePath) {
            const dir = path.dirname(testFilePath);
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test.beforeEach(async ({ browser }) => {
        const senderCtx = await browser.newContext();
        const receiverCtx = await browser.newContext();
        senderPage = await senderCtx.newPage();
        receiverPage = await receiverCtx.newPage();

        await Promise.all([
            senderPage.goto('/'),
            receiverPage.goto('/'),
        ]);
    });

    test.afterEach(async () => {
        await senderPage?.close();
        await receiverPage?.close();
    });

    test('sender can create a session and see a pairing code', async () => {
        await navigateToSend(senderPage);
        // Select a file to trigger session creation
        const fileInput = senderPage.locator('#file-input');
        await fileInput.setInputFiles(testFilePath);
        const code = await getPairingCode(senderPage);
        expect(code).toMatch(/^\d{6}$/);
    });

    test('receiver can join a session', async () => {
        await navigateToSend(senderPage);
        const fileInput = senderPage.locator('#file-input');
        await fileInput.setInputFiles(testFilePath);

        const code = await getPairingCode(senderPage);

        await navigateToReceive(receiverPage);
        await joinSession(receiverPage, code);
        await confirmSecurityCode(senderPage, receiverPage);

        // Both should show peer-connected indicator
        await expect(
            senderPage.locator('[data-testid="peer-connected"]')
        ).toBeVisible({ timeout: 15_000 });
    });

    test('small file (1MB) transfers successfully', async () => {
        // Sender
        await navigateToSend(senderPage);
        const fileInput = senderPage.locator('#file-input');
        await fileInput.setInputFiles(testFilePath);
        const code = await getPairingCode(senderPage);

        // Receiver
        await navigateToReceive(receiverPage);
        await joinSession(receiverPage, code);
        await confirmSecurityCode(senderPage, receiverPage);
        await acceptIncoming(receiverPage);

        // Wait for transfer complete on receiver
        await expect(
            receiverPage.locator('[data-testid="transfer-complete"]')
        ).toBeVisible({ timeout: 60_000 });
    });

    test('transfer shows progress bar during transfer', async () => {
        await navigateToSend(senderPage);
        const fileInput = senderPage.locator('#file-input');
        await fileInput.setInputFiles(testFilePath);
        const code = await getPairingCode(senderPage);

        await navigateToReceive(receiverPage);
        await joinSession(receiverPage, code);
        await confirmSecurityCode(senderPage, receiverPage);
        await acceptIncoming(receiverPage);

        // Progress bar rendered inside TransferProgress component
        await expect(
            receiverPage.locator('[data-testid="transfer-view"] [role="progressbar"], [data-testid="transfer-view"] progress')
        ).toBeVisible({ timeout: 15_000 });
    });
});

test.describe('Transfer — Error Handling', () => {
    test('shows error for invalid pairing code', async ({ page }) => {
        await page.goto('/');
        await navigateToReceive(page);
        await joinSession(page, '000000');

        // Error notification with data-testid
        await expect(
            page.locator('[data-testid="error-notification"], [role="alert"]')
        ).toBeVisible({ timeout: 10_000 });
    });

    test('health endpoint returns ok', async ({ request }) => {
        const response = await request.get(`${process.env.SIGNAL_URL || 'http://localhost:10000'}/health`);
        expect(response.ok()).toBeTruthy();
        const body = await response.json();
        expect(body.status).toBe('ok');
    });

    test('/stats endpoint returns session count', async ({ request }) => {
        // No METRICS_TOKEN set in test env → unrestricted (dev mode)
        const response = await request.get(`${process.env.SIGNAL_URL || 'http://localhost:10000'}/stats`);
        expect(response.ok()).toBeTruthy();
        const body = await response.json();
        expect(body).toHaveProperty('activeSessions');
    });

    test('/metrics endpoint returns Prometheus format', async ({ request }) => {
        const response = await request.get(`${process.env.SIGNAL_URL || 'http://localhost:10000'}/metrics`);
        expect(response.ok()).toBeTruthy();
        const text = await response.text();
        expect(text).toContain('linkspan_active_sessions');
    });

    test('/metrics returns 401 when METRICS_TOKEN is set and not provided', async ({ request }) => {
        // This test is skipped if no token is configured in the test environment
        const token = process.env.METRICS_TOKEN;
        test.skip(!token, 'METRICS_TOKEN not configured in test environment');

        const response = await request.get(`${process.env.SIGNAL_URL || 'http://localhost:10000'}/metrics`);
        expect(response.status()).toBe(401);
    });
});
