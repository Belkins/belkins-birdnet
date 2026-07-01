/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL for the legacy PHP API (snapshot + cutout images). */
  readonly VITE_API_BASE?: string;
  /** SSE endpoint for live `bird.detected` deltas. */
  readonly VITE_EVENTS_URL?: string;
  /** '1' => self-contained mock (no backend). */
  readonly VITE_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  /** Deterministic readiness flag set by `markFrameReady()`; `shoot.py` waits on it. */
  __frameReady?: boolean;
}
