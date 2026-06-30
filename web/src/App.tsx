import { useEffect, useRef, useState } from 'react';
import './App.css';
import { CollageEngine } from './collage';
import { MOCK } from './config';

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [count, setCount] = useState(0);
  const [status, setStatus] = useState('starting');
  const [latest, setLatest] = useState<string>('');

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const engine = new CollageEngine(canvas, {
      onCount: setCount,
      onStatus: setStatus,
      onLatest: setLatest,
    });

    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) engine.resize(r.width, r.height);
    });
    ro.observe(wrap);

    void engine.start();

    return () => {
      ro.disconnect();
      engine.destroy();
    };
  }, []);

  return (
    <div className="stage" ref={wrapRef}>
      <canvas ref={canvasRef} className="collage-canvas" />
      <header className="hud">
        <div className="hud-title">
          Belkins BirdNET
          <span className="hud-phase">collage · phase 0</span>
          {MOCK && <span className="hud-badge">MOCK</span>}
        </div>
        <div className="hud-stats">
          <span className="hud-stat">
            <strong>{count}</strong> birds
          </span>
          <span className="hud-dot" data-live={status.includes('live')} />
          <span className="hud-status">{status}</span>
          {latest && <span className="hud-latest">↳ {latest}</span>}
        </div>
      </header>
    </div>
  );
}
