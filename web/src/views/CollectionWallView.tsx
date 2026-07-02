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
import { currentSeasonFacts, anniversariesFor } from '../almanac';
import type { CatalogSpecies } from '../catalog';
import { fetchCatalog } from '../catalog';
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

/** Catalogue order: earliest first_confident first (ISO strings sort
 *  chronologically), undated species last, ties broken by common name. */
function catalogOrder(a: CatalogSpecies, b: CatalogSpecies): number {
  const af = a.first_confident;
  const bf = b.first_confident;
  if (af && bf) {
    if (af !== bf) return af < bf ? -1 : 1;
  } else if (af) {
    return -1;
  } else if (bf) {
    return 1;
  }
  return (a.com_name || a.sci_name).localeCompare(b.com_name || b.sci_name);
}

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
            return (
              <div className="acard wall-card" key={s.sci_name || s.com_name}>
                {/* Permanent accession No. + first-seen date on the left; the
                    rarity band + all-time call tally on the right. */}
                <div className="wall-h">
                  <span className="wall-cat">
                    <span className="acard-no">No. {no == null ? '—' : String(no).padStart(3, '0')}</span>
                    <span className="wall-seen">first seen {firstSeenLabel(s.first_confident)}</span>
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
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
