// ATLAS — museum cards in a responsive grid, with a graceful image fallback
// (a letter plate) so a missing or still-generating illustration never shows
// a broken icon.
import { useState } from 'react';
import type { RosterRow } from '../types';
import { birdImageUrl } from '../img';

function BirdThumb({ slug, sci, com }: { slug: string; sci: string; com: string }) {
  const [failed, setFailed] = useState(false);
  const url = birdImageUrl(slug, sci);
  if (!url || failed) {
    return <div className="acard-sil">{(com || sci).slice(0, 1)}</div>;
  }
  return <img src={url} alt={com || sci} loading="lazy" onError={() => setFailed(true)} />;
}

export function AtlasView({ rows }: { rows: RosterRow[] }) {
  const cards = rows.slice(0, 18);
  return (
    <div className="view">
      <div className="view-mast">
        <div className="eyebrow">your window</div>
        <div className="t">THE ATLAS</div>
      </div>
      <div className="atlas-grid">
        {cards.map((r) => (
          <div className="acard" key={r.sci}>
            <div className="acard-h">
              <span>
                <b>{r.n}</b> calls
              </span>
              <span className={r.isNew ? 'tg l' : 'tg n'}>{r.isNew ? 'New' : 'Heard'}</span>
            </div>
            <div className="acard-img">
              <BirdThumb slug={r.slug} sci={r.sci} com={r.com} />
            </div>
            <div className="acard-cn">{r.com || r.sci}</div>
            <div className="acard-ln">{r.sci}</div>
            <div className="acard-f">
              <button type="button" className="acard-play" aria-label={`Play a recording of ${r.com || r.sci}`}>
                ▶ Listen
              </button>
              <a
                className="acard-lnk"
                href={`https://en.wikipedia.org/wiki/${encodeURIComponent(r.sci.replace(/ /g, '_'))}`}
                target="_blank"
                rel="noreferrer"
              >
                wiki ↗
              </a>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
