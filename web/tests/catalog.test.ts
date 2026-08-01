// The catalog fetch memo, and the boot seed that feeds it.
//
// Both of these are PERFORMANCE changes to code whose failure mode is silent:
// a memo that caches too long makes a day-long kiosk stop learning new species,
// and a memo that caches a failure turns one dropped request into a minute of
// the museum printing confident measured zeroes. Neither shows up as an error,
// so neither can be left to review.
//
// Counting fetches is the only way to state "six calls, one request" as a fact.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import type { LoadHookSync, ResolveHookSync } from 'node:module';
import { test } from 'node:test';

// ── the two-line bundler shim (verbatim from jardine.test.ts / lab.test.ts) ──
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

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

/** Source with comments stripped.
 *
 *  Load-bearing, and learned the hard way one commit before this file existed:
 *  the first draft of the boot assertion below did `doesNotMatch(app, /await
 *  engine.setWindow\(s0.windowHours\)/)` against the RAW source, and it failed —
 *  because the comment explaining the removal QUOTES the removed line. A guard
 *  that reads prose describing the absence of a thing as the presence of it is
 *  the self-matching-grep sin repo-guards.sh records at guards 6, 7 and 10. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

async function loadCatalog(fetchImpl: typeof fetch) {
  const g = globalThis as Record<string, unknown>;
  g.fetch = fetchImpl;
  // Cache-bust so each test gets a module with a FRESH memo slot — otherwise
  // test two would be reading test one's cached promise and proving nothing.
  return (await import(`../src/catalog.ts?t=${Math.random()}`)) as {
    fetchCatalogOrNull: () => Promise<unknown[] | null>;
  };
}

function counter(body: unknown, ok = true) {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    return {
      ok,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

test('memo: concurrent callers share ONE request, not one each', async () => {
  const c = counter([{ sci_name: 'Turdus merula', com_name: 'Blackbird' }]);
  const mod = await loadCatalog(c.impl);
  await Promise.all(Array.from({ length: 6 }, () => mod.fetchCatalogOrNull()));
  assert.equal(
    c.calls(),
    1,
    'six callers on one paint must issue one request — this is the boot storm the memo exists for',
  );
});

test('memo: a FAILURE is never cached — a dropped request must not blind the museum for a minute', async () => {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    if (calls === 1) throw new Error('network down');
    return { ok: true, json: async () => [{ sci_name: 'Turdus merula', com_name: 'Blackbird' }] } as unknown as Response;
  }) as unknown as typeof fetch;

  const mod = await loadCatalog(impl);
  assert.equal(await mod.fetchCatalogOrNull(), null, 'a failed fetch reads as "could not read", not as empty');
  const second = await mod.fetchCatalogOrNull();
  assert.equal(calls, 2, 'the retry must reach the network — caching null would print measured zeroes for 60s');
  assert.ok(Array.isArray(second) && second.length === 1, 'and the retry must succeed normally');
});

test('memo: a non-array 200 is a failure wearing a 200, and is not cached either', async () => {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    // Caddy's php try_files answers 200 text/html for any missing path
    return { ok: true, json: async () => '<!doctype html>' } as unknown as Response;
  }) as unknown as typeof fetch;

  const mod = await loadCatalog(impl);
  assert.equal(await mod.fetchCatalogOrNull(), null);
  await mod.fetchCatalogOrNull();
  assert.equal(calls, 2, 'an HTML body is not an empty catalog and must not be memoized as one');
});

test('memo: bounded, so a kiosk left up for days still sees the nightly rebuild', () => {
  const src = read('../src/catalog.ts');
  const ttl = /const CATALOG_TTL_MS = ([\d_]+)/.exec(src);
  assert.ok(ttl, 'CATALOG_TTL_MS is gone — an unbounded memo pins ?frame=1 to the catalog it booted with');
  const ms = Number(ttl[1].replace(/_/g, ''));
  assert.ok(
    ms > 0 && ms <= 5 * 60_000,
    `CATALOG_TTL_MS is ${ms}ms; species.json is rebuilt nightly and the frame runs for days, so this must stay short`,
  );
});

// ── the boot seed ───────────────────────────────────────────────────────────
// A source assertion, and weaker than a behavioural one — there is no DOM in
// this runner. It is here because the double-seed regressed once already by
// landing in two halves across two sessions, and the symptom (two snapshot
// fetches and two image sweeps per load) is invisible unless someone counts.

test('boot: the collage is seeded ONCE, with the persisted window', () => {
  const app = stripComments(read('../src/App.tsx'));
  assert.match(
    app,
    /engine\.start\(s0\.windowHours\)/,
    'App no longer passes the persisted window to start() — every visitor who has tapped 1H/12H/7D/ALL pays two snapshot fetches and two full image sweeps on every load',
  );
  assert.doesNotMatch(
    app,
    /await engine\.setWindow\(s0\.windowHours\)/,
    'the boot re-seed is back alongside start(hours) — that is the double sweep, restored',
  );
});

test('boot: start() still drops its snapshot if a setDay overtook it', () => {
  const collage = read('../src/collage.ts');
  assert.match(
    collage,
    /const seq = \+\+this\.seedSeq/,
    'start() no longer claims a seed sequence',
  );
  assert.match(
    collage,
    /if \(seq === this\.seedSeq\) this\.seed\(snapshot\)/,
    'the boot snapshot no longer checks its sequence before painting — a scrubber-pinned day would be replaced by live data. This check is what made the removed `engine.day === null` guard redundant, so it is now load-bearing for that too.',
  );
});
