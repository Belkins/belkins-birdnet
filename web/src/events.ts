// Event sources feeding live `bird.detected` deltas into the collage.
//   - SseStream: real backend. We bound EventSource's auto-reconnect: count
//     consecutive failures, back off exponentially (capped), and after a
//     budget close the socket and go `offline` instead of retrying forever.
//     Replay/dedup on reconnect rides on the `hello` cursor (per the contract).
//   - MockStream: self-contained generator, ~every few seconds, cycling real
//     slugs. No backend, used when VITE_MOCK=1.

import type { BirdEvent, EventStream, HelloEvent, StreamHandlers } from './types';
import { MOCK_INTERVAL_MS } from './config';
import { mockBirdEvent, MOCK_SPECIES } from './mockData';

/** Bounded reconnect: give up (go `offline`) after this many consecutive fails. */
const MAX_RECONNECT_ATTEMPTS = 6;
/** First backoff wait (ms); doubles each attempt, capped at RECONNECT_MAX_MS. */
const RECONNECT_BASE_MS = 1000;
/** Upper bound on a single backoff wait (ms). */
const RECONNECT_MAX_MS = 30000;
/** Cadence of the slow keep-trying path once the fast budget is spent (ms). One
 *  request a minute is invisible to the Pi and is what lets an unattended wall
 *  come back on its own after an outage longer than the 61s fast ladder. */
const IDLE_RETRY_MS = 60000;

/** Real Server-Sent-Events source against `/events`. */
export class SseStream implements EventStream {
  private es: EventSource | null = null;
  private readonly url: string;
  private handlers: StreamHandlers | null = null;
  /** consecutive connection failures since the last successful frame. */
  private failures = 0;
  /** true once a `hello`/first frame proved this connection is alive. */
  private connected = false;
  /** set by stop() so a late error can't schedule another reconnect. */
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** true while the online/visibilitychange wake listeners are attached. */
  private wakeBound = false;
  constructor(url: string) {
    this.url = url;
  }

  start(handlers: StreamHandlers): void {
    this.handlers = handlers;
    this.stopped = false;
    this.failures = 0;
    handlers.onState?.('connecting');
    this.open();
  }

  /** Open one EventSource; each open must re-prove liveness before counting. */
  private open(): void {
    const handlers = this.handlers;
    if (!handlers) return;
    this.connected = false;
    const es = new EventSource(this.url);
    this.es = es;

    es.addEventListener('hello', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as HelloEvent;
        this.markLive();
        handlers.onHello?.(data.cursor);
      } catch (err) {
        handlers.onError?.(err);
      }
    });

    es.addEventListener('bird.detected', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as BirdEvent;
        this.markLive();
        handlers.onBird(data);
      } catch (err) {
        handlers.onError?.(err);
      }
    });

    es.onerror = (err) => {
      handlers.onError?.(err);
      this.onTransientError();
    };
  }

  /** First good frame on a connection: clear the failure budget, go `live`. */
  private markLive(): void {
    if (!this.connected) {
      this.connected = true;
      this.failures = 0;
      this.handlers?.onState?.('live');
    }
  }

  /** Take reconnection over from the native EventSource so it can't loop forever. */
  private onTransientError(): void {
    if (this.stopped) return;
    this.es?.close();
    this.es = null;
    this.failures++;
    if (this.failures >= MAX_RECONNECT_ATTEMPTS) {
      // Budget spent: stop the FAST loop and surface `offline` — but never stop
      // trying altogether. The exponential ladder is 1+2+4+8+16+30 = 61s, so any
      // outage longer than a minute (a router reboot, a birdcast restart, the Pi
      // dropping off the wifi) used to leave this wall permanently dead until a
      // human pressed reload. An unattended wall that needs F5 reads as broken,
      // not as slow. So: keep the `offline` state, but retry on a slow, cheap
      // cadence (one request a minute, not a hot loop), and wake immediately when
      // the browser says the network is back or the viewer returns to the tab.
      this.handlers?.onState?.('offline');
      this.armIdleRetry();
      return;
    }
    this.handlers?.onState?.('reconnecting');
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** (this.failures - 1),
      RECONNECT_MAX_MS,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  /** Slow keep-trying path used only once the fast budget is spent. */
  private armIdleRetry(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.addWakeListeners();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.retryNow();
    }, IDLE_RETRY_MS);
  }

  /** Reopen at once. `failures` is reset so a recovered backend gets the full
   *  fast budget again rather than one grudging attempt; markLive() also resets
   *  it, so a genuine reconnection restores normal behaviour either way. */
  private retryNow(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failures = 0;
    this.handlers?.onState?.('reconnecting');
    this.open();
  }

  private addWakeListeners(): void {
    if (this.wakeBound) return;
    this.wakeBound = true;
    window.addEventListener('online', this.onWake);
    document.addEventListener('visibilitychange', this.onWake);
  }

  private removeWakeListeners(): void {
    if (!this.wakeBound) return;
    this.wakeBound = false;
    window.removeEventListener('online', this.onWake);
    document.removeEventListener('visibilitychange', this.onWake);
  }

  /** Bound field, not a method, so add/removeEventListener see one identity. */
  private onWake = (): void => {
    if (this.stopped || this.es) return;
    if (document.visibilityState === 'hidden') return;
    this.retryNow();
  };

  stop(): void {
    this.stopped = true;
    // Must run before the early returns below: a leaked window/document listener
    // would outlive the stream and resurrect it after teardown (StrictMode
    // double-mounts this in dev, so a leak shows up as two live streams).
    this.removeWakeListeners();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.es?.close();
    this.es = null;
    this.handlers = null;
  }
}

/** Self-contained mock generator (no backend). */
export class MockStream implements EventStream {
  private timer: ReturnType<typeof setInterval> | null = null;
  private cursor = 1000;
  private idx = 0;

  start(handlers: StreamHandlers): void {
    handlers.onState?.('live');
    handlers.onHello?.(this.cursor);
    this.timer = setInterval(() => {
      // Bias toward the asset-backed species; occasionally fire the
      // default-mask demo species so the fallback path is exercised live.
      let index: number;
      if (Math.random() < 0.12) {
        index = MOCK_SPECIES.length - 1; // the default-mask demo
      } else {
        index = this.idx % (MOCK_SPECIES.length - 1);
        this.idx++;
      }
      this.cursor++;
      handlers.onBird(mockBirdEvent(index, this.cursor));
    }, MOCK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
