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
import { CollectionWallView } from './views/CollectionWallView';

type Tab = 'collage' | 'index' | 'stats' | 'atlas' | 'wall';

const PERIODS: { label: string; hours: number }[] = [
  { label: '1H', hours: 1 },
  { label: '12H', hours: 12 },
  { label: '24H', hours: 24 },
  { label: '7D', hours: 168 },
  { label: 'ALL', hours: 1_000_000 },
];
const TABS: Tab[] = ['collage', 'index', 'stats', 'atlas', 'wall'];

/** Active-window label for the given hours (falls back to 24H). */
function windowLabelFor(hours: number): string {
  return (PERIODS.find((p) => p.hours === hours) ?? PERIODS[2]).label;
}

const TAB_STORAGE_KEY = 'belkins-birdnet-tab';

/** Restore the last-viewed tab (persisted separately from the Settings blob). */
function loadTab(): Tab {
  try {
    const v = localStorage.getItem(TAB_STORAGE_KEY);
    if (v === 'collage' || v === 'index' || v === 'stats' || v === 'atlas' || v === 'wall') return v;
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
}

function Overlay({ children }: { children: ReactNode }) {
  return <div className="overlay">{children}</div>;
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

  const [tab, setTab] = useState<Tab>(loadTab);
  const [rows, setRows] = useState<RosterRow[]>([]);
  const [status, setStatus] = useState('starting');
  const [latest, setLatest] = useState('');
  const [liveState, setLiveState] = useState<LiveState>('connecting');
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  // Engine + canvas live for the whole session — never unmounted on tab switch.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const engine = new CollageEngine(canvas, {
      onStatus: setStatus,
      onLatest: setLatest,
      onData: setRows,
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
    });

    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) engine.resize(r.width, r.height);
    });
    ro.observe(wrap);

    void engine.start().then(() => {
      if (engineRef.current !== engine) return; // torn down / remounted (StrictMode)
      if (s0.windowHours !== SNAPSHOT_HOURS) void engine.setWindow(s0.windowHours);
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

  // Persist the active tab so a reload restores the last view.
  useEffect(() => {
    try {
      localStorage.setItem(TAB_STORAGE_KEY, tab);
    } catch {
      /* ignore persistence failure */
    }
  }, [tab]);

  // Global keys App owns: 1–5 switch tabs, ←/→ cycle the window. `F` (toggle) and
  // `Esc` (exit) stay owned by useFrameMode; the Settings drawer owns its own Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.length === 1 && e.key >= '1' && e.key <= '5') {
        if (!framed) setTab(TABS[Number(e.key) - 1]);
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const cur = PERIODS.findIndex((p) => p.hours === settingsRef.current.windowHours);
        const base = cur < 0 ? 2 : cur;
        const nextIdx =
          e.key === 'ArrowRight' ? Math.min(PERIODS.length - 1, base + 1) : Math.max(0, base - 1);
        if (nextIdx !== base) patch({ windowHours: PERIODS[nextIdx].hours });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [framed, patch]);

  // Honest counter figures + active-window label, both from the real roster.
  const windowLabel = windowLabelFor(settings.windowHours);
  const { species, calls } = counterFrom(rows, windowLabel);

  // Tab is pinned to the collage while framed (the other tabs' chrome is hidden).
  const shownTab: Tab = framed ? 'collage' : tab;

  return (
    <div
      className={framed ? 'stage frame' : 'stage'}
      ref={wrapRef}
      data-reveal={settings.revealAnim ? 'true' : 'false'}
      data-lifer={settings.liferTick ? 'true' : 'false'}
    >
      <canvas ref={canvasRef} className="collage-canvas" />

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

      {shownTab === 'collage' && (
        <header className="mast">
          <div className="eyebrow">your window{MOCK ? ' · demo' : ''}</div>
          <div className="mast-t">{mastTitle(species)}</div>
        </header>
      )}

      {shownTab === 'collage' && species === 0 && settings.listeningAnim && (
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
          <IndexView rows={rows} />
        </Overlay>
      )}
      {shownTab === 'stats' && (
        <Overlay>
          <StatsView rows={rows} />
        </Overlay>
      )}
      {shownTab === 'atlas' && (
        <Overlay>
          <AtlasView rows={rows} />
        </Overlay>
      )}
      {shownTab === 'wall' && (
        <Overlay>
          <CollectionWallView />
        </Overlay>
      )}

      <nav className="nav">
        {TABS.map((t) => (
          <button key={t} className={t === shownTab ? 'on' : ''} onClick={() => setTab(t)}>
            {t.toUpperCase()}
          </button>
        ))}
      </nav>

      <LiveCounter
        species={species}
        calls={calls}
        windowLabel={windowLabel}
        live={liveState}
        latest={latest}
        compact={framed}
      />

      {settings.showColophon && shownTab === 'collage' && (
        <div className="colophon">Belkins BirdNET</div>
      )}

      {framed && (
        <FrameOverlay
          onExit={exitFrame}
          tombstone={{ title: mastTitle(species), sub: `${calls} calls · ${windowLabel}` }}
        />
      )}

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
