import { defineConfig, loadEnv } from 'vite';
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
