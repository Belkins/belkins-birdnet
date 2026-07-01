// COLLECTION WALL — the life list. A calm, ALL-TIME wall of specimen plates,
// one per species ever heard, read from the catalog's species.json (NOT the
// live engine roster). It accretes over time and works day-one: eight species
// is already a real wall. Aesthetic = "collection, not streaks" — no badges,
// no streaks, no leaderboard framing; just the quiet accumulation of a life.
//
// Reuses the Atlas specimen-plate pattern (the .acard system + the illustration
// → knockout → letter-plate image fallback), but fetches its own data on mount.
import { useEffect, useState } from 'react';
import type { CatalogSpecies } from '../catalog';
import { fetchCatalog } from '../catalog';
import { birdImageUrl } from '../img';
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

type ThumbState = 'photo' | 'knockout' | 'plate';

// Specimen image well with the Atlas fallback chain (illustration → knockout
// ink-ghost → letter plate). art_status optimization: a species the catalog
// marks 'none' (or one with no resolvable URL) starts at the letter plate — we
// skip a cutout.php request that, for art the catalog knows is unbundled, would
// only resolve to the generic ink silhouette (or a still-pending Railway 302),
// never the illustration (cutout.php always 200s/302s, it never 404s). 'ready'
// loads the illustration and degrades gracefully on error.
function WallThumb({ slug, sci, com, art }: { slug: string; sci: string; com: string; art: string }) {
  const url = birdImageUrl(slug, sci);
  const [state, setState] = useState<ThumbState>(!url || art !== 'ready' ? 'plate' : 'photo');
  if (!url || state === 'plate') {
    return (
      <div className="acard-img">
        <div className="acard-sil" aria-hidden="true">
          {(com || sci).slice(0, 1)}
        </div>
      </div>
    );
  }
  const knock = state === 'knockout';
  return (
    <div className={knock ? 'acard-img knockout' : 'acard-img'}>
      <img
        key={state}
        src={url}
        alt={com || sci}
        loading="lazy"
        onError={() => setState(knock ? 'plate' : 'knockout')}
      />
    </div>
  );
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
              <div className="wall-h">
                <span className="acard-no">No. {String(i + 1).padStart(3, '0')}</span>
                <span className="wall-tally">
                  <b>{s.detection_count.toLocaleString()}</b> calls
                </span>
              </div>
              <WallThumb slug={s.slug} sci={s.sci_name} com={s.com_name} art={s.art_status} />
              <div className="acard-cn">{s.com_name || s.sci_name}</div>
              <div className="acard-ln">{s.sci_name}</div>
              <div className="wall-first">first seen {firstSeenLabel(s.first_confident)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
