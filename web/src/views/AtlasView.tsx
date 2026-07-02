// ATLAS — museum specimen plates. A 3-col grid of cards, each with a graceful
// image fallback (kachō-e illustration → letter plate, via the shared BirdThumb
// component) so a missing or still-generating illustration never shows a broken
// icon. At N≤2 the grid gives way to a single centered "first specimen" feature
// plate; the grid engages at N≥3. Every plate is clickable — `onOpen` surfaces
// the row to the parent, which opens the shared BirdPopup detail modal.
import { useEffect, useState } from 'react';
import type { RosterRow } from '../types';
import { fetchArtStatus } from '../catalog';
import { BirdThumb } from '../components/BirdThumb';
import { Listen } from '../components/Listen';
import { formatDay } from '../days';

// eBird / Macaulay media catalogue search, keyed on the binomial (no per-species
// code needed) — always resolves, unlike the auth-gated /species/<code> pages.
const EBIRD_SEARCH = 'https://media.ebird.org/catalog?q=';

// Header: the catalogue number (life-list order) over the call count. The Lifer
// pill shows only for a genuine first (isNew) — never an always-true "Heard"
// badge (every plate was, by definition, heard).
function CardHead({ cat, n, isNew }: { cat: string; n: number; isNew: boolean }) {
  return (
    <div className="acard-h">
      <div className="acard-hl">
        <span className="acard-no">{cat}</span>
        <span>
          <b>{n}</b> {n === 1 ? 'call' : 'calls'}
        </span>
      </div>
      {isNew && <span className="tg l">Lifer</span>}
    </div>
  );
}

// Footer chip row: the real Listen control + the two external links (wiki,
// eBird), shared by the grid card and the feature plate. Every interactive
// child stops the click from bubbling into the card's open handler — Listen
// does this itself; the anchor links do it inline.
function CardFooter({ sci }: { sci: string }) {
  return (
    <div className="acard-f">
      <Listen sci={sci} />
      <span className="acard-links">
        <a
          className="acard-lnk"
          href={`https://en.wikipedia.org/wiki/${encodeURIComponent(sci.replace(/ /g, '_'))}`}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          wiki ↗
        </a>
        <a
          className="acard-lnk"
          href={`${EBIRD_SEARCH}${encodeURIComponent(sci)}`}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          ebird ↗
        </a>
      </span>
    </div>
  );
}

export function AtlasView({
  rows,
  archiveDay = null,
  onOpen,
}: {
  rows: RosterRow[];
  /** Pinned past day the roster reflects (time-travel scrubber), or null =
   *  live window — keeps the masthead truthful when browsing an archive day. */
  archiveDay?: string | null;
  onOpen?: (r: RosterRow) => void;
}) {
  // Catalog art_status map (slug → 'ready' | 'none'): lets each plate skip the
  // readiness probe when the catalog already vouches for real art. Render
  // immediately without waiting for it — first paint never blocks on the
  // catalog; the brief pre-map probe race is capped by the hook's semaphore
  // and aborted when `trusted` flips.
  const [art, setArt] = useState<Map<string, string> | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchArtStatus().then((m) => {
      if (alive) setArt(m);
    });
    return () => {
      alive = false;
    };
  }, []);

  // N≤2: a single centered "first specimen" feature plate instead of a lonely
  // grid cell. The grid engages at N≥3.
  if (rows.length >= 1 && rows.length <= 2) {
    const r = rows[0];
    return (
      <div className="view">
        <div className="view-mast">
          <div className="eyebrow">{archiveDay ? `${formatDay(archiveDay)} · archive` : 'your window'}</div>
          <div className="t">Atlas BirdNet</div>
        </div>
        <div className="atlas-feature">
          <div className="acard feat" role="button" tabIndex={0} onClick={() => onOpen?.(r)}>
            <CardHead cat={`No. ${String(1).padStart(3, '0')}`} n={r.n} isNew={r.isNew} />
            <BirdThumb slug={r.slug} sci={r.sci} com={r.com} art={art?.get(r.slug)} feature />
            <div className="feat-kicker">first specimen</div>
            <div className="acard-cn">{r.com || r.sci}</div>
            <div className="acard-ln">{r.sci}</div>
            <CardFooter sci={r.sci} />
          </div>
        </div>
      </div>
    );
  }

  // Every species in the window earns a plate; scale is handled by
  // content-visibility + lazy images, not by dropping species.
  const cards = rows;
  return (
    <div className="view">
      <div className="view-mast">
        <div className="eyebrow">{archiveDay ? `${formatDay(archiveDay)} · archive` : 'your window'}</div>
        <div className="t">Atlas BirdNet</div>
        {/* Explicit completeness: "this is everything" stated, not implied. */}
        <div className="atlas-note">
          {cards.length} species {archiveDay ? `· ${formatDay(archiveDay)}` : 'in the window'}
        </div>
      </div>
      <div className="atlas-grid">
        {cards.map((r, i) => (
          <div
            className="acard"
            key={r.sci}
            role="button"
            tabIndex={0}
            onClick={() => onOpen?.(r)}
          >
            <CardHead cat={`No. ${String(i + 1).padStart(3, '0')}`} n={r.n} isNew={r.isNew} />
            <BirdThumb slug={r.slug} sci={r.sci} com={r.com} art={art?.get(r.slug)} />
            <div className="acard-cn">{r.com || r.sci}</div>
            <div className="acard-ln">{r.sci}</div>
            <CardFooter sci={r.sci} />
          </div>
        ))}
      </div>
    </div>
  );
}
