// STATION PANEL — the live microphone, in the museum's own window.
//
// REBUILT 2026-07-30 after a fair complaint: the first version invented a raw
// <audio controls> and a bordered <img>, when this app already had both a real
// audio control and a real spectrogram treatment. It now uses them:
//
//   * <Listen> — the museum's own play/pause control (▶ / ❚❚, idle→loading→
//     playing→error states, "No audio" when the source fails). It already did
//     everything a live stream needs; it only lacked a way to be pointed at a
//     url that is not a recording, so it gained an optional `src`.
//   * .bp-spectro / .bp-spectro-img — the same greyscaled band the bird dossier
//     draws a clip's spectrogram into. Identical vocabulary, so the live picture
//     reads as the same instrument as the one on every recording row.
//
// Nothing here is a new visual element. The only bespoke CSS left is layout.
//
// AUTH: both halves are open now (STATION_OPEN=1), so there is no lock state to
// handle — /spectrogram.png and /stream both answer without credentials. If the
// gates ever come back, <Listen> already degrades to a disabled "No audio" pill
// on a 401, which is the honest failure, so this needs no lock probe.
//
// HONESTY: the spectrogram updates per analysis cycle, not per second. An image
// that quietly stopped refreshing would read as "the garden is quiet" — the lie
// this project exists not to tell. So we poll Last-Modified, swap the src only
// when it genuinely changes, print the real timestamp, and say so plainly once
// the frame goes stale.
import { useEffect, useRef, useState } from 'react';
import { Listen } from './Listen';
import './BirdPopup.css'; // the .bp-spectro band — reused, not reimplemented
import './StationPanel.css';

const SPECTROGRAM_URL = '/spectrogram.png';
const STREAM_URL = '/stream';

/** HEAD poll cadence — cheap, no body. */
const POLL_MS = 5_000;
/** Past this, say the picture is old rather than letting it imply "now". */
const STALE_MS = 3 * 60_000;

function clockOf(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function StationPanel({ onClose }: { onClose: () => void }) {
  const [shotAt, setShotAt] = useState<Date | null>(null);
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [imgFailed, setImgFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const lastMod = useRef<string | null>(null);

  // Esc closes, matching BirdPopup and the Settings drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Poll Last-Modified; swap the frame only on a real change.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(SPECTROGRAM_URL, { method: 'HEAD', cache: 'no-store' });
        if (!alive || !r.ok) return;
        const lm = r.headers.get('last-modified');
        if (lm && lm === lastMod.current) return;
        lastMod.current = lm;
        const when = lm ? new Date(lm) : new Date();
        setShotAt(when);
        setImgFailed(false);
        setImgSrc(`${SPECTROGRAM_URL}?t=${when.getTime()}`);
      } catch {
        /* keep the last good frame; the caption's age tells the truth */
      }
    };
    void tick();
    const iv = window.setInterval(tick, POLL_MS);
    const age = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      alive = false;
      window.clearInterval(iv);
      window.clearInterval(age);
    };
  }, []);

  const stale = shotAt !== null && now - shotAt.getTime() > STALE_MS;

  return (
    <div className="st-scrim" onClick={onClose}>
      <div
        className="st-card"
        role="dialog"
        aria-modal="true"
        aria-label="The station — live microphone"
        onClick={(e) => e.stopPropagation()}
      >
        <button ref={closeRef} type="button" className="st-x" aria-label="Close" onClick={onClose}>
          ×
        </button>

        <div className="st-head">
          <span className="st-kicker">THE STATION</span>
          <h2 className="st-title">Listening now</h2>
        </div>

        {/* The dossier's spectrogram band, pointed at the live frame instead of
            a clip. Same classes, so it greyscales in night and reads identically
            to the one under every recording row. */}
        <figure className="st-figure">
          <div className="bp-spectro st-spectro">
            {imgSrc && !imgFailed ? (
              <img
                className="bp-spectro-img"
                src={imgSrc}
                alt="Live spectrogram of the garden microphone"
                onError={() => setImgFailed(true)}
              />
            ) : (
              <div className="st-spectro-empty">
                {imgFailed ? 'the spectrogram is not being written' : 'waiting for the first frame…'}
              </div>
            )}
          </div>
          <figcaption className="st-cap">
            what the microphone is hearing
            {shotAt && (
              <>
                {' · '}
                <span className={stale ? 'st-stale' : undefined}>
                  {stale ? `last frame ${clockOf(shotAt)} — not updating` : `updated ${clockOf(shotAt)}`}
                </span>
              </>
            )}
          </figcaption>
        </figure>

        {/* The museum's own control, pointed at the live mount. */}
        <div className="st-listen">
          <Listen sci="live" src={STREAM_URL} idleLabel="Listen live" playingLabel="Stop" />
        </div>

        <nav className="st-more">
          <a href="/views.php?view=Services" target="_blank" rel="noopener">
            Service Controls ↗
          </a>
          <a href="/index.php" target="_blank" rel="noopener">
            Station Console ↗
          </a>
        </nav>
      </div>
    </div>
  );
}
