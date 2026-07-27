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
import { BASE, JARDINE_URL } from './config';
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
export type JardineBinomialSource = 'em' | 'synonymy' | 'scaps';
export type JardineErratumKind = 'precedence' | 'slip' | 'collision';
export type JardineSubjectRole = 'garden' | 'library' | 'absent';

/** One OCR artefact preserved verbatim, with the note the [sic] marker carries. */
export interface JardineSic {
  find: string;
  note: string;
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
  drift: JardineDrift | null;
  /** null IS content — the Blue Tit ships voice:null and the Roll says so. */
  voice: JardinePassage | null;
  /** The second movement: the Song Thrush climate line, the Blue Tit door-capital line. */
  coda: JardinePassage | null;
  note: string | null;
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
const SOURCES: readonly JardineBinomialSource[] = ['em', 'synonymy', 'scaps'];
const KINDS: readonly JardineErratumKind[] = ['precedence', 'slip', 'collision'];
const ROLES: readonly JardineSubjectRole[] = ['garden', 'library', 'absent'];

function asSic(v: unknown): JardineSic[] {
  if (!Array.isArray(v)) return [];
  const out: JardineSic[] = [];
  for (const item of v) {
    if (!isRecord(item)) continue;
    const find = asString(item.find);
    if (!find) continue; // an empty needle would match everywhere / nowhere
    out.push({ find, note: asString(item.note) });
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
      drift: asEnum(item.drift, DRIFTS),
      voice: asPassage(item.voice),
      coda: asPassage(item.coda),
      note: asNullableString(item.note),
    });
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
    .sort((a, b) => b.count - a.count || a.species.sci_name.localeCompare(b.species.sci_name));
}

export function jardineImageUrl(image: string | null): string | null {
  if (!image) return null;
  return `${BASE}${image.replace(/^\/+/, '')}`;
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
function heardHere(c: CatalogSpecies): boolean {
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
    .sort((a, b) => a.sci_name.localeCompare(b.sci_name));
}

export interface DeskPick {
  species: JardineSpecies;
  /** 'live' = audible in the current window (tier 1); 'rotation' = the day's page. */
  source: 'live' | 'rotation';
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
