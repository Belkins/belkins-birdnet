# Belkins BirdNET — Collage Shell (Phase 0)

A Vite + React + TypeScript front end that paints BirdNET detections onto a
live, bird-shaped collage. A real (or mock) detection appears on screen
**< ~3 s after the DB write, with no full-page reload** — the cheap dogfood
that gates the Phase-1 WebGL painter.

This app owns **only** the `web/` directory. It reuses the **unchanged** legacy
PHP API for the snapshot + cut-out images, and consumes the new `/events` SSE
stream for live deltas (both defined in `_plan/_build/PHASE-0-CONTRACT.md`).

---

## Run locally on a Mac with NO backend (mock mode)

```bash
cd web
npm install
npm run dev          # dev defaults to mock (see .env.development)
# or be explicit:
npm run dev:mock
```

Open the printed URL (e.g. http://localhost:5173). You'll see:

- an initial collage seeded from a **bundled snapshot** (15 real species +
  one "default-mask" demo species), and
- a new bird **painting in** roughly every 4 s, driven by an internal mock
  generator that cycles real species slugs.

No PHP, no `birds.db`, no SSE server required. Mock illustrations live in
`public/mock/`; the silhouette masks + dimensions live in `public/data/`.

### Production build (the gate)

```bash
npm run build        # tsc -b && vite build — must exit 0
npm run preview      # serve the built dist/ (real mode unless VITE_MOCK=1)
```

---

## Point it at a real birdcast

Configuration is via Vite env vars (all optional):

| Var | Default | Meaning |
|-----|---------|---------|
| `VITE_MOCK` | `1` in dev, unset in prod | `1` = self-contained mock (no backend). Anything else = talk to a real backend. |
| `VITE_API_BASE` | `/avian/api` | Base for the legacy PHP API. Snapshot: `birdnet-api.php?action=recent&hours=24`. Images: `cutout.php?sci=<sci>&pose=1`. |
| `VITE_EVENTS_URL` | `/events` | SSE endpoint emitting `hello` + `bird.detected` frames. |
| `VITE_PROXY_TARGET` | _(unset)_ | Dev-only. If set (e.g. `http://raspberrypi.local`), the dev server proxies `/avian` and `/events` to it so `dev:real` works cross-origin. |

Examples:

```bash
# Dev against a real birdcast on the same host (same-origin, no proxy):
VITE_MOCK=0 npm run dev:real

# Dev against a Pi on the LAN (proxy /avian + /events to it):
echo 'VITE_MOCK=0'                             >  .env.local
echo 'VITE_PROXY_TARGET=http://birdcast.local' >> .env.local
npm run dev

# Production build that talks to same-origin /avian + /events:
VITE_MOCK=0 npm run build
```

When live, the client opens `EventSource(VITE_EVENTS_URL)`. On reconnect the
browser automatically sends `Last-Event-ID`, so the birdcast ring-buffer replay
(per the contract) is transparent — only the missed `bird.detected` frames are
re-delivered, and each is added incrementally (no re-pack).

---

## How it works (Phase 0 scope)

- **Snapshot seed** — `fetchSnapshot()` pulls `action=recent&hours=24` and runs
  the **faithful** layout pipeline ported from `avian/frontend/apt.js`:
  count-weighted tile areas (`tuning()`), largest-first **spiral nest** against
  an occupancy grid (`maskPack`), and an iterative shrink-to-fit so nothing is
  dropped off-screen.
- **Live deltas** — each `bird.detected` adds **one** bird, nested onto the
  **persistent** occupancy grid (no wipe, no re-pack — contract requirement).
- **Renderer** — Canvas2D (the locked primary; WebGL ink-shader is Phase 1 and
  is deliberately **not** built here). Each new bird paints in: fade + scale-up
  + a cheap top-down reveal over ~1.2 s. `prefers-reduced-motion` ⇒ instant.
- **Long tail never dropped** — any species missing from the stale 249-species
  `masks.json` gets a **default bbox mask (aspect 1.4)**, and a missing image
  renders a labelled placeholder card. This fixes the `apt.js:446`
  `if (!mask) return null` drop bug (contract refusal #4).

### Source map

| File | Role |
|------|------|
| `src/config.ts` | Env config (API base, events URL, mock flag). |
| `src/data.ts` | `slugify`, mask/dims load + decode, default-bbox fallback. |
| `src/packer.ts` | `CollageGrid` — ported `maskPack` spiral nester, incremental. |
| `src/renderer.ts` | Canvas2D draw + paint-in animation + placeholders. |
| `src/snapshot.ts` | Initial snapshot (real PHP API or mock). |
| `src/events.ts` | `SseStream` (real) / `MockStream` (generator). |
| `src/mockData.ts` | Bundled mock species + snapshot + event synth. |
| `src/collage.ts` | `CollageEngine` — orchestrates everything. |
| `src/App.tsx` | React shell: full-bleed canvas + status HUD. |
| `public/data/` | `masks.json`, `dims.json` (fetched at runtime, not bundled). |
| `public/mock/` | 15 real illustration PNGs for mock mode. |

---

## Strangler-fig plan (how this replaces the legacy front end)

This is the new front end in a strangler-fig migration:

- **New app → `/`** — build `web/` and serve `dist/` at the site root. It calls
  the existing `/avian/api/*` PHP endpoints and the new `/events` SSE service.
- **Legacy `apt.js` → `/classic`** — the current single-file UI keeps working,
  unchanged, at `/classic` as a fallback while the new collage is validated.
- Nothing in the legacy PHP API or `birds.db` is modified by this front end
  (the backend's only change is one additive, guarded SSE emit — see
  `avian/realtime/`). When the new app reaches parity, `/classic` is retired.

### Known Phase-0 limitations (intentional — deferred to Phase 1)

- Live tiles use a **representative** size, not the global count-weighted
  re-normalisation, because re-normalising would require re-packing the whole
  collage (forbidden in Phase 0). The WebGL painter can re-flow continuously.
- **Resize** updates the canvas but does **not** re-pack; the cluster stays put
  within the resized viewport.
- Flight poses (`-2`) are ignored; Phase 0 is perched-only.
