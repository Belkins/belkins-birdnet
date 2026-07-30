import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'node:path';
import { rmSync } from 'node:fs';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Optional dev proxy so `npm run dev:real` can reach a backend that serves
  // the legacy PHP API (/avian/...) and the SSE stream (/events) on another
  // origin. Set VITE_PROXY_TARGET=http://host:port in .env.local.
  const target = env.VITE_PROXY_TARGET;

  // A REAL build must not ship fabricated content to a public path. Vite copies
  // public/ wholesale, so the deployed bundle carried public/dev/species-london
  // .json (a SYNTHETIC 47-row fixture) and 15 Nearctic mock PNGs — birds this
  // London garden has never heard — to /collage/dev/ and /collage/mock/ on a
  // wall whose entire claim is that nothing on it is invented. Nothing links
  // them, which is exactly why nobody noticed.
  //
  // A build-time EXCLUSION, never a move: img.ts serves ${BASE}mock/ whenever
  // MOCK is set, and the test suite loads public/dev/species-london.json
  // directly. Both must keep working, so the files stay in public/ and are
  // dropped from the emitted bundle — and only when this is NOT a mock build,
  // because a mock build is the one case that legitimately needs them.
  //
  // It must run in closeBundle and delete from disk: publicDir is copied by Vite
  // OUTSIDE the rollup bundle, so a generateBundle hook cannot see these files
  // at all — it runs, finds nothing, and reports success. (Measured: the first
  // attempt did exactly that and the fixture still shipped.)
  const isMock = env.VITE_MOCK === '1';
  let outDir = 'dist';
  const dropFabricated = {
    name: 'drop-fabricated-assets',
    apply: 'build' as const,
    configResolved(cfg: { build: { outDir: string } }) {
      outDir = cfg.build.outDir;
    },
    closeBundle() {
      if (isMock) return;
      for (const dir of ['dev', 'mock']) {
        rmSync(resolve(__dirname, outDir, dir), { recursive: true, force: true });
      }
      // derived.json is the same class and cost 27 days of a stale console. The
      // committed public/derived.json is a 2026-07-02 fixture (8 species, 188
      // rows). deploy-christina.sh SYMLINKS the live one into place — and any
      // rsync of dist/ over the served directory replaced that symlink with the
      // fixture, so /lab quietly showed a month-old museum. The deploy recipe
      // protects species.json by name and nobody had added this one.
      //
      // Excluding it from the bundle fixes it at the root: the file cannot
      // clobber a symlink it is not in. `npm run dev` is unaffected — the dev
      // server serves public/ directly and never reads dist/.
      rmSync(resolve(__dirname, outDir, 'derived.json'), { force: true });
    },
  };

  return {
    plugins: [react(), dropFabricated],
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
