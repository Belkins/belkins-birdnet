// THE ACCESSION MOMENT — the museum's quiet first-detection ceremony.
//
// When a species the station's LEDGER has never held lands live, a small card
// joins the tombstone register (the LiveCounter's corner): accession line over
// the bird's name over "first heard HH:MM". Held until the top of the hour,
// then gone — a label hung while the paint dries, not a popup. No confetti:
// the wall's restraint IS the signal (POPUP-BUDGET doctrine).
//
// THE AUTHORITY IS THE CATALOG, NEVER THE ENGINE'S ROSTER. The engine's
// roster is WINDOW-scoped (cleared and re-seeded on every window/day switch),
// so "not in the roster" only means "quiet within the current filter window"
// — the first cut of this feature fired a full ceremony for a European Robin
// with Accession No. 2 in the ledger, then stamped that very number on the
// false card (adversarial review, 2026-08-02). The catalog (species.json) is
// the station-lifetime record: a species PRESENT there has been heard before,
// by definition — its presence is the disproof, not an embellishment.
//
// Everything decidable lives HERE as pure functions so every negative case is
// a unit test, not a hope.

export interface AccessionFire {
  /** The engine's window-scoped "not currently in roster" signal — a cheap
   *  PRE-FILTER only, never the verdict. */
  isWindowNew: boolean;
  /** Is the species already in the station-lifetime catalog? Presence = it
   *  has been heard before = NO ceremony, whatever the window says. */
  inCatalog: boolean;
  /** A catalog that collapsed to [] (fetch failure, broken endpoint) can
   *  prove nothing — with no ledger, EVERY bird would look first-ever, and
   *  ceremony spam over a broken endpoint is the calm-empty-museum bug
   *  wearing party clothes. Empty ledger = silence. */
  catalogNonEmpty: boolean;
  /** A pinned past day never fires (it has no live state to celebrate). */
  dayPinned: boolean;
  /** The owner's off switch (settings.accessionCard, toggle in Settings). */
  enabled: boolean;
}

/** THE fire decision — called at exactly one seam (App's onAccession). */
export function decideAccession(f: AccessionFire): boolean {
  return f.enabled && f.isWindowNew && f.catalogNonEmpty && !f.inCatalog && !f.dayPinned;
}

export interface AccessionCopy {
  headline: string;
  name: string;
  sub: string;
}

/** The card's copy, bound to its predicate: "ACCESSION No. n" appears ONLY
 *  when the ledger actually holds a number for this species. A genuine
 *  first-ever bird CANNOT have one yet (a pinned number is proof it was heard
 *  before — see the authority note above), so the live card always renders
 *  the honest "pending" and the nightly build does the numbering. The num
 *  parameter stays so the claim-binding is enforced wherever this copy is
 *  ever reused. */
export function accessionCopy(com: string, num: number | null | undefined, firstHeardHHMM: string): AccessionCopy {
  const hasNum = typeof num === 'number' && Number.isFinite(num);
  return {
    headline: hasNum ? `ACCESSION No. ${num}` : 'ACCESSION — pending',
    name: com,
    sub: `first heard ${firstHeardHHMM}`,
  };
}

/** "Held for the remainder of the hour": ms from `now` to the top of the next
 *  hour. Never returns ≤0 (a card must always get at least a moment). */
export function msUntilNextHour(now: Date): number {
  const next = new Date(now.getTime());
  next.setMinutes(60, 0, 0);
  return Math.max(1, next.getTime() - now.getTime());
}

/** 24h wall-clock HH:MM for the card's "first heard" line. The DETECTION's
 *  own timestamp (the event frame's iso8601), never the browser's receipt
 *  clock — SSE replay delivers minutes-old frames by design. */
export function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
