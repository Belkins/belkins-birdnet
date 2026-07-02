// The shared kachō-e PLATE engine — one paint source for every surface.
//
// Extracted from renderer.ts (the live collage) so the SAME seat-ink, vignette,
// contain-fit specimen draw, and silhouette glyphs render a bird identically on
// the wall, on a share card, and on the weekly recap sheet. The rule the whole
// project turns on: build the plate ONCE, so a card can never drift from the
// frame (five earlier proposals each wanted their own renderer — this is the one).
//
// This module is deliberately PURE + surface-agnostic: it draws through a
// CanvasRenderingContext2D and never touches the DOM, rAF, matchMedia, or the
// window. renderer.ts keeps every DOM/motion/scheduling concern; it now imports
// the paint math from here so there is a single source of truth. The browser
// export engine (export-card.ts) drives an OffscreenCanvas through the same
// functions; a future Railway node-canvas job can drive them too (the 2D API is
// the only contract).

/** 2π, hoisted once (renderer + glyphs share it). */
export const TAU = Math.PI * 2;

/** Authoring box for the generic fallback glyphs (width × height). */
export const GLYPH_W = 100;
export const GLYPH_H = 72;

/** Max static composition rotation (rad ≈ 2.6°) — a subtle seeded per-bird tilt
 *  so a cluster reads as a composed rosette, not a shelf of upright stickers. */
export const MAX_ROT = 0.045;

export function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

/** Stable 32-bit FNV-1a hash of a slug → a deterministic per-bird seed. */
export function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 PRNG — a deterministic [0,1) stream from a 32-bit seed. */
export function mulberry32(a: number): () => number {
  let t = a >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Clamp `v` into [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Linear mix of two rgba tuples → a CSS color. At t=0 this reproduces `a`
 *  exactly (the untinted theme), so Golden Hour off is pixel-identical. */
export function mixRgba(
  a: [number, number, number, number],
  b: [number, number, number, number],
  t: number,
): string {
  const c = (i: 0 | 1 | 2) => Math.round(a[i] + (b[i] - a[i]) * t);
  return `rgba(${c(0)}, ${c(1)}, ${c(2)}, ${(a[3] + (b[3] - a[3]) * t).toFixed(3)})`;
}

/** Deterministic per-slug composition tilt in [-MAX_ROT, MAX_ROT]. */
export function tileRotation(slug: string): number {
  const r = (hashSeed(slug) & 0xffff) / 0xffff; // 0..1
  return (r * 2 - 1) * MAX_ROT;
}

/** One UNIFIED per-bird "seat" ink, sized so the treatment is visually
 *  consistent across birds (radius scales with the bird → the rim reads the same
 *  thickness on a hero and on a small tile). Night: a faint luminous off-white
 *  edge-light that lifts even a jackdaw/swift off pure obsidian and seats it.
 *  Day: a soft desaturated ink-wash contact shadow, offset down to ground the
 *  bird. Golden Hour `warmth` mixes the ink toward amber (0 = today's exact
 *  colors); blur/offset stay untouched — a lighting tint, never a new treatment. */
export function seatInk(
  size: number,
  night: boolean,
  warmth = 0,
): { color: string; blur: number; offsetY: number } {
  if (night) {
    return {
      color: mixRgba([245, 234, 210, 0.18], [255, 199, 130, 0.21], warmth),
      blur: clamp(size * 0.09, 12, 30),
      offsetY: clamp(size * 0.02, 1, 8),
    };
  }
  return {
    color: mixRgba([38, 28, 16, 0.2], [64, 40, 14, 0.22], warmth),
    blur: clamp(size * 0.07, 8, 22),
    offsetY: clamp(size * 0.05, 3, 16),
  };
}

/** Paint one decoded specimen image INTO a box under the unified seat ink, with
 *  CONTAIN-fit when the image's aspect disagrees with the box (auto-gen species
 *  whose box came from DEFAULT_ASPECT). Extracted verbatim from renderer.paintTile
 *  so the wall and a share card seat a bird identically. The caller owns alpha /
 *  clip / rotation; this owns only the shadow + the fitted draw, and resets the
 *  shadow so the halo never bleeds onto a subsequent primitive. `ambient` softens
 *  the seat ink for the recessed backdrop layer. */
export function paintSpecimen(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  natW: number,
  natH: number,
  x: number,
  y: number,
  w: number,
  h: number,
  night: boolean,
  warmth = 0,
  ambient = false,
): void {
  const ink = seatInk(Math.max(w, h), night, warmth);
  ctx.shadowColor = ink.color;
  ctx.shadowBlur = ambient ? ink.blur * 0.6 : ink.blur;
  ctx.shadowOffsetY = ink.offsetY;
  let dx = x;
  let dy = y;
  let dw = w;
  let dh = h;
  if (natW > 0 && natH > 0) {
    const imgAr = natW / natH;
    const boxAr = w / h;
    if (Math.abs(imgAr - boxAr) / boxAr > 0.02) {
      if (imgAr > boxAr) {
        dh = w / imgAr;
        dy = y + (h - dh) / 2;
      } else {
        dw = h * imgAr;
        dx = x + (w - dw) / 2;
      }
    }
  }
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

/** Faint radial seating vignette behind a cluster centroid (screen space). Night
 *  lifts the cluster off obsidian with a warm off-white pool; day drops a soft
 *  ink pool. Golden Hour `warmth` mixes toward amber (0 reproduces the untinted
 *  theme); inside the sunrise/sunset band the pool glows a touch more. Fills the
 *  given W×H — extracted verbatim from renderer.paintVignette. */
export function paintVignette(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  cx: number,
  cy: number,
  radius: number,
  night: boolean,
  warmth = 0,
  golden = false,
): void {
  if (radius <= 1) return;
  const lift = golden ? 0.015 : 0;
  const g = ctx.createRadialGradient(cx, cy, radius * 0.12, cx, cy, radius);
  if (night) {
    g.addColorStop(0, mixRgba([245, 234, 210, 0.06], [255, 196, 120, 0.085 + lift], warmth));
    g.addColorStop(1, mixRgba([245, 234, 210, 0], [255, 196, 120, 0], warmth));
  } else {
    g.addColorStop(0, mixRgba([58, 44, 24, 0.05], [122, 72, 20, 0.07 + lift], warmth));
    g.addColorStop(1, mixRgba([58, 44, 24, 0], [122, 72, 20, 0], warmth));
  }
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

/** A SET of distinct perched-bird silhouettes in the GLYPH_W×GLYPH_H box — used
 *  when a species has no baked mask, so an un-illustrated bird still reads as a
 *  bird (never a box, never a letter) and adjacent default-mask birds never twin
 *  (the slug hash picks + mirrors one). None is duck-shaped; all read upright. */
export const GENERIC_BIRDS: Array<() => Path2D> = [
  // Round-bodied songbird, short cocked tail (wren/robin feel).
  () => {
    const p = new Path2D();
    p.ellipse(54, 46, 26, 20, -0.15, 0, TAU); // body
    p.ellipse(30, 28, 13, 13, 0, 0, TAU); // head
    p.moveTo(19, 26); p.lineTo(4, 30); p.lineTo(20, 33); p.closePath(); // beak
    p.moveTo(76, 44); p.lineTo(97, 30); p.lineTo(80, 56); p.closePath(); // tail up
    return p;
  },
  // Slim finch, long tail dropping down.
  () => {
    const p = new Path2D();
    p.ellipse(48, 40, 20, 16, -0.1, 0, TAU); // body
    p.ellipse(30, 24, 11, 11, 0, 0, TAU); // head
    p.moveTo(21, 22); p.lineTo(7, 25); p.lineTo(22, 29); p.closePath(); // beak
    p.moveTo(56, 48); p.lineTo(70, 71); p.lineTo(48, 58); p.closePath(); // long tail down
    return p;
  },
  // Upright standing bird (thrush/starling), head stacked on the body.
  () => {
    const p = new Path2D();
    p.ellipse(52, 46, 21, 25, 0.05, 0, TAU); // tall body
    p.ellipse(52, 17, 14, 14, 0, 0, TAU); // head on top
    p.moveTo(40, 14); p.lineTo(24, 17); p.lineTo(41, 21); p.closePath(); // beak
    p.moveTo(66, 60); p.lineTo(83, 70); p.lineTo(60, 62); p.closePath(); // short tail
    return p;
  },
  // Plump dove, small head, long sweeping tail.
  () => {
    const p = new Path2D();
    p.ellipse(46, 42, 27, 19, -0.12, 0, TAU); // plump body
    p.ellipse(24, 30, 10, 10, 0, 0, TAU); // small head
    p.moveTo(16, 29); p.lineTo(5, 31); p.lineTo(16, 34); p.closePath(); // beak
    p.moveTo(64, 46); p.lineTo(96, 52); p.lineTo(66, 56); p.closePath(); // long tail
    return p;
  },
  // Little big-headed tit, tiny tail (flitty).
  () => {
    const p = new Path2D();
    p.ellipse(53, 47, 19, 17, 0, 0, TAU); // small body
    p.ellipse(38, 28, 15, 14, 0, 0, TAU); // big head
    p.moveTo(26, 26); p.lineTo(12, 29); p.lineTo(27, 32); p.closePath(); // beak
    p.moveTo(70, 49); p.lineTo(86, 45); p.lineTo(72, 57); p.closePath(); // tiny tail
    return p;
  },
];

/** The generic glyph for a slug (seeded pick + optional mirror within GLYPH_W),
 *  so no two default-mask birds share a shape. Mirrors renderer.silhouettePath's
 *  default-mask branch exactly. */
export function genericGlyph(slug: string): Path2D {
  const seed = hashSeed(slug);
  const glyph = GENERIC_BIRDS[seed % GENERIC_BIRDS.length]();
  if ((seed >>> 8) & 1) {
    const p = new Path2D();
    p.addPath(glyph, new DOMMatrix([-1, 0, 0, 1, GLYPH_W, 0]));
    return p;
  }
  return glyph;
}
