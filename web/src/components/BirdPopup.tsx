// BIRD POPUP — the rich species dossier opened by clicking a bird in the collage
// or an Atlas plate. A wide, two-column editorial modal that matches (and gently
// exceeds) the legacy detail modal:
//
//   LEFT   a bordered plate with the large kachō-e cutout + a perched/flight
//          pose toggle (birdImageUrl's pose arg); a broken image collapses to a
//          bounded letter plate, never an unbounded circle.
//   RIGHT  the display name, italic scientific name, 2–3 stat cards (window /
//          all-time / first-heard), the Wikipedia blurb, and a genus · rarity
//          meta line.
//   BELOW  a full-width RECORDINGS section — a scrollable list of the species'
//          recent detections, each row playing its own clip via recording.php.
//
// The window count (bird.n) shows immediately from the roster row; the all-time
// total, first-heard, recordings, and description enrich on open from
// birdnet-api.php (action=species) + wiki.php. Every endpoint degrades silently:
// a missing API hides its section and never logs a console error. Dismisses on
// backdrop / ✕ / Escape; role="dialog" with the close button focused on open.
// Every colour resolves from a theme var, so it reads in both night and day.
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { API_BASE } from '../config';
import { birdImageUrl } from '../img';
import './BirdPopup.css';

// eBird / Macaulay media catalogue search, keyed on the binomial — matches the
// Atlas footer link so the two surfaces resolve identically.
const EBIRD_SEARCH = 'https://media.ebird.org/catalog?q=';

// A single clickable bird — the collage tile / Atlas row projected down to just
// what the modal needs. `n` is the window count (this window only); the all-time
// total, first-heard, and recordings come from the on-open species fetch.
export interface BirdRef {
  sci: string;
  com: string;
  slug: string;
  n: number;
}

// One past detection, as returned by birdnet-api.php's `species` action
// (birdnet-api.php:129-133): d=Date, t=Time, file=File_Name, conf=Confidence.
interface Recording {
  file: string;
  d: string;
  t: string;
  conf: number;
}

// The enriched detail folded out of the `species` action, newest-first.
interface SpeciesDetail {
  total: number | null;
  firstSeen: string | null;
  recordings: Recording[];
}

type Pose = 1 | 2;

// ── formatting helpers (ported from the legacy modal) ─────────────────────────

/** "6h ago" / "3d ago" from a BirdNET Date + Time pair. */
function fmtRelative(d: string | null, t: string | null): string {
  if (!d) return '—';
  const date = new Date(`${d}T${t || '00:00:00'}`);
  if (Number.isNaN(date.getTime())) return `${d} ${t || ''}`.trim();
  const ago = Math.floor((Date.now() - date.getTime()) / 1000);
  if (ago < 60) return `${ago}s ago`;
  if (ago < 3600) return `${Math.floor(ago / 60)}m ago`;
  if (ago < 86400) return `${Math.floor(ago / 3600)}h ago`;
  return `${Math.floor(ago / 86400)}d ago`;
}

/** "1 Jul · 05:09" — a compact absolute stamp for the recording rows. */
function fmtDateLine(d: string | null, t: string | null): string {
  if (!d) return '';
  const date = new Date(`${d}T${t || '00:00:00'}`);
  if (Number.isNaN(date.getTime())) return `${d} ${t || ''}`.trim();
  const day = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${day} · ${t ? t.slice(0, 5) : ''}`.trim();
}

/** Detections-per-day heuristic → a plain-language rarity band. */
function rarityLabel(total: number | null, firstSeenIso: string | null): string | null {
  if (!total) return null;
  let days = 1;
  if (firstSeenIso) {
    const parsed = Date.parse(firstSeenIso.replace(' ', 'T'));
    if (!Number.isNaN(parsed)) days = Math.max(1, Math.ceil((Date.now() - parsed) / 86400000));
  }
  const perDay = total / days;
  if (perDay >= 5) return 'common';
  if (perDay >= 1) return 'regular';
  if (perDay >= 0.2) return 'occasional';
  return 'rare';
}

/** First ~n sentences of the Wikipedia extract, so the blurb stays a paragraph. */
function firstSentences(text: string, n: number): string {
  const parts = text.match(/[^.!?]+[.!?]+(\s|$)/g);
  if (!parts || parts.length <= n) return text.trim();
  return parts.slice(0, n).join('').trim();
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
// so opening = mount — focus the close button, wire Escape, fetch detail + wiki —
// and closing = unmount, tearing every listener + the in-flight fetches down.
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
  const [desc, setDesc] = useState<string | null>(null);
  const [pose, setPose] = useState<Pose>(1);
  const [imgErr, setImgErr] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // All-time total, first-heard, and the recent-detections list come from this
  // one call; `detections` is newest-first. A failure (offline mock, 404, abort
  // on close) degrades silently — the modal stays useful on the roster-only data
  // and never logs a console error.
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
          summary?: { total?: number; first_seen?: string | null } | null;
          detections?: Array<{ file?: string | null; d?: string; t?: string; conf?: number }> | null;
        };
        const recordings: Recording[] = (data.detections ?? [])
          .filter((r): r is { file: string; d?: string; t?: string; conf?: number } => !!r.file)
          .map((r) => ({ file: r.file, d: r.d ?? '', t: r.t ?? '', conf: r.conf ?? 0 }));
        setDetail({
          total: data.summary?.total ?? null,
          firstSeen: data.summary?.first_seen ?? null,
          recordings,
        });
      } catch {
        // aborted on unmount, or a network/parse failure — intentionally quiet.
      }
    })();
    return () => ctrl.abort();
  }, [bird.sci]);

  // Wikipedia summary (species blurb). Same silent-degrade contract as above.
  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/wiki.php?sci=${encodeURIComponent(bird.sci)}`, {
          signal: ctrl.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as { extract?: string | null };
        if (data.extract) setDesc(firstSentences(data.extract, 6));
      } catch {
        // quiet — the description block just stays hidden.
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

  // Retry the illustration when the pose flips — a pose that 404s falls back to
  // the plate, but flipping back should show the working pose again.
  useEffect(() => setImgErr(false), [pose]);

  // Pause + detach the single audio element on unmount so a closed modal goes
  // quiet (and never leaks a playing clip into the next open).
  useEffect(() => {
    return () => {
      const a = audioRef.current;
      if (a) {
        a.pause();
        a.src = '';
        audioRef.current = null;
      }
    };
  }, []);

  // One <audio> element for the whole list: clicking the active row's ▶ pauses
  // it; clicking any other row stops the current clip and starts that one.
  function playRow(file: string): void {
    const cur = audioRef.current;
    if (playing === file && cur) {
      cur.pause();
      setPlaying(null);
      return;
    }
    if (cur) {
      cur.pause();
      cur.src = '';
    }
    const a = new Audio(`${API_BASE}/recording.php?file=${encodeURIComponent(file)}`);
    a.addEventListener('ended', () => setPlaying(null));
    a.addEventListener('error', () => setPlaying(null));
    audioRef.current = a;
    setPlaying(file);
    a.play().catch(() => setPlaying(null));
  }

  const title = bird.com || bird.sci;
  const genus = bird.sci.split(' ')[0] || '—';
  const rarity = rarityLabel(detail?.total ?? null, detail?.firstSeen ?? null);
  const imgUrl = birdImageUrl(bird.slug, bird.sci, pose);
  const recordings = detail?.recordings ?? [];
  const showWindowStat = windowLabel !== 'ALL';

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

        <div className="bp-top">
          {/* ── LEFT · illustration plate + pose toggle ───────────────── */}
          <div className="bp-left">
            <div className="bp-plate">
              {imgUrl && !imgErr ? (
                <img
                  className="bp-illus"
                  src={imgUrl}
                  alt={title}
                  onError={() => setImgErr(true)}
                />
              ) : (
                <div className="bp-sil" aria-hidden="true">
                  {title.slice(0, 1)}
                </div>
              )}

              <div className="bp-pose" role="group" aria-label="Pose">
                <button
                  type="button"
                  className="bp-pose-b"
                  aria-pressed={pose === 1}
                  aria-label="Perched"
                  onClick={() => setPose(1)}
                >
                  perched
                </button>
                <button
                  type="button"
                  className="bp-pose-b"
                  aria-pressed={pose === 2}
                  aria-label="In flight"
                  onClick={() => setPose(2)}
                >
                  flight
                </button>
              </div>
            </div>
          </div>

          {/* ── RIGHT · name, stats, description, meta ─────────────────── */}
          <div className="bp-right">
            <h2 className="bp-name">{title}</h2>
            <div className="bp-sci">{bird.sci}</div>

            <div className="bp-stats">
              {showWindowStat && (
                <div className="bp-stat">
                  <b className="bp-stat-n">{bird.n.toLocaleString()}</b>
                  <span className="bp-stat-l">calls · this {windowLabel}</span>
                </div>
              )}
              <div className="bp-stat">
                <b className="bp-stat-n">{detail?.total != null ? detail.total.toLocaleString() : '—'}</b>
                <span className="bp-stat-l">all-time</span>
              </div>
              <div className="bp-stat">
                <b className="bp-stat-n">{detail?.firstSeen ? fmtRelative(detail.firstSeen.split(' ')[0], detail.firstSeen.split(' ')[1]) : '—'}</b>
                <span className="bp-stat-l">first heard</span>
              </div>
            </div>

            {desc && <p className="bp-desc">{desc}</p>}

            <div className="bp-meta">
              <span className="bp-meta-i">
                <span className="bp-meta-k">genus</span>
                <span className="bp-meta-v">{genus}</span>
              </span>
              {rarity && (
                <span className="bp-meta-i">
                  <span className="bp-meta-k">rarity</span>
                  <span className={rarity === 'rare' ? 'bp-meta-v bp-rare' : 'bp-meta-v'}>{rarity}</span>
                </span>
              )}
            </div>
          </div>
        </div>

        {/* ── RECORDINGS ──────────────────────────────────────────────── */}
        {recordings.length > 0 && (
          <div className="bp-rec">
            <div className="bp-rec-head">
              <h3 className="bp-rec-title">Recordings</h3>
              <span className="bp-rec-count">{recordings.length} captured</span>
            </div>
            <ol className="bp-rec-list">
              {recordings.map((r, i) => {
                const isPlaying = playing === r.file;
                return (
                  <li className="bp-rec-row" key={`${r.file}-${i}`}>
                    <button
                      type="button"
                      className="bp-play"
                      data-active={isPlaying ? 'true' : undefined}
                      aria-label={isPlaying ? 'Pause recording' : 'Play recording'}
                      onClick={() => playRow(r.file)}
                    >
                      {isPlaying ? '❚❚' : '▶'}
                    </button>
                    <span className="bp-when">
                      {fmtRelative(r.d, r.t)}
                      <small>{fmtDateLine(r.d, r.t)}</small>
                    </span>
                    <span className="bp-conf">{Math.round((r.conf || 0) * 100)}%</span>
                  </li>
                );
              })}
            </ol>
          </div>
        )}

        {/* ── external links ──────────────────────────────────────────── */}
        <div className="bp-foot">
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
        </div>
      </div>
    </div>
  );
}
