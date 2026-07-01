// Derive the honest live-counter figures from the roster: distinct species and
// total calls in the current window. The painting may be filled with ambient
// birds (§6.5), but these two numbers count only what was really heard.
import type { RosterRow } from './types';

export function counterFrom(
  rows: RosterRow[],
  windowLabel: string,
): { species: number; calls: number; windowLabel: string } {
  return {
    species: rows.length,
    calls: rows.reduce((a, r) => a + r.n, 0),
    windowLabel,
  };
}
