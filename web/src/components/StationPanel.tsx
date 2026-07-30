// STATION PANEL — the microphone, in the museum's own window.
//
// Live Audio and the Live Spectrogram used to be two links out to the old PHP
// UI, which meant leaving the wall and (before the realm fix) a password prompt
// per hop. They belong together in one window: the spectrogram is the picture of
// what the stream is playing.
//
// TWO DIFFERENT AUTH STORIES, deliberately handled differently:
//
//  * /spectrogram.png is UNGATED (verified on the live Pi 2026-07-30: 200,
//    image/png, and it is a webroot symlink to StreamData/spectrogram.png that
//    spectrogram.sh rewrites on each analysis cycle). So the picture renders
//    immediately for anyone who can see the wall — no prompt, no friction.
//  * /stream is GATED, and a 401 on an <audio> element does NOT reliably raise
//    the browser's Basic dialog — media subresources usually just fail silently.
//    So we probe first and show an honest locked state rather than a dead play
//    button. Unlocking is a top-level navigation, which DOES prompt; and since
//    Caddy, common.php and avian/api/_auth.php now share one realm, that single
//    sign-in unlocks the whole station for the session.
//
// HONESTY: the spectrogram updates per analysis cycle, not per second. An image
// that silently stopped refreshing would read as "the garden is quiet" — the
// exact lie this project exists not to tell — so we poll Last-Modified, only
// swap the src when it genuinely changes, and print the real timestamp.
import { useCallback, useEffect, useRef, useState } from 'react';
import './StationPanel.css';

/** Gated resource used purely as a lock probe. Icecast answers HEAD with 400
 *  rather than 200, so treat "not 401" as unlocked — the only bit we need. */
const STREAM_URL = '/stream';
const SPECTROGRAM_URL = '/spectrogram.png';
/** A top-level navigation is the only reliable way to raise the Basic dialog. */
const UNLOCK_URL = '/index.php?stream=play';

type Lock = 'checking' | 'unlocked' | 'locked';

/** Poll cadence for the spectrogram's Last-Modified. Cheap: a HEAD, no body. */
const POLL_MS = 5_000;
/** Past this, say the picture is old rather than letting it imply "now". */
const STALE_MS = 3 * 60_000;

function clockOf(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function StationPanel({ onClose }: { onClose: () => void }) {
  const [lock, setLock] = useState<Lock>('checking');
  const [shotAt, setShotAt] = useState<Date | null>(null);
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [imgFailed, setImgFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const closeRef = useRef<HTMLButtonElement | null>(null);
  // Last-Modified we already rendered, so an unchanged frame never re-downloads.
  const lastMod = useRef<string | null>(null);

  const checkLock = useCallback(async () => {
    try {
      const r = await fetch(STREAM_URL, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store' });
      setLock(r.status === 401 ? 'locked' : 'unlocked');
    } catch {
      // Network error tells us nothing about credentials. Assume locked so the
      // user is offered the action that can fix it, not a silent dead player.
      setLock('locked');
    }
  }, []);

  useEffect(() => {
    void checkLock();
  }, [checkLock]);

  // Esc closes, matching BirdPopup / the Settings drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Spectrogram poll: HEAD for Last-Modified, swap src only on a real change.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(SPECTROGRAM_URL, { method: 'HEAD', cache: 'no-store' });
        if (!alive || !r.ok) return;
        const lm = r.headers.get('last-modified');
        if (lm && lm === lastMod.current) return; // unchanged — leave the frame alone
        lastMod.current = lm;
        const when = lm ? new Date(lm) : new Date();
        setShotAt(when);
        setImgFailed(false);
        setImgSrc(`${SPECTROGRAM_URL}?t=${when.getTime()}`);
      } catch {
        /* leave the last good frame up; the caption's age will tell the truth */
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

        <figure className="st-figure">
          {imgSrc && !imgFailed ? (
            <img className="st-spec" src={imgSrc} alt="Live spectrogram of the garden microphone" onError={() => setImgFailed(true)} />
          ) : (
            <div className="st-spec st-spec-empty">
              {imgFailed ? 'the spectrogram is not being written' : 'waiting for the first frame…'}
            </div>
          )}
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

        <div className="st-listen">
          <span className="st-label">LISTEN</span>
          {lock === 'unlocked' && (
            <audio className="st-audio" controls preload="none" src={STREAM_URL}>
              Your browser cannot play the live stream.
            </audio>
          )}
          {lock === 'checking' && <p className="st-note">checking the station…</p>}
          {lock === 'locked' && (
            <p className="st-note">
              The live audio is behind the station password — the wall is open to the house, the
              microphone is not.{' '}
              <a className="st-unlock" href={UNLOCK_URL} target="_blank" rel="noopener">
                Unlock the station ↗
              </a>{' '}
              then{' '}
              <button type="button" className="st-retry" onClick={() => { setLock('checking'); void checkLock(); }}>
                try again
              </button>
              .
            </p>
          )}
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
