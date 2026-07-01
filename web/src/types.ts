// Shared types for the Phase 0 collage shell.

/** One species row from the snapshot API (`action=recent`). */
export interface SpeciesRow {
  sci: string;
  com: string;
  /** total calls in the window (drives relative size in the seed pack). */
  n: number;
}

/** A roster entry the engine emits to the React views (Index / Stats / Atlas):
 *  snapshot counts plus live increments, with a slug + "new this session" flag. */
export interface RosterRow {
  sci: string;
  com: string;
  slug: string;
  n: number;
  isNew: boolean;
}

/** The `bird.detected` SSE frame — LOCKED by PHASE-0-CONTRACT.md. */
export interface BirdEvent {
  v: number;
  type: 'bird.detected';
  cursor: number;
  sci: string;
  com: string;
  slug: string;
  conf: number;
  conf_pct: number;
  iso8601: string;
  date: string;
  time: string;
  week: number;
  file: string;
}

/** The one-shot `hello` frame sent on connect. */
export interface HelloEvent {
  v: number;
  type: 'hello';
  cursor: number;
}

/** Decoded binary alpha mask: sparse list of "on" cells in mask-grid coords. */
export interface Mask {
  w: number;
  h: number;
  /** [x, y] of each opaque cell. */
  cells: Array<[number, number]>;
  /** true when this is the aspect-1.4 default bbox (no real silhouette). */
  isDefault: boolean;
}

/** A bird placed in the collage. */
export interface Tile {
  sci: string;
  com: string;
  slug: string;
  /** 1 = perched (default), 2 = flight. Drives the cutout image + box aspect. */
  pose: 1 | 2;
  mask: Mask;
  /** width/height aspect ratio from DIMS (or 1.4 default). */
  ar: number;
  /** rendered footprint in viewport px. */
  fullW: number;
  fullH: number;
  /** top-left in viewport px (-99999 = not yet placed). */
  x: number;
  y: number;
  /** image element + load state, owned by the renderer. */
  img: HTMLImageElement | null;
  loaded: boolean;
  failed: boolean;
  /** paint-in animation start time (performance.now) or null when settled. */
  animStart: number | null;
  /** ambient/never-counted backdrop layer (does not feed the live counter). */
  ambient?: boolean;
  /** eligible for the bounded image retry after a load failure. */
  retryable?: boolean;
  /** performance.now() when this tile entered the collage (drives retry timing). */
  addedAt?: number;
}

/** Live connection state surfaced by an event stream (drives the counter dot). */
export type LiveState = 'connecting' | 'live' | 'idle' | 'reconnecting' | 'offline';

/** Handlers a caller registers on an event stream. */
export interface StreamHandlers {
  onHello?: (cursor: number) => void;
  onBird: (ev: BirdEvent) => void;
  onError?: (err: unknown) => void;
  onState?: (s: LiveState) => void;
}

/** Pluggable event source: real SSE or the mock generator. */
export interface EventStream {
  start(handlers: StreamHandlers): void;
  stop(): void;
}
