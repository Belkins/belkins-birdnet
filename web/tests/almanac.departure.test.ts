// DEPARTURES — the logic suite for the Wall's one subtraction.
//
// ─────────────────────────────────────────────────────────────────────────────
// READ THIS FIRST: THIS SUITE IS NOT RUN BY CI.
// .github/workflows/python-app.yml runs pytest only and never runs npm, and
// scripts/repo-guards.sh guard 3 enumerates directories containing `test_*.py`,
// so web/tests/ is invisible to it. Nothing in the repo goes red if this file
// stops passing, or is deleted. That is a known, recorded hole — the repo's own
// guard-3 doctrine exists because an un-enumerated suite silently stopped
// running behind a green badge. Until a `cd web && npm test` line exists in CI
// with a matching guard entry, the discipline is manual:
//
//     cd web && npm test        # before EVERY web/dist rebuild
//
// The thresholds this file pins (14 days, 60 days) and the DST-proof day math
// are editorial claims about a real garden, not tuning knobs. If you change one,
// a test here must change with it — that is the entire point of the file.
// ─────────────────────────────────────────────────────────────────────────────
//
// Zero dependencies: node:test + node:assert/strict + native TypeScript
// type-stripping (needs Node >= 22.18; on an older Node this errors out loudly
// rather than passing vacuously). TZ is pinned to Europe/London by the npm
// script so the DST cases are deterministic on any machine — and because this
// is a London garden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { departuresFor } from '../src/almanac.ts';

type Row = { last_detected: string | null };

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** A stamp for the day before `now`, in the bare fixture form. */
function yesterday(now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The caption for ONE species, obtained the only way the app can obtain it:
 *  through the whole-catalog entry point. Every fixture therefore carries a bird
 *  heard yesterday, because departuresFor refuses to say anything at all about a
 *  catalog whose freshest detection is itself stale — a lone 29-day-old row is a
 *  dead station, not a departure. Asserting the anchor stays silent also keeps
 *  T1's promise honest inside every other test. */
function caption(lastDetected: string | null, now: Date) {
  const anchor: Row = { last_detected: yesterday(now) };
  const subject: Row = { last_detected: lastDetected };
  const board = departuresFor([anchor, subject], now);
  assert.equal(board.get(anchor), undefined, 'a bird heard yesterday must never carry a caption');
  return board.get(subject) ?? null;
}

test('T1 a bird heard yesterday says nothing — the wall stays calm for birds still here', () => {
  // WHY: the museum is a calm surface. A caption on all 47 cards is clutter, not
  // a departure. This fails the moment someone "improves" the feature into an
  // always-on last-heard line.
  const now = new Date(2026, 6, 27);
  assert.equal(caption('2026-07-26 06:12:33', now), null);
});

test('T2 the fortnight threshold IS the editorial claim — 13 days silent, 14 days speaks', () => {
  // WHY: below 14 days the wall would be asserting a departure that is really
  // weather or a quiet week. The number is a claim about the garden, not a
  // tuning knob; moving it must break a test.
  const now = new Date(2026, 6, 27);
  assert.equal(caption('2026-07-14', now), null); // 13 days
  assert.deepEqual(caption('2026-07-13', now), { text: 'not heard in 14 days', band: 'quiet' });
});

test('T3 Common Swift leaving London reads as a season, not a stale day count', () => {
  // WHY: the motivating case. By late October "not heard in 75 days" is
  // arithmetic; "not heard since Aug 2026" is the sentence a gallery label carries.
  assert.deepEqual(caption('2026-08-06 04:41:02', new Date(2026, 9, 20)), {
    text: 'not heard since Aug 2026',
    band: 'away',
  });
});

test('T4 the register switch at 60 days is exact, and only the sentence changes', () => {
  // WHY: an off-by-one here produces "not heard in 60 days" one day and "not
  // heard since May 2026" the next in the wrong order — a card that appears to
  // contradict itself.
  const now = new Date(2026, 6, 27);
  assert.deepEqual(caption('2026-05-29', now), { text: 'not heard in 59 days', band: 'quiet' });
  assert.deepEqual(caption('2026-05-28', now), { text: 'not heard since May 2026', band: 'away' });
});

test('T5 a species never confidently heard says nothing rather than "not heard in NaN days"', () => {
  // WHY: the shipped fixture web/public/species.json literally contains a null
  // row (Hermit Thrush) and catalog.ts coerces '' to null. A NaN caption would
  // reach the wall on day one.
  const now = new Date(2026, 6, 27);
  assert.equal(caption(null, now), null);
  assert.equal(caption('', now), null);
  assert.equal(caption('not a date', now), null);
  const corrupt = caption('2026-13-99', now); // must not throw
  if (corrupt !== null) {
    assert.ok(!/NaN|undefined/.test(corrupt.text), `corrupt stamp leaked: ${corrupt.text}`);
  }
});

test('T6 the prod stamp and the mock stamp count the same day', () => {
  // WHY: rebuild_catalog.py:305 emits "YYYY-MM-DD HH:MM:SS" (space) while the
  // fixture emits bare dates. Any implementation reaching for Date.parse on the
  // raw string works in dev:mock and silently NaNs in prod — the feature would
  // be invisible on the only machine that matters.
  const now = new Date(2026, 6, 27);
  const prod = caption('2026-06-28 23:59:59', now);
  const mock = caption('2026-06-28', now);
  assert.deepEqual(prod, { text: 'not heard in 29 days', band: 'quiet' });
  assert.deepEqual(prod, mock);
});

test('T7 a spring DST shift must not blink the departure line out for a fortnight', () => {
  // WHY: the falsifying case. (now - then) / 86400000 over locally-parsed dates
  // returns 13 for the spring span (a real 14 days minus one hour), so the
  // caption would vanish for a day every spring at exactly the threshold. This
  // asserts the Date.UTC-on-decomposed-local-components approach.
  // BST starts Sun 29 Mar 2026; BST ends Sun 25 Oct 2026.
  assert.deepEqual(caption('2026-03-25', new Date(2026, 3, 8)), {
    text: 'not heard in 14 days',
    band: 'quiet',
  });
  assert.deepEqual(caption('2026-10-20', new Date(2026, 10, 3)), {
    text: 'not heard in 14 days',
    band: 'quiet',
  });
});

test('T8 a clock from the future is refused, not rendered as a negative departure', () => {
  // WHY: a Raspberry Pi has no RTC. After a power cut its clock can land in the
  // past or the future before NTP catches up, and "not heard in -5 days" is
  // exactly the sort of thing that ships.
  assert.equal(caption('2026-08-01', new Date(2026, 6, 27)), null);
});

test('T9 the dev fixture still exercises the silent path', () => {
  // WHY: dev:mock is the ONLY surface where this feature can be looked at
  // offline. If the fixture drifts and loses either the field or its null row,
  // the visual check silently stops covering the never-heard case.
  const rows = JSON.parse(
    readFileSync(new URL('../public/species.json', import.meta.url), 'utf8'),
  ) as Row[];
  assert.ok(rows.length > 0, 'fixture is empty');
  assert.ok(
    rows.every((r) => 'last_detected' in r),
    'fixture lost the field this feature reads',
  );
  assert.ok(
    rows.some((r) => r.last_detected === null),
    'fixture no longer has a never-heard row',
  );
});

test('T10 a wholesale-stale catalog yields ZERO captions, not N', () => {
  // WHY — THE LOAD-BEARING ONE. species.json carries no build timestamp, so the
  // Wall cannot tell "the garden went quiet" from "catalog.service is dead", "the
  // /collage/species.json symlink was clobbered by rsync --delete", or "the
  // 8-species dev fixture is being served in prod". Without this gate the
  // museum's first negative-claim surface turns a dead pipeline into 47
  // fabricated departures, with a 200 all the way down. The honest read of
  // "nothing at all has been heard for a fortnight" is a dead station, never a
  // mass departure.
  const now = new Date(2026, 6, 27);
  const stale: Row[] = [
    { last_detected: '2026-06-01 05:30:00' }, // 56 days
    { last_detected: '2026-05-02' }, // 86 days
    { last_detected: '2026-04-14' }, // 104 days
    { last_detected: null }, // never heard
  ];
  assert.equal(departuresFor(stale, now).size, 0, 'a dead catalog must narrate NOTHING');

  // The gate is not simply "always empty": add one bird heard yesterday and the
  // same three rows all speak.
  const live: Row[] = [{ last_detected: yesterday(now) }, ...stale];
  assert.equal(departuresFor(live, now).size, 3, 'a live catalog must still show its departures');
});

test('T11 the gate opens and closes on the same fortnight the captions use', () => {
  // WHY: two thresholds that drift apart produce a wall that is silent for one
  // day and then shouts — or worse, one that narrates from a catalog it has
  // already judged stale. Freshest = 13 days: alive, so the old rows speak.
  // Freshest = 14 days: the station itself is in doubt, so nothing speaks.
  const now = new Date(2026, 6, 27);
  const old: Row = { last_detected: '2026-01-05' };
  assert.equal(departuresFor([{ last_detected: '2026-07-14' }, old], now).size, 1); // 13 days
  assert.equal(departuresFor([{ last_detected: '2026-07-13' }, old], now).size, 0); // 14 days
});

test('T12 the shipped fixture renders real captions once its own clock is live', () => {
  // WHY: proves the feature against the actual production row shape (not a
  // hand-built literal) and that no caption can contain NaN/undefined/Invalid.
  // `now` is pinned 11 days past the fixture's newest stamp (2026-06-30) so the
  // freshness gate is open — the fixture as of today is itself wholesale stale,
  // which is exactly why dev:mock currently shows no captions at all.
  const rows = JSON.parse(
    readFileSync(new URL('../public/species.json', import.meta.url), 'utf8'),
  ) as Row[];
  const board = departuresFor(rows, new Date(2026, 6, 11));
  assert.ok(board.size > 0, 'no fixture row crossed the fortnight — the fixture drifted');
  assert.ok(board.size < rows.length, 'every single row spoke — the calm-wall contract is broken');
  for (const dep of board.values()) {
    assert.match(dep.text, /^not heard (in \d+ days|since [A-Z][a-z]{2} \d{4})$/, dep.text);
    assert.ok(dep.band === 'quiet' || dep.band === 'away');
  }
});
