// THE LAB's station-console fetchers - the archive query, the rhythm matrix,
// and the birdnet-status admin surface. Every reader here keeps the honesty
// firewall: a failed fetch throws (the panel renders the reason, never a
// fabricated table), echoed filter values come from the RESPONSE so the UI
// describes the slice the server actually applied, and nothing retries in a
// loop. MOCK builds short-circuit with a typed error so the demo says "no
// station" instead of pretending.
import { API_BASE, MOCK } from '../config';
import { isoDay } from '../days';

// ── archive (birdnet-api.php?action=archive) ────────────────────────────────
export interface ArchiveRow {
  d: string;
  t: string;
  sci: string;
  com: string;
  conf: number;
  file: string;
}
export interface ArchivePage {
  rows: ArchiveRow[];
  total: number;
  from: string | null;
  to: string | null;
  sci: string | null;
  min_conf: number;
  limit: number;
  offset: number;
  as_of: string;
}

export interface ArchiveQuery {
  from?: string;
  to?: string;
  sci?: string;
  minConf?: number;
  limit?: number;
  offset?: number;
}

/** Raised for the MOCK build and auth walls so panels can word it honestly. */
export class StationUnavailable extends Error {
  readonly kind: 'mock' | 'locked';
  constructor(kind: 'mock' | 'locked') {
    super(kind === 'mock' ? 'mock build - no station behind this page' : 'station gate is up');
    this.kind = kind;
  }
}

async function getJson<T>(url: string): Promise<T> {
  if (MOCK) throw new StationUnavailable('mock');
  const res = await fetch(url, { cache: 'no-store' });
  if (res.status === 401) throw new StationUnavailable('locked');
  if (!res.ok) {
    // The API writes its refusal reason into the body ({error: 'from= after
    // to='}); surface it instead of a bare status code.
    let msg = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body?.error === 'string') msg = `${msg} - ${body.error}`;
    } catch {
      /* not JSON - the status alone is the truth we have */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export function fetchArchive(q: ArchiveQuery): Promise<ArchivePage> {
  const p = new URLSearchParams({ action: 'archive' });
  if (q.from) p.set('from', q.from);
  if (q.to) p.set('to', q.to);
  if (q.sci) p.set('sci', q.sci);
  if (q.minConf) p.set('min_conf', String(q.minConf));
  if (q.limit) p.set('limit', String(q.limit));
  if (q.offset) p.set('offset', String(q.offset));
  return getJson<ArchivePage>(`${API_BASE}/birdnet-api.php?${p}`);
}

export function recordingUrl(file: string): string {
  return `${API_BASE}/recording.php?file=${encodeURIComponent(file)}`;
}
export function spectrogramUrl(file: string): string {
  return `${API_BASE}/spectrogram.php?file=${encodeURIComponent(file)}`;
}

// ── activity (birdnet-api.php?action=activity) ──────────────────────────────
export interface ActivityCell {
  date: string;
  hour: number;
  n: number;
}
export interface Activity {
  days: number;
  sci: string | null;
  today: string;
  cells: ActivityCell[];
  as_of: string;
}

export function fetchActivity(days: number): Promise<Activity> {
  return getJson<Activity>(`${API_BASE}/birdnet-api.php?action=activity&days=${days}`);
}

export interface ActivityGrid {
  /** Dates ascending, oldest first; every day in the window, zero-backfilled. */
  dates: string[];
  /** counts[dateIndex][hour 0..23] */
  counts: number[][];
  max: number;
  total: number;
}

/** Build the dense day x hour grid from the sparse server cells, anchored on
 *  the SERVER's `today` (the clock that wrote the Date column - the browser's
 *  day may differ near midnight). Steps at local noon to dodge DST edges,
 *  the same idiom as days.ts zeroFill. Rejects cells outside the window or
 *  with nonsense hours rather than silently mis-plotting them. */
export function buildActivityGrid(a: Pick<Activity, 'days' | 'today' | 'cells'>): ActivityGrid {
  const days = Math.max(1, Math.min(366, a.days));
  const dates: string[] = [];
  const cur = new Date(`${a.today}T12:00:00`);
  cur.setDate(cur.getDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    dates.push(isoDay(cur));
    cur.setDate(cur.getDate() + 1);
  }
  const index = new Map(dates.map((d, i) => [d, i]));
  const counts = dates.map(() => new Array<number>(24).fill(0));
  let max = 0;
  let total = 0;
  for (const c of a.cells) {
    const di = index.get(c.date);
    if (di === undefined || !Number.isInteger(c.hour) || c.hour < 0 || c.hour > 23) continue;
    const n = Number(c.n);
    if (!Number.isFinite(n) || n <= 0) continue;
    counts[di][c.hour] = n;
    if (n > max) max = n;
    total += n;
  }
  return { dates, counts, max, total };
}

/** Sequential ramp for the heatmap - single blue hue off --lab-accent,
 *  monotonic in lightness (validated); 0 stays the panel surface so quiet
 *  hours read as quiet. Steps chosen from the fraction of the grid max. */
export const HEAT_RAMP = ['#24344f', '#35507c', '#5a82b8', '#8fb7ff'] as const;

export function heatColor(n: number, max: number): string | null {
  if (n <= 0 || max <= 0) return null;
  const f = n / max;
  if (f <= 0.25) return HEAT_RAMP[0];
  if (f <= 0.5) return HEAT_RAMP[1];
  if (f <= 0.75) return HEAT_RAMP[2];
  return HEAT_RAMP[3];
}

// ── station status (birdnet-status.php) ─────────────────────────────────────
export interface ServiceState {
  active: string;
  enabled: string;
  since: string | null;
}
export interface ServicesResponse {
  services: Record<string, ServiceState>;
  as_of: string;
}
export interface SystemResponse {
  uptime?: { seconds?: number; pretty?: string; load?: number[]; now?: string };
  mem?: { total_bytes?: number; used_bytes?: number; used_pct?: number };
  disk_root?: { path?: string; total_bytes?: number; free_bytes?: number; used_pct?: number; error?: string };
  disk_birds?: { path?: string; total_bytes?: number; free_bytes?: number; used_pct?: number; error?: string };
  temp_c?: number | null;
  stream_data?: { exists?: boolean; file_count?: number; newest_age_s?: number | null };
  birds_db?: { exists?: boolean; size_bytes?: number; modified_s?: number; mtime?: string };
  conf?: { readable?: boolean; values?: Record<string, string> };
  hostname?: string;
  kernel?: string;
  as_of?: string;
}
export interface LogsResponse {
  unit: string;
  lines: number;
  text: string;
}
export interface RestartResponse {
  unit: string;
  ok?: boolean;
  rc?: number;
  out?: string;
  /** Present instead of ok/rc/out on a 400 refusal (unit not allowed). */
  error?: string;
}

/** Units that carry this very page: restarting them aborts the in-flight
 *  response, so a dead fetch is the EXPECTED signature of success there. */
export const SELF_KILLING_UNITS = /^(caddy|php[\d.]+-fpm)$/;

const STATUS = `${API_BASE}/birdnet-status.php`;

export function fetchServices(): Promise<ServicesResponse> {
  return getJson<ServicesResponse>(`${STATUS}?action=services`);
}
export function fetchSystem(): Promise<SystemResponse> {
  return getJson<SystemResponse>(`${STATUS}?action=system`);
}
export function fetchLogs(unit: string, lines = 120): Promise<LogsResponse> {
  return getJson<LogsResponse>(
    `${STATUS}?action=logs&unit=${encodeURIComponent(unit)}&lines=${lines}`,
  );
}
export async function postRestart(unit: string): Promise<RestartResponse> {
  if (MOCK) throw new StationUnavailable('mock');
  const res = await fetch(`${STATUS}?action=restart&unit=${encodeURIComponent(unit)}`, {
    method: 'POST',
  });
  if (res.status === 401) throw new StationUnavailable('locked');
  if (!res.ok && res.status !== 400) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as RestartResponse;
}

// ── small honest formatters ─────────────────────────────────────────────────
export function fmtBytes(b: number): string {
  if (!Number.isFinite(b) || b < 0) return '?';
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(1)} kB`;
  return `${b} B`;
}
export function fmtAgo(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '?';
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${(s / 3600).toFixed(1)}h`;
  return `${Math.round(s / 86400)}d`;
}
