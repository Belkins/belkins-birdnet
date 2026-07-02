// repaint — the dossier's `repaint ↺` gesture: ask the painter for a fresh
// plate. `requestRepaint` POSTs the wish to the Pi's regen.php (which guards,
// cools down, and proxies to the Railway atelier); `useRepaint` owns the whole
// lifecycle as a small status-driven state machine:
//
//   idle → confirm → requesting → painting → swapped
//              │          │           │
//              └ keep /   ├ cooldown  └ parked (4-minute poll budget spent,
//                8s idle  ├ paused        or the species parked server-side)
//                revert   └ unavailable
//
// Facts the machine leans on:
//   · The OLD plate keeps serving for the entire repaint (never-worse
//     invariant), so arrival is detected via regen.php's `?status=1` action —
//     cutout.php keeps answering `X-Av-Real: 1` with the old bytes throughout,
//     and useBirdImage is structurally blind to an in-place swap.
//   · The one status probe on mount doubles as feature detection AND as the
//     resume path: a dark/absent regen.php (503 / unreachable / non-JSON)
//     resolves `unavailable` and the button is simply never rendered; a live
//     marker (this device or another on the LAN pressed earlier) resumes
//     `painting`. Degrade to silence — nothing is ever logged.
//   · `done` is answered exactly once per press (regen.php flushes the Pi
//     cutout cache as its side effect), so a marker that vanished mid-poll
//     means the arrival was consumed elsewhere — treated as an arrival here
//     too, because the wall has already swapped.
import { useEffect, useRef, useState } from 'react';
import { API_BASE, MOCK } from './config';

export type RepaintPhase =
  | 'idle'
  | 'confirm'
  | 'requesting'
  | 'painting'
  | 'swapped'
  | 'parked'
  | 'paused'
  | 'cooldown'
  | 'unavailable';

export interface RepaintSnapshot {
  phase: RepaintPhase;
  /** seconds until the per-species cooldown lifts (phase 'cooldown' only). */
  retryAfterS: number | null;
  /** timestamp of the most recent arrival — drives the one-shot crossfade. */
  swappedAt: number | null;
}

// Poll cadence for ?status=1 while painting: 4s relaxing to 10s (the last
// value repeats), inside a hard 4-minute budget. A clean regen runs 40–90s and
// hint-retries stretch to ~3 min, so the budget covers the happy path and one
// re-roll — never a server-side park. Past it the museum's answer is the
// parked sentence: come back, which is what museums say.
const POLL_MS = [4000, 6000, 8000, 10000];
const POLL_BUDGET_MS = 4 * 60_000;
/** an untouched confirm reverts to rest (the child-and-elbow gate). */
const CONFIRM_REVERT_MS = 8000;
/** how long `swapped` lingers before the button quietly returns to rest. */
const SWAP_DWELL_MS = 4000;
/** cooldown fallback when the server omits retry_after_s. */
const COOLDOWN_FALLBACK_S = 900;

interface RegenBody {
  state?: unknown;
  retry_after_s?: unknown;
}

/** regen.php always answers JSON `{state, …}`; anything else reads as null. */
async function readBody(res: Response): Promise<RegenBody | null> {
  try {
    return (await res.json()) as RegenBody;
  } catch {
    return null;
  }
}

/** POST the repaint wish for one pose. Throws only on network failure. */
export async function requestRepaint(
  sci: string,
  pose: 1 | 2,
): Promise<{ state: string; retryAfterS: number | null }> {
  const res = await fetch(`${API_BASE}/regen.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `sci=${encodeURIComponent(sci)}&pose=${pose}`,
  });
  const body = await readBody(res);
  const state = typeof body?.state === 'string' ? body.state : res.status === 202 ? 'queued' : '';
  const retryAfterS = typeof body?.retry_after_s === 'number' ? body.retry_after_s : null;
  return { state, retryAfterS };
}

/** One ?status=1 probe. null = unreachable / non-JSON (no affordance). */
async function fetchStatus(sci: string, pose: 1 | 2): Promise<string | null> {
  try {
    const u = `${API_BASE}/regen.php?status=1&sci=${encodeURIComponent(sci)}&pose=${pose}&_=${Date.now()}`;
    const res = await fetch(u, { cache: 'no-store' });
    const body = await readBody(res);
    return typeof body?.state === 'string' ? body.state : null;
  } catch {
    return null;
  }
}

export interface RepaintMachine {
  snapshot(): RepaintSnapshot;
  /** mount probe: feature detection + resume of an in-flight repaint. */
  start(): void;
  /** rest → confirm → (pressed again) submit; ignored in other phases. */
  press(): void;
  /** confirm → rest, silently. */
  keep(): void;
  dispose(): void;
}

// MOCK: successive presses in one dev session walk this script, so dev:mock
// can demo every phase of the machine without a backend.
const MOCK_OUTCOMES = ['swapped', 'cooldown', 'parked', 'paused'] as const;
let mockPressCount = 0;

// The machine is a plain closure (no React) so its transitions are testable
// under node with fetch/timers stubbed; useRepaint below is the thin wrapper.
export function createRepaintMachine(
  sci: string,
  getPose: () => 1 | 2,
  onChange: () => void,
): RepaintMachine {
  let snap: RepaintSnapshot = { phase: 'unavailable', retryAfterS: null, swappedAt: null };
  let disposed = false;
  // The FSM only ever has one pending timer (confirm revert, next poll, swap
  // dwell, or cooldown lift are mutually exclusive), so a single slot suffices.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let jobPose: 1 | 2 = getPose();
  let startedAt = 0;
  let polls = 0;

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const set = (phase: RepaintPhase, extra?: { retryAfterS?: number; swappedAt?: number }): void => {
    if (disposed) return;
    snap = {
      phase,
      retryAfterS: extra?.retryAfterS ?? null,
      // swappedAt persists across the swapped→idle settle so the consumer's
      // one-shot crossfade never races the dwell timer.
      swappedAt: extra?.swappedAt ?? snap.swappedAt,
    };
    onChange();
  };

  const arrive = (): void => {
    clearTimer();
    set('swapped', { swappedAt: Date.now() });
    timer = setTimeout(() => {
      if (snap.phase === 'swapped') set('idle');
    }, SWAP_DWELL_MS);
  };

  const schedulePoll = (): void => {
    const delay = POLL_MS[Math.min(polls, POLL_MS.length - 1)];
    polls += 1;
    timer = setTimeout(() => void poll(), delay);
  };

  const beginPainting = (): void => {
    clearTimer();
    startedAt = Date.now();
    polls = 0;
    set('painting');
    schedulePoll();
  };

  const poll = async (): Promise<void> => {
    if (disposed || snap.phase !== 'painting') return;
    if (Date.now() - startedAt >= POLL_BUDGET_MS) {
      // Budget spent. The species may still land server-side; the parked
      // sentence stays truthful — the painter WILL return to this plate.
      set('parked');
      return;
    }
    const state = await fetchStatus(sci, jobPose);
    if (disposed || snap.phase !== 'painting') return;
    switch (state) {
      case 'done':
      case 'idle': // marker consumed by another device — the wall already swapped
        arrive();
        return;
      case 'parked':
      case 'paused': // exhaustion mid-flight reads as the parked sentence
        set('parked');
        return;
      default:
        // queued / generating / a transient miss — keep watching, inside budget.
        schedulePoll();
    }
  };

  const beginCooldown = (retryAfterS: number): void => {
    clearTimer();
    set('cooldown', { retryAfterS });
    timer = setTimeout(() => {
      if (snap.phase === 'cooldown') set('idle');
    }, retryAfterS * 1000);
  };

  const mockSubmit = (): void => {
    const outcome = MOCK_OUTCOMES[mockPressCount % MOCK_OUTCOMES.length];
    mockPressCount += 1;
    timer = setTimeout(() => {
      if (disposed) return;
      if (outcome === 'cooldown') {
        beginCooldown(20);
        return;
      }
      if (outcome === 'paused') {
        set('paused');
        return;
      }
      // 'swapped' | 'parked' — a short scripted painting spell first.
      set('painting');
      timer = setTimeout(() => {
        if (disposed) return;
        if (outcome === 'swapped') arrive();
        else set('parked');
      }, 5000);
    }, 400);
  };

  const submit = (): void => {
    jobPose = getPose();
    set('requesting');
    if (MOCK) {
      mockSubmit();
      return;
    }
    void (async () => {
      try {
        const r = await requestRepaint(sci, jobPose);
        if (disposed || snap.phase !== 'requesting') return;
        if (r.state === 'queued') beginPainting();
        else if (r.state === 'cooldown') beginCooldown(r.retryAfterS ?? COOLDOWN_FALLBACK_S);
        else if (r.state === 'paused') set('paused');
        // busy / unavailable / anything unexpected: the button withdraws.
        else set('unavailable');
      } catch {
        if (!disposed) set('unavailable');
      }
    })();
  };

  return {
    snapshot: () => snap,
    start(): void {
      if (MOCK) {
        set('idle');
        return;
      }
      void (async () => {
        const state = await fetchStatus(sci, getPose());
        if (disposed) return;
        switch (state) {
          case 'idle':
            set('idle');
            break;
          case 'queued':
          case 'generating':
            jobPose = getPose();
            beginPainting();
            break;
          case 'done':
            arrive();
            break;
          case 'parked':
            set('parked');
            break;
          case 'paused':
            set('paused');
            break;
          default:
            set('unavailable');
        }
      })();
    },
    press(): void {
      if (snap.phase === 'idle' || snap.phase === 'swapped') {
        clearTimer();
        set('confirm');
        timer = setTimeout(() => {
          if (snap.phase === 'confirm') set('idle');
        }, CONFIRM_REVERT_MS);
      } else if (snap.phase === 'confirm') {
        clearTimer();
        submit();
      }
    },
    keep(): void {
      if (snap.phase === 'confirm') {
        clearTimer();
        set('idle');
      }
    },
    dispose(): void {
      disposed = true;
      clearTimer();
    },
  };
}

export interface UseRepaint {
  phase: RepaintPhase;
  retryAfterS: number | null;
  /** last arrival timestamp — the popup's one-shot crossfade + bust key. */
  swappedAt: number | null;
  press: () => void;
  keep: () => void;
}

/** BirdPopup is the only consumer. `enabled` = the repaintPlate setting;
 *  false keeps the machine dark (phase 'unavailable', no probe, no button). */
export function useRepaint(sci: string, pose: 1 | 2, enabled: boolean): UseRepaint {
  // The live pose feeds the machine through a ref so a pose flip mid-confirm
  // repaints what the viewer is actually looking at, without restarting the
  // machine (a flip mid-painting keeps watching the pose that was pressed).
  const poseRef = useRef<1 | 2>(pose);
  poseRef.current = pose;
  const machineRef = useRef<RepaintMachine | null>(null);
  const [snap, setSnap] = useState<RepaintSnapshot>({
    phase: 'unavailable',
    retryAfterS: null,
    swappedAt: null,
  });

  useEffect(() => {
    if (!enabled) {
      setSnap({ phase: 'unavailable', retryAfterS: null, swappedAt: null });
      return;
    }
    const m = createRepaintMachine(
      sci,
      () => poseRef.current,
      () => setSnap(m.snapshot()),
    );
    machineRef.current = m;
    m.start();
    setSnap(m.snapshot());
    return () => {
      m.dispose();
      if (machineRef.current === m) machineRef.current = null;
    };
  }, [sci, enabled]);

  return {
    phase: snap.phase,
    retryAfterS: snap.retryAfterS,
    swappedAt: snap.swappedAt,
    press: () => machineRef.current?.press(),
    keep: () => machineRef.current?.keep(),
  };
}
