// Initial collage snapshot. Real mode reuses the UNCHANGED legacy PHP API
// (`action=recent&hours=24`); mock mode returns a bundled snapshot. When
// `PROFILE.debugN` is set (`?n=`), the roster is deterministically pinned to N
// rows so the acceptance harness can drive ?n=0|1|12|80 with no backend.

import type { SpeciesRow } from './types';
import { API_BASE, MOCK, SNAPSHOT_HOURS } from './config';
import { mockSnapshot } from './mockData';
import { PROFILE } from './profile';

interface RecentResponse {
  hours?: number;
  species?: Array<{ sci: string; com: string; n: number | string }>;
  as_of?: string;
}

export async function fetchSnapshot(hours: number = SNAPSHOT_HOURS): Promise<SpeciesRow[]> {
  if (MOCK) return withDebugRoster(mockSnapshot());

  const url = `${API_BASE}/birdnet-api.php?action=recent&hours=${hours}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`snapshot ${res.status}`);
  const json = (await res.json()) as RecentResponse;
  const species = json.species ?? [];
  return withDebugRoster(
    species.map((s) => ({
      sci: s.sci,
      com: s.com,
      n: Number(s.n) || 1,
    })),
  );
}

/** Geometric per-lap count falloff so synthesized repeats read as a long tail. */
const DEBUG_DECAY = 0.6;

/** Pin the snapshot roster to exactly `PROFILE.debugN` rows when set, so the
 *  acceptance harness can drive ?n=0|1|12|80 with no backend. Absent ⇒ the real
 *  snapshot passes through untouched. */
function withDebugRoster(rows: SpeciesRow[]): SpeciesRow[] {
  return PROFILE.debugN === null ? rows : coerceRosterToN(rows, PROFILE.debugN);
}

/** Deterministically resize `rows` to exactly `n`: slice when longer (or empty),
 *  cycle the base rows with geometrically-decaying counts when shorter. */
function coerceRosterToN(rows: SpeciesRow[], n: number): SpeciesRow[] {
  if (rows.length === 0 || n <= rows.length) return rows.slice(0, n);
  const out = rows.slice();
  for (let i = rows.length; i < n; i++) {
    const base = rows[i % rows.length];
    const lap = Math.floor(i / rows.length); // ≥1 in this branch
    const decayed = Math.max(1, Math.round(base.n * Math.pow(DEBUG_DECAY, lap)));
    out.push({ sci: base.sci, com: base.com, n: decayed });
  }
  return out;
}
