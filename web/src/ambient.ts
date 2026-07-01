// Never-barren ambient population + the honesty firewall (spec §6.5).
// At sparse N the canvas would read as barren, so we paint a low-opacity
// "cast that has visited" behind the composed, honest foreground. This module
// only DECIDES which species fill the void; placement/alpha lives in the engine.
//
// Honesty firewall: ambient birds are visually present but NEVER counted. We
// therefore always exclude any species already in the real (counted) roster so
// the same bird is never both a live tile and an ambient ghost — the number
// stays truthful, the painting fills the void.

import type { RosterRow, SpeciesRow } from './types';
import type { Settings } from './settings';

/** A single ambient bird: just enough identity to draw its silhouette/cutout. */
export interface AmbientSpecies {
  sci: string;
  com: string;
}

/** The legacy 12-bird fallback set the user already likes, ported verbatim from
 *  `avian/frontend/apt.js:2` (the offline sketch gallery). Used as the empty /
 *  offline fallback and as the explicit `Placeholder set` mode. */
export const PLACEHOLDER: AmbientSpecies[] = [
  { sci: 'Calypte anna', com: "Anna's Hummingbird" },
  { sci: 'Passer domesticus', com: 'House Sparrow' },
  { sci: 'Haemorhous mexicanus', com: 'House Finch' },
  { sci: 'Turdus migratorius', com: 'American Robin' },
  { sci: 'Zenaida macroura', com: 'Mourning Dove' },
  { sci: 'Spinus psaltria', com: 'Lesser Goldfinch' },
  { sci: 'Zonotrichia leucophrys', com: 'White-crowned Sparrow' },
  { sci: 'Aphelocoma californica', com: 'California Scrub-Jay' },
  { sci: 'Mimus polyglottos', com: 'Northern Mockingbird' },
  { sci: 'Sayornis nigricans', com: 'Black Phoebe' },
  { sci: 'Larus occidentalis', com: 'Western Gull' },
  { sci: 'Corvus brachyrhynchos', com: 'American Crow' },
];

/** Target TOTAL on-canvas population each density tier aims for — real species
 *  plus ambient ghosts combined (spec §4-C control 6). The ambient cast fills
 *  only the deficit below this target, so it recedes to nothing as real data
 *  grows in. */
const DENSITY_CAP: Record<Settings['density'], number> = {
  sparse: 8,
  balanced: 14,
  cozy: 20,
};

/** Decide the ambient backdrop cast for the current real roster + settings.
 *  Pure: no DOM, no fetch, no mutation of the inputs.
 *   - `off`         → [] (pure composed cold-start tiers, no backdrop).
 *   - `placeholder` → the fixed 12-bird PLACEHOLDER set.
 *   - `roster`      → the all-time life list, TOPPED UP with PLACEHOLDER to fill.
 *  In every non-off mode, species already present in `realRoster` are excluded
 *  (case-insensitive sci match — the honesty firewall) and the result is capped
 *  to the density tier's TARGET TOTAL minus the real roster — i.e. ambient fills
 *  only the deficit, receding to [] once real species reach the target. A young
 *  install (little/no history) still reads full, never barren, because the
 *  placeholder cast backfills the empty space. */
export function ambientRoster(opts: {
  realRoster: RosterRow[];
  allTime: SpeciesRow[];
  mode: Settings['ambientFill'];
  density: Settings['density'];
}): AmbientSpecies[] {
  const { realRoster, allTime, mode, density } = opts;

  if (mode === 'off') return [];

  // Density is now a TARGET TOTAL population, not an additive ghost count. As
  // real detections grow the ambient deficit shrinks to zero — so at 5-13 real
  // species the backdrop all but disappears and cannot collide with the real
  // birds. A young/empty install still fills to the target.
  const cap = Math.max(0, DENSITY_CAP[density] - realRoster.length);
  if (cap === 0) return [];
  // Honesty firewall: never echo a species the live counter is already counting
  // (seed with the counted set, then dedupe as we fill).
  const seen = new Set(realRoster.map((r) => r.sci.toLowerCase()));
  const out: AmbientSpecies[] = [];
  const add = (b: AmbientSpecies): void => {
    const k = b.sci.toLowerCase();
    if (seen.has(k) || out.length >= cap) return;
    seen.add(k);
    out.push(b);
  };

  // `roster` prefers the real all-time life list; `placeholder` skips it. Then
  // BOTH modes top up from the legacy placeholder cast so the backdrop stays
  // full even when history is thin — capped to the density tier throughout.
  if (mode === 'roster') for (const s of allTime) add({ sci: s.sci, com: s.com });
  for (const b of PLACEHOLDER) add(b);

  return out;
}
