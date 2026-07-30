// Frame / Wall mode — the chrome-free fullscreen wall display (spec §5, the #1
// ask). Drives a single `frame` boolean plus the browser hooks that make a 24/7
// wall display behave: the Fullscreen API (edge-to-edge), the Screen Wake Lock
// (keep the panel lit), an idle auto-enter timer, and the `F` / `Esc` keyboard
// shortcuts. EVERY browser API is feature-detected and every rejection swallowed
// so it degrades cleanly on the Pi kiosk Chromium, where Fullscreen / Wake Lock
// may be unavailable. Logic-only (no JSX), so it lives in a `.ts`.

import { useState, useEffect, useRef, useCallback } from 'react';
import type { Theme } from './theme';

export interface FrameModeOptions {
  /** Seconds of no pointer/keyboard before auto-entering frame; `0` disables. */
  idleSec: number;
  /** The active theme — the frame follows it (applied via `data-theme` on the
   *  shell, not here); kept in the contract so the caller wires it through. */
  theme: Theme;
  onEnter?: () => void;
  onExit?: () => void;
}

export interface FrameModeApi {
  frame: boolean;
  enter: () => void;
  exit: () => void;
  toggle: () => void;
}

export function useFrameMode(opts: FrameModeOptions): FrameModeApi {
  const { idleSec, onEnter, onExit } = opts;

  const [frame, setFrame] = useState(false);
  // Mirror of `frame` so the stable callbacks/timers can read it without going
  // stale — keeps enter/exit referentially fixed so listeners never resubscribe.
  const frameRef = useRef(false);
  // The held Wake Lock sentinel, or null when none is active.
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  // Hold the callbacks in refs so enter/exit stay referentially stable even when
  // the caller passes fresh inline handlers every render — otherwise a busy App
  // re-render would constantly re-arm the idle timer and it would never fire.
  const onEnterRef = useRef(onEnter);
  const onExitRef = useRef(onExit);
  useEffect(() => {
    onEnterRef.current = onEnter;
    onExitRef.current = onExit;
  }, [onEnter, onExit]);

  const enter = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = true;
    setFrame(true);

    // Fullscreen — feature-detected; a rejection (no user gesture, or no support)
    // is swallowed so we still drop into the chrome-free layout regardless.
    const el = document.documentElement;
    if (typeof el.requestFullscreen === 'function') {
      void el.requestFullscreen().catch(() => {
        /* not permitted here (idle auto-enter has no gesture) — degrade */
      });
    }

    // Screen Wake Lock — keep a wall display awake; store the sentinel so exit
    // can release it. Absent on the Pi kiosk Chromium ⇒ simply skipped.
    const wl = navigator.wakeLock;
    if (wl && typeof wl.request === 'function') {
      void wl
        .request('screen')
        .then((sentinel) => {
          // The request can resolve AFTER a quick exit() (or a second enter()).
          // If we've since left frame mode, release this sentinel now instead of
          // storing a lock nothing will free. Otherwise release any sentinel
          // already held before overwriting the ref, so an earlier lock can't leak.
          if (!frameRef.current) {
            void sentinel.release().catch(() => {
              /* already released / unsupported — ignore */
            });
            return;
          }
          if (wakeLockRef.current && wakeLockRef.current !== sentinel) {
            void wakeLockRef.current.release().catch(() => {
              /* already released — ignore */
            });
          }
          wakeLockRef.current = sentinel;
        })
        .catch(() => {
          /* denied / unsupported — the panel just keeps its OS defaults */
        });
    }

    onEnterRef.current?.();
  }, []);

  const exit = useCallback(() => {
    if (!frameRef.current) return;
    frameRef.current = false;
    setFrame(false);

    // Release the wake lock if we hold one.
    const sentinel = wakeLockRef.current;
    if (sentinel) {
      wakeLockRef.current = null;
      void sentinel.release().catch(() => {
        /* already released by the UA (e.g. tab hidden) — ignore */
      });
    }

    // Leave fullscreen only when we are actually in it.
    if (document.fullscreenElement && typeof document.exitFullscreen === 'function') {
      void document.exitFullscreen().catch(() => {
        /* nothing to exit — ignore */
      });
    }

    onExitRef.current?.();
  }, []);

  const toggle = useCallback(() => {
    if (frameRef.current) exit();
    else enter();
  }, [enter, exit]);

  // Keyboard: `F` toggles, `Esc` exits. Both live on window so they work even
  // when focus rests on the canvas. `Esc` is a no-op when not framed (exit
  // guards), so it coexists with the Settings drawer's own Esc-to-close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'f' || e.key === 'F') {
        // Don't hijack browser/OS shortcuts like ⌘F / Ctrl+F (find).
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        toggle();
      } else if (e.key === 'Escape') {
        exit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, exit]);

  // Idle auto-enter: arm a timer that enters frame after `idleSec` of no
  // pointer/keyboard activity. `idleSec === 0` disables it entirely.
  useEffect(() => {
    if (idleSec <= 0) return;

    let timer = 0;
    const arm = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        enter();
      }, idleSec * 1000);
    };
    const onActivity = () => {
      // Once framed, activity is the overlay's concern (it surfaces the exit
      // pill) — don't churn a timer on a 24/7 panel.
      if (frameRef.current) return;
      arm();
    };

    arm();
    // SCROLLING IS ACTIVITY, AND IT WAS NOT LISTED. The detector watched
    // pointermove and keydown only — which misses the wheel, the trackpad, and
    // every touch on a phone. On the collage that was harmless: nothing scrolls,
    // so pointermove is the whole interaction. The Library is a page you sit and
    // READ, and one of its passages runs 2,700 characters; a reader who scrolled
    // and then read for sixty seconds was thrown into frame mode mid-sentence,
    // by an idle detector blind to the one thing they were doing.
    //
    // `scroll` is capture-phase because the app does not scroll the document —
    // an inner .overlay does, and a non-capturing window listener never sees it.
    // All passive: none of these handlers do anything but re-arm a timer.
    const ACTIVITY = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const ev of ACTIVITY) window.addEventListener(ev, onActivity, { passive: true });
    window.addEventListener('scroll', onActivity, { capture: true, passive: true });
    return () => {
      if (timer) window.clearTimeout(timer);
      for (const ev of ACTIVITY) window.removeEventListener(ev, onActivity);
      window.removeEventListener('scroll', onActivity, { capture: true });
    };
  }, [idleSec, enter]);

  // Release the wake lock on unmount so a teardown never leaks it.
  useEffect(() => {
    return () => {
      const sentinel = wakeLockRef.current;
      if (sentinel) {
        wakeLockRef.current = null;
        void sentinel.release().catch(() => {
          /* ignore */
        });
      }
    };
  }, []);

  return { frame, enter, exit, toggle };
}
