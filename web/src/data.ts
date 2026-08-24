// Mask + dimension data, ported faithfully from avian/frontend/apt.js.
// Masks and dims are STALE (249 perched-only species). Any species missing
// from these tables falls back to a default bbox mask so the long tail is
// NEVER dropped — this fixes the `apt.js:446` `if (!mask) return null` bug
// (PHASE-0-CONTRACT refusal #4).

import type { Mask } from './types';
import { BASE } from './config';
import { ENGINE_ASPECT, isEngine } from './engine';

type MaskRecord = { w: number; h: number; bits: string };
type RawMasks = Record<string, MaskRecord>;
type RawDims = Record<string, [number, number]>;

let MASKS: RawMasks = {};
let DIMS: RawDims = {};
const maskCache: Record<string, Mask> = {};

/** Default bbox aspect for species lacking baked data (contract refusal #4). */
export const DEFAULT_ASPECT = 1.4;

/**
 * slugify — IDENTICAL to the Python/PHP/JS algorithm in the contract:
 *   re.sub(r"[^a-z0-9]+","-", sci.lower()).strip("-")
 */
export function slugify(sci: string): string {
  return sci
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Fetch the static mask + dims tables once at startup. */
export async function loadData(): Promise<void> {
  const [m, d] = await Promise.all([
    fetch(`${BASE}data/masks.json`).then((r) => r.json() as Promise<RawMasks>),
    fetch(`${BASE}data/dims.json`).then((r) => r.json() as Promise<RawDims>),
  ]);
  MASKS = m;
  DIMS = d;
}

/** width/height aspect for a species (DIMS lookup, else 1.4). */
export function aspect(sci: string): number {
  const slug = slugify(sci);
  // The Engine easter egg's bundled aeroplane plate is wider than any bird's
  // default box; serve its own aspect so the tile doesn't squish the wings.
  if (isEngine(slug)) return ENGINE_ASPECT;
  const d = DIMS[slug];
  return d ? d[0] / d[1] : DEFAULT_ASPECT;
}

/**
 * Build a default rectangular bbox mask at the given aspect. A fully-opaque
 * rectangle => bbox-style (non-overlapping) collision, the documented
 * fallback for the long tail. Low-res so collision tests stay cheap.
 */
function buildDefaultMask(ar: number): Mask {
  // ~24px on the long edge keeps the cell count tiny but the shape correct.
  let w: number;
  let h: number;
  if (ar >= 1) {
    w = 24;
    h = Math.max(1, Math.round(24 / ar));
  } else {
    h = 24;
    w = Math.max(1, Math.round(24 * ar));
  }
  const cells: Array<[number, number]> = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) cells.push([x, y]);
  }
  return { w, h, cells, isDefault: true };
}

/**
 * Decode + cache a species mask. Ported from apt.js `loadMask()`. Returns a
 * default bbox mask (NEVER null) for any slug missing from masks.json.
 */
export function loadMask(slug: string, ar: number): Mask {
  const cached = maskCache[slug];
  if (cached) return cached;

  const rec = MASKS[slug];
  if (!rec) {
    return (maskCache[slug] = buildDefaultMask(ar));
  }

  // base64 -> bit-per-pixel row-major; collect the "on" cells (sparse form).
  const bytes = atob(rec.bits);
  const { w, h } = rec;
  const cells: Array<[number, number]> = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const b = bytes.charCodeAt(i >> 3);
      if ((b >> (7 - (i & 7))) & 1) cells.push([x, y]);
    }
  }
  return (maskCache[slug] = { w, h, cells, isDefault: false });
}
