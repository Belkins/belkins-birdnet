// WHAT TO CALL THE WINDOW THE NUMBERS WERE COUNTED OVER.
//
// Every count in this museum is counted over a window, and every label above
// those counts is a CLAIM about which window that was. Two of them were false.
//
// · `windowLabelFor(hours)` in App.tsx ended `?? PERIODS[2]`, and PERIODS[2] is
//   `{ label: '24H', hours: 24 }`. The Display Profile accepts `?win=` with any
//   positive number (profile.ts: `if (Number.isFinite(w) && w > 0)`), so
//   `?win=6` counted six hours and printed 24H — on the filter chip, and then
//   again as the headline, because IndexView falls back to that same label when
//   WINDOW_HEADLINE has no entry. A wall left on a custom window states the
//   wrong period twice and looks completely normal doing it.
// · The headline map was guarded by its KEYS: a test proved every preset had an
//   entry and never that the entry described that preset. 'Heard Today' over a
//   rolling 24-hour window — the exact defect a previous fix removed — could be
//   typed straight back in.
//
// So the naming is one total function over ANY window, in a .ts a test can
// call. There is no fallback to another window's name, because that is the bug:
// an unknown window gets a name derived from its own hours, and a name derived
// from its own hours cannot be wrong about which window it is.

export interface Period {
  label: string;
  hours: number;
}

/** The windows the filter offers. ALL is a sentinel, not a duration. */
export const ALL_TIME_HOURS = 1_000_000;

export const PERIODS: readonly Period[] = [
  { label: '1H', hours: 1 },
  { label: '12H', hours: 12 },
  { label: '24H', hours: 24 },
  { label: '7D', hours: 168 },
  { label: 'ALL', hours: ALL_TIME_HOURS },
];

/** Days, when the window divides into whole days and is at least two. */
function wholeDays(hours: number): number | null {
  if (hours < 48 || hours % 24 !== 0) return null;
  return hours / 24;
}

/** The short chip label — '24H', '7D', 'ALL', or the truth about a window that
 *  is none of those. Never another period's label. */
export function windowLabel(hours: number): string {
  const preset = PERIODS.find((p) => p.hours === hours);
  if (preset) return preset.label;
  if (!Number.isFinite(hours) || hours <= 0) return '—';
  const d = wholeDays(hours);
  if (d !== null) return `${d}D`;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}H`;
}

/** The sentence set over the counts. Same rule: derived from the window it
 *  describes, so it cannot name a different one. */
export function windowHeadline(hours: number): string {
  if (hours === ALL_TIME_HOURS) return 'All Time';
  if (!Number.isFinite(hours) || hours <= 0) return 'This Window';
  if (hours === 1) return 'This Hour';
  const d = wholeDays(hours);
  if (d !== null) return d === 7 ? 'These 7 Days' : `These ${d} Days`;
  const n = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  return `These ${n} Hours`;
}
