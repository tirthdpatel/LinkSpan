/**
 * resume.spec.ts — Transfer resume E2E tests.
 *
 * Simulates mid-transfer interruptions and verifies that:
 *   1. Transfer state is preserved in IndexedDB/OPFS
 *   2. On page reload, the UI offers to resume
 *   3. After resuming, only missing chunks are re-requested
 *   4. The transfer completes with the same file hash
 */

import { test, expect, Page, BrowserContext } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

// ── Helpers ────────────────────────────────────────────────────────────────

function createTestFile(sizeBytes: number, name = 'resume-test.bin'): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkspan-resume-'));
    const filePath = path.join(tmpDir, name);
    const buffer = Buffer.allocUnsafe(sizeBytes);
    for (let i = 0; i < sizeBytes; i++) buffer[i] = i % 256;
    fs.writeFileSync(filePath, buffer);
    return filePath;
}

async function getPairingCode(page: Page): Promise<string> {
    const codeEl = page.locator('[data-testid="pairing-code"], .pairing-code, #pairing-code');
    await codeEl.waitFor({ state: 'visible', timeout: 15_000 });
    return (await codeEl.textContent())?.trim().replace(/\s/g, '') ?? '';
}

async function joinSession(page: Page, code: string): Promise<void> {
    // Six per-digit boxes; the sixth digit auto-submits, so the explicit join is a
    // fallback that may be intercepted by the SAS overlay popping on connect.
    const digits = code.padEnd(6, '').slice(0, 6).split('');
    for (let i = 0; i < 6; i++) {
        await page.locator(`#code-digit-${i}`).fill(digits[i] ?? '');
    }
    await page
        .locator('[data-testid="join-button"]')
        .click({ timeout: 2_000 })
        .catch(() => { /* auto-submitted */ });
}

/** Accept the receive-approval gate (Feature 4) shown after SAS confirmation. */
async function acceptIncoming(page: Page): Promise<void> {
    const accept = page.locator('[data-testid="rc-accept"]');
    await accept.waitFor({ state: 'visible', timeout: 15_000 });
    await accept.click();
}

/**
 * Confirm the Short Authentication String overlay (shown on both peers after the
 * ECDH handshake) so the transfer can proceed. NOTE: a mid-transfer page reload
 * re-establishes the connection and re-triggers the handshake, so the SAS may
 * appear again after a reload — confirm it there too.
 */
async function confirmSecurityCode(...pages: Page[]): Promise<void> {
    for (const page of pages) {
        const btn = page.locator('[data-testid="sas-confirm"]');
        await btn.waitFor({ state: 'visible', timeout: 20_000 });
        await btn.click();
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────

test.describe('Transfer Resume', () => {
    let testFilePath: string;

    test.beforeAll(async () => {
        // 5MB file — large enough to interrupt mid-transfer
        testFilePath = createTestFile(48 * 1024 * 1024, 'medium-transfer.bin');
    });

    test.afterAll(async () => {
        if (testFilePath) {
            fs.rmSync(path.dirname(testFilePath), { recursive: true, force: true });
        }
    });

    // KNOWN GAP (verified live 2026-06-15): ResumeManager persists received chunks
    // to IDB, but after a mid-transfer reload the receiver page returns to the home
    // view with no resume affordance — resume-after-reload is not wired into the UI
    // (no session/resume state is rehydrated, the sender is not re-paired). Marked
    // fixme until the resume UX is implemented; the selectors below are already
    // modernized so the test runs as-is once the feature exists.
    test.fixme('receiver can resume after page reload mid-transfer', async ({ browser }) => {
        const senderCtx = await browser.newContext();
        const receiverCtx = await browser.newContext({
            // Grant storage permissions so IDB/OPFS survive reload
            storageState: undefined,
        });

        const senderPage = await senderCtx.newPage();
        const receiverPage = await receiverCtx.newPage();

        await Promise.all([
            senderPage.goto('/'),
            receiverPage.goto('/'),
        ]);

        // ── Start transfer ───────────────────────────────────
        await senderPage.locator('[data-testid="send-tab"]').click();

        const fileInput = senderPage.locator('#file-input');
        await fileInput.setInputFiles(testFilePath);

        const code = await getPairingCode(senderPage);

        await receiverPage.locator('[data-testid="receive-tab"]').click();

        await joinSession(receiverPage, code);
        await confirmSecurityCode(senderPage, receiverPage);
        await acceptIncoming(receiverPage);

        // ── Wait until transfer starts ─────────────────────
        await expect(
            receiverPage.locator('[role="progressbar"], .progress-bar, progress')
        ).toBeVisible({ timeout: 15_000 });

        // ── Interrupt by reloading receiver ────────────────
        await receiverPage.waitForTimeout(1000); // Let 1s worth of chunks arrive
        await receiverPage.reload();

        // ── Resume UI should appear ────────────────────────
        // The app detects interrupted state from sessionStorage/IDB
        await expect(
            receiverPage.locator(':has-text("Resume"), [data-testid="resume-btn"], button:has-text("Resume")')
        ).toBeVisible({ timeout: 10_000 });

        // Click resume
        const resumeBtn = receiverPage.locator('button:has-text("Resume"), [data-testid="resume-btn"]').first();
        await resumeBtn.click();

        // ── Transfer should complete ────────────────────────
        await expect(
            receiverPage.locator('[data-testid="transfer-complete"], .transfer-complete, :has-text("Download")')
        ).toBeVisible({ timeout: 90_000 });

        await senderPage.close();
        await receiverPage.close();
        await senderCtx.close();
        await receiverCtx.close();
    });

    // KNOWN GAP: there is no sender-side pause/resume control in the current UI, so
    // this test only ever exercised the plain completion path. Marked fixme until a
    // pause/resume control exists. (See the reload test above.)
    test.fixme('sender can pause and receiver can resume', async ({ browser }) => {
        const senderCtx = await browser.newContext();
        const receiverCtx = await browser.newContext();

        const senderPage = await senderCtx.newPage();
        const receiverPage = await receiverCtx.newPage();

        await Promise.all([
            senderPage.goto('/'),
            receiverPage.goto('/'),
        ]);

        await senderPage.locator('[data-testid="send-tab"]').click();

        const fileInput = senderPage.locator('#file-input');
        await fileInput.setInputFiles(testFilePath);

        const code = await getPairingCode(senderPage);

        await receiverPage.locator('[data-testid="receive-tab"]').click();

        await joinSession(receiverPage, code);
        await confirmSecurityCode(senderPage, receiverPage);
        await acceptIncoming(receiverPage);

        // Wait for transfer to start
        await expect(
            receiverPage.locator('[role="progressbar"], .progress-bar, progress')
        ).toBeVisible({ timeout: 15_000 });

        // Pause on sender side
        const pauseBtn = senderPage.locator('button:has-text("Pause"), [data-testid="pause-btn"]').first();
        if (await pauseBtn.isVisible()) {
            await pauseBtn.click();

            // Progress should stop
            await receiverPage.waitForTimeout(500);

            // Resume
            const resumeBtn = senderPage.locator('button:has-text("Resume"), [data-testid="resume-btn"]').first();
            await resumeBtn.click();
        }

        // Transfer should complete
        await expect(
            receiverPage.locator('[data-testid="transfer-complete"], .transfer-complete, :has-text("Download")')
        ).toBeVisible({ timeout: 90_000 });

        await senderPage.close();
        await receiverPage.close();
        await senderCtx.close();
        await receiverCtx.close();
    });
});
