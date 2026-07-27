// NAME THAT VISITOR — a gentle companion game (the "family / kids" delight the
// swarm flagged). Show a real kachō-e plate from YOUR collection, guess which
// visitor it is from four names, reveal with an honest field note. It is play,
// not a treadmill: score is session-only, there is no streak to lose, no
// leaderboard, no daily-or-else. Everything shown is real — the art is the
// species' own plate, the options are real names from the life list, the reveal
// stats are real catalog reads.
//
// Lives on its own /play companion route — never on the calm museum frame.
import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { fetchCatalog, type CatalogSpecies } from '../catalog';
import {
  counterpointFor,
  fetchJardine,
  firstSentence,
  speciesBySci,
  type JardineSpecies,
} from '../jardine';
import { birdImageUrl } from '../img';
import { BASE } from '../config';

interface Question {
  answer: CatalogSpecies;
  options: string[]; // common names, shuffled — one matches the answer
}

/** Fisher–Yates shuffle (a fresh array). Math.random is fine in app code. */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Probe an image URL; resolve true only if it actually decodes. Keeps the game
 *  to species whose plate really loads (in mock only a few do; on the real Pi all
 *  cutout.php URLs resolve). */
function probe(url: string | null): Promise<boolean> {
  if (!url) return Promise.resolve(false);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

/** An honest one-line field note built ONLY from real catalog facts — genus,
 *  all-time count, first-heard year. No personality, no causation, no invention. */
function fieldNote(s: CatalogSpecies): string {
  const bits: string[] = [];
  const genus = s.sci_name.split(' ')[0];
  if (genus) bits.push(`Genus ${genus}`);
  if (s.detection_count) {
    bits.push(`heard ${s.detection_count.toLocaleString()} ${s.detection_count === 1 ? 'time' : 'times'}`);
  }
  if (s.first_confident) bits.push(`first recorded ${s.first_confident.slice(0, 4)}`);
  return bits.join(' · ');
}

export function Play(): JSX.Element {
  const [pool, setPool] = useState<CatalogSpecies[]>([]); // loadable-art species (answers)
  const [names, setNames] = useState<string[]>([]); // all common names (distractors)
  const [q, setQ] = useState<Question | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  // THE 1838 REVEAL. fetchJardine() is session-memoised and never throws — a
  // missing jardine.json collapses to the empty shape, the map is empty, and
  // every reveal renders exactly as it did before this existed.
  const [jard, setJard] = useState<Map<string, JardineSpecies>>(new Map());
  const [score, setScore] = useState({ right: 0, total: 0 });
  const [hard, setHard] = useState(false);
  const [loading, setLoading] = useState(true);

  const nextQuestion = useCallback(
    (answers: CatalogSpecies[], allNames: string[]) => {
      if (answers.length === 0) return;
      const answer = answers[Math.floor(Math.random() * answers.length)];
      const distractors = shuffle(allNames.filter((n) => n !== answer.com_name)).slice(0, 3);
      setChosen(null);
      setQ({ answer, options: shuffle([answer.com_name, ...distractors]) });
    },
    [],
  );

  useEffect(() => {
    let live = true;
    fetchJardine()
      .then((doc) => {
        if (live) setJard(speciesBySci(doc));
      })
      .catch(() => {
        /* the game simply keeps its own reveal */
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void fetchCatalog().then(async (rows) => {
      if (!alive) return;
      const named = rows.filter((r) => r.com_name);
      const allNames = Array.from(new Set(named.map((r) => r.com_name)));
      // Probe a bounded, shuffled sample so the answer pool is only plates that
      // actually load. Fall back to the full list if too few load (real Pi: all).
      const sample = shuffle(named).slice(0, 40);
      const flags = await Promise.all(sample.map((s) => probe(birdImageUrl(s.slug, s.sci_name))));
      if (!alive) return;
      const loadable = sample.filter((_, i) => flags[i]);
      const answers = loadable.length >= 1 ? loadable : named;
      setPool(answers);
      setNames(allNames);
      setLoading(false);
      if (allNames.length >= 4) nextQuestion(answers, allNames);
    });
    return () => {
      alive = false;
    };
  }, [nextQuestion]);

  function choose(name: string): void {
    if (chosen || !q) return;
    setChosen(name);
    setScore((s) => ({
      right: s.right + (name === q.answer.com_name ? 1 : 0),
      total: s.total + 1,
    }));
  }

  const canPlay = names.length >= 4 && pool.length >= 1;

  return (
    <div className="pl">
      <header className="pl-head">
        <div>
          <div className="pl-eyebrow">A game from your collection</div>
          <h1 className="pl-title">Name That Visitor</h1>
        </div>
        <div className="pl-score">
          <b>{score.right}</b>
          <span>of {score.total} correct</span>
        </div>
      </header>

      {loading && <p className="pl-note">shuffling the deck…</p>}

      {!loading && !canPlay && (
        <p className="pl-note">
          Not enough of the collection has illustrations yet to play — come back once more visitors have
          been painted.
        </p>
      )}

      {!loading && canPlay && q && (
        <>
          <div className="pl-stage">
            <div className={hard ? 'pl-plate pl-plate--hard' : 'pl-plate'}>
              <img src={birdImageUrl(q.answer.slug, q.answer.sci_name) ?? ''} alt="Mystery visitor" />
            </div>
          </div>

          <div className="pl-options">
            {q.options.map((name) => {
              const isAnswer = name === q.answer.com_name;
              const isChosen = name === chosen;
              const cls = !chosen
                ? 'pl-opt'
                : isAnswer
                  ? 'pl-opt pl-opt--right'
                  : isChosen
                    ? 'pl-opt pl-opt--wrong'
                    : 'pl-opt pl-opt--dim';
              return (
                <button key={name} className={cls} onClick={() => choose(name)} disabled={!!chosen}>
                  {name}
                </button>
              );
            })}
          </div>

          {chosen && (
            <div className="pl-reveal">
              <div
                className={
                  chosen === q.answer.com_name ? 'pl-reveal-verdict is-right' : 'pl-reveal-verdict'
                }
              >
                {chosen === q.answer.com_name ? '✓ Yes —' : '✗ It was'} {q.answer.com_name}
              </div>
              <div className="pl-reveal-sci">{q.answer.sci_name}</div>
              <div className="pl-reveal-note">
                {q.answer.accession != null && `No. ${String(q.answer.accession).padStart(3, '0')} · `}
                {fieldNote(q.answer)}
              </div>
              {/* What the library said — and for 19 of 51 species, that it said
                  nothing. Routed through the SAME selector the Library tab and
                  the dossier use, so the three surfaces can never disagree about
                  which birds are silent. Absent corpus → this block never
                  mounts and the game reads exactly as before. */}
              {(() => {
                const cp = counterpointFor(jard.get(q.answer.sci_name));
                if (!cp) return null;
                return cp.kind === 'voice' ? (
                  <div className="pl-jard">
                    <p className="pl-jard-t">{firstSentence(cp.passage.text)}</p>
                    <span className="pl-jard-c">
                      {cp.passage.speaker} · {cp.passage.volume_title}
                    </span>
                  </div>
                ) : (
                  <div className="pl-jard">
                    <span className="pl-jard-s">the library is silent on this one</span>
                    <span className="pl-jard-c">{cp.note}</span>
                  </div>
                );
              })()}
              <button className="pl-next" onClick={() => nextQuestion(pool, names)}>
                next visitor →
              </button>
            </div>
          )}

          <div className="pl-controls">
            <label className="pl-toggle">
              <input type="checkbox" checked={hard} onChange={(e) => setHard(e.target.checked)} />
              hard mode (silhouette)
            </label>
            <button className="pl-reset" onClick={() => setScore({ right: 0, total: 0 })}>
              reset score
            </button>
          </div>
        </>
      )}

      <footer className="pl-foot">
        <a href={BASE}>← the museum</a>
        <a href={`${BASE}wrapped.html`}>year in review →</a>
      </footer>
    </div>
  );
}
