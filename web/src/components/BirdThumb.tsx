// BIRD THUMB — the shared image well used by the Atlas plates and the bird
// popup. A simplified two-step fallback so a missing or still-generating
// illustration never shows a broken <img>:
//
//   kachō-e illustration (birdImageUrl)  →  onError  →  letter plate (.acard-sil)
//
// The old "knockout" ink-ghost refetch tier was dropped — cutout.php already
// resolves its own fallback chain server-side, so a client-side re-render
// through a filter added nothing but a second failed request.
import { useState } from 'react';
import { birdImageUrl } from '../img';

type ThumbState = 'photo' | 'plate';

// The illustration paints first; on a load error it collapses straight to the
// letter plate — the structural floor that can never show a broken <img>.
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
  const [state, setState] = useState<ThumbState>('photo');
  const well = feature ? 'acard-img feat' : 'acard-img';
  if (!url || state === 'plate') {
    return (
      <div className={well}>
        <div className="acard-sil">{(com || sci).slice(0, 1)}</div>
      </div>
    );
  }
  return (
    <div className={well}>
      <img src={url} alt={com || sci} loading="lazy" onError={() => setState('plate')} />
    </div>
  );
}
