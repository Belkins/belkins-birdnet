// FRAME OVERLAY — the only chrome that survives Frame/Wall mode (spec §5.2).
// A single floating "Exit frame ✕" pill (top-right, mono, glass) that shows
// itself on entry, fades after ~3s of stillness, and wakes again on any
// pointer move or keypress so it stays discoverable without cluttering the
// wall. Plus an optional corner wall-tombstone (italic eyebrow / serif title /
// mono sub) that names the painting. Both read in night and day — every colour
// comes from the theme vars, never a hex.
import { useEffect, useRef, useState } from 'react';
import './FrameOverlay.css';

const HIDE_AFTER_MS = 3000;

export function FrameOverlay({
  onExit,
  tombstone,
  exitable = true,
}: {
  onExit: () => void;
  tombstone?: { title: string; sub: string };
  /** false on surfaces that cannot be clicked (the e-ink print): the pill is
   *  an affordance for a pointer, and a printed button is a lie on paper. The
   *  tombstone stays — a wall label is exactly what a print wants. */
  exitable?: boolean;
}) {
  // The exit pill is visible on entry, then auto-hides; pointer/keyboard wake it.
  const [visible, setVisible] = useState(true);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const wake = () => {
      setVisible(true);
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setVisible(false), HIDE_AFTER_MS);
    };
    wake(); // start the initial auto-hide countdown on enter
    window.addEventListener('pointermove', wake);
    window.addEventListener('keydown', wake);
    return () => {
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('keydown', wake);
      if (timer.current !== undefined) clearTimeout(timer.current);
    };
  }, []);

  return (
    <div className="frame-ov">
      {exitable && (
        <button
          type="button"
          className={visible ? 'exit-frame show' : 'exit-frame'}
          onClick={onExit}
          aria-label="Exit frame"
        >
          Exit frame
          <span className="exit-frame-x" aria-hidden="true">
            ✕
          </span>
        </button>
      )}
      {tombstone && (
        <div className="wall-tomb">
          <div className="wall-tomb-eyebrow">your window</div>
          <div className="wall-tomb-t">{tombstone.title}</div>
          <div className="wall-tomb-sub">{tombstone.sub}</div>
        </div>
      )}
    </div>
  );
}
