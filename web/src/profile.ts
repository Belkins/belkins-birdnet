// The Display Profile — the declarative substrate that makes Frame mode (and
// the e-ink print path) buildable (spec §5.4). Parsed ONCE at boot from the URL
// query (with `VITE_*` deploy-time fallbacks), then frozen for the session so
// composition never has to know how it's being shown — it only reads knobs.
//
// `shoot.py` waits on the readiness signal set by `markFrameReady()` instead of
// regex-rewriting `apt.js`; the print path only sets query knobs.

export type Surface = 'screen' | 'kiosk' | 'eink';
export type MotionMode = 'auto' | 'on' | 'off';
export type ChromeMode = 'auto' | 'hidden';

export interface DisplayProfile {
  surface: Surface;
  palette: 'full' | 'spectra6';
  motion: MotionMode;
  chrome: ChromeMode;
  orientation: 'landscape' | 'portrait';
  windowHours: number;
  debugN: number | null;
  ghost: boolean;
  /** one-time city-level location for Golden Hour (null = feature silent). */
  lat: number | null;
  lon: number | null;
  /** Composition-fraction overrides for print/wall surfaces (null = the
   *  count-stepped defaults in collage.ts tuning()). A print viewport IS the
   *  whole panel: the browser fractions, sized for pages that also carry
   *  chrome, read as a stamp on 13.3" of ink. */
  budget: number | null; // packingBudgetFrac: flock's share of viewport area
  minTile: number | null; // minTileAreaFrac: floor under the rarest bird
  heroCap: number | null; // maxTileAreaFrac: ceiling over the most-heard bird
  /** ?overlap= — fraction of each bird's silhouette that neighbours may
   *  cover (packer stamps only the central 1-overlap of the mask). null = no
   *  overlap, the museum's own law. The layered-mob look on the wall. */
  overlap: number | null;
  /** ?air= — breathing room: scales every safeBox() inset (title clear zone,
   *  bottom band, side gutters) by this fraction. The insets carry PIXEL
   *  floors tuned for browser canvases; on the wall's zoomed viewport those
   *  floors eat the glass, and this knob is the lever that gives it back.
   *  null = 1 = today's law. Low values let birds crowd the masthead — the
   *  panel preview shows the truth before anything is painted. */
  air: number | null;
  /** ?seed= — pins the composition dice. The packer itself is deterministic;
   *  the only randomness in a kiosk shot is rollPose's perched-vs-flight
   *  roll, so a pinned seed makes APPLY paint the very composition the panel
   *  previewed. null = every load rolls fresh (the museum's own law). */
  seed: number | null;
}

/** The frozen-for-the-session profile, parsed once at module load. */
export const PROFILE: DisplayProfile = readProfile();

/** True when the app should boot straight into chrome-free wall presentation
 *  (explicit `chrome:hidden`, or any non-screen surface like kiosk/e-ink). */
export const FRAME_AT_BOOT = PROFILE.chrome === 'hidden' || PROFILE.surface !== 'screen';

/** The single deterministic readiness selector `shoot.py` waits on, set once
 *  composition has settled and every illustration has decoded. */
export function markFrameReady(): void {
  window.__frameReady = true;
  document.documentElement.setAttribute('data-frame-ready', '');
}

function readProfile(): DisplayProfile {
  const params = new URLSearchParams(location.search);
  const env = import.meta.env;

  // Query param wins; an empty/absent param falls back to a `VITE_*` deploy var.
  const pick = (key: string, envKey: string): string | null => {
    const q = params.get(key);
    if (q !== null) return q;
    const e = env[envKey];
    return typeof e === 'string' && e !== '' ? e : null;
  };

  // Defaults: screen / full / auto / auto / landscape / 24h / no debug / no ghost.
  let surface: Surface = 'screen';
  let palette: 'full' | 'spectra6' = 'full';
  let motion: MotionMode = 'auto';
  let chrome: ChromeMode = 'auto';
  let orientation: 'landscape' | 'portrait' = 'landscape';
  let windowHours = 24;
  let debugN: number | null = null;
  let ghost = false;
  let lat: number | null = null;
  let lon: number | null = null;

  // ?surface=eink|kiosk|screen — e-ink also implies the print substrate.
  const surfaceRaw = pick('surface', 'VITE_SURFACE');
  if (surfaceRaw === 'eink' || surfaceRaw === 'kiosk' || surfaceRaw === 'screen') {
    surface = surfaceRaw;
  }
  if (surface === 'eink') {
    palette = 'spectra6';
    motion = 'off';
    orientation = 'portrait';
  }

  // ?frame=1 — the wall-display shorthand: dissolve chrome and treat as a kiosk
  // surface (unless an explicit non-screen surface such as e-ink already won).
  if (pick('frame', 'VITE_FRAME') === '1') {
    chrome = 'hidden';
    if (surface === 'screen') surface = 'kiosk';
  }

  // ?chrome=hidden|auto — an explicit override beats the frame shorthand.
  const chromeRaw = pick('chrome', 'VITE_CHROME');
  if (chromeRaw === 'hidden' || chromeRaw === 'auto') chrome = chromeRaw;

  // ?motion=off|on|auto — an explicit override beats the e-ink default.
  const motionRaw = pick('motion', 'VITE_MOTION');
  if (motionRaw === 'off' || motionRaw === 'on' || motionRaw === 'auto') motion = motionRaw;

  // ?win=<hours> — snapshot window override.
  const winRaw = pick('win', 'VITE_WINDOW_HOURS');
  if (winRaw !== null) {
    const w = Number(winRaw);
    if (Number.isFinite(w) && w > 0) windowHours = w;
  }

  // ?n=<int> — debug roster size for the acceptance harness (no backend).
  const nRaw = params.get('n');
  if (nRaw !== null) {
    const n = parseInt(nRaw, 10);
    if (Number.isFinite(n) && n >= 0) debugN = n;
  }

  // ?ghost=1 — opt-in full-cast scatter on the empty screen (never e-ink).
  if (params.get('ghost') === '1') ghost = true;

  // ?budget= / ?mintile= / ?herocap= — wall-surface composition fractions.
  // Each parses independently; out-of-range is null (the page's own law),
  // never a clamp — a half-understood knob must not half-apply.
  const frac = (key: string, envKey: string, max: number): number | null => {
    const raw = pick(key, envKey)?.trim() ?? null;
    if (raw === null || raw === '') return null;
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 && v <= max ? v : null;
  };
  const budget = frac('budget', 'VITE_BUDGET', 1.2);
  let minTile = frac('mintile', 'VITE_MIN_TILE', 0.06);
  let heroCap = frac('herocap', 'VITE_HERO_CAP', 0.6);
  // The PAIR is atomic, like lat/lon below: a floor at or above the ceiling
  // inverts the hero law (every commoner raised to the floor while the hero
  // holds the cap) and parks overflow birds off-screen with no telemetry.
  // Individually valid but jointly absurd -> BOTH revert to the page's law.
  if (minTile !== null && heroCap !== null && minTile >= heroCap) {
    minTile = null;
    heroCap = null;
  }
  const overlap = frac('overlap', 'VITE_OVERLAP', 0.6);
  // ?air= — (0, 1]: 1 keeps the page's own insets, lower values shrink them.
  // frac()'s v > 0 gate is deliberate here too: air=0 (birds tangent to the
  // glass edge and under the masthead) is a mistake, not a composition.
  const air = frac('air', 'VITE_AIR', 1);

  // ?seed= — a positive int31 pins the pose dice; anything else is null
  // (free roll). Digits-only first so "1e3" and "0x10" never sneak past
  // Number(), and 0 stays null — the daemon uses 0 as "not baked".
  const seedRaw = pick('seed', 'VITE_SEED')?.trim() ?? null;
  let seed: number | null = null;
  if (seedRaw !== null && /^[0-9]{1,10}$/.test(seedRaw)) {
    const s = Number(seedRaw);
    if (s >= 1 && s <= 2147483647) seed = s;
  }

  // ?lat=&lon= — one-time city-level location for Golden Hour. The pair is
  // ATOMIC: both must parse in range or BOTH stay null (a half-set location is
  // silence, never a guess). No browser geolocation prompt, no cloud — the sun
  // is computed offline from these plus the device's own clock.
  // Trim first: Number(' ') === 0, so an un-trimmed whitespace value would
  // silently pin the station to Null Island (0°N 0°E) — a fabricated location.
  const latRaw = pick('lat', 'VITE_LAT')?.trim() ?? null;
  const lonRaw = pick('lon', 'VITE_LON')?.trim() ?? null;
  if (latRaw !== null && latRaw !== '' && lonRaw !== null && lonRaw !== '') {
    const la = Number(latRaw);
    const lo = Number(lonRaw);
    if (Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180) {
      lat = la;
      lon = lo;
    }
  }

  return {
    surface,
    palette,
    motion,
    chrome,
    orientation,
    windowHours,
    debugN,
    ghost,
    lat,
    lon,
    budget,
    minTile,
    heroCap,
    overlap,
    air,
    seed,
  };
}
