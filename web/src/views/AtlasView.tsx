// ATLAS — museum specimen plates. A 3-col grid of cards, each with a graceful
// image fallback (kachō-e illustration → letter plate, via the shared BirdThumb
// component) so a missing or still-generating illustration never shows a broken
// icon. At N≤2 the grid gives way to a single centered "first specimen" feature
// plate; the grid engages at N≥3. Every plate is clickable — `onOpen` surfaces
// the row to the parent, which opens the shared BirdPopup detail modal.
import { useEffect, useState } from 'react';
import type { RosterRow } from '../types';
import { fetchArtStatus, fetchEbirdCodes } from '../catalog';
import { BirdThumb } from '../components/BirdThumb';
import { Listen } from '../components/Listen';
import { formatDay } from '../days';
import { fetchJardine, speciesBySci, type JardineSpecies } from '../jardine';
import { JardineName } from '../components/JardineName';
import { ebirdMediaUrl } from '../ebird';

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

// Footer chip row: the real Listen control + the external links (wiki, and eBird
// when we hold a taxon code), shared by the grid card and the feature plate.
// Every interactive child stops the click from bubbling into the card's open
// handler — Listen does this itself; the anchor links do it inline.
//
// `ebird` arrives from the nightly catalog and is undefined until it resolves,
// so the chip appears a beat after the plate. That is deliberate: the museum
// would rather show one link late than two links where one goes nowhere.
function CardFooter({ sci, ebird }: { sci: string; ebird?: string }) {
  const ebirdHref = ebirdMediaUrl(ebird);
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
        {ebirdHref && (
          <a
            className="acard-lnk"
            href={ebirdHref}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            ebird ↗
          </a>
        )}
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
  // THE 1838 NAME under the modern one. Rendered through <JardineName>, so the
  // dotted verify marker and any [sic] come with it and cannot be forgotten here
  // the way they were forgotten in the Index of Silences.
  const [jard, setJard] = useState<Map<string, JardineSpecies>>(new Map());
  useEffect(() => {
    let live = true;
    fetchJardine()
      .then((d) => {
        if (live) setJard(speciesBySci(d));
      })
      .catch(() => {
        /* the atlas simply stays as it was */
      });
    return () => {
      live = false;
    };
  }, []);

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

  // sci_name → eBird taxon code, for the catalogue link in each plate's footer.
  // Shares the catalog's 60s TTL memo with the art-status map above, so this
  // costs no extra network read. A failure leaves the map empty and the plates
  // simply carry no eBird chip.
  const [ebird, setEbird] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let alive = true;
    void fetchEbirdCodes().then((m) => {
      if (alive) setEbird(m);
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
            {(() => {
              const j = jard.get(r.sci);
              // only when the name actually MOVED — repeating an unchanged
              // binomial under itself says nothing.
              if (!j || !j.jardine_binomial || j.jardine_binomial === r.sci) return null;
              return (
                <div className="acard-ln acard-ln-1838">
                  <JardineName species={j} /> <span className="acard-yr">1838</span>
                </div>
              );
            })()}
            <CardFooter sci={r.sci} ebird={ebird.get(r.sci)} />
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
            <CardFooter sci={r.sci} ebird={ebird.get(r.sci)} />
          </div>
        ))}
      </div>
    </div>
  );
}
