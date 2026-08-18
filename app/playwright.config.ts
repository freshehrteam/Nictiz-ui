import { defineConfig, devices } from '@playwright/test';

/**
 * e2e runs against a real browser — the only place Medblocks' Lit 1 components,
 * Shoelace's shadow DOM and the CDR are all exercised together.
 *
 * `npm run test:e2e` starts the BFF and Vite itself; the EHRbase + HAPI stack
 * must already be up, and tests that need it are tagged @stack.
 */
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
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 120_000,
    cwd: import.meta.dirname,
  },
});
