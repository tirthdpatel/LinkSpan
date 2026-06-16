import { defineConfig, devices } from '@playwright/test';

/**
 * LinkSpan Playwright Configuration
 *
 * Multi-browser E2E test suite for:
 *   - Full transfer flows (Chrome, Firefox, WebKit)
 *   - Resume after interruption
 *   - Mobile viewport
 *   - Stress tests (100MB, 1GB)
 *
 * Run with:
 *   npx playwright test              # all tests
 *   npx playwright test transfer     # specific spec
 *   npx playwright test --headed     # show browser
 *   npx playwright test --debug      # pause on failure
 */
export default defineConfig({
    testDir: '.',
    testMatch: ['**/*.spec.ts'],

    // Global settings
    timeout: 120_000,           // 2 min per test (transfers can be slow)
    expect: { timeout: 10_000 },
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 2 : 4,
    reporter: [
        ['list'],
        ['html', { open: 'never', outputFolder: '../test-results/html' }],
        ['junit', { outputFile: '../test-results/results.xml' }],
    ],
    outputDir: '../test-results/artifacts',

    // Self-start the full stack (signaling server + client dev server) so the suite runs
    // with a single `playwright test` — in CI and locally. Locally, an already-running
    // server is reused (handy during development). Rate limits are relaxed so a test run
    // from one IP isn't throttled. The client defaults its signaling URL to ws://localhost:10000.
    webServer: [
        {
            command: 'node ../server/src/server.js',
            url: 'http://localhost:10000/health',
            reuseExistingServer: !process.env.CI,
            timeout: 60_000,
            env: {
                PORT: '10000',
                RL_MAX_CONNECTIONS_PER_MIN: '100000',
                RL_MAX_SESSIONS_PER_HOUR: '100000',
                RL_MAX_MESSAGES_PER_SEC: '100000',
                RL_MAX_JOIN_ATTEMPTS_PER_MIN: '100000',
            },
        },
        {
            command: 'npm --prefix ../client run dev -- --port 3000 --strictPort',
            url: 'http://localhost:3000',
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
        },
    ],

    use: {
        // Local dev server (matches the webServer client above)
        baseURL: process.env.BASE_URL || 'http://localhost:3000',
        // Collect traces on failure
        trace: 'on-first-retry',
        // Video on failure
        video: 'on-first-retry',
        // Screenshots on failure
        screenshot: 'only-on-failure',
        // Slower interactions for CI stability
        actionTimeout: 15_000,
        navigationTimeout: 30_000,
    },

    // ── Browser Projects ────────────────────────────────────────────────────
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                // Two browser contexts on one host negotiate WebRTC over loopback.
                // Chrome's default mDNS host-candidate obfuscation replaces local IPs
                // with unresolvable *.local names; with no STUN/TURN reachable in CI,
                // ICE then never connects. Disabling mDNS lets the host candidates carry
                // real loopback IPs so the data channel establishes.
                launchOptions: {
                    args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
                },
            },
        },
        {
            name: 'firefox',
            use: { ...devices['Desktop Firefox'] },
        },
        {
            name: 'webkit',
            use: { ...devices['Desktop Safari'] },
        },

        // Mobile
        {
            name: 'mobile-chrome',
            testMatch: '**/mobile.spec.ts',
            use: { ...devices['Pixel 5'] },
        },
        {
            name: 'mobile-safari',
            testMatch: '**/mobile.spec.ts',
            use: { ...devices['iPhone 12'] },
        },

        // Stress tests run only on Chromium (to avoid 3x resource usage)
        {
            name: 'stress',
            testMatch: '**/stress.spec.ts',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
});
