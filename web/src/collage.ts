// Collage engine — orchestrates data load, snapshot seed, live SSE deltas,
// spiral-nest layout and the Canvas2D paint-in. Framework-agnostic; App.tsx
// just hands it a <canvas> and starts it.
//
// Layout fidelity: the SEED (initial snapshot) uses the faithful apt.js
// pipeline — count-weighted areas (tuning), largest-first spiral pack, and an
// iterative shrink-to-fit so nothing is dropped off-screen. LIVE deltas add
// ONE bird at a time onto the persistent occupancy grid (no re-wipe / no
// re-pack), per the Phase 0 contract.

import type { BirdEvent, EventStream, SpeciesRow, Tile } from './types';
import { CollageGrid, COLLAGE_PAD, GRID_STRIDE } from './packer';
import { CollageRenderer } from './renderer';
import { aspect, loadData, loadMask, slugify } from './data';
import { fetchSnapshot } from './snapshot';
import { MockStream, SseStream } from './events';
import { API_BASE, BASE, EVENTS_URL, MOCK } from './config';
import { MOCK_SPECIES } from './mockData';

// Count-weighted tuning — ported verbatim from apt.js `tuning()`.
function tuning(n: number) {
  return {
    packingBudgetFrac: n <= 4 ? 0.46 : n <= 12 ? 0.4 : n <= 24 ? 0.34 : 0.28,
    countExp: 0.65,
    minTileAreaFrac: n <= 8 ? 0.01 : n <= 20 ? 0.0075 : 0.0055,
    ellipseAspectBias: 2.1,
  };
}

// Mock slugs that actually have a bundled PNG (others -> placeholder).
const MOCK_ASSET_SLUGS = new Set(
  MOCK_SPECIES.filter((s) => s.hasAsset).map((s) => slugify(s.sci)),
);

function imageUrl(slug: string, sci: string): string | null {
  if (MOCK) return MOCK_ASSET_SLUGS.has(slug) ? `${BASE}mock/${slug}.png` : null;
  return `${API_BASE}/cutout.php?sci=${encodeURIComponent(sci)}&pose=1`;
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
  private readonly cb: EngineCallbacks;

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
    this.renderer.setTiles(this.grid.placed);
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

    // Seed reveals instantly (no paint-in storm); live deltas paint in.
    tiles.forEach((t) => {
      t.animStart = null;
      this.loadImage(t);
    });
    this.renderer.setTiles(this.grid.placed);
    this.renderer.requestDraw();
    this.cb.onCount?.(this.grid.placed.length);
    this.cb.onStatus?.(MOCK ? 'mock live' : 'live');
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

    this.grid.placeOne(tile, this.xBias, this.yBias);
    this.loadImage(tile);

    this.renderer.setTiles(this.grid.placed);
    this.renderer.requestDraw();
    this.cb.onCount?.(this.grid.placed.length);
    this.cb.onLatest?.(ev.com || sci);
  }

  private loadImage(tile: Tile): void {
    const url = imageUrl(tile.slug, tile.sci);
    if (!url) {
      tile.failed = true;
      tile.loaded = true; // settled (placeholder)
      return;
    }
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      tile.img = img;
      tile.loaded = true;
      this.renderer.requestDraw();
    };
    img.onerror = () => {
      tile.failed = true;
      tile.loaded = true;
      this.renderer.requestDraw();
    };
    img.src = url;
  }

  private connectLive(): void {
    this.stream = MOCK ? new MockStream() : new SseStream(EVENTS_URL);
    this.stream.start({
      onHello: () => this.cb.onStatus?.(MOCK ? 'mock live' : 'live'),
      onBird: (ev) => this.addBird(ev),
      onError: () => this.cb.onStatus?.('reconnecting…'),
    });
  }

  /** Resize the backing canvas. Phase 0 keeps existing positions (no re-pack);
   *  the cluster simply stays within the resized canvas. */
  resize(W: number, H: number): void {
    this.W = Math.max(1, W);
    this.H = Math.max(1, H);
    this.renderer.resize(this.W, this.H);
  }

  destroy(): void {
    this.disposed = true;
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
