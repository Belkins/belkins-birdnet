// STATION PANEL — the live microphone, in the museum's own window.
//
// Two rebuilds, both from fair complaints:
//   1. It invented a raw <audio controls> and a bordered <img> when this app
//      already had <Listen> and the .bp-spectro band. Fixed: it uses those.
//   2. The picture was /spectrogram.png — the still sox re-renders once per
//      15-second analysis cycle. A slideshow of stills is not a live instrument;
//      "it's just like static" was right. Fixed: <LiveSpectrogram> paints a
//      scrolling waterfall from the very audio <Listen> is playing.
//
// TWO STATES, each labelled for what it actually is — no state pretends to be
// the other:
//   before you press play  the last frame BirdNET analysed, with its real
//                          timestamp. Honest: it is a still, and it says so.
//   playing                a live waterfall of the sound reaching your speakers.
//
// The live canvas draws only while audio is genuinely playing. Silence produces
// no new columns rather than a synthesised animation implying the garden is
// being heard — this station spent four hours recording digital silence on
// 2026-07-30 while the wall said LISTENING, and a spectrogram that animates
// without input is exactly how that stays invisible.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Listen } from './Listen';
import { LiveSpectrogram } from './LiveSpectrogram';
import './BirdPopup.css'; // the .bp-spectro band — reused, not reimplemented
import './StationPanel.css';

const SPECTROGRAM_URL = '/spectrogram.png';
const STREAM_URL = '/stream';
const BAND_H = 168;

/** HEAD poll cadence for the idle still. Stops entirely once you are live. */
const POLL_MS = 5_000;
/** Past this the still is old; say so rather than let it imply "now". */
const STALE_MS = 3 * 60_000;

function clockOf(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function StationPanel({ onClose }: { onClose: () => void }) {
  const [audio, setAudio] = useState<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [shotAt, setShotAt] = useState<Date | null>(null);
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [imgFailed, setImgFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const lastMod = useRef<string | null>(null);

  // Once <Listen> has ever made an element, the live canvas owns the band.
  const live = audio !== null;

  const onAudio = useCallback((el: HTMLAudioElement | null) => setAudio(el), []);

  // Follow the element's own events rather than adding another prop to Listen.
  useEffect(() => {
    if (!audio) {
      setPlaying(false);
      return;
    }
    const on = () => setPlaying(true);
    const off = () => setPlaying(false);
    audio.addEventListener('playing', on);
    audio.addEventListener('pause', off);
    audio.addEventListener('ended', off);
    audio.addEventListener('error', off);
    return () => {
      audio.removeEventListener('playing', on);
      audio.removeEventListener('pause', off);
      audio.removeEventListener('ended', off);
      audio.removeEventListener('error', off);
    };
  }, [audio]);

  // Esc closes, matching BirdPopup and the Settings drawer. Pause on close so
  // the stream does not keep playing behind a dismissed dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The idle still. Polled ONLY while not live — once the waterfall is running
  // this is dead weight and a request every 5s for a picture nobody can see.
  useEffect(() => {
    if (live) return;
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
  }, [live]);

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

        {/* The dossier's band. Live waterfall once there is audio to read;
            before that, the last frame BirdNET analysed. */}
        <figure className="st-figure">
          <div className="bp-spectro st-spectro">
            {live ? (
              <LiveSpectrogram audio={audio} playing={playing} height={BAND_H} />
            ) : imgSrc && !imgFailed ? (
              <img
                className="bp-spectro-img"
                src={imgSrc}
                alt="The last frame the station analysed"
                onError={() => setImgFailed(true)}
              />
            ) : (
              <div className="st-spectro-empty">
                {imgFailed ? 'the spectrogram is not being written' : 'waiting for the first frame…'}
              </div>
            )}
          </div>
          <figcaption className="st-cap">
            {live ? (
              playing ? (
                <>
                  <span className="st-livedot" aria-hidden="true" /> live — what the microphone is hearing
                </>
              ) : (
                'paused — press Listen live to resume the waterfall'
              )
            ) : (
              <>
                the last frame the station analysed
                {shotAt && (
                  <>
                    {' · '}
                    <span className={stale ? 'st-stale' : undefined}>
                      {stale ? `${clockOf(shotAt)} — not updating` : clockOf(shotAt)}
                    </span>
                  </>
                )}
                {' · press Listen live for the real-time picture'}
              </>
            )}
          </figcaption>
        </figure>

        <div className="st-listen">
          <Listen sci="live" src={STREAM_URL} idleLabel="Listen live" playingLabel="Stop" onAudio={onAudio} />
        </div>

        <nav className="st-more">
          <a href="/views.php?view=Spectrogram" target="_blank" rel="noopener">
            Station spectrogram page ↗
          </a>
          <a href="/index.php" target="_blank" rel="noopener">
            Station Console ↗
          </a>
        </nav>
      </div>
    </div>
  );
}
