// Canvas2D collage renderer (Phase 0). Canvas2D is the LOCKED primary path;
// the WebGL ink-shader painter is Phase 1 and is deliberately NOT built here.
//
// Each settled bird draws at full alpha. A freshly-added bird "paints in":
// fade 0->1 + scale 0.85->1 + a cheap top-down reveal wipe over ~1.2s. With
// prefers-reduced-motion the bird appears instantly (no motion).

import type { Tile } from './types';

const PAINT_MS = 1200;
const SCALE_FROM = 0.85;

function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

export class CollageRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private tiles: Tile[] = [];
  private W = 0;
  private H = 0;
  private dpr = 1;
  private rafId = 0;
  private scheduled = false;
  private dead = false;
  /** instant reveals when the user prefers reduced motion. */
  readonly reducedMotion: boolean;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas2D not supported');
    this.ctx = ctx;
    this.reducedMotion =
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  setTiles(tiles: Tile[]): void {
    this.tiles = tiles;
  }

  resize(W: number, H: number): void {
    this.W = W;
    this.H = H;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(W * this.dpr);
    this.canvas.height = Math.round(H * this.dpr);
    this.canvas.style.width = `${W}px`;
    this.canvas.style.height = `${H}px`;
    this.requestDraw();
  }

  /** Schedule a single redraw on the next frame (coalesces bursts). */
  requestDraw(): void {
    if (this.dead || this.scheduled) return;
    this.scheduled = true;
    this.rafId = requestAnimationFrame(() => {
      this.scheduled = false;
      this.draw();
    });
  }

  private draw(): void {
    const { ctx, W, H, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const now = performance.now();
    let animating = false;

    for (const t of this.tiles) {
      if (t.x <= -99998) continue; // parked off-screen

      let progress = 1;
      if (t.animStart !== null) {
        const raw = (now - t.animStart) / PAINT_MS;
        if (raw >= 1) {
          t.animStart = null; // settle
        } else {
          progress = easeOutCubic(Math.max(0, raw));
          animating = true;
        }
      }

      const alpha = progress;
      const scale = SCALE_FROM + (1 - SCALE_FROM) * progress;
      const drawW = t.fullW * scale;
      const drawH = t.fullH * scale;
      const dx = t.x + (t.fullW - drawW) / 2;
      const dy = t.y + (t.fullH - drawH) / 2;

      ctx.save();
      ctx.globalAlpha = alpha;
      // Top-down reveal wipe: clip to the portion painted so far.
      if (progress < 1) {
        ctx.beginPath();
        ctx.rect(dx, dy, drawW, drawH * progress);
        ctx.clip();
      }

      if (t.loaded && t.img && !t.failed) {
        ctx.drawImage(t.img, dx, dy, drawW, drawH);
      } else {
        this.drawPlaceholder(t, dx, dy, drawW, drawH);
      }
      ctx.restore();
    }

    if (animating) this.requestDraw();
  }

  /** Muted card + label so a missing image (or default-mask species) is
   *  still visible — never an invisible gap. */
  private drawPlaceholder(t: Tile, x: number, y: number, w: number, h: number): void {
    const { ctx } = this;
    ctx.fillStyle = t.loaded ? 'rgba(120,140,130,0.18)' : 'rgba(120,140,130,0.10)';
    const r = Math.min(10, w * 0.12, h * 0.12);
    roundRect(ctx, x, y, w, h, r);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,140,130,0.35)';
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, w, h, r);
    ctx.stroke();
    const label = t.com || t.sci;
    ctx.fillStyle = 'rgba(40,55,48,0.75)';
    ctx.font = `${Math.max(9, Math.min(14, w * 0.12))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(truncate(label, w), x + w / 2, y + h / 2, w * 0.9);
  }

  destroy(): void {
    this.dead = true;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.scheduled = false;
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function truncate(s: string, w: number): string {
  const max = Math.max(3, Math.floor(w / 7));
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
