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
// A caller that already knows the catalog's art_status can pass it via `art` —
// a species marked 'ready' skips the probe/poll entirely (plain lazy <img>).
import { useEffect, useState } from 'react';
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
  art,
}: {
  slug: string;
  sci: string;
  com: string;
  feature?: boolean;
  /** The catalog's raw art_status; 'ready' skips the readiness probe. */
  art?: string;
}) {
  const url = birdImageUrl(slug, sci);
  // Gate strictly on === 'ready' — any unknown/future value takes the probe path.
  const trusted = art === 'ready' && !!url;
  const { phase, src } = useBirdImage(url, trusted);
  const well = feature ? 'acard-img feat' : 'acard-img';

  // A trusted <img> that fails to load falls to the silhouette, never a broken
  // glyph; reset on url change so a new species gets a fresh try.
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setBroken(false);
  }, [url]);

  if (broken) {
    return (
      <div className={well}>
        <BirdSilhouette />
      </div>
    );
  }
  if (phase === 'ready' && src) {
    return (
      <div className={well}>
        <img
          src={src}
          alt={com || sci}
          loading="lazy"
          decoding="async"
          onError={() => setBroken(true)}
        />
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
