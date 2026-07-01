// ATLAS — museum specimen plates. A 3-col grid of cards, each with a graceful
// image fallback chain (kachō-e illustration → knockout ink-ghost silhouette →
// letter plate) so a missing or still-generating illustration never shows a
// broken icon. At N≤2 the grid gives way to a single centered "first specimen"
// feature plate; the grid engages at N≥3.
import { useState } from 'react';
import type { RosterRow } from '../types';
import { birdImageUrl } from '../img';

// eBird / Macaulay media catalogue search, keyed on the binomial (no per-species
// code needed) — always resolves, unlike the auth-gated /species/<code> pages.
const EBIRD_SEARCH = 'https://media.ebird.org/catalog?q=';

type ThumbState = 'photo' | 'knockout' | 'plate';

// Image well with the fallback chain: the illustration paints first; on a load
// error it re-renders through the knockout filter (a tasteful ink ghost, styled
// in App.css); if that also fails it collapses to the letter plate — the
// structural floor that can never show a broken <img>.
function BirdThumb({ slug, sci, com, feature }: { slug: string; sci: string; com: string; feature?: boolean }) {
  const url = birdImageUrl(slug, sci);
  const [state, setState] = useState<ThumbState>('photo');
  const well = feature ? 'acard-img feat' : 'acard-img';
  if (!url || state === 'plate') {
    return (
      <div className={well}>
        <div className="acard-sil">{(com || sci).slice(0, 1)}</div>
      </div>
    );
  }
  const knock = state === 'knockout';
  return (
    <div className={knock ? `${well} knockout` : well}>
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

// Header: the catalogue number (life-list order) over the call count, with the
// Lifer / Heard tag pill on the right.
function CardHead({ cat, n, isNew }: { cat: string; n: number; isNew: boolean }) {
  return (
    <div className="acard-h">
      <div className="acard-hl">
        <span className="acard-no">{cat}</span>
        <span>
          <b>{n}</b> calls
        </span>
      </div>
      <span className={isNew ? 'tg l' : 'tg n'}>{isNew ? 'Lifer' : 'Heard'}</span>
    </div>
  );
}

// Footer chip row: Listen + the two external links (wiki, eBird), shared by the
// grid card and the feature plate.
function CardFooter({ sci, com }: { sci: string; com: string }) {
  const name = com || sci;
  return (
    <div className="acard-f">
      <button type="button" className="acard-play" aria-label={`Play a recording of ${name}`}>
        ▶ Listen
      </button>
      <span className="acard-links">
        <a
          className="acard-lnk"
          href={`https://en.wikipedia.org/wiki/${encodeURIComponent(sci.replace(/ /g, '_'))}`}
          target="_blank"
          rel="noreferrer"
        >
          wiki ↗
        </a>
        <a
          className="acard-lnk"
          href={`${EBIRD_SEARCH}${encodeURIComponent(sci)}`}
          target="_blank"
          rel="noreferrer"
        >
          ebird ↗
        </a>
      </span>
    </div>
  );
}

export function AtlasView({ rows }: { rows: RosterRow[] }) {
  // N≤2: a single centered "first specimen" feature plate instead of a lonely
  // grid cell. The grid engages at N≥3.
  if (rows.length >= 1 && rows.length <= 2) {
    const r = rows[0];
    return (
      <div className="view">
        <div className="view-mast">
          <div className="eyebrow">your window</div>
          <div className="t">THE ATLAS</div>
        </div>
        <div className="atlas-feature">
          <div className="acard feat">
            <CardHead cat={`No. ${String(1).padStart(3, '0')}`} n={r.n} isNew={r.isNew} />
            <BirdThumb slug={r.slug} sci={r.sci} com={r.com} feature />
            <div className="feat-kicker">first specimen</div>
            <div className="acard-cn">{r.com || r.sci}</div>
            <div className="acard-ln">{r.sci}</div>
            <CardFooter sci={r.sci} com={r.com} />
          </div>
        </div>
      </div>
    );
  }

  const cards = rows.slice(0, 18);
  return (
    <div className="view">
      <div className="view-mast">
        <div className="eyebrow">your window</div>
        <div className="t">THE ATLAS</div>
      </div>
      <div className="atlas-grid">
        {cards.map((r, i) => (
          <div className="acard" key={r.sci}>
            <CardHead cat={`No. ${String(i + 1).padStart(3, '0')}`} n={r.n} isNew={r.isNew} />
            <BirdThumb slug={r.slug} sci={r.sci} com={r.com} />
            <div className="acard-cn">{r.com || r.sci}</div>
            <div className="acard-ln">{r.sci}</div>
            <CardFooter sci={r.sci} com={r.com} />
          </div>
        ))}
      </div>
    </div>
  );
}
