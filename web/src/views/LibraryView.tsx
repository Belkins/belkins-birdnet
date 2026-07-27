// THE LIBRARY — a reading room in the same building as the museum. Forty
// volumes of Jardine's The Naturalist's Library (Edinburgh, 1833–1843) quietly
// corrected by one London garden: an 1838 sentence about a bird's voice, and
// the Pi's recording of that bird printed underneath it as the sentence's own
// ornament.
//
// THE TWO-HAND LAW governs every line: everything from 1838 is Cormorant
// (var(--display)), ragged-right, --ink-2, no caps; everything from 2026 is
// Space Mono (var(--mono)), 9–10px, uppercase, --mut. THE AMBER LAW: --amber
// marks exactly two things — an UNCHANGED 1838 binomial, and a number MEASURED
// BY THE PI. Nothing here is fetched from a model, generated or paraphrased:
// every sentence is verbatim Victorian prose from the committed corpus, or a
// number computed at render from species.json.
//
// Nothing is hand-written that could be derived, and nothing is derived that is
// not true: every section degrades to silence rather than to a placeholder, and
// the whole tab renders its honest empty state when /jardine.json is absent.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { API_BASE } from '../config';
import type { CatalogSpecies } from '../catalog';
import { fetchArtStatus, fetchCatalog } from '../catalog';
import { fmtRelative } from '../almanac';

import { BirdThumb } from '../components/BirdThumb';
import { JardineName } from '../components/JardineName';
import { Listen } from '../components/Listen';
import type {
  Jardine,
  JardineErratum,
  JardineErratumSubject,
  JardinePassage,
  JardineSic,
  JardineAccounts,
  JardineSpecies,
} from '../jardine';
import {
  deskPool,
  fetchAccounts,
  fetchJardine,
  jardineImageUrl,
  pickDeskSpecies,
  sealLine,
  silences,
  sicSpans,
  speciesBySci,
  volumeRoman,
} from '../jardine';
import type { RosterRow } from '../types';
import './LibraryView.css';

// The corvid genera, for the one dry line the Roll is allowed. Jardine gave the
// family thousands of words and their voices none; the sentence only prints
// when the silent rows actually contain them.
const CORVID_GENERA = [
  'Corvus',
  'Coloeus',
  'Pica',
  'Garrulus',
  'Nucifraga',
  'Pyrrhocorax',
  'Cyanopica',
  'Perisoreus',
];

// The Roll's one ordering: by how far the name has drifted since 1838, then
// alphabetically. NEVER by tally — rank inversely correlates with prose quality
// here, and a rank sort opens the ledger on Jardine's three weakest subjects.
const DRIFT_RANK: Record<string, number> = {
  unchanged: 0,
  spelling: 1,
  genus: 2,
  family: 3,
  collision: 4,
};


/** The catalog's 'YYYY-MM-DD HH:MM:SS' split the way BirdPopup already splits a
 *  stamp for fmtRelative — the one relative-time helper in the tree. */
function relFromStamp(stamp: string | null): string | null {
  if (!stamp) return null;
  const [d, t] = stamp.split(' ');
  const out = fmtRelative(d ?? null, t ?? null);
  return out === '—' ? null : out;
}

/** Render a passage VERBATIM, each preserved OCR artefact wearing a visible
 *  [sic]. The SPLITTING is jardine.ts's sicSpans() — the one engine every
 *  surface shares; this only turns its runs into nodes. */
function sicNodes(text: string, sic: JardineSic[]): ReactNode {
  const spans = sicSpans(text, sic);
  if (spans.length === 1 && !spans[0].sic) return text;
  return spans.map((s, i) =>
    s.sic ? (
      <span className="lib-sic" key={i} title={s.sic.note || 'as printed'}>
        {s.text}
        <sup className="lib-sic-m">[sic]</sup>
      </span>
    ) : (
      <span key={i}>{s.text}</span>
    ),
  );
}

/** THE FULL ACCOUNT — the whole of what Jardine wrote about one bird.
 *
 *  The tab in front of this shows the curated reading: one passage chosen by
 *  ear, sometimes a coda. That is 58 passages across 51 species. The extraction
 *  verified 211. This is the other 153 — already attributed, already through
 *  the speaker wall, and until now reaching nobody.
 *
 *  Every passage renders through the same <Prose> and <Attribution> the desk
 *  uses, so the attribution rule ("printed under every single passage, always")
 *  holds here for free rather than being re-implemented. */
function FullAccount({
  species,
  passages,
  com,
  onClose,
}: {
  species: JardineSpecies;
  passages: JardinePassage[];
  com: string;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="lib-acct-back" onClick={onClose}>
      <div
        className="lib-acct"
        role="dialog"
        aria-modal="true"
        aria-label={`Jardine's full account of the ${com}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="lib-acct-h">
          <div>
            <span className="lib-acct-k">the full account</span>
            <span className="lib-acct-t">{species.jardine_title}</span>
          </div>
          <button type="button" className="lib-acct-x" onClick={onClose} ref={closeRef}>
            ✕
          </button>
        </div>
        <div className="lib-acct-sub">
          {com} · vol. {volumeRoman(species.volume)} · {passages.length} passages, as printed
        </div>
        <div className="lib-acct-body">
          {passages.map((p, i) => (
            <Prose p={p} key={i} />
          ))}
          {passages.length > 0 && <Attribution p={passages[0]} />}
        </div>
      </div>
    </div>
  );
}

/** THE INDEX OF SILENCES — the birds Jardine described without ever describing
 *  their sound, and the Pi playing the very thing the book failed to write down.
 *
 *  Ordered by the Pi's tally DESCENDING, which deliberately inverts the Roll's
 *  never-by-tally rule. That inversion IS the argument: sorted this way the
 *  ledger opens on the bird this garden shouts about most and the library is
 *  quietest on. Do not align it with the Roll.
 *
 *  THE TWO-HAND LAW is the subtle part here. The note is the MUSEUM writing in
 *  2026 about a gap in an 1838 book, so it takes the modern hand. Only the coda
 *  — where one exists — is Jardine's own sentence, and it alone gets Cormorant
 *  and an <Attribution>. Setting a curator's note in Cormorant would file the
 *  museum's opinion under a dead man's name, which is this project's one
 *  unrecoverable failure. */
function SilenceIndex({
  rows,
  comFor,
  onReadAll,
}: {
  rows: Array<{ species: JardineSpecies; count: number }>;
  comFor: (sci: string) => string;
  onReadAll?: (sci: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="lib-sec lib-silences">
      <div className="lib-sec-h">
        <span className="lib-sec-k">the index of silences</span>
        <span className="lib-sec-t">
          Birds the library describes without ever describing their sound.
        </span>
      </div>
      <ol className="lib-sil-list">
        {rows.map(({ species, count }) => (
          <li className="lib-sil-row" key={species.sci_name}>
            <div className="lib-sil-head">
              <span className="lib-sil-com">{comFor(species.sci_name)}</span>
              {/* the SAME provenance marker the Roll prints. 11 of these 16
                  rows are weak-sourced; printing them bare stated a confidence
                  the extraction never had. */}
              <JardineName species={species} className="lib-sil-bin" />
              <span className="lib-sil-n prose-nums">
                {count.toLocaleString()} <span className="lib-sil-u">recorded here</span>
              </span>
            </div>
            {/* 2026 prose about a gap in an 1838 book — the modern hand. */}
            <p className="lib-sil-note">{species.note}</p>
            {/* the ONLY 1838 words in this row, and the only Cormorant. */}
            {species.coda && (
              <div className="lib-sil-coda">
                <span className="lib-sil-lab">what he wrote instead</span>
                <Prose p={species.coda} tone="coda" />
                <Attribution p={species.coda} />
              </div>
            )}
            <div className="lib-sil-play">
              <Listen sci={species.sci_name} />
              {onReadAll && (
                <button
                  type="button"
                  className="lib-another lib-sil-read"
                  onClick={() => onReadAll(species.sci_name)}
                >
                  ☞ read what he DID write
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
      <div className="lib-close">
        The book has no word for these. The microphone does.
      </div>
    </section>
  );
}

/** THE ATTRIBUTION RULE, rendered: the speaker is printed under every single
 *  passage, always, with no exception and no hover disclosure. A quotation says
 *  so, so a voice inside a volume is never mistaken for the volume's author. */
function Attribution({ p, link = true }: { p: JardinePassage; link?: boolean }) {
  return (
    <div className="lib-cite">
      <span className="lib-cite-who">{p.speaker}</span>
      <span className="lib-cite-w">
        {p.is_quotation ? 'quoted in ' : ''}
        vol. {volumeRoman(p.volume)}
        {p.volume_title ? ` · ${p.volume_title}` : ''}
        {p.volume_author && p.volume_author !== p.speaker ? ` · ${p.volume_author}` : ''}
      </span>
      {link && p.source_url && (
        <a
          className="lib-cite-l"
          href={p.source_url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          c82.net ↗
        </a>
      )}
    </div>
  );
}

/** An 1838 passage: Cormorant, ragged-right, oldstyle figures inside prose. */
function Prose({ p, tone = 'desk' }: { p: JardinePassage; tone?: 'desk' | 'coda' | 'slip' }) {
  return (
    <p className={`lib-prose prose-nums lib-prose-${tone}`}>{sicNodes(p.text, p.sic)}</p>
  );
}

// ── THE READING DESK — the signature ─────────────────────────────────────────

interface DeskDetail {
  file: string | null;
  d: string | null;
  t: string | null;
}

/** One passage, and beneath it at exactly the same measure the Pi's spectrogram
 *  of that species' newest recording — a 44px band set as the printed rule under
 *  the type. An amber hairline sweeps it while the clip plays.
 *
 *  The desk owns its own <audio> + rAF loop, exactly as BirdPopup's recording
 *  rows already do (BirdPopup.tsx openRow + the progress rAF), because the
 *  playhead is the signature and no shared control exposes its currentTime.
 *  <Listen> is used verbatim everywhere on this tab that does NOT need a
 *  playhead (the errata, the blind ear). */
function ReadingDesk({
  sp,
  lastDetected,
  live,
  aimed = false,
  onReadAll,
  onAnother,
  canRotate,
}: {
  sp: JardineSpecies;
  lastDetected: string | null;
  live: boolean;
  /** The reader named this bird (?read=). Tier zero can land on a species with
   *  NO voice, so the desk must be able to answer with the library's silence. */
  aimed?: boolean;
  /** Open the bird's complete account. Absent when the accounts file is not in
   *  the tree, in which case the control never renders. */
  onReadAll?: (sci: string) => void;
  onAnother: () => void;
  canRotate: boolean;
}) {
  const [detail, setDetail] = useState<DeskDetail | null | undefined>(undefined);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [bandFailed, setBandFailed] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // The newest recording for this species. A failure IS the off-Pi state, which
  // is designed rather than tolerated — never an error, never a spinner.
  useEffect(() => {
    const ctrl = new AbortController();
    setDetail(undefined);
    setBandFailed(false);
    (async () => {
      try {
        const res = await fetch(
          `${API_BASE}/birdnet-api.php?action=species&sci=${encodeURIComponent(sp.sci_name)}`,
          { signal: ctrl.signal },
        );
        if (!res.ok) {
          setDetail(null);
          return;
        }
        const data = (await res.json()) as {
          detections?: Array<{ file?: string | null; d?: string; t?: string }> | null;
        };
        const rows = (data.detections ?? []).filter(
          (r): r is { file: string; d?: string; t?: string } => !!r.file,
        );
        rows.sort((a, b) => {
          const ta = Date.parse(`${a.d}T${a.t || '00:00:00'}`) || 0;
          const tb = Date.parse(`${b.d}T${b.t || '00:00:00'}`) || 0;
          return tb - ta;
        });
        const newest = rows[0];
        setDetail(newest ? { file: newest.file, d: newest.d ?? null, t: newest.t ?? null } : null);
      } catch {
        if (!ctrl.signal.aborted) setDetail(null);
      }
    })();
    return () => ctrl.abort();
  }, [sp.sci_name]);

  // One clip, torn down whenever the desk turns its page or unmounts.
  useEffect(() => {
    setPlaying(false);
    setPos(0);
    return () => {
      const a = audioRef.current;
      if (a) {
        a.pause();
        a.src = '';
        audioRef.current = null;
      }
    };
  }, [sp.sci_name]);

  // The only thing that moves on this tab, and it moves because audio is
  // playing. Same rAF shape as BirdPopup's playhead.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = (): void => {
      const a = audioRef.current;
      if (a && a.duration && Number.isFinite(a.duration)) setPos(a.currentTime / a.duration);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const file = detail?.file ?? null;

  const toggle = useCallback((): void => {
    if (!file) return;
    let a = audioRef.current;
    if (!a) {
      a = new Audio(`${API_BASE}/recording.php?file=${encodeURIComponent(file)}`);
      a.preload = 'none';
      a.addEventListener('playing', () => setPlaying(true));
      a.addEventListener('pause', () => setPlaying(false));
      a.addEventListener('ended', () => {
        setPlaying(false);
        setPos(0);
      });
      a.addEventListener('error', () => setPlaying(false));
      audioRef.current = a;
    }
    if (a.paused) {
      if (a.ended) a.currentTime = 0;
      a.play().catch(() => setPlaying(false));
    } else {
      a.pause();
    }
  }, [file]);

  const stamp = relFromStamp(
    detail?.d ? `${detail.d} ${detail.t ?? ''}`.trim() : (lastDetected ?? null),
  );
  const bandStyle = { '--pos': `${(pos * 100).toFixed(2)}%` } as CSSProperties;

  return (
    <section className="lib-desk" aria-label="The reading desk">
      {/* Say so when the reader chose this page. Without it an aimed desk is
          indistinguishable from the daily rotation happening to agree, and the
          reader cannot tell whether the button worked. */}
      {aimed && <span className="lib-desk-aim">you asked for this one</span>}
      {sp.voice && <Prose p={sp.voice} />}
      {sp.coda && <Prose p={sp.coda} tone="coda" />}
      {/* An aimed bird can be one of the silent ones. Rendering nothing would
          repeat the dossier's old bug on a bigger surface, so the desk says
          what the library actually has: nothing, and why. */}
      {!sp.voice && sp.note && <p className="lib-desk-silence">{sp.note}</p>}

      <div className="lib-deskbar">
        <button
          type="button"
          className="listen-btn"
          data-status={playing ? 'playing' : 'idle'}
          disabled={!file}
          aria-label={
            file ? `Play the newest recording of ${sp.sci_name}` : 'No recording available'
          }
          onClick={toggle}
        >
          <span className="listen-ico">{playing ? '❚❚' : '▶'}</span>
          <span className="listen-lab">
            {file ? (playing ? 'Pause' : 'Listen') : detail === undefined ? 'Listen' : 'No audio'}
          </span>
        </button>
        {canRotate && (
          <button type="button" className="lib-another" onClick={onAnother}>
            ☞ another passage
          </button>
        )}
        {onReadAll && (
          <button type="button" className="lib-another" onClick={() => onReadAll(sp.sci_name)}>
            ☞ the whole account
          </button>
        )}
      </div>

      {/* THE BAND — the printed rule under the type. Same measure as the
          passage, never a chart in a box. Absent, by design, when the machine
          in the garden cannot be reached. */}
      {file && !bandFailed ? (
        <div className="lib-band" style={bandStyle}>
          <img
            className="lib-band-img"
            alt=""
            src={`${API_BASE}/spectrogram.php?file=${encodeURIComponent(file)}`}
            onError={() => setBandFailed(true)}
          />
          {playing && <div className="lib-band-head" />}
        </div>
      ) : null}

      <div className="lib-deskfoot">
        {sp.voice && <Attribution p={sp.voice} />}
        {/* The garden's answer. Amber ONLY when it is a measurement the Pi
            made; the off-Pi line is Jardine's own condition restated, not a
            number, so it stays muted. */}
        <div
          className="lib-answer"
          data-kind={file ? 'heard' : detail === undefined ? 'wait' : 'silent'}
        >
          {file
            ? `heard here${stamp ? ` ${stamp}` : ''}${live ? ' · in this window' : ''}`
            : detail === undefined
              ? ''
              : 'the recording lives on the machine in the garden.'}
        </div>
      </div>
    </section>
  );
}

// ── THE ERRATA ───────────────────────────────────────────────────────────────

interface GardenFact {
  present: boolean;
  count: number;
  pct: string;
  com: string;
}

function gardenFact(
  sub: JardineErratumSubject,
  byCatalog: Map<string, CatalogSpecies>,
  totalCalls: number,
): GardenFact {
  const c = byCatalog.get(sub.sci_name);
  if (!c) return { present: false, count: 0, pct: '0', com: '' };
  const pct = totalCalls > 0 ? (c.detection_count / totalCalls) * 100 : 0;
  return {
    present: true,
    count: c.detection_count,
    pct: `${pct.toFixed(2)}%`,
    com: c.com_name || c.sci_name,
  };
}

/** The 2026 half of any comparison: the museum's own cut specimen, its live
 *  tally in amber (a number measured by the Pi), and a working control — or one
 *  flat, honestly inert line when this garden has never heard the bird. */
function ModernHalf({
  sub,
  fact,
  art,
  onOpen,
  slugFor,
}: {
  sub: JardineErratumSubject;
  fact: GardenFact;
  art: Map<string, string> | null;
  onOpen?: (r: RosterRow) => void;
  slugFor: (sci: string) => string;
}) {
  if (!fact.present) {
    return (
      <div className="lib-modern lib-modern-none">
        <div className="lib-inert">no recording — never heard in this garden.</div>
      </div>
    );
  }
  const slug = slugFor(sub.sci_name);
  return (
    <div className="lib-modern">
      <div
        className="lib-cut"
        role={onOpen ? 'button' : undefined}
        tabIndex={onOpen ? 0 : undefined}
        onClick={() =>
          onOpen?.({ sci: sub.sci_name, com: fact.com, slug, n: 0, isNew: false })
        }
      >
        <BirdThumb slug={slug} sci={sub.sci_name} com={fact.com} art={art?.get(slug)} />
      </div>
      <div className="lib-modern-n">{fact.com}</div>
      <div className="lib-tally">
        <b>{fact.count.toLocaleString()}</b> calls · {fact.pct}
      </div>
      <Listen sci={sub.sci_name} />
    </div>
  );
}

/** Jardine's engraving, matted: 1px --line frame, --card ground, a --bg2 mount,
 *  filter:none, no glow. The only rectangular hard-edged image in this museum —
 *  printed sheet against cut specimen, two centuries legible without reading a
 *  word. Sized at Jardine's OWN relative scale, which is the whole argument. */
function Engraving({ sub, caption }: { sub: JardineErratumSubject; caption: string }) {
  const src = jardineImageUrl(sub.image);
  const style = { '--scale': String(sub.scale) } as CSSProperties;
  return (
    <figure className="lib-mount" style={style}>
      {src ? (
        <span className="lib-mat">
          <img
            className="lib-plate"
            src={src}
            width={sub.image_w ?? undefined}
            height={sub.image_h ?? undefined}
            alt={`Jardine's ${sub.jardine_plate ?? 'plate'} of ${sub.sci_name}`}
            loading="lazy"
            decoding="async"
          />
        </span>
      ) : (
        <span className="lib-mat lib-mat-empty" aria-hidden="true" />
      )}
      <figcaption className="lib-mount-cap">
        <span className="lib-mount-k">
          {sub.jardine_plate ? sub.jardine_plate.replace(/-/g, ' ') : 'not illustrated'}
        </span>
        <span className="lib-mount-t">{caption}</span>
      </figcaption>
    </figure>
  );
}

function ErratumSlip({
  e,
  byCatalog,
  bySci,
  totalCalls,
  art,
  onOpen,
  slugFor,
}: {
  e: JardineErratum;
  byCatalog: Map<string, CatalogSpecies>;
  bySci: Map<string, JardineSpecies>;
  totalCalls: number;
  art: Map<string, string> | null;
  onOpen?: (r: RosterRow) => void;
  slugFor: (sci: string) => string;
}) {
  const facts = e.subjects.map((s) => gardenFact(s, byCatalog, totalCalls));
  // A slip with nothing to correct is not a correction: No. V concedes, and
  // concessions are set in --mut, not --red. Derived, never tagged by hand.
  const conceded = facts.length > 0 && facts.every((f) => !f.present);

  const heading = (
    <div className="lib-slip-h">
      <span className="lib-slip-no">No. {e.no}</span>
      <span className="lib-slip-t">{e.headline}</span>
    </div>
  );

  const says = e.quote && (
    <div className="lib-says">
      <div className="lib-lab">Jardine says</div>
      <Prose p={e.quote} tone="slip" />
      <Attribution p={e.quote} />
    </div>
  );

  // No. I — THE VITRINE. Three plates hung at Jardine's own relative sizes,
  // each beside the museum's own plate of the same bird at full museum size.
  if (e.kind === 'precedence') {
    return (
      <article className="acard lib-slip lib-slip-wide" data-tone={conceded ? 'mut' : 'red'}>
        {heading}
        {says}
        <div className="lib-vitrine">
          {e.subjects.map((sub, i) => {
            const j = bySci.get(sub.sci_name);
            return (
              <div className="lib-spread" key={sub.sci_name}>
                <Engraving sub={sub} caption={j?.jardine_title || sub.sci_name} />
                <div className="lib-gutter" aria-hidden="true">
                  {i === 0 && <span className="lib-gutter-k">190 years</span>}
                </div>
                <ModernHalf
                  sub={sub}
                  fact={facts[i]}
                  art={art}
                  onOpen={onOpen}
                  slugFor={slugFor}
                />
              </div>
            );
          })}
        </div>
        <div className="lib-wall">Precedence, as printed. Tallies, as heard.</div>
        {e.closing && <div className="lib-close">{e.closing}</div>}
      </article>
    );
  }

  // No. IV — THE COLLISION. One binomial, two entirely different birds, both in
  // this garden, both in the same 1838 volume two headings apart.
  if (e.kind === 'collision') {
    // the shared 1838 name both birds were filed under. A plain string, not a
    // rendered species: the slip is ABOUT the collision of the name itself, and
    // there is no single species whose provenance marker would be correct here.
    const sharedName = e.subjects
      .map((s) => bySci.get(s.sci_name)?.jardine_binomial)
      .find(Boolean);
    return (
      <article className="acard lib-slip lib-slip-wide" data-tone="red">
        {heading}
        <div className="lib-coll-name">{sharedName || e.headline}</div>
        <div className="lib-coll-rule" aria-hidden="true" />
        <div className="lib-coll-cols">
          {e.subjects.map((sub, i) => {
            const j = bySci.get(sub.sci_name);
            const fact = facts[i];
            const era = i === 0 ? '1838' : '2026';
            const name =
              i === 0 ? j?.jardine_title || sub.sci_name : fact.com || sub.sci_name;
            return (
              <div className="lib-coll-col" key={sub.sci_name}>
                <div className="lib-coll-k">
                  {era} · {name}
                </div>
                {fact.present ? (
                  <ModernHalf
                    sub={sub}
                    fact={fact}
                    art={art}
                    onOpen={onOpen}
                    slugFor={slugFor}
                  />
                ) : (
                  <div className="lib-modern lib-modern-none">
                    <span className="lib-mat lib-mat-empty" aria-hidden="true" />
                    <div className="lib-inert">not in this garden's catalogue.</div>
                  </div>
                )}
                <div className="lib-coll-sci">{sub.sci_name}</div>
              </div>
            );
          })}
        </div>
        {says}
        {e.closing && <div className="lib-close">{e.closing}</div>}
      </article>
    );
  }

  // The plain slip: what he said, over what the garden says.
  return (
    <article className="acard lib-slip" data-tone={conceded ? 'mut' : 'red'}>
      {heading}
      {says}
      <div className="lib-garden">
        <div className="lib-lab">The garden says</div>
        <div className="lib-garden-rows">
          {e.subjects.map((sub, i) => {
            const f = facts[i];
            return (
              <div className="lib-garden-row" key={sub.sci_name}>
                {f.present ? (
                  <>
                    <b className="lib-fig">{f.pct}</b>
                    <span className="lib-fig-l">
                      {f.com} · {f.count.toLocaleString()} calls · of everything this station
                      has ever heard
                    </span>
                  </>
                ) : (
                  <>
                    <b className="lib-fig lib-fig-zero">0</b>
                    <span className="lib-fig-l">{sub.sci_name} · never heard here</span>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {e.closing && <div className="lib-close">{e.closing}</div>}
    </article>
  );
}

// ── THE BLIND EAR ────────────────────────────────────────────────────────────

interface Round {
  answer: JardineSpecies;
  options: JardineSpecies[];
}

/** One recording, three verbatim 1838 descriptions, one question. The decoys
 *  are length-matched to within ±25% so sentence length is never the tell. No
 *  score, no streak, no badge, nothing persisted — the museum's contract is
 *  collection, not streaks. The reveal names every bird, so a wrong answer
 *  still teaches which sentence belonged to which voice. */
function drawRound(pool: JardineSpecies[]): Round | null {
  if (pool.length < 3) return null;
  const answer = pool[Math.floor(Math.random() * pool.length)];
  const len = answer.voice ? answer.voice.text.length : 0;
  const others = pool.filter((s) => s.sci_name !== answer.sci_name);
  const matched = others.filter((s) => {
    const l = s.voice ? s.voice.text.length : 0;
    return len > 0 && l >= len * 0.75 && l <= len * 1.25;
  });
  const bag = [...(matched.length >= 2 ? matched : others)];
  const decoys: JardineSpecies[] = [];
  while (decoys.length < 2 && bag.length > 0) {
    decoys.push(bag.splice(Math.floor(Math.random() * bag.length), 1)[0]);
  }
  if (decoys.length < 2) return null;
  const options = [answer, ...decoys];
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  return { answer, options };
}

function BlindEar({
  pool,
  art,
  comFor,
  slugFor,
}: {
  pool: JardineSpecies[];
  art: Map<string, string> | null;
  comFor: (sci: string) => string;
  slugFor: (sci: string) => string;
}) {
  const [round, setRound] = useState<Round | null>(null);
  const [picked, setPicked] = useState<number | null>(null);

  const redraw = useCallback(() => {
    setPicked(null);
    setRound(drawRound(pool));
  }, [pool]);

  useEffect(() => {
    setPicked(null);
    setRound(drawRound(pool));
  }, [pool]);

  if (!round) return null;
  const answerSlug = slugFor(round.answer.sci_name);
  const answerCom = comFor(round.answer.sci_name);

  return (
    <section className="lib-sec lib-ear">
      <div className="lib-sec-h">
        <span className="lib-sec-k">the blind ear</span>
        <span className="lib-sec-t">Which description is this bird?</span>
      </div>

      <div className="lib-ear-play">
        <Listen sci={round.answer.sci_name} />
        <span className="lib-ear-hint">
          one recording from this garden · three descriptions from 1838 · press 1, 2 or 3
        </span>
      </div>

      <div
        className="lib-ear-opts"
        role="group"
        aria-label="Three 1838 descriptions"
        tabIndex={0}
        onKeyDown={(ev) => {
          if (picked !== null) return;
          const i = Number(ev.key) - 1;
          if (i >= 0 && i < round.options.length) {
            ev.preventDefault();
            setPicked(i);
          }
        }}
      >
        {round.options.map((opt, i) => {
          const correct = opt.sci_name === round.answer.sci_name;
          const state =
            picked === null ? 'open' : correct ? 'right' : picked === i ? 'wrong' : 'off';
          return (
            <button
              type="button"
              className="acard lib-opt"
              data-state={state}
              key={opt.sci_name}
              disabled={picked !== null}
              onClick={() => setPicked(i)}
            >
              <span className="lib-opt-no">{i + 1}</span>
              {opt.voice && <span className="lib-opt-p prose-nums">{sicNodes(opt.voice.text, opt.voice.sic)}</span>}
              {picked !== null && (
                <span className="lib-opt-true">
                  {opt.jardine_title || opt.sci_name}
                  {opt.jardine_binomial && (
                    <>
                      {' · '}
                      <JardineName species={opt} />
                    </>
                  )}{' '}
                  · vol. {volumeRoman(opt.volume)}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {picked !== null && (
        <div className="lib-ear-rev">
          <div className="lib-cut lib-cut-sm">
            <BirdThumb
              slug={answerSlug}
              sci={round.answer.sci_name}
              com={answerCom}
              art={art?.get(answerSlug)}
            />
          </div>
          <div className="lib-ear-rev-t">
            <div className="lib-ear-rev-n">{answerCom || round.answer.sci_name}</div>
            <div className="lib-ear-rev-s">
              {round.answer.jardine_title}
              {round.answer.jardine_binomial && (
                <>
                  {', '}
                  <JardineName species={round.answer} />
                </>
              )}
              {round.answer.jardine_authority && (
                <>
                  {' '}
                  <JardineName species={round.answer} className="lib-scaps" field="authority" />
                </>
              )}
            </div>
            {round.answer.voice && <Attribution p={round.answer.voice} />}
            <button type="button" className="lib-again" onClick={redraw}>
              again ↺
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// ── THE VIEW ─────────────────────────────────────────────────────────────────

export function LibraryView({
  rows,
  windowHours,
  aim,
  onReleaseAim,
  onOpen,
}: {
  /** The live roster for the CURRENT period window (1H/12H/24H/7D) — on this
   *  tab that shared filter finally has a job: it selects the recency band the
   *  Reading Desk answers from. */
  rows: RosterRow[];
  /** The active period in hours. Under ALL the window is a non-claim (the same
   *  reasoning as BirdPopup's showWindowStat), so the desk stops answering
   *  "in this window" and falls to its daily rotation. */
  windowHours?: number;
  /** ?read= — the bird the reader named from a dossier. Tier zero of the desk. */
  aim?: string | null;
  /** Called when the reader turns the page: the aim is spent and the URL should
   *  stop claiming it, or Back would re-aim at a bird they have moved past. */
  onReleaseAim?: () => void;
  onOpen?: (r: RosterRow) => void;
}) {
  const [jardine, setJardine] = useState<Jardine | null>(null);
  const [catalog, setCatalog] = useState<CatalogSpecies[] | null>(null);
  const [art, setArt] = useState<Map<string, string> | null>(null);
  const [step, setStep] = useState(0);
  const [shelfHover, setShelfHover] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchJardine().then((j) => {
      if (alive) setJardine(j);
    });
    void fetchCatalog().then((c) => {
      if (alive) setCatalog(c);
    });
    void fetchArtStatus().then((m) => {
      if (alive) setArt(m);
    });
    return () => {
      alive = false;
    };
  }, []);

  const byCatalog = useMemo(() => {
    const m = new Map<string, CatalogSpecies>();
    for (const c of catalog ?? []) m.set(c.sci_name, c);
    return m;
  }, [catalog]);

  const bySci = useMemo(
    () => (jardine ? speciesBySci(jardine) : new Map<string, JardineSpecies>()),
    [jardine],
  );

  const totalCalls = useMemo(
    () => (catalog ?? []).reduce((a, c) => a + (c.detection_count || 0), 0),
    [catalog],
  );

  // The roster carries a slug for live species; the catalog carries one for
  // every species ever heard. One lookup, no second slugifier.
  const slugFor = useCallback(
    (sci: string): string => {
      const c = byCatalog.get(sci);
      if (c?.slug) return c.slug;
      const r = rows.find((x) => x.sci === sci);
      return r?.slug ?? '';
    },
    [byCatalog, rows],
  );
  const comFor = useCallback(
    (sci: string): string => byCatalog.get(sci)?.com_name ?? rows.find((x) => x.sci === sci)?.com ?? '',
    [byCatalog, rows],
  );

  // THE DESK'S PAGE. Both tiers live in jardine.ts's pickDeskSpecies — the one
  // place a test can reach them (node --test cannot parse JSX). TIER ONE: at
  // 24H or tighter, the loudest bird in the window the library actually
  // described. TIER TWO: day-of-year over the catalog∩voiced pool. "☞ another
  // passage" only ever advances the rotation, in local state — not persisted,
  // not URL-bound.
  const voicePool = useMemo(
    () => deskPool(jardine?.species ?? [], catalog ?? []),
    [jardine, catalog],
  );
  const pick = useMemo(
    () =>
      pickDeskSpecies({
        species: jardine?.species ?? [],
        rows,
        catalog: catalog ?? [],
        windowHours: windowHours ?? 24,
        now: new Date(),
        aim,
        step,
      }),
    [jardine, rows, catalog, windowHours, aim, step],
  );
  const desk = pick?.species ?? null;
  const deskIsLive = pick?.source === 'live';
  const deskIsAimed = pick?.source === 'aimed';

  // The masthead's one derived ledger sentence, never hand-written.
  const volumes = jardine?.volumes ?? [];
  const ornithology = volumes.filter((v) => v.division === 'birds').length;
  const withPage = (jardine?.species ?? []).filter((s) => byCatalog.has(s.sci_name));
  const withPlate = withPage.filter((s) => s.plate_ref !== null).length;
  const heardCount = catalog?.length ?? 0;

  // THE ROLL — a left join of the garden onto the library. Sorted by drift class
  // then alphabetically; NEVER by tally. The silent rows are a set difference,
  // so a 48th species files itself with no edit and no code change.
  const roll = useMemo(() => {
    const out = (catalog ?? []).map((c) => ({ c, j: bySci.get(c.sci_name) ?? null }));
    out.sort((a, b) => {
      const ra = a.j ? (DRIFT_RANK[a.j.drift ?? ''] ?? 5) : 9;
      const rb = b.j ? (DRIFT_RANK[b.j.drift ?? ''] ?? 5) : 9;
      if (ra !== rb) return ra - rb;
      return (a.c.com_name || a.c.sci_name).localeCompare(b.c.com_name || b.c.sci_name);
    });
    return out;
  }, [catalog, bySci]);
  const silentCount = roll.filter((r) => !r.j).length;
  const firstSilent = roll.findIndex((r) => !r.j);
  const silentCorvids = roll.filter(
    (r) => !r.j && CORVID_GENERA.some((g) => r.c.sci_name.startsWith(`${g} `)),
  ).length;

  // The shelf lights only where this garden lives.
  const litVolumes = useMemo(() => {
    const lit = new Set<number>();
    for (const s of jardine?.species ?? []) if (byCatalog.has(s.sci_name)) lit.add(s.volume);
    return lit;
  }, [jardine, byCatalog]);

  const passageCount = useMemo(() => {
    if (!jardine) return 0;
    let n = jardine.epigraph ? 1 : 0;
    for (const s of jardine.species) {
      if (s.voice) n++;
      if (s.coda) n++;
    }
    for (const e of jardine.errata) if (e.quote) n++;
    if (jardine.roll_closing) n++;
    return n;
  }, [jardine]);

  const colophon = jardine?.colophon ?? null;

  // THE READING ROOM. `openSci` is the bird whose full account is open; the
  // ~277 KB accounts file is fetched on the FIRST open and never before, so the
  // tab's first paint is unchanged by this feature existing. fetchAccounts()
  // never throws and yields {} when the file is absent, in which case the
  // affordance never renders and the tab behaves exactly as it did.
  const [accounts, setAccounts] = useState<JardineAccounts | null>(null);
  const [openSci, setOpenSci] = useState<string | null>(null);
  useEffect(() => {
    if (openSci === null || accounts !== null) return;
    let live = true;
    fetchAccounts()
      .then((a) => {
        if (live) setAccounts(a);
      })
      .catch(() => {
        if (live) setAccounts({});
      });
    return () => {
      live = false;
    };
  }, [openSci, accounts]);
  const openAccount = useCallback((sci: string) => setOpenSci(sci), []);
  // The silent birds, loudest first. Empty (and the section unmounts) whenever
  // the corpus is absent — the tab keeps its honest empty state.
  const silenceRows = useMemo(
    () => (jardine ? silences(jardine, catalog ?? []) : []),
    [jardine, catalog],
  );

  const empty = jardine !== null && volumes.length === 0 && jardine.species.length === 0;

  return (
    <div className="view lib">
      {/* 1 · MASTHEAD + THE EPIGRAPH — one borrowed sentence, then it shuts up. */}
      <div className="view-mast">
        <div className="eyebrow">the naturalist's library · edinburgh, 1833–1843</div>
        <div className="t">THE LIBRARY</div>
      </div>

      {jardine === null ? (
        <div className="lib-loading">
          <div className="word">Opening the volumes…</div>
        </div>
      ) : empty ? (
        <div className="lib-empty">
          <div className="word">The library has not been shelved yet.</div>
          <div className="rule" />
          <div className="cap">forty volumes are waiting to be catalogued</div>
        </div>
      ) : (
        <>
          <div className="lib-epi-wrap">
            {jardine.epigraph && (
              <>
                <p className="lib-epi prose-nums">
                  {sicNodes(jardine.epigraph.text, jardine.epigraph.sic)}
                </p>
                <div className="lib-epi-cite">
                  {jardine.epigraph.speaker} · vol. {volumeRoman(jardine.epigraph.volume)}
                  {jardine.epigraph.volume_title ? ` · ${jardine.epigraph.volume_title}` : ''}
                  {jardine.epigraph.volume_author ? ` · ${jardine.epigraph.volume_author}` : ''} ·{' '}
                  <a
                    className="lib-cite-l"
                    href={jardine.epigraph.source_url || 'https://www.c82.net/naturalists-library/'}
                    target="_blank"
                    rel="noreferrer"
                  >
                    restored by Nicholas Rougeux ↗
                  </a>
                </div>
              </>
            )}
            {/* ONE derived ledger sentence, never hand-written — and never
                printed against a catalog that has not arrived yet. */}
            {catalog !== null && volumes.length > 0 && (
              <div className="lib-ledger">
                {volumes.length} volumes · {ornithology} ornithology · {withPage.length} of the{' '}
                {heardCount} species heard in this garden have a page · {withPlate} have a plate
              </div>
            )}
          </div>

          {/* 2 · THE READING DESK — the signature. */}
          {desk ? (
            <ReadingDesk
              key={desk.sci_name}
              sp={desk}
              lastDetected={byCatalog.get(desk.sci_name)?.last_detected ?? null}
              live={deskIsLive}
              aimed={deskIsAimed}
              onReadAll={openAccount}
              canRotate={voicePool.length > 1}
              onAnother={() => {
                setStep((s) => s + 1);
                onReleaseAim?.();
              }}
            />
          ) : (
            // Only once the catalog has actually answered: an empty desk while
            // it is still in flight would state a silence that is not yet true.
            catalog !== null && (
              <section className="lib-desk lib-desk-quiet">
                <p className="lib-prose lib-prose-desk">
                  No page in this library describes the voice of a bird this garden has heard.
                </p>
                <div className="lib-answer">the library is silent.</div>
              </section>
            )
          )}

          {/* 3 · THE ERRATA — five slips. */}
          {jardine.errata.length > 0 && (
            <section className="lib-sec lib-errata">
              <div className="lib-sec-h">
                <span className="lib-sec-k">errata</span>
                <span className="lib-sec-t">
                  Total respect in the address. No mercy in the correction.
                </span>
              </div>
              {jardine.errata.map((e) => (
                <ErratumSlip
                  key={e.no || e.headline}
                  e={e}
                  byCatalog={byCatalog}
                  bySci={bySci}
                  totalCalls={totalCalls}
                  art={art}
                  onOpen={onOpen}
                  slugFor={slugFor}
                />
              ))}
            </section>
          )}

          {/* 3b · THE INDEX OF SILENCES. */}
          <SilenceIndex rows={silenceRows} comFor={comFor} onReadAll={openAccount} />

          {/* 4 · THE BLIND EAR. */}
          <BlindEar pool={voicePool} art={art} comFor={comFor} slugFor={slugFor} />

          {/* 5 · THE SHELF — forty volumes, five lit. */}
          {volumes.length > 0 && (
            <section className="lib-sec lib-shelf-sec">
              <div className="lib-sec-h">
                <span className="lib-sec-k">the shelf</span>
                <span className="lib-sec-t">
                  {volumes.length} volumes of the entire natural world. This garden lights{' '}
                  {litVolumes.size}.
                </span>
              </div>
              <div className="lib-shelf">
                {volumes.map((v) => {
                  const lit = litVolumes.has(v.n);
                  return (
                    <div
                      className="lib-spine"
                      data-lit={lit ? 'yes' : 'no'}
                      key={`${v.n}-${v.title}`}
                      onMouseEnter={() => setShelfHover(`vol. ${volumeRoman(v.n)} · ${v.title}`)}
                      onMouseLeave={() => setShelfHover(null)}
                      onFocus={() => setShelfHover(`vol. ${volumeRoman(v.n)} · ${v.title}`)}
                      onBlur={() => setShelfHover(null)}
                      tabIndex={0}
                      aria-label={`Volume ${v.n}: ${v.title}`}
                    >
                      <span className="lib-spine-foil" aria-hidden="true" />
                      <span className="lib-spine-t">{v.title}</span>
                      <span className="lib-spine-n">{volumeRoman(v.n)}</span>
                    </div>
                  );
                })}
              </div>
              <div className="lib-shelf-cap">{shelfHover ?? ' '}</div>
            </section>
          )}

          {/* 6 · THE ROLL — the receipts. The least designed thing on the page. */}
          {roll.length > 0 && (
            <section className="lib-sec lib-roll-sec">
              <div className="lib-sec-h">
                <span className="lib-sec-k">the roll</span>
                <span className="lib-sec-t">Every species this garden has recorded.</span>
              </div>
              <table className="lib-roll">
                <thead>
                  <tr>
                    <th>modern name</th>
                    <th>1838 name</th>
                    <th className="lib-roll-vol">vol.</th>
                    <th className="lib-roll-n">calls heard</th>
                  </tr>
                </thead>
                <tbody>
                  {roll.flatMap(({ c, j }, i) => {
                    const out: ReactNode[] = [];
                    // The one dry line the ledger is allowed, and only when it
                    // is literally true of the silent rows below it.
                    if (i === firstSilent && silentCorvids > 0) {
                      out.push(
                        <tr className="lib-roll-break" key="lib-roll-break">
                          <td colSpan={4}>
                            {silentCorvids} of the silent are crows. Jardine gave the family
                            thousands of words and their voices none.
                          </td>
                        </tr>,
                      );
                    }
                    out.push(
                      <tr
                        className={j ? 'lib-roll-r' : 'lib-roll-r lib-roll-silent'}
                        key={`${c.sci_name || c.com_name}-${i}`}
                        onClick={() =>
                          onOpen?.({
                            sci: c.sci_name,
                            com: c.com_name,
                            slug: c.slug,
                            n: rows.find((r) => r.sci === c.sci_name)?.n ?? 0,
                            isNew: false,
                          })
                        }
                      >
                        <td className="lib-roll-m">{c.com_name || c.sci_name}</td>
                        {j ? (
                          <td
                            className={
                              j.drift === 'unchanged' ? 'lib-roll-o lib-roll-un' : 'lib-roll-o'
                            }
                          >
                            {j.jardine_binomial ? <JardineName species={j} /> : '—'}
                            {j.jardine_authority && (
                              <>
                                {' '}
                                <JardineName species={j} className="lib-scaps" field="authority" />
                              </>
                            )}
                          </td>
                        ) : (
                          <td className="lib-roll-o lib-roll-none">the library is silent.</td>
                        )}
                        <td className="lib-roll-vol">{j ? volumeRoman(j.volume) : ''}</td>
                        <td className="lib-roll-n">{c.detection_count.toLocaleString()}</td>
                      </tr>,
                    );
                    return out;
                  })}
                </tbody>
              </table>
              <div className="lib-roll-foot">
                {roll.length - silentCount} of {roll.length} have an account · {silentCount} do not
              </div>

              {/* The closing line: a ledger of what is present, signed off by an
                  1838 sentence about a bird disappearing. Absent from the corpus
                  → the Roll simply ends. Nothing is invented to close it. */}
              {jardine.roll_closing && (
                <div className="lib-elegy">
                  {/* the subject, named — the sentence's "it" is bound two
                      sentences earlier in the source, so printed bare the
                      pronoun dangles. The 2026 hand: this is the museum saying
                      which bird, not Jardine. */}
                  {jardine.roll_closing.subject && (
                    <span className="lib-elegy-s">{jardine.roll_closing.subject}</span>
                  )}
                  <p className="lib-elegy-t prose-nums">
                    {sicNodes(jardine.roll_closing.text, jardine.roll_closing.sic)}
                  </p>
                  <Attribution p={jardine.roll_closing} />
                </div>
              )}
            </section>
          )}

          {openSci !== null &&
            (() => {
              const sp = bySci.get(openSci);
              const ps = accounts?.[openSci];
              if (!sp || !ps || ps.length === 0) return null;
              return (
                <FullAccount
                  species={sp}
                  passages={ps}
                  com={comFor(openSci)}
                  onClose={() => setOpenSci(null)}
                />
              );
            })()}

          {/* 7 · THE COLOPHON — the museum's own honesty label. */}
          <div className="lib-colophon">
            {colophon && (
              <div className="lib-col-l">
                text extracted once on {colophon.extracted_at} from {colophon.volumes_fetched}{' '}
                volume pages · sha256 {colophon.corpus_sha256.slice(0, 12)} · {sealLine(colophon)} ·
                nothing on this page is fetched or generated at runtime
              </div>
            )}
            <div className="lib-col-l">
              Sir William Jardine, The Naturalist's Library, Edinburgh 1833–1843.{' '}
              {colophon?.credit || 'Restored and transcribed by Nicholas Rougeux, c82.net.'}{' '}
              {colophon?.licence ||
                'Illustrations CC0 1.0. Prose public domain by age.'}{' '}
              Passages are verbatim, including the printer's and the scanner's errors.
            </div>
            {catalog !== null && (
              <div className="lib-col-l">
                {passageCount} passages · {withPage.length} of {heardCount} species
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
