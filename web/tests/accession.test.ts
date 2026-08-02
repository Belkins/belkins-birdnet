// THE ACCESSION MOMENT — every negative case as a unit test, per the law that
// a ceremony must be harder to fire wrongly than to fire at all:
//   · the AUTHORITY is the station-lifetime catalog, never the window roster —
//     a ledger species quiet for an hour is NOT a first detection (the robin
//     test: adversarial review 2026-08-02 caught the first cut firing a full
//     ceremony for Accession No. 2 and stamping the real number on the lie)
//   · a collapsed catalog (empty ledger) proves nothing and must NOT fire —
//     with no ledger EVERY bird looks first-ever, and ceremony spam over a
//     broken endpoint is the calm-empty-museum bug wearing party clothes
//   · a pinned past day must NOT fire (no live state to celebrate)
//   · "ACCESSION No. n" is a claim about the ledger: it renders ONLY when a
//     real number exists; the honest state for a genuine first is pending
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessionCopy, decideAccession, hhmm, msUntilNextHour } from '../src/accession.ts';

const FIRE_OK = { isWindowNew: true, inCatalog: false, catalogNonEmpty: true, dayPinned: false, enabled: true };

test('D1: a genuine first — window-new, absent from a non-empty ledger — fires', () => {
  assert.equal(decideAccession(FIRE_OK), true);
});

test('D2 (the robin): a LEDGER species quiet for the window never fires — presence is the disproof', () => {
  assert.equal(decideAccession({ ...FIRE_OK, inCatalog: true }), false);
});

test('D3: an EMPTY ledger (collapsed catalog fetch) proves nothing and never fires', () => {
  assert.equal(decideAccession({ ...FIRE_OK, catalogNonEmpty: false }), false);
});

test('D4: a PINNED past day never fires', () => {
  assert.equal(decideAccession({ ...FIRE_OK, dayPinned: true }), false);
});

test('D5: the owner’s off switch wins over everything', () => {
  assert.equal(decideAccession({ ...FIRE_OK, enabled: false }), false);
});

test('D6: a repeat within the window (not window-new) never fires', () => {
  assert.equal(decideAccession({ ...FIRE_OK, isWindowNew: false }), false);
});

test('D7: the impossible combination — inCatalog with an "empty" catalog — still never fires', () => {
  assert.equal(decideAccession({ ...FIRE_OK, inCatalog: true, catalogNonEmpty: false }), false);
});

test('C1: a real ledger number renders as ACCESSION No. n — and never as pending', () => {
  const c = accessionCopy('Common Swift', 12, '14:32');
  assert.equal(c.headline, 'ACCESSION No. 12');
  assert.ok(!/pending/i.test(c.headline));
  assert.equal(c.name, 'Common Swift');
  assert.equal(c.sub, 'first heard 14:32');
});

test('C2: no number = pending, and the claim-word "No." must be ABSENT', () => {
  for (const num of [null, undefined, Number.NaN] as const) {
    const c = accessionCopy('Tree Pipit', num as number | null, '06:05');
    assert.equal(c.headline, 'ACCESSION — pending');
    assert.ok(!/No\./.test(c.headline), `a ${String(num)} ledger value must never claim a number`);
  }
});

test('H1: msUntilNextHour reaches exactly the top of the next hour', () => {
  const at = new Date(2026, 7, 2, 14, 32, 10, 0);
  assert.equal(msUntilNextHour(at), (27 * 60 + 50) * 1000);
});

test('H2: exactly on the hour holds the FULL hour, and the result is never ≤0', () => {
  const onTheHour = new Date(2026, 7, 2, 14, 0, 0, 0);
  assert.equal(msUntilNextHour(onTheHour), 3_600_000);
  const lastMs = new Date(2026, 7, 2, 14, 59, 59, 999);
  assert.equal(msUntilNextHour(lastMs), 1);
});

test('H3: hhmm zero-pads both fields', () => {
  assert.equal(hhmm(new Date(2026, 7, 2, 6, 5, 0)), '06:05');
  assert.equal(hhmm(new Date(2026, 7, 2, 23, 59, 0)), '23:59');
});
