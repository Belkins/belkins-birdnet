// BIRD POPUP — the detail modal opened by clicking a bird in the collage or an
// Atlas plate. It shows the window count immediately (from the roster row, so it
// never blocks on the network) and enriches it on open with the all-time total,
// last-heard time, and newest recording pulled from birdnet-api.php's `species`
// action. The hero reuses the shared BirdThumb fallback chain; the actions row
// reuses the real Listen control and the same wiki/eBird links as the Atlas
// footer. Dismisses on backdrop / ✕ / Escape; role="dialog" with the close
// button focused on open. Every colour resolves from a theme var, so it reads in
// both night and day.
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { API_BASE } from '../config';
import { BirdThumb } from './BirdThumb';
import { Listen } from './Listen';
import './BirdPopup.css';

// eBird / Macaulay media catalogue search, keyed on the binomial — matches the
// Atlas footer link so the two surfaces resolve identically.
const EBIRD_SEARCH = 'https://media.ebird.org/catalog?q=';

// A single clickable bird — the collage tile / Atlas row projected down to just
// what the modal needs. `n` is the window count (this window only); the all-time
// total and newest recording come from the on-open species fetch.
export interface BirdRef {
  sci: string;
  com: string;
  slug: string;
  n: number;
}

// Only the `species`-action fields the modal reads (birdnet-api.php:126-142).
interface SpeciesDetail {
  total: number | null;
  lastSeen: string | null;
  latestFile: string | null;
}

export function BirdPopup({
  bird,
  windowLabel,
  onClose,
}: {
  bird: BirdRef | null;
  windowLabel: string;
  onClose: () => void;
}): JSX.Element | null {
  // No hooks here so this early-out never trips the rules of hooks; the keyed
  // Dialog below owns the whole open/close lifecycle.
  if (bird === null) return null;
  return <Dialog key={bird.sci} bird={bird} windowLabel={windowLabel} onClose={onClose} />;
}

// Mounts only while a bird is selected (and remounts per species via the key),
// so opening = mount — focus the close button, wire Escape, fetch detail — and
// closing = unmount, tearing every listener + the in-flight fetch back down.
function Dialog({
  bird,
  windowLabel,
  onClose,
}: {
  bird: BirdRef;
  windowLabel: string;
  onClose: () => void;
}): JSX.Element {
  const [detail, setDetail] = useState<SpeciesDetail | null>(null);
  const [specOk, setSpecOk] = useState(true);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // All-time total, last-heard, and the newest recording basename come from this
  // one call; `detections` is newest-first so `[0].file` is the latest clip. A
  // failure (offline mock, 404, abort on close) degrades silently — the modal
  // stays useful on the roster-only data and never logs a console error.
  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch(
          `${API_BASE}/birdnet-api.php?action=species&sci=${encodeURIComponent(bird.sci)}`,
          { signal: ctrl.signal },
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          summary?: { total?: number; last_seen?: string | null } | null;
          detections?: Array<{ file?: string | null }> | null;
        };
        setDetail({
          total: data.summary?.total ?? null,
          lastSeen: data.summary?.last_seen ?? null,
          latestFile: data.detections?.[0]?.file ?? null,
        });
      } catch {
        // aborted on unmount, or a network/parse failure — intentionally quiet.
      }
    })();
    return () => ctrl.abort();
  }, [bird.sci]);

  // Focus the close button on open (accessible dialog entry point) and dismiss
  // on Escape. stopPropagation keeps a global frame-mode Esc from also firing.
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const title = bird.com || bird.sci;
  const specSrc = `${API_BASE}/spectrogram.php?sci=${encodeURIComponent(bird.sci)}`;

  return (
    <div className="bp-scrim" onClick={onClose}>
      <div
        className="bp-card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <button ref={closeRef} type="button" className="bp-x" aria-label="Close" onClick={onClose}>
          ✕
        </button>

        <div className="bp-hero">
          <BirdThumb slug={bird.slug} sci={bird.sci} com={bird.com} />
        </div>

        <div className="bp-head">
          <div className="bp-name">{title}</div>
          <div className="bp-sci">{bird.sci}</div>
        </div>

        <div className="bp-figs">
          <div className="bp-fig">
            <b className="bp-fig-n">{bird.n}</b>
            <span className="bp-fig-l">calls · this {windowLabel}</span>
          </div>
          <div className="bp-fig">
            <b className="bp-fig-n">{detail?.total ?? '—'}</b>
            <span className="bp-fig-l">calls · all-time</span>
          </div>
        </div>

        {detail?.lastSeen && <div className="bp-last">last heard {detail.lastSeen}</div>}

        {specOk && (
          <img className="bp-spec" src={specSrc} alt="" onError={() => setSpecOk(false)} />
        )}

        <div className="bp-actions">
          <Listen sci={bird.sci} file={detail?.latestFile ?? undefined} />
          <span className="bp-links">
            <a
              className="bp-lnk"
              href={`https://en.wikipedia.org/wiki/${encodeURIComponent(bird.sci.replace(/ /g, '_'))}`}
              target="_blank"
              rel="noreferrer"
            >
              wiki ↗
            </a>
            <a
              className="bp-lnk"
              href={`${EBIRD_SEARCH}${encodeURIComponent(bird.sci)}`}
              target="_blank"
              rel="noreferrer"
            >
              ebird ↗
            </a>
          </span>
        </div>
      </div>
    </div>
  );
}
