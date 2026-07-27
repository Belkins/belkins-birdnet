// BIRD POPUP — the rich species dossier opened by clicking a bird in the collage
// or an Atlas plate. A wide, two-column editorial modal that matches (and gently
// exceeds) the legacy detail modal:
//
//   LEFT   a bordered plate with the large kachō-e cutout + a perched/flight
//          pose toggle (birdImageUrl's pose arg); a broken image collapses to a
//          bounded letter plate, never an unbounded circle.
//   RIGHT  the display name, italic scientific name, the Library's 1838 line
//          for this bird (when Jardine gave it an account), 2–3 stat cards
//          (window / all-time / first-heard), the Wikipedia blurb, and a
//          genus · rarity meta line.
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
import { API_BASE, ATTEST_URL } from '../config';
import { formatDay } from '../days';
import { birdImageUrl } from '../img';
import {
  counterpointFor,
  fetchJardine,
  firstSentence,
  weakSource,
  type JardineSpecies,
} from '../jardine';
import { clearBird, writeRead, writeTab } from '../url';
import { useBirdImage } from '../useBirdImage';
import { useRepaint, type RepaintPhase } from '../repaint';
import { downloadPlateCard } from '../export-card';
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
export function fmtRelative(d: string | null, t: string | null): string {
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

/** 24 → "XXIV". The Naturalist's Library is forty volumes and always will be,
 *  so the table stops at XL; anything outside 1–40 falls back to the plain
 *  figure rather than inventing a numeral. Exported so the Library tab cites
 *  its volumes through this one converter. */
export function volumeRoman(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 40) return String(n);
  const table: Array<[number, string]> = [
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ];
  let out = '';
  let rest = n;
  for (const [v, s] of table) {
    while (rest >= v) {
      out += s;
      rest -= v;
    }
  }
  return out;
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

/** One-shot cache-bust after a repaint arrival (the withParam pattern): the
 *  plain cutout URL may still hold the OLD art in the browser cache. */
function withBust(url: string, ts: number): string {
  return `${url}${url.includes('?') ? '&' : '?'}rb=${ts}`;
}

export function BirdPopup({
  bird,
  windowLabel,
  archiveDay = null,
  repaintEnabled = false,
  onClose,
  onPoseChange,
}: {
  bird: BirdRef | null;
  windowLabel: string;
  /** Pinned past day the roster count belongs to (time-travel scrubber), or
   *  null = live window. Keeps the count's label truthful in archive mode. */
  archiveDay?: string | null;
  /** The `repaintPlate` setting. The Pi pool env is the true gate — even ON,
   *  an unarmed regen.php answers 503 and the button never renders. */
  repaintEnabled?: boolean;
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
      repaintEnabled={repaintEnabled}
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
  repaintEnabled,
  onClose,
  onPoseChange,
}: {
  bird: BirdRef;
  windowLabel: string;
  archiveDay: string | null;
  repaintEnabled: boolean;
  onClose: () => void;
  onPoseChange?: (pose: 1 | 2) => void;
}): JSX.Element {
  const [detail, setDetail] = useState<SpeciesDetail | null>(null);
  const [desc, setDesc] = useState<string | null>(null);
  // Phenology ribbon data (the species' 52-week presence strip) — from the
  // nightly catalog's widened `weeks` field; null = no ribbon at all.
  const [phen, setPhen] = useState<Phenology | null>(null);
  // Pinned museum accession number for this species (from the nightly catalog),
  // used only to stamp a saved plate card. null until the catalog resolves.
  const [accession, setAccession] = useState<number | null>(null);
  // One-shot guard so a double-click never kicks off two card renders at once.
  const [saving, setSaving] = useState(false);
  // Keyed per species, so this init is per-open (deep-link pose restore stays
  // one-shot and a new bird still resets to perched).
  const [pose, setPose] = useState<Pose>(bird.pose ?? 1);
  // Conservator's Mark state (see the /attest fetch below); null = no mark.
  const [attest, setAttest] = useState<'attested' | 'caveat' | 'unexamined' | null>(null);
  // THE RETURN LEG — this species' account in Jardine's Naturalist's Library
  // (1833–1843), or null when the library has none. Thirteen of the forty birds
  // heard in this garden have no account, and four of those are corvids he wrote
  // thousands of words about without once describing the noise they make. That
  // is content, not a gap: the block simply renders nothing.
  const [jardine, setJardine] = useState<JardineSpecies | null>(null);
  // Readiness of the current pose's plate (reads cutout.php's X-Av-Real): a
  // still-generating species shows the "painting" loader and auto-swaps to art;
  // re-runs on every pose flip because imgUrl changes. `imgSrc` is the display
  // url (cache-busted once after a pending→ready flip).
  const imgUrl = birdImageUrl(bird.slug, bird.sci, pose);
  const { phase: imgPhase, src: imgSrc } = useBirdImage(imgUrl);
  // The `repaint ↺` gesture: a viewer asks the museum to repaint THIS pose. The
  // machine is dark unless the setting is on AND the Pi's regen.php is armed
  // (its status probe answers → phase leaves 'unavailable'); the old plate keeps
  // hanging until a QA-passing successor lands (never-worse). `swappedAt` fires a
  // one-shot cache-bust so the swapped-in art bypasses the browser's old copy.
  const repaint = useRepaint(bird.sci, pose, repaintEnabled);
  const [bust, setBust] = useState(0);
  useEffect(() => {
    if (repaint.swappedAt) setBust(repaint.swappedAt);
  }, [repaint.swappedAt]);
  // The displayed plate url: the ready art, cache-busted once after a repaint
  // arrival so the flushed-and-re-proxied fresh plate replaces the stale one.
  const plateSrc = imgSrc && bust ? withBust(imgSrc, bust) : imgSrc;
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

  // Conservator's Mark: the judge's verdict on the HANGING perched plate,
  // fetched from birdgen's public /attest. 'attested' | 'caveat' |
  // 'unexamined'; null = no mark row at all (bundled art 404s — the founder's
  // canon was never machine-judged, so it carries no seal). Re-fetched after a
  // repaint lands (bust) because the new plate carries its own verdict.
  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch(`${ATTEST_URL}/${encodeURIComponent(bird.slug)}`, {
          signal: ctrl.signal,
        });
        if (!res.ok) return; // 404 = bundled plate → no mark, by design
        const data = (await res.json()) as { state?: string };
        if (data.state === 'attested' || data.state === 'caveat' || data.state === 'unexamined') {
          setAttest(data.state);
        }
      } catch {
        // Railway unreachable from the frame — the mark just stays absent.
      }
    })();
    return () => ctrl.abort();
  }, [bird.slug, bust]);

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
        setAccession(match?.accession ?? null);
      })
      .catch(() => {
        // defensive — the ribbon just stays hidden.
      });
    return () => {
      alive = false;
    };
  }, [bird.sci]);

  // The Library row for this species. fetchJardine() is session-memoised and
  // never throws (a missing jardine.json collapses to an empty shape), so the
  // join is the same selector the catalog uses above — sci_name, never the slug
  // and never the common name.
  useEffect(() => {
    let alive = true;
    fetchJardine()
      .then((doc) => {
        if (!alive) return;
        setJardine(doc?.species.find((r) => r.sci_name === bird.sci) ?? null);
      })
      .catch(() => {
        // defensive — the Jardine line just stays absent.
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

  // Leave the reading room open on the Library tab. The URL is App's source of
  // truth for the tab (App.tsx's popstate handler re-reads it), so this reuses
  // url.ts's own writers — clearBird first, or the re-read would immediately
  // reopen this dossier on top of the tab it just went to.
  // THE AIM. This used to clear the bird and write no replacement, so the
  // Library fell through to "the loudest bird in the window" — and with this
  // garden's 81% three-bird concentration that meant the Robin or the Parakeet
  // almost regardless of which bird the reader had open. The button announced
  // one destination and delivered another. Now it names the bird.
  function openInLibrary(): void {
    clearBird();
    writeRead(bird.sci);
    writeTab('library');
    window.dispatchEvent(new PopStateEvent('popstate'));
    onClose();
  }

  const title = bird.com || bird.sci;
  const genus = bird.sci.split(' ')[0] || '—';
  // The 1838 name is printed only when it is NOT the one above it — an unchanged
  // binomial would just repeat the line it sits under. The sentence is a verbatim
  // slice via jardine.ts's own firstSentence(), OCR artefacts and all.
  const jardineName =
    jardine && jardine.jardine_binomial && jardine.jardine_binomial !== bird.sci
      ? jardine.jardine_binomial
      : null;
  // What the library has to say — an 1838 sentence, or the museum's own account
  // of why there isn't one. Routed through jardine.ts's ONE branch point so this
  // dossier and the Library's Index of Silences can never disagree about which
  // birds are silent. Before this, a voice:null bird rendered its binomial, then
  // "Vol. XXIV", then nothing at all — sixteen of forty-seven species, including
  // the Blue Tit, which is 8.5% of everything this garden has ever heard.
  const counterpoint = counterpointFor(jardine);
  const jardineVoice =
    counterpoint?.kind === 'voice' ? firstSentence(counterpoint.passage.text) : null;
  const rarity = rarityLabel(detail?.total ?? null, detail?.firstSeen ?? null);
  const recordings = detail?.recordings ?? [];

  // Save a museum plate CARD of this bird via the shared export engine — the same
  // seat-ink + kachō-e treatment as the wall. Every stamped field is a real value
  // (accession, all-time count, first-heard, rarity band) or omitted; no number is
  // invented. A missing cutout degrades to a wordmark card. Guarded against
  // double-fire; failures stay quiet (the modal's degrade contract).
  async function saveCard(): Promise<void> {
    if (saving) return;
    setSaving(true);
    try {
      await downloadPlateCard({
        slug: bird.slug,
        sci: bird.sci,
        com: title,
        pose,
        accession,
        detectionCount: detail?.total ?? null,
        firstConfident: detail?.firstSeen ? detail.firstSeen.split(' ')[0] : null,
        rarityLabel: rarity,
        attest: attest === 'attested' || attest === 'caveat' ? attest : null,
        theme: 'day',
      });
    } catch {
      // quiet — a failed export never disrupts the dossier.
    } finally {
      setSaving(false);
    }
  }
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
              {imgPhase === 'ready' && plateSrc ? (
                <img className="bp-illus" src={plateSrc} alt={title} />
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

              {/* A quiet corner whisper while a repaint is in flight: the OLD
                  plate keeps hanging (never-worse), so this is the only signal
                  that the studio is at work. aria-live so a reader is told. */}
              {repaint.phase === 'painting' && (
                <div className="bp-repainting" aria-live="polite">
                  repainting…
                </div>
              )}
            </div>
          </div>

          {/* ── RIGHT · name, stats, description, meta ─────────────────── */}
          <div className="bp-right">
            <h2 className="bp-name">{title}</h2>
            <div className="bp-sci">{bird.sci}</div>

            {/* ── THE RETURN LEG — the same bird, as the library had it ──── */}
            {/* One line from 1838 under the modern name: the binomial as it was
                printed (when it has since moved), the opening of the passage on
                its voice (when he wrote one), and the volume it stands in. The
                speaker is printed with every passage, always — the volume author
                is never assumed. No row → nothing renders, and that silence is
                the honest answer, not an empty state. */}
            {jardine && (
              <div className="bp-jard">
                {jardineName && (
                  <div className="bp-jard-name">
                    <span
                      className="bp-jard-bin"
                      data-weak={weakSource(jardine) ? 'true' : undefined}
                      title={weakSource(jardine) ?? undefined}
                    >
                      {jardineName}
                    </span>
                    {jardine.jardine_authority && (
                      <span className="bp-jard-auth">{jardine.jardine_authority}</span>
                    )}
                  </div>
                )}
                {jardineVoice && <p className="bp-jard-voice prose-nums">{jardineVoice}</p>}
                {counterpoint?.kind === 'silence' && (
                  <p className="bp-jard-silence">{counterpoint.note}</p>
                )}
                <div className="bp-jard-cite">
                  <span className="bp-jard-src">
                    {jardineVoice && jardine.voice?.speaker ? `${jardine.voice.speaker} · ` : ''}
                    Vol. {volumeRoman(jardine.volume)}
                  </span>
                  <button
                    type="button"
                    className="bp-lnk bp-lnk-b"
                    onClick={openInLibrary}
                    aria-label={`Open ${title} in the Library`}
                  >
                    in the library →
                  </button>
                </div>
              </div>
            )}

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
              {/* Conservator's Mark — the honesty rule is LOCKED: fail-open and
                  accept-with-flag never render as a clean seal. Bundled plates
                  (attest === null) carry no mark at all. */}
              {attest && (
                <span className="bp-meta-i">
                  <span className="bp-meta-k">conservator</span>
                  {attest === 'attested' ? (
                    <span className="bp-meta-v">
                      <i className="bp-seal bp-seal-full" aria-hidden="true" />
                      attested
                    </span>
                  ) : attest === 'caveat' ? (
                    <span className="bp-meta-v">
                      <i className="bp-seal bp-seal-ring" aria-hidden="true" />
                      attested · with caveat
                    </span>
                  ) : (
                    <span className="bp-meta-v bp-attest-dim">not yet examined</span>
                  )}
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

        {/* ── actions + external links ────────────────────────────────── */}
        <div className="bp-foot">
          {/* repaint ↺ — the FIRST footer action (docs/POPUP-BUDGET.md caps the
              action zone at two: repaint + save plate). The one slot transforms
              through the whole lifecycle; nothing is ever added or floated.
              Absent entirely for paused/unavailable — a wall object shows no
              dead control (Pillar 4, degrade to silence). */}
          <RepaintControl
            phase={repaint.phase}
            retryAfterS={repaint.retryAfterS}
            pose={pose}
            silhouette={imgPhase === 'none'}
            firstPainting={imgPhase === 'pending'}
            onPress={repaint.press}
            onKeep={repaint.keep}
          />
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
          <button
            type="button"
            className="bp-lnk bp-lnk-b bp-lnk-right"
            onClick={saveCard}
            disabled={saving}
            aria-label="Save a plate card of this bird"
          >
            {saving ? 'saving…' : 'save plate ↓'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── repaint control ───────────────────────────────────────────────────────────
// One footer slot that transforms across the whole repaint lifecycle — the
// museum-copy sheet, states 1-11, verbatim. It never adds elements: rest →
// confirm (two choices) → painting… → silent success, or the calm terminal
// caption. Never an error, never a percentage, never an exclamation. The button
// is simply ABSENT for paused / unavailable — a wall object shows no dead
// control (Pillar 4). `pose` names the confirm ("a new perched / flight plate").
function RepaintControl({
  phase,
  retryAfterS,
  pose,
  silhouette,
  firstPainting,
  onPress,
  onKeep,
}: {
  phase: RepaintPhase;
  retryAfterS: number | null;
  pose: Pose;
  silhouette: boolean;
  firstPainting: boolean;
  onPress: () => void;
  onKeep: () => void;
}): JSX.Element | null {
  // State 3: a plate still on its FIRST painting owns the story via the loader —
  // there is nothing yet to repaint. States 9/10: paused / unavailable → silence.
  if (firstPainting || phase === 'unavailable' || phase === 'paused') return null;

  const poseWord = pose === 2 ? 'flight' : 'perched';

  switch (phase) {
    // State 4 — confirm (after one press): the same slot, transformed.
    case 'confirm':
      return (
        <span className="bp-repaint bp-repaint-confirm" role="group" aria-label="Confirm repaint">
          <span className="bp-repaint-q">paint a new {poseWord} plate?</span>
          <button type="button" className="bp-lnk bp-lnk-b" onClick={onPress}>
            yes, repaint
          </button>
          <button type="button" className="bp-lnk bp-lnk-b" onClick={onKeep}>
            keep
          </button>
        </span>
      );
    // State 5 — painting (request accepted; the old plate stays on the wall).
    case 'requesting':
    case 'painting':
      return (
        <span className="bp-lnk bp-repaint-msg" aria-live="polite">
          painting…
        </span>
      );
    // State 7 — cooldown (this species was repainted recently).
    case 'cooldown':
      return (
        <span
          className="bp-lnk bp-repaint-msg"
          aria-label={
            retryAfterS
              ? `Recently repainted — available again in about ${Math.ceil(retryAfterS / 60)} minutes`
              : 'Recently repainted — available again later'
          }
        >
          still drying
        </span>
      );
    // State 8 — parked / failed: the slot becomes a calm caption about the future.
    case 'parked':
      return <span className="bp-repaint-caption">The painter will return to this plate.</span>;
    // States 1/2/6 — rest (real art, or silhouette, or just after a swap).
    default:
      return (
        <button
          type="button"
          className="bp-lnk bp-lnk-b"
          onClick={onPress}
          aria-label={silhouette ? 'Ask for this plate to be painted' : 'Repaint this plate'}
        >
          {silhouette ? 'paint this plate ↺' : 'repaint ↺'}
        </button>
      );
  }
}
