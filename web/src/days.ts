// Day-activity strip for the time-travel scrubber. Real mode reads the
// existing `timeseries` action (real per-day totals — the catalog's
// species.json has no per-day data); mock synthesizes a fortnight so
// dev:mock can drive the UI. Failure collapses to [] and the scrubber
// never renders — degrade to silence, never fabricate.

import { API_BASE, MOCK } from './config';

export interface DayActivity {
  /** 'YYYY-MM-DD' (Pi-local calendar day). */
  date: string;
  detections: number;
  species: number;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Per-day activity, zero-filled and ascending; last entry = today. */
export async function fetchDayActivity(days = 366): Promise<DayActivity[]> {
  if (MOCK) return zeroFill(mockDays());
  try {
    const res = await fetch(`${API_BASE}/birdnet-api.php?action=timeseries&days=${days}`, {
      cache: 'no-store',
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { daily?: unknown };
    const daily = Array.isArray(json?.daily) ? json.daily : [];
    const rows: DayActivity[] = [];
    for (const item of daily) {
      const r = item as { date?: unknown; detections?: unknown; species?: unknown };
      if (typeof r.date !== 'string' || !DAY_RE.test(r.date)) continue;
      const n = Number(r.detections);
      if (!Number.isFinite(n) || n < 0) continue;
      rows.push({ date: r.date, detections: n, species: Number(r.species) || 0 });
    }
    return zeroFill(rows);
  } catch {
    return [];
  }
}

/** Fill missing dates (the SQL GROUP BY drops empty days) from the first
 *  active day through today, so the ruler is linear in time with honest
 *  zero-count (dimmed) days. */
function zeroFill(rows: DayActivity[]): DayActivity[] {
  if (!rows.length) return [];
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const first = [...byDate.keys()].sort()[0];
  const today = isoDay(new Date());
  if (first > today) return []; // clock skew — refuse to fabricate a timeline
  const out: DayActivity[] = [];
  const cur = new Date(`${first}T12:00:00`); // local noon dodges DST edges
  // Bound matches the server's 3660-day timeseries clamp — never runs away.
  for (let day = first; day <= today && out.length <= 3660; ) {
    out.push(byDate.get(day) ?? { date: day, detections: 0, species: 0 });
    cur.setDate(cur.getDate() + 1);
    day = isoDay(cur);
  }
  return out;
}

/** Local calendar day → 'YYYY-MM-DD' (client clock). */
export function isoDay(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** '2026-06-14' → '14 June 2026' (parsed at local noon to dodge TZ edges). */
export function formatDay(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** Deterministic last-14-days ridge (two honest zero days) for dev:mock. */
function mockDays(): DayActivity[] {
  const out: DayActivity[] = [];
  const now = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 12);
    const n = i === 4 || i === 9 ? 0 : Math.round(8 + 22 * Math.abs(Math.sin((i + 1) * 1.7)));
    out.push({ date: isoDay(d), detections: n, species: n ? Math.max(1, Math.round(n / 4)) : 0 });
  }
  return out;
}
