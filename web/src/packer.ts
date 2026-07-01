// Spiral-nest packer with an occupancy grid — ported from the `maskPack()`
// in avian/frontend/apt.js. The original re-packs the WHOLE collage on every
// render; Phase 0 needs INCREMENTAL placement (add ONE bird, never re-wipe),
// so the grid + placed list are made persistent and a single `placeOne()`
// nests a new tile against everything already on screen.
//
// Algorithm (unchanged from apt.js): maintain a viewport-resolution occupancy
// grid; for each tile, spiral outward from the cluster centre and take the
// closest non-colliding position. Masks are polygon-aware (sparse opaque
// cells), so birds nest into each other's concavities. A `pad` dilation on
// stamping bakes a uniform visual gap around every silhouette.

import type { Tile } from './types';

/** viewport px per occupancy cell; smaller = tighter but slower (apt.js). */
export const GRID_STRIDE = 4;
/** breathing room (grid cells) around each bird. Tight on purpose: the seed
 *  reads as one composed ROSETTE (birds nesting into each other's concavities,
 *  transparent illustration margins overlapping) rather than a spaced-out
 *  sticker-sheet with dead voids. Was 4 (≈32px gap) → 2 (≈16px gap). */
export const COLLAGE_PAD = 2;

const OFFSCREEN = -99999;

export class CollageGrid {
  readonly W: number;
  readonly H: number;
  private readonly GW: number;
  private readonly GH: number;
  private readonly stride: number;
  private readonly pad: number;
  private grid: Uint8Array;
  /** every tile that has been placed (settled or animating). */
  readonly placed: Tile[] = [];
  // seeded PRNG keeps layouts deterministic across resizes (apt.js).
  private prngState = 0x9e3779b9;

  constructor(W: number, H: number, stride = GRID_STRIDE, pad = COLLAGE_PAD) {
    this.W = W;
    this.H = H;
    this.stride = stride;
    this.pad = pad;
    this.GW = Math.ceil(W / stride) + 2;
    this.GH = Math.ceil(H / stride) + 2;
    this.grid = new Uint8Array(this.GW * this.GH);
  }

  private rand(): number {
    this.prngState = (this.prngState * 16807) % 2147483647;
    return this.prngState / 2147483647;
  }

  // For mask cell c, the inclusive grid-cell range the tile covers at (tx,ty).
  private cellRange(tile: Tile, tx: number, ty: number, cx: number, cy: number) {
    const sx = tile.fullW / tile.mask.w;
    const sy = tile.fullH / tile.mask.h;
    let x0 = ((tx + cx * sx) / this.stride) | 0;
    let y0 = ((ty + cy * sy) / this.stride) | 0;
    let x1 = ((tx + (cx + 1) * sx) / this.stride) | 0;
    let y1 = ((ty + (cy + 1) * sy) / this.stride) | 0;
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 >= this.GW) x1 = this.GW - 1;
    if (y1 >= this.GH) y1 = this.GH - 1;
    return [x0, y0, x1, y1] as const;
  }

  private collides(tile: Tile, tx: number, ty: number): boolean {
    const cells = tile.mask.cells;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const [gx0, gy0, gx1, gy1] = this.cellRange(tile, tx, ty, c[0], c[1]);
      for (let gy = gy0; gy <= gy1; gy++) {
        const off = gy * this.GW;
        for (let gx = gx0; gx <= gx1; gx++) {
          if (this.grid[off + gx]) return true;
        }
      }
    }
    return false;
  }

  private stamp(tile: Tile, tx: number, ty: number): void {
    const cells = tile.mask.cells;
    const pad = this.pad;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const [rx0, ry0, rx1, ry1] = this.cellRange(tile, tx, ty, c[0], c[1]);
      // Dilate the stamp by `pad` cells so the next bird keeps a uniform gap.
      let gy0 = ry0 - pad;
      let gy1 = ry1 + pad;
      let gx0 = rx0 - pad;
      let gx1 = rx1 + pad;
      if (gy0 < 0) gy0 = 0;
      if (gx0 < 0) gx0 = 0;
      if (gy1 >= this.GH) gy1 = this.GH - 1;
      if (gx1 >= this.GW) gx1 = this.GW - 1;
      for (let gy = gy0; gy <= gy1; gy++) {
        const off = gy * this.GW;
        for (let gx = gx0; gx <= gx1; gx++) this.grid[off + gx] = 1;
      }
    }
  }

  private offGrid(tile: Tile, tx: number, ty: number): boolean {
    return tx < 0 || ty < 0 || tx + tile.fullW > this.W || ty + tile.fullH > this.H;
  }

  /** Area-weighted centre of mass of placed tiles (apt.js cluster bias). */
  private centreOfMass(): { x: number; y: number } {
    const cx = this.W / 2;
    const cy = this.H / 2;
    let nx = 0;
    let ny = 0;
    let den = 0;
    for (const p of this.placed) {
      if (p.x <= OFFSCREEN + 1) continue;
      const a = p.fullW * p.fullH;
      nx += (p.x + p.fullW / 2) * a;
      ny += (p.y + p.fullH / 2) * a;
      den += a;
    }
    if (den === 0) return { x: cx, y: cy };
    return { x: nx / den, y: ny / den };
  }

  /**
   * Place ONE tile against the current grid. Mutates tile.x / tile.y and
   * stamps the grid. Returns true if a real position was found.
   *
   * Spiral logic is the original apt.js maskPack inner loop, lifted to operate
   * on the persistent grid so live birds nest onto the existing cluster.
   */
  placeOne(tile: Tile, xBias: number, yBias: number, anchorFirst = true): boolean {
    const cx = this.W / 2;
    const cy = this.H / 2;

    // First bird anchors the cluster at viewport centre — UNLESS we're packing a
    // secondary layer (ambient) onto a grid already blocked out with the real
    // cluster, in which case even the first tile must spiral to a free cell.
    if (anchorFirst && this.placed.length === 0) {
      tile.x = cx - tile.fullW / 2;
      tile.y = cy - tile.fullH / 2;
      this.stamp(tile, tile.x, tile.y);
      this.placed.push(tile);
      return true;
    }

    const com = this.centreOfMass();
    const step = Math.max(this.stride, Math.min(tile.fullW, tile.fullH) * 0.05);
    const maxR = Math.max(this.W, this.H);
    const phase = this.rand() * Math.PI * 2;

    // Pass 1: respect the viewport. Pass 2: allow off-screen overflow so a
    // bird is NEVER dropped even on a full canvas (contract: long tail kept).
    for (let pass = 0; pass < 2; pass++) {
      const allowOff = pass === 1;
      let best: { x: number; y: number } | null = null;
      let bestCost = Infinity;
      let foundRing = -1;

      for (let r = 0; r <= maxR; r += step) {
        if (foundRing >= 0 && r > foundRing + step * 2) break;
        const samples = Math.max(36, Math.floor(r / 1.6));
        for (let k = 0; k < samples; k++) {
          const theta = phase + (k / samples) * Math.PI * 2;
          const px = cx + r * xBias * Math.cos(theta) - tile.fullW / 2;
          const py = cy + r * yBias * Math.sin(theta) - tile.fullH / 2;
          if (!allowOff && this.offGrid(tile, px, py)) continue;
          if (this.collides(tile, px, py)) continue;
          const dxx = px + tile.fullW / 2 - com.x;
          const dyy = py + tile.fullH / 2 - com.y;
          const cost = Math.hypot(dxx / xBias, dyy / yBias) + this.rand() * step * 0.5;
          if (cost < bestCost) {
            bestCost = cost;
            best = { x: px, y: py };
          }
        }
        if (best && foundRing < 0) foundRing = r;
      }

      if (best) {
        tile.x = best.x;
        tile.y = best.y;
        this.stamp(tile, best.x, best.y);
        this.placed.push(tile);
        return true;
      }
    }

    // Truly nowhere (should not happen): park off-screen rather than overlap.
    tile.x = OFFSCREEN;
    tile.y = OFFSCREEN;
    this.placed.push(tile);
    return false;
  }

  /**
   * Seed pack: place a batch largest-first so the cluster grows around the
   * biggest anchor (apt.js sort). Used for the initial snapshot only.
   */
  seed(tiles: Tile[], xBias: number, yBias: number): void {
    tiles.sort((a, b) => b.fullW * b.fullH - a.fullW * a.fullH);
    for (const t of tiles) this.placeOne(t, xBias, yBias);
  }

  /** Tiles actually on screen (for bounds / centring). */
  onScreen(): Tile[] {
    return this.placed.filter((t) => t.x > OFFSCREEN + 1);
  }

  /** Stamp these tiles' footprints into the occupancy grid as blockers WITHOUT
   *  adding them to `placed`. Lets the ambient backdrop pack AROUND the real
   *  cluster: the ambient grid reserves every real bird's cells first, so no
   *  ghost can land on a counted bird. Blockers don't render or feed the
   *  centre-of-mass — they only occupy space. Off-screen tiles are skipped. */
  blockOut(tiles: Tile[]): void {
    for (const t of tiles) {
      if (t.x <= OFFSCREEN + 1) continue;
      this.stamp(t, t.x, t.y);
    }
  }

  /**
   * Clear the occupancy cells and re-stamp every placed tile at its CURRENT
   * x/y. Used after the cluster is translated (re-centred) so the grid stays
   * in sync with the rendered positions — without re-spiralling anything.
   */
  restamp(): void {
    this.grid.fill(0);
    for (const t of this.placed) {
      if (t.x <= OFFSCREEN + 1) continue;
      this.stamp(t, t.x, t.y);
    }
  }
}
