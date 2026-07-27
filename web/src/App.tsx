import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import './App.css';
import { CollageEngine } from './collage';
import { MOCK, SNAPSHOT_HOURS } from './config';
import { loadSettings, saveSettings } from './settings';
import type { Settings } from './settings';
import type { LiveState, RosterRow } from './types';
import { counterFrom } from './counter';
import { LiveCounter } from './components/LiveCounter';
import { SettingsPanel } from './views/Settings';
import { FrameOverlay } from './views/FrameOverlay';
import { useFrameMode } from './frame';
import { FRAME_AT_BOOT, markFrameReady, PROFILE } from './profile';
import { IndexView } from './views/IndexView';
import { StatsView } from './views/StatsView';
import { AtlasView } from './views/AtlasView';
import { BirdPopup, type BirdRef } from './components/BirdPopup';
import { CollectionWallView } from './views/CollectionWallView';
import { LibraryView } from './views/LibraryView';
import { LibraryFrameView } from './views/LibraryFrameView';
import { LiveView } from './views/LiveView';
import type { FeedRow } from './views/LiveView';
import {
  readUrl,
  writeTab,
  writeBird,
  clearBird,
  writePose,
  writeOn,
  clearRead,
} from './url';
import { fetchCatalog } from './catalog';
import { Scrubber } from './components/Scrubber';
import { fetchDayActivity, formatDay, isoDay } from './days';
import type { DayActivity } from './days';
import { fetchDaySnapshot } from './snapshot';

type Tab = 'collage' | 'index' | 'stats' | 'atlas' | 'wall' | 'library';

const PERIODS: { label: string; hours: number }[] = [
  { label: '1H', hours: 1 },
  { label: '12H', hours: 12 },
  { label: '24H', hours: 24 },
  { label: '7D', hours: 168 },
  { label: 'ALL', hours: 1_000_000 },
];
const TABS: Tab[] = ['collage', 'index', 'stats', 'atlas', 'wall', 'library'];

/** Active-window label for the given hours (falls back to 24H). */
function windowLabelFor(hours: number): string {
  return (PERIODS.find((p) => p.hours === hours) ?? PERIODS[2]).label;
}

const TAB_STORAGE_KEY = 'belkins-birdnet-tab';

// Deep-link params, parsed once at module load (the profile.ts parse-once
// pattern): ?tab= seeds the initial tab, ?bird=/?pose= restore a dossier after
// the boot snapshot settles.
const BOOT_URL = readUrl();

/** Narrow an untrusted string (URL param / localStorage) to a Tab, else null. */
function asTab(v: string | null): Tab | null {
  return v === 'collage' || v === 'index' || v === 'stats' || v === 'atlas' || v === 'wall' || v === 'library' ? v : null;
}

/** Restore the last-viewed tab (persisted separately from the Settings blob). */
function loadTab(): Tab {
  try {
    return asTab(localStorage.getItem(TAB_STORAGE_KEY)) ?? 'collage';
  } catch {
    /* storage unavailable — fall through to the default */
  }
  return 'collage';
}

/** Masthead / tombstone title by real-species tier (DESIGN-SPEC §6.1). Keyed on
 *  the honest species count (rows.length), never on the on-screen tile count. */
function mastTitle(species: number): string {
  if (species === 0) return 'LISTENING';
  if (species === 1) return 'FIRST VISITOR';
  if (species <= 3) return 'HEARD TODAY';
  return 'HEARD RECENTLY';
}

/** Forward a settings change into the live engine. Diff-aware on purpose: only
 *  the key(s) that actually changed are pushed, so a cheap toggle (colophon,
 *  listening, …) never triggers the snapshot re-seed that `setWindow` performs.
 *  (Rule 7: chose this over the literal "call all four setters on every patch".) */
function applyEffects(engine: CollageEngine, next: Settings, changed: Partial<Settings>): void {
  if ('theme' in changed) engine.setTheme(next.theme);
  if ('windowHours' in changed) void engine.setWindow(next.windowHours);
  if ('ambientFill' in changed || 'density' in changed) engine.setAmbient(next.ambientFill, next.density);
  if ('ambientMotion' in changed) engine.setMotion(next.ambientMotion);
  if ('solarLight' in changed) engine.setSolar(next.solarLight);
}

function Overlay({ children }: { children: ReactNode }) {
  return <div className="overlay">{children}</div>;
}

/** Archive-mode stand-in for the LiveCounter (same tombstone register): the
 *  pinned day over its species figure over a quiet ARCHIVE row with the
 *  one-tap NOW return. No dot, no ticker — a past day has no live state. */
function ArchiveCaption({ day, species, onNow }: { day: string; species: number; onNow: () => void }) {
  return (
    <div className="archive-cap">
      <div className="ac-day">{formatDay(day)}</div>
      <div className="ac-fig">{species} species</div>
      <div className="ac-row">
        <span className="ac-lab">ARCHIVE</span>
        <button className="ac-now" onClick={onNow}>
          NOW
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<CollageEngine | null>(null);

  // Seed from the persisted blob, then let the Display Profile (?win= / ?motion=)
  // override so a kiosk/e-ink deploy boots with its configured window + motion.
  const [settings, setSettings] = useState<Settings>(() => {
    const s = loadSettings();
    if (PROFILE.windowHours !== 24) s.windowHours = PROFILE.windowHours;
    if (PROFILE.motion !== 'auto') s.ambientMotion = PROFILE.motion === 'on';
    return s;
  });
  // Always-current mirror of `settings` so the stable `patch` + keyboard handler
  // read the latest values without a fresh closure every render.
  const settingsRef = useRef(settings);

  // URL wins over localStorage so a shared ?tab= link boots into that view.
  const [tab, setTab] = useState<Tab>(() => asTab(BOOT_URL.tab) ?? loadTab());
  // THE AIM (?read=) — which bird the Library's desk should open on. Seeded
  // from the boot URL and refreshed on popstate, exactly like `tab`.
  const [aim, setAim] = useState<string | null>(() => BOOT_URL.read);
  const [rows, setRows] = useState<RosterRow[]>([]);
  const [status, setStatus] = useState('starting');
  const [latest, setLatest] = useState('');
  const [liveState, setLiveState] = useState<LiveState>('connecting');
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The bird-detail modal target (C5). null = closed; a click on the collage
  // canvas or an Atlas plate sets it, and BirdPopup enriches it on open.
  const [popup, setPopup] = useState<BirdRef | null>(null);
  // Always-current roster mirror (same pattern as settingsRef) so the deep-link
  // resolver reads the live roster without re-subscribing on every SSE tick.
  const rowsRef = useRef<RosterRow[]>([]);
  // One-shot boot ?bird= deep link, consumed once the roster is real.
  const pendingBirdRef = useRef(
    BOOT_URL.birdSlug ? { slug: BOOT_URL.birdSlug, pose: BOOT_URL.pose } : null,
  );
  // Open→closed edge detection for the popup→URL sync (null→null never writes).
  const prevPopupRef = useRef<BirdRef | null>(null);
  // Flips true once the boot snapshot — and any persisted-window re-seed — has
  // settled, so ?bird= resolves against a REAL roster, never a guess.
  const [bootDone, setBootDone] = useState(false);
  // Hover affordance: a cursor-following tooltip over the collage canvas. Its
  // POSITION is written straight to the ref's transform on every mousemove (no
  // re-render); its CONTENT changes state only when the hovered species flips —
  // hoverSlugRef guards that so the canvas doesn't re-render every pixel.
  const [hovered, setHovered] = useState<{ com: string; n: number } | null>(null);
  const hoverElRef = useRef<HTMLDivElement | null>(null);
  const hoverSlugRef = useRef<string | null>(null);
  // Real-time feed for the 1H live dashboard, derived from roster deltas.
  const [feed, setFeed] = useState<FeedRow[]>([]);
  const feedBaseRef = useRef<{ hours: number; counts: Map<string, number> } | null>(null);
  // Time-travel scrubber: the pinned past day (null = live NOW), the zero-filled
  // per-day activity strip, and whether the deployed API can serve days at all
  // (the mount probe + `on` echo keep an old Pi's live data from ever
  // masquerading as an archive day).
  const [viewDay, setViewDay] = useState<string | null>(null);
  const [dayStrip, setDayStrip] = useState<DayActivity[]>([]);
  const [scrubOk, setScrubOk] = useState(false);
  // Always-current mirrors (settingsRef pattern) for the stable keyboard /
  // popstate handlers, plus a selection seq so a stale setDay resolution can
  // never pin the wrong day or hide the scrubber after a newer action.
  const viewDayRef = useRef<string | null>(null);
  const dayStripRef = useRef<DayActivity[]>([]);
  const selectSeqRef = useRef(0);
  // One-shot boot ?on= deep link (a kiosk may park on ?frame=1&on=<day>).
  const pendingOnRef = useRef(BOOT_URL.on);

  const theme = settings.theme;

  // Frame / Wall mode — the chrome-free fullscreen surface (spec §5). enter/exit
  // are referentially stable; entering closes the Settings drawer over it. We
  // destructure so the effects below can depend on the stable pieces directly.
  const { frame: framed, enter: enterFrame, exit: exitFrame } = useFrameMode({
    idleSec: settings.autoFrameIdleSec,
    theme,
    onEnter: () => setSettingsOpen(false),
  });

  // A single settings mutation: merge, persist, and forward the delta to the
  // engine. Stable (reads the latest settings via a ref) so the keyboard
  // listener can depend on it without re-subscribing on every render.
  const patch = useCallback((p: Partial<Settings>): void => {
    const next: Settings = { ...settingsRef.current, ...p };
    settingsRef.current = next;
    setSettings(next);
    saveSettings(next); // persists the blob + mirrors theme through theme.ts
    const engine = engineRef.current;
    if (engine) applyEffects(engine, next, p);
  }, []);

  // Resolve a ?bird= slug into an open dossier: the live roster first (real
  // window count), else the all-time catalog (honest zero in this window),
  // else strip the params silently — never fabricate a species.
  const openFromUrl = useCallback((slug: string, pose: 1 | 2): void => {
    const row = rowsRef.current.find((r) => r.slug === slug);
    if (row) {
      setPopup({ sci: row.sci, com: row.com, slug: row.slug, n: row.n, pose });
      return;
    }
    void fetchCatalog().then((cat) => {
      const c = cat.find((s) => s.slug === slug && s.sci_name !== '');
      if (c) setPopup({ sci: c.sci_name, com: c.com_name || c.sci_name, slug: c.slug, n: 0, pose });
      else clearBird();
    });
  }, []);

  // Pin the collage to one past day, or null = the one-tap return to NOW.
  // App NEVER writes viewDay here: the engine emits every re-seed tagged with
  // its day (onData), and that emission is the single writer — so the label,
  // the roster, and the feed can never disagree about WHICH data is on screen
  // (a failed return-to-NOW honestly stays in archive mode). Only a true
  // 'unsupported' (old API) hides the scrubber; a transient error or a
  // superseded click never does.
  const selectDay = useCallback((day: string | null): void => {
    const engine = engineRef.current;
    if (!engine) return;
    ++selectSeqRef.current;
    if (day === null) {
      void engine.setWindow(settingsRef.current.windowHours);
      return;
    }
    void engine.setDay(day).then((res) => {
      if (res === 'unsupported') setScrubOk(false); // API can't do days — hide, silently
    });
  }, []);

  // Mirror kept in step for the stable keyboard / popstate handlers.
  useEffect(() => {
    viewDayRef.current = viewDay;
  }, [viewDay]);

  // Engine + canvas live for the whole session — never unmounted on tab switch.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const engine = new CollageEngine(canvas, {
      onStatus: setStatus,
      onLatest: setLatest,
      onData: (r, archiveDay) => {
        rowsRef.current = r;
        // Batched with setRows: rows and their archive/live tag land in ONE
        // commit, so no render can pair archive counts with a live label.
        setRows(r);
        setViewDay(archiveDay);
      },
      onLive: setLiveState,
      onReady: markFrameReady, // spec §5.4 — signal shoot.py the frame is settled
    });
    engineRef.current = engine;

    // Push the persisted prefs that need no snapshot fetch straight in (theme
    // glow, ambient backdrop, idle motion). The window is restored AFTER start()
    // so the snapshot isn't fetched twice on boot.
    const s0 = settingsRef.current;
    applyEffects(engine, s0, {
      theme: s0.theme,
      ambientFill: s0.ambientFill,
      density: s0.density,
      ambientMotion: s0.ambientMotion,
      solarLight: s0.solarLight,
    });

    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) engine.resize(r.width, r.height);
    });
    ro.observe(wrap);

    void engine.start().then(async () => {
      if (engineRef.current !== engine) return; // torn down / remounted (StrictMode)
      // Skip the persisted-window re-seed if the user already pinned an
      // archive day (the scrubber renders before boot settles) — the re-seed
      // would silently replace the pinned day with live data.
      if (engine.day === null && s0.windowHours !== SNAPSHOT_HOURS) {
        await engine.setWindow(s0.windowHours);
      }
      if (engineRef.current !== engine) return; // teardown can land mid-setWindow
      setBootDone(true); // roster is real → the ?bird= restore may resolve
    });

    return () => {
      ro.disconnect();
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  // Boot straight into the chrome-free wall layout for `?frame=1` / kiosk / eink.
  useEffect(() => {
    if (FRAME_AT_BOOT) enterFrame();
  }, [enterFrame]);

  // Scrubber day strip + capability probe, once at mount. The probe requests
  // yesterday (client clock): a zero-detection day still echoes `on`, so it
  // probes true — only an old API (no echo) or a dead DB probes false, and the
  // scrubber then simply never renders (degrade to silence).
  useEffect(() => {
    let alive = true;
    void fetchDayActivity(366).then((strip) => {
      if (!alive) return;
      dayStripRef.current = strip;
      setDayStrip(strip);
    });
    if (MOCK) {
      setScrubOk(true);
    } else {
      const y = new Date();
      y.setDate(y.getDate() - 1);
      void fetchDaySnapshot(isoDay(y)).then((rows) => {
        if (alive && Array.isArray(rows)) setScrubOk(true);
      });
    }
    return () => {
      alive = false;
    };
  }, []);

  // Any window change IS the return to live (period buttons and ←/→ alike):
  // the engine's setWindow re-seeds and its emission clears the pin — App
  // never clears it optimistically (the archive label must outlive a failed
  // return). Bumping the selection seq drops any in-flight setDay.
  useEffect(() => {
    selectSeqRef.current++;
  }, [settings.windowHours]);

  // One-shot boot ?on= restore, once the boot snapshot has settled. Unlike
  // ?bird=, it APPLIES under FRAME_AT_BOOT (a kiosk may park on
  // ?frame=1&on=<day> — a memorial wall); boot params are still never
  // rewritten in frame mode — an unsupported day is cleared only when unframed.
  useEffect(() => {
    if (!bootDone) return;
    const want = pendingOnRef.current;
    if (want === null) return;
    const engine = engineRef.current;
    if (!engine || viewDayRef.current !== null) {
      // The user already pinned a (different) day mid-boot: drop the boot
      // param and publish the day actually on screen, so the address bar
      // never claims a day the collage isn't showing.
      pendingOnRef.current = null;
      if (!FRAME_AT_BOOT) writeOn(viewDayRef.current);
      return;
    }
    const seq = ++selectSeqRef.current;
    void engine.setDay(want).then((res) => {
      pendingOnRef.current = null;
      if (seq !== selectSeqRef.current) return;
      // 'ok' pins via the engine's tagged emission; only a truly unsupported
      // day clears the param (and only unframed — kiosk boot params stay).
      if (res === 'unsupported' && !FRAME_AT_BOOT) writeOn(null);
    });
  }, [bootDone]);

  // viewDay → URL (?on=), replace-only. Skipped while the boot ?on= is still
  // pending (the mount run must not eat the param before the restore consumes
  // it) and under a framed boot (kiosk boot params stay verbatim).
  useEffect(() => {
    if (FRAME_AT_BOOT || pendingOnRef.current !== null) return;
    writeOn(viewDay);
  }, [viewDay]);

  // Persist the active tab so a reload restores the last view.
  useEffect(() => {
    try {
      localStorage.setItem(TAB_STORAGE_KEY, tab);
    } catch {
      /* ignore persistence failure */
    }
  }, [tab]);

  // One-shot boot restore: consume the ?bird= deep link once the roster is
  // real. FRAME_AT_BOOT suppresses it entirely (a kiosk never boots into a
  // modal) and leaves the boot params untouched.
  useEffect(() => {
    if (!bootDone) return;
    const want = pendingBirdRef.current;
    pendingBirdRef.current = null;
    if (!want || FRAME_AT_BOOT) return;
    openFromUrl(want.slug, want.pose);
  }, [bootDone, openFromUrl]);

  // Back/Forward: the URL is the source of truth. The sync effects below are
  // compare-before-write, so re-applying the parsed state never loops.
  useEffect(() => {
    const onPop = () => {
      const u = readUrl();
      setTab(asTab(u.tab) ?? 'collage');
      setAim(u.read);
      if (u.birdSlug) openFromUrl(u.birdSlug, u.pose);
      else setPopup(null);
      if (u.on !== viewDayRef.current) selectDay(u.on);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [openFromUrl, selectDay]);

  // Tab → URL (replaceState only — arrow-key/1–6 cycling never spams history);
  // the first run also publishes a localStorage-restored tab so the address
  // bar is always truthful. Never while framed: a kiosk parked on its boot
  // URL keeps it verbatim (tab state is pinned to the collage there anyway).
  useEffect(() => {
    if (FRAME_AT_BOOT || framed) return;
    writeTab(tab);
  }, [tab, framed]);

  // Popup → URL. null→null never writes (a boot ?bird= survives until the
  // restore consumes it); open pushes exactly once via writeBird's had-no-bird
  // check; close replace-deletes bird+pose.
  useEffect(() => {
    const prev = prevPopupRef.current;
    prevPopupRef.current = popup;
    if (popup) writeBird(popup.sci, popup.pose ?? 1);
    else if (prev) clearBird();
  }, [popup]);

  // Global keys App owns: 1–6 switch tabs, ←/→ cycle the window (or step
  // archive days while a past day is pinned). `F` (toggle) and `Esc` (exit)
  // stay owned by useFrameMode; the Settings drawer owns its own Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.length === 1 && e.key >= '1' && e.key <= '6') {
        if (!framed) setTab(TABS[Number(e.key) - 1]);
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        const pinned = viewDayRef.current;
        if (pinned !== null) {
          // Past mode: ←/→ step across ACTIVE archive days (zero days are
          // honest gaps — skipped, same as the scrubber's disabled ticks).
          // Stepping right past the newest archive day is the return to NOW.
          const strip = dayStripRef.current;
          const idx = strip.findIndex((d) => d.date === pinned);
          if (idx < 0) return;
          for (let i = idx + dir; i >= 0 && i < strip.length; i += dir) {
            if (i === strip.length - 1) break; // today's tick belongs to NOW
            if (strip[i].detections > 0) {
              selectDay(strip[i].date);
              return;
            }
          }
          if (dir > 0) selectDay(null); // walked off the right edge → NOW
          return;
        }
        const cur = PERIODS.findIndex((p) => p.hours === settingsRef.current.windowHours);
        const base = cur < 0 ? 2 : cur;
        const nextIdx =
          e.key === 'ArrowRight' ? Math.min(PERIODS.length - 1, base + 1) : Math.max(0, base - 1);
        if (nextIdx !== base) patch({ windowHours: PERIODS[nextIdx].hours });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [framed, patch, selectDay]);

  // Honest counter figures + active-window label, both from the real roster.
  const windowLabel = windowLabelFor(settings.windowHours);
  const { species, calls } = counterFrom(rows, windowLabel);

  // Real-time feed: only in the rolling-1H window. On entering 1H we snapshot the
  // hour's backlog as the baseline (no feed spam); each later roster tick that
  // raises a species' count emits a fresh detection row. Honesty firewall intact:
  // the feed only ever mirrors real counted roster increments.
  useEffect(() => {
    if (viewDay !== null) {
      // A pinned past day re-seeds the roster; diffing that against the live
      // baseline would fabricate "live" feed rows out of archive data.
      feedBaseRef.current = null;
      return;
    }
    if (settings.windowHours !== 1) {
      feedBaseRef.current = null;
      return;
    }
    const cur = new Map(rows.map((r) => [r.slug, r.n]));
    const base = feedBaseRef.current;
    if (!base || base.hours !== 1) {
      feedBaseRef.current = { hours: 1, counts: cur };
      setFeed([]);
      return;
    }
    const t = new Date();
    const time = t.toTimeString().slice(0, 8);
    const fresh: FeedRow[] = [];
    for (const r of rows) {
      if (r.n > (base.counts.get(r.slug) ?? 0)) {
        fresh.push({ key: `${r.slug}-${t.getTime()}-${r.n}`, com: r.com, sci: r.sci, slug: r.slug, isNew: r.isNew, time, at: t.getTime() });
      }
    }
    feedBaseRef.current = { hours: 1, counts: cur };
    if (fresh.length) setFeed((f) => [...fresh, ...f].slice(0, 40));
  }, [rows, settings.windowHours, viewDay]);

  // The reading wall — the ONE additional surface the frame may be pointed at
  // (owner decision 1). Opt-in is explicit: under a kiosk/e-ink boot only a
  // literal ?tab=library selects it, so a bare ?frame=1 renders the collage
  // rosette exactly as it does today even if this browser's localStorage last
  // held 'library'. Unframed, toggling into frame mode from the LIBRARY tab
  // carries the wall over — a state that could not exist before this tab did.
  // asTab stays the ONLY gate that reads the raw ?tab= param, here as everywhere.
  const frameLibrary =
    framed && (FRAME_AT_BOOT ? asTab(BOOT_URL.tab) === 'library' : tab === 'library');
  // Tab is pinned to the collage while framed (the other tabs' chrome is hidden),
  // the reading wall excepted — and everything keyed on 'collage' below (the
  // mast, the live dashboard, the listening pulse, the scrubber, the colophon)
  // therefore stays silent on it without a second condition.
  const shownTab: Tab = framed ? (frameLibrary ? 'library' : 'collage') : tab;
  // The rolling-1H window turns the collage surface into the live dashboard —
  // never while a past day is pinned (an archive has no live dashboard).
  const liveActive =
    !framed && shownTab === 'collage' && settings.windowHours === 1 && viewDay === null;
  // The time-travel ruler earns its place only on the collage, unframed, off the
  // live dashboard, when the API can serve days AND there is a real archive to
  // travel (3+ past days with detections). It now rides in the bottom nav row,
  // right after the tabs — a matched time control beside the view tabs.
  const showScrub =
    shownTab === 'collage' &&
    !framed &&
    !liveActive &&
    scrubOk &&
    dayStrip.slice(0, -1).filter((d) => d.detections > 0).length >= 3;

  return (
    <div
      className={framed ? 'stage frame' : 'stage'}
      ref={wrapRef}
      data-reveal={settings.revealAnim ? 'true' : 'false'}
      data-lifer={settings.liferTick ? 'true' : 'false'}
    >
      <canvas
        ref={canvasRef}
        className="collage-canvas"
        onClick={(e) => {
          // Frame mode is a chrome-free wall — a stray click never opens a modal.
          if (framed) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const hit = engineRef.current?.hitTest(e.clientX - rect.left, e.clientY - rect.top);
          setPopup(hit ?? null);
        }}
        onMouseMove={(e) => {
          if (framed) return;
          // Move the tooltip via a raw transform write — never through React, so
          // tracking the cursor is jank-free and re-render-free.
          const el = hoverElRef.current;
          if (el) el.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 16}px)`;
          const rect = e.currentTarget.getBoundingClientRect();
          const hit = engineRef.current?.hitTest(e.clientX - rect.left, e.clientY - rect.top);
          e.currentTarget.style.cursor = hit ? 'pointer' : 'default';
          // Content is state, but only flip it when the species under the cursor
          // actually changes — otherwise a moving cursor would re-render the app
          // (and the canvas) on every pixel.
          const slug = hit?.slug ?? null;
          if (slug !== hoverSlugRef.current) {
            hoverSlugRef.current = slug;
            setHovered(hit ? { com: hit.com, n: hit.n } : null);
          }
        }}
        onMouseLeave={() => {
          hoverSlugRef.current = null;
          setHovered(null);
        }}
      />

      <div className="filter">
        {PERIODS.map((p) => (
          <button
            key={p.label}
            className={p.hours === settings.windowHours ? 'on' : ''}
            onClick={() => patch({ windowHours: p.hours })}
          >
            {p.label}
          </button>
        ))}
      </div>


      <div className="menu-wrap">
        <button
          className="theme-quick"
          aria-label={theme === 'night' ? 'Switch to day theme' : 'Switch to night theme'}
          onClick={() => patch({ theme: theme === 'night' ? 'day' : 'night' })}
        >
          {theme === 'night' ? '☀' : '☾'}
        </button>
        <button className="menu" onClick={() => setSettingsOpen(true)}>
          <i />
          MENU
        </button>
      </div>

      {shownTab === 'collage' && !liveActive && (
        <header className="mast">
          <div className="eyebrow">
            {viewDay ? `${formatDay(viewDay)} · archive` : `your window${MOCK ? ' · demo' : ''}`}
          </div>
          {/* Archive days get archival titles — never "HEARD TODAY" over a past
              day. A zero-detection day is an honest quiet wall, not LISTENING. */}
          <div className="mast-t">
            {viewDay ? (species === 0 ? 'A QUIET DAY' : 'FROM THE ARCHIVE') : mastTitle(species)}
          </div>
        </header>
      )}

      {liveActive && (
        <Overlay>
          <LiveView species={species} calls={calls} feed={feed} live={liveState} />
        </Overlay>
      )}

      {/* The pulse implies live listening — never shown while a past day is pinned. */}
      {shownTab === 'collage' && !liveActive && viewDay === null && species === 0 && settings.listeningAnim && (
        <div className="listen">
          <div className="pulse">
            <span />
            <span />
            <span />
            <i />
          </div>
          <div className="listen-cap">{status}</div>
        </div>
      )}

      {shownTab === 'index' && (
        <Overlay>
          <IndexView rows={rows} archiveDay={viewDay} />
        </Overlay>
      )}
      {shownTab === 'stats' && (
        <Overlay>
          <StatsView rows={rows} archiveDay={viewDay} />
        </Overlay>
      )}
      {shownTab === 'atlas' && (
        <Overlay>
          <AtlasView
            rows={rows}
            archiveDay={viewDay}
            onOpen={(r) => setPopup({ sci: r.sci, com: r.com, slug: r.slug, n: r.n })}
          />
        </Overlay>
      )}
      {shownTab === 'wall' && (
        <Overlay>
          <CollectionWallView />
        </Overlay>
      )}
      {shownTab === 'library' && !frameLibrary && (
        <Overlay>
          <LibraryView
            rows={rows}
            windowHours={settings.windowHours}
            aim={aim}
            onReleaseAim={() => {
              setAim(null);
              clearRead();
            }}
            onOpen={(r) => setPopup({ sci: r.sci, com: r.com, slug: r.slug, n: r.n })}
          />
        </Overlay>
      )}
      {/* The reading wall: chrome-free, no Overlay, no dossier — an ADDITIONAL
          frame surface, never a change to what the e-ink frame shows today. */}
      {frameLibrary && <LibraryFrameView rows={rows} windowHours={settings.windowHours} />}

      {/* The bottom control row: the view tabs, and — right after them — the
          time-travel ruler when there is an archive to travel. One matched
          cluster instead of a lonely strip floating above the nav. */}
      <div className="navrow">
        <nav className="nav">
          {TABS.map((t) => (
            <button key={t} className={t === shownTab ? 'on' : ''} onClick={() => setTab(t)}>
              {t.toUpperCase()}
            </button>
          ))}
        </nav>
        {showScrub && <Scrubber days={dayStrip} selected={viewDay} onSelect={selectDay} />}
      </div>

      {!framed &&
        (viewDay ? (
          <ArchiveCaption day={viewDay} species={species} onNow={() => selectDay(null)} />
        ) : (
          <LiveCounter
            species={species}
            calls={calls}
            windowLabel={windowLabel}
            live={liveState}
            latest={latest}
            compact={framed}
          />
        ))}

      {settings.showColophon && shownTab === 'collage' && !framed && (
        <div className="colophon">Belkins BirdNET</div>
      )}

      {/* THE WALL PLACARD. FrameOverlay has accepted, styled and rendered a
          tombstone since it was written and nothing ever passed one, so the
          museum's most-seen surface carried no label at all. Gated on
          !frameLibrary: the reading wall is already a page of text and does not
          want a second title over it. */}
      {framed && (
        <FrameOverlay
          onExit={exitFrame}
          tombstone={
            frameLibrary
              ? undefined
              : { title: 'Belkins BirdNET', sub: 'a London garden, listening' }
          }
        />
      )}

      <div
        className="bird-hover"
        ref={hoverElRef}
        data-show={!framed && hovered ? 'true' : 'false'}
        aria-hidden="true"
      >
        {hovered && (
          <>
            <span className="bh-name">{hovered.com}</span>
            <span className="bh-n">
              {hovered.n} {hovered.n === 1 ? 'call' : 'calls'}
            </span>
          </>
        )}
      </div>

      <BirdPopup
        bird={popup}
        windowLabel={windowLabel}
        archiveDay={viewDay}
        repaintEnabled={settings.repaintPlate}
        onClose={() => setPopup(null)}
        onPoseChange={writePose}
      />

      <SettingsPanel
        open={settingsOpen}
        settings={settings}
        onChange={patch}
        onClose={() => setSettingsOpen(false)}
        onEnterFrame={enterFrame}
      />
    </div>
  );
}
