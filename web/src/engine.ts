// The Engine easter egg — the station's one honest non-bird.
//
// BirdNET's classifier ships a handful of non-bird classes; over this London
// garden exactly one of them fires: "Engine" — aircraft sliding overhead.
// The catalog marks it is_bird=0, cutout.php refuses to paint it (400), and
// the Railway pipeline must never spend a generation on it (its one recorded
// attempt hallucinated a house sparrow). So instead of the anonymous grey
// bird silhouette the museum hangs a small aeroplane plate of its own —
// bundled, deterministic, free.
import planeUrl from './assets/engine-plane.svg';

/** The catalog slug BirdNET's "Engine" class resolves to (slugify('Engine')). */
export const ENGINE_SLUG = 'engine';

export function isEngine(slug: string): boolean {
  return slug === ENGINE_SLUG;
}

/** Bundled aeroplane art. One file for either pose — a plane has one pose. */
export const ENGINE_ART_URL: string = planeUrl;

/** width/height of the bundled plane art (200×100 with ~2:1 ink coverage);
 *  data.ts aspect() serves this so the collage tile box matches the art. */
export const ENGINE_ASPECT = 2.0;

/** The dossier's account — wiki.php?sci=Engine would fetch the Wikipedia
 *  article on combustion engines, so the museum writes its own label. */
export const ENGINE_DESC =
  'Not a bird at all: an aircraft, sliding over the garden low enough for the ' +
  'station to file its drone alongside the wrens. The ear is honest, so the ' +
  'ledger keeps it — and the museum hangs a small aeroplane where the portrait ' +
  'would go.';
