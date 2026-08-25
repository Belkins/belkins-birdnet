// The wall's composition knobs: ?seed= / ?air= / ?herocap= parsing, the
// seeded pose dice, and the safeBox air law.
//
// The seed exists for exactly one promise: APPLY paints the composition the
// panel previewed. That promise dies silently — swap the hash back to
// Math.random(), drop the digits-only guard, half-apply an inset — and every
// suite stays green while the wall paints strangers again. Each clause is
// pinned here as a fact.

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
  // profile.ts reads import.meta.env for its VITE_* fallbacks; there is no
  // bundler here, so it becomes an empty object (query params still win).
  if (url.includes('/src/profile.ts') || url.endsWith('/src/config.ts')) {
    return {
      ...r,
      source: String(r.source).replaceAll('import.meta.env', '({})'),
      format: 'module-typescript',
    };
  }
  return r;
};
registerHooks({ resolve, load });

type ProfileMod = typeof import('../src/profile');
type FlightMod = typeof import('../src/flight');

/** A freshly-frozen PROFILE for one query string (cache-busted import). */
async function profileFor(search: string): Promise<ProfileMod> {
  (globalThis as Record<string, unknown>).location = { search };
  return (await import(`../src/profile.ts?t=${Math.random()}`)) as ProfileMod;
}

/** Source with comments stripped (the self-matching-grep guard from
 *  catalog.test.ts — prose quoting a pattern must never satisfy it). */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── rollPose honours a pinned seed ──────────────────────────────────────────
// DECLARED FIRST ON PURPOSE: flight.ts imports './profile' BARE, and the bare
// module is frozen by whichever location.search is live at its first load.
// This test performs that first load under ?seed=777; the parsing tests below
// use cache-busted profile imports and are untouched by the frozen bare copy.

test('a pinned seed makes rollPose deterministic and hash-driven', async () => {
  (globalThis as Record<string, unknown>).location = { search: '?seed=777' };
  const flight = (await import('../src/flight.ts')) as FlightMod;
  const { rollPose, seededRoll, FLY_PROB, FLIGHT_ASPECT, canFly } = flight;

  const flyers = Object.keys(FLIGHT_ASPECT);
  assert.ok(flyers.length >= 5, 'the flight roster exists');

  for (const slug of flyers) {
    const first = rollPose(slug);
    for (let i = 0; i < 20; i++) {
      assert.equal(rollPose(slug), first, `${slug}: twenty rolls, one answer`);
    }
    const expected = seededRoll(777, slug) < FLY_PROB ? 2 : 1;
    assert.equal(first, expected, `${slug}: the roll IS the hash`);
  }
  assert.ok(!canFly('no-such-bird'));
  assert.equal(rollPose('no-such-bird'), 1, 'a non-flyer never rolls flight');
});

test('seededRoll is pure, order-free, seed-sensitive and in [0,1)', async () => {
  const { seededRoll } = (await import(`../src/flight.ts?t=${Math.random()}`)) as FlightMod;
  const slugs = ['erithacus-rubecula', 'psittacula-krameri', 'apus-apus', 'pica-pica'];
  // Stable: the same (seed, slug) always lands on the same value — and the
  // value is a pure function of the pair, so call order cannot matter.
  const forward = slugs.map((s) => seededRoll(9001, s));
  const backward = [...slugs].reverse().map((s) => seededRoll(9001, s));
  assert.deepEqual(forward, backward.reverse());
  assert.deepEqual(slugs.map((s) => seededRoll(9001, s)), forward);
  // Seed-sensitive: neighbouring seeds must not reproduce the whole vector
  // (a finisher-less hash would make seed and seed+1 near-identical).
  const shifted = slugs.map((s) => seededRoll(9002, s));
  assert.notDeepEqual(forward, shifted);
  // Range: every draw is a probability.
  for (const seed of [1, 777, 2147483647]) {
    for (const s of slugs) {
      const v = seededRoll(seed, s);
      assert.ok(v >= 0 && v < 1, `${seed}/${s} -> ${v}`);
    }
  }
});

// ── ?seed= parsing: the daemon's "0 = not baked" contract, mirrored ─────────

test('?seed= accepts only a bare positive int31 — 0 and disguises stay null', async () => {
  assert.equal((await profileFor('?seed=1')).PROFILE.seed, 1);
  assert.equal((await profileFor('?seed=2147483647')).PROFILE.seed, 2147483647);
  for (const bad of ['0', '-1', '2147483648', '1e3', '0x10', '1.5', 'abc', '']) {
    assert.equal((await profileFor(`?seed=${bad}`)).PROFILE.seed, null, `seed=${bad}`);
  }
  assert.equal((await profileFor('?')).PROFILE.seed, null, 'absent = free roll');
});

// ── the raised superset ceilings the panel/PHP/daemon rely on ───────────────

test('?herocap= superset admits the raised 0.6 ceiling, no further', async () => {
  assert.equal((await profileFor('?herocap=0.6')).PROFILE.heroCap, 0.6);
  assert.equal((await profileFor('?herocap=0.601')).PROFILE.heroCap, null);
});

test('?air= is (0, 1]: 1 in, 0 and overshoot out, absent null', async () => {
  assert.equal((await profileFor('?air=1')).PROFILE.air, 1);
  assert.equal((await profileFor('?air=0.55')).PROFILE.air, 0.55);
  assert.equal((await profileFor('?air=0')).PROFILE.air, null);
  assert.equal((await profileFor('?air=1.001')).PROFILE.air, null);
  assert.equal((await profileFor('?')).PROFILE.air, null);
});

// ── safeBox: the air law, pinned in source (no DOM in this runner) ──────────
// CollageEngine needs a real canvas, so this reads the source — the
// frame.test.ts doctrine-guard pattern. Weaker than execution, but it pins
// the two clauses that die silently: absent = exactly 1 (the public museum
// unchanged byte-for-byte), and ALL THREE insets scale — dropping `* air`
// from one of them half-applies the knob with nothing red anywhere.

test('safeBox scales every inset by air, and absent means exactly 1', () => {
  const src = stripComments(
    readFileSync(new URL('../src/collage.ts', import.meta.url), 'utf8'),
  );
  assert.match(src, /const air = PROFILE\.air \?\? 1;/);
  assert.match(src, /const mx = Math\.max\(24, W \* 0\.05\) \* air/);
  assert.match(src, /const mt = Math\.max\(96, H \* 0\.2\) \* air/);
  assert.match(src, /const mb = Math\.max\(56, H \* 0\.12\) \* air/);
});
