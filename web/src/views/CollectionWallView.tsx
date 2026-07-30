// COLLECTION WALL — the life list. A calm, ALL-TIME wall of specimen plates,
// one per species ever heard, read from the catalog's species.json (NOT the
// live engine roster). It accretes over time and works day-one: eight species
// is already a real wall. Aesthetic = "collection, not streaks" — no badges,
// no streaks, no leaderboard framing; just the quiet accumulation of a life.
//
// Two orderings the viewer can pick between: FIRST SEEN (the default — the wall
// as a chronological life list, each plate carrying a permanent accession No.)
// and RAREST (local scarcity — the seldom-heard visitors surfaced first). The
// accession No. is bound to first-appearance and stays fixed across sorts, so a
// rarity sort reorders the plates without renumbering them.
//
// Reuses the Atlas specimen-plate pattern via the shared <BirdThumb>, so every
// illustrated species shows its transparent cutout and un-illustrated ones show
// the bird silhouette — never a flat gray letter disc. Fetches its own data on
// mount (the all-time catalog, independent of the live engine roster).
import { useEffect, useState } from 'react';
import { currentSeasonFacts, anniversariesFor, departuresFor } from '../almanac';
import type { CatalogSpecies } from '../catalog';
import { fetchCatalog, catalogOrder } from '../catalog';
import {
  counterpointFor,
  fetchJardine,
  firstSentence,
  speciesBySci,
  type JardineSpecies,
} from '../jardine';
import { BirdThumb } from '../components/BirdThumb';
import './CollectionWallView.css';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type SortMode = 'first' | 'rarity';

/** "first seen" caption: a calm Month-Year (uppercased by the CSS), an em dash
 *  for the undated long tail (species heard but never confidently first-dated). */
function firstSeenLabel(iso: string | null): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${m[1]}` : m[1];
}

/** Anniversary vitrine date: the leading `YYYY-MM-DD` of a first_confident
 *  stamp as "first heard Mon D, YYYY" (same MONTHS as the plate captions). */
function annivDateLine(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `first heard ${month} ${Number(m[3])}, ${m[1]}` : `first heard ${m[1]}`;
}

// catalogOrder() MOVED to catalog.ts — see the note there. Its three-branch
// null handling is the whole claim of this wall's heading, and it needed to be
// somewhere `node --test` can call it.

/** Local scarcity for the life-list wall: the all-time tally of times a species
 *  has ever been heard here. Fewer = rarer. (The bird popup uses a per-day rate
 *  for its "how often lately" read; the wall is an all-time collection, so the
 *  absolute tally is the truer "rare find" signal — a bird heard once reads as
 *  rare even on the day it first appears.) Thresholds are tuned for a young
 *  window and are easy to retune as a collection grows. */
function rarityBand(n: number): string {
  if (n <= 0) return '—';
  if (n <= 1) return 'rare';
  if (n <= 5) return 'occasional';
  if (n <= 40) return 'regular';
  return 'common';
}

/** Rarest first: fewest total detections, ties broken by the stable
 *  first-appearance order. */
function rarityOrder(a: CatalogSpecies, b: CatalogSpecies): number {
  const na = a.detection_count || 0;
  const nb = b.detection_count || 0;
  if (na !== nb) return na - nb;
  return catalogOrder(a, b);
}

export function CollectionWallView() {
  // null = still loading; [] = loaded but empty (day zero) or fetch failed.
  const [species, setSpecies] = useState<CatalogSpecies[] | null>(null);
  const [sort, setSort] = useState<SortMode>('first');

  // THE 1838 COUNTERPOINT on the wall. Session-memoised and never-throwing, so
  // an absent corpus leaves every card exactly as it was. Scanning the wall is
  // how most people meet this collection; before this, the library's whole
  // argument was reachable only by opening a separate tab.
  const [jard, setJard] = useState<Map<string, JardineSpecies>>(new Map());
  useEffect(() => {
    let live = true;
    fetchJardine()
      .then((d) => {
        if (live) setJard(speciesBySci(d));
      })
      .catch(() => {
        /* the wall simply stays as it was */
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    fetchCatalog()
      .then((list) => {
        if (alive) setSpecies(list);
      })
      .catch(() => {
        // fetchCatalog already swallows errors → [], but stay defensive.
        if (alive) setSpecies([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const hasBirds = species !== null && species.length > 0;

  // Almanac dateline + anniversary vitrine — pure facts over the catalog the
  // wall already fetched (zero extra plumbing); null renders nothing.
  const now = new Date();
  const almanac = species ? currentSeasonFacts(species, now) : null;
  const anniv = species ? anniversariesFor(species, now) : null;
  // Departures — the one caption on this wall that can APPEAR rather than
  // accrue. Computed for the whole catalog in one pass because the gate that
  // keeps a dead catalog from narrating 47 fabricated departures is a fact
  // about the collection, not about any one bird (see almanac.departuresFor).
  // Empty for every bird still being heard, so a present garden stays calm.
  const departures = species ? departuresFor(species, now) : null;

  // Use the PERMANENT accession No. the nightly build pins into species.json when
  // present; fall back to a client-side first-appearance derivation for old builds
  // that predate the pin. Either way, reorder the plates by the selected sort — so
  // a rarity sort never renumbers.
  const pinnedMode = species != null && species.some((s) => s.accession !== undefined);
  const numbered: Array<{ s: CatalogSpecies; no: number | null }> = species
    ? pinnedMode
      ? [...species].sort(catalogOrder).map((s) => ({ s, no: s.accession ?? null }))
      : [...species].sort(catalogOrder).map((s, i) => ({ s, no: i + 1 }))
    : [];
  const ordered = sort === 'rarity' ? [...numbered].sort((x, y) => rarityOrder(x.s, y.s)) : numbered;

  return (
    <div className="view">
      <div className="view-mast">
        <div className="eyebrow">all time</div>
        <div className="t">THE WALL</div>
        {/* Explicit sort context so the catalogue number reads as a permanent
            first-appearance accession, never a call-count rank. */}
        <div className="wall-note">
          {sort === 'rarity' ? 'rarest at your window first' : 'in order of first appearance'}
        </div>
        {/* Almanac dateline — only when this month has a true "first heard". */}
        {almanac && (
          <div className="wall-almanac">
            {almanac.count === 1
              ? `In ${almanac.monthName}, one was first heard here — the ${almanac.soleName}.`
              : `In ${almanac.monthName}, ${almanac.count} of the collection were first heard here.`}
          </div>
        )}
        {hasBirds && (
          <div className="wall-sort" role="group" aria-label="Sort the wall">
            <button
              type="button"
              className="wall-sort-b"
              aria-pressed={sort === 'first'}
              onClick={() => setSort('first')}
            >
              first seen
            </button>
            <button
              type="button"
              className="wall-sort-b"
              aria-pressed={sort === 'rarity'}
              onClick={() => setSort('rarity')}
            >
              rarest
            </button>
          </div>
        )}
      </div>

      {/* "On this day" vitrine — only when a first-heard anniversary is
          literally true (silent the whole first year). */}
      {anniv && (
        <div className="wall-anniv" role="note">
          <span className="wall-anniv-k">on this day</span>
          <span className="wall-anniv-t">
            {anniv.yearsAgo === 1 ? 'One year ago today' : `${anniv.yearsAgo} years ago today`} — the
            first {anniv.com}.
          </span>
          <span className="wall-anniv-d">{annivDateLine(anniv.firstConfident)}</span>
        </div>
      )}

      {species === null ? (
        // Quiet loading state — never a spinner, never an error.
        <div className="wall-loading">
          <div className="word">Gathering the collection…</div>
        </div>
      ) : species.length === 0 ? (
        // Day zero (or an unreachable catalog): a calm gallery label.
        <div className="wall-empty">
          <div className="word">The wall is waiting for its first bird.</div>
          <div className="rule" />
          <div className="cap">Every species ever heard will earn a plate here.</div>
        </div>
      ) : (
        <div className="wall-grid">
          {ordered.map(({ s, no }) => {
            const band = rarityBand(s.detection_count);
            const gone = departures?.get(s);
            return (
              <div className="acard wall-card" key={s.sci_name || s.com_name}>
                {/* Permanent accession No. + first-seen date on the left; the
                    rarity band + all-time call tally on the right. */}
                <div className="wall-h">
                  <span className="wall-cat">
                    <span className="acard-no">No. {no == null ? '—' : String(no).padStart(3, '0')}</span>
                    <span className="wall-seen">first seen {firstSeenLabel(s.first_confident)}</span>
                    {gone && (
                      <span className="wall-gone" data-gone={gone.band}>
                        {gone.text}
                      </span>
                    )}
                  </span>
                  <span className="wall-tally">
                    <span className="wall-rarity" data-band={band}>{band}</span>
                    <span className="wall-calls">
                      <b>{s.detection_count.toLocaleString()}</b>{' '}
                      {s.detection_count === 1 ? 'call' : 'calls'}
                    </span>
                  </span>
                </div>
                <BirdThumb slug={s.slug} sci={s.sci_name} com={s.com_name} art={s.art_status} />
                <div className="acard-cn">{s.com_name || s.sci_name}</div>
                <div className="acard-ln">{s.sci_name}</div>
                {(() => {
                  const cp = counterpointFor(jard.get(s.sci_name));
                  if (!cp) return null;
                  return cp.kind === 'voice' ? (
                    <div className="wall-jard">
                      <span className="wall-jard-t">{firstSentence(cp.passage.text)}</span>
                      <span className="wall-jard-c">{cp.passage.speaker}, 1838</span>
                    </div>
                  ) : (
                    <div className="wall-jard">
                      <span className="wall-jard-c">the library never described its voice</span>
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
