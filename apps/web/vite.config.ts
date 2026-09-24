import react from '@vitejs/plugin-react-swc';
import type { ProxyOptions } from 'vite';
import { defineConfig } from 'vitest/config';

// The core Worker (apps/core, `wrangler dev`) listens here during development.
const CORE = 'http://localhost:8787';

/**
 * Core only accepts a changing request from its own origin (CSRF check), and the browser
 * sends Vite's (http://localhost:5173). Proxied requests therefore present core's origin,
 * so saving, adding and signing in work in hot-reload development too.
 */
const toCore: ProxyOptions = {
  target: CORE,
  changeOrigin: true,
  headers: { origin: CORE },
};

export default defineConfig({
  plugins: [react()],
  server: {
    // Anchored patterns so that e.g. `/docs` is not mistaken for a delivery link (`/d?t=…`).
    proxy: {
      '^/api/': toCore,
      '^/auth/': toCore,
      '^/mcp': toCore,
      '^/d(?:[/?]|$)': toCore,
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    restoreMocks: true,
  },
});
