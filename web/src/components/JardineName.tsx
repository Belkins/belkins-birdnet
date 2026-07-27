// THE 1838 NAME — the one component that prints a Jardine binomial.
//
// It exists because three surfaces printed the same string three different ways
// and drifted: the Roll marked weak provenance and preserved [sic]; the Index of
// Silences marked neither, so eleven of its sixteen rows stated a confidence the
// extraction never had; and the dossier hand-rolled `=== 'synonymy'` with the
// tooltip inlined, so it disagreed with the Roll about the same name. Each was
// fixed separately, and each fix was a guard bolted onto a duplication.
//
// Collapsing them is the actual repair. A binomial rendered through this
// component CANNOT lose its verify marker or its [sic], because there is nowhere
// left to forget them — which is a stronger guarantee than any test.
import type { ReactNode } from 'react';
import { sicSpans, weakSource, type JardineSpecies } from '../jardine';
import './JardineName.css';

export function JardineName({
  species,
  className,
  field = 'binomial',
}: {
  species: JardineSpecies;
  className?: string;
  /** Which 1838 string to set. Both carry artefacts — the scanner's `cælebes`
   *  is in the binomial and its `Linneas` is in the authority — so both go
   *  through the same engine. */
  field?: 'binomial' | 'authority';
}) {
  const text = field === 'binomial' ? species.jardine_binomial : species.jardine_authority;
  if (!text) return null;
  const weak = weakSource(species);
  const spans: ReactNode[] = sicSpans(text, species.sic).map((s, i) =>
    s.sic ? (
      <span className="jn-sic" key={i} title={s.sic.note || 'as printed'}>
        {s.text}
        <sup className="jn-sic-m">[sic]</sup>
      </span>
    ) : (
      <span key={i}>{s.text}</span>
    ),
  );
  return (
    <span
      className={[className, weak ? 'jn-weak' : null].filter(Boolean).join(' ') || undefined}
      title={weak ?? undefined}
    >
      {spans}
    </span>
  );
}
