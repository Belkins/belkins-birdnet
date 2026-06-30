// Event sources feeding live `bird.detected` deltas into the collage.
//   - SseStream: real backend. EventSource auto-sends Last-Event-ID on
//     reconnect, so the birdcast ring-buffer replay (per the contract) works
//     transparently — we just parse frames.
//   - MockStream: self-contained generator, ~every few seconds, cycling real
//     slugs. No backend, used when VITE_MOCK=1.

import type { BirdEvent, EventStream, HelloEvent, StreamHandlers } from './types';
import { MOCK_INTERVAL_MS } from './config';
import { mockBirdEvent, MOCK_SPECIES } from './mockData';

/** Real Server-Sent-Events source against `/events`. */
export class SseStream implements EventStream {
  private es: EventSource | null = null;
  private readonly url: string;
  constructor(url: string) {
    this.url = url;
  }

  start(handlers: StreamHandlers): void {
    const es = new EventSource(this.url);
    this.es = es;

    es.addEventListener('hello', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as HelloEvent;
        handlers.onHello?.(data.cursor);
      } catch (err) {
        handlers.onError?.(err);
      }
    });

    es.addEventListener('bird.detected', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as BirdEvent;
        handlers.onBird(data);
      } catch (err) {
        handlers.onError?.(err);
      }
    });

    es.onerror = (err) => handlers.onError?.(err);
  }

  stop(): void {
    this.es?.close();
    this.es = null;
  }
}

/** Self-contained mock generator (no backend). */
export class MockStream implements EventStream {
  private timer: ReturnType<typeof setInterval> | null = null;
  private cursor = 1000;
  private idx = 0;

  start(handlers: StreamHandlers): void {
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
