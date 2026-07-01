// ATLAS — museum specimen plates. A 3-col grid of cards, each with a graceful
// image fallback (kachō-e illustration → letter plate, via the shared BirdThumb
// component) so a missing or still-generating illustration never shows a broken
// icon. At N≤2 the grid gives way to a single centered "first specimen" feature
// plate; the grid engages at N≥3. Every plate is clickable — `onOpen` surfaces
// the row to the parent, which opens the shared BirdPopup detail modal.
import type { RosterRow } from '../types';
import { BirdThumb } from '../components/BirdThumb';
import { Listen } from '../components/Listen';

// eBird / Macaulay media catalogue search, keyed on the binomial (no per-species
// code needed) — always resolves, unlike the auth-gated /species/<code> pages.
const EBIRD_SEARCH = 'https://media.ebird.org/catalog?q=';

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

export function AtlasView({ rows, onOpen }: { rows: RosterRow[]; onOpen?: (r: RosterRow) => void }) {
  // N≤2: a single centered "first specimen" feature plate instead of a lonely
  // grid cell. The grid engages at N≥3.
  if (rows.length >= 1 && rows.length <= 2) {
    const r = rows[0];
    return (
      <div className="view">
        <div className="view-mast">
          <div className="eyebrow">your window</div>
          <div className="t">Atlas Belkins BirdNET</div>
        </div>
        <div className="atlas-feature">
          <div className="acard feat" role="button" tabIndex={0} onClick={() => onOpen?.(r)}>
            <CardHead cat={`No. ${String(1).padStart(3, '0')}`} n={r.n} isNew={r.isNew} />
            <BirdThumb slug={r.slug} sci={r.sci} com={r.com} feature />
            <div className="feat-kicker">first specimen</div>
            <div className="acard-cn">{r.com || r.sci}</div>
            <div className="acard-ln">{r.sci}</div>
            <CardFooter sci={r.sci} />
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
        <div className="t">Atlas Belkins BirdNET</div>
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
            <BirdThumb slug={r.slug} sci={r.sci} com={r.com} />
            <div className="acard-cn">{r.com || r.sci}</div>
            <div className="acard-ln">{r.sci}</div>
            <CardFooter sci={r.sci} />
          </div>
        ))}
      </div>
    </div>
  );
}
