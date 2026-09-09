import { defineConfig, devices } from '@playwright/test';

/**
 * e2e runs against a real browser — the only place Medblocks' Lit 1 components,
 * Shoelace's shadow DOM and the CDR are all exercised together.
 *
 * `npm run test:e2e` starts the BFF and Vite itself; the EHRbase + HAPI stack
 * must already be up, and tests that need it are tagged @stack.
 */
// Overridable together with VITE_PORT / PORT / BFF_URL (see vite.config.ts) so
// a worktree's e2e run drives its own dev pair, not whichever checkout happens
// to hold 5173 — `reuseExistingServer` would otherwise silently test the
// other checkout's code.
const BASE_URL = process.env.PW_BASE_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  // Unit tests and e2e tests share one package, so Playwright must be told not
  // to wander into vitest's territory: without this it picks up vitest.config.ts
  // and the tests/unit suite, then fails with "Vitest failed to access its
  // internal state" — a confusing error that is really just misrouted discovery.
  testIgnore: ['**/tests/unit/**', '**/node_modules/**'],
  timeout: 60_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
    cwd: import.meta.dirname,
  },
});
