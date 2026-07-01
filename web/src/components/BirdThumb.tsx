// BIRD THUMB — the shared image well used by the Atlas plates, the Collection
// Wall and elsewhere. Four phases so a missing or still-generating illustration
// never shows a broken <img> nor a flat grey disc:
//
//   loading  →  gentle shimmer sweep       (first readiness probe in flight)
//   ready    →  the kachō-e illustration
//   pending  →  a "painting" loader — the species is heard but its plate is
//               still being generated on Railway; auto-swaps to art when ready
//   none     →  a quiet bird SILHOUETTE    (probe failed / gen genuinely stuck)
//
// Readiness comes from useBirdImage, which reads cutout.php's X-Av-Real header;
// the client only bridges the gap while a newly-heard species is being painted.
import { birdImageUrl } from '../img';
import { useBirdImage } from '../useBirdImage';

// The fallback specimen mark: a quiet bird silhouette for a species with no
// bundled illustration (or one that failed to load). Deliberately NOT a letter
// monogram — the common name already sits beneath the plate.
function BirdSilhouette() {
  return (
    <span className="acard-sil" aria-hidden="true">
      <svg viewBox="0 0 84 60" fill="currentColor" role="img">
        <path d="M8 22 L30 31 L21 44 Z" />
        <ellipse cx="45" cy="34" rx="22" ry="16" />
        <circle cx="61" cy="21" r="12" />
        <path d="M71 15 L84 13 L72 25 Z" />
      </svg>
    </span>
  );
}

export function BirdThumb({
  slug,
  sci,
  com,
  feature,
}: {
  slug: string;
  sci: string;
  com: string;
  feature?: boolean;
}) {
  const url = birdImageUrl(slug, sci);
  const { phase, src } = useBirdImage(url);
  const well = feature ? 'acard-img feat' : 'acard-img';

  if (phase === 'ready' && src) {
    return (
      <div className={well}>
        <img src={src} alt={com || sci} />
      </div>
    );
  }
  if (phase === 'pending') {
    // A heard-but-not-yet-painted species: the breathing ink silhouette under a
    // warm sweep + a caption reads as "developing", never as "missing".
    return (
      <div className={`${well} acard-gen`} role="img" aria-label={`Painting ${com || sci}`}>
        <BirdSilhouette />
        <span className="acard-gen-cap" aria-hidden="true">painting</span>
      </div>
    );
  }
  if (phase === 'none' || !src) {
    return (
      <div className={well}>
        <BirdSilhouette />
      </div>
    );
  }
  // loading — the brief first probe
  return (
    <div className={well}>
      <span className="acard-shimmer" aria-hidden="true" />
    </div>
  );
}
