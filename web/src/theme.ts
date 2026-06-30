// Night (Obsidian) / Day (cream) theme.
// Persisted to localStorage and applied as `data-theme` on <html>; the colour
// layer lives in index.css as CSS variables. The Canvas2D renderer can't read
// CSS vars, so it reads `birdInk()` here for the per-theme bird treatment
// (a warm spotlight glow at night, a soft contact shadow by day).

export type Theme = 'night' | 'day';

const KEY = 'belkins-birdnet-theme';

/** The persisted theme, defaulting to night (Obsidian). */
export function storedTheme(): Theme {
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
