import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Optional dev proxy so `npm run dev:real` can reach a backend that serves
  // the legacy PHP API (/avian/...) and the SSE stream (/events) on another
  // origin. Set VITE_PROXY_TARGET=http://host:port in .env.local.
  const target = env.VITE_PROXY_TARGET;

  return {
    plugins: [react()],
    build: {
      // Multi-page: the museum SPA (index) PLUS the two COMPANION surfaces that
      // live off the sacred frame — /lab (the data-dense nerd console) and /recap
      // (the weekly illustrated sheet). Each is its own static HTML entry; they
      // reuse the same JSON/SSE endpoints and add no backend. Emitted alongside
      // index.html into dist/ so the existing static host serves them as-is.
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html'),
          lab: resolve(__dirname, 'lab.html'),
          recap: resolve(__dirname, 'recap.html'),
          play: resolve(__dirname, 'play.html'),
          wrapped: resolve(__dirname, 'wrapped.html'),
        },
      },
    },
    server: target
      ? {
          proxy: {
            '/avian': { target, changeOrigin: true },
            '/events': { target, changeOrigin: true, ws: false },
          },
        }
      : undefined,
  };
});
