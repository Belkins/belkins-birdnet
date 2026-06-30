// Data for the Stats view: by-period totals, newest first-detections, and a
// 24-bucket by-hour series. Real mode hits the unchanged PHP API; mock mode
// synthesizes from the live roster so `dev:mock` is never blank.

import { API_BASE, MOCK } from './config';
import type { RosterRow } from './types';

export interface Period {
  detections: number;
  species: number;
}

export interface FirstSeen {
  sci: string;
  com: string;
}

export interface StatsData {
  now: Period; // last hour
  today: Period;
  week: Period;
  all: Period;
  firstSeen: FirstSeen[]; // newest lifers
  byHour: number[]; // 24 detection-count buckets (0..23h)
}

interface StatsResponse {
  totals?: { detections?: number; species?: number };
  today?: { detections?: number; species?: number };
  last_hour?: { detections?: number };
  week?: { detections?: number; species?: number };
}
interface FirstSeenResponse {
  species?: { sci: string; com: string }[];
}
interface TimeseriesResponse {
  by_hour?: { hour: number; detections: number }[];
}

async function getJson(action: string) {
  const res = await fetch(`${API_BASE}/birdnet-api.php?action=${action}`, {
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`${action} → ${res.status}`);
  return res.json();
}

export async function loadStats(roster: RosterRow[]): Promise<StatsData> {
  if (MOCK) return mockStats(roster);

  const [stats, first, ts] = await Promise.all([
    getJson('stats') as Promise<StatsResponse>,
    getJson('firstseen&limit=6') as Promise<FirstSeenResponse>,
    getJson('timeseries&days=1') as Promise<TimeseriesResponse>,
  ]);

  const byHour = new Array(24).fill(0) as number[];
  for (const b of ts.by_hour ?? []) {
    if (b.hour >= 0 && b.hour < 24) byHour[b.hour] = b.detections ?? 0;
  }

  return {
    now: { detections: stats.last_hour?.detections ?? 0, species: 0 },
    today: { detections: stats.today?.detections ?? 0, species: stats.today?.species ?? 0 },
    week: { detections: stats.week?.detections ?? 0, species: stats.week?.species ?? 0 },
    all: { detections: stats.totals?.detections ?? 0, species: stats.totals?.species ?? 0 },
    firstSeen: (first.species ?? []).map((s) => ({ sci: s.sci, com: s.com })),
    byHour,
  };
}

/** Deterministic dawn+dusk-chorus shape scaled to the live roster total. */
function mockStats(roster: RosterRow[]): StatsData {
  const detections = roster.reduce((a, r) => a + r.n, 0);
  const species = roster.length;
  const shape = Array.from({ length: 24 }, (_, h) => {
    const dawn = Math.exp(-((h - 6) ** 2) / 6);
    const dusk = Math.exp(-((h - 19) ** 2) / 8);
    return dawn + dusk * 0.8 + 0.05;
  });
  const sum = shape.reduce((a, v) => a + v, 0) || 1;
  const byHour = shape.map((v) => Math.round((v / sum) * detections));
  const newest = roster.filter((r) => r.isNew).slice(0, 6);
  const firstSeen = (newest.length ? newest : roster.slice(0, 3)).map((r) => ({
    sci: r.sci,
    com: r.com,
  }));
  return {
    now: { detections: Math.round(detections * 0.08), species: Math.min(species, 4) },
    today: { detections, species },
    week: { detections, species },
    all: { detections, species },
    firstSeen,
    byHour,
  };
}
