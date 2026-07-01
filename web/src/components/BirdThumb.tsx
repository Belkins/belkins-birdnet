// BIRD THUMB — the shared image well used by the Atlas plates, the Collection
// Wall and the bird popup. A three-step chain so a missing or still-generating
// illustration never shows a broken <img> (nor a flat gray letter disc):
//
//   loading  →  shimmer skeleton in the bounded frame  (URL in flight)
//   loaded   →  kachō-e illustration (birdImageUrl)
//   error    →  a quiet bird SILHOUETTE (never a letter monogram)
//
// cutout.php resolves its own fallback chain server-side; the client only has
// to bridge the gap while a newly-heard species is generating on Railway.
import { useState } from 'react';
import { birdImageUrl } from '../img';

type ThumbState = 'loading' | 'photo' | 'plate';

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

// The illustration paints once it loads; while it is in flight a gentle shimmer
// fills the frame; on a load error it collapses to the bird silhouette — the
// structural floor that can never show a broken <img>.
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
  const [state, setState] = useState<ThumbState>('loading');
  const well = feature ? 'acard-img feat' : 'acard-img';
  if (!url || state === 'plate') {
    return (
      <div className={well}>
        <BirdSilhouette />
      </div>
    );
  }
  return (
    <div className={well}>
      {state === 'loading' && <span className="acard-shimmer" aria-hidden="true" />}
      <img
        src={url}
        alt={com || sci}
        loading="lazy"
        style={state === 'loading' ? { opacity: 0 } : undefined}
        onLoad={() => setState('photo')}
        onError={() => setState('plate')}
      />
    </div>
  );
}
