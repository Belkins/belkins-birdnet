// Collage engine — orchestrates data load, snapshot seed, live SSE deltas,
// spiral-nest layout and the Canvas2D paint-in. Framework-agnostic; App.tsx
// just hands it a <canvas> and starts it.
//
// Layout fidelity: the SEED (initial snapshot) uses the faithful apt.js
// pipeline — count-weighted areas (tuning), largest-first spiral pack, and an
// iterative shrink-to-fit so nothing is dropped off-screen. LIVE deltas add
// ONE bird at a time onto the persistent occupancy grid (no re-wipe / no
// re-pack), per the Phase 0 contract.

import type { BirdEvent, EventStream, LiveState, RosterRow, SpeciesRow, Tile } from './types';
import type { Theme } from './theme';
import { solarTint } from './theme';
import type { Settings } from './settings';
import { CollageGrid, COLLAGE_PAD, GRID_STRIDE } from './packer';
import { CollageRenderer } from './renderer';
import { aspect, loadData, loadMask, slugify } from './data';
import { fetchDaySnapshot, fetchSnapshot } from './snapshot';
import { ambientRoster } from './ambient';
import { MockStream, SseStream } from './events';
import { EVENTS_URL, MOCK, SNAPSHOT_HOURS } from './config';
import { PROFILE } from './profile';
import { birdImageUrl } from './img';
import { FLIGHT_ASPECT, rollPose } from './flight';

// Failed-tile retry loop (auto-gen watcher, CONTRACT.md "Live-update Phase A").
// A brand-new species' cutout.php 302s to Railway, which 404s until the PNG is
// generated (~30s). We retry ONLY a live-added new species' <img> (flagged
// `retryable`, within a short window) with a cache-buster so the next 302 -> 200
// paints it in without a page refresh. Seed / ambient / null-url tiles are never
// retried — that unbounded sweep is what turned the console into a 404 storm.
const RETRY_INTERVAL_MS = 30000; // ~30s between sweeps
const RETRY_MAX_TRIES = 3; // 3 sweeps -> ~90s total, then give up
const RETRY_WINDOW_MS = 90000; // only watch a live-new tile for ~90s after it lands

// Vertical seat of the HERO inside the safe box (0 = top, 1 = bottom). Placed a
// touch below middle so the hero still reads as the central anchor while the
// cluster's mass settles into the lower half — with the title clear zone above,
// this composes the scene top-to-bottom instead of floating it top-heavy.
const HERO_Y_FRAC = 0.54;

// The wall's ?overlap= knob as a stamp fraction (1 = no overlap, the museum's
// own law). Applied at every CollageGrid construction so incremental placement
// and full repacks agree on what blocks.
const STAMP_FRAC = 1 - (PROFILE.overlap ?? 0);

// Count-weighted tuning — ported verbatim from apt.js `tuning()`. The wall's
// Display Profile may override the three FRACTIONS (?budget= / ?mintile= /
// ?herocap=): a print viewport IS the whole panel, and these count-stepped
// values — sized so a busy plate never crowds a page that also carries
// chrome — read as a stamp on 13.3" of ink. countExp and the ellipse stay
// the composition's own; the knobs move shares of the page, never its shape.
function tuning(n: number) {
  return {
    packingBudgetFrac: PROFILE.budget ?? (n <= 4 ? 0.46 : n <= 12 ? 0.4 : n <= 24 ? 0.34 : 0.28),
    countExp: 0.65,
    minTileAreaFrac: PROFILE.minTile ?? (n <= 8 ? 0.01 : n <= 20 ? 0.0075 : 0.0055),
    // Hero cap: no single bird exceeds this fraction of the viewport. Raised from
    // the old 0.17/0.13/0.10 so the most-heard species reads as UNMISTAKABLY the
    // largest plate at optical centre — the old cap flattened the top of the
    // gradient and let the #1 and #2 birds tie in size. Still bounded so a lone
    // N=1 window can't balloon into a canvas-filling plate.
    maxTileAreaFrac: PROFILE.heroCap ?? (n <= 2 ? 0.22 : n <= 6 ? 0.17 : n <= 12 ? 0.13 : 0.11),
    // Ellipse bias for the spiral nest. Dropped from 2.1 (a wide, shelf-like
    // horizontal band that spread birds into an even top row) to 1.35 and now
    // 1.18 so the cluster grows as a rounded ROSETTE that fills the composition
    // top-to-bottom, not a wide shelf that stacks into a top-heavy band.
    ellipseAspectBias: 1.18,
  };
}

function makeTile(
  sci: string,
  com: string,
  slug: string,
  fullW: number,
  fullH: number,
  pose: 1 | 2 = 1,
): Tile {
  // Flight tiles size their box to the MEASURED flight aspect so the wings-spread
  // cutout fills it without distortion (the renderer stretches image -> box).
  // Perched uses the bundled/DEFAULT aspect. The mask is a bbox at that aspect
  // for species without a baked silhouette (all Railway species), same as perched.
  const ar = pose === 2 ? (FLIGHT_ASPECT[slug] ?? aspect(sci)) : aspect(sci);
  return {
    sci,
    com,
    slug,
    pose,
    mask: loadMask(slug, ar),
    ar,
    fullW,
    fullH,
    x: -99999,
    y: -99999,
    img: null,
    loaded: false,
    failed: false,
    animStart: null,
  };
}

/** Axis-aligned footprint intersection — the guard addBird uses to evict an
 *  ambient ghost a freshly-placed live bird lands on (the live grid never
 *  collision-tests against the ambient layer's separate grid). Parked
 *  (off-screen) tiles never overlap anything. */
function tilesOverlap(a: Tile, b: Tile): boolean {
  if (a.x < -9000 || b.x < -9000) return false;
  return (
    a.x < b.x + b.fullW && b.x < a.x + a.fullW && a.y < b.y + b.fullH && b.y < a.y + a.fullH
  );
}

export interface EngineCallbacks {
  onCount?: (count: number) => void;
  onStatus?: (status: string) => void;
  onLatest?: (com: string) => void;
  /** The species roster (snapshot + live increments), for the React views.
   *  `archiveDay` tags WHICH data these rows are: the pinned past day, or null
   *  for live NOW. The tag travels WITH the rows so a consumer can never diff
   *  or label archive counts as live ones (honesty firewall). */
  onData?: (rows: RosterRow[], archiveDay: string | null) => void;
  /** Live SSE connection state — drives the counter's live/idle/offline dot. */
  onLive?: (s: LiveState) => void;
  /** Fired at most once after the seed's illustrations settle, so the frame /
   *  print path can call markFrameReady() (spec §5.4). */
  onReady?: () => void;
  /** A live detection of a species the CURRENT WINDOW's roster has never
   *  held. This is a cheap PRE-FILTER, not a first-ever verdict — the roster
   *  is window-scoped (cleared on every setWindow/setDay), so a ledger
   *  veteran quiet for an hour trips it too. The Accession Moment's real
   *  authority is the station-lifetime catalog, checked by the App handler
   *  via accession.ts's decideAccession. whenIso is the DETECTION's own
   *  timestamp (the event frame), because SSE replay delivers old frames by
   *  design and the card's copy is a claim about the detection, not the
   *  browser. addBird never runs on a pinned day, so this cannot fire from
   *  the archive. */
  onAccession?: (ev: { sci: string; com: string; slug: string; whenIso: string | null }) => void;
}

export class CollageEngine {
  private readonly renderer: CollageRenderer;
  private grid: CollageGrid;
  private stream: EventStream | null = null;
  private W = 0;
  private H = 0;
  private xBias = 1;
  private yBias = 1;
  private pad = COLLAGE_PAD;
  /** representative live-tile area, derived from the seed (keeps live birds
   *  visually consistent with the seeded plate without a full re-pack). */
  private areaHint = 0;
  private started = false;
  private disposed = false;
  /** pinned past day (time-travel scrubber), or null = live NOW. While set,
   *  live SSE deltas are gated off — a detection belongs to NOW, never to a
   *  pinned archive day. */
  private viewDay: string | null = null;
  /** monotonic seed sequence: a slow setDay/setWindow response landing after a
   *  faster later one must never seed under the wrong label (honesty guard). */
  private seedSeq = 0;
  /** failed-tile retry loop (auto-gen watcher live-update). */
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private retryCount = 0;
  /** Golden Hour: whether the once-a-minute solar recompute loop is running. */
  private solarOn = false;
  private solarTimer: ReturnType<typeof setInterval> | null = null;
  private readonly cb: EngineCallbacks;
  /** species roster (snapshot counts + live increments) → React views. */
  private readonly roster = new Map<string, RosterRow>();
  /** ambient backdrop tiles on their OWN grid — painted behind the real birds
   *  and NEVER counted (the honesty firewall). */
  private ambientGrid: CollageGrid | null = null;
  private ambientMode: Settings['ambientFill'] = 'roster';
  private ambientDensity: Settings['density'] = 'balanced';
  /** all-time life list, fetched lazily once for the `roster` ambient mode. */
  private allTime: SpeciesRow[] = [];
  private allTimeFetched = false;
  private allTimePending = false;
  /** cb.onReady fires at most once, after the first seed's images settle. */
  private onReadyFired = false;

  constructor(canvas: HTMLCanvasElement, cb: EngineCallbacks = {}) {
    this.cb = cb;
    this.renderer = new CollageRenderer(canvas);
    const rect = canvas.getBoundingClientRect();
    this.W = Math.max(1, rect.width);
    this.H = Math.max(1, rect.height);
    this.grid = new CollageGrid(this.W, this.H, GRID_STRIDE, COLLAGE_PAD, STAMP_FRAC);
    this.computeBiases();
  }

  private computeBiases(): void {
    const narrow = this.W <= 700;
    const T = tuning(20);
    // Wide screens: a rounded, slightly-taller-than-a-band ROSETTE so the cluster
    // fills the composition top-to-bottom instead of stacking into a wide top
    // shelf (the old top-heavy read). Narrow (portrait phone): a taller oval so
    // the cluster uses the vertical room instead of a squat band.
    this.xBias = narrow ? 1 : T.ellipseAspectBias;
    this.yBias = narrow ? 1.5 : 1.2;
    // COLLAGE_PAD was tuned on desktop-width canvases. The wall shoots ZOOMED
    // viewports (273px wide at zoom 2.2) where three fixed grid cells read as
    // a moat around every bird and the flock cannot attain its budget —
    // "locked resolution" smallness. Scale the pad with canvas width, floor 1.
    const basePad = narrow ? Math.max(1, COLLAGE_PAD - 1) : COLLAGE_PAD;
    this.pad = Math.max(1, Math.round(basePad * Math.min(1, this.W / 600)));
  }

  /** The composition-safe rectangle: the region the cluster may occupy so no
   *  bird tangents the canvas edge or the chrome (top masthead + filter/menu,
   *  bottom nav + live counter + colophon). Insets are generous enough to clear
   *  the worst-case (collage-mode) chrome, and harmless in frame mode where the
   *  cluster simply sits a touch inboard of the hidden chrome. */
  private safeBox(): { L: number; T: number; R: number; B: number } {
    const { W, H } = this;
    const mx = Math.max(24, W * 0.05); // side gutters (clears parakeet-tail tangents)
    // TITLE CLEAR ZONE: reserve the whole display-headline band at the top so no
    // bird (parakeet head et al.) can tangent RECENTLY — in BOTH collage-landing
    // and chrome-free frame modes. Deliberately generous: a large display title
    // plus its top offset, so the clamp below keeps the cluster wholly beneath it.
    const mt = Math.max(96, H * 0.2); // top: display title band + filter/menu row
    // Bottom: nav + counter + colophon, but pulled in from the old 0.15 so the
    // cluster's baseline extends into the lower third (kills the dead bottom zone).
    const mb = Math.max(56, H * 0.12);
    return { L: mx, T: mt, R: W - mx, B: H - mb };
  }

  /** Translate a packed cluster so its HERO (largest = most-heard tile) sits at
   *  the safe box's optical centre, then CLAMP the translation so the whole
   *  cluster still fits inside the safe box (fit wins over a perfectly-centred
   *  hero if the cluster is lopsided). Restamps the occupancy grid to the moved
   *  positions so live placement collides against the right cells. Returns the
   *  applied delta so a caller can shift a parallel layer (ambient) in step. */
  private centreCluster(
    grid: CollageGrid,
    safe: { L: number; T: number; R: number; B: number },
  ): { dx: number; dy: number } {
    const on = grid.onScreen();
    if (!on.length) return { dx: 0, dy: 0 };
    const cxT = (safe.L + safe.R) / 2;
    const cyT = safe.T + (safe.B - safe.T) * HERO_Y_FRAC;
    // Hero = the LARGEST DRAWN SPAN (longest edge), which the count→size engine
    // guarantees is the most-heard bird. Selecting on edge (not raw area) keeps
    // the anchor honest even when a rounder bird has more pixel area than a taller
    // one of the same span.
    let hero = on[0];
    for (const t of on) {
      if (Math.max(t.fullW, t.fullH) > Math.max(hero.fullW, hero.fullH)) hero = t;
    }
    let dx = cxT - (hero.x + hero.fullW / 2);
    let dy = cyT - (hero.y + hero.fullH / 2);
    const b = bounds(on);
    if (b.R + dx > safe.R) dx = safe.R - b.R;
    if (b.L + dx < safe.L) dx = safe.L - b.L;
    if (b.B + dy > safe.B) dy = safe.B - b.B;
    if (b.T + dy < safe.T) dy = safe.T - b.T;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      for (const t of grid.placed) {
        if (t.x > -99998) {
          t.x += dx;
          t.y += dy;
        }
      }
      grid.restamp();
    }
    return { dx, dy };
  }

  /** Boot the collage at `hours` of history. The caller passes its PERSISTED
   *  window straight in: seeding 24h here and re-seeding afterwards fired a
   *  second full loadImage() sweep for every tile, so anyone who had ever
   *  picked 1H/12H/7d/all silently paid double the image bytes on every load.
   *  masks and the snapshot are independent (masks are per-slug silhouette
   *  geometry, the snapshot is which birds are in the window), so both are
   *  kicked off before either is awaited — one fewer serial network level
   *  before the first bird request goes out. */
  async start(hours: number = SNAPSHOT_HOURS): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.cb.onStatus?.('loading masks');
    const masksP = loadData();
    // seq is claimed with the fetch it guards, exactly as before.
    const seq = ++this.seedSeq;
    const snapP = fetchSnapshot(hours);
    // Keeps a rejected snapshot from surfacing as an unhandled rejection if
    // this method returns before the try/catch below awaits it (the disposed
    // early-returns). snapP's real rejection handling stays down there.
    void snapP.catch(() => undefined);
    try {
      await masksP;
    } catch (err) {
      // The ONE await here that used to reject out of start() and strand the
      // boot on 'loading masks' forever (unhandled rejection, no console on
      // the kiosk/e-ink surface). Degrade like every other fetch in this
      // class: report, keep going — aspect() falls back per-species and the
      // snapshot + live feed below still come up.
      this.cb.onStatus?.(`mask data failed: ${String(err)}`);
    }
    if (this.disposed) return;
    this.syncTiles();
    this.renderer.resize(this.W, this.H);

    this.cb.onStatus?.('loading snapshot');
    try {
      const snapshot = await snapP;
      if (this.disposed) return;
      // A setDay/setWindow issued while the boot snapshot was in flight owns
      // the label now — skip the stale boot seed, but still connect live.
      if (seq === this.seedSeq) this.seed(snapshot);
    } catch (err) {
      this.cb.onStatus?.(`snapshot failed: ${String(err)}`);
    }

    if (this.disposed) return;
    this.connectLive();
  }

  /** Faithful initial pack of the snapshot (apt.js renderCollage pipeline). */
  private seed(species: SpeciesRow[]): void {
    const { W, H } = this;
    if (!species.length) {
      this.cb.onStatus?.(MOCK ? 'mock — waiting for birds' : 'no birds in window');
      this.cb.onCount?.(0);
      // Never barren: even with nothing in-window, paint the ambient cast and
      // let the frame/print path settle (a listening screen is a valid capture).
      this.populateAmbient();
      // Emit the (now-cleared) roster so React's rows don't stay stale on the
      // previous window — species=0 / calls=0 / LISTENING.
      this.emitRoster();
      this.fireReady();
      return;
    }
    const T = tuning(species.length);
    const vpArea = W * H;
    const budget = vpArea * T.packingBudgetFrac;
    const minArea = vpArea * T.minTileAreaFrac;

    // Step 1: count-weighted score (sub-linear so a loud bird doesn't drown).
    const scored = species.map((s) => {
      const n = !s.n || Number.isNaN(s.n) ? 1 : s.n;
      return { s, score: Math.pow(Math.max(1, n), T.countExp), area: 0, edge: 0 };
    });
    // Step 2: normalise to budget, floor each at minArea.
    const sumScore = scored.reduce((a, t) => a + t.score, 0) || 1;
    scored.forEach((t) => {
      t.area = Math.max(minArea, (budget * t.score) / sumScore);
    });
    // Clamp the hero AFTER the min-area floor: nothing exceeds maxTileAreaFrac of
    // the viewport (minArea 0.0055-0.01 is always < maxArea 0.1-0.17, so floor and
    // cap never conflict). Fixes the giant N=1 hero overlapping the ambient cast.
    const maxArea = vpArea * T.maxTileAreaFrac;
    scored.forEach((t) => {
      if (t.area > maxArea) t.area = maxArea;
    });
    // Squeeze the over-budget remainder out of the larger tiles only.
    const sumA = scored.reduce((a, t) => a + t.area, 0);
    if (sumA > budget) {
      const fixedSum = scored
        .filter((t) => t.area <= minArea + 1e-9)
        .reduce((a, t) => a + t.area, 0);
      const flexSum = sumA - fixedSum;
      const flexBudget = Math.max(0, budget - fixedSum);
      const shrink = flexSum > 0 ? Math.min(1, flexBudget / flexSum) : 1;
      scored.forEach((t) => {
        if (t.area > minArea + 1e-9) t.area *= shrink;
      });
    }
    // Step 2.5: DRAWN-SIZE authority. The count-weighted AREA above is a good
    // gradient but a poor size read, because a naturally long/wide bird (a long-
    // tailed parakeet, a great tit) spans far more canvas than a rounder, louder
    // bird of the same area — so it looks as big as, or bigger than, the hero.
    // FIX: work in a square-equivalent EDGE (sqrt of area, aspect-INDEPENDENT) so
    // size is decoupled from shape, then (a) rank by count and (b) CAP every non-
    // hero's longest edge to a fraction of the hero's, stepping each quieter bird
    // strictly shorter. The hero's longest drawn edge is therefore the ceiling no
    // bird can reach — the most-heard reads UNMISTAKABLY largest, the 1–2 call
    // birds smallest, and drawn size is a strict monotone read of call count.
    const cnt = (t: { s: SpeciesRow }): number =>
      !t.s.n || Number.isNaN(t.s.n) ? 1 : t.s.n;
    const edgeFloor = Math.sqrt(minArea);
    scored.forEach((t) => {
      t.edge = Math.sqrt(t.area);
    });
    const ranked = [...scored].sort((a, b) => cnt(b) - cnt(a) || a.s.sci.localeCompare(b.s.sci));
    const heroEdge = ranked[0].edge;
    const HERO_EDGE_FRAC = 0.7; // no non-hero's longest edge exceeds 70% of the hero's
    const STEP = 0.92; // each strictly-quieter bird is ≥8% shorter, until the floor
    let runningMax = heroEdge;
    for (let i = 1; i < ranked.length; i++) {
      let e = Math.min(ranked[i].edge, HERO_EDGE_FRAC * heroEdge);
      e = cnt(ranked[i]) < cnt(ranked[i - 1]) ? Math.min(e, runningMax * STEP) : Math.min(e, runningMax);
      e = Math.max(e, edgeFloor);
      ranked[i].edge = e;
      runningMax = e;
    }
    // Step 3: longest-edge + aspect -> width/height -> tiles. The tile BOX (not the
    // image's natural aspect) is the size authority: max(fullW, fullH) === edge, so
    // the hero cap above bounds every bird's on-screen span regardless of shape.
    const tiles = scored.map((t) => {
      const slug = slugify(t.s.sci);
      // Roll perched/flight per fresh seed (rerolls on every reload). Flight tiles
      // size their box to the measured flight aspect so nothing is distorted.
      const pose = rollPose(slug);
      const ar = pose === 2 ? FLIGHT_ASPECT[slug] : aspect(t.s.sci);
      const edge = t.edge;
      const fullW = ar >= 1 ? edge : edge * ar;
      const fullH = ar >= 1 ? edge / ar : edge;
      return makeTile(t.s.sci, t.s.com, slug, fullW, fullH, pose);
    });

    // Iterative shrink-to-fit into the composition-SAFE box (not the raw
    // viewport): re-pack into a fresh grid until the whole cluster fits inside
    // the margins that clear the chrome, so nothing tangents an edge or the
    // masthead/nav/counter. (apt.js scale-to-fit loop, retargeted to safeBox.)
    const safe = this.safeBox();
    const boxW = Math.max(1, safe.R - safe.L);
    const boxH = Math.max(1, safe.B - safe.T);
    let grid = new CollageGrid(W, H, GRID_STRIDE, this.pad, STAMP_FRAC);
    grid.seed(tiles, this.xBias, this.yBias);
    for (let iter = 0; iter < 12; iter++) {
      const b = bounds(grid.onScreen());
      const missing = tiles.some((t) => t.x <= -99998);
      const clW = b.R - b.L;
      const clH = b.B - b.T;
      const overflow = clW > boxW || clH > boxH;
      if (!missing && !overflow) break;
      let scale = 0.93;
      if (overflow) {
        const sx = boxW / Math.max(clW, 1);
        const sy = boxH / Math.max(clH, 1);
        scale = Math.min(scale, sx, sy);
      }
      tiles.forEach((t) => {
        t.fullW *= scale;
        t.fullH *= scale;
      });
      grid = new CollageGrid(W, H, GRID_STRIDE, this.pad, STAMP_FRAC);
      grid.seed(tiles, this.xBias, this.yBias);
    }

    // Centre the HERO (largest = most-heard) at the safe box's optical centre,
    // then clamp the translation so the cluster still fits inside the safe box.
    // Result: Robin sits at optical centre AND no bird tangents an edge/chrome.
    this.centreCluster(grid, safe);

    this.grid = grid;
    // Representative area for live additions: median seeded tile area.
    const areas = tiles.map((t) => t.fullW * t.fullH).sort((a, c) => a - c);
    this.areaHint = areas.length ? areas[areas.length >> 1] : vpArea * 0.012;

    // Seed the species roster (drives the Index / Stats / Atlas views).
    species.forEach((s) => {
      const n = !s.n || Number.isNaN(s.n) ? 1 : s.n;
      this.bumpRoster(s.sci, s.com, slugify(s.sci), n, false);
    });
    this.emitRoster();

    // Seed reveals instantly (no paint-in storm); live deltas paint in. Fire
    // cb.onReady once every seed illustration has settled (decoded or errored)
    // so the frame/print path can mark itself capture-ready (spec §5.4).
    let pending = tiles.length;
    const settle = (): void => {
      pending -= 1;
      if (pending <= 0) this.fireReady();
    };
    const now = performance.now();
    tiles.forEach((t) => {
      t.animStart = null;
      // A seeded species with no cutout yet (Great Tit, Rook, Jackdaw, Blackbird)
      // 302s to Railway, which 404s until it has generated the PNG (~30s). Flag the
      // seed tile bounded-retryable so the generated cutout paints in without a
      // refresh. Bounded (3 sweeps / 90s) + failed-only, so 13 species is no storm.
      // loadImage flips retryable=false for null-url/mock tiles, so MOCK never storms.
      t.retryable = true;
      t.addedAt = now;
      this.loadImage(t, false, settle);
    });
    // Re-arm the bounded retry budget for this (re)seed so a window switch also
    // retries its still-generating species (mirrors addBird's re-arm).
    this.retryCount = 0;
    this.startRetryLoop();
    this.syncTiles();
    this.renderer.requestDraw();
    this.cb.onCount?.(this.grid.onScreen().length);
    this.cb.onStatus?.(MOCK ? 'mock live' : 'live');

    // Never barren: paint the ambient backdrop cast behind the composed birds.
    this.populateAmbient();
  }

  /** Add ONE bird incrementally — no re-wipe, no re-pack (contract). */
  addBird(ev: BirdEvent): void {
    if (this.viewDay !== null) return; // a live detection belongs to NOW, never painted onto a pinned past day
    const sci = ev.sci;
    const slug = ev.slug || slugify(sci);
    const ar = aspect(sci);
    // TODO(phase1): live tiles use a representative area, NOT the global
    // count-weighted re-normalisation, because re-normalising would require
    // re-packing the whole collage (forbidden in Phase 0). The WebGL painter
    // can re-flow continuously.
    const conf = Number.isFinite(ev.conf) ? ev.conf : 0.8;
    const base = this.areaHint || this.W * this.H * 0.012;
    const area = base * (0.7 + 0.6 * Math.max(0, Math.min(1, conf)));
    const fullW = Math.sqrt(area * ar);
    const tile = makeTile(sci, ev.com, slug, fullW, fullW / ar);
    tile.animStart = this.renderer.reducedMotion ? null : performance.now();

    // Only a live-added NEW species is worth retrying (its cutout PNG may still
    // be generating). Flag it retryable + timestamp it so the bounded loop can
    // stop watching after ~90s — seed / ambient / long-tail tiles never retry.
    const isNewSpecies = !this.roster.has(sci);
    if (isNewSpecies) {
      tile.retryable = true;
      tile.addedAt = performance.now();
      // Re-arm the retry budget so a species detected long after boot still gets
      // its cutout retried: resets the count (extends the budget if the loop is
      // alive) and restarts the loop if it already gave up. The per-tile
      // RETRY_WINDOW_MS guard still ages tiles out, so this stays bounded.
      this.retryCount = 0;
      this.startRetryLoop();
    }

    this.grid.placeOne(tile, this.xBias, this.yBias);
    this.loadImage(tile);

    this.bumpRoster(sci, ev.com, slug, 1, isNewSpecies);

    // Evict ambient GHOSTS the new live bird invalidates: (a) this species' own
    // ghost, so a live detection of a currently-ambient bird doesn't show as
    // BOTH a counted tile and an uncounted ghost; (b) ANY ghost whose footprint
    // the live tile landed on — placeOne collision-tests against this.grid
    // (real tiles) only, never the ambient layer's grid, so without this a
    // solid live bird paints straight over a backdrop ghost. Mutate the placed
    // list in place (it's readonly) — no populateAmbient, so surviving ghosts
    // keep their positions. Runs before requestDraw so the overlap never paints.
    if (this.ambientGrid) {
      const kept = this.ambientGrid.placed.filter(
        (t) => t.sci.toLowerCase() !== sci.toLowerCase() && !tilesOverlap(t, tile),
      );
      this.ambientGrid.placed.length = 0;
      this.ambientGrid.placed.push(...kept);
    }

    this.syncTiles();
    this.renderer.requestDraw();
    this.cb.onCount?.(this.grid.onScreen().length);
    this.cb.onLatest?.(ev.com || sci);
    if (isNewSpecies) {
      this.cb.onAccession?.({ sci, com: ev.com || sci, slug, whenIso: ev.iso8601 || null });
    }
    this.emitRoster();
  }

  private loadImage(tile: Tile, bust = false, onSettle?: () => void): void {
    let url = birdImageUrl(tile.slug, tile.sci, tile.pose);
    if (!url) {
      tile.failed = true;
      tile.loaded = true; // settled (placeholder)
      tile.retryable = false; // nothing to fetch — never retry a null-url tile
      onSettle?.();
      return;
    }
    // Cache-buster ONLY on a retry (never on first load), so the browser
    // re-requests a tile whose earlier 302->Railway 404'd. `&` when the URL
    // already carries a query (cutout.php?sci=...&pose=1), `?` otherwise.
    if (bust) {
      url += (url.includes('?') ? '&' : '?') + 't=' + Date.now();
    }
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      tile.img = img;
      tile.loaded = true;
      this.renderer.requestDraw();
      onSettle?.();
    };
    img.onerror = () => {
      tile.failed = true;
      tile.loaded = true;
      this.renderer.requestDraw();
      onSettle?.();
    };
    img.src = url;
  }

  private connectLive(): void {
    this.stream = MOCK ? new MockStream() : new SseStream(EVENTS_URL);
    this.stream.start({
      onHello: () => this.cb.onStatus?.(MOCK ? 'mock live' : 'live'),
      onBird: (ev) => this.addBird(ev),
      onError: () => this.cb.onStatus?.('reconnecting…'),
      onState: (s) => this.cb.onLive?.(s),
    });
    this.startRetryLoop();
  }

  /** Periodically re-attempt any tile whose image failed to load. A brand-new
   *  species redirects (cutout.php 302) to Railway, which 404s until the asset
   *  is generated (~30s); retrying with a cache-buster paints it in once ready,
   *  with no page refresh. Bounded to ~3 sweeps (~90s) then gives up (re-armed by
   *  addBird when a new species lands, so late detections still get retried). */
  private startRetryLoop(): void {
    if (this.retryTimer !== null) return;
    this.retryCount = 0;
    this.retryTimer = setInterval(() => {
      this.retryCount += 1;
      if (this.retryCount > RETRY_MAX_TRIES) {
        this.stopRetryLoop();
        return;
      }
      const now = performance.now();
      for (const tile of this.grid.placed) {
        // Only live-added NEW species are retryable; seed / ambient / null-url
        // tiles are skipped so the console never storms on the long tail.
        if (tile.retryable !== true || tile.failed !== true) continue;
        if (tile.addedAt !== undefined && now - tile.addedAt > RETRY_WINDOW_MS) {
          tile.retryable = false; // aged out — stop watching this tile
          continue;
        }
        tile.failed = false;
        tile.loaded = false;
        this.loadImage(tile, true);
      }
    }, RETRY_INTERVAL_MS);
  }

  private stopRetryLoop(): void {
    if (this.retryTimer !== null) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** Resize the backing canvas. Phase 0 keeps existing bird POSITIONS (no
   *  re-pack), but the occupancy grid is rebuilt at the new size and existing
   *  tiles re-stamped, so the bounds + centre used for FUTURE live placement
   *  track the new viewport (otherwise new birds nest around the stale centre). */
  resize(W: number, H: number): void {
    this.W = Math.max(1, W);
    this.H = Math.max(1, H);
    this.computeBiases();
    const next = new CollageGrid(this.W, this.H, GRID_STRIDE, this.pad, STAMP_FRAC);
    for (const t of this.grid.placed) next.placed.push(t);

    // Re-centre the existing cluster into the resized viewport's SAFE box. Phase 0
    // keeps the relative arrangement (no re-pack / no re-spiral) — this is a pure
    // TRANSLATION of every real + ambient tile by the same delta. Without it, a
    // canvas that shrinks AFTER the seed centred on the taller size (mobile
    // 100vh→dvh URL-bar collapse, a frame-mode layout change, an orientation flip)
    // leaves the cluster jammed against an edge and clipped off-screen. Using the
    // safe box keeps the re-centred cluster clear of the chrome, and live placement
    // then nests around it (bounds + centre track the new viewport).
    const { dx, dy } = this.centreCluster(next, this.safeBox());
    if ((Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) && this.ambientGrid) {
      for (const t of this.ambientGrid.placed) {
        if (t.x > -99998) {
          t.x += dx;
          t.y += dy;
        }
      }
    }

    next.restamp();
    this.grid = next;
    this.syncTiles();
    this.renderer.resize(this.W, this.H);
  }

  /** Re-fetch the snapshot for a new time window and re-seed; live SSE keeps
   *  running. The 1H/12H/24H/7D/ALL filter calls this — and it is the single
   *  return-to-live path: any window change clears a pinned past day. */
  async setWindow(hours: number): Promise<void> {
    if (this.disposed) return;
    const seq = ++this.seedSeq;
    this.cb.onStatus?.('loading snapshot');
    try {
      const snapshot = await fetchSnapshot(hours);
      if (this.disposed || seq !== this.seedSeq) return;
      // The return to live commits only WITH a real snapshot: clearing the pin
      // before the fetch would let a failed return leave the archive collage
      // on screen in full live mode, with SSE painting into a past day.
      this.viewDay = null;
      this.roster.clear();
      this.seed(snapshot);
    } catch (err) {
      this.cb.onStatus?.(`snapshot failed: ${String(err)}`);
    }
  }

  /** Travel the collage to ONE real past local day. Re-seeds through the same
   *  pipeline as setWindow; live SSE deltas are gated off while pinned (they
   *  belong to NOW). The result disambiguates WHY nothing was pinned so the
   *  caller only hides the scrubber when the API truly can't serve days —
   *  never on a transient fetch error or a superseded click. */
  async setDay(day: string): Promise<'ok' | 'stale' | 'unsupported' | 'error'> {
    if (this.disposed) return 'stale';
    const seq = ++this.seedSeq;
    this.cb.onStatus?.('loading day');
    const snapshot = await fetchDaySnapshot(day);
    if (this.disposed || seq !== this.seedSeq) return 'stale';
    if (snapshot === 'unsupported') return 'unsupported';
    if (snapshot === 'error') {
      this.cb.onStatus?.('day fetch failed');
      return 'error';
    }
    this.viewDay = day;
    this.roster.clear();
    this.seed(snapshot);
    // seed() closes on a 'live' status; the archive label written after it wins.
    this.cb.onStatus?.(`archive · ${day}`);
    return 'ok';
  }

  /** The pinned past day, or null = live NOW (mirrors what emitRoster tags). */
  get day(): string | null {
    return this.viewDay;
  }

  /** Forward the active theme to the canvas renderer (glow vs contact shadow). */
  setTheme(theme: Theme): void {
    this.renderer.setTheme(theme);
  }

  /** Toggle idle ambient life (cluster breath + per-bird drift) on the renderer.
   *  Reduced-motion / e-ink already zero the amplitudes inside the renderer. */
  setMotion(on: boolean): void {
    this.renderer.setMotion(on);
  }

  /** Golden Hour: fold the REAL sun's elevation (offline NOAA math from the
   *  configured lat/lon) into the renderer's ink warmth. Recomputed once a
   *  minute, never per frame. Structurally silent when the toggle is off, no
   *  location is configured, or the surface is an e-ink print. */
  setSolar(on: boolean): void {
    const active = on && PROFILE.lat !== null && PROFILE.lon !== null && PROFILE.surface !== 'eink';
    if (active === this.solarOn) return;
    this.solarOn = active;
    if (active) {
      this.solarTick();
      this.solarTimer = setInterval(() => this.solarTick(), 60_000);
    } else {
      this.stopSolarLoop();
      this.renderer.setSolar(0, false);
    }
  }

  private solarTick(): void {
    if (PROFILE.lat === null || PROFILE.lon === null) return;
    const t = solarTint(new Date(), PROFILE.lat, PROFILE.lon);
    this.renderer.setSolar(t.warmth, t.golden);
  }

  private stopSolarLoop(): void {
    if (this.solarTimer !== null) {
      clearInterval(this.solarTimer);
      this.solarTimer = null;
    }
  }

  /** Hit-test a click at CSS px (px,py) against the REAL placed birds and return
   *  the topmost tile's identity + live window count, or null on a miss. Reverse-
   *  iterates this.grid.placed so the most-recently-painted (frontmost) tile wins,
   *  skips parked off-screen tiles, and reads the count from the roster. The
   *  ambient backdrop grid is intentionally NOT consulted — ghosts aren't clickable
   *  (they're uncounted, and a click must map to a real, counted detection). */
  hitTest(px: number, py: number): { sci: string; com: string; slug: string; n: number } | null {
    const placed = this.grid.placed;
    for (let i = placed.length - 1; i >= 0; i--) {
      const t = placed[i];
      if (t.x <= -99998) continue; // parked off-screen — not visible, not clickable
      if (px < t.x || px > t.x + t.fullW || py < t.y || py > t.y + t.fullH) continue;
      const row = this.roster.get(t.sci);
      return { sci: t.sci, com: t.com, slug: t.slug, n: row ? row.n : 1 };
    }
    return null;
  }

  /** Set the never-barren ambient backdrop mode + density and rebuild it now.
   *  Ambient tiles are a low-opacity "cast that has visited" painted behind the
   *  real birds; they are NEVER counted (the honesty firewall). */
  setAmbient(mode: Settings['ambientFill'], density: Settings['density']): void {
    this.ambientMode = mode;
    this.ambientDensity = density;
    this.populateAmbient();
  }

  /** (Re)build the ambient backdrop for the current real roster + settings, on a
   *  SEPARATE grid, and compose it behind the real birds. Skipped entirely on
   *  e-ink prints, under reduced-motion, or when the fill is off. Never calls
   *  bumpRoster — the counter must reflect real detections only. */
  private populateAmbient(): void {
    // The Frame/Wall surface (kiosk) keeps its STATIC backdrop even under
    // reduced-motion: reduced-motion silences MOTION (drift/breath), not the
    // painting's presence — so a wall never collapses to "2 stragglers on black."
    // e-ink (a print) and an explicit `off` still suppress it; a normal reduced-
    // motion SCREEN is unchanged (backdrop off, honest cold-start tiers).
    const isWall = PROFILE.surface === 'kiosk';
    const disabled =
      PROFILE.surface === 'eink' ||
      this.ambientMode === 'off' ||
      (this.renderer.reducedMotion && !isWall);
    if (disabled) {
      if (this.ambientGrid) {
        this.ambientGrid = null;
        this.syncTiles();
        this.renderer.requestDraw();
      }
      return;
    }

    // Lazily fetch the all-time life list once (guarded); it rebuilds on arrival.
    this.ensureAllTime();

    const cast = ambientRoster({
      realRoster: [...this.roster.values()],
      allTime: this.allTime,
      mode: this.ambientMode,
      density: this.ambientDensity,
      // Wall/kiosk density floor: fill to a fuller target so the marquee wall
      // always reads as a composed painting, never empty/still-loading. Screens
      // keep the honest density tier (undefined → the DENSITY_CAP default).
      targetTotal: isWall ? 16 : undefined,
    });

    const grid = new CollageGrid(this.W, this.H, GRID_STRIDE, this.pad, STAMP_FRAC);
    // Reserve every real bird's footprint so ambient nests AROUND the cluster,
    // never on top of a counted bird. With this.grid.placed empty (N=0) blockOut
    // stamps nothing and the first non-anchored tile still resolves to centre via
    // the r=0 spiral ring — identical to the pre-ambient N=0 path.
    grid.blockOut(this.grid.placed);
    const base = this.areaHint || this.W * this.H * 0.012;
    for (const a of cast) {
      const slug = slugify(a.sci);
      const ar = aspect(a.sci);
      // Backdrop tiles sit a touch smaller than live birds so they recede.
      const fullW = Math.sqrt(base * 0.9 * ar);
      const tile = makeTile(a.sci, a.com, slug, fullW, fullW / ar);
      tile.ambient = true;
      tile.animStart = null; // backdrop never reveals
      grid.placeOne(tile, this.xBias, this.yBias, false); // never anchor at centre
      this.loadImage(tile); // honesty firewall: never bumpRoster for ambient
    }
    this.ambientGrid = grid;
    this.syncTiles();
    this.renderer.requestDraw();
  }

  /** Fetch the all-time roster ONCE for the `roster` ambient mode, then rebuild
   *  ambient against it. Failure just leaves the legacy fallback (ambientRoster). */
  private ensureAllTime(): void {
    if (this.allTimeFetched || this.allTimePending) return;
    this.allTimePending = true;
    fetchSnapshot(1_000_000)
      .then((rows) => {
        this.allTimeFetched = true;
        this.allTimePending = false;
        if (this.disposed) return;
        this.allTime = rows;
        this.populateAmbient();
      })
      .catch(() => {
        this.allTimeFetched = true;
        this.allTimePending = false;
      });
  }

  /** Compose the renderer's draw list: ambient backdrop first (so it paints
   *  BEHIND), then the real placed tiles on top. With no ambient layer the real
   *  list is passed as-is — identical to the pre-ambient behaviour. */
  private syncTiles(): void {
    const ambient = this.ambientGrid?.placed;
    this.renderer.setTiles(
      ambient && ambient.length ? [...ambient, ...this.grid.placed] : this.grid.placed,
    );
  }

  /** Fire cb.onReady exactly once (idempotent), after the first seed settles. */
  private fireReady(): void {
    if (this.onReadyFired) return;
    this.onReadyFired = true;
    this.cb.onReady?.();
  }

  private bumpRoster(
    sci: string,
    com: string,
    slug: string,
    addN: number,
    markNew: boolean,
  ): void {
    const existing = this.roster.get(sci);
    if (existing) {
      existing.n += addN;
    } else {
      this.roster.set(sci, { sci, com, slug, n: addN, isNew: markNew });
    }
  }

  private emitRoster(): void {
    if (!this.cb.onData) return;
    this.cb.onData([...this.roster.values()].sort((a, b) => b.n - a.n), this.viewDay);
  }

  destroy(): void {
    this.disposed = true;
    this.stopRetryLoop();
    this.stopSolarLoop();
    this.stream?.stop();
    this.renderer.destroy();
  }
}

function bounds(tiles: Tile[]): { L: number; R: number; T: number; B: number } {
  let L = Infinity;
  let R = -Infinity;
  let T = Infinity;
  let B = -Infinity;
  for (const t of tiles) {
    if (t.x < L) L = t.x;
    if (t.x + t.fullW > R) R = t.x + t.fullW;
    if (t.y < T) T = t.y;
    if (t.y + t.fullH > B) B = t.y + t.fullH;
  }
  if (!Number.isFinite(L)) return { L: 0, R: 0, T: 0, B: 0 };
  return { L, R, T, B };
}
