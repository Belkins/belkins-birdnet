// ALMANAC — pure, deterministic fact-extractors over the nightly catalog.
// Three functions, no fetches, no model calls: every sentence a consumer
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
function parseCatalogDate(iso: string | null): { y: number; m: number; d: number } | null {
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
