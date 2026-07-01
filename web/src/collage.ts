// Collage engine — orchestrates data load, snapshot seed, live SSE deltas,
// spiral-nest layout and the Canvas2D paint-in. Framework-agnostic; App.tsx
// just hands it a <canvas> and starts it.
//
// Layout fidelity: the SEED (initial snapshot) uses the faithful apt.js
// pipeline — count-weighted areas (tuning), largest-first spiral pack, and an
// iterative shrink-to-fit so nothing is dropped off-screen. LIVE deltas add
// ONE bird at a time onto the persistent occupancy grid (no re-wipe / no
// re-pack), per the Phase 0 contract.

import type { BirdEvent, EventStream, LiveState, RosterRow, SpeciesRow, Tile } from './types';
import type { Theme } from './theme';
import type { Settings } from './settings';
import { CollageGrid, COLLAGE_PAD, GRID_STRIDE } from './packer';
import { CollageRenderer } from './renderer';
import { aspect, loadData, loadMask, slugify } from './data';
import { fetchSnapshot } from './snapshot';
import { ambientRoster } from './ambient';
import { MockStream, SseStream } from './events';
import { EVENTS_URL, MOCK } from './config';
import { PROFILE } from './profile';
import { birdImageUrl } from './img';

// Failed-tile retry loop (auto-gen watcher, CONTRACT.md "Live-update Phase A").
// A brand-new species' cutout.php 302s to Railway, which 404s until the PNG is
// generated (~30s). We retry ONLY a live-added new species' <img> (flagged
// `retryable`, within a short window) with a cache-buster so the next 302 -> 200
// paints it in without a page refresh. Seed / ambient / null-url tiles are never
// retried — that unbounded sweep is what turned the console into a 404 storm.
const RETRY_INTERVAL_MS = 30000; // ~30s between sweeps
const RETRY_MAX_TRIES = 3; // 3 sweeps -> ~90s total, then give up
const RETRY_WINDOW_MS = 90000; // only watch a live-new tile for ~90s after it lands

// Count-weighted tuning — ported verbatim from apt.js `tuning()`.
function tuning(n: number) {
  return {
    packingBudgetFrac: n <= 4 ? 0.46 : n <= 12 ? 0.4 : n <= 24 ? 0.34 : 0.28,
    countExp: 0.65,
    minTileAreaFrac: n <= 8 ? 0.01 : n <= 20 ? 0.0075 : 0.0055,
    ellipseAspectBias: 2.1,
  };
}

function makeTile(
  sci: string,
  com: string,
  slug: string,
  fullW: number,
  fullH: number,
): Tile {
  const ar = aspect(sci);
  return {
    sci,
    com,
    slug,
    mask: loadMask(slug, ar),
    ar,
    fullW,
    fullH,
    x: -99999,
    y: -99999,
    img: null,
    loaded: false,
    failed: false,
    animStart: null,
  };
}

export interface EngineCallbacks {
  onCount?: (count: number) => void;
  onStatus?: (status: string) => void;
  onLatest?: (com: string) => void;
  /** The live species roster (snapshot + live increments), for the React views. */
  onData?: (rows: RosterRow[]) => void;
  /** Live SSE connection state — drives the counter's live/idle/offline dot. */
  onLive?: (s: LiveState) => void;
  /** Fired at most once after the seed's illustrations settle, so the frame /
   *  print path can call markFrameReady() (spec §5.4). */
  onReady?: () => void;
}

export class CollageEngine {
  private readonly renderer: CollageRenderer;
  private grid: CollageGrid;
  private stream: EventStream | null = null;
  private W = 0;
  private H = 0;
  private xBias = 1;
  private yBias = 1;
  private pad = COLLAGE_PAD;
  /** representative live-tile area, derived from the seed (keeps live birds
   *  visually consistent with the seeded plate without a full re-pack). */
  private areaHint = 0;
  private started = false;
  private disposed = false;
  /** failed-tile retry loop (auto-gen watcher live-update). */
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private retryCount = 0;
  private readonly cb: EngineCallbacks;
  /** species roster (snapshot counts + live increments) → React views. */
  private readonly roster = new Map<string, RosterRow>();
  /** ambient backdrop tiles on their OWN grid — painted behind the real birds
   *  and NEVER counted (the honesty firewall). */
  private ambientGrid: CollageGrid | null = null;
  private ambientMode: Settings['ambientFill'] = 'roster';
  private ambientDensity: Settings['density'] = 'balanced';
  /** all-time life list, fetched lazily once for the `roster` ambient mode. */
  private allTime: SpeciesRow[] = [];
  private allTimeFetched = false;
  private allTimePending = false;
  /** cb.onReady fires at most once, after the first seed's images settle. */
  private onReadyFired = false;

  constructor(canvas: HTMLCanvasElement, cb: EngineCallbacks = {}) {
    this.cb = cb;
    this.renderer = new CollageRenderer(canvas);
    const rect = canvas.getBoundingClientRect();
    this.W = Math.max(1, rect.width);
    this.H = Math.max(1, rect.height);
    this.grid = new CollageGrid(this.W, this.H);
    this.computeBiases();
  }

  private computeBiases(): void {
    const narrow = this.W <= 700;
    const T = tuning(20);
    this.xBias = narrow ? 1 : T.ellipseAspectBias;
    this.yBias = narrow ? 1.7 : 1;
    this.pad = narrow ? Math.max(1, COLLAGE_PAD - 1) : COLLAGE_PAD;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.cb.onStatus?.('loading masks');
    await loadData();
    if (this.disposed) return;
    this.syncTiles();
    this.renderer.resize(this.W, this.H);

    this.cb.onStatus?.('loading snapshot');
    try {
      const snapshot = await fetchSnapshot();
      if (this.disposed) return;
      this.seed(snapshot);
    } catch (err) {
      this.cb.onStatus?.(`snapshot failed: ${String(err)}`);
    }

    if (this.disposed) return;
    this.connectLive();
  }

  /** Faithful initial pack of the snapshot (apt.js renderCollage pipeline). */
  private seed(species: SpeciesRow[]): void {
    const { W, H } = this;
    if (!species.length) {
      this.cb.onStatus?.(MOCK ? 'mock — waiting for birds' : 'no birds in window');
      this.cb.onCount?.(0);
      // Never barren: even with nothing in-window, paint the ambient cast and
      // let the frame/print path settle (a listening screen is a valid capture).
      this.populateAmbient();
      // Emit the (now-cleared) roster so React's rows don't stay stale on the
      // previous window — species=0 / calls=0 / LISTENING.
      this.emitRoster();
      this.fireReady();
      return;
    }
    const T = tuning(species.length);
    const vpArea = W * H;
    const budget = vpArea * T.packingBudgetFrac;
    const minArea = vpArea * T.minTileAreaFrac;

    // Step 1: count-weighted score (sub-linear so a loud bird doesn't drown).
    const scored = species.map((s) => {
      const n = !s.n || Number.isNaN(s.n) ? 1 : s.n;
      return { s, score: Math.pow(Math.max(1, n), T.countExp), area: 0 };
    });
    // Step 2: normalise to budget, floor each at minArea.
    const sumScore = scored.reduce((a, t) => a + t.score, 0) || 1;
    scored.forEach((t) => {
      t.area = Math.max(minArea, (budget * t.score) / sumScore);
    });
    // Squeeze the over-budget remainder out of the larger tiles only.
    const sumA = scored.reduce((a, t) => a + t.area, 0);
    if (sumA > budget) {
      const fixedSum = scored
        .filter((t) => t.area <= minArea + 1e-9)
        .reduce((a, t) => a + t.area, 0);
      const flexSum = sumA - fixedSum;
      const flexBudget = Math.max(0, budget - fixedSum);
      const shrink = flexSum > 0 ? Math.min(1, flexBudget / flexSum) : 1;
      scored.forEach((t) => {
        if (t.area > minArea + 1e-9) t.area *= shrink;
      });
    }
    // Step 3: area + aspect -> width/height -> tiles.
    const tiles = scored.map((t) => {
      const slug = slugify(t.s.sci);
      const ar = aspect(t.s.sci);
      const fullW = Math.sqrt(t.area * ar);
      return makeTile(t.s.sci, t.s.com, slug, fullW, fullW / ar);
    });

    // Iterative shrink-to-fit: re-pack into a fresh grid until everything
    // lands on screen (apt.js scale-to-fit loop). Keep the final grid.
    let grid = new CollageGrid(W, H, GRID_STRIDE, this.pad);
    grid.seed(tiles, this.xBias, this.yBias);
    for (let iter = 0; iter < 10; iter++) {
      const b = bounds(grid.onScreen());
      const missing = tiles.some((t) => t.x <= -99998);
      const overflow = b.L < 0 || b.T < 0 || b.R > W || b.B > H;
      if (!missing && !overflow) break;
      let scale = 0.93;
      if (overflow) {
        const clW = b.R - b.L;
        const clH = b.B - b.T;
        const sx = (W * 0.96) / Math.max(clW, W * 0.96);
        const sy = (H * 0.94) / Math.max(clH, H * 0.94);
        scale = Math.min(scale, sx, sy);
      }
      tiles.forEach((t) => {
        t.fullW *= scale;
        t.fullH *= scale;
      });
      grid = new CollageGrid(W, H, GRID_STRIDE, this.pad);
      grid.seed(tiles, this.xBias, this.yBias);
    }

    // Re-centre the cluster, then resync the grid to the moved positions so
    // live placement collides against the right cells.
    const b = bounds(grid.onScreen());
    const dx = W / 2 - (b.L + b.R) / 2;
    const dy = H / 2 - (b.T + b.B) / 2;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
      grid.placed.forEach((t) => {
        if (t.x > -99998) {
          t.x += dx;
          t.y += dy;
        }
      });
      grid.restamp();
    }

    this.grid = grid;
    // Representative area for live additions: median seeded tile area.
    const areas = tiles.map((t) => t.fullW * t.fullH).sort((a, c) => a - c);
    this.areaHint = areas.length ? areas[areas.length >> 1] : vpArea * 0.012;

    // Seed the species roster (drives the Index / Stats / Atlas views).
    species.forEach((s) => {
      const n = !s.n || Number.isNaN(s.n) ? 1 : s.n;
      this.bumpRoster(s.sci, s.com, slugify(s.sci), n, false);
    });
    this.emitRoster();

    // Seed reveals instantly (no paint-in storm); live deltas paint in. Fire
    // cb.onReady once every seed illustration has settled (decoded or errored)
    // so the frame/print path can mark itself capture-ready (spec §5.4).
    let pending = tiles.length;
    const settle = (): void => {
      pending -= 1;
      if (pending <= 0) this.fireReady();
    };
    tiles.forEach((t) => {
      t.animStart = null;
      this.loadImage(t, false, settle);
    });
    this.syncTiles();
    this.renderer.requestDraw();
    this.cb.onCount?.(this.grid.onScreen().length);
    this.cb.onStatus?.(MOCK ? 'mock live' : 'live');

    // Never barren: paint the ambient backdrop cast behind the composed birds.
    this.populateAmbient();
  }

  /** Add ONE bird incrementally — no re-wipe, no re-pack (contract). */
  addBird(ev: BirdEvent): void {
    const sci = ev.sci;
    const slug = ev.slug || slugify(sci);
    const ar = aspect(sci);
    // TODO(phase1): live tiles use a representative area, NOT the global
    // count-weighted re-normalisation, because re-normalising would require
    // re-packing the whole collage (forbidden in Phase 0). The WebGL painter
    // can re-flow continuously.
    const conf = Number.isFinite(ev.conf) ? ev.conf : 0.8;
    const base = this.areaHint || this.W * this.H * 0.012;
    const area = base * (0.7 + 0.6 * Math.max(0, Math.min(1, conf)));
    const fullW = Math.sqrt(area * ar);
    const tile = makeTile(sci, ev.com, slug, fullW, fullW / ar);
    tile.animStart = this.renderer.reducedMotion ? null : performance.now();

    // Only a live-added NEW species is worth retrying (its cutout PNG may still
    // be generating). Flag it retryable + timestamp it so the bounded loop can
    // stop watching after ~90s — seed / ambient / long-tail tiles never retry.
    const isNewSpecies = !this.roster.has(sci);
    if (isNewSpecies) {
      tile.retryable = true;
      tile.addedAt = performance.now();
      // Re-arm the retry budget so a species detected long after boot still gets
      // its cutout retried: resets the count (extends the budget if the loop is
      // alive) and restarts the loop if it already gave up. The per-tile
      // RETRY_WINDOW_MS guard still ages tiles out, so this stays bounded.
      this.retryCount = 0;
      this.startRetryLoop();
    }

    this.grid.placeOne(tile, this.xBias, this.yBias);
    this.loadImage(tile);

    this.bumpRoster(sci, ev.com, slug, 1, isNewSpecies);

    // Evict this species' ambient GHOST so a live detection of a currently-ambient
    // bird doesn't show as BOTH a counted live tile and an uncounted ghost. Mutate
    // the placed list in place (it's readonly) — no populateAmbient, so the other
    // ambient tiles keep their positions.
    if (this.ambientGrid) {
      const kept = this.ambientGrid.placed.filter(
        (t) => t.sci.toLowerCase() !== sci.toLowerCase(),
      );
      this.ambientGrid.placed.length = 0;
      this.ambientGrid.placed.push(...kept);
    }

    this.syncTiles();
    this.renderer.requestDraw();
    this.cb.onCount?.(this.grid.onScreen().length);
    this.cb.onLatest?.(ev.com || sci);
    this.emitRoster();
  }

  private loadImage(tile: Tile, bust = false, onSettle?: () => void): void {
    let url = birdImageUrl(tile.slug, tile.sci);
    if (!url) {
      tile.failed = true;
      tile.loaded = true; // settled (placeholder)
      tile.retryable = false; // nothing to fetch — never retry a null-url tile
      onSettle?.();
      return;
    }
    // Cache-buster ONLY on a retry (never on first load), so the browser
    // re-requests a tile whose earlier 302->Railway 404'd. `&` when the URL
    // already carries a query (cutout.php?sci=...&pose=1), `?` otherwise.
    if (bust) {
      url += (url.includes('?') ? '&' : '?') + 't=' + Date.now();
    }
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      tile.img = img;
      tile.loaded = true;
      this.renderer.requestDraw();
      onSettle?.();
    };
    img.onerror = () => {
      tile.failed = true;
      tile.loaded = true;
      this.renderer.requestDraw();
      onSettle?.();
    };
    img.src = url;
  }

  private connectLive(): void {
    this.stream = MOCK ? new MockStream() : new SseStream(EVENTS_URL);
    this.stream.start({
      onHello: () => this.cb.onStatus?.(MOCK ? 'mock live' : 'live'),
      onBird: (ev) => this.addBird(ev),
      onError: () => this.cb.onStatus?.('reconnecting…'),
      onState: (s) => this.cb.onLive?.(s),
    });
    this.startRetryLoop();
  }

  /** Periodically re-attempt any tile whose image failed to load. A brand-new
   *  species redirects (cutout.php 302) to Railway, which 404s until the asset
   *  is generated (~30s); retrying with a cache-buster paints it in once ready,
   *  with no page refresh. Bounded to ~3 sweeps (~90s) then gives up (re-armed by
   *  addBird when a new species lands, so late detections still get retried). */
  private startRetryLoop(): void {
    if (this.retryTimer !== null) return;
    this.retryCount = 0;
    this.retryTimer = setInterval(() => {
      this.retryCount += 1;
      if (this.retryCount > RETRY_MAX_TRIES) {
        this.stopRetryLoop();
        return;
      }
      const now = performance.now();
      for (const tile of this.grid.placed) {
        // Only live-added NEW species are retryable; seed / ambient / null-url
        // tiles are skipped so the console never storms on the long tail.
        if (tile.retryable !== true || tile.failed !== true) continue;
        if (tile.addedAt !== undefined && now - tile.addedAt > RETRY_WINDOW_MS) {
          tile.retryable = false; // aged out — stop watching this tile
          continue;
        }
        tile.failed = false;
        tile.loaded = false;
        this.loadImage(tile, true);
      }
    }, RETRY_INTERVAL_MS);
  }

  private stopRetryLoop(): void {
    if (this.retryTimer !== null) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** Resize the backing canvas. Phase 0 keeps existing bird POSITIONS (no
   *  re-pack), but the occupancy grid is rebuilt at the new size and existing
   *  tiles re-stamped, so the bounds + centre used for FUTURE live placement
   *  track the new viewport (otherwise new birds nest around the stale centre). */
  resize(W: number, H: number): void {
    this.W = Math.max(1, W);
    this.H = Math.max(1, H);
    this.computeBiases();
    const next = new CollageGrid(this.W, this.H, GRID_STRIDE, this.pad);
    for (const t of this.grid.placed) next.placed.push(t);
    next.restamp();
    this.grid = next;
    this.syncTiles();
    this.renderer.resize(this.W, this.H);
  }

  /** Re-fetch the snapshot for a new time window and re-seed; live SSE keeps
   *  running. The 1H/12H/24H/7D/ALL filter calls this. */
  async setWindow(hours: number): Promise<void> {
    if (this.disposed) return;
    this.cb.onStatus?.('loading snapshot');
    try {
      const snapshot = await fetchSnapshot(hours);
      if (this.disposed) return;
      this.roster.clear();
      this.seed(snapshot);
    } catch (err) {
      this.cb.onStatus?.(`snapshot failed: ${String(err)}`);
    }
  }

  /** Forward the active theme to the canvas renderer (glow vs contact shadow). */
  setTheme(theme: Theme): void {
    this.renderer.setTheme(theme);
  }

  /** Toggle idle ambient life (cluster breath + per-bird drift) on the renderer.
   *  Reduced-motion / e-ink already zero the amplitudes inside the renderer. */
  setMotion(on: boolean): void {
    this.renderer.setMotion(on);
  }

  /** Set the never-barren ambient backdrop mode + density and rebuild it now.
   *  Ambient tiles are a low-opacity "cast that has visited" painted behind the
   *  real birds; they are NEVER counted (the honesty firewall). */
  setAmbient(mode: Settings['ambientFill'], density: Settings['density']): void {
    this.ambientMode = mode;
    this.ambientDensity = density;
    this.populateAmbient();
  }

  /** (Re)build the ambient backdrop for the current real roster + settings, on a
   *  SEPARATE grid, and compose it behind the real birds. Skipped entirely on
   *  e-ink prints, under reduced-motion, or when the fill is off. Never calls
   *  bumpRoster — the counter must reflect real detections only. */
  private populateAmbient(): void {
    const disabled =
      PROFILE.surface === 'eink' || this.renderer.reducedMotion || this.ambientMode === 'off';
    if (disabled) {
      if (this.ambientGrid) {
        this.ambientGrid = null;
        this.syncTiles();
        this.renderer.requestDraw();
      }
      return;
    }

    // Lazily fetch the all-time life list once (guarded); it rebuilds on arrival.
    this.ensureAllTime();

    const cast = ambientRoster({
      realRoster: [...this.roster.values()],
      allTime: this.allTime,
      mode: this.ambientMode,
      density: this.ambientDensity,
    });

    const grid = new CollageGrid(this.W, this.H, GRID_STRIDE, this.pad);
    const base = this.areaHint || this.W * this.H * 0.012;
    for (const a of cast) {
      const slug = slugify(a.sci);
      const ar = aspect(a.sci);
      // Backdrop tiles sit a touch smaller than live birds so they recede.
      const fullW = Math.sqrt(base * 0.9 * ar);
      const tile = makeTile(a.sci, a.com, slug, fullW, fullW / ar);
      tile.ambient = true;
      tile.animStart = null; // backdrop never reveals
      grid.placeOne(tile, this.xBias, this.yBias);
      this.loadImage(tile); // honesty firewall: never bumpRoster for ambient
    }
    this.ambientGrid = grid;
    this.syncTiles();
    this.renderer.requestDraw();
  }

  /** Fetch the all-time roster ONCE for the `roster` ambient mode, then rebuild
   *  ambient against it. Failure just leaves the legacy fallback (ambientRoster). */
  private ensureAllTime(): void {
    if (this.allTimeFetched || this.allTimePending) return;
    this.allTimePending = true;
    fetchSnapshot(1_000_000)
      .then((rows) => {
        this.allTimeFetched = true;
        this.allTimePending = false;
        if (this.disposed) return;
        this.allTime = rows;
        this.populateAmbient();
      })
      .catch(() => {
        this.allTimeFetched = true;
        this.allTimePending = false;
      });
  }

  /** Compose the renderer's draw list: ambient backdrop first (so it paints
   *  BEHIND), then the real placed tiles on top. With no ambient layer the real
   *  list is passed as-is — identical to the pre-ambient behaviour. */
  private syncTiles(): void {
    const ambient = this.ambientGrid?.placed;
    this.renderer.setTiles(
      ambient && ambient.length ? [...ambient, ...this.grid.placed] : this.grid.placed,
    );
  }

  /** Fire cb.onReady exactly once (idempotent), after the first seed settles. */
  private fireReady(): void {
    if (this.onReadyFired) return;
    this.onReadyFired = true;
    this.cb.onReady?.();
  }

  private bumpRoster(
    sci: string,
    com: string,
    slug: string,
    addN: number,
    markNew: boolean,
  ): void {
    const existing = this.roster.get(sci);
    if (existing) {
      existing.n += addN;
    } else {
      this.roster.set(sci, { sci, com, slug, n: addN, isNew: markNew });
    }
  }

  private emitRoster(): void {
    if (!this.cb.onData) return;
    this.cb.onData([...this.roster.values()].sort((a, b) => b.n - a.n));
  }

  destroy(): void {
    this.disposed = true;
    this.stopRetryLoop();
    this.stream?.stop();
    this.renderer.destroy();
  }
}

function bounds(tiles: Tile[]): { L: number; R: number; T: number; B: number } {
  let L = Infinity;
  let R = -Infinity;
  let T = Infinity;
  let B = -Infinity;
  for (const t of tiles) {
    if (t.x < L) L = t.x;
    if (t.x + t.fullW > R) R = t.x + t.fullW;
    if (t.y < T) T = t.y;
    if (t.y + t.fullH > B) B = t.y + t.fullH;
  }
  if (!Number.isFinite(L)) return { L: 0, R: 0, T: 0, B: 0 };
  return { L, R, T, B };
}
