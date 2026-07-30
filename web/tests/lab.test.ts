// THE LAB'S CONSOLE GROWTH — logic + doctrine suite for the 2026-07-30 tabs.
//
// Same standing caveat as every suite in this directory: CI runs pytest only,
// so `cd web && npm test` is a manual discipline before every dist rebuild.
//
// Two kinds of test here:
//   1. Pure logic — buildActivityGrid (the day x hour heatmap builder) and the
//      heat ramp. The grid anchors on the SERVER's `today` and steps at local
//      noon (TZ pinned Europe/London by the npm script), so the DST cases are
//      real dates from this garden's own clock-change weekend.
//   2. Source-read doctrine guards (frame.test.ts precedent) — the failure
//      mode is a MISSING thing that regresses silently: the station-door
//      doctrine says the old console and the Services deep-link must stay on
//      a walkable path after the menu entry came out. If someone deletes the
//      escape hatch, this file goes red, nothing else would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import type { LoadHookSync, ResolveHookSync } from 'node:module';

// ── the two-line bundler shim (verbatim from jardine.test.ts) ────────────────
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

const SRC = new URL('../src/', import.meta.url);

interface LabApiShape {
  buildActivityGrid: (a: {
    days: number;
    today: string;
    cells: { date: string; hour: number; n: number }[];
  }) => { dates: string[]; counts: number[][]; max: number; total: number };
  heatColor: (n: number, max: number) => string | null;
  HEAT_RAMP: readonly string[];
  fmtBytes: (b: number) => string;
  fmtAgo: (s: number) => string;
}
const api = (await import(new URL('lab/labApi.ts', SRC).href)) as unknown as LabApiShape;

// ── 1. the grid builder ──────────────────────────────────────────────────────

test('grid: full window, zero-backfilled, anchored on the server day', () => {
  const g = api.buildActivityGrid({
    days: 3,
    today: '2026-07-30',
    cells: [
      { date: '2026-07-30', hour: 6, n: 2 },
      { date: '2026-07-29', hour: 21, n: 1 },
    ],
  });
  assert.deepEqual(g.dates, ['2026-07-28', '2026-07-29', '2026-07-30']);
  assert.equal(g.counts[2][6], 2);
  assert.equal(g.counts[1][21], 1);
  assert.equal(g.counts[0][0], 0); // backfilled, not undefined
  assert.equal(g.max, 2);
  assert.equal(g.total, 3);
});

test('grid: cells outside the window or with nonsense hours are refused, not mis-plotted', () => {
  const g = api.buildActivityGrid({
    days: 2,
    today: '2026-07-30',
    cells: [
      { date: '2026-07-01', hour: 6, n: 50 }, // before the window
      { date: '2026-07-31', hour: 6, n: 50 }, // after the anchor day
      { date: '2026-07-30', hour: 24, n: 50 }, // no 24th hour
      { date: '2026-07-30', hour: -1, n: 50 },
      { date: '2026-07-30', hour: 6, n: 0 }, // zero adds nothing
      { date: '2026-07-30', hour: 7, n: 3 },
    ],
  });
  assert.equal(g.total, 3);
  assert.equal(g.max, 3);
  assert.equal(
    g.counts.flat().reduce((a, b) => a + b, 0),
    3,
  );
});

test('grid: steps cleanly across the spring clock change (BST starts 2026-03-29)', () => {
  const g = api.buildActivityGrid({ days: 3, today: '2026-03-30', cells: [] });
  assert.deepEqual(g.dates, ['2026-03-28', '2026-03-29', '2026-03-30']);
});

test('grid: steps cleanly across the autumn clock change (GMT returns 2026-10-25)', () => {
  const g = api.buildActivityGrid({ days: 3, today: '2026-10-26', cells: [] });
  assert.deepEqual(g.dates, ['2026-10-24', '2026-10-25', '2026-10-26']);
});

// ── 2. the sequential ramp ───────────────────────────────────────────────────

test('heat: zero and empty-window cells stay the panel surface (null), never a colour', () => {
  assert.equal(api.heatColor(0, 10), null);
  assert.equal(api.heatColor(5, 0), null);
  assert.equal(api.heatColor(-1, 10), null);
});

test('heat: quarter steps are monotonic through the ramp, max lands on the accent', () => {
  const max = 100;
  const seen = [25, 50, 75, 100].map((n) => api.heatColor(n, max));
  assert.deepEqual(seen, [...api.HEAT_RAMP]);
  assert.equal(api.heatColor(1, max), api.HEAT_RAMP[0]);
  assert.equal(api.HEAT_RAMP[api.HEAT_RAMP.length - 1], '#8fb7ff'); // --lab-accent
});

// ── 3. formatters refuse to invent ───────────────────────────────────────────

test('formatters: negative and non-finite inputs read as "?", never a fabricated figure', () => {
  assert.equal(api.fmtBytes(-1), '?');
  assert.equal(api.fmtBytes(Number.NaN), '?');
  assert.equal(api.fmtAgo(-5), '?');
  assert.equal(api.fmtBytes(1_200_000), '1.2 MB');
  assert.equal(api.fmtAgo(60 * 60 * 3), '3.0h');
});

// ── 4. doctrine guards (source reads) ────────────────────────────────────────

const services = readFileSync(new URL('lab/Services.tsx', SRC), 'utf8');
const settings = readFileSync(new URL('views/Settings.tsx', SRC), 'utf8');
const lab = readFileSync(new URL('lab/Lab.tsx', SRC), 'utf8');

test('door: the Services tab carries the view=Services deep-link the menu gave up', () => {
  assert.match(services, /\/views\.php\?view=Services/);
});

test('door: the mic-row trap stays written beside the link that inherits it', () => {
  assert.match(services, /birdnet_recording row/);
});

test('door: the old console itself stays in the STATION menu', () => {
  assert.match(settings, /href: '\/index\.php'/);
});

test('tabs: hand-typed and back/forward hashes are both heard', () => {
  assert.match(lab, /addEventListener\('hashchange'/);
});

test('honesty: restart is a two-step arm, never a single click', () => {
  assert.match(services, /confirm restart\?/);
});

test('honesty: a caddy/php-fpm restart is never reported as failure on a dead fetch', () => {
  // Restarting the unit that serves this very page aborts the in-flight
  // response - the catch path fires on SUCCESS. If the special case goes,
  // every successful caddy restart reads "restart failed" forever, and no
  // type-check or render test would notice.
  interface SelfKilling {
    SELF_KILLING_UNITS: RegExp;
  }
  const { SELF_KILLING_UNITS } = api as unknown as SelfKilling;
  assert.ok(SELF_KILLING_UNITS.test('caddy'));
  assert.ok(SELF_KILLING_UNITS.test('php8.4-fpm'));
  assert.ok(SELF_KILLING_UNITS.test('php8.2-fpm'));
  assert.ok(!SELF_KILLING_UNITS.test('birdnet_recording'), 'the recorder is not self-killing');
  assert.ok(!SELF_KILLING_UNITS.test('icecast2'), 'icecast does not carry this page');
  assert.match(services, /SELF_KILLING_UNITS\.test\(unit\)/);
  assert.match(services, /the reply died with it/);
});

test('honesty: journals are keyed by unit, so a slow response cannot wear another unit\'s name', () => {
  // One shared logText string let unit A's late journal render under unit
  // B's row - mislabeled logs one click from the wrong restart (the MUST
  // from the 2026-07-30 review). The write must be keyed by the unit the
  // fetch was issued for, and the read must key on the row's own unit.
  assert.match(services, /setLogs\(\(v\) => \(\{ \.\.\.v, \[unit\]:/);
  assert.match(services, /logs\[unit\]/);
  assert.doesNotMatch(services, /setLogText\(/);
});

test('honesty: an armed restart disarms on a timer, not only on blur (Safari never blurs)', () => {
  assert.match(services, /setTimeout\(\(\) => setArming\(null\)/);
});

test('honesty: leaving the archive tab closes the open row so hidden audio cannot keep playing', () => {
  const archive = readFileSync(new URL('lab/Archive.tsx', SRC), 'utf8');
  assert.match(archive, /if \(!active\) setOpen\(null\);/);
  const lab = readFileSync(new URL('lab/Lab.tsx', SRC), 'utf8');
  assert.match(lab, /<Archive cat=\{cat\} active=\{tab === 'archive'\}/);
});

test('css: .lab-hide outranks every display-setting rule it must beat (declared last)', () => {
  // Equal specificity means source order decides. If .lab-hide is declared
  // before .lab-tabbody (display: grid), a hidden tab body stays VISIBLE and
  // nothing errors - the exact silent failure shipped and caught 2026-07-30.
  const css = readFileSync(new URL('lab/lab.css', SRC), 'utf8');
  const hide = css.lastIndexOf('.lab-hide');
  for (const sel of ['.lab-tabbody', '.lab-grid']) {
    const at = css.indexOf(`${sel} {`);
    assert.ok(at >= 0, `${sel} rule exists`);
    assert.ok(hide > at, `.lab-hide is declared after ${sel}`);
  }
});
