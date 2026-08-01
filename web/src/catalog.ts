// Species catalog — the all-time life-list source for the Collection Wall tab.
// The wall reads this INDEPENDENTLY of the live engine roster: one plate per
// species ever heard, accreting over time. Real mode fetches the nightly
// species.json the catalog rebuild produces (symlinked under /collage/); mock
// mode resolves the bundled public fixture. Mirrors snapshot.ts — a 404, an
// empty body, or a parse error collapses to `[]` and NEVER throws to the view,
// so the wall shows its calm empty state instead of an error or a dead spinner.

import { BASE, CATALOG_URL, MOCK } from './config';

export interface CatalogSpecies {
  sci_name: string;
  com_name: string;
  slug: string;
  first_confident: string | null;
  last_detected: string | null;
  detection_count: number;
  art_status: string;
  /** WHO MADE THE PICTURE: 'bundled' ships with the repo, 'autogen' was painted
   *  here. cutout.php serves both with X-Av-Real:1, so no header can tell them
   *  apart and the Library's provenance caption has nothing else to go on. */
  art_source: string;
  // Pinned permanent accession No. from the nightly build (int), or null when a
  // bird has been heard but never confidently detected. `undefined` = the build
  // predates the pin (old deployment) → the wall falls back to client derivation.
  accession?: number | null;
  // Sparse per-species ISO-week presence: [[week 1..53, count], ...] ascending.
  // Missing/garbage coerces to [] so consumers never see a malformed shape.
  weeks: Array<[number, number]>;
}

/** The bundled dev/mock fixture ships in public/ and is served at the app base. */
const MOCK_CATALOG_URL = `${BASE}species.json`;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asNullableString(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** Coerce the untrusted `weeks` payload into sparse [[isoWeek, count], ...].
 *  Anything non-array, malformed pairs, non-finite numbers, or out-of-range
 *  weeks are dropped — a missing/garbage field becomes []. Never throws. */
function asWeeks(v: unknown): Array<[number, number]> {
  if (!Array.isArray(v)) return [];
  const out: Array<[number, number]> = [];
  for (const p of v) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const w = Number(p[0]);
    const n = Number(p[1]);
    if (!Number.isFinite(w) || !Number.isFinite(n)) continue;
    if (w < 1 || w > 53) continue;
    out.push([w, n]);
  }
  return out;
}

/** Coerce the untrusted JSON (a hand-symlinked file on the Pi, or a stale build)
 *  into the CatalogSpecies shape, dropping anything that isn't a usable row so
 *  the view never sees a malformed entry. */
function normalize(raw: unknown): CatalogSpecies[] {
  if (!Array.isArray(raw)) return [];
  const out: CatalogSpecies[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const sci_name = asString(item.sci_name);
    const com_name = asString(item.com_name);
    if (!sci_name && !com_name) continue; // no name at all → not a species
    // Preserve the accession tri-state: key absent (undefined) = pre-pin build,
    // key present but not a number = null (heard, not yet accessioned).
    let accession: number | null | undefined = undefined;
    if (Object.prototype.hasOwnProperty.call(item, 'accession')) {
      accession = typeof item.accession === 'number' ? item.accession : null;
    }
    out.push({
      sci_name,
      com_name,
      slug: asString(item.slug),
      first_confident: asNullableString(item.first_confident),
      last_detected: asNullableString(item.last_detected),
      detection_count:
        typeof item.detection_count === 'number' ? item.detection_count : Number(item.detection_count) || 0,
      art_status: asString(item.art_status) || 'none',
      // Unknown degrades to '' so the caption falls back to the WEAKER claim —
      // never assert 'this station painted it' on a field we could not read.
      art_source: asString(item.art_source),
      accession,
      weeks: asWeeks(item.weeks),
    });
  }
  return out;
}

/** All-time life list. Never throws — see the file header. */
export async function fetchCatalog(): Promise<CatalogSpecies[]> {
  // An EXPLICIT VITE_CATALOG_URL wins even under MOCK. It used to be discarded
  // here, which made the incantation this repo documents at
  // tests/jardine.test.ts a no-op: `VITE_CATALOG_URL=/dev/species-london.json
  // npm run dev` kept VITE_MOCK=1 and quietly served the 8-row NEARCTIC
  // public/species.json instead — a set with ZERO intersection with the 51
  // Jardine species, so the Library degraded to a tab that looks deliberate:
  // desk silent, Index of Silences and Blind Ear unmounted, 0 of 40 spines lit,
  // every Roll row reading "the library is silent."
  //
  // The defect was never that nobody could look. It was that the repo's own
  // written cure did nothing, so anyone who followed it saw the degraded tab and
  // had no way to tell it from the real one.
  //
  // `!import.meta.env.VITE_CATALOG_URL` and not a comparison, because of the
  // empty case: CATALOG_URL uses ??, so `VITE_CATALOG_URL=` yields '', and
  // fetch('') resolves to the page itself → index.html → a parse failure → [].
  // Treating empty as unset keeps a stray blank var from blanking the catalog.
  return (await fetchCatalogOrNull()) ?? [];
}

/** TTL MEMO, NOT A SESSION MEMO — and the difference is the wall.
 *
 *  species.json was fetched fresh, with `cache: 'no-store'`, by every caller
 *  that wanted it: App, StatsView, LibraryView, LibraryFrameView,
 *  CollectionWallView, fetchArtStatus, and BirdPopup on EVERY popup open and
 *  every change of bird. Browsing wall → library → stats and opening three
 *  birds re-downloaded the same ~250-entry file six or more times, and
 *  no-store means not even a 304 — the whole body, each time.
 *
 *  jardine.ts:968/998 memoize their fetches for the whole session, and copying
 *  that here would be wrong: jardine.json is a static build artifact, while
 *  species.json is rebuilt every night by catalog.service. The frame runs for
 *  DAYS on one page load (?frame=1, kiosk), so a session memo would pin the
 *  wall to the catalog it booted with and it would quietly stop learning new
 *  species — trading six redundant fetches for a museum that stops growing.
 *
 *  60s collapses the boot storm and makes a popup open free, while a day-long
 *  kiosk still picks up the nightly rebuild within a minute of asking. */
const CATALOG_TTL_MS = 60_000;
let catalogHit: { at: number; p: Promise<CatalogSpecies[] | null> } | null = null;

/** THE SAME FETCH, BUT IT CAN SAY "I DON'T KNOW".
 *
 *  fetchCatalog() collapses a 404, a network error, a parse failure and a
 *  genuinely empty file to the same `[]`. Callers then wrote `catalog !== null`
 *  meaning "the ledger arrived" — a test that can NEVER be false, because the
 *  function never resolves to null. So on the day the nightly does not publish,
 *  the museum does not go quiet: it prints measured zeroes. "0 of 0 species have
 *  a page." "never heard in this garden." Confident, and wrong.
 *
 *  null means the ledger could not be read. [] means it was read and is empty —
 *  a real state for a station on its first night. A caller that cannot tell them
 *  apart must not assert anything about the garden. */
export async function fetchCatalogOrNull(): Promise<CatalogSpecies[] | null> {
  const now = Date.now();
  if (catalogHit && now - catalogHit.at < CATALOG_TTL_MS) return catalogHit.p;

  const url = MOCK && !import.meta.env.VITE_CATALOG_URL ? MOCK_CATALOG_URL : CATALOG_URL;
  const p = (async () => {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return null;
      // Caddy's php try_files answers 200 text/html for any missing path under
      // /collage/, so an OK status proves nothing. A body that is not an array is
      // not an empty catalog — it is a failure wearing a 200.
      const raw = (await res.json()) as unknown;
      if (!Array.isArray(raw)) return null;
      return normalize(raw);
    } catch {
      return null;
    }
  })();

  catalogHit = { at: now, p };
  // NEVER CACHE A FAILURE. null means "the ledger could not be read", and
  // holding that for a minute would turn one dropped request into a minute of
  // a museum printing measured zeroes — exactly the confident-and-wrong state
  // this function's whole docstring exists to prevent. Successes are cacheable
  // because a species.json that parsed is true until the next nightly; a failure
  // is not a fact about the catalog, it is a fact about one request.
  void p.then((v) => {
    if (v === null && catalogHit?.p === p) catalogHit = null;
  });
  return p;
}

/** Session-memoized slug → art_status map. Honesty contract: the map is used
 *  ONLY to skip a redundant readiness probe (the <img> still shows exactly what
 *  cutout.php serves); a missing/failed map means every species keeps the probe
 *  path — degrade to current behavior, never fabricate. Stale-direction is
 *  safe: art never gets deleted in normal operation, and a species newly heard
 *  today is simply absent from the map → probes → correct. */
let artStatusPromise: Promise<Map<string, string>> | null = null;

export function fetchArtStatus(): Promise<Map<string, string>> {
  if (!artStatusPromise) {
    artStatusPromise = fetchCatalog().then((list) => {
      if (list.length === 0) artStatusPromise = null; // unreachable catalog: retry on next mount
      const m = new Map<string, string>();
      for (const s of list) if (s.slug) m.set(s.slug, s.art_status);
      return m;
    });
  }
  return artStatusPromise;
}

/** CATALOGUE ORDER — earliest first_confident first, UNDATED LAST, ties broken
 *  by common name.
 *
 *  The wall's heading says "in order of first appearance", and that sentence is
 *  only true because of the three-branch null dance below. Collapse it to one
 *  comparison — `(a.first_confident ?? '') < (b.first_confident ?? '')`, the
 *  tidy it visibly invites — and an empty string sorts BEFORE every real date,
 *  so a wall titled "in order of first appearance" opens with precisely the
 *  birds whose first appearance is unknown. Nothing caught that, because the
 *  comparator lived inside a .tsx and no test could reach it.
 *
 *  Undated last is not a preference. A bird with no first_confident has no
 *  place in that order at all, and the end is the only honest place to put it. */
export function catalogOrder(a: CatalogSpecies, b: CatalogSpecies): number {
  const af = a.first_confident;
  const bf = b.first_confident;
  if (af && bf) {
    if (af !== bf) return af < bf ? -1 : 1;
  } else if (af) {
    return -1;
  } else if (bf) {
    return 1;
  }
  return (a.com_name || a.sci_name).localeCompare(b.com_name || b.sci_name);
}
