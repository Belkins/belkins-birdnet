// COLLECTION WALL — the life list. A calm, ALL-TIME wall of specimen plates,
// one per species ever heard, read from the catalog's species.json (NOT the
// live engine roster). It accretes over time and works day-one: eight species
// is already a real wall. Aesthetic = "collection, not streaks" — no badges,
// no streaks, no leaderboard framing; just the quiet accumulation of a life.
//
// Reuses the Atlas specimen-plate pattern via the shared <BirdThumb>, so every
// illustrated species shows its transparent cutout and un-illustrated ones show
// the bird silhouette — never a flat gray letter disc. Fetches its own data on
// mount (the all-time catalog, independent of the live engine roster).
import { useEffect, useState } from 'react';
import type { CatalogSpecies } from '../catalog';
import { fetchCatalog } from '../catalog';
import { BirdThumb } from '../components/BirdThumb';
import './CollectionWallView.css';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "first seen" caption: a calm Month-Year (uppercased by the CSS), an em dash
 *  for the undated long tail (species heard but never confidently first-dated). */
function firstSeenLabel(iso: string | null): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${m[1]}` : m[1];
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

export function CollectionWallView() {
  // null = still loading; [] = loaded but empty (day zero) or fetch failed.
  const [species, setSpecies] = useState<CatalogSpecies[] | null>(null);

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

  return (
    <div className="view">
      <div className="view-mast">
        <div className="eyebrow">all time</div>
        <div className="t">THE WALL</div>
        {/* Explicit sort context so the catalogue number reads as chronological
            first-appearance order, never a call-count rank. */}
        <div className="wall-note">in order of first appearance</div>
      </div>

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
          {[...species].sort(catalogOrder).map((s, i) => (
            <div className="acard wall-card" key={s.sci_name || s.com_name}>
              {/* Catalogue number is bound to its "first seen" date, so the
                  number is unmistakably first-appearance order; the call tally
                  is a separate value on the right. Number and value agree. */}
              <div className="wall-h">
                <span className="wall-cat">
                  <span className="acard-no">No. {String(i + 1).padStart(3, '0')}</span>
                  <span className="wall-seen">first seen {firstSeenLabel(s.first_confident)}</span>
                </span>
                <span className="wall-tally">
                  <b>{s.detection_count.toLocaleString()}</b>{' '}
                  {s.detection_count === 1 ? 'call' : 'calls'}
                </span>
              </div>
              <BirdThumb slug={s.slug} sci={s.sci_name} com={s.com_name} />
              <div className="acard-cn">{s.com_name || s.sci_name}</div>
              <div className="acard-ln">{s.sci_name}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
