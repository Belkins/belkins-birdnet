// Canvas2D collage renderer (Phase 0). Canvas2D is the LOCKED primary path;
// the WebGL ink-shader painter is Phase 1 and is deliberately NOT built here.
//
// Each settled bird draws at full alpha. A freshly-added bird "paints in":
// fade 0->1 + scale 0.85->1 + a cheap top-down reveal wipe over ~1.2s. With
// prefers-reduced-motion the bird appears instantly (no motion).
//
// Theme (night/day) adds a per-bird Canvas shadow — a warm spotlight glow on
// the dark Obsidian ground, a soft contact shadow on the cream Day ground —
// plus a light atmospheric depth cue (smaller/farther birds recede).

import type { Tile } from './types';
import { birdInk, type Theme } from './theme';
import { PROFILE } from './profile';

const PAINT_MS = 1200;
const SCALE_FROM = 0.85;
const TAU = Math.PI * 2;

// Idle ambient-life motion (spec §7.2). Every amplitude/duration lives here so
// reduced-motion and e-ink zero the piece deterministically to its phase-0 home.
// This is ADDITIVE to the reveal above (PAINT_MS/SCALE_FROM stay the reveal's).
const MOTION = {
  /** whole-cluster breath: ±0.3% scale about the composition centroid, one sine. */
  breathAmp: 0.003,
  breathPeriodMs: 14_000,
  /** per-bird seeded drift: sub-pixel Lissajous, ≤1.5px, decorrelated 18–42s. */
  driftAmpPx: 1.5,
  driftPeriodMinMs: 18_000,
  driftPeriodSpanMs: 24_000, // 18s..42s
  /** budget: ~10fps accumulator — ambient life is felt, not watched. */
  frameMs: 100,
} as const;

/** Shared zero offset so the motion-off path never allocates. */
const ZERO_DRIFT = { dx: 0, dy: 0 };

/** Per-bird drift seed, derived once from the slug and cached (see `drift()`). */
interface DriftSeed {
  perX: number;
  perY: number;
  phX: number;
  phY: number;
}

function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

/** Stable 32-bit FNV-1a hash of a slug → a deterministic per-bird seed. */
function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 PRNG — a deterministic [0,1) stream from a 32-bit seed. */
function mulberry32(a: number): () => number {
  let t = a >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export class CollageRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private tiles: Tile[] = [];
  private theme: Theme = 'night';
  private W = 0;
  private H = 0;
  private dpr = 1;
  private rafId = 0;
  private scheduled = false;
  private dead = false;
  /** idle ambient-life loop: whether motion is switched on (setMotion). */
  private motionOn = false;
  /** rAF handle for the low-rate (~10fps) ambient loop, 0 when parked. */
  private motionRafId = 0;
  /** last ambient-tick timestamp, for the 100ms accumulator. */
  private motionLast = 0;
  /** per-slug drift seeds, computed lazily and reused across frames. */
  private readonly drifts = new Map<string, DriftSeed>();
  /** per-slug silhouette Path2D (mask-space), built once and reused. */
  private readonly silhouettes = new Map<string, Path2D>();
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
    // Ambient loop runs at 0fps while the tab is hidden (spec §7.2 budget).
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  /** Pause the ambient loop when hidden; resume it when the tab returns. */
  private readonly onVisibility = (): void => {
    if (document.visibilityState === 'visible') {
      if (this.motionActive()) this.startMotion();
    } else {
      this.stopMotion();
    }
  };

  setTiles(tiles: Tile[]): void {
    this.tiles = tiles;
  }

  /** Swap the bird glow/shadow treatment and repaint immediately. */
  setTheme(theme: Theme): void {
    if (theme === this.theme) return;
    this.theme = theme;
    this.requestDraw();
  }

  /** Toggle idle ambient life (breath + per-bird drift). `false`, reduced-motion
   *  or an e-ink surface all collapse to amplitude 0 — the composition snaps to
   *  its phase-0 home and every printed still stays composed (spec §7.4). */
  setMotion(on: boolean): void {
    if (on === this.motionOn) return;
    this.motionOn = on;
    if (this.motionActive()) this.startMotion();
    else this.stopMotion();
    // Repaint once so amplitudes either begin or snap home this frame.
    this.requestDraw();
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
    const ink = birdInk(this.theme);
    const night = this.theme === 'night';
    const motion = this.motionActive();
    const driftAmp = motion ? MOTION.driftAmpPx : 0;
    // Ambient backdrop tiles paint at a reduced, theme-aware alpha (spec §6.5).
    const AMBIENT_ALPHA = night ? 0.22 : 0.18;
    let animating = false;

    // Largest on-screen footprint (real tiles only) for the atmospheric-depth
    // cue, plus the composition centroid the whole-cluster breath scales about.
    let maxW = 1;
    let sumX = 0;
    let sumY = 0;
    let nReal = 0;
    for (const t of this.tiles) {
      if (t.ambient || t.x <= -99998) continue;
      if (t.fullW > maxW) maxW = t.fullW;
      sumX += t.x + t.fullW / 2;
      sumY += t.y + t.fullH / 2;
      nReal++;
    }
    const cx = nReal > 0 ? sumX / nReal : W / 2;
    const cy = nReal > 0 ? sumY / nReal : H / 2;

    // Whole-cluster breath: ±0.3% about the centroid, applied as a canvas
    // transform so ambient + real tiles inhale together (0 amplitude => none).
    if (motion) {
      const breath = 1 + MOTION.breathAmp * Math.sin((TAU * now) / MOTION.breathPeriodMs);
      ctx.translate(cx, cy);
      ctx.scale(breath, breath);
      ctx.translate(-cx, -cy);
    }

    // Ambient layer first, behind the real birds: no reveal, reduced alpha.
    for (const t of this.tiles) {
      if (!t.ambient || t.x <= -99998) continue;
      const depth = Math.max(0, Math.min(1, 1 - t.fullW / maxW));
      const dr = this.drift(t.slug, depth, now, driftAmp);
      const dx = t.x + dr.dx;
      const dy = t.y + dr.dy;
      ctx.save();
      ctx.globalAlpha = AMBIENT_ALPHA;
      if (t.loaded && t.img && !t.failed) {
        ctx.shadowColor = ink.shadowColor;
        ctx.shadowBlur = night ? ink.shadowBlur * (1 - 0.5 * depth) : ink.shadowBlur;
        ctx.shadowOffsetY = ink.shadowOffsetY;
        ctx.drawImage(t.img, dx, dy, t.fullW, t.fullH);
      } else {
        this.drawSilhouette(t, dx, dy, t.fullW, t.fullH);
      }
      ctx.restore();
    }

    for (const t of this.tiles) {
      if (t.ambient || t.x <= -99998) continue; // ambient handled above / parked off-screen

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

      // depth: 0 = nearest/biggest, 1 = farthest/smallest.
      const depth = Math.max(0, Math.min(1, 1 - t.fullW / maxW));
      const alpha = progress * (1 - 0.2 * depth);
      const scale = SCALE_FROM + (1 - SCALE_FROM) * progress;
      const drawW = t.fullW * scale;
      const drawH = t.fullH * scale;
      const dr = this.drift(t.slug, depth, now, driftAmp);
      const dx = t.x + (t.fullW - drawW) / 2 + dr.dx;
      const dy = t.y + (t.fullH - drawH) / 2 + dr.dy;

      ctx.save();
      ctx.globalAlpha = alpha;
      // Top-down reveal wipe: clip to the portion painted so far.
      if (progress < 1) {
        ctx.beginPath();
        ctx.rect(dx, dy, drawW, drawH * progress);
        ctx.clip();
      }

      if (t.loaded && t.img && !t.failed) {
        ctx.shadowColor = ink.shadowColor;
        ctx.shadowBlur = night ? ink.shadowBlur * (1 - 0.5 * depth) : ink.shadowBlur;
        ctx.shadowOffsetY = ink.shadowOffsetY;
        ctx.drawImage(t.img, dx, dy, drawW, drawH);
      } else {
        this.drawSilhouette(t, dx, dy, drawW, drawH);
      }
      ctx.restore();
    }

    if (animating) this.requestDraw();
  }

  /** A tasteful ink SILHOUETTE for a bird with no cutout yet (pending Railway
   *  gen) or no illustration at all — never a labeled grey card. Real mask →
   *  the bird's own shape; default-bbox species → a generic perched-bird glyph.
   *  Theme-aware ink so it reads on both grounds. */
  private drawSilhouette(t: Tile, x: number, y: number, w: number, h: number): void {
    const { ctx } = this;
    const night = this.theme === 'night';
    ctx.fillStyle = night ? 'rgba(241,234,217,0.32)' : 'rgba(26,22,18,0.28)';
    const path = this.silhouettePath(t);
    ctx.save();
    ctx.translate(x, y);
    if (t.mask.isDefault) ctx.scale(w / 100, h / 72);        // glyph authoring box
    else ctx.scale(w / t.mask.w, h / t.mask.h);              // real mask space
    ctx.fill(path);
    ctx.restore();
  }

  private silhouettePath(t: Tile): Path2D {
    const cached = this.silhouettes.get(t.slug);
    if (cached) return cached;
    let p: Path2D;
    if (t.mask.isDefault) {
      p = genericBirdPath();
    } else {
      p = new Path2D();
      for (const c of t.mask.cells) p.rect(c[0], c[1], 1.02, 1.02); // union of mask cells
    }
    this.silhouettes.set(t.slug, p);
    return p;
  }

  /** Motion runs only when explicitly on, motion-safe, and not an e-ink print. */
  private motionActive(): boolean {
    return this.motionOn && !this.reducedMotion && PROFILE.surface !== 'eink';
  }

  /** Drive the ambient composition at ~10fps (100ms accumulator) via rAF, which
   *  also naturally quiesces to 0fps while the tab is hidden. */
  private startMotion(): void {
    if (this.dead || this.motionRafId) return;
    this.motionLast = 0;
    const tick = (ts: number): void => {
      if (this.dead || !this.motionActive()) {
        this.motionRafId = 0;
        return;
      }
      if (ts - this.motionLast >= MOTION.frameMs) {
        this.motionLast = ts;
        this.requestDraw();
      }
      this.motionRafId = requestAnimationFrame(tick);
    };
    this.motionRafId = requestAnimationFrame(tick);
  }

  private stopMotion(): void {
    if (this.motionRafId) cancelAnimationFrame(this.motionRafId);
    this.motionRafId = 0;
  }

  /** Seeded sub-pixel drift for a tile at time `now`; ZERO_DRIFT when amp<=0 so
   *  the motion-off / reduced-motion / e-ink paths snap to home with no cost.
   *  Nearer (lower-depth) birds drift a touch more → a real parallax. */
  private drift(slug: string, depth: number, now: number, amp: number): { dx: number; dy: number } {
    if (amp <= 0) return ZERO_DRIFT;
    let d = this.drifts.get(slug);
    if (!d) {
      const rnd = mulberry32(hashSeed(slug));
      d = {
        perX: MOTION.driftPeriodMinMs + rnd() * MOTION.driftPeriodSpanMs,
        perY: MOTION.driftPeriodMinMs + rnd() * MOTION.driftPeriodSpanMs,
        phX: rnd() * TAU,
        phY: rnd() * TAU,
      };
      this.drifts.set(slug, d);
    }
    const a = amp * (1 - 0.35 * depth);
    return {
      dx: a * Math.sin((TAU * now) / d.perX + d.phX),
      dy: a * Math.sin((TAU * now) / d.perY + d.phY),
    };
  }

  destroy(): void {
    this.dead = true;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.stopMotion();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.scheduled = false;
  }
}

/** A generic perched-bird silhouette in a 100x72 authoring box — used when a
 *  species has no baked mask, so an un-illustrated bird still reads as a bird,
 *  never a box. */
function genericBirdPath(): Path2D {
  const p = new Path2D();
  p.ellipse(52, 44, 30, 19, -0.18, 0, TAU);   // body
  p.ellipse(26, 30, 12, 12, 0, 0, TAU);        // head
  p.moveTo(15, 27); p.lineTo(2, 31); p.lineTo(16, 34); p.closePath();  // beak
  p.moveTo(78, 42); p.lineTo(99, 31); p.lineTo(82, 52); p.closePath(); // tail
  return p;
}
