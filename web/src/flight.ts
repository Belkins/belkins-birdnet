// Collage flight-pose variety for Railway species.
//
// These birds have a verified real, distinct flight render (cutout
// X-Av-Real=1) but no bundled flight silhouette/dims, so the collage would
// otherwise only ever show them perched. We mix in their flight pose at
// FLY_PROB, using a MEASURED per-species flight aspect: the renderer stretches
// the image to the tile box, so an accurate box aspect keeps the wings-spread
// art from being distorted.
//
// This mirrors the legacy apt.js HAS_FLIGHT/FLY_PROB change. It is
// hand-maintained for now — a species heard later stays perched until added
// here. The durable home is rebuild_catalog.py emitting a has_flight + flight
// aspect into the roster so this isn't a bundled constant.
//
// Probed 2026-07-01 via cutout.php?sci=<sci>&pose=2 (X-Av-Real=1) + sips.

/** Chance a flight-capable bird shows in its flight pose (calm minority). */
export const FLY_PROB = 0.25;

/** Measured flight-image aspect (width / height). The tile box uses this so the
 *  flight art fills its box without being squished or stretched. */
export const FLIGHT_ASPECT: Record<string, number> = {
  // robin re-measured 2026-08-05 after the belly rekey (plate now 1042x625);
  // the 1.28 here was probed 07-01 against a plate two generations gone.
  'erithacus-rubecula': 1.67,
  // parakeet flight re-rolled 2026-08-24 (the old "flight" plate was a perched
  // copy that measured square); the real wings-spread plate is 759×700.
  'psittacula-krameri': 1.08,
  'cyanistes-caeruleus': 1.2,
  'carduelis-carduelis': 1.82,
  'apus-apus': 1.79,
  'anthus-trivialis': 1.49,
  'corvus-monedula': 1.41,
  'parus-major': 1.11,
  'turdus-philomelos': 1.36,
  'corvus-frugilegus': 1.37,
  'pica-pica': 1.03,
  'turdus-merula': 1.32,
  'charadrius-dubius': 1.16,
  'haematopus-ostralegus': 1.58,
  'chloris-chloris': 1.39,
  // measured 2026-08-07 after their plates were made whole: the tit's flight
  // plate is a REAL render now (was a byte-copy of perched), the heron's
  // neck survives the per-species key tol.
  'aegithalos-caudatus': 1.09,
  'ardea-cinerea': 1.12,
  // measured 2026-08-07 after the rekey batch made their flight plates whole.
  'troglodytes-troglodytes': 1.68,
  'buteo-buteo': 1.01,
  'motacilla-alba': 2.06,
};

/** A bird can fly in the collage iff we have a measured flight aspect for it
 *  (which is only set for species with a verified real flight render). */
export function canFly(slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(FLIGHT_ASPECT, slug);
}

/** Roll a pose for a fresh render: flight (2) at FLY_PROB for flight-capable
 *  birds, perched (1) otherwise. Rerolls every seed (i.e. every reload). */
export function rollPose(slug: string): 1 | 2 {
  return canFly(slug) && Math.random() < FLY_PROB ? 2 : 1;
}
