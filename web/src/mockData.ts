// Self-contained mock data for VITE_MOCK=1 (no backend). Real species whose
// PNGs are bundled under public/mock/, plus ONE species deliberately lacking a
// mask + image to exercise the default-bbox fallback (long tail never dropped).

import type { BirdEvent, SpeciesRow } from './types';
import { slugify } from './data';

interface MockSpecies {
  sci: string;
  com: string;
  /** true => bundled PNG exists under /mock; false => placeholder + default mask. */
  hasAsset: boolean;
}

// 15 species with a bundled illustration AND a baked mask (nice nesting).
export const MOCK_SPECIES: MockSpecies[] = [
  { sci: 'Turdus migratorius', com: 'American Robin', hasAsset: true },
  { sci: 'Zenaida macroura', com: 'Mourning Dove', hasAsset: true },
  { sci: 'Spinus tristis', com: 'American Goldfinch', hasAsset: true },
  { sci: 'Bombycilla cedrorum', com: 'Cedar Waxwing', hasAsset: true },
  { sci: 'Dryobates pubescens', com: 'Downy Woodpecker', hasAsset: true },
  { sci: 'Corvus brachyrhynchos', com: 'American Crow', hasAsset: true },
  { sci: 'Haemorhous mexicanus', com: 'House Finch', hasAsset: true },
  { sci: 'Melospiza melodia', com: 'Song Sparrow', hasAsset: true },
  { sci: 'Agelaius phoeniceus', com: 'Red-winged Blackbird', hasAsset: true },
  { sci: 'Sturnus vulgaris', com: 'European Starling', hasAsset: true },
  { sci: 'Aix sponsa', com: 'Wood Duck', hasAsset: true },
  { sci: 'Anas platyrhynchos', com: 'Mallard', hasAsset: true },
  { sci: 'Aquila chrysaetos', com: 'Golden Eagle', hasAsset: true },
  { sci: 'Accipiter cooperii', com: "Cooper's Hawk", hasAsset: true },
  { sci: 'Archilochus alexandri', com: 'Black-chinned Hummingbird', hasAsset: true },
  // No mask, no PNG: proves the default-bbox fallback + placeholder render.
  { sci: 'Catharus guttatus', com: 'Hermit Thrush', hasAsset: false },
];

/** Bundled initial snapshot for mock mode (species-collapsed, with counts). */
export function mockSnapshot(): SpeciesRow[] {
  // Deterministic-ish counts so the seed collage looks like a real plate.
  const counts = [142, 88, 61, 47, 39, 33, 28, 24, 19, 15, 12, 9, 6, 4, 2, 3];
  return MOCK_SPECIES.map((s, i) => ({
    sci: s.sci,
    com: s.com,
    n: counts[i] ?? 1,
  }));
}

/** Synthesize a `bird.detected` frame for the i-th mock species. */
export function mockBirdEvent(index: number, cursor: number): BirdEvent {
  const s = MOCK_SPECIES[index % MOCK_SPECIES.length];
  const conf = 0.7 + Math.random() * 0.29;
  const now = new Date();
  const iso = now.toISOString();
  return {
    v: 1,
    type: 'bird.detected',
    cursor,
    sci: s.sci,
    com: s.com,
    slug: slugify(s.sci),
    conf: Math.round(conf * 100) / 100,
    conf_pct: Math.round(conf * 100),
    iso8601: iso,
    date: iso.slice(0, 10),
    time: iso.slice(11, 19),
    week: 27,
    file: `${s.com.replace(/\s+/g, '_')}-${Math.round(conf * 100)}-mock.mp3`,
  };
}
