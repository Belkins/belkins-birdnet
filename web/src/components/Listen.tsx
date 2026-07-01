// Listen — a real audio control that owns a single <audio> element. Plays the
// newest recording for a species (resolved server-side from the sci name) or a
// specific past clip when a `file` is supplied. The button lives inside
// clickable cards / the detail popup, so every click is stopped from bubbling
// into the parent's open/close handler. A 404 (or any load failure) degrades to
// a disabled "No audio" pill rather than a broken control, and the element is
// paused + detached on unmount so a card that scrolls away goes quiet.
import { useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { API_BASE } from '../config';
import './Listen.css';

type Status = 'idle' | 'loading' | 'playing' | 'error';

export function Listen({ sci, file }: { sci: string; file?: string }) {
  const [status, setStatus] = useState<Status>('idle');
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // A specific clip when `file` is known (atlas detail modal replaying a past
  // recording); otherwise the newest recording, resolved by recording.php from
  // the scientific name. Both endpoints 404 when nothing plays — handled below.
  const src = file
    ? `${API_BASE}/recording.php?file=${encodeURIComponent(file)}`
    : `${API_BASE}/recording.php?sci=${encodeURIComponent(sci)}`;

  // Tear the element down whenever the source changes (e.g. the popup's detail
  // fetch resolves `file` after opening) and on unmount, so nothing keeps
  // playing in the background and a fresh source starts from a clean state.
  useEffect(() => {
    setStatus('idle');
    return () => {
      const a = audioRef.current;
      if (a) {
        a.pause();
        a.src = '';
        audioRef.current = null;
      }
    };
  }, [src]);

  function toggle(e: MouseEvent<HTMLButtonElement>) {
    // The control sits inside a clickable card / dialog — never let the click
    // bubble up and toggle the parent.
    e.stopPropagation();
    if (status === 'error') return;

    let a = audioRef.current;
    if (!a) {
      // Lazily create one HTMLAudioElement on first play — no eager network hit
      // for every card that is merely rendered.
      a = new Audio(src);
      a.preload = 'none';
      a.addEventListener('playing', () => setStatus('playing'));
      a.addEventListener('waiting', () => setStatus('loading'));
      a.addEventListener('pause', () => setStatus('idle'));
      a.addEventListener('ended', () => setStatus('idle'));
      a.addEventListener('error', () => setStatus('error'));
      audioRef.current = a;
    }

    if (a.paused) {
      if (a.ended) a.currentTime = 0;
      setStatus('loading');
      // play() rejects on a 404 / decode failure; the `error` event covers the
      // same case, but catch here so an unhandled rejection never hits console.
      a.play().catch(() => setStatus('error'));
    } else {
      a.pause();
    }
  }

  const disabled = status === 'error';
  const label =
    status === 'error'
      ? 'No audio'
      : status === 'playing'
        ? 'Pause'
        : status === 'loading'
          ? 'Loading'
          : 'Listen';
  const glyph = status === 'playing' ? '❚❚' : status === 'idle' ? '▶' : '';

  return (
    <button
      type="button"
      className="listen"
      data-status={status}
      disabled={disabled}
      aria-label={disabled ? 'No recording available' : `Play a recording of ${sci}`}
      onClick={toggle}
    >
      {glyph && <span className="listen-ico">{glyph}</span>}
      <span className="listen-lab">{label}</span>
    </button>
  );
}
