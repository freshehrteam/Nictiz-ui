import { defineConfig } from 'vitest/config';

/**
 * Tests live INSIDE app/ (plan: "Testing"). That is the whole reason this file
 * is nine lines instead of the PoC's thirty — with `tests/` above `app/` the
 * root had to be lifted to the repo, `medblocks-ui` aliased by hand, and the
 * fs boundary widened. None of that is needed here.
 */
export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
  },
});
