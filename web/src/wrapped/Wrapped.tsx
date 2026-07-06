// YEAR IN REVIEW — the yard's year as a museum broadsheet, not a stat card. On
// obsidian: a hero specimen (the most-heard, luminous) over an editorial ledger
// of real figures, then the year's new acquisitions. Every number is a real
// catalog read; the year is derived from the DATA's latest detection (like
// derive.py), never wall-clock. The on-screen piece is HTML (so it is reliably
// beautiful); "save poster" composes a shareable PNG on the same paint engine.
import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { fetchCatalog, type CatalogSpecies } from '../catalog';
import { composeYearSheet, type SheetSpec, type YearStat } from '../export-card';
import { birdImageUrl } from '../img';
import { BASE } from '../config';

function yearOf(s: string | null): number | null {
  if (!s) return null;
  const y = Number(s.slice(0, 4));
  return Number.isInteger(y) && y > 1900 ? y : null;
}

/** A luminous specimen <img> with the museum's warm seat-ink glow, or nothing
 *  when the plate can't load (never a broken image). */
function Specimen({ s, className }: { s: CatalogSpecies; className: string }): JSX.Element | null {
  const url = birdImageUrl(s.slug, s.sci_name);
  const [ok, setOk] = useState(true);
  if (!url || !ok) return null;
  return <img className={className} src={url} alt={s.com_name} onError={() => setOk(false)} />;
}

export function Wrapped(): JSX.Element {
  const [cat, setCat] = useState<CatalogSpecies[] | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchCatalog().then((rows) => {
      if (alive) setCat(rows);
    });
    return () => {
      alive = false;
    };
  }, []);

  const model = useMemo(() => {
    if (!cat || cat.length === 0) return null;
    let year = 0;
    for (const s of cat) {
      const y = yearOf(s.last_detected) ?? 0;
      if (y > year) year = y;
    }
    if (year === 0) return null;
    const heard = cat.filter((s) => yearOf(s.last_detected) === year);
    const fresh = cat
      .filter((s) => yearOf(s.first_confident) === year)
      .sort((a, b) => b.detection_count - a.detection_count);
    const favourite = cat.reduce((a, b) => (b.detection_count > a.detection_count ? b : a));
    return { year, heard, fresh, favourite, life: cat.length };
  }, [cat]);

  function download(): void {
    if (!model) return;
    const stats: YearStat[] = [
      { value: String(model.heard.length), label: `species heard in ${model.year}` },
      { value: String(model.fresh.length), label: 'new to the collection' },
      { value: String(model.life), label: 'on the life list' },
    ];
    const highlights: SheetSpec[] = (model.fresh.length ? model.fresh : [model.favourite])
      .slice(0, 5)
      .map((s) => ({ slug: s.slug, sci: s.sci_name, com: s.com_name, accession: s.accession ?? null }));
    void composeYearSheet(model.year, stats, highlights, 'night').then((canvas) => {
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = `belkins-birdnet-${model.year}-wrapped.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  }

  if (cat && !model) {
    return (
      <div className="wr">
        <p className="wr-note">Not enough of a year on record yet. The frame is still listening.</p>
        <Foot />
      </div>
    );
  }

  return (
    <div className="wr">
      <header className="wr-mast">
        <div className="wr-eyebrow">The Yard · {model ? model.year : '—'}</div>
        <h1 className="wr-title">Year in Review</h1>
      </header>

      {model && (
        <>
          <section className="wr-hero">
            <div className="wr-hero-plate">
              <Specimen s={model.favourite} className="wr-hero-img" />
            </div>
            <div className="wr-hero-cap">
              <div className="wr-hero-name">{model.favourite.com_name}</div>
              <div className="wr-hero-sci">{model.favourite.sci_name}</div>
              <div className="wr-hero-sub">
                most-heard of the collection · {model.favourite.detection_count.toLocaleString()} calls
              </div>
            </div>
          </section>

          <div className="wr-rule" />

          <section className="wr-ledger">
            <div className="wr-stat">
              <span className="wr-fig">{model.heard.length}</span>
              <span className="wr-lab">species heard in {model.year}</span>
            </div>
            <div className="wr-stat">
              <span className="wr-fig">{model.fresh.length}</span>
              <span className="wr-lab">new to the collection</span>
            </div>
            <div className="wr-stat">
              <span className="wr-fig">{model.life}</span>
              <span className="wr-lab">on the life list, all-time</span>
            </div>
          </section>

          {model.fresh.length > 0 && (
            <>
              <div className="wr-rule" />
              <section className="wr-acq">
                <div className="wr-acq-head">This year's acquisitions</div>
                <div className="wr-acq-row">
                  {model.fresh.slice(0, 6).map((s) => (
                    <figure className="wr-acq-item" key={s.slug}>
                      <div className="wr-acq-plate">
                        <Specimen s={s} className="wr-acq-img" />
                      </div>
                      <figcaption className="wr-acq-cap">
                        <span className="wr-acq-name">{s.com_name}</span>
                        {s.accession != null && (
                          <span className="wr-acq-no">No. {String(s.accession).padStart(3, '0')}</span>
                        )}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              </section>
            </>
          )}

          <div className="wr-actions">
            <button className="wr-btn" onClick={download}>
              save poster ↓
            </button>
          </div>
        </>
      )}

      <Foot />
    </div>
  );
}

function Foot(): JSX.Element {
  return (
    <footer className="wr-foot">
      <a href={BASE}>← the museum</a>
      <span className="wr-colophon">Belkins BirdNET · Living Gallery</span>
      <a href={`${BASE}play.html`}>play →</a>
    </footer>
  );
}
