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
import { phenologyWeeks, type Phenology } from '../almanac';
import { fetchCatalog } from '../catalog';
import { API_BASE } from '../config';
import { formatDay } from '../days';
import { birdImageUrl } from '../img';
import { useBirdImage } from '../useBirdImage';
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
  /** initial dossier pose when restored from a deep link (absent = perched). */
  pose?: 1 | 2;
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
  archiveDay = null,
  onClose,
  onPoseChange,
}: {
  bird: BirdRef | null;
  windowLabel: string;
  /** Pinned past day the roster count belongs to (time-travel scrubber), or
   *  null = live window. Keeps the count's label truthful in archive mode. */
  archiveDay?: string | null;
  onClose: () => void;
  onPoseChange?: (pose: 1 | 2) => void;
}): JSX.Element | null {
  // No hooks here so this early-out never trips the rules of hooks; the keyed
  // Dialog below owns the whole open/close lifecycle.
  if (bird === null) return null;
  return (
    <Dialog
      key={bird.sci}
      bird={bird}
      windowLabel={windowLabel}
      archiveDay={archiveDay}
      onClose={onClose}
      onPoseChange={onPoseChange}
    />
  );
}

// Mounts only while a bird is selected (and remounts per species via the key),
// so opening = mount — focus the close button, wire Escape, fetch detail + wiki —
// and closing = unmount, tearing every listener + the in-flight fetches down.
function Dialog({
  bird,
  windowLabel,
  archiveDay,
  onClose,
  onPoseChange,
}: {
  bird: BirdRef;
  windowLabel: string;
  archiveDay: string | null;
  onClose: () => void;
  onPoseChange?: (pose: 1 | 2) => void;
}): JSX.Element {
  const [detail, setDetail] = useState<SpeciesDetail | null>(null);
  const [desc, setDesc] = useState<string | null>(null);
  // Phenology ribbon data (the species' 52-week presence strip) — from the
  // nightly catalog's widened `weeks` field; null = no ribbon at all.
  const [phen, setPhen] = useState<Phenology | null>(null);
  // Keyed per species, so this init is per-open (deep-link pose restore stays
  // one-shot and a new bird still resets to perched).
  const [pose, setPose] = useState<Pose>(bird.pose ?? 1);
  // Readiness of the current pose's plate (reads cutout.php's X-Av-Real): a
  // still-generating species shows the "painting" loader and auto-swaps to art;
  // re-runs on every pose flip because imgUrl changes. `imgSrc` is the display
  // url (cache-busted once after a pending→ready flip).
  const imgUrl = birdImageUrl(bird.slug, bird.sci, pose);
  const { phase: imgPhase, src: imgSrc } = useBirdImage(imgUrl);
  const [playing, setPlaying] = useState<string | null>(null);
  // The single expanded recording row (spectrogram band open). Opening another
  // collapses this one — one clip open/playing at a time. `progress` is the 0..1
  // playhead fraction for that open row; `specFailed` remembers which clips'
  // spectrogram PNGs 404'd so we degrade to a plain grey scrubber quietly.
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [specFailed, setSpecFailed] = useState<Set<string>>(() => new Set());
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const bandRef = useRef<HTMLDivElement | null>(null);
  const openRowRef = useRef<HTMLLIElement | null>(null);
  const draggingRef = useRef(false);

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
        // Consistent order regardless of what the API returns: newest first,
        // then higher confidence as the tie-break within the same timestamp.
        recordings.sort((a, b) => {
          const ta = Date.parse(`${a.d}T${a.t || '00:00:00'}`) || 0;
          const tb = Date.parse(`${b.d}T${b.t || '00:00:00'}`) || 0;
          if (tb !== ta) return tb - ta;
          return (b.conf || 0) - (a.conf || 0);
        });
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

  // Phenology: self-fetch the nightly catalog and match this species' row for
  // its ISO-week presence data. fetchCatalog never throws (a miss → []), so an
  // unmatched species / a pre-weeks build just leaves the ribbon hidden.
  useEffect(() => {
    let alive = true;
    fetchCatalog()
      .then((list) => {
        if (!alive) return;
        const match = list.find((s) => s.sci_name === bird.sci);
        setPhen(match ? phenologyWeeks(match) : null);
      })
      .catch(() => {
        // defensive — the ribbon just stays hidden.
      });
    return () => {
      alive = false;
    };
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

  // Drive the playhead from a requestAnimationFrame loop (smoother than the ~4Hz
  // `timeupdate` event) while a clip plays. Scoped to `playing`: it starts when a
  // row begins, and its cleanup cancels the frame on pause / ended / switch /
  // unmount — so the loop never survives the modal. `duration` is NaN until
  // metadata loads, so the guard keeps progress at 0 until the clip is seekable.
  useEffect(() => {
    if (playing == null) return;
    let raf = 0;
    const tick = (): void => {
      const a = audioRef.current;
      if (a && a.duration && Number.isFinite(a.duration)) setProgress(a.currentTime / a.duration);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // Nudge a freshly-opened row into view — the band adds ~110px, which can push
  // it under the scrollable list's fold.
  useEffect(() => {
    if (openFile) openRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [openFile]);

  // Expand a row into its spectrogram band and start its clip on the one shared
  // <audio> element. Any previously-open row is stopped + collapsed first, so
  // only one is ever open/playing. A recording.php 404 (or mock dev) fires the
  // audio `error` → we drop `playing` but keep the band open as an inert grey
  // scrubber, mirroring the modal's quiet-degrade contract.
  function openRow(file: string): void {
    const cur = audioRef.current;
    if (cur) {
      cur.pause();
      cur.src = '';
    }
    setProgress(0);
    setOpenFile(file);
    const a = new Audio(`${API_BASE}/recording.php?file=${encodeURIComponent(file)}`);
    // Rewind the playhead on end but keep the element for replay; play() on an
    // ended clip re-seeks to 0 per spec, so the ▶ button replays it.
    a.addEventListener('ended', () => {
      setPlaying(null);
      setProgress(0);
    });
    a.addEventListener('error', () => setPlaying(null));
    audioRef.current = a;
    setPlaying(file);
    a.play().catch(() => setPlaying(null));
  }

  // Row-header click: open+play this clip, or collapse+stop it if already open.
  function toggleRow(file: string): void {
    if (openFile === file) {
      const cur = audioRef.current;
      if (cur) {
        cur.pause();
        cur.src = '';
        audioRef.current = null;
      }
      setOpenFile(null);
      setPlaying(null);
      setProgress(0);
      return;
    }
    openRow(file);
  }

  // The ▶/❚❚ control on the open row: pause/resume without collapsing (so you
  // can scrub a paused clip and resume). Opens the row if it wasn't already.
  function playPause(file: string): void {
    const a = audioRef.current;
    if (openFile !== file || !a) {
      openRow(file);
      return;
    }
    if (playing === file) {
      a.pause();
      setPlaying(null);
    } else {
      setPlaying(file);
      a.play().catch(() => setPlaying(null));
    }
  }

  // Map a pointer x onto the band's width → 0..1 → currentTime. setProgress runs
  // even when paused (rAF isn't looping then) so the line tracks a paused scrub.
  function seek(clientX: number): void {
    const band = bandRef.current;
    if (!band) return;
    const rect = band.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const a = audioRef.current;
    if (a && a.duration && Number.isFinite(a.duration)) a.currentTime = pct * a.duration;
    setProgress(pct);
  }

  const title = bird.com || bird.sci;
  const genus = bird.sci.split(' ')[0] || '—';
  const rarity = rarityLabel(detail?.total ?? null, detail?.firstSeen ?? null);
  const recordings = detail?.recordings ?? [];
  // An archive-day count is always a real per-day figure, so it always shows;
  // the live count hides only under ALL, where "this window" is a non-claim.
  const showWindowStat = archiveDay !== null || windowLabel !== 'ALL';

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
              {imgPhase === 'ready' && imgSrc ? (
                <img className="bp-illus" src={imgSrc} alt={title} />
              ) : imgPhase === 'pending' ? (
                <div className="bp-gen" role="img" aria-label={`Painting ${title}`}>
                  <span className="bp-gen-sil" aria-hidden="true">
                    <svg viewBox="0 0 84 60" fill="currentColor" role="img">
                      <path d="M8 22 L30 31 L21 44 Z" />
                      <ellipse cx="45" cy="34" rx="22" ry="16" />
                      <circle cx="61" cy="21" r="12" />
                      <path d="M71 15 L84 13 L72 25 Z" />
                    </svg>
                  </span>
                  <span className="bp-gen-cap" aria-hidden="true">painting</span>
                </div>
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
                  onClick={() => {
                    setPose(1);
                    onPoseChange?.(1);
                  }}
                >
                  perched
                </button>
                <button
                  type="button"
                  className="bp-pose-b"
                  aria-pressed={pose === 2}
                  aria-label="In flight"
                  onClick={() => {
                    setPose(2);
                    onPoseChange?.(2);
                  }}
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
                  <span className="bp-stat-l">
                    {archiveDay ? `calls · ${formatDay(archiveDay)}` : `calls · this ${windowLabel}`}
                  </span>
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

        {/* ── PHENOLOGY — 52-week presence ribbon ─────────────────────── */}
        {/* Blank cells are empty grooves (weeks NOT heard — never interpolated);
            ink opacity scales with the real weekly count. */}
        {phen && (
          <div className="bp-phen">
            <div className="bp-phen-head">
              <h3 className="bp-phen-title">Across the Year</h3>
              <span className="bp-phen-cap">weeks {title} was heard</span>
            </div>
            <div className="bp-phen-ribbon" aria-hidden="true">
              {phen.cells.map((c, i) => (
                <span
                  key={i}
                  className="bp-phen-cell"
                  data-on={c > 0 ? 'true' : undefined}
                  style={c > 0 ? { opacity: 0.25 + 0.75 * (c / phen.maxWeek) } : undefined}
                />
              ))}
            </div>
            <div className="bp-phen-ax">
              <span>Jan</span>
              <span>Apr</span>
              <span>Jul</span>
              <span>Oct</span>
            </div>
          </div>
        )}

        {/* ── RECORDINGS ──────────────────────────────────────────────── */}
        {recordings.length > 0 && (
          <div className="bp-rec">
            <div className="bp-rec-head">
              <h3 className="bp-rec-title">Recordings</h3>
              <span className="bp-rec-count">{recordings.length} captured</span>
            </div>
            <ol className="bp-rec-list">
              {recordings.map((r, i) => {
                const isOpen = openFile === r.file;
                const isPlaying = playing === r.file;
                return (
                  <li
                    className="bp-rec-row"
                    data-open={isOpen ? 'true' : undefined}
                    ref={isOpen ? openRowRef : undefined}
                    key={`${r.file}-${i}`}
                  >
                    <div className="bp-rec-main" onClick={() => toggleRow(r.file)}>
                      <button
                        type="button"
                        className="bp-play"
                        data-active={isPlaying ? 'true' : undefined}
                        aria-label={isPlaying ? 'Pause recording' : 'Play recording'}
                        onClick={(e) => {
                          e.stopPropagation();
                          playPause(r.file);
                        }}
                      >
                        {isPlaying ? '❚❚' : '▶'}
                      </button>
                      <span className="bp-when">
                        {fmtRelative(r.d, r.t)}
                        <small>{fmtDateLine(r.d, r.t)}</small>
                      </span>
                      <span className="bp-conf">{Math.round((r.conf || 0) * 100)}%</span>
                    </div>

                    {isOpen && (
                      <div
                        className="bp-spectro"
                        ref={bandRef}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          e.currentTarget.setPointerCapture(e.pointerId);
                          draggingRef.current = true;
                          seek(e.clientX);
                        }}
                        onPointerMove={(e) => {
                          if (draggingRef.current) seek(e.clientX);
                        }}
                        onPointerUp={(e) => {
                          draggingRef.current = false;
                          e.currentTarget.releasePointerCapture(e.pointerId);
                        }}
                        onPointerCancel={() => {
                          draggingRef.current = false;
                        }}
                      >
                        {!specFailed.has(r.file) && (
                          <img
                            className="bp-spectro-img"
                            alt=""
                            src={`${API_BASE}/spectrogram.php?file=${encodeURIComponent(r.file)}`}
                            onError={() =>
                              setSpecFailed((prev) => new Set(prev).add(r.file))
                            }
                          />
                        )}
                        <div className="bp-spectro-played" style={{ width: `${progress * 100}%` }} />
                        <div className="bp-spectro-cursor" style={{ left: `${progress * 100}%` }} />
                      </div>
                    )}
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
