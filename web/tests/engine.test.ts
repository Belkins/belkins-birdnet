// The Engine easter egg's two load-bearing branches.
//
// Both fail SILENTLY when dropped: birdImageUrl falls through to
// cutout.php?sci=Engine, which the API refuses with a 400 — every surface
// hangs a broken image where the aeroplane should drift — and aspect() falls
// to the 1.4 bird default, squishing the plane's wings into a bird-shaped
// box. Neither shows up as an error, so neither can be left to review.

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { LoadHookSync, ResolveHookSync } from 'node:module';
import { test } from 'node:test';

// ── the bundler shim (verbatim from catalog.test.ts / jardine.test.ts), plus
//    an .svg loader: Vite serves asset imports as URL strings, node cannot —
//    the shim answers with a marker string the assertions can recognise. ──
const resolve: ResolveHookSync = (spec, ctx, next) => {
  if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) {
    try {
      return next(`${spec}.ts`, ctx);
    } catch {
      /* not a .ts sibling — fall through to Node's own resolution */
    }
  }
  return next(spec, ctx);
};
const load: LoadHookSync = (url, ctx, next) => {
  if (url.endsWith('.svg')) {
    return {
      source: "export default 'bundled-engine-plane-url'",
      format: 'module',
      shortCircuit: true,
    };
  }
  const r = next(url, ctx);
  if (url.endsWith('/src/config.ts')) {
    return {
      ...r,
      source: String(r.source).replaceAll('import.meta.env', '({})'),
      format: 'module-typescript',
    };
  }
  return r;
};
registerHooks({ resolve, load });

const { birdImageUrl } = await import('../src/img.ts');
const { aspect } = await import('../src/data.ts');

test('engine resolves to the bundled aeroplane art in either pose', () => {
  assert.equal(birdImageUrl('engine', 'Engine', 1), 'bundled-engine-plane-url');
  assert.equal(birdImageUrl('engine', 'Engine', 2), 'bundled-engine-plane-url');
});

test('a real bird still resolves to cutout.php with its pose', () => {
  const url = birdImageUrl('erithacus-rubecula', 'Erithacus rubecula', 2);
  assert.ok(url, 'a real bird must resolve to a URL');
  assert.match(url!, /cutout\.php\?sci=Erithacus%20rubecula&pose=2$/);
});

test('the engine tile box takes the plane aspect, birds keep the default', () => {
  // aspect() is keyed by SCIENTIFIC name (slugified inside) — 'Engine' is both.
  assert.equal(aspect('Engine'), 2.0);
  // DIMS is unloaded here, so an unknown bird proves the fallback — and that
  // isEngine() is not answering true for everything (the inverse mutation).
  assert.equal(aspect('Turdus merula'), 1.4);
});
