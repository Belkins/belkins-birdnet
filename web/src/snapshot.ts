// Initial collage snapshot. Real mode reuses the UNCHANGED legacy PHP API
// (`action=recent&hours=24`); mock mode returns a bundled snapshot.

import type { SpeciesRow } from './types';
import { API_BASE, MOCK, SNAPSHOT_HOURS } from './config';
import { mockSnapshot } from './mockData';

interface RecentResponse {
  hours?: number;
  species?: Array<{ sci: string; com: string; n: number | string }>;
  as_of?: string;
}

export async function fetchSnapshot(hours: number = SNAPSHOT_HOURS): Promise<SpeciesRow[]> {
  if (MOCK) return mockSnapshot();

  const url = `${API_BASE}/birdnet-api.php?action=recent&hours=${hours}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`snapshot ${res.status}`);
  const json = (await res.json()) as RecentResponse;
  const species = json.species ?? [];
  return species.map((s) => ({
    sci: s.sci,
    com: s.com,
    n: Number(s.n) || 1,
  }));
}
