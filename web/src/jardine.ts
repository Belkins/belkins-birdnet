// JARDINE — the typed loader + normaliser for the committed /jardine.json:
// forty volumes of The Naturalist's Library (Edinburgh, 1833–1843), joined to
// this garden on `sci_name` and NOTHING else. The file is static, committed and
// served verbatim; nothing here is fetched, generated or paraphrased at runtime.
//
// Contract (jardine-data-contract.md) mirrored exactly, with three deliberate
// widenings — `division`, `drift` and `binomial_source` accept null — so a row
// carrying an unexpected enum value still SHELVES (its spine, its ledger row)
// instead of vanishing from the tab. Nothing is defaulted into a value the
// source did not contain.
//
// THE STRUCTURAL DEFENCE AGAINST MISATTRIBUTION: `speaker` is required and
// non-empty. normalize() DROPS any passage whose speaker is missing, blank or
// non-string — it does not default it, does not fall back to the volume author
// and does not throw. The extractor already withholds those rows; this is the
// second wall, so a flattened blockquote cannot reach a reader under the wrong
// man's name even if the data regresses.
//
// Mirrors catalog.ts's contract otherwise: a 404, an empty body or a parse
// error collapses to the empty shape and NEVER throws to the view, so the tab
// renders its honest empty states. Session-memoised exactly as fetchArtStatus()
// is, so the Library tab and the popup's return leg share one fetch.

import { parseCatalogDate } from './almanac';
import type { CatalogSpecies } from './catalog';
import { BASE, JARDINE_ACCOUNTS_URL, JARDINE_URL } from './config';
import type { RosterRow } from './types';

export type JardineDivision = 'birds' | 'mammals' | 'insects' | 'fish';
export type JardineDrift = 'unchanged' | 'spelling' | 'genus' | 'family' | 'collision';
/** How the 1838 binomial was found, weakest last. `em` is the strong path (an
 *  italic binomial line). `synonymy` and `scaps` are both WEAK and both wear the
 *  Roll's verify marker: `scaps` is the tertiary discriminator — a small-caps
 *  binomial opening an ordinary narrative paragraph, the path that recovered the
 *  Grey Lag-goose. It was previously absent from this union, so `asEnum()` nulled
 *  it and the single most weakly-sourced binomial in the corpus was the one row
 *  displaying NO verify marker. Widening is strictly additive. */
export type JardineBinomialSource = 'em' | 'synonymy' | 'scaps' | 'scaps_paragraph';
export type JardineErratumKind = 'precedence' | 'slip' | 'collision';
export type JardineSubjectRole = 'garden' | 'library' | 'absent';
/** 'all_absent'     — holds while NONE of the subjects has been recorded here.
 *  'subject_is_top' — holds while a subject is the most-recorded species. */
export type JardineClosingRequires = 'all_absent' | 'subject_is_top';

/** One OCR artefact preserved verbatim, with the note the [sic] marker carries. */
export interface JardineSic {
  find: string;
  note: string;
  /** Where the extractor FOUND this artefact. A needle can occur more than once
   *  in a passage and only one of them is the scanner's error — "Ireland" is
   *  flagged in one sentence and correct in the next — so the offset is what
   *  makes the marker precise rather than approximate. null when the source did
   *  not record one; sicSpans() then falls back to the first occurrence. */
  offset: number | null;
}

/** A verbatim 1838 passage. `speaker` is REQUIRED — see the file header. */
export interface JardinePassage {
  text: string;
  speaker: string;
  /** true => the text sat inside a <blockquote>; the speaker is NOT the volume author. */
  is_quotation: boolean;
  volume: number;
  volume_title: string;
  volume_author: string;
  /** Volume page only — c82 has one id across 141 headings, so no per-passage anchor exists. */
  source_url: string;
  sic: JardineSic[];
  /** How many passages the extraction REFUSED immediately after this one.
   *  Almost always 0. Non-zero means Jardine's next sentences were a quotation
   *  the protocol would not publish — its speaker is only 'probable', and a
   *  probable name in 30px Cormorant under a real person is the one
   *  unrecoverable failure here. The refusal is correct; printing the prose as
   *  though nothing were missing is not, because Jardine's own lead-in runs
   *  into it ("Mr Hewitson relates his knowledge of one which") and the passage
   *  then stops mid-clause. */
  elided_after: number;
  /** The account heading this sentence was lifted from, VERBATIM ("The Common
   *  Crane"). Null on every passage that is already rendered beside its own
   *  bird — it exists for the Roll's closer, which is the one passage on the
   *  tab that stands alone. Its sentence is "In Ireland it has not been seen
   *  for a hundred years", and the "it" is bound two sentences earlier in the
   *  source: printed bare, the pronoun dangles and the reader cannot know which
   *  bird vanished. Naming the subject is the difference between an elegy and a
   *  riddle, and the name is the source's own heading, not a caption. */
  subject: string | null;
}

export interface JardineVolume {
  n: number;
  title: string;
  /** null only when the source carried a division this build does not know. */
  division: JardineDivision | null;
  /** null for the 36 volumes not fetched; only the 4 bird volumes carry a verified author. */
  author: string | null;
}

export interface JardineSpecies {
  /** ★ THE JOIN KEY — the raw BirdNET V2.4 binomial. Never join on slug or common name. */
  sci_name: string;
  /** Redundant asset key. NEVER used to join. */
  slug: string;
  jardine_title: string;
  jardine_binomial: string;
  jardine_authority: string;
  /** OCR artefacts in the TWO fields above — the scanner's `cælebes` for
   *  `cælebs`, its `Linneas` for `Linnæus`. Kept verbatim and worn with a
   *  visible [sic] in the Roll, never repaired: see the file header. A needle
   *  may sit in EITHER field, so both are rendered through sicNodes(). */
  sic: JardineSic[];
  /** 'synonymy' and 'scaps' are BOTH weak paths; each is surfaced in the Roll as
   *  a dotted underline carrying its own verify tooltip. 'em' is the strong one. */
  binomial_source: JardineBinomialSource | null;
  volume: number;
  volume_title: string;
  volume_author: string;
  source_url: string;
  plate_ref: string | null;
  plate_is_vignette: boolean;
  /** The engraving itself, once tools/jardine/link_plates.py has adjudicated it.
   *  Path RELATIVE to BASE — resolve with jardineImageUrl(). */
  image: string | null;
  image_w: number | null;
  image_h: number | null;
  /** OTHER birds figured on the same sheet. Jardine drew two species on one
   *  plate more than once — a Spotted Sandpiper beside the Common, a Firecrest
   *  above the Goldcrest, the American teal beside the European — and a caption
   *  naming one of them tells a visitor the other bird IS that species. Never
   *  print a shared plate without printing this. */
  plate_also: JardinePlateFigure[];
  /** Where on the sheet this bird is, so a dual caption can point. */
  plate_where: string | null;
  /** 'depicted' — the picture shows this bird. 'plate-list' — the VOLUME assigns
   *  the plate to this bird and the picture does not identify itself, which is
   *  the difference between a citation and a claim. */
  plate_attribution: JardinePlateAttribution;
  /** Why the attribution is only as strong as it is. Printed, not hidden. */
  plate_note: string | null;
  drift: JardineDrift | null;
  /** null IS content — the Blue Tit ships voice:null and the Roll says so. */
  voice: JardinePassage | null;
  /** The second movement: the Song Thrush climate line, the Blue Tit door-capital line. */
  coda: JardinePassage | null;
  note: string | null;
}

export type JardinePlateAttribution = 'depicted' | 'plate-list';

/** One bird on a shared plate, and where it stands. */
export interface JardinePlateFigure {
  sci_name: string;
  common: string;
  where: string;
}

export interface JardineErratumSubject {
  sci_name: string;
  role: JardineSubjectRole | null;
  jardine_plate: string | null;
  /** Path RELATIVE to BASE — resolve with jardineImageUrl(). */
  image: string | null;
  image_w: number | null;
  image_h: number | null;
  /** Jardine's OWN relative size: 1.0 for a full plate, 0.38 for a vignette. */
  scale: number;
}

export interface JardineErratum {
  no: string;
  kind: JardineErratumKind | null;
  headline: string;
  quote: JardinePassage | null;
  closing: string | null;
  /** What the closing SENTENCE depends on to stay true, or null when it is a
   *  timeless remark about the book. Two of the five make live claims about the
   *  garden — "Agreed." concedes that a bird is absent, and one asserts which
   *  bird is most-recorded — and both used to print unconditionally, so the day
   *  the data moved the museum would have gone on asserting them. The card's
   *  tone already flipped; the sentence did not. */
  closing_requires: JardineClosingRequires | null;
  subjects: JardineErratumSubject[];
}

export interface JardineColophon {
  extracted_at: string;
  corpus_sha256: string;
  source_url: string;
  credit: string;
  licence: string;
  verified_by: string;
  verified_at: string;
  volumes_fetched: number;
}

export interface Jardine {
  version: number;
  epigraph: JardinePassage | null;
  colophon: JardineColophon | null;
  volumes: JardineVolume[];
  species: JardineSpecies[];
  errata: JardineErratum[];
  /** The Roll's closing line — an 1838 sentence about a bird disappearing, set
   *  beneath the ledger of what is present. Optional: absent → the Roll simply
   *  ends, it never invents a closer. */
  roll_closing: JardinePassage | null;
}

/** The shape every failure resolves to. A tab rendered from this shows its
 *  honest empty states — no spinner, no error, no fabricated content. */
export const EMPTY_JARDINE: Jardine = {
  version: 0,
  epigraph: null,
  colophon: null,
  volumes: [],
  species: [],
  errata: [],
  roll_closing: null,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asNullableString(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0;
}

function asNullableNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) && v !== null && v !== '' && v !== undefined ? n : null;
}

/** Narrow an untrusted string to one of a known set, else null. Never coerces
 *  an unknown value into a known one — an unrecognised enum reads as "unknown",
 *  which the views render quietly, rather than as a fabricated classification. */
function asEnum<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

const DIVISIONS: readonly JardineDivision[] = ['birds', 'mammals', 'insects', 'fish'];
const DRIFTS: readonly JardineDrift[] = ['unchanged', 'spelling', 'genus', 'family', 'collision'];
const SOURCES: readonly JardineBinomialSource[] = ['em', 'synonymy', 'scaps', 'scaps_paragraph'];
const KINDS: readonly JardineErratumKind[] = ['precedence', 'slip', 'collision'];
const ROLES: readonly JardineSubjectRole[] = ['garden', 'library', 'absent'];
const REQUIRES: readonly JardineClosingRequires[] = ['all_absent', 'subject_is_top'];

function asSic(v: unknown): JardineSic[] {
  if (!Array.isArray(v)) return [];
  const out: JardineSic[] = [];
  for (const item of v) {
    if (!isRecord(item)) continue;
    const find = asString(item.find);
    if (!find) continue; // an empty needle would match everywhere / nowhere
    out.push({ find, note: asString(item.note), offset: asNullableNumber(item.offset) });
  }
  return out;
}

/** THE SECOND WALL. A passage with a missing, blank or non-string speaker is
 *  DROPPED — never defaulted, never attributed to the volume author. A passage
 *  with no text is equally useless and goes the same way. */
function asPassage(v: unknown): JardinePassage | null {
  if (!isRecord(v)) return null;
  const speaker = typeof v.speaker === 'string' ? v.speaker.trim() : '';
  if (!speaker) return null;
  const text = asString(v.text);
  if (!text.trim()) return null;
  return {
    text,
    speaker,
    is_quotation: v.is_quotation === true,
    volume: asNumber(v.volume),
    volume_title: asString(v.volume_title),
    volume_author: asString(v.volume_author),
    source_url: asString(v.source_url),
    sic: asSic(v.sic),
    // a malformed or absent count is 0 — never a marker the data cannot justify
    elided_after:
      typeof v.elided_after === 'number' && Number.isInteger(v.elided_after) && v.elided_after > 0
        ? v.elided_after
        : 0,
    subject: asNullableString(v.subject),
  };
}

function asVolumes(v: unknown): JardineVolume[] {
  if (!Array.isArray(v)) return [];
  const out: JardineVolume[] = [];
  for (const item of v) {
    if (!isRecord(item)) continue;
    const title = asString(item.title);
    const n = asNumber(item.n);
    if (!title && !n) continue; // no spine to shelve
    out.push({
      n,
      title,
      division: asEnum(item.division, DIVISIONS),
      author: asNullableString(item.author),
    });
  }
  return out;
}

function asSpecies(v: unknown): JardineSpecies[] {
  if (!Array.isArray(v)) return [];
  const out: JardineSpecies[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (!isRecord(item)) continue;
    const sci_name = asString(item.sci_name).trim();
    if (!sci_name) continue; // no join key → the row can never be shown against a bird
    if (seen.has(sci_name)) continue; // one account per binomial; first wins
    seen.add(sci_name);
    out.push({
      sci_name,
      slug: asString(item.slug),
      jardine_title: asString(item.jardine_title),
      jardine_binomial: asString(item.jardine_binomial),
      jardine_authority: asString(item.jardine_authority),
      sic: asSic(item.sic),
      binomial_source: asEnum(item.binomial_source, SOURCES),
      volume: asNumber(item.volume),
      volume_title: asString(item.volume_title),
      volume_author: asString(item.volume_author),
      source_url: asString(item.source_url),
      plate_ref: asNullableString(item.plate_ref),
      plate_is_vignette: item.plate_is_vignette === true,
      image: asNullableString(item.image),
      image_w: asNullableNumber(item.image_w),
      image_h: asNullableNumber(item.image_h),
      plate_also: asFigures(item.plate_also),
      plate_where: asNullableString(item.plate_where),
      // Anything unrecognised degrades to the WEAKER claim. A corrupt or
      // future value must not silently promote a citation into an assertion.
      plate_attribution: item.plate_attribution === 'depicted' ? 'depicted' : 'plate-list',
      plate_note: asNullableString(item.plate_note),
      drift: asEnum(item.drift, DRIFTS),
      voice: asPassage(item.voice),
      coda: asPassage(item.coda),
      note: asNullableString(item.note),
    });
  }
  return out;
}

/** A co-occupant is only useful if it can be NAMED and POINTED AT, so a figure
 *  missing either is dropped rather than half-printed. Dropping is safe here
 *  only because test E4 fails when a shared plate loses its co-occupant. */
function asFigures(v: unknown): JardinePlateFigure[] {
  if (!Array.isArray(v)) return [];
  const out: JardinePlateFigure[] = [];
  for (const item of v) {
    if (!isRecord(item)) continue;
    const sci_name = asString(item.sci_name).trim();
    const common = asString(item.common).trim();
    const where = asString(item.where).trim();
    if (!sci_name || !where) continue;
    out.push({ sci_name, common: common || sci_name, where });
  }
  return out;
}

function asSubjects(v: unknown): JardineErratumSubject[] {
  if (!Array.isArray(v)) return [];
  const out: JardineErratumSubject[] = [];
  for (const item of v) {
    if (!isRecord(item)) continue;
    const sci_name = asString(item.sci_name).trim();
    if (!sci_name) continue;
    const scale = typeof item.scale === 'number' && Number.isFinite(item.scale) ? item.scale : 1;
    out.push({
      sci_name,
      role: asEnum(item.role, ROLES),
      jardine_plate: asNullableString(item.jardine_plate),
      image: asNullableString(item.image),
      image_w: asNullableNumber(item.image_w),
      image_h: asNullableNumber(item.image_h),
      // Jardine's own relative size is the whole argument of the vitrine —
      // clamp only against nonsense, never normalise it away.
      scale: scale > 0 && scale <= 4 ? scale : 1,
    });
  }
  return out;
}

function asErrata(v: unknown): JardineErratum[] {
  if (!Array.isArray(v)) return [];
  const out: JardineErratum[] = [];
  for (const item of v) {
    if (!isRecord(item)) continue;
    const headline = asString(item.headline);
    const no = asString(item.no);
    if (!headline && !no) continue;
    out.push({
      no,
      kind: asEnum(item.kind, KINDS),
      headline,
      quote: asPassage(item.quote),
      closing: asNullableString(item.closing),
      closing_requires: asEnum(item.closing_requires, REQUIRES),
      subjects: asSubjects(item.subjects),
    });
  }
  return out;
}

function asColophon(v: unknown): JardineColophon | null {
  if (!isRecord(v)) return null;
  return {
    extracted_at: asString(v.extracted_at),
    corpus_sha256: asString(v.corpus_sha256),
    source_url: asString(v.source_url),
    credit: asString(v.credit),
    licence: asString(v.licence),
    verified_by: asString(v.verified_by),
    verified_at: asString(v.verified_at),
    volumes_fetched: asNumber(v.volumes_fetched),
  };
}

/** Coerce the untrusted committed JSON into the Jardine shape, dropping
 *  anything that isn't usable so no view ever sees a malformed row. */
export function normalize(raw: unknown): Jardine {
  if (!isRecord(raw)) return EMPTY_JARDINE;
  return {
    version: asNumber(raw.version),
    epigraph: asPassage(raw.epigraph),
    colophon: asColophon(raw.colophon),
    volumes: asVolumes(raw.volumes),
    species: asSpecies(raw.species),
    errata: asErrata(raw.errata),
    roll_closing: asPassage(raw.roll_closing),
  };
}

/** Resolve a committed engraving path against the app base ('jardine/24-11.jpg'
 *  → '/collage/jardine/24-11.jpg'). Null in, null out. */
/** THE SEAL. The colophon's one job is to be the honest label on a wall of
 *  honest labels, and it was the least honest line on the tab: it printed
 *  "hand-proofed by {verified_by} on {verified_at}" unconditionally, and BOTH
 *  fields are null in the committed corpus. asString() coerces null to '', so
 *  the museum shipped the sentence "hand-proofed by  on " — a claim of human
 *  acceptance that has never happened, rendered as two blanks nobody reads.
 *
 *  Two states, derived from the COMMITTED FILE and nothing else. No local
 *  state, no session flag and no UI affordance may ever promote the unsigned
 *  string to the signed one: a seal that a reader can set is not a seal. A
 *  machine may verify the sha256 — that is arithmetic — but only a human may
 *  sign for having read the prose, so this returns the unsigned string until
 *  the JSON itself carries a name AND a date. */
export function sealLine(c: JardineColophon | null): string {
  if (!c) return 'the acceptance pass is unsigned';
  const who = c.verified_by.trim();
  const when = c.verified_at.trim();
  return who && when
    ? `hand-proofed by ${who} on ${when}`
    : 'the acceptance pass is unsigned — no human has yet signed for this text';
}

const ROMAN: ReadonlyArray<readonly [number, string]> = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

/** Volume numbers are set the way the volumes are set: VOL. XXIV. One copy,
 *  because there were three — BirdPopup's exported volumeRoman, and a private
 *  `roman` in each of the two Library views. Identical today; three chances to
 *  diverge tomorrow. Living here also stops BirdPopup exporting a non-component,
 *  which was the file's only lint warning. */
export function volumeRoman(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  let v = Math.floor(n);
  let out = '';
  for (const [value, glyph] of ROMAN) {
    while (v >= value) {
      out += glyph;
      v -= value;
    }
  }
  return out;
}

/** One run of a passage: plain prose, or a preserved OCR artefact with the note
 *  that explains it. */
export interface SicSpan {
  text: string;
  sic: JardineSic | null;
}

/** THE ONE [sic] ENGINE. Splits a passage into runs so every surface marks the
 *  same characters, with the same note, in the same places.
 *
 *  It replaces two implementations that had quietly diverged. LibraryView's
 *  consumed the string and so marked EVERY occurrence of a needle; the frame's
 *  called indexOf once and so marked only the FIRST; and the frame's typed its
 *  input as `{find}` alone, which meant the curator's note — the entire
 *  explanation of the artefact — was structurally unreachable on the wall.
 *
 *  This is more precise than either. A needle can occur several times while only
 *  one is the scanner's error ("Ireland" is flagged in one sentence and correct
 *  in the next), so the RECORDED OFFSET wins whenever it still lands on the
 *  needle, and indexOf is only the fallback for a row that carries none. An
 *  offset that no longer validates is treated as absent rather than trusted —
 *  the text is the authority, not a number that may have drifted from it. */
export function sicSpans(text: string, sic: JardineSic[]): SicSpan[] {
  const hits: Array<{ at: number; s: JardineSic }> = [];
  for (const s of sic) {
    if (!s || typeof s.find !== 'string' || s.find === '') continue; // '' matches everywhere
    const o = s.offset;
    const at =
      typeof o === 'number' && o >= 0 && text.slice(o, o + s.find.length) === s.find
        ? o
        : text.indexOf(s.find);
    if (at < 0) continue;
    hits.push({ at, s });
  }
  if (hits.length === 0) return [{ text, sic: null }];
  hits.sort((a, b) => a.at - b.at);

  const out: SicSpan[] = [];
  let cur = 0;
  for (const h of hits) {
    if (h.at < cur) continue; // overlapping markers — the earliest wins
    if (h.at > cur) out.push({ text: text.slice(cur, h.at), sic: null });
    out.push({ text: text.slice(h.at, h.at + h.s.find.length), sic: h.s });
    cur = h.at + h.s.find.length;
  }
  if (cur < text.length) out.push({ text: text.slice(cur), sic: null });
  return out;
}

/** THE WEAK-PATH RULE — the ONE authority, exported because it had three
 *  implementations and they disagreed.
 *
 *  Two of the three discriminators are weak and BOTH must wear the verify
 *  marker: `synonymy` reads the binomial off a synonymy line, `scaps` off a
 *  small-caps run opening a narrative paragraph. `em` is the strong path.
 *  Returns the tooltip when the row is weak and null when it is strong, so a
 *  marker can never appear without its explanation.
 *
 *  IT LIVES HERE, NOT IN A VIEW. It was previously a private function in
 *  LibraryView, which meant the Roll classified both weak paths while the
 *  Index of Silences printed no marker at all (most of its rows are weak) and
 *  BirdPopup hand-rolled `=== 'synonymy'` with the tooltip inlined, so the
 *  dossier and the Roll gave contradictory provenance for the same binomial.
 *  Every consumer must call THIS — a copy is how the three drifted apart. */
export function weakSource(s: JardineSpecies): string | null {
  switch (s.binomial_source) {
    case 'synonymy':
      return 'read from the synonymy line; verify';
    case 'scaps':
    case 'scaps_paragraph':
      // BOTH spellings, because the producer and the committed file disagree:
      // extract.py writes 'scaps_paragraph' (extract.py:974) while
      // jardine.json carries 'scaps'. Accepting only one means the next
      // extractor re-run silently re-opens the very hole this case was added to
      // close — asEnum() nulls the value and the corpus's weakest binomial goes
      // back to printing as though it were certain.
      return 'read from a small-caps opening line; verify';
    default:
      return null;
  }
}

/** What the library has to say about a bird: either an 1838 sentence, or the
 *  museum's own account of why there isn't one. */
export type Counterpoint =
  | { kind: 'voice'; passage: JardinePassage }
  | { kind: 'silence'; note: string }
  | null;

/** THE ONE BRANCH POINT. Every surface that asks "what did the library say
 *  about this bird" must ask HERE, so the dossier and the Library can never
 *  disagree about which birds are silent.
 *
 *  THE TEST IS `voice === null`, NEVER `note !== null`. Five species carry BOTH
 *  a voice and a note — Erithacus rubecula, Phylloscopus collybita, Picus
 *  viridis, Psittacula krameri, Sitta europaea — and on those the note is
 *  commentary, not an absence. Branching on the note would print "the library
 *  never described its voice" under five birds whose voices Jardine described
 *  at length, which is a fabricated absence: the same class of error as a
 *  fabricated presence, and harder to spot because it reads as modesty. */
export function counterpointFor(s: JardineSpecies | null | undefined): Counterpoint {
  if (!s) return null;
  if (s.voice) return { kind: 'voice', passage: s.voice };
  const note = (s.note ?? '').trim();
  return note ? { kind: 'silence', note } : null;
}

/** The birds Jardine described without ever describing their sound, loudest
 *  first — the Pi's tally, descending.
 *
 *  The Roll is ordered by drift and never by tally, deliberately; this section
 *  inverts that ON PURPOSE and the inversion is the whole argument. Sorted this
 *  way the ledger opens on the bird this garden shouts about most and the
 *  library is quietest on. Do not "fix" this to match the Roll.
 *
 *  A silence with no note is not shown: an unexplained blank is indistinguishable
 *  from a bug, and this section exists to make absence legible. */
export function silences(
  j: Jardine,
  catalog: CatalogSpecies[],
): Array<{ species: JardineSpecies; count: number }> {
  const tally = new Map(catalog.map((c) => [c.sci_name, c.detection_count]));
  return j.species
    .filter((s) => s.voice === null && (s.note ?? '').trim() !== '')
    .map((s) => ({ species: s, count: tally.get(s.sci_name) ?? 0 }))
    // THE GARDEN MUST HAVE AN ANSWER. This section's whole argument is "the book
    // is silent and the microphone is not", so a bird THIS station has never
    // heard makes no argument: it would print a bare `0 recorded here` beside a
    // Listen button that 404s.
    //
    // Not hypothetical, and invisible in the fixture — which is why it shipped.
    // The committed 47-row fixture and the LIVE station are different sets of 47:
    // the fixture carries Herring Gull and Starling, the station has never heard
    // either, and both are silence rows. Measured against the live catalog on
    // 2026-07-27. Any editorial claim on this tab must be checked against
    // production, never against the fixture that makes it look true.
    .filter((r) => r.count > 0)
    // code-unit order for the tie-break, for the same determinism reason as
    // deskPool: a stable ledger must not reorder itself per viewer.
    .sort((a, b) => b.count - a.count ||
      (a.species.sci_name < b.species.sci_name ? -1 : a.species.sci_name > b.species.sci_name ? 1 : 0));
}

/** Does this erratum's closing SENTENCE still hold?
 *
 *  A closing with no declared contingency is a remark about the book and always
 *  holds. The two that make claims about the garden are checked against the
 *  catalog every render — never committed, never cached — so the museum stops
 *  saying them the moment they stop being true rather than the moment somebody
 *  notices.
 *
 *  An EMPTY catalog holds nothing: with no ledger to check against, an unproven
 *  claim is not a true one. That is the same rule the errata's own garden facts
 *  follow, and the opposite of what this project has shipped three times. */
export function closingHolds(
  e: JardineErratum,
  byCatalog: Map<string, CatalogSpecies>,
): boolean {
  if (e.closing_requires === null) return true;
  if (byCatalog.size === 0) return false;
  const subjects = new Set(e.subjects.map((s) => s.sci_name));
  if (e.closing_requires === 'all_absent') {
    for (const sci of subjects) {
      const c = byCatalog.get(sci);
      if (c && heardHere(c)) return false;
    }
    return true;
  }
  // 'subject_is_top' — a subject must be the SINGLE most-recorded species here.
  //
  // Counting the maximum and then requiring exactly one holder, rather than
  // keeping the first row that ties: a tie decided by catalog ORDER made the
  // claim flip depending on how species.json happened to be sorted, which is not
  // a property of the garden. On a tie nobody is "the most-recorded bird", so
  // the sentence must not print at all.
  let max = -Infinity;
  for (const c of byCatalog.values()) max = Math.max(max, c.detection_count || 0);
  if (max <= 0) return false; // nothing recorded — nothing can be top
  const tops: string[] = [];
  for (const c of byCatalog.values()) {
    if ((c.detection_count || 0) === max) tops.push(c.sci_name);
  }
  return tops.length === 1 && subjects.has(tops[0]);
}

export function jardineImageUrl(image: string | null): string | null {
  if (!image) return null;
  return `${BASE}${image.replace(/^\/+/, '')}`;
}

/** ── THE ROLL'S BANDS — a caption and its proof, as one object ───────────────
 *
 *  The Roll is ordered by how far a name travelled since 1838, and each tier
 *  prints a line explaining what its rows have in common. I wrote those lines
 *  from my head and shipped them, and three of the five were FALSE of the data
 *  sitting directly underneath them:
 *
 *  · "names Linnæus set" — 15 rows, of which only 8 attribute to Linnæus in any
 *    spelling. Two say Latham, one Willughby, four carry no authority at all.
 *    The museum credited a man for names its own cells credit to someone else.
 *  · "the same name, spelled the way 1838 spelled it" — 14 rows, of which ZERO
 *    have an identical binomial. `Alcedo ispida` → `Alcedo atthis` is not a
 *    spelling variant, it is a different bird's worth of epithet.
 *  · "moved to another genus since" — false for `Anser ferus` → `Anser anser`.
 *
 *  A heading is a claim. So each band now carries the predicate that makes its
 *  sentence true, and a test asserts every row in the tier satisfies it. The
 *  caption cannot drift from the data again without the suite going red,
 *  because the caption and the check are the same object. */
export interface JardineDriftBand {
  /** What the tier below this heading has in common. Must be TRUE of every row. */
  label: string;
  /** The property that makes the label true, per species. */
  holds: (jardineBinomial: string, sciName: string) => boolean;
}

/** Victorian orthography, normalised away: æ/ae/oe → e, accents stripped, case
 *  folded. `Hæmatopus` and `Haematopus` are the same word printed twice. */
function orth(word: string): string {
  return word
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/æ|ae|oe/g, 'e');
}
function binomialWords(b: string): [string, string] {
  const p = b.trim().split(/\s+/);
  return [p[0] ?? '', p[1] ?? ''];
}
/** How many of the two words differ once Victorian spelling is normalised. */
function wordsMoved(a: string, b: string): number {
  const x = binomialWords(a);
  const y = binomialWords(b);
  return (orth(x[0]) !== orth(y[0]) ? 1 : 0) + (orth(x[1]) !== orth(y[1]) ? 1 : 0);
}

export const DRIFT_BANDS: Record<string, JardineDriftBand> = {
  unchanged: {
    label: 'the same binomial in 1838 and now — letter for letter',
    holds: (j, s) => j === s,
  },
  spelling: {
    label: 'the same bird one word away — a Victorian spelling, or a second name since replaced',
    holds: (j, s) => wordsMoved(j, s) <= 1,
  },
  genus: {
    label: 'the name has moved further — a different genus, or a different species within it',
    holds: (j, s) => j !== s,
  },
  family: {
    label: 'both halves of the name changed — the bird was refiled entirely',
    holds: (j, s) => wordsMoved(j, s) === 2,
  },
  collision: {
    label: 'the 1838 name now belongs to a DIFFERENT bird',
    holds: (j, s) => j !== s,
  },
};

/** ── TWO DECISIONS LIFTED OUT OF JSX, SO A TEST CAN CALL THEM ────────────────
 *
 *  A mutation sweep proved both of the guards protecting these were blind to
 *  the thing they guarded, because both asserted SOURCE TEXT:
 *
 *  · E6 pinned the regex `phase !== 'ready' … return null`, which cannot see the
 *    OPERATOR. Flipping `||` to `&&` keeps the regex matching and re-opens the
 *    25 fabricated attributions the guard was written for — `!src` is always
 *    false on the live station (birdImageUrl always returns a string off MOCK),
 *    so `A && false` never fires and StationBird renders the placeholder
 *    silhouette under "AI visualized by this station".
 *  · E4 guards the shared-plate DATA. Nothing guarded the CAPTION, so deleting
 *    one <span> made a two-bird engraving name one bird, suite green.
 *
 *  A regex over source is a guard on spelling. These are the decisions
 *  themselves; the tests call them with arguments and check the answers. */
/** A type predicate, so the COMPILER also refuses a caption over a null image —
 *  two independent walls between the claim and a picture that cannot support it. */
export function stationClaimAllowed(phase: string, src: string | null): src is string {
  return phase === 'ready' && !!src;
}

/** Everything a plate's caption is REQUIRED to say about this bird. */
export interface JardinePlateCaption {
  /** Co-occupants that must be named, or the caption asserts the other bird is this one. */
  mustName: string[];
  /** True when the VOLUME assigns the plate and the picture does not identify itself. */
  mustDisclaimCitation: boolean;
  /** The reason a citation is only a citation. Printed, never hidden. */
  note: string | null;
  /** Where this bird stands, so a dual caption can point. */
  where: string | null;
}

export function plateCaption(sp: JardineSpecies): JardinePlateCaption {
  // NO PLATE, NO OBLIGATIONS. `plate_attribution` defaults to the weaker claim
  // ('plate-list') for any row that does not say 'depicted' — deliberately, so a
  // corrupt field cannot promote a citation into an assertion — which means all
  // 27 birds Jardine never figured also carry it, with no note. They are not
  // cited from a plate list; they have no plate at all, and a caption cannot
  // disclaim an attribution that was never made.
  if (!sp.image) return { mustName: [], mustDisclaimCitation: false, note: null, where: null };
  return {
    mustName: sp.plate_also.map((a) => a.common || a.sci_name),
    mustDisclaimCitation: sp.plate_attribution === 'plate-list',
    note: sp.plate_note,
    where: sp.plate_where,
  };
}

/** sci_name → account. The ONE join, built once per corpus by the callers. */
export function speciesBySci(j: Jardine): Map<string, JardineSpecies> {
  const m = new Map<string, JardineSpecies>();
  for (const s of j.species) m.set(s.sci_name, s);
  return m;
}

/** The first sentence of a passage, VERBATIM — a slice of the source string,
 *  never a rewrite. Used by the popup's return leg, where one sentence is all
 *  the room there is. Falls back to the whole text when no terminator is found. */
export function firstSentence(text: string): string {
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(text.trim());
  return (m ? m[0] : text).trim();
}

// ── THE READING DESK selector ────────────────────────────────────────────────
// The desk's two-tier pick, and the only job the shared 1H/12H/24H/7D filter
// has anywhere in the museum. It lives HERE, not in LibraryView.tsx: node
// --test strips types but cannot parse JSX, so a selector inside the view is a
// selector nothing can ever test — and this is the tab's signature.

/** 1..366, local time. The rotation's clock — no cron, no storage, no model. */
export function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getFullYear(), 0, 0);
  const today = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.floor((today - start) / 86400000);
}

/** Has this garden actually heard the bird? Presence in the nightly catalog
 *  with a real detection — parsed by the ONE date parser in the tree
 *  (almanac.parseCatalogDate, which handles both the prod
 *  'YYYY-MM-DD HH:MM:SS' and the fixture's bare 'YYYY-MM-DD'). */
/** Has this garden actually recorded the bird? EITHER a parseable last_detected
 *  OR a non-zero tally — a row with a real count and a missing timestamp has
 *  still been heard. Exported because the frame tested `last_detected` alone and
 *  therefore printed "not yet heard in this garden" about birds the Pi had
 *  recorded: a fabricated ABSENCE, the same class as a fabricated presence. */
export function heardHere(c: CatalogSpecies): boolean {
  return parseCatalogDate(c.last_detected) !== null || (c.detection_count || 0) > 0;
}

/** The rotation pool: voice-carrying accounts for species PRESENT IN THE
 *  CATALOG, in a stable order. A bird this garden has never recorded is never
 *  set on the desk — that would put an 1838 passage above a band with no
 *  recording under it, which is the off-Pi state rendered for a bird that was
 *  never on the Pi. Empty pool = honest silence; species #48 files itself. */
export function deskPool(species: JardineSpecies[], catalog: CatalogSpecies[]): JardineSpecies[] {
  const heard = new Set<string>();
  for (const c of catalog) if (heardHere(c)) heard.add(c.sci_name);
  return species
    .filter((s) => s.voice !== null && heard.has(s.sci_name))
    // CODE-UNIT ORDER, not localeCompare. The rotation promises to be
    // "deterministic for a given date, so the passage never changes mid-read" —
    // but localeCompare is locale-SENSITIVE, so two visitors reading the museum
    // on the same day under different locales were shown different passages, and
    // the frame and a phone could disagree. A machine key wants a machine order.
    .sort((a, b) => (a.sci_name < b.sci_name ? -1 : a.sci_name > b.sci_name ? 1 : 0));
}

export interface DeskPick {
  species: JardineSpecies;
  /** 'aimed' = the reader named this bird (tier 0); 'live' = audible in the
   *  current window (tier 1); 'rotation' = the day's page. */
  source: 'aimed' | 'live' | 'rotation';
}

export interface DeskArgs {
  /** jardine.species[], unfiltered — the voice filter is the selector's job. */
  species: JardineSpecies[];
  /** The live roster App.tsx passes every view, for the CURRENT period window. */
  rows: RosterRow[];
  /** fetchCatalog() — the rotation pool is the catalog intersection. */
  catalog: CatalogSpecies[];
  /** settings.windowHours, straight off the shared period filter. */
  windowHours: number;
  now: Date;
  /** THE AIM (?read=) — the species the reader asked for by name, from the
   *  dossier's "in the library →". Tier ZERO: an explicit request outranks both
   *  the loudest-live rule and the daily rotation, because otherwise that button
   *  lands on whatever is loudest, and with this garden's 81% three-bird
   *  concentration that is the Robin or the Parakeet almost regardless of which
   *  bird the reader clicked. Unknown name → ignored, and the desk chooses. */
  aim?: string | null;
  /** "☞ another passage" — how many pages forward of today's the reader has
   *  turned. Local view state, never persisted and never URL-bound. Any step
   *  above 0 also leaves the live bird behind: turning the page is a request
   *  for a DIFFERENT passage, not a re-roll of the same one. */
  step?: number;
}

/** THE DIAL. 1H/12H/24H are real recency bands, and inside them the desk
 *  answers a bird heard NOW — the one place the museum's shared filter means
 *  anything. Above that it stops claiming one: "heard here 12 minutes ago"
 *  under a 7-day window is a lie with a timestamp on it, and ALL (1,000,000
 *  hours) is not a window at all. */
const LIVE_WINDOW_MAX_HOURS = 24;

/** TIER 1 — inside a real recency band, the LOUDEST bird in the window that the
 *  library actually described. A live bird Jardine never wrote about (the Rook:
 *  he gave the corvids thousands of words and their voices none) must NOT
 *  displace one he did, or the desk is empty at dawn.
 *  TIER 2 — otherwise day-of-year over the pool: a different page every morning,
 *  deterministic for a given date, so the passage never changes mid-read.
 *  Neither → null. The desk renders its honest silence; it never invents a page. */
export function pickDeskSpecies(a: DeskArgs): DeskPick | null {
  // Number.isFinite FIRST, and it is load-bearing rather than defensive noise.
  // Math.floor(Infinity) is Infinity, Math.max(0, Infinity) is Infinity, and
  // Infinity is truthy, so the old `|| 0` passed it straight through to the
  // modulus below — where Infinity % pool.length is NaN and pool[NaN] is
  // undefined. That returned a DeskPick whose species is undefined: a shape
  // TypeScript accepts and the signature tab then renders as nothing at all.
  // NaN takes the same path (it only survived before by accident, being falsy).
  const rawStep = a.step ?? 0;
  const step = Number.isFinite(rawStep) ? Math.max(0, Math.floor(rawStep)) : 0;

  // TIER ZERO — guarded on `step === 0` ALONE. It must NOT inherit tier one's
  // `windowHours <= LIVE_WINDOW_MAX_HOURS` clause: a reader on a 7-day window
  // would then be silently un-aimed, and a guard scoped one clause too wide is
  // this project's recorded failure mode. Turning the page (step > 0) IS a
  // request for a different passage, so it releases the aim.
  //
  // The aim is honoured even when the species has NO voice: the desk answers
  // with the library's silence for that bird, which is the true answer and the
  // one the reader asked for. Falling through to rotation here would send them
  // to an unrelated bird and call it an answer.
  if (step === 0 && a.aim) {
    const aimed = a.species.find((s) => s.sci_name === a.aim);
    if (aimed) return { species: aimed, source: 'aimed' };
  }

  if (step === 0 && a.windowHours <= LIVE_WINDOW_MAX_HOURS) {
    const voiced = new Map<string, JardineSpecies>();
    for (const s of a.species) if (s.voice !== null) voiced.set(s.sci_name, s);
    let best: JardineSpecies | null = null;
    let bestN = -Infinity;
    for (const r of a.rows) {
      const s = voiced.get(r.sci);
      if (!s) continue;
      if (r.n > bestN) {
        bestN = r.n;
        best = s;
      }
    }
    if (best) return { species: best, source: 'live' };
  }

  const pool = deskPool(a.species, a.catalog);
  if (pool.length === 0) return null;
  return { species: pool[(dayOfYear(a.now) + step) % pool.length], source: 'rotation' };
}

// Session-memoised like fetchArtStatus(): the tab and the popup share one
// fetch. An unreachable/empty corpus clears the memo so a later mount retries.
let jardinePromise: Promise<Jardine> | null = null;

/** The corpus. Never throws — see the file header. */
/** sci_name -> every verified passage of that bird's account, in printed order. */
export type JardineAccounts = Record<string, JardinePassage[]>;

let accountsPromise: Promise<JardineAccounts> | null = null;

/** THE FULL ACCOUNT, lazily. Same contract as fetchJardine(): session-memoised,
 *  never throws, and a 404 / empty body / malformed payload collapses to {} so
 *  the reading affordance simply never appears. The rows go through the SAME
 *  asPassage() the curated file uses, so the speaker wall — a blank speaker is
 *  DROPPED, never defaulted to the volume author — holds here too, without a
 *  second parser that could drift from it. */
export function fetchAccounts(): Promise<JardineAccounts> {
  if (!accountsPromise) {
    accountsPromise = (async (): Promise<JardineAccounts> => {
      try {
        const res = await fetch(JARDINE_ACCOUNTS_URL, { cache: 'no-store' });
        if (!res.ok) {
          accountsPromise = null;
          return {};
        }
        const raw = (await res.json()) as unknown;
        if (!isRecord(raw)) {
          accountsPromise = null;
          return {};
        }
        const out: JardineAccounts = {};
        for (const [sci, rows] of Object.entries(raw)) {
          if (!Array.isArray(rows)) continue;
          const ps = rows.map(asPassage).filter((p): p is JardinePassage => p !== null);
          if (ps.length > 0) out[sci] = ps;
        }
        if (Object.keys(out).length === 0) accountsPromise = null;
        return out;
      } catch {
        accountsPromise = null;
        return {};
      }
    })();
  }
  return accountsPromise;
}

export function fetchJardine(): Promise<Jardine> {
  if (!jardinePromise) {
    jardinePromise = (async (): Promise<Jardine> => {
      try {
        const res = await fetch(JARDINE_URL, { cache: 'no-store' });
        if (!res.ok) {
          jardinePromise = null;
          return EMPTY_JARDINE;
        }
        const j = normalize((await res.json()) as unknown);
        if (j.species.length === 0 && j.volumes.length === 0) jardinePromise = null;
        return j;
      } catch {
        jardinePromise = null;
        return EMPTY_JARDINE;
      }
    })();
  }
  return jardinePromise;
}
