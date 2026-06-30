// Single source of truth for a bird's image URL — used by the collage engine
// and the Index / Atlas views so they never drift.
//
// REAL: cutout.php resolves a fallback chain (bundled kachō-e illustration →
// photo cutout → dynamic cache → Railway auto-gen). Built from the SCIENTIFIC
// name. pose=1 perched (default), pose=2 flight.
// MOCK: a bundled public/mock/<slug>.png, but only for species that ship one.

import { API_BASE, BASE, MOCK } from './config';
import { MOCK_SPECIES } from './mockData';
import { slugify } from './data';

const MOCK_ASSET_SLUGS = new Set(
  MOCK_SPECIES.filter((s) => s.hasAsset).map((s) => slugify(s.sci)),
);

export function birdImageUrl(slug: string, sci: string, pose: 1 | 2 = 1): string | null {
  if (MOCK) return MOCK_ASSET_SLUGS.has(slug) ? `${BASE}mock/${slug}.png` : null;
  return `${API_BASE}/cutout.php?sci=${encodeURIComponent(sci)}&pose=${pose}`;
}
