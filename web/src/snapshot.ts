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
  /** Echo of the requested `on=` day — the scrubber's feature-detection token. */
  on?: string;
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

/** One real past local day (the time-travel scrubber). 'unsupported' = the
 *  API can't do days — a 4xx, or a response whose `on` echo doesn't match
 *  (an OLD Pi ignores unknown params and would return the LIVE window; the
 *  echo check is the honesty firewall that keeps live data from ever being
 *  presented as an archive day). 'error' = a transient failure (network, 5xx)
 *  on an API that may well be capable — the caller must NOT conclude the
 *  feature is absent. Both degrade to silence, differently. */
export async function fetchDaySnapshot(
  day: string,
): Promise<SpeciesRow[] | 'unsupported' | 'error'> {
  if (MOCK) return withDebugRoster(mockSnapshot());
  try {
    const url = `${API_BASE}/birdnet-api.php?action=recent&on=${encodeURIComponent(day)}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return res.status >= 500 ? 'error' : 'unsupported';
    const json = (await res.json()) as RecentResponse;
    if (json.on !== day) return 'unsupported'; // old API ignored on= — refuse the live data
    return withDebugRoster(
      (json.species ?? []).map((s) => ({ sci: s.sci, com: s.com, n: Number(s.n) || 1 })),
    );
  } catch {
    return 'error';
  }
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
