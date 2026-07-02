// Single source of truth for every user preference the Living Gallery exposes
// (spec §4 controls A–F). Persisted to localStorage as one JSON blob and read
// back resiliently: bad/absent JSON falls back to defaults and unknown keys are
// ignored. Theme is special-cased — it mirrors the existing theme.ts key so the
// pre-paint FOUC script in index.html, applyTheme, and Settings never diverge.

import { applyTheme, storedTheme, type Theme } from './theme';

const KEY = 'belkins-birdnet-settings';

export interface Settings {
  theme: Theme;
  /** snapshot window in hours (mirrors the top filter: 1 / 12 / 24 / 168 / all). */
  windowHours: number;
  listeningAnim: boolean;
  ambientMotion: boolean;
  revealAnim: boolean;
  density: 'cozy' | 'balanced' | 'sparse';
  ambientFill: 'roster' | 'placeholder' | 'off';
  /** seconds idle before auto-entering frame mode (0 = off). */
  autoFrameIdleSec: 0 | 60 | 300;
  showColophon: boolean;
  liferTick: boolean;
  /** Golden Hour: solar-tracking ink warmth. Inert without a configured location (profile.ts lat/lon). */
  solarLight: boolean;
}

export const SETTINGS_DEFAULTS: Settings = {
  theme: 'night',
  windowHours: 24,
  listeningAnim: true,
  ambientMotion: true,
  revealAnim: true,
  density: 'balanced',
  ambientFill: 'roster',
  autoFrameIdleSec: 60,
  showColophon: true,
  liferTick: false,
  // Default ON: configuring lat/lon is the real opt-in gesture — with no
  // location the feature is structurally silent, and a kiosk boots warm.
  solarLight: true,
};

/** Validate one parsed blob field-by-field; unknown keys and wrong types drop. */
function pickKnown(o: Record<string, unknown>): Partial<Settings> {
  const out: Partial<Settings> = {};
  if (o.theme === 'night' || o.theme === 'day') out.theme = o.theme;
  if (typeof o.windowHours === 'number' && Number.isFinite(o.windowHours)) out.windowHours = o.windowHours;
  if (typeof o.listeningAnim === 'boolean') out.listeningAnim = o.listeningAnim;
  if (typeof o.ambientMotion === 'boolean') out.ambientMotion = o.ambientMotion;
  if (typeof o.revealAnim === 'boolean') out.revealAnim = o.revealAnim;
  if (o.density === 'cozy' || o.density === 'balanced' || o.density === 'sparse') out.density = o.density;
  if (o.ambientFill === 'roster' || o.ambientFill === 'placeholder' || o.ambientFill === 'off') out.ambientFill = o.ambientFill;
  if (o.autoFrameIdleSec === 0 || o.autoFrameIdleSec === 60 || o.autoFrameIdleSec === 300) out.autoFrameIdleSec = o.autoFrameIdleSec;
  if (typeof o.showColophon === 'boolean') out.showColophon = o.showColophon;
  if (typeof o.liferTick === 'boolean') out.liferTick = o.liferTick;
  if (typeof o.solarLight === 'boolean') out.solarLight = o.solarLight;
  return out;
}

/** Read the persisted blob; never throws (corrupt JSON / no storage → {}). */
function readStored(): Partial<Settings> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    return pickKnown(parsed as Record<string, unknown>);
  } catch {
    /* corrupt JSON or unavailable storage — fall through to defaults */
    return {};
  }
}

/** Defaults <- persisted blob, with theme taken from the canonical theme.ts key
 *  (back-compat) so it agrees with the pre-paint FOUC script in index.html. */
export function loadSettings(): Settings {
  return { ...SETTINGS_DEFAULTS, ...readStored(), theme: storedTheme() };
}

/** Persist the whole blob, then mirror the theme through theme.ts so its
 *  localStorage key, the FOUC pre-paint script, and applyTheme stay in lockstep. */
export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore persistence failure (private mode / quota) */
  }
  applyTheme(s.theme);
}
