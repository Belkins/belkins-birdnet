// ALMANAC — pure, deterministic fact-extractors over the nightly catalog.
// Four functions, no fetches, no model calls: every sentence a consumer
// renders is a template over real numbers/dates from CatalogSpecies, and each
// function returns null on thin data so the caller renders NOTHING (silence
// over speculation). Month-based on purpose — the frontend has no latitude
// sign, so naming a season would be a Southern-Hemisphere lie.

import type { CatalogSpecies } from './catalog';

const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Handles BOTH catalog date formats: prod 'YYYY-MM-DD HH:MM:SS' and the mock
 *  fixture's bare 'YYYY-MM-DD' — regex the leading date, never `new Date(iso)`
 *  (the space-separated prod form is not portable Date input). */
export function parseCatalogDate(iso: string | null): { y: number; m: number; d: number } | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return { y: +m[1], m: +m[2], d: +m[3] };
}

// ── ALMANAC — the Wall's month dateline ───────────────────────────────────────

export interface AlmanacFacts {
  monthName: string;
  count: number;
  /** the one species, only when count === 1 (the sole-first wording). */
  soleName: string | null;
}

/** How many of the collection were FIRST confidently heard in the current
 *  month (any year). null when none — the dateline stays silent. */
export function currentSeasonFacts(catalog: CatalogSpecies[], now: Date): AlmanacFacts | null {
  const mi = now.getMonth(); // 0-11
  let count = 0;
  let sole: string | null = null;
  for (const s of catalog) {
    const d = parseCatalogDate(s.first_confident);
    if (!d) continue;
    if (d.m - 1 === mi) {
      count++;
      sole = s.com_name || s.sci_name;
    }
  }
  if (count === 0) return null; // degrade to silence when nothing true to say
  return { monthName: MONTHS_LONG[mi], count, soleName: count === 1 ? sole : null };
}

// ── ANNIVERSARIES — "on this day" vitrine ─────────────────────────────────────

export interface Anniversary {
  com: string;
  sci: string;
  slug: string;
  yearsAgo: number;
  firstConfident: string;
}

/** The single species first confidently heard on this exact month-day in a
 *  PRIOR year — only when literally true; oldest wins, ties by common name.
 *  null the whole first year (and on Feb-29 firsts in non-leap years). */
export function anniversariesFor(catalog: CatalogSpecies[], date: Date): Anniversary | null {
  const ty = date.getFullYear();
  const tm = date.getMonth() + 1;
  const td = date.getDate();
  let best: Anniversary | null = null;
  for (const s of catalog) {
    if (!s.first_confident) continue;
    const d = parseCatalogDate(s.first_confident);
    if (!d) continue;
    if (d.m === tm && d.d === td && d.y < ty) {
      const yrs = ty - d.y;
      const com = s.com_name || s.sci_name;
      if (!best || yrs > best.yearsAgo || (yrs === best.yearsAgo && com < best.com)) {
        best = { com, sci: s.sci_name, slug: s.slug, yearsAgo: yrs, firstConfident: s.first_confident };
      }
    }
  }
  return best;
}

// ── PHENOLOGY — the dossier's 52-week presence strip ──────────────────────────

export interface Phenology {
  /** 52 cells, index 0 = ISO week 1; a cell is the real all-detection count. */
  cells: number[];
  maxWeek: number;
  weeksPresent: number;
}

/** A 52-cell presence strip from the widened species.weeks (sparse ISO-week
 *  pairs). Blank cells mean NOT HEARD — never interpolated. ISO week 53 folds
 *  into cell 52 (still a real count). null when there is nothing to show. */
export function phenologyWeeks(species: CatalogSpecies): Phenology | null {
  const weeks = species.weeks ?? [];
  if (weeks.length === 0) return null;
  const cells = new Array<number>(52).fill(0);
  for (const [w, n] of weeks) {
    if (n <= 0) continue;
    const idx = Math.min(52, Math.max(1, w)) - 1; // ISO week 53 folds into cell 52
    cells[idx] += n;
  }
  let max = 0;
  let present = 0;
  for (const c of cells) {
    if (c > 0) {
      present++;
      if (c > max) max = c;
    }
  }
  if (present === 0) return null; // blank = not heard; never interpolate
  return { cells, maxWeek: max, weeksPresent: present };
}

// ── DEPARTURES — the wall's one subtraction ───────────────────────────────────

/** Whole calendar days of silence before the wall will say a bird is gone.
 *  Below this it says NOTHING. The Pi listens 24/7, but a garden bird can go a
 *  week unheard through weather, wind, a moult, or simply being quiet, and
 *  calling that a departure is a claim the wall cannot take back. A fortnight
 *  of continuous listening is about the bird, not about the sampling. */
const GONE_DAYS = 14;

/** Past this a day count stops being legible and the absence is seasonal —
 *  switch to the same Month-Year register the "first seen" caption uses. */
const AWAY_DAYS = 60;

export interface Departure {
  /** Ready-to-render caption: "not heard in 21 days" / "not heard since Aug 2026". */
  text: string;
  /** 'quiet' = a fresh gap, 'away' = a seasonal absence. Drives one muted step
   *  of contrast only — the real signal is the change of sentence. */
  band: 'quiet' | 'away';
}

/** The only field this section reads. CatalogSpecies satisfies it structurally,
 *  so the Wall hands its catalog straight in and gets back a Map keyed by its
 *  OWN row objects — no slug key to collide when the catalog carries a blank or
 *  duplicated slug. */
interface Departable {
  last_detected: string | null;
}

/** Whole calendar days from a catalog stamp to `now`. BOTH sides are reduced to
 *  their local calendar day and differenced in UTC, so a DST shift can never
 *  bend the count by ±1 — a naive (now - then) / 86400000 over parsed local
 *  dates loses an hour every spring and silently reports 13 for a real 14, i.e.
 *  the caption blinks out at exactly the threshold. null when the stamp is
 *  missing or unparseable, and null when it is in the FUTURE: a Pi has no RTC,
 *  and a post-power-cut clock skew must render nothing, never "-3 days". */
function daysSince(iso: string | null, now: Date): number | null {
  const d = parseCatalogDate(iso);
  if (!d) return null;
  const then = Date.UTC(d.y, d.m - 1, d.d);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((today - then) / 86400000);
  return days < 0 ? null : days;
}

/** One species' caption, or null when the wall must stay silent: never heard,
 *  unparseable, clock skew, or heard inside the last GONE_DAYS. Always plural —
 *  the caption cannot exist below 14 days.
 *
 *  NOTE for the next maintainer: this returns null IDENTICALLY for "heard
 *  yesterday", "never heard", "corrupt stamp" and "clock ahead". Silence here is
 *  therefore NOT proof that the row is fine. The raw stamp is visible per
 *  species in the Lab's catalog table (src/lab/Lab.tsx, the `last_detected`
 *  column) — debug corruption there, not by staring at a quiet wall. */
function captionFor(lastDetected: string | null, now: Date): Departure | null {
  const days = daysSince(lastDetected, now);
  if (days === null || days < GONE_DAYS) return null;
  if (days < AWAY_DAYS) return { text: `not heard in ${days} days`, band: 'quiet' };
  const d = parseCatalogDate(lastDetected);
  if (!d) return null; // unreachable — daysSince already parsed it; never throw
  const mon = MONTHS_LONG[d.m - 1];
  return {
    text: mon ? `not heard since ${mon.slice(0, 3)} ${d.y}` : `not heard since ${d.y}`,
    band: 'away',
  };
}

/** Every departure caption the Wall may render, keyed by the caller's own row.
 *  Species with nothing true to say are simply absent from the Map.
 *
 *  THE FRESHNESS GATE, and why the whole feature is one function instead of a
 *  per-row helper: species.json carries NO build timestamp, so the Wall has
 *  exactly one clock (the browser's) and no way to know whether the catalog
 *  behind `last_detected` is from last night or last year. A dead
 *  catalog.service, a clobbered /collage/species.json symlink, or the committed
 *  8-species dev fixture served in its place would otherwise make this — the
 *  museum's first surface capable of a NEGATIVE claim about the garden —
 *  confidently narrate 47 departures that never happened, with a 200 all the
 *  way down and no error state anywhere.
 *
 *  So the catalog must first prove itself alive out of its own data: if the
 *  FRESHEST last_detected in the whole collection is itself older than
 *  GONE_DAYS, every caption is suppressed. The honest read of "nothing at all
 *  has been heard here for a fortnight" is a dead station or a dead build, never
 *  a simultaneous mass departure. Routing every caption through this one entry
 *  point is what makes the gate impossible to forget at a call site. */
export function departuresFor(catalog: Departable[], now: Date): Map<Departable, Departure> {
  const out = new Map<Departable, Departure>();
  let freshest: number | null = null;
  for (const s of catalog) {
    const d = daysSince(s.last_detected, now);
    if (d !== null && (freshest === null || d < freshest)) freshest = d;
  }
  // null = not one parseable stamp in the whole catalog (day zero, or a shape
  // change upstream). Both that and a wholesale-stale catalog stay silent.
  if (freshest === null || freshest >= GONE_DAYS) return out;
  for (const s of catalog) {
    const dep = captionFor(s.last_detected, now);
    if (dep) out.set(s, dep);
  }
  return out;
}

/** "6h ago" / "3d ago" from a BirdNET Date + Time pair. THE ONE relative-time
 *  helper in the tree. It lived in BirdPopup.tsx, which made that component file
 *  export a non-component — the file's only lint warning — and put a pure date
 *  function somewhere node --test cannot reach it. almanac.ts is where every
 *  other date derivation already lives.
 *
 *  (original doc) "6h ago" / "3d ago" from a BirdNET Date + Time pair. */
export function fmtRelative(d: string | null, t: string | null): string {
  if (!d) return '—';
  const date = new Date(`${d}T${t || '00:00:00'}`);
  if (Number.isNaN(date.getTime())) return `${d} ${t || ''}`.trim();
  const ago = Math.floor((Date.now() - date.getTime()) / 1000);
  if (ago < 60) return `${ago}s ago`;
  if (ago < 3600) return `${Math.floor(ago / 60)}m ago`;
  if (ago < 86400) return `${Math.floor(ago / 3600)}h ago`;
  return `${Math.floor(ago / 86400)}d ago`;
}
