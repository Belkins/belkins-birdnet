// THE WEEKLY RECAP — the flagship pull artifact. One washi "acquisitions" sheet
// composed from the week's REAL visitors (species.json), on the same paint engine
// as the wall (export-card.composeWeeklySheet). It is pull, not push: no streak,
// no FOMO, no habit loop — you come here (or follow the digest link) to see a
// calm, true postcard of the week. Every figure is a real catalog read; "new this
// week" is a real first-heard date, never invented.
//
// The page renders the sheet to a canvas and shows it as an <img> (WYSIWYG — the
// preview IS the shareable image) with a Save button. The weekly_digest.py push
// links here.
import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { fetchCatalog, type CatalogSpecies } from '../catalog';
import { composeWeeklySheet, type SheetSpec } from '../export-card';
import { BASE } from '../config';

/** Days in the recap window. */
const WINDOW_DAYS = 7;
/** Cap the sheet so it stays a composed page, not an endless scroll. */
const MAX_CELLS = 12;

/** Parse a "YYYY-MM-DD" (or datetime) date string to ms, or null. */
function dayMs(s: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s.length > 10 ? s.replace(' ', 'T') : `${s}T00:00:00`);
  return Number.isNaN(t) ? null : t;
}

/** "Mon D" for a ms timestamp. */
function fmt(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function Recap(): JSX.Element {
  const [cat, setCat] = useState<CatalogSpecies[] | null>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [rendering, setRendering] = useState(true);

  useEffect(() => {
    let alive = true;
    void fetchCatalog().then((rows) => {
      if (alive) setCat(rows);
    });
    return () => {
      alive = false;
    };
  }, []);

  // This week's window [start, now]; species whose last_detected falls inside it.
  const week = useMemo(() => {
    const now = Date.now();
    const start = now - WINDOW_DAYS * 86400000;
    return { now, start };
  }, []);

  const { specs, newCount, dateline, log } = useMemo(() => {
    if (!cat) return { specs: [] as SheetSpec[], newCount: 0, dateline: '', log: '' };
    const visitors = cat
      .map((s) => {
        const last = dayMs(s.last_detected);
        const first = dayMs(s.first_confident);
        return { s, last, isNew: first != null && first >= week.start };
      })
      .filter((v) => v.last != null && v.last >= week.start);

    // New to the collection first, then the loudest of the week.
    visitors.sort((a, b) => {
      if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
      return b.s.detection_count - a.s.detection_count;
    });

    const nNew = visitors.filter((v) => v.isNew).length;
    const specsOut: SheetSpec[] = visitors.slice(0, MAX_CELLS).map((v) => ({
      slug: v.s.slug,
      sci: v.s.sci_name,
      com: v.s.com_name,
      accession: v.s.accession ?? null,
      detectionCount: v.s.detection_count,
      isNew: v.isNew,
      theme: 'day',
    }));

    const dl = `Week of ${fmt(week.start)} – ${fmt(week.now)}`;
    // Honest one-line log: facts only. Silence-when-nothing is a feature.
    let l = '';
    if (visitors.length) {
      l = `${visitors.length} species heard this week`;
      if (nNew > 0) l += ` · ${nNew} new to the collection`;
    }
    return { specs: specsOut, newCount: nNew, dateline: dl, log: l };
  }, [cat, week]);

  // Compose the sheet whenever the week's specs resolve.
  useEffect(() => {
    if (!cat) return;
    let alive = true;
    setRendering(true);
    if (specs.length === 0) {
      setDataUrl(null);
      setRendering(false);
      return;
    }
    void composeWeeklySheet(specs, { title: 'Acquisitions', dateline, log })
      .then((canvas) => {
        if (!alive) return;
        setDataUrl(canvas.toDataURL('image/png'));
        setRendering(false);
      })
      .catch(() => {
        if (alive) setRendering(false);
      });
    return () => {
      alive = false;
    };
  }, [cat, specs, dateline, log]);

  function download(): void {
    if (!dataUrl) return;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `belkins-birdnet-recap-${fmt(week.now).replace(/\s/g, '-').toLowerCase()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return (
    <div className="rc">
      <header className="rc-head">
        <div className="rc-eyebrow">{dateline || 'Weekly Recap'}</div>
        <h1 className="rc-title">Acquisitions</h1>
        {log && <p className="rc-log">{log}</p>}
      </header>

      <div className="rc-stage">
        {rendering && cat && specs.length > 0 && <p className="rc-note">composing the sheet…</p>}
        {!rendering && specs.length === 0 && (
          <p className="rc-note">
            A quiet week — nothing new to the collection in the last {WINDOW_DAYS} days. The frame is
            still listening.
          </p>
        )}
        {dataUrl && <img className="rc-sheet" src={dataUrl} alt="This week's acquisitions sheet" />}
      </div>

      {dataUrl && (
        <div className="rc-actions">
          <button className="rc-btn" onClick={download}>
            save sheet ↓
          </button>
          {newCount > 0 && <span className="rc-hint">{newCount} new this week</span>}
        </div>
      )}

      <footer className="rc-foot">
        <a href={BASE}>← the museum</a>
        <a href={`${BASE}lab.html`}>the lab →</a>
      </footer>
    </div>
  );
}
