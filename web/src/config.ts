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

/** Window (hours) for the initial snapshot. Matches the legacy default. */
export const SNAPSHOT_HOURS = 24;

/** Mock generator cadence (ms) between synthesized detections. */
export const MOCK_INTERVAL_MS = 4000;
