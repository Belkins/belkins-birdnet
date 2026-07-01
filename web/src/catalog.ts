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
    out.push({
      sci_name,
      com_name,
      slug: asString(item.slug),
      first_confident: asNullableString(item.first_confident),
      last_detected: asNullableString(item.last_detected),
      detection_count:
        typeof item.detection_count === 'number' ? item.detection_count : Number(item.detection_count) || 0,
      art_status: asString(item.art_status) || 'none',
    });
  }
  return out;
}

/** All-time life list. Never throws — see the file header. */
export async function fetchCatalog(): Promise<CatalogSpecies[]> {
  const url = MOCK ? MOCK_CATALOG_URL : CATALOG_URL;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return [];
    return normalize((await res.json()) as unknown);
  } catch {
    return [];
  }
}
