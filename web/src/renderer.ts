// Canvas2D collage renderer (Phase 0). Canvas2D is the LOCKED primary path;
// the WebGL ink-shader painter is Phase 1 and is deliberately NOT built here.
//
// Each settled bird draws at full alpha. A freshly-added bird "paints in":
// fade 0->1 + scale 0.85->1 + a cheap top-down reveal wipe over ~1.2s. With
// prefers-reduced-motion the bird appears instantly (no motion).
//
// Theme (night/day) adds ONE unified per-bird "seat" ink (seatInk) — a faint
// luminous edge-light that lifts dark specimens off the Obsidian ground at
// night, and a soft ink-wash contact shadow that grounds each bird by day.
// Consistent radius/opacity across birds (no uneven "Photoshop drop-glow"), so
// every specimen sits INTO the painting instead of floating like a sticker.

import type { Tile } from './types';
import type { Theme } from './theme';
import { PROFILE } from './profile';
import {
  TAU,
  GLYPH_W,
  GLYPH_H,
  clamp,
  easeOutCubic,
  hashSeed,
  mulberry32,
  tileRotation,
  paintSpecimen,
  paintVignette,
  genericGlyph,
} from './plate';

const PAINT_MS = 1200;
const SCALE_FROM = 0.85;

/** Legibility floor (px, longest drawn edge) for an INK SILHOUETTE / pending
 *  placeholder. Below this a bird outline reads as a dust speck / glitch, so we
 *  DROP it from the paint entirely rather than floor it up into a boxy fleck
 *  (judges' "reads as dust"). Anything that survives renders at its true box as
 *  a legible, deliberate outline. Illustrated tiles are count-sized above this. */
const MIN_SIL_PX = 44;
/** Hard speck guard for a LOADED illustration: an image below this many px on its
 *  longest edge is a stray fleck and is skipped too. Count-sizing keeps real
 *  birds far above this — it only catches pathological shrink at very high N. */
const SPECK_PX = 14;

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
  /** Golden Hour warmth folded into seat ink + vignette (setSolar); 0 = untinted. */
  private solarWarmth = 0;
  /** true inside the sunrise/sunset band — the ground pool glows a touch more. */
  private solarGolden = false;
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

  /** Golden-hour warmth folded into seat ink + vignette. 0 = the untinted
   *  theme (degrade to silence). */
  setSolar(warmth: number, golden: boolean): void {
    const w = clamp(warmth, 0, 1);
    if (Math.abs(w - this.solarWarmth) < 0.01 && golden === this.solarGolden) return;
    this.solarWarmth = w;
    this.solarGolden = golden;
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
    const night = this.theme === 'night';
    const motion = this.motionActive();
    const driftAmp = motion ? MOTION.driftAmpPx : 0;
    // A pending tile pulses only where motion is honest (not e-ink / reduced-
    // motion); elsewhere it draws one steady shimmer frame.
    const canPulse = !this.reducedMotion && PROFILE.surface !== 'eink';
    // Ambient backdrop tiles paint at a reduced, theme-aware alpha (spec §6.5).
    const AMBIENT_ALPHA = night ? 0.22 : 0.18;
    let animating = false;
    let pending = false;

    // Largest on-screen SPAN (longest edge, real tiles only) for the atmospheric-
    // depth cue + the hero test, the composition centroid the breath scales about,
    // and the cluster bounds the seating vignette is sized to.
    let maxEdge = 1;
    let sumX = 0;
    let sumY = 0;
    let nReal = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const t of this.tiles) {
      if (t.ambient || t.x <= -99998) continue;
      const e = Math.max(t.fullW, t.fullH);
      if (e > maxEdge) maxEdge = e;
      sumX += t.x + t.fullW / 2;
      sumY += t.y + t.fullH / 2;
      nReal++;
      if (t.x < minX) minX = t.x;
      if (t.y < minY) minY = t.y;
      if (t.x + t.fullW > maxX) maxX = t.x + t.fullW;
      if (t.y + t.fullH > maxY) maxY = t.y + t.fullH;
    }
    const cx = nReal > 0 ? sumX / nReal : W / 2;
    const cy = nReal > 0 ? sumY / nReal : H / 2;

    // Faint radial seating vignette BEHIND the whole cluster (screen space, under
    // the breath transform) so the composition sits on the ground instead of
    // floating. Sized to the cluster's own extent; skipped when there are no real
    // birds (a bare ambient backdrop needs no seat). (Judges: "add a faint radial
    // vignette behind the cluster to seat it.")
    if (nReal > 0) {
      const radius = 0.5 * Math.hypot(maxX - minX, maxY - minY) * 0.95;
      this.paintVignette(cx, cy, radius, night, this.solarWarmth, this.solarGolden);
    }

    // Whole-cluster breath: ±0.3% about the centroid, applied as a canvas
    // transform so ambient + real tiles inhale together (0 amplitude => none).
    if (motion) {
      const breath = 1 + MOTION.breathAmp * Math.sin((TAU * now) / MOTION.breathPeriodMs);
      ctx.translate(cx, cy);
      ctx.scale(breath, breath);
      ctx.translate(-cx, -cy);
    }

    // Ambient layer first, behind the real birds: no reveal, reduced alpha, a
    // gentler tilt. Its own pending tiles shimmer once (never drive the loop).
    for (const t of this.tiles) {
      if (!t.ambient || t.x <= -99998) continue;
      const isImage = t.loaded && !!t.img && !t.failed;
      const span = Math.max(t.fullW, t.fullH);
      // Never paint a speck: drop a sub-legible ghost silhouette entirely.
      if (isImage ? span < SPECK_PX : span < MIN_SIL_PX) continue;
      const depth = Math.max(0, Math.min(1, 1 - span / maxEdge));
      const dr = this.drift(t.slug, depth, now, driftAmp);
      const dx = t.x + dr.dx;
      const dy = t.y + dr.dy;
      ctx.save();
      ctx.globalAlpha = AMBIENT_ALPHA;
      this.rotateAbout(dx + t.fullW / 2, dy + t.fullH / 2, tileRotation(t.slug) * 0.8);
      this.paintTile(t, dx, dy, t.fullW, t.fullH, night, true, now, canPulse);
      ctx.restore();
    }

    for (const t of this.tiles) {
      if (t.ambient || t.x <= -99998) continue; // ambient handled above / parked off-screen

      const isImage = t.loaded && !!t.img && !t.failed;
      const span = Math.max(t.fullW, t.fullH);
      // Never paint a speck: drop a sub-legible silhouette / pending placeholder
      // entirely (judges' "reads as dust"); a loaded illustration only vanishes if
      // it is truly micro. Decided on the SETTLED box so paint-in never flickers it.
      if (isImage ? span < SPECK_PX : span < MIN_SIL_PX) continue;

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

      // depth: 0 = nearest/biggest, 1 = farthest/smallest. Gentle alpha recede
      // (dark specimens stay present; the seat edge-light does the lifting).
      const depth = Math.max(0, Math.min(1, 1 - span / maxEdge));
      const alpha = progress * (1 - 0.12 * depth);
      const scale = SCALE_FROM + (1 - SCALE_FROM) * progress;
      const drawW = t.fullW * scale;
      const drawH = t.fullH * scale;
      const dr = this.drift(t.slug, depth, now, driftAmp);
      const dx = t.x + (t.fullW - drawW) / 2 + dr.dx;
      const dy = t.y + (t.fullH - drawH) / 2 + dr.dy;

      ctx.save();
      ctx.globalAlpha = alpha;
      // Subtle seeded tilt — never the hero (largest reads as the upright anchor).
      const isHero = span >= maxEdge * 0.985;
      this.rotateAbout(dx + drawW / 2, dy + drawH / 2, isHero ? 0 : tileRotation(t.slug));
      // Top-down reveal wipe: clip to the portion painted so far.
      if (progress < 1) {
        ctx.beginPath();
        ctx.rect(dx, dy, drawW, drawH * progress);
        ctx.clip();
      }

      this.paintTile(t, dx, dy, drawW, drawH, night, false, now, canPulse);
      ctx.restore();

      // A loading tile (has a URL, not yet decoded, not failed) keeps the loop
      // alive so its shimmer breathes until the cutout paints in.
      if (!t.loaded && !t.failed && canPulse) pending = true;
    }

    if (animating || pending) this.requestDraw();
  }

  /** Rotate the context about a point (no-op at 0). Caller has already saved. */
  private rotateAbout(px: number, py: number, rot: number): void {
    if (!rot) return;
    const { ctx } = this;
    ctx.translate(px, py);
    ctx.rotate(rot);
    ctx.translate(-px, -py);
  }

  /** Paint one tile in its current state, with the caller's alpha/clip/rotation
   *  already applied:
   *   - decoded illustration → drawImage under the UNIFIED seat ink;
   *   - loading (has URL, not decoded, not failed) → soft pulsing shimmer;
   *   - failed / no illustration → the species silhouette.
   *  `ambient` softens the seat ink for the recessed backdrop layer. */
  private paintTile(
    t: Tile,
    x: number,
    y: number,
    w: number,
    h: number,
    night: boolean,
    ambient: boolean,
    now: number,
    canPulse: boolean,
  ): void {
    const { ctx } = this;
    if (t.loaded && t.img && !t.failed) {
      // CONTAIN-fit + unified seat ink live in the shared plate engine (plate.ts)
      // so the wall and a share card seat a bird identically. Auto-gen species
      // missing from dims.json get the DEFAULT_ASPECT box; contain-fit keeps the
      // art undistorted and its opaque pixels off the box edge (where the painted
      // tilt would swing them into a neighbour). Bundled boxes were measured from
      // these very images, so they pass the tolerance and render exactly as before.
      paintSpecimen(
        ctx,
        t.img,
        t.img.naturalWidth,
        t.img.naturalHeight,
        x,
        y,
        w,
        h,
        night,
        this.solarWarmth,
        ambient,
      );
      return;
    }
    if (!t.loaded && !t.failed) {
      this.drawPending(t, x, y, w, h, night, now, canPulse);
      return;
    }
    this.drawSilhouette(t, x, y, w, h);
  }

  /** A tasteful SPECIES-SPECIFIC ink silhouette for a bird with a failed cutout
   *  or no illustration at all — never a labeled grey card, never a letter, never
   *  two identical shapes. Real mask → the bird's OWN outline; a species lacking a
   *  baked mask → one of several distinct perched-bird glyphs (seeded + optionally
   *  mirrored by slug, so adjacent default-mask birds never twin). Warm ink at
   *  ~15% with a soft feathered edge — soft ink-wash fill; sub-legible tiles are
   *  dropped upstream (MIN_SIL_PX) so this only ever draws a deliberate outline. */
  private drawSilhouette(t: Tile, x: number, y: number, w: number, h: number): void {
    const { ctx } = this;
    const night = this.theme === 'night';
    const p = this.scaledSilhouette(t, x, y, w, h);
    ctx.save();
    ctx.fillStyle = night ? 'rgba(238,228,205,0.15)' : 'rgba(34,26,16,0.15)';
    ctx.shadowColor = night ? 'rgba(238,228,205,0.10)' : 'rgba(34,26,16,0.10)';
    ctx.shadowBlur = 3; // real px (path is pre-scaled) → a soft, non-boxy edge
    ctx.fill(p);
    ctx.restore();
  }

  /** A "still generating" placeholder in the bird's footprint: the species
   *  silhouette, gently breathing (alpha + halo) so a pending Railway cutout
   *  clearly reads as LOADING rather than as a static failed silhouette. On
   *  e-ink / reduced-motion it draws one steady low-alpha frame (no pulse). */
  private drawPending(
    t: Tile,
    x: number,
    y: number,
    w: number,
    h: number,
    night: boolean,
    now: number,
    canPulse: boolean,
  ): void {
    const { ctx } = this;
    const p = this.scaledSilhouette(t, x, y, w, h);
    const wave = canPulse ? 0.5 + 0.5 * Math.sin((TAU * now) / 1500) : 0.5;
    const a = 0.07 + 0.1 * wave; // 0.07 .. 0.17 breathing body
    ctx.save();
    ctx.fillStyle = night ? `rgba(245,236,214,${a})` : `rgba(40,30,18,${a})`;
    ctx.shadowColor = night ? `rgba(255,214,150,${0.05 + 0.1 * wave})` : `rgba(40,30,18,${0.05 + 0.06 * wave})`;
    ctx.shadowBlur = 6 + 6 * wave; // a soft, pulsing "generating" halo
    ctx.fill(p);
    ctx.restore();
  }

  /** The tile's silhouette Path2D pre-transformed to the on-screen box. Sub-
   *  legible tiles are DROPPED upstream (MIN_SIL_PX) rather than floored up, so
   *  every silhouette that reaches here draws at its true box as a deliberate
   *  outline. Pre-scaling (vs. ctx.scale) keeps shadow/blur in real pixels for a
   *  predictable soft edge. */
  private scaledSilhouette(t: Tile, x: number, y: number, w: number, h: number): Path2D {
    const base = this.silhouettePath(t);
    const sw = t.mask.isDefault ? GLYPH_W : t.mask.w;
    const sh = t.mask.isDefault ? GLYPH_H : t.mask.h;
    const m = new DOMMatrix().translateSelf(x, y).scaleSelf(w / sw, h / sh);
    const out = new Path2D();
    out.addPath(base, m);
    return out;
  }

  /** Faint radial glow behind the cluster centroid that seats the composition on
   *  the ground (spec: seating vignette). Night lifts the cluster off obsidian
   *  with a warm off-white pool; day drops a soft desaturated ink pool. Very low
   *  opacity — felt, not seen — and drawn once behind everything. Golden Hour
   *  `warmth` mixes the pool toward amber (0 reproduces the untinted theme);
   *  inside the sunrise/sunset band the ground pool glows a touch more. */
  private paintVignette(
    cx: number,
    cy: number,
    radius: number,
    night: boolean,
    warmth = 0,
    golden = false,
  ): void {
    paintVignette(this.ctx, this.W, this.H, cx, cy, radius, night, warmth, golden);
  }

  /** Per-slug silhouette in AUTHORING/MASK space, built once and cached. Real
   *  mask → the union of its opaque cells (the bird's own outline). Default-bbox
   *  species → a distinct perched-bird glyph chosen (and optionally mirrored) by
   *  the slug hash, so no two default-mask birds share a shape. */
  private silhouettePath(t: Tile): Path2D {
    const cached = this.silhouettes.get(t.slug);
    if (cached) return cached;
    let p: Path2D;
    if (t.mask.isDefault) {
      // Seeded pick + optional mirror lives in the shared plate engine so a
      // fallback silhouette is identical on the wall and on a card.
      p = genericGlyph(t.slug);
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

// The generic fallback glyphs, the seat ink, the vignette, and every shared
// paint helper now live in ./plate — a single source of truth so a share card
// and the recap sheet seat a bird identically to the wall.
