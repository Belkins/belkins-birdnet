import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import './App.css';
import { CollageEngine } from './collage';
import { MOCK } from './config';
import { applyTheme, storedTheme, type Theme } from './theme';
import type { RosterRow } from './types';
import { IndexView } from './views/IndexView';
import { StatsView } from './views/StatsView';
import { AtlasView } from './views/AtlasView';

type Tab = 'collage' | 'index' | 'stats' | 'atlas';
const PERIODS = ['1H', '12H', '24H', '7D', 'ALL'];
const TABS: Tab[] = ['collage', 'index', 'stats', 'atlas'];

function Overlay({ children }: { children: ReactNode }) {
  return <div className="overlay">{children}</div>;
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<CollageEngine | null>(null);
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const [tab, setTab] = useState<Tab>('collage');
  const [rows, setRows] = useState<RosterRow[]>([]);
  const [count, setCount] = useState(0);
  const [status, setStatus] = useState('starting');
  const [latest, setLatest] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);

  // Engine + canvas live for the whole session — never unmounted on tab switch.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const engine = new CollageEngine(canvas, {
      onCount: setCount,
      onStatus: setStatus,
      onLatest: setLatest,
      onData: setRows,
    });
    engineRef.current = engine;
    engine.setTheme(storedTheme());
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) engine.resize(r.width, r.height);
    });
    ro.observe(wrap);
    void engine.start();
    return () => {
      ro.disconnect();
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    applyTheme(theme);
    engineRef.current?.setTheme(theme);
  }, [theme]);

  return (
    <div className="stage" ref={wrapRef}>
      <canvas ref={canvasRef} className="collage-canvas" />

      <div className="filter">
        {PERIODS.map((p) => (
          <span key={p} className={p === '24H' ? 'on' : ''}>
            {p}
          </span>
        ))}
      </div>

      <div className="menu-wrap">
        <button className="menu" onClick={() => setMenuOpen((o) => !o)}>
          <i />
          MENU
        </button>
        {menuOpen && (
          <div className="menu-pop">
            <button
              onClick={() => {
                setTheme((t) => (t === 'night' ? 'day' : 'night'));
                setMenuOpen(false);
              }}
            >
              {theme === 'night' ? '☀  Day theme' : '☾  Night theme'}
            </button>
          </div>
        )}
      </div>

      {tab === 'collage' && (
        <header className="mast">
          <div className="eyebrow">your window{MOCK ? ' · demo' : ''}</div>
          <div className="mast-t">{count === 0 ? 'LISTENING' : 'HEARD RECENTLY'}</div>
        </header>
      )}

      {tab === 'collage' && count === 0 && (
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

      {tab === 'index' && (
        <Overlay>
          <IndexView rows={rows} />
        </Overlay>
      )}
      {tab === 'stats' && (
        <Overlay>
          <StatsView rows={rows} />
        </Overlay>
      )}
      {tab === 'atlas' && (
        <Overlay>
          <AtlasView rows={rows} />
        </Overlay>
      )}

      <nav className="nav">
        {TABS.map((t) => (
          <button key={t} className={t === tab ? 'on' : ''} onClick={() => setTab(t)}>
            {t.toUpperCase()}
          </button>
        ))}
      </nav>

      <div className="live">
        <span className="live-dot" data-live={status.includes('live')} />
        <span className="live-n">{count}</span>
        {latest && <span className="live-latest">↳ {latest}</span>}
      </div>
    </div>
  );
}
