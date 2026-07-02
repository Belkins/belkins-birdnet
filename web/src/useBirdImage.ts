// useBirdImage — resolves a bird illustration's *readiness*, not just its bytes.
//
// cutout.php always answers 200 with a drawable PNG: genuine species art carries
// `X-Av-Real: 1`, an intentional placeholder (a species heard but not yet painted
// by the Railway gen service) carries `X-Av-Real: 0`. A plain <img> can't read
// that header, so a brand-new bird would silently show cutout's grey silhouette
// forever. This hook does a same-origin fetch to read the header and reports a
// phase the UI can act on:
//
//   loading  — first probe in flight (brief)
//   ready    — real art; render <img src>
//   pending  — placeholder → the plate is still being painted; show the loader
//              and keep polling (cache-busted) until it flips to ready
//   none     — the fetch failed, or polling was exhausted; fall to a silhouette
//
// The placeholder is cached for 5 min (max-age=300), so every re-check MUST
// cache-bust or the browser keeps serving the stale silhouette; and once a poll
// sees real art we hand back a one-shot cache-busted `src` so the <img> bypasses
// that stale placeholder entry. Real art is cached for a day, so the initial
// probe is allowed to hit the HTTP cache (cheap for the common case).
import { useEffect, useState } from 'react';

export type ImgPhase = 'loading' | 'ready' | 'pending' | 'none';

// Backoff schedule (ms) between placeholder re-checks; the last value repeats.
// pose-1 typically lands within ~30–90s of a first hearing, so the early polls
// are tight and then relax; the whole schedule covers ~10 min before giving up.
const POLL_MS = [2000, 3000, 5000, 8000, 12000, 18000, 25000];
const MAX_POLLS = 30;

// Probe gate: at N=200 species the Wall/Atlas would otherwise fire 200
// concurrent header fetches at the Pi's Caddy/PHP front — the same front that
// carries the SSE stream. Every probe (initial + polls, all views) shares this
// module-level semaphore instead.
const MAX_PROBES_IN_FLIGHT = 6;
let inFlight = 0;
const waiters: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (inFlight < MAX_PROBES_IN_FLIGHT) {
    inFlight += 1;
    return Promise.resolve();
  }
  return new Promise((res) => waiters.push(res));
}

function releaseSlot(): void {
  // Slot HANDOFF semantics: waking a waiter transfers the slot to it, so
  // inFlight stays unchanged; only an empty queue actually frees the slot.
  const next = waiters.shift();
  if (next) next();
  else inFlight -= 1;
}

function withParam(url: string, key: string, val: string | number): string {
  return `${url}${url.includes('?') ? '&' : '?'}${key}=${val}`;
}

export function useBirdImage(url: string | null, trusted = false): { phase: ImgPhase; src: string | null } {
  const [phase, setPhase] = useState<ImgPhase>(!url ? 'none' : trusted ? 'ready' : 'loading');
  // 0 => display the plain url (HTTP-cached); a timestamp => append it to force a
  // fresh load past the 5-min placeholder cache after a pending→ready flip.
  const [bust, setBust] = useState(0);

  useEffect(() => {
    setBust(0);
    if (!url) {
      setPhase('none');
      return;
    }
    if (trusted) {
      // Catalog says real art exists: the <img> will 200 with art; no probe, no poll.
      setPhase('ready');
      return;
    }
    setPhase('loading');

    let cancelled = false;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    let sawPending = false;

    const schedulePoll = (): void => {
      if (polls >= MAX_POLLS) {
        // Exhausted: a species that hasn't painted in ~10 min is genuinely stuck
        // (the gen service retries it server-side in slow bursts). Drop to a
        // silhouette rather than spin forever; re-opening the view re-probes.
        if (!cancelled) setPhase('none');
        return;
      }
      const delay = POLL_MS[Math.min(polls, POLL_MS.length - 1)];
      polls += 1;
      timer = setTimeout(() => void probe(true), delay);
    };

    const probe = async (fresh: boolean): Promise<void> => {
      const u = fresh ? withParam(url, '_', Date.now()) : url;
      // A queued waiter for an unmounted hook just acquires, sees cancelled,
      // and releases in the finally — no slot leak.
      await acquireSlot();
      try {
        if (cancelled) return;
        const res = await fetch(u, { signal: ctrl.signal, cache: fresh ? 'no-store' : 'default' });
        if (cancelled) return;
        if (!res.ok) {
          schedulePoll();
          return;
        }
        // A server without the header (older cutout, mock) → treat as real.
        if (res.headers.get('X-Av-Real') === '0') {
          sawPending = true;
          setPhase('pending');
          schedulePoll();
          return;
        }
        if (sawPending) setBust(Date.now());
        setPhase('ready');
      } catch {
        if (!cancelled) schedulePoll();
      } finally {
        releaseSlot();
      }
    };

    void probe(false);

    return () => {
      cancelled = true;
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
    // `trusted` in the deps: a late-arriving art map flips trusted → the cleanup
    // aborts an already-in-flight probe instead of racing it.
  }, [url, trusted]);

  const src = url ? (bust ? withParam(url, '_', bust) : url) : null;
  return { phase, src };
}
