import { defineConfig } from 'vite';

// Overridable so a git worktree can run its own dev pair next to the main
// checkout's (which holds the default 5173/3001) instead of silently being
// proxied to the other checkout's BFF.
const VITE_PORT = Number(process.env.VITE_PORT ?? 5173);
const BFF_URL = process.env.BFF_URL ?? 'http://localhost:3001';

export default defineConfig({
  server: {
    port: VITE_PORT,
    // Without this, a taken port silently bumps to the next one and the
    // dev pair splits across checkouts — exactly the mixup the overrides
    // above exist to prevent.
    strictPort: true,
    proxy: {
      // BFF injects the EHRbase Bearer token and solves CORS; see server/index.ts
      '/api': {
        target: BFF_URL,
        changeOrigin: true,
      },
    },
  },
});
