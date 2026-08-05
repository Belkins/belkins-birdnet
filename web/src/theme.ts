// Night (Obsidian) / Day (cream) theme.
// Persisted to localStorage and applied as `data-theme` on <html>; the colour
// layer lives in index.css as CSS variables. The Canvas2D renderer can't read
// CSS vars, so it reads `birdInk()` here for the per-theme bird treatment
// (a warm spotlight glow at night, a soft contact shadow by day).

import { solarElevationDeg } from './solar';

export type Theme = 'night' | 'day';

const KEY = 'belkins-birdnet-theme';

/** The persisted theme, defaulting to night (Obsidian). A `?theme=day|night`
 *  query knob overrides storage without replacing it — the e-ink print path
 *  boots a fresh profile with no localStorage, and the wall must not inherit
 *  the museum's evening dress (the print path only sets query knobs). Kept in
 *  lockstep with the FOUC pre-paint script in index.html. */
export function storedTheme(): Theme {
  try {
    const q = new URLSearchParams(location.search).get('theme');
    if (q === 'night' || q === 'day') return q;
  } catch {
    /* no location / malformed query; fall through to storage */
  }
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'night' || v === 'day') return v;
  } catch {
    /* localStorage may be unavailable (private mode); fall through */
  }
  return 'night';
}

/** Apply + persist. Sets data-theme on <html> so the CSS var blocks switch. */
export function applyTheme(t: Theme): void {
  document.documentElement.setAttribute('data-theme', t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'day' ? '#fcfaf4' : '#0a090d');
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* ignore persistence failure */
  }
}

/** One Canvas2D shadow per drawImage — a glow (night) or a contact shadow (day). */
export interface BirdInk {
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetY: number;
}

export function birdInk(t: Theme): BirdInk {
  return t === 'day'
    ? { shadowColor: 'rgba(50, 38, 22, 0.22)', shadowBlur: 12, shadowOffsetY: 8 }
    : { shadowColor: 'rgba(255, 196, 120, 0.42)', shadowBlur: 26, shadowOffsetY: 0 };
}

export interface SolarTint {
  warmth: number;
  golden: boolean;
}

/** Golden Hour ink warmth (delight-motion §1). Maps the REAL sun elevation
 *  (offline NOAA math, the device's own clock) to 0..1 warmth the renderer
 *  folds into seatInk/paintVignette. A lighting treatment, never data:
 *  warmth 0 leaves the theme's inks unchanged. */
export function solarTint(now: Date, lat: number, lon: number): SolarTint {
  const e = solarElevationDeg(now, lat, lon);
  // Tent peaking at the horizon: neutral above 10° (midday), fading to a
  // neutral deep-calm by −8° (night). Low winter sun stays honestly warm.
  const warmth = clamp01(Math.min((10 - e) / 10, 1 + e / 8));
  return { warmth, golden: e >= -4 && e <= 6 };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
