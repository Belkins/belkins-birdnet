// Runtime configuration, all overridable via Vite env (VITE_*).
// Phase 0 contract: snapshot from the unchanged PHP API, deltas from the
// new /events SSE stream, or a fully self-contained mock with no backend.

const env = import.meta.env;

/** Base for the legacy PHP API (snapshot + cutout images). */
export const API_BASE: string = env.VITE_API_BASE ?? '/avian/api';

/** SSE endpoint emitting `hello` + `bird.detected` frames. */
export const EVENTS_URL: string = env.VITE_EVENTS_URL ?? '/events';

/** '1' => self-contained demo: bundled snapshot + internal event generator,
 *  no backend required. Anything else => talk to a real birdcast. */
export const MOCK: boolean = env.VITE_MOCK === '1';

/** Vite-managed base path; '/' in dev, configurable for sub-path deploys. */
export const BASE: string = env.BASE_URL ?? '/';

/** All-time species catalog (the life-list "wall" source), served under
 *  /collage/ — mirrors the `${BASE}data/masks.json` convention. On the Pi this
 *  path is a symlink to the nightly scripts/species.json; in dev it resolves to
 *  the bundled public/species.json fixture. Overridable via VITE_CATALOG_URL. */
export const CATALOG_URL: string = env.VITE_CATALOG_URL ?? `${BASE}species.json`;

/** Honest derived-intelligence bundle (the derive.py single-writer output):
 *  local rarity, co-occurrence, waking line, first-of-year. Served next to
 *  species.json under /collage/. Consumed only by the COMPANION surfaces (the
 *  /lab console) — never the museum frame. Absent until derive.py has run, so
 *  every reader degrades to silence. Overridable via VITE_DERIVED_URL. */
export const DERIVED_URL: string = env.VITE_DERIVED_URL ?? `${BASE}derived.json`;

/** Conservator's Mark reader (birdgen's public, CORS-open /attest/<slug>).
 *  Quality metadata only — no art, no queue control — so the popup fetches it
 *  straight from the browser. Every reader degrades to silence: a 404 means a
 *  bundled (never machine-painted, never judged) plate, and shows NO mark. */
export const ATTEST_URL: string =
  env.VITE_ATTEST_URL ?? 'https://birdgen-production.up.railway.app/attest';

/** Window (hours) for the initial snapshot. Matches the legacy default. */
export const SNAPSHOT_HOURS = 24;

/** Mock generator cadence (ms) between synthesized detections. */
export const MOCK_INTERVAL_MS = 4000;
