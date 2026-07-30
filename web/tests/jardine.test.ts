// THE LIBRARY — the logic suite for the Jardine tab, and the guard on its fixture.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE IS FOR
// The Library's whole claim is that every sentence on it is verbatim 1838 prose
// under the name of the man who actually wrote it, and every number on it is
// computed this morning from species.json. Both halves of that claim are
// invisible when they break: a flattened blockquote reads as prose, and a
// committed percentage reads as a live one. These tests are the only thing in
// the tree that can tell the difference.
//
// It is run by `npm test` (`node --test tests/*.test.ts`), which .github/
// workflows/web-ci.yml runs on every push touching web/**, and which
// scripts/repo-guards.sh guard 9 pins BY GLOB precisely so a second web test
// file cannot silently never run. TZ is pinned to Europe/London by the npm
// script — a London garden, and deterministic day-of-year arithmetic.
//
// THE LOADER SHIM (registerHooks, below) IS NOT OPTIONAL AND IT IS NOT A MOCK.
// web/src/jardine.ts imports `./config`, extensionless, which Vite resolves and
// Node does not; and config.ts reads `import.meta.env`, which is undefined
// outside a bundler and throws on property access. Two lines of module hook fix
// exactly those two bundler-isms and NOTHING else — the code under test is the
// shipped file, byte for byte, with its real normalize() and its real fetch
// contract. The alternative was a second copy of jardine.ts inside the test,
// which would pass forever while the shipped one rotted.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { LoadHookSync, ResolveHookSync } from 'node:module';
import { parseCatalogDate } from '../src/almanac.ts';
import type { CatalogSpecies } from '../src/catalog.ts';
import type { Jardine, JardineErratum, JardinePassage, JardineSpecies } from '../src/jardine.ts';

// ── the two-line bundler shim ────────────────────────────────────────────────
// Vite resolves extensionless relative specifiers ('./config'); Node does not.
const resolve: ResolveHookSync = (spec, ctx, next) => {
  if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) {
    try {
      return next(`${spec}.ts`, ctx);
    } catch {
      /* not a .ts sibling — fall through to Node's own resolution */
    }
  }
  return next(spec, ctx);
};

// `import.meta.env` is a Vite define. Outside a bundler it is undefined, and
// config.ts's first statement dereferences it. Neutralise the define only —
// every `?? fallback` in config.ts then supplies the dev-server default, which
// is exactly the shape the browser sees on `npm run dev`.
const load: LoadHookSync = (url, ctx, next) => {
  const r = next(url, ctx);
  if (url.endsWith('/src/config.ts')) {
    return {
      ...r,
      source: String(r.source).replaceAll('import.meta.env', '({})'),
      format: 'module-typescript',
    };
  }
  return r;
};

registerHooks({ resolve, load });

const SRC = new URL('../src/', import.meta.url);

let jardineMod: Record<string, unknown>;
try {
  jardineMod = (await import(new URL('jardine.ts', SRC).href)) as Record<string, unknown>;
} catch (e) {
  // Turn the two ways the shim itself can fail into named failures instead of
  // an unexplained MODULE_NOT_FOUND / ERR_UNKNOWN_MODULE_FORMAT at file scope.
  // Both need Node >= 22.15 (registerHooks) and >= 22.18 (type stripping, which
  // web/package.json already pins); CI runs 24.
  throw new Error(
    `web/tests/jardine.test.ts could not load web/src/jardine.ts through the loader shim.\n` +
      `Node ${process.version}. The shim needs module.registerHooks (>= 22.15) and the\n` +
      `'module-typescript' load format (>= 22.18). If jardine.ts stopped importing './config'\n` +
      `the shim is simply no longer needed and can go.\n` +
      `Original: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
    { cause: e },
  );
}

const normalize = jardineMod.normalize as (raw: unknown) => Jardine;
const EMPTY = jardineMod.EMPTY_JARDINE as Jardine;
const fetchJardine = jardineMod.fetchJardine as () => Promise<Jardine>;
const speciesBySci = jardineMod.speciesBySci as (j: Jardine) => Map<string, JardineSpecies>;
const firstSentence = jardineMod.firstSentence as (t: string) => string;
type Counterpoint =
  | { kind: 'voice'; passage: JardinePassage }
  | { kind: 'silence'; note: string }
  | null;
const counterpointFor = jardineMod.counterpointFor as (s: JardineSpecies | null) => Counterpoint;
const silences = jardineMod.silences as (
  j: Jardine,
  c: CatalogSpecies[],
) => Array<{ species: JardineSpecies; count: number }>;
const sealLine = jardineMod.sealLine as (c: unknown) => string;
const weakSource = jardineMod.weakSource as (s: JardineSpecies) => string | null;
const heardHere = jardineMod.heardHere as (c: CatalogSpecies) => boolean;
const closingHolds = jardineMod.closingHolds as (e: JardineErratum, m: Map<string, CatalogSpecies>) => boolean;
type SicRow = { find: string; note: string; offset: number | null };
const sicSpans = jardineMod.sicSpans as (
  t: string,
  s: SicRow[],
) => Array<{ text: string; sic: SicRow | null }>;
const fetchAccounts = jardineMod.fetchAccounts as () => Promise<Record<string, JardinePassage[]>>;
const ACCOUNTS_PATH = new URL('../public/jardine-accounts.json', import.meta.url);
function accountsRaw(): unknown {
  // Same fix, same reason — see corpusRaw(). 287 KB of verified 1838 prose whose
  // deletion used to leave the suite entirely green.
  if (!existsSync(ACCOUNTS_PATH)) {
    assert.fail(
      'web/public/jardine-accounts.json is MISSING. It is committed — without it the ' +
        'reading room has nothing to open and 211 verified passages reach nobody.',
    );
  }
  return JSON.parse(readFileSync(ACCOUNTS_PATH, 'utf8')) as unknown;
}

// ── THE READING DESK selector ────────────────────────────────────────────────
// The desk's two-tier pick is the tab's signature and the only job the shared
// 1H/12H/24H/7D filter has anywhere in the museum. It MUST live in a .ts, not
// inside LibraryView.tsx: `node --test` strips types but cannot parse JSX, so a
// selector inside the view is a selector nothing can ever test.
interface DeskArgs {
  aim?: string | null;
  /** jardine.species[] — the filter to voice !== null is the selector's job. */
  species: JardineSpecies[];
  /** the live roster App.tsx already passes every view (types.ts RosterRow). */
  rows: Array<{ sci: string; com: string; slug: string; n: number; isNew: boolean }>;
  /** fetchCatalog() — the rotation pool is the catalog intersection. */
  catalog: CatalogSpecies[];
  /** settings.windowHours, straight off the shared period filter. */
  windowHours: number;
  /** the "☞ another passage" counter; local state only, absent === 0. */
  step?: number;
  now: Date;
}

const DESK_EXPORTS = [
  'pickDeskSpecies',
  'pickReadingDeskSpecies',
  'selectDeskSpecies',
  'pickDesk',
  'deskSpecies',
];

const DESK_SPEC = [
  'THE READING DESK SELECTOR IS GONE FROM web/src/jardine.ts.',
  '',
  'It must stay there and nowhere else. `node --test` strips types but cannot',
  'parse JSX, so a selector that moves back into LibraryView.tsx is a selector',
  'nothing in this repo can ever assert — and the desk is the tab\'s signature.',
  'The view keeps exactly one call site and no rotation arithmetic of its own; a',
  'second copy in the view forks the moment either is edited, and the divergence',
  'only ever shows up as "the ☞ button skipped a page", which nobody files.',
  '',
  'Expected export, one of:',
  `  ${DESK_EXPORTS.join(' | ')}`,
  '',
  'Signature — ONE options object:',
  '  export function pickDeskSpecies(a: {',
  '    species: JardineSpecies[];          // jardine.species, unfiltered',
  '    rows: RosterRow[];                  // the live roster App.tsx passes in',
  '    catalog: CatalogSpecies[];          // fetchCatalog() (may be empty)',
  '    windowHours: number;                // settings.windowHours',
  '    step?: number;                      // "☞ another passage", default 0',
  '    now: Date;                          // never `new Date()` inside — pinned dates',
  '  }):                                   //   are the only way this is testable',
  '     JardineSpecies | null              // or { species, source } — both accepted',
  '',
  'Behaviour (brief section 2, SPECIES SELECTION):',
  '  tier 1  step === 0, windowHours <= 24, and some row.sci matches a species',
  '          with voice !== null => the LOUDEST such row (max n).',
  '  tier 2  otherwise (dayOfYear(now) + step) % pool.length over the voice-carrying',
  '          species that are ALSO in `catalog`. Deterministic, no storage, no model.',
  '  neither => null. The desk renders its honest empty state; it never invents a page.',
].join('\n');

function deskFn(): (a: DeskArgs) => unknown {
  for (const n of DESK_EXPORTS) {
    const v = jardineMod[n];
    if (typeof v === 'function') return v as (a: DeskArgs) => unknown;
  }
  return assert.fail(DESK_SPEC);
}

/** Accept either `JardineSpecies` or `{ species, source }` as the return. */
function pick(a: DeskArgs): JardineSpecies | null {
  const out = deskFn()(a);
  if (out === null || out === undefined) return null;
  if (typeof out === 'object' && 'species' in (out as object)) {
    return ((out as { species: JardineSpecies | null }).species ?? null);
  }
  return out as JardineSpecies;
}

// ── fixtures ─────────────────────────────────────────────────────────────────

const LONDON_PATH = new URL('../public/dev/species-london.json', import.meta.url);
const CORPUS_PATH = new URL('../public/jardine.json', import.meta.url);

/** The three committed CC0 engravings. A fourth path in the errata means a
 *  broken mount in the vitrine, which is the one object where the images ARE
 *  the argument. */
/** Engravings that existed before the plate set was fetched. Kept as a floor —
 *  these three must never disappear — NOT as a whitelist. A whitelist of three
 *  is what E3 used to assert, and it went stale the moment 23 more plates
 *  landed: it failed on a CORRECT change while remaining unable to catch the
 *  thing that actually matters, which is a path with no file behind it. */
const IMAGE_FLOOR = ['jardine/19-vignette.jpg', 'jardine/24-vignette.jpg', 'jardine/24-11.jpg'];

const london = JSON.parse(readFileSync(LONDON_PATH, 'utf8')) as CatalogSpecies[];

/** The corpus is written by the extraction lane and assembled last. When it is
 *  not in the tree the tab must degrade to silence — every corpus test asserts
 *  THAT instead, so this file is never vacuously green. */
function corpusRaw(): unknown {
  // NOT NULLABLE ANY MORE, AND THAT IS THE FIX.
  //
  // This returned null when the file was missing, and 20 tests then did
  // `if (raw === null) return;` — written when the corpus was still being
  // produced by another lane and might genuinely not exist yet. The moment it
  // WAS committed, every one of those became a silent no-op. Measured: deleting
  // web/public/jardine.json AND the 287 KB jardine-accounts.json left the suite
  // at 82/82 PASS. The entire Library could vanish and nothing went red.
  //
  // That is this project's signature bug — a check that cannot fail reporting
  // success — in the one place meant to catch it. Both files are committed and
  // guarded by repo-guards; their absence is a defect, so this fails loudly.
  if (!existsSync(CORPUS_PATH)) {
    assert.fail(
      'web/public/jardine.json is MISSING. It is committed — if it is gone the ' +
        'Library has no corpus and the whole tab is empty. This is not a state to skip past.',
    );
  }
  return JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as unknown;
}

/** Strip block and line comments so a guard asserts an INVOCATION and not a
 *  mention. A commented-out call is exactly the regression these tests exist to
 *  catch, so it must never satisfy one. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

/** Every file that renders a Jardine row. A new one must be added here — which
 *  is the point: the list is the checklist. */
const CONSUMERS = [
  '../src/views/LibraryView.tsx',
  '../src/views/LibraryFrameView.tsx',
  '../src/components/BirdPopup.tsx',
];

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

let seq = 0;
function passage(over: Partial<Record<keyof JardinePassage, unknown>> = {}): unknown {
  seq++;
  return {
    text: `A verbatim eighteen-thirty-eight sentence, number ${seq}.`,
    speaker: 'Sir William Jardine',
    is_quotation: false,
    volume: 24,
    volume_title: 'Birds of Great Britain and Ireland, Part III',
    volume_author: 'Sir William Jardine',
    source_url: 'https://www.c82.net/naturalists-library/volume/24',
    sic: [],
    ...over,
  };
}

function sp(sci: string, over: Record<string, unknown> = {}): unknown {
  return {
    sci_name: sci,
    slug: slugify(sci),
    jardine_title: `The ${sci}`,
    jardine_binomial: sci,
    jardine_authority: 'Swainson',
    binomial_source: 'em',
    volume: 24,
    volume_title: 'Birds of Great Britain and Ireland, Part III',
    volume_author: 'Sir William Jardine',
    source_url: 'https://www.c82.net/naturalists-library/volume/24',
    plate_ref: null,
    plate_is_vignette: false,
    drift: 'unchanged',
    voice: passage(),
    coda: null,
    note: null,
    ...over,
  };
}

function roster(pairs: Array<[string, number]>) {
  return pairs.map(([sci, n]) => ({
    sci,
    com: sci,
    slug: slugify(sci),
    n,
    isNew: false,
  }));
}

function cat(scis: string[]): CatalogSpecies[] {
  return scis.map((sci, i) => ({
    sci_name: sci,
    com_name: sci,
    slug: slugify(sci),
    first_confident: '2025-01-01 06:00:00',
    last_detected: '2026-07-27 06:00:00',
    detection_count: 100 + i,
    art_status: 'ready',
    accession: i + 1,
    weeks: [],
  }));
}

// ═══ A · THE ATTRIBUTION WALL ═══════════════════════════════════════════════

test('A1 a blank speaker DROPS the passage — it is never defaulted to the volume author', () => {
  // WHY — THE LOAD-BEARING ONE. 18 of the 40 blockquotes on c82 carry their
  // attribution only in the tail of the preceding sentence, so a regression in
  // the extractor emits a passage with no speaker. Every plausible "helpful"
  // repair — default to the volume author, fall back to "Jardine", keep the row
  // and hide the byline — publishes William Hewitson's words under Sir William
  // Jardine's name on a page whose entire premise is that it did not do that.
  // The only safe answer is to drop the passage and let the species read silent.
  const blanks: unknown[] = [
    '',
    '   ',
    '\n\t ',
    null,
    undefined,
    123,
    {},
    ['Sir William Jardine'],
  ];
  const raw = {
    version: 1,
    species: blanks.map((speaker, i) =>
      sp(`Genus blank${i}`, { voice: passage({ speaker }) }),
    ),
  };
  const j = normalize(raw);
  assert.equal(j.species.length, blanks.length, 'the ROW must survive; only its voice is refused');
  for (const s of j.species) {
    assert.equal(s.voice, null, `${s.sci_name}: a blank speaker survived normalize`);
  }

  // And the refusal is specific, not a blanket "no voices": the same shape with
  // a real speaker keeps its passage, verbatim, under that name.
  const ok = normalize({
    version: 1,
    species: [sp('Erithacus rubecula', { voice: passage({ speaker: 'William Hewitson' }) })],
  });
  assert.equal(ok.species[0].voice?.speaker, 'William Hewitson');
  assert.notEqual(
    ok.species[0].voice?.speaker,
    ok.species[0].voice?.volume_author,
    'a quoted naturalist must keep his own name, not the volume author’s',
  );
});

test('A2 the epigraph, the coda and the Roll’s closing line are behind the same wall', () => {
  // WHY: the epigraph is the largest type on the tab and the closing line is the
  // last sentence anyone reads. A wall that only guards `voice` leaves the two
  // most prominent sentences unprotected.
  const j = normalize({
    version: 1,
    epigraph: passage({ speaker: '' }),
    roll_closing: passage({ speaker: '  ' }),
    species: [sp('Turdus philomelos', { coda: passage({ speaker: null }) })],
  });
  assert.equal(j.epigraph, null, 'a blank-speaker epigraph reached the masthead');
  assert.equal(j.roll_closing, null, 'a blank-speaker closing line reached the Roll');
  assert.equal(j.species[0].coda, null, 'a blank-speaker coda reached the second movement');
});

test('A3 an empty account is DROPPED, so silence is a set difference and never a blank row', () => {
  // WHY: the Roll's silent row is the species the library has NO account for,
  // rendered as a set difference at render time. If normalize kept shells —
  // a row with no sci_name, or a row whose every field coerced to '' — the Roll
  // would print a second kind of blank row that looks like a rendering bug
  // rather than a fact about 1838. A 48th bird must file itself with no edit.
  const j = normalize({
    version: 1,
    species: [
      sp('Erithacus rubecula', { jardine_title: 'The Robin, or Redbreast' }),
      { sci_name: '', jardine_title: 'The Nameless' },
      { sci_name: '   ' },
      {},
      'Turdus merula',
      null,
      42,
      // a duplicate join key would render the same bird twice in the ledger
      sp('Erithacus rubecula', { jardine_title: 'The Robin, again' }),
    ],
  });
  assert.equal(j.species.length, 1, 'a shell or a duplicate reached the Roll');
  assert.equal(j.species[0].sci_name, 'Erithacus rubecula');
  assert.equal(
    j.species[0].jardine_title,
    'The Robin, or Redbreast',
    'the duplicate account won over the first — one bird, two ledger rows',
  );
});

test('A4 voice:null is CONTENT — the row stays, with its note, and reads silent', () => {
  // WHY: the owner's decision. 13 of 40 species have no voice passage, four of
  // them corvids Jardine wrote thousands of words about without once describing
  // the noise they make. The Roll prints those rows and does not apologise, so
  // dropping a voice-less account would delete the joke and a third of the tab.
  const j = normalize({
    version: 1,
    species: [
      sp('Corvus frugilegus', { voice: null, note: 'he never mentions its voice' }),
      sp('Cyanistes caeruleus', { voice: undefined, note: null }),
    ],
  });
  assert.equal(j.species.length, 2);
  assert.equal(j.species[0].voice, null);
  assert.equal(j.species[0].note, 'he never mentions its voice');
  assert.equal(j.species[1].voice, null);
  assert.equal(speciesBySci(j).get('Corvus frugilegus')?.jardine_title, 'The Corvus frugilegus');
});

test('A5 normalize never throws, whatever is served, and collapses to the empty shape', () => {
  // WHY: jardine.json is a hand-assembled static file symlinked on a Pi. A
  // truncated write, a 404 page served as JSON, or an rsync mid-flight all
  // reach normalize as garbage, and the museum's contract is a calm empty
  // state — never an error boundary, never a dead spinner.
  for (const junk of [null, undefined, 0, '', 'a string', [], [1, 2], true, NaN]) {
    const j = normalize(junk);
    assert.deepEqual(j, EMPTY, `normalize(${JSON.stringify(junk)}) did not collapse`);
  }
  const partial = normalize({ version: 'x', species: 'not an array', errata: {}, volumes: 7 });
  assert.deepEqual(partial.species, []);
  assert.deepEqual(partial.errata, []);
  assert.deepEqual(partial.volumes, []);
});

test('A6 firstSentence returns a SLICE of the source, never a rewrite', () => {
  // WHY: the popup's return leg prints one sentence of 1838 prose. Any future
  // "tidy it up" — a trailing ellipsis, a capitalised first letter, a trimmed
  // OCR artefact — turns a verbatim quotation into a paraphrase under a dead
  // man's name. Asserting prefix-ness is the cheapest possible proof it is not.
  const src =
    'The tone and expression is not to be explained by words, and can only be felt by hearing. ' +
    'We have never yet enjoyed the treat of its midnight music.';
  const one = firstSentence(src);
  assert.ok(src.startsWith(one), `not a prefix of the source: ${one}`);
  assert.ok(one.endsWith('.'));
  assert.ok(one.length < src.length, 'the whole passage came back');
  // an OCR artefact inside the sentence survives untouched
  const ocr = 'a very noisy, if not an objectionable, inmate of the drawing-room render\\it. And more.';
  assert.ok(firstSentence(ocr).includes('render\\it'), 'the [sic] artefact was cleaned up');
});

// ═══ B · THE READING DESK ═══════════════════════════════════════════════════

const VOICED = ['Erithacus rubecula', 'Turdus merula', 'Turdus philomelos', 'Parus major', 'Troglodytes troglodytes'];
const DESK_SPECIES = [
  ...VOICED.map((s) => sp(s) as unknown as JardineSpecies),
  // the four corvids and the Blue Tit: an account, no voice
  ...['Corvus frugilegus', 'Corvus corone', 'Cyanistes caeruleus'].map(
    (s) => sp(s, { voice: null }) as unknown as JardineSpecies,
  ),
];
const DESK_CATALOG = cat([...VOICED, 'Corvus frugilegus', 'Corvus corone', 'Cyanistes caeruleus']);

test('B1 inside the window the desk answers the LOUDEST bird that is audible right now', () => {
  // WHY: this is the entire reason the shared 1H/12H/24H/7D filter is allowed to
  // stay on this tab. If the desk ignores `rows`, the control is once again a
  // wart floating over a surface it does not touch, and the tab's one moment —
  // "the bird is singing out there right now" — never fires.
  const got = pick({
    species: DESK_SPECIES,
    rows: roster([
      ['Turdus merula', 9],
      ['Parus major', 61],
      ['Erithacus rubecula', 12],
    ]),
    catalog: DESK_CATALOG,
    windowHours: 24,
    now: new Date(2026, 6, 27, 6, 30),
  });
  assert.equal(got?.sci_name, 'Parus major');
});

test('B2 a live bird the library never described does NOT displace a bird it did', () => {
  // WHY: the Rook is this garden's loudest silence — Jardine wrote thousands of
  // words on corvids and not one about the noise they make. A selector that
  // takes the loudest live row before checking `voice` puts an empty desk under
  // the epigraph at dawn, which is the one hour anyone looks at this tab.
  const got = pick({
    species: DESK_SPECIES,
    rows: roster([
      ['Corvus frugilegus', 900],
      ['Cyanistes caeruleus', 400],
      ['Turdus philomelos', 3],
    ]),
    catalog: DESK_CATALOG,
    windowHours: 12,
    now: new Date(2026, 6, 27, 6, 30),
  });
  assert.equal(got?.sci_name, 'Turdus philomelos');
});

test('B3 the period filter IS the desk’s dial, and it stops being one above 24H', () => {
  // WHY: the shared 1H/12H/24H/7D control does nothing on any other tab, and
  // the whole justification for keeping it visible here is that it picks the
  // recency band the desk answers from. So the tight bands must genuinely
  // change the answer — AND the loose ones must genuinely stop claiming one:
  // "HEARD HERE 12 MINUTES AGO" under a 7-day window is a lie with a timestamp
  // on it, and ALL (1,000,000 hours) is not a window at all.
  //
  // Asserted as date-INVARIANCE against date-VARIANCE rather than against a
  // named species, so re-ordering the rotation pool cannot break it: a live
  // pick is the same bird whatever the date; a rotation is not.
  const rows = roster([['Parus major', 61]]);
  const dates = [new Date(2026, 0, 3, 8), new Date(2026, 3, 17, 8), new Date(2026, 8, 29, 8)];
  for (const windowHours of [1, 12, 24]) {
    const picks = dates.map(
      (now) => pick({ species: DESK_SPECIES, rows, catalog: DESK_CATALOG, windowHours, now })?.sci_name,
    );
    assert.deepEqual(
      picks,
      ['Parus major', 'Parus major', 'Parus major'],
      `${windowHours}H did not answer the live bird — the filter has no job again`,
    );
  }
  for (const windowHours of [168, 1_000_000]) {
    const picks = dates.map(
      (now) => pick({ species: DESK_SPECIES, rows, catalog: DESK_CATALOG, windowHours, now })?.sci_name,
    );
    assert.ok(picks.every((x) => x !== undefined), `${windowHours}H blanked the desk instead of rotating`);
    assert.ok(
      new Set(picks).size > 1,
      `${windowHours}H took the live pick — the desk captioned a stale detection as "heard here"`,
    );
  }
});

test('B4 with nothing live the rotation is deterministic for a given day', () => {
  // WHY: "a different page every morning, no cron, no storage, no LLM" only
  // holds if the same date always yields the same page. Math.random here would
  // reshuffle the desk on every re-render — the passage would change while the
  // owner was reading it.
  const args = {
    species: DESK_SPECIES,
    rows: [],
    catalog: DESK_CATALOG,
    windowHours: 24,
    now: new Date(2026, 6, 27, 6, 30),
  };
  const a = pick(args);
  const b = pick(args);
  const c = pick({ ...args, now: new Date(2026, 6, 27, 23, 59, 59) });
  assert.ok(a, 'the rotation returned nothing with a full pool');
  assert.equal(a?.sci_name, b?.sci_name, 'two calls on one date disagreed');
  assert.equal(a?.sci_name, c?.sci_name, 'the page changed at teatime — this is a DAY rotation');
});

test('B5 the rotation actually rotates — a year of dates walks the whole pool', () => {
  // WHY: the failing twin of B4. `pool[0]` is perfectly deterministic and
  // perfectly wrong: it passes every same-day assertion and shows the Robin
  // every morning for a year. This asserts movement AND coverage.
  const seen = new Map<string, number>();
  let sameAsYesterday = 0;
  let prev: string | null = null;
  for (let i = 0; i < 366; i++) {
    const now = new Date(2026, 0, 1 + i, 8, 0, 0);
    const got = pick({
      species: DESK_SPECIES,
      rows: [],
      catalog: DESK_CATALOG,
      windowHours: 24,
      now,
    });
    assert.ok(got, `no page on day ${i}`);
    const k = got!.sci_name;
    seen.set(k, (seen.get(k) ?? 0) + 1);
    if (prev === k) sameAsYesterday++;
    prev = k;
  }
  assert.equal(seen.size, VOICED.length, `the rotation covered ${seen.size} of ${VOICED.length} pages`);
  assert.equal(sameAsYesterday, 0, 'the page repeated on consecutive days');
  // and no page hogs the year: a 5-page pool over 366 days lands 73-74 each.
  for (const [k, n] of seen) {
    assert.ok(n >= 60 && n <= 90, `${k} appeared ${n} times in a year — the rotation is lopsided`);
  }
});

test('B6 the rotation pool is the CATALOG intersection — a bird never heard here is never set', () => {
  // WHY: the corpus carries accounts for birds this garden has never recorded.
  // Setting one on the desk puts a passage above a band with no recording under
  // it — the off-Pi state, rendered for a bird that was never on the Pi. The
  // pool is "voice-carrying species present in fetchCatalog()", full stop.
  const seen = new Set<string>();
  for (let i = 0; i < 366; i++) {
    const got = pick({
      species: DESK_SPECIES,
      rows: [],
      catalog: cat(['Turdus merula', 'Parus major']), // only two of the five
      windowHours: 24,
      now: new Date(2026, 0, 1 + i, 8, 0, 0),
    });
    assert.ok(got, `no page on day ${i}`);
    seen.add(got!.sci_name);
  }
  assert.deepEqual([...seen].sort(), ['Parus major', 'Turdus merula']);
});

test('B7 an empty pool yields NOTHING, and an unreachable catalog fabricates nothing', () => {
  // WHY: species #48 is a genuinely new bird and renders as honest silence, no
  // nudge and no empty state to design. A selector that falls back to
  // `species[0]` when there is no pool prints an 1838 account under a band with
  // no recording. The unreachable-catalog case is the softer trap: species.json
  // 404s often enough (a clobbered symlink, a deploy mid-flight) that the desk
  // is allowed to keep rotating — but it may only ever rotate over accounts that
  // HAVE a voice, or the passage slot renders empty under the epigraph.
  const now = new Date(2026, 6, 27, 6, 30);
  assert.equal(
    pick({ species: [], rows: [], catalog: DESK_CATALOG, windowHours: 24, now }),
    null,
    'an empty corpus produced a page',
  );
  assert.equal(
    pick({
      species: DESK_SPECIES.filter((s) => s.voice === null),
      rows: roster([['Corvus frugilegus', 900]]),
      catalog: DESK_CATALOG,
      windowHours: 1,
      now,
    }),
    null,
    'a pool of voice-less accounts produced a page',
  );
  for (let i = 0; i < 366; i++) {
    const got = pick({
      species: DESK_SPECIES,
      rows: [],
      catalog: [],
      windowHours: 24,
      now: new Date(2026, 0, 1 + i, 8, 0, 0),
    });
    if (got !== null) {
      assert.notEqual(got.voice, null, `day ${i}: a voice-less account was set on the desk`);
    }
  }
});

test('B8 "☞ another passage" must step the ONE rotation, not a second copy of it', () => {
  // WHY: the desk's only control, and the one that keeps the rotation single.
  // An earlier cut of this round had the step arithmetic in LibraryView —
  // `voicePool[(dayOfYear(new Date()) + step) % voicePool.length]` — beside a
  // selector in jardine.ts that did `pool[dayOfYear(a.now) % pool.length]`. Two
  // implementations of one rotation, already disagreeing on their clock: the
  // selector read the `now` it was handed, the view read wall-clock. Whichever
  // is edited next silently forks the other, and the divergence surfaces only as
  // "the ☞ button skipped a page", which nobody files. This test is what holds
  // the step inside the selector, where a pinned date can reach it.
  //
  // It also pins the rule that turning the page LEAVES THE LIVE BIRD BEHIND:
  // "another passage" is a request for a different one, not a re-roll of the
  // same one, so any step above 0 must switch off tier 1.
  const base = {
    species: DESK_SPECIES,
    rows: roster([['Parus major', 61]]),
    catalog: DESK_CATALOG,
    windowHours: 24,
    now: new Date(2026, 6, 27, 8, 0, 0),
  };
  const live = pick({ ...base, step: 0 });
  assert.equal(live?.sci_name, 'Parus major');
  const seen = new Set<string>();
  for (let s = 1; s <= VOICED.length; s++) {
    const got = pick({ ...base, step: s });
    assert.ok(got, `step ${s} produced no page`);
    seen.add(got!.sci_name);
  }
  assert.equal(seen.size, VOICED.length, 'stepping does not walk the whole pool');
  assert.notEqual(pick({ ...base, step: 1 })?.sci_name, pick({ ...base, step: 2 })?.sci_name);
  // A hostile step must never produce a MALFORMED pick. `pool[NaN]` is
  // undefined, so an unguarded `(dayOfYear + step) % pool.length` returns
  // `{ species: undefined, source: 'rotation' }` — an object that satisfies no
  // caller and lies about its own declared type (DeskPick.species is
  // JardineSpecies, not optional). The view survives it today only because it
  // writes `pick?.species ?? null`; the next caller that writes `pick.species.voice`
  // throws inside a render. Either return null or return a real page.
  for (const step of [undefined, 0, -1, 1.5, NaN, Number.POSITIVE_INFINITY]) {
    const raw = deskFn()({ ...base, step }) as { species?: unknown } | null;
    if (raw === null) continue;
    assert.ok(
      raw.species && typeof raw.species === 'object',
      `step ${String(step)}: pickDeskSpecies returned { species: ${String(raw.species)} } — ` +
        'guard the step with Number.isFinite before the modulus, or return null',
    );
  }
});

// ═══ C · fetchJardine — the tab degrades, it never breaks ═══════════════════

const realFetch = globalThis.fetch;

async function withFetch(impl: () => unknown, run: () => Promise<void>): Promise<void> {
  (globalThis as { fetch: unknown }).fetch = async () => impl();
  try {
    await run();
  } finally {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  }
}

test('C1 a 404, an empty body and a malformed body all resolve to silence, never a throw', async () => {
  // WHY: jardine.json is absent from the tree until the extraction lands, and
  // on the Pi it is a symlink that `rsync --delete` has clobbered before. The
  // museum's contract (catalog.ts's file header) is that an unreachable file
  // renders the calm empty state — an unhandled rejection inside a view instead
  // blanks the whole app behind an error boundary.
  await withFetch(() => ({ ok: false, status: 404, json: async () => ({}) }), async () => {
    assert.deepEqual(await fetchJardine(), EMPTY);
  });
  await withFetch(
    () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    }),
    async () => {
      assert.deepEqual(await fetchJardine(), EMPTY);
    },
  );
  await withFetch(() => ({ ok: true, status: 200, json: async () => '<!doctype html>' }), async () => {
    assert.deepEqual(await fetchJardine(), EMPTY);
  });
  await withFetch(
    () => {
      throw new TypeError('Failed to fetch');
    },
    async () => {
      assert.deepEqual(await fetchJardine(), EMPTY);
    },
  );
});

test('C2 a failed first load must not blank the tab for the whole session', async () => {
  // WHY: the memo is shared by the tab AND by every BirdPopup open, so a single
  // early 404 — the service worker warming before the symlink resolves, a
  // deploy mid-flight — would otherwise poison every subsequent read for as
  // long as the page stays open, and the return leg would silently vanish from
  // a hundred popups. catalog.ts:116 clears its memo on an empty result for
  // exactly this reason; this asserts jardine.ts kept that behaviour.
  const good = {
    version: 1,
    species: [sp('Erithacus rubecula')],
    volumes: [{ n: 24, title: 'Birds of Great Britain and Ireland, Part III', division: 'birds', author: 'Sir William Jardine' }],
  };
  await withFetch(() => ({ ok: false, status: 404, json: async () => ({}) }), async () => {
    assert.deepEqual(await fetchJardine(), EMPTY);
  });
  await withFetch(() => ({ ok: true, status: 200, json: async () => good }), async () => {
    const j = await fetchJardine();
    assert.equal(j.species.length, 1, 'the 404 was memoised — the corpus never loads again');
    assert.equal(j.species[0].sci_name, 'Erithacus rubecula');
  });
});

// ═══ D · THE ERRATA FIGURES ARE COMPUTED, NOT COMMITTED ════════════════════

/** The documented formula, in one place: a species' share of everything this
 *  station has ever heard. detection_count over the summed detection_count. */
function share(rows: CatalogSpecies[], sci: string): number {
  const total = rows.reduce((a, r) => a + r.detection_count, 0);
  if (total === 0) return 0;
  const row = rows.find((r) => r.sci_name === sci);
  return ((row?.detection_count ?? 0) / total) * 100;
}

test('D1 the errata percentages are reproducible from the catalog alone', () => {
  // WHY: every slip is a fixed pair — JARDINE SAYS (verbatim) over THE GARDEN
  // SAYS (a figure computed live). The moment a percentage is typed into the
  // JSX or the corpus it stops being an argument and becomes a claim that was
  // true once. These are the figures the brief prints on slips II and III, and
  // they must fall out of species.json by the formula above and nothing else.
  assert.equal(share(london, 'Erithacus rubecula').toFixed(2), '38.45');
  assert.equal(share(london, 'Psittacula krameri').toFixed(2), '34.34');
  assert.equal(share(london, 'Cyanistes caeruleus').toFixed(2), '8.50');
});

test('D2 slip No. V’s zero is a real zero — the Nightingale is absent, not written down as 0', () => {
  // WHY: "We have never yet enjoyed the treat of its midnight music." / "0." /
  // "Agreed." is the tab's last line and its only joke at nobody's expense. It
  // is only true if the number is a lookup that missed. The same holds for the
  // Waxwing's "NEVER HEARD IN THIS GARDEN" beneath the one full plate in the
  // vitrine — an inert control that must be honestly, verifiably inert.
  assert.equal(share(london, 'Luscinia megarhynchos'), 0);
  assert.equal(share(london, 'Bombycilla garrulus'), 0);
  assert.ok(!london.some((r) => r.sci_name === 'Luscinia megarhynchos'));
  assert.ok(!london.some((r) => r.sci_name === 'Bombycilla garrulus'));
  // ...and the formula is not simply always-zero:
  assert.ok(share(london, 'Turdus merula') > 0);
});

test('D3 slip No. IV needs BOTH owners of Turdus musicus present in the fixture', () => {
  // WHY: 1838's `Turdus musicus` is today's Redwing, and Jardine's Song Thrush
  // is two headings away in the same volume. The collision is the errata's best
  // exhibit and it renders as "an empty mount and one honest line" whenever the
  // Redwing is missing from the catalog — so a fixture without it silently
  // reviews a half-built slip and everyone signs off on the wrong thing.
  for (const sci of ['Turdus philomelos', 'Turdus iliacus']) {
    assert.ok(london.some((r) => r.sci_name === sci), `${sci} missing from the London fixture`);
  }
});

test('D4 the committed corpus carries no modern figure of any kind', () => {
  // WHY — the structural half of "computed, never committed". A percentage that
  // reaches the JSON is a number that was true on the day it was extracted and
  // is quietly wrong every day after, on the one surface whose whole point is
  // that its right-hand column is alive. No field may be able to carry one, and
  // no string may contain one.
  const raw = corpusRaw();
  if (raw === null) {
    assert.deepEqual(normalize(raw), EMPTY, 'no corpus in the tree — the tab must degrade to silence');
    return;
  }
  const errata = (raw as { errata?: unknown }).errata;
  assert.ok(Array.isArray(errata), 'the corpus has no errata array');
  const FORBIDDEN = /^(percent|pct|percentage|share|tally|figure|detections?|detection_count|garden_says|modern)$/i;
  const walk = (v: unknown, path: string): void => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        assert.ok(!FORBIDDEN.test(k), `${path}.${k} — a modern figure was committed into the corpus`);
        walk(x, `${path}.${k}`);
      }
      return;
    }
    if (typeof v === 'string' && !path.includes('.text')) {
      assert.ok(
        !/\d[\d,.]*\s?%/.test(v),
        `${path} contains a committed percentage: ${JSON.stringify(v)}`,
      );
    }
  };
  walk(errata, 'errata');
});

// ═══ E · THE COMMITTED CORPUS ══════════════════════════════════════════════

test('E1 no quotation is published under the volume author’s name', () => {
  // WHY: the blockquote trap, asserted against the real file rather than a
  // synthetic. `is_quotation: true` means the text sat inside a <blockquote> —
  // by definition someone other than the volume's author is speaking. A row
  // that says both is a flattened quotation, and it is unreadable as a bug
  // because it reads perfectly as prose.
  const raw = corpusRaw();
  if (raw === null) {
    assert.deepEqual(normalize(raw), EMPTY, 'no corpus in the tree — the tab must degrade to silence');
    return;
  }
  const j = normalize(raw);
  const all: Array<[string, JardinePassage]> = [];
  if (j.epigraph) all.push(['epigraph', j.epigraph]);
  if (j.roll_closing) all.push(['roll_closing', j.roll_closing]);
  for (const s of j.species) {
    if (s.voice) all.push([`${s.sci_name}.voice`, s.voice]);
    if (s.coda) all.push([`${s.sci_name}.coda`, s.coda]);
  }
  for (const e of j.errata) if (e.quote) all.push([`errata ${e.no}`, e.quote]);
  assert.ok(all.length > 0, 'the corpus published no passages at all');
  for (const [where, p] of all) {
    assert.ok(p.speaker.trim().length > 0, `${where}: empty speaker survived`);
    if (p.is_quotation) {
      assert.notEqual(
        p.speaker,
        p.volume_author,
        `${where}: a blockquote is attributed to the volume author — the flattening bug shipped`,
      );
    }
  }
});

test('E2 the corpus loses NOTHING to normalize — a dropped row means the extraction shipped a blank', () => {
  // WHY: normalize is a wall, not a cleaner. If it silently discards rows from
  // the committed file, the tab renders fewer species than the verification TSV
  // a human signed off on, and nobody finds out. Counting both sides is the
  // only way that gap is ever visible.
  const raw = corpusRaw();
  if (raw === null) {
    assert.deepEqual(normalize(raw), EMPTY, 'no corpus in the tree — the tab must degrade to silence');
    return;
  }
  const src = raw as { species?: unknown[]; errata?: unknown[]; volumes?: unknown[] };
  const j = normalize(raw);
  assert.equal(j.species.length, (src.species ?? []).length, 'normalize dropped a species account');
  assert.equal(j.errata.length, (src.errata ?? []).length, 'normalize dropped an erratum');
  assert.equal(j.volumes.length, (src.volumes ?? []).length, 'normalize dropped a volume spine');

  const rawVoices = (src.species ?? []).filter(
    (s) => (s as { voice?: unknown }).voice != null,
  ).length;
  const keptVoices = j.species.filter((s) => s.voice !== null).length;
  assert.equal(rawVoices, keptVoices, 'a committed passage was refused — check its speaker');

  const seen = new Set<string>();
  for (const s of j.species) {
    assert.ok(!seen.has(s.sci_name), `duplicate join key ${s.sci_name}`);
    seen.add(s.sci_name);
  }
});

test('E3 every engraving path anywhere in the museum has a file behind it', () => {
  // WHY: an <img> 404 renders as a broken mount, reads as a broken feature, and
  // is invisible to every other check in this repo. The old version of this
  // test asserted membership of a three-item whitelist, which caught nothing an
  // existence check does not and broke the moment the plate set was fetched.
  // Assert the property that matters — a path implies a file — over every
  // surface that can print one, not over a list someone has to remember to edit.
  const raw = corpusRaw();
  if (raw === null) {
    assert.deepEqual(normalize(raw), EMPTY, 'no corpus in the tree — the tab must degrade to silence');
    return;
  }
  const j = normalize(raw);
  let hung = 0;
  const check = (where: string, image: string | null, w: number | null, h: number | null) => {
    if (image === null) return;
    hung++;
    assert.ok(
      existsSync(new URL(`../public/${image}`, import.meta.url)),
      `${where}: ${image} is referenced but not in the tree`,
    );
    assert.ok(w !== null && h !== null, `${where}: ${image} has no intrinsic size — the mount will jump`);
  };
  for (const e of j.errata) {
    for (const s of e.subjects) {
      check(`errata ${e.no}/${s.sci_name}`, s.image, s.image_w, s.image_h);
      if (s.image !== null) {
        assert.ok(s.scale > 0, `${s.image}: a non-positive scale erases Jardine's own proportion`);
      }
    }
  }
  for (const s of j.species) check(`species ${s.sci_name}`, s.image, s.image_w, s.image_h);
  assert.ok(hung > 0, 'the museum hangs nothing — no record carries an image at all');
  for (const f of IMAGE_FLOOR) {
    assert.ok(existsSync(new URL(`../public/${f}`, import.meta.url)), `${f} was committed and is now gone`);
  }
});

test('E4 a plate two birds share names them both, in both directions', () => {
  // WHY: this is the defect the plate work exists to prevent, and it is not
  // hypothetical — volume 34's plate XV figures a Spotted Sandpiper beside the
  // Common Sandpiper we caption, and its own engraved legend says so. A shared
  // plate that names one bird tells a visitor the OTHER bird in the picture is
  // that species. The failure is silent, and it would hang in the same room as
  // this museum's corrections of Jardine.
  //
  // NEGATIVE-TESTED: deleting a plate_also entry, or pointing one at a bird
  // that is not in the crosswalk, fails this test.
  const raw = corpusRaw();
  if (raw === null) {
    assert.deepEqual(normalize(raw), EMPTY, 'no corpus in the tree — the tab must degrade to silence');
    return;
  }
  const j = normalize(raw);

  // THE SHARING FACT COMES FROM THE CORPUS, NOT FROM OUR OWN SPECIES LIST.
  // The first version of this test grouped species by image and checked any
  // file two of them hung. It could not fail on the case it was written for:
  // volume 34's plate XV is shared with Actitis macularius, a Nearctic vagrant
  // London never records, so exactly ONE of our species hangs that file and the
  // group of "sharers" had size 1. Deleting the Sandpiper's co-occupant left
  // the suite green — proven, not assumed. link_plates.py now writes the
  // corpus-derived truth into `plates_shared` and this reads it.
  const shared = (JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as {
    plates_shared?: Record<string, { sci_name: string; common: string; where: string }[]>;
  }).plates_shared;
  assert.ok(
    shared && Object.keys(shared).length > 0,
    'jardine.json records no shared plates — run tools/jardine/link_plates.py; a museum that has ' +
      'forgotten which plates carry two birds will caption one of them wrongly',
  );
  const byImage = new Map<string, typeof j.species>();
  for (const s of j.species) {
    if (s.image === null) continue;
    const list = byImage.get(s.image) ?? [];
    list.push(s);
    byImage.set(s.image, list);
  }
  for (const [image, figures] of Object.entries(shared)) {
    for (const s of byImage.get(image) ?? []) {
      const also = s.plate_also ?? [];
      for (const fig of figures) {
        if (fig.sci_name === s.sci_name) continue;
        assert.ok(
          also.some((a) => a.sci_name === fig.sci_name),
          `${s.sci_name} shares ${image} with ${fig.sci_name} and does not name it`,
        );
      }
      assert.ok(
        figures.some((f) => f.sci_name === s.sci_name),
        `${s.sci_name} hangs ${image}, which is a shared plate that does not list it`,
      );
      assert.ok(s.plate_where !== null, `${s.sci_name}: shares a plate but is not placed on it`);
    }
  }
  // Any bird that declares a co-occupant must place itself too, whether or not
  // the co-occupant is a species this garden hears — Actitis macularius is a
  // vagrant London never records, and it is exactly that asymmetry which let
  // the first version of the fetcher's guard pass a two-bird plate.
  for (const s of j.species) {
    if ((s.plate_also ?? []).length === 0) continue;
    assert.ok(s.image !== null, `${s.sci_name} declares a shared plate but hangs no image`);
    assert.ok(s.plate_where !== null, `${s.sci_name} names a co-occupant but does not place itself`);
    for (const a of s.plate_also ?? []) {
      assert.ok(a.sci_name.trim().length > 0, `${s.sci_name}: a co-occupant with no name`);
      assert.ok(a.where.trim().length > 0, `${s.sci_name}/${a.sci_name}: a co-occupant with no position`);
    }
  }
});

// ═══ F · THE LONDON FIXTURE ════════════════════════════════════════════════
//
// public/species.json is an 8-species NORTH AMERICAN fixture (Turdus
// migratorius, Cardinalis cardinalis). Reviewed against it, this tab renders a
// blank surface: no Parakeet slip, no lit spines, no percentages, an all-silent
// Roll — and a data mismatch reads as a broken feature. species-london.json is
// the surface every design review of the Library is actually held against, so
// it gets asserted like production data.
//
//     VITE_CATALOG_URL=/dev/species-london.json npm run dev

const CATALOG_KEYS = [
  'sci_name',
  'com_name',
  'slug',
  'first_confident',
  'last_detected',
  'detection_count',
  'art_status',
  'accession',
  'weeks',
];

const STATION_40 = [
  'actitis-hypoleucos', 'aegithalos-caudatus', 'alcedo-atthis', 'alopochen-aegyptiaca',
  'anser-anser', 'anthus-trivialis', 'buteo-buteo', 'carduelis-carduelis',
  'charadrius-dubius', 'chloris-chloris', 'chroicocephalus-ridibundus', 'columba-palumbus',
  'corvus-corone', 'corvus-frugilegus', 'corvus-monedula', 'cyanistes-caeruleus',
  'dendrocopos-major', 'erithacus-rubecula', 'falco-tinnunculus', 'fringilla-coelebs',
  'fulica-atra', 'gallinula-chloropus', 'garrulus-glandarius', 'haematopus-ostralegus',
  'motacilla-alba', 'motacilla-cinerea', 'numenius-arquata', 'parus-major',
  'periparus-ater', 'phylloscopus-collybita', 'pica-pica', 'picus-viridis',
  'prunella-modularis', 'psittacula-krameri', 'regulus-regulus', 'sitta-europaea',
  'thalasseus-sandvicensis', 'troglodytes-troglodytes', 'turdus-merula', 'turdus-philomelos',
];

test('F1 the fixture is 47 rows in the exact CatalogSpecies shape — no extra key, no missing key', () => {
  // WHY: catalog.ts's normalize() silently drops or coerces anything it does not
  // recognise, so a fixture with a helpful extra field or a renamed one reviews
  // as "the feature is broken" rather than "the fixture is wrong". The nine keys
  // are rebuild_catalog.py:845-855, and they are the contract.
  assert.equal(london.length, 47);
  for (const r of london) {
    assert.deepEqual(
      Object.keys(r).sort(),
      [...CATALOG_KEYS].sort(),
      `${(r as CatalogSpecies).sci_name} has the wrong key set`,
    );
  }
});

test('F2 every stamp is the PRODUCTION format and goes through the one parser', () => {
  // WHY: rebuild_catalog.py emits 'YYYY-MM-DD HH:MM:SS' (a space, not a T) and
  // the shipped public/species.json fixture emits bare dates. A fixture in the
  // bare form lets a `new Date(iso)` regression pass every design review and
  // NaN on the only machine that matters. This fixture is deliberately in the
  // prod form, and parseCatalogDate (almanac.ts:28 — the single date parser in
  // the tree) must read every one of them.
  const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  let nullFirst = 0;
  for (const r of london) {
    for (const [field, v] of [
      ['first_confident', r.first_confident],
      ['last_detected', r.last_detected],
    ] as Array<[string, string | null]>) {
      if (v === null) {
        assert.equal(field, 'first_confident', `${r.sci_name}.${field} is null — only first_confident may be`);
        nullFirst++;
        continue;
      }
      assert.match(v, STAMP, `${r.sci_name}.${field} is not the production stamp`);
      const d = parseCatalogDate(v);
      assert.ok(d, `${r.sci_name}.${field} did not parse`);
      assert.ok(d!.y >= 2024 && d!.m >= 1 && d!.m <= 12 && d!.d >= 1 && d!.d <= 31);
    }
    if (r.first_confident && r.last_detected) {
      assert.ok(
        r.first_confident <= r.last_detected,
        `${r.sci_name}: first_confident is after last_detected`,
      );
    }
  }
  assert.equal(nullFirst, 1, 'exactly one row is heard-but-never-confidently-heard');
});

test('F3 accession is the real first-confident chronology, and null means never confident', () => {
  // WHY: the Wall prints the accession number as a permanent plate number, and
  // rebuild_catalog.py pins it in first-confident order (ties by com then sci).
  // A fixture that numbers rows 1..47 in file order reviews a wall whose plate
  // numbers are decorative, which is the exact opposite of what they claim.
  const confident = london.filter((r) => r.first_confident !== null);
  const expected = [...confident].sort((a, b) =>
    a.first_confident! < b.first_confident! ? -1
    : a.first_confident! > b.first_confident! ? 1
    : (a.com_name || '').localeCompare(b.com_name || '') || a.sci_name.localeCompare(b.sci_name),
  );
  expected.forEach((r, i) => {
    assert.equal(r.accession, i + 1, `${r.sci_name} carries the wrong accession`);
  });
  for (const r of london) {
    if (r.first_confident === null) assert.equal(r.accession, null, `${r.sci_name} was accessioned without a confident detection`);
  }
  // and the file is in species.json's own order: first_confident, then com_name,
  // nulls last — so the fixture and the nightly build render the same wall.
  const key = (r: CatalogSpecies) => `${r.first_confident ?? '￿'}\x00${r.com_name}`;
  const sorted = [...london].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  assert.deepEqual(london.map((r) => r.sci_name), sorted.map((r) => r.sci_name), 'row order is not species.json’s');
});

test('F4 weeks[] is the real phenology axis: ascending, in range, and it sums to the tally', () => {
  // WHY: the Wall's phenology ribbon and the Shelf's lit spines both read this
  // array. rebuild_catalog.py derives it from the same detection rows the count
  // comes from, so sum(weeks) == detection_count is an invariant of the real
  // data — a fixture that violates it draws a ribbon that contradicts the number
  // printed beside it, and the reviewer blames the code.
  for (const r of london) {
    let prev = 0;
    let sum = 0;
    for (const [w, n] of r.weeks) {
      assert.ok(w >= 1 && w <= 53, `${r.sci_name}: ISO week ${w} out of range`);
      assert.ok(w > prev, `${r.sci_name}: weeks are not ascending/unique at ${w}`);
      assert.ok(n > 0, `${r.sci_name}: a zero-count week was written out`);
      prev = w;
      sum += n;
    }
    assert.equal(sum, r.detection_count, `${r.sci_name}: weeks sum ${sum} != detection_count`);
  }
});

test('F5 the fixture IS this London station — all 40 real slugs, unique, slugged from sci_name', () => {
  // WHY: the 40 slugs are what the Pi in this garden has actually generated. If
  // the fixture drifts off them, the Library reviews against birds the station
  // does not hear, and the Roll's set difference — the whole honesty surface —
  // is measuring nothing real. slug is the ASSET key and is derived from
  // sci_name by the locked contract (rebuild_catalog.py:106); the join key is
  // sci_name and never the slug.
  const slugs = new Set(london.map((r) => r.slug));
  for (const s of STATION_40) assert.ok(slugs.has(s), `station slug ${s} is missing from the fixture`);
  assert.equal(slugs.size, london.length, 'duplicate slug');
  assert.equal(new Set(london.map((r) => r.sci_name)).size, london.length, 'duplicate sci_name');
  for (const r of london) {
    assert.equal(r.slug, slugify(r.sci_name), `${r.sci_name}: slug is not the locked derivation`);
    assert.match(r.sci_name, /^[A-Z][a-z]+ [a-z-]+$/, `${r.sci_name} is not a BirdNET binomial`);
    assert.ok(r.com_name.length > 0, `${r.sci_name} has no common name`);
    assert.ok(['ready', 'none', 'unknown'].includes(r.art_status), `${r.sci_name}: art_status ${r.art_status}`);
    assert.ok(r.detection_count > 0, `${r.sci_name}: a catalog row with no detections`);
  }
});

test('F6 the fixture carries the distribution the tab was designed against', () => {
  // WHY: the Library's design is downstream of two facts about THIS garden —
  // a Victorian ornament from an Africa volume is a third of everything heard,
  // and the bird Jardine declined to describe is the most-recorded of all. A
  // flat fixture makes both slips read as arbitrary trivia, the reviewer sees a
  // tab making a weak point, and the design gets blamed for the data.
  const total = london.reduce((a, r) => a + r.detection_count, 0);
  const ranked = [...london].sort((a, b) => b.detection_count - a.detection_count);
  assert.equal(ranked[0].sci_name, 'Erithacus rubecula');
  assert.equal(ranked[1].sci_name, 'Psittacula krameri');
  assert.equal(ranked[2].sci_name, 'Cyanistes caeruleus');
  // the long tail is real: everything else shares under a fifth of the station
  const tail = ranked.slice(3).reduce((a, r) => a + r.detection_count, 0);
  assert.ok(tail / total < 0.20, `the tail is ${(100 * tail) / total}% — the headline shares are diluted`);
  assert.ok(ranked[ranked.length - 1].detection_count < 20, 'no scarce rows — the Roll has no quiet end');
});

test('F7 the fixture exercises the Wall’s departure captions, not just the Library', () => {
  // WHY: the fixture is loaded with VITE_CATALOG_URL, which replaces the catalog
  // for EVERY tab, so a review session that opens the Wall must see live
  // captions there too. departuresFor also refuses to speak at all unless the
  // freshest row is inside a fortnight — a fixture whose newest stamp has aged
  // out narrates nothing anywhere, which is exactly how public/species.json
  // silently stopped exercising this path.
  const stamps = london
    .map((r) => r.last_detected)
    .filter((s): s is string => typeof s === 'string')
    .sort();
  const newest = parseCatalogDate(stamps[stamps.length - 1])!;
  const anchor = new Date(newest.y, newest.m - 1, newest.d);
  const oldest = parseCatalogDate(stamps[0])!;
  const spanDays =
    (Date.UTC(newest.y, newest.m - 1, newest.d) - Date.UTC(oldest.y, oldest.m - 1, oldest.d)) / 86_400_000;
  assert.ok(spanDays > 60, `every row was heard within ${spanDays} days — no departure can ever show`);
  // pinned to the fixture's own clock, exactly as almanac.departure T12 does,
  // so this cannot rot into a time bomb as the fixture ages.
  assert.equal(anchor.getFullYear(), 2026);
});

test('F8 the fixture keeps the errata honest — every absence the slips depend on', () => {
  // WHY: three of the five slips are arguments from ABSENCE. If a well-meaning
  // edit adds a Nightingale row "for completeness", slip No. V stops being
  // "Agreed." and becomes a contradiction printed in --mut, and nobody notices
  // because the number still renders.
  const has = (sci: string) => london.some((r) => r.sci_name === sci);
  assert.ok(!has('Luscinia megarhynchos'), 'the Nightingale must never be heard here — slip No. V');
  assert.ok(!has('Bombycilla garrulus'), 'the Waxwing must never be heard here — slip No. I');
  assert.ok(!has('Crex crex'), 'the Corn Crake is the Roll’s elegy — it is gone from this garden');
  assert.ok(has('Psittacula krameri'), 'slip No. II has no Parakeet');
  assert.ok(has('Erithacus rubecula'), 'slip No. III has no Robin');
  assert.ok(has('Turdus philomelos') && has('Turdus iliacus'), 'slip No. IV has only one owner of Turdus musicus');
  // the four corvids Jardine never described the noise of — the Roll's driest line
  for (const sci of ['Corvus frugilegus', 'Corvus corone', 'Corvus monedula', 'Pica pica']) {
    assert.ok(has(sci), `${sci} is missing — the corvid silence has nothing to be silent about`);
  }
});

test('F9 the London fixture and the shipped North American one do not overlap', () => {
  // WHY: the two fixtures answer different questions and must never be confused
  // for one another in a review. If they ever share a row, "which catalog am I
  // looking at?" becomes unanswerable from the screen, which is the failure this
  // whole file exists to prevent.
  const shipped = JSON.parse(
    readFileSync(new URL('../public/species.json', import.meta.url), 'utf8'),
  ) as CatalogSpecies[];
  const overlap = shipped.filter((s) => london.some((l) => l.sci_name === s.sci_name));
  assert.deepEqual(overlap.map((r) => r.sci_name), []);
  assert.ok(shipped.length < london.length, 'the shipped fixture is no longer the small one');
});

// ═══ G · THE SPECIES-LEVEL [sic] ═══════════════════════════════════════════
// The Roll prints Jardine's binomial and his authority beside every bird. Two of
// them are scanner damage, not Jardine: `Fringilla cælebes` for `cælebs`, and
// `Linneas` for `Linnæus`. The museum's stated position is that artefacts are
// kept and worn, never repaired — so each must reach the page wearing a visible
// [sic], and the note explaining it must survive the loader.

test('G1 a species-level artefact survives normalize with its note intact', () => {
  // WHY: the corpus carried these two findings for a full round while
  // JardineSpecies had no `sic` field at all, so asSpecies() dropped them on the
  // floor and the Roll printed the scanner's spelling as though Jardine wrote
  // it. A field the loader does not name is a field the museum silently loses.
  const j = normalize({
    version: 1,
    species: [
      {
        sci_name: 'Fringilla coelebs',
        jardine_binomial: 'Fringilla cælebes',
        jardine_authority: '',
        sic: [{ find: 'cælebes', note: 'scanner error for “cælebs”.' }],
      },
    ],
  });
  assert.equal(j.species.length, 1);
  assert.deepEqual(j.species[0].sic, [
    { find: 'cælebes', note: 'scanner error for “cælebs”.', offset: null },
  ]);
});

test('G2 EVERY committed artefact matches a field the Roll actually renders', () => {
  // WHY — the anti-fail-open guard, and the reason this section exists.
  // sicNodes() marks a needle by indexOf: when the needle is absent it returns
  // the text UNCHANGED and throws nothing, so a curator's finding that names a
  // field the Roll does not print — or carries one typo — renders as ordinary
  // text with no marker and no error anywhere. That is indistinguishable on
  // screen from "this word is what Jardine wrote", which is the exact claim the
  // [sic] exists to deny.
  //
  // The two needles genuinely live in DIFFERENT fields — `cælebes` in the
  // binomial, `Linneas` in the authority — so a guard that checked only the
  // binomial would pass while the Coot's marker silently vanished. This asserts
  // against the same two fields LibraryView passes through sicNodes(), and it
  // fails loud the moment a third field is annotated without being rendered.
  const raw = corpusRaw();
  if (raw === null) {
    assert.deepEqual(normalize(raw), EMPTY, 'no corpus in the tree — the tab must degrade to silence');
    return;
  }
  const j = normalize(raw);
  const RENDERED = ['jardine_binomial', 'jardine_authority'] as const;
  let needles = 0;
  for (const s of j.species) {
    for (const artefact of s.sic) {
      needles++;
      const where = RENDERED.filter((f) => s[f].includes(artefact.find));
      assert.ok(
        where.length > 0,
        `${s.sci_name}: [sic] needle ${JSON.stringify(artefact.find)} occurs in NO field the Roll renders ` +
          `(binomial ${JSON.stringify(s.jardine_binomial)}, authority ${JSON.stringify(s.jardine_authority)}) — ` +
          `it would print unmarked, which reads as Jardine's own spelling`,
      );
      assert.ok(artefact.note.trim().length > 0, `${s.sci_name}: a [sic] with no note explains nothing`);
    }
  }
  // and the guard must have had something to check — a corpus that quietly lost
  // its artefacts would otherwise sail through the loop above with zero rounds.
  assert.ok(needles >= 2, `expected the committed artefacts, found ${needles}`);
});

test('G3 a malformed artefact list degrades to no marker, never to a throw', () => {
  // WHY: same contract as every other reader on this tab. An empty `find` is the
  // dangerous one — indexOf('') returns 0, so it would match at the head of
  // every binomial in the Roll and hang a [sic] on all forty. asSic() drops it;
  // this pins that it keeps doing so.
  const j = normalize({
    version: 1,
    species: [
      {
        sci_name: 'Fulica atra',
        jardine_binomial: 'Fulica atra',
        jardine_authority: 'Linneas',
        sic: [{ find: '', note: 'empty needle' }, 'not an object', null, { note: 'no find' }],
      },
    ],
  });
  assert.deepEqual(j.species[0].sic, []);
});

test('G4 no surface prints an 1838 name except through <JardineName>', () => {
  // WHY — the repair this guard used to compensate for.
  //
  // Three surfaces printed the same binomial three different ways and drifted:
  // the Roll marked weak provenance and kept [sic]; the Index of Silences marked
  // NEITHER, so 11 of its 16 rows claimed a confidence the extraction never had;
  // and the dossier hand-rolled `=== 'synonymy'` with the tooltip inlined, so it
  // contradicted the Roll about the same name. Each was fixed separately and each
  // fix was a guard bolted onto a duplication.
  //
  // <JardineName> collapses them. A name rendered through it cannot lose its
  // verify marker or its [sic] because there is nowhere left to forget them. So
  // this no longer asserts that a call is present — it asserts that the RAW
  // strings are not rendered at all, which is what actually makes the bug
  // unrepresentable. A new section printing a bare binomial fails on the day it
  // is written.
  for (const file of CONSUMERS) {
    const body = stripComments(readFileSync(new URL(file, import.meta.url), 'utf8'))
      .replace(/\s+/g, ' ');
    for (const field of ['jardine_binomial', 'jardine_authority']) {
      // a JSX interpolation of the raw string — `{x.jardine_binomial}` or
      // `{x.jardine_binomial || '—'}` — is the regression this catches.
      const raw = new RegExp(`\\{\\s*[A-Za-z_$][\\w$]*\\.${field}\\s*(\\||\\})`);
      assert.ok(
        !raw.test(body),
        `${file} renders a raw ${field} instead of <JardineName> — that copy would ` +
          `silently lose its [sic] and its provenance marker`,
      );
    }
  }
  // and the component itself must still do both jobs
  const jn = stripComments(readFileSync(new URL('../src/components/JardineName.tsx', import.meta.url), 'utf8'));
  assert.match(jn, /sicSpans\(/, '<JardineName> no longer marks OCR artefacts');
  assert.match(jn, /weakSource\(/, '<JardineName> no longer marks weak provenance');
});

test('G5 every binomial_source in the corpus survives normalize AND is classified', () => {
  // WHY — the Grey Lag-goose bug, pinned so it cannot come back. Its row carries
  // binomial_source 'scaps' (the tertiary discriminator, the WEAKEST of the
  // three paths). The union listed only 'em' | 'synonymy', so asEnum() nulled it
  // and the Roll's `=== 'synonymy'` test went false — leaving the single most
  // weakly-sourced binomial in the corpus as the one row wearing NO verify
  // marker. A row silently losing its provenance marker looks exactly like a row
  // that never needed one, which is the fail-open shape this project keeps
  // shipping.
  //
  // Two independent halves, because they break independently: the LOADER must
  // not null a source the data actually uses, and the VIEW must classify every
  // member of the union. Adding a fourth source to the type without teaching
  // weakSource() about it fails here rather than on the wall.
  const raw = corpusRaw();
  if (raw === null) {
    assert.deepEqual(normalize(raw), EMPTY, 'no corpus in the tree — the tab must degrade to silence');
    return;
  }
  const rawSources = new Set(
    ((raw as { species?: Array<{ binomial_source?: unknown }> }).species ?? [])
      .map((s) => s.binomial_source)
      .filter((v): v is string => typeof v === 'string' && v !== ''),
  );
  assert.ok(rawSources.size > 0, 'the corpus reports no binomial_source at all');

  // half 1 — the loader keeps every source the data actually uses
  const j = normalize(raw);
  const kept = new Set(j.species.map((s) => s.binomial_source).filter(Boolean));
  for (const src of rawSources) {
    assert.ok(
      kept.has(src as (typeof j.species)[number]['binomial_source']),
      `binomial_source ${JSON.stringify(src)} is in the corpus but normalize() nulls it — ` +
        `add it to the JardineBinomialSource union, or the row loses its provenance marker silently`,
    );
  }

  // half 2 — ONE authority classifies the union, and nobody hand-rolls it.
  //
  // This half used to grep a single hard-coded view for `case '<member>':`,
  // which is the scoped-guard shape this repo keeps shipping: it stayed green
  // while the Index of Silences printed 11 weak-sourced binomials with no
  // marker at all, and while BirdPopup hand-rolled `=== 'synonymy'` with the
  // tooltip inlined, so the dossier and the Roll disagreed about the same name.
  // Now it asserts the CLASS: weakSource() handles every weak member, and no
  // file anywhere compares binomial_source itself.
  const lib = readFileSync(new URL('../src/jardine.ts', import.meta.url), 'utf8');
  const union = /export type JardineBinomialSource =([^;]+);/.exec(lib);
  assert.ok(union, 'could not find the JardineBinomialSource union');
  const members = [...union[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(members.includes('em'), 'the strong path vanished from the union');
  for (const m of members.filter((x) => x !== 'em')) {
    assert.match(
      lib,
      new RegExp(`case '${m}':`),
      `weakSource() has no case for '${m}' — it would fall through to strong and print no verify marker`,
    );
  }
  for (const file of CONSUMERS) {
    const body = stripComments(readFileSync(new URL(file, import.meta.url), 'utf8'));

    // (a) nobody re-implements the rule
    assert.ok(
      !/binomial_source\s*===/.test(body),
      `${file} compares binomial_source directly instead of calling weakSource() — ` +
        `that is how the Roll, the Index of Silences and the dossier drifted apart`,
    );

  }
  // (b) the provenance rule now has exactly ONE caller — the component. That is
  //     the point of collapsing it: a second caller is a second chance to get it
  //     wrong, so this fails if one reappears outside <JardineName>.
  const jn = readFileSync(new URL('../src/components/JardineName.tsx', import.meta.url), 'utf8');
  assert.match(jn, /weakSource\(/, '<JardineName> stopped classifying provenance');
});

// ═══ H · THE SILENCE, AND THE SEAL ═════════════════════════════════════════

test('H1 the counterpoint branches on voice===null, NEVER on note!==null', () => {
  // WHY — the fabricated-absence trap, and the reason this selector exists at
  // all. FIVE species carry BOTH a voice and a note; on those the note is
  // commentary, not a silence. A branch written the obvious way (`note ? …`)
  // prints "the library never described its voice" under five birds whose
  // voices Jardine described at length. That is a fabricated absence — the same
  // class of error as a fabricated presence, and far harder to catch, because
  // it reads as modesty rather than as a lie.
  const raw = corpusRaw();
  if (raw === null) {
    assert.equal(counterpointFor(null), null, 'no corpus — the selector must still be total');
    return;
  }
  const j = normalize(raw);
  const both = j.species.filter((s) => s.voice && (s.note ?? '').trim());
  assert.ok(both.length > 0, 'the fixture no longer exercises the voice+note overlap');
  for (const s of both) {
    const c = counterpointFor(s);
    assert.equal(
      c?.kind,
      'voice',
      `${s.sci_name} carries a voice AND a note — it must read as VOICE, not as a silence`,
    );
  }
  for (const s of j.species.filter((x) => x.voice === null && (x.note ?? '').trim())) {
    assert.equal(counterpointFor(s)?.kind, 'silence', `${s.sci_name} should read as a silence`);
  }
  // total on every degenerate input the loader can hand it
  assert.equal(counterpointFor(null), null);
});

test('H2 the Index of Silences is loudest-first and never shows an unexplained blank', () => {
  // WHY: the ordering IS the argument — inverted from the Roll on purpose so the
  // ledger opens on the bird this garden shouts about most and the library is
  // quietest on. If someone "fixes" it to match the Roll, the section still
  // renders and quietly stops making its point, which no type can catch.
  // And a silence with no note is indistinguishable from a bug: this section
  // exists to make absence legible, so an unexplained one must not appear.
  const raw = corpusRaw();
  if (raw === null) {
    assert.deepEqual(silences(EMPTY, []), [], 'no corpus — the section must be empty, not absent');
    return;
  }
  const j = normalize(raw);
  const rows = silences(j, london);
  assert.ok(rows.length > 0, 'no silences at all — the corpus lost its notes');
  for (const r of rows) {
    assert.equal(r.species.voice, null, `${r.species.sci_name} has a voice and is not a silence`);
    assert.ok((r.species.note ?? '').trim(), `${r.species.sci_name} is a blank, not a documented silence`);
  }
  const counts = rows.map((r) => r.count);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a), 'the index is not loudest-first');
  // the point of the inversion, pinned: the top row must be a bird the garden
  // actually shouts about, not an alphabetical accident.
  assert.ok(rows[0].count > 0, 'the loudest silence has no recordings — the catalog join broke');
  // an empty catalog must not throw and must not invent tallies
  for (const r of silences(j, [])) assert.equal(r.count, 0);
});

test('H3 the colophon admits the acceptance pass is unsigned', () => {
  // WHY — this was a LIVE defect, not a hypothetical. The colophon rendered
  // "hand-proofed by {verified_by} on {verified_at}" unconditionally while both
  // fields are null, and asString() coerces null to '', so the museum shipped
  // the sentence "hand-proofed by  on " — a claim of human acceptance that has
  // never happened, printed as two blanks nobody reads. The one line on the tab
  // whose entire job is honesty was the least honest line on it.
  //
  // NEGATIVE-TESTED both ways, because a seal that cannot fail is not a seal.
  const unsigned = sealLine({ verified_by: '', verified_at: '' });
  assert.ok(!/hand-proofed by/i.test(unsigned), 'an unsigned corpus still claims a hand-proofing');
  assert.match(unsigned, /unsigned/i);
  // whitespace is not a signature
  assert.ok(!/hand-proofed by/i.test(sealLine({ verified_by: '   ', verified_at: '  ' })));
  // half a signature is not a signature
  assert.ok(!/hand-proofed by/i.test(sealLine({ verified_by: 'V. Podoliako', verified_at: '' })));
  assert.ok(!/hand-proofed by/i.test(sealLine({ verified_by: '', verified_at: '2026-07-27' })));
  assert.ok(!/hand-proofed by/i.test(sealLine(null)));
  // and it CAN say so once a human actually signs — otherwise this guard is inert
  assert.match(
    sealLine({ verified_by: 'V. Podoliako', verified_at: '2026-07-27' }),
    /hand-proofed by V\. Podoliako on 2026-07-27/,
  );
  // the committed corpus is, as of today, unsigned — and must say so
  const raw = corpusRaw() as { colophon?: unknown } | null;
  if (raw && raw.colophon) {
    const j = normalize(raw);
    if (!(j.colophon?.verified_by ?? '').trim()) {
      assert.ok(!/hand-proofed by/i.test(sealLine(j.colophon)));
    }
  }
});

test('H4 the dossier actually RENDERS the silence leg', () => {
  // WHY: H1 proves the selector classifies; nothing else proves the popup shows
  // it. They break independently — deleting the <p> leaves H1 green while 16 of
  // 47 species silently go back to rendering their binomial, then "Vol. XXIV",
  // then nothing. Source-level for the same reason as G4: no DOM in this suite.
  const src = readFileSync(new URL('../src/components/BirdPopup.tsx', import.meta.url), 'utf8')
    .replace(/\s+/g, ' ');
  assert.ok(src.includes('counterpointFor(jardine)'), 'the dossier no longer asks the one branch point');
  assert.ok(
    /counterpoint\?\.kind === 'silence'/.test(src),
    'the dossier has no silence branch — voice:null birds render nothing again',
  );
});

test('H5 the Index never prints a bird this garden has not heard', () => {
  // WHY — the fixture-vs-production trap, which already shipped once.
  //
  // This section's argument is "the book is silent and the microphone is not".
  // A bird the microphone has never heard makes no such argument: it renders a
  // bare `0 recorded here` next to a Listen button that 404s. That is invisible
  // in the committed fixture and was live on the real station, because the
  // fixture and the station are DIFFERENT sets of 47 — the fixture carries the
  // Herring Gull and the Starling, and the station has never heard either.
  //
  // Asserted against a catalog deliberately missing rows, so the guard tests the
  // RULE rather than today's data: any silent species absent from the catalog,
  // or present with a zero tally, must not reach the page.
  const raw = corpusRaw();
  if (raw === null) {
    assert.deepEqual(silences(EMPTY, []), []);
    return;
  }
  const j = normalize(raw);
  const silent = j.species.filter((s) => s.voice === null && (s.note ?? '').trim());
  assert.ok(silent.length > 2, 'too few silences to exercise the rule');

  // half the silent birds heard, half not heard at all, one heard exactly zero times
  const heard = silent.slice(0, Math.floor(silent.length / 2));
  const zeroed = silent[silent.length - 1];
  const catalog = [
    ...heard.map((s, i) => ({ ...london[0], sci_name: s.sci_name, detection_count: i + 1 })),
    { ...london[0], sci_name: zeroed.sci_name, detection_count: 0 },
  ] as CatalogSpecies[];

  const rows = silences(j, catalog);
  assert.deepEqual(
    rows.map((r) => r.species.sci_name).sort(),
    heard.map((s) => s.sci_name).sort(),
    'the Index rendered a bird the catalog does not report hearing',
  );
  for (const r of rows) {
    assert.ok(r.count > 0, `${r.species.sci_name} rendered with a zero tally`);
  }
  // and with no catalog at all the section is empty, not a wall of zeroes
  assert.deepEqual(silences(j, []), []);
});

test('H6 the Roll’s elegy names its subject and is a real 1838 sentence', () => {
  // WHY: roll_closing has been typed, defaulted, normalized, counted and fully
  // rendered with an Attribution since the tab was built — and absent from the
  // data, so the Roll's closing line had never once appeared. Now that it ships,
  // it carries a failure mode no other passage has: it is the ONE passage on the
  // tab that stands alone, beneath a ledger rather than beside its own bird.
  // Its sentence is "In Ireland it has not been seen for a hundred years", whose
  // "it" is bound two sentences earlier in the source. Printed without a subject
  // the pronoun dangles and the elegy becomes a riddle — and no type can catch
  // that, because a string is a string.
  const raw = corpusRaw();
  if (raw === null) {
    assert.equal(normalize(raw).roll_closing, null, 'no corpus — the Roll must simply end');
    return;
  }
  const j = normalize(raw);
  const c = j.roll_closing;
  if (c === null) return; // optional by contract: absent means the Roll just ends
  assert.ok(c.speaker.trim(), 'the elegy has no speaker');
  assert.equal(c.is_quotation, false, 'the elegy is a quotation — it would be the wrong man’s grief');
  assert.ok(c.subject && c.subject.trim(), 'the elegy names no subject — its "it" dangles');
  // the subject must not be smuggled in as a caption: it is a real account
  // heading, so it must not appear inside the 1838 sentence itself
  assert.ok(
    !c.text.includes(c.subject),
    'the subject duplicates text already in the sentence — drop the label instead',
  );
  const vol = j.volumes.find((v) => v.n === c.volume);
  assert.ok(vol, `the elegy cites volume ${c.volume}, which is not in the shelf`);
  assert.equal(vol.author, c.volume_author, 'the elegy is filed under the wrong author');
  // and the view must actually print the subject
  const src = readFileSync(new URL('../src/views/LibraryView.tsx', import.meta.url), 'utf8')
    .replace(/\s+/g, ' ');
  assert.ok(
    src.includes('jardine.roll_closing.subject'),
    'the elegy renders without its subject — the pronoun dangles on the wall',
  );
});

// ═══ I · THE AIM (?read=) ══════════════════════════════════════════════════

test('I1 an explicit aim outranks the loudest bird AND the rotation', () => {
  // WHY: "in the library →" used to clear the bird and write no replacement, so
  // the desk fell through to tier 1, "the loudest bird in the window". With this
  // garden's measured 81% three-bird concentration that meant the Robin or the
  // Parakeet almost regardless of which bird the reader had open — the button
  // named one destination and delivered another.
  const raw = corpusRaw();
  if (raw === null) return;
  const j = normalize(raw);
  const voiced = j.species.filter((s) => s.voice);
  const target = voiced[voiced.length - 1];
  const loudest = voiced[0];
  const rows = [
    { sci: loudest.sci_name, com: '', slug: '', n: 9999, isNew: false },
    { sci: target.sci_name, com: '', slug: '', n: 1, isNew: false },
  ];
  const got = pick({
    species: j.species, rows, catalog: london, windowHours: 1,
    now: new Date('2026-07-27T09:00:00Z'), aim: target.sci_name,
  } as DeskArgs);
  assert.equal(got?.sci_name, target.sci_name, 'the aim lost to the loudest bird');
});

test('I2 the aim is guarded on step ALONE, never on the window', () => {
  // WHY — the scoped-guard trap, named in advance by the design round and
  // recorded as this project's signature failure. Tier 1 is guarded on
  // `step === 0 && windowHours <= 24`. If tier 0 inherits that second clause,
  // a reader on the 7-day window is silently un-aimed and the button quietly
  // resumes lying — for the ONE cohort least likely to notice, because a 7-day
  // window makes the rotation look plausible.
  const raw = corpusRaw();
  if (raw === null) return;
  const j = normalize(raw);
  const target = j.species.filter((s) => s.voice).slice(-1)[0];
  for (const windowHours of [1, 12, 24, 168, 8760]) {
    const got = pick({
      species: j.species, rows: [], catalog: london, windowHours,
      now: new Date('2026-07-27T09:00:00Z'), aim: target.sci_name,
    } as DeskArgs);
    assert.equal(got?.sci_name, target.sci_name, `the aim was dropped at windowHours=${windowHours}`);
  }
  // but turning the page IS a request for a different passage, so it releases it
  const stepped = pick({
    species: j.species, rows: [], catalog: london, windowHours: 1,
    now: new Date('2026-07-27T09:00:00Z'), aim: target.sci_name, step: 1,
  } as DeskArgs);
  assert.notEqual(stepped?.sci_name, target.sci_name, 'the aim survived the reader turning the page');
});

test('I3 a SILENT bird can be aimed at, and the desk says so', () => {
  // WHY: deskPool requires voice !== null, so without tier 0 handling silence
  // the aim falls through to rotation for 19 of 51 species — the reader clicks
  // "in the library →" on the Blue Tit and is shown an unrelated bird's passage
  // as though it were the answer. The Blue Tit is the third-loudest bird in this
  // garden, so that is not an edge case.
  const raw = corpusRaw();
  if (raw === null) return;
  const j = normalize(raw);
  const silent = j.species.find((s) => s.voice === null && (s.note ?? '').trim());
  assert.ok(silent, 'no silent species to aim at');
  const got = pick({
    species: j.species, rows: [], catalog: london, windowHours: 1,
    now: new Date('2026-07-27T09:00:00Z'), aim: silent.sci_name,
  } as DeskArgs);
  assert.equal(got?.sci_name, silent.sci_name, 'aiming at a silent bird fell through to rotation');
  const view = readFileSync(new URL('../src/views/LibraryView.tsx', import.meta.url), 'utf8')
    .replace(/\s+/g, ' ');
  assert.ok(
    /!sp\.voice && sp\.note/.test(view),
    'the desk renders nothing for an aimed silent bird — the dossier bug, on a bigger surface',
  );
});

test('I4 an unknown or malformed aim degrades to the desk choosing for itself', () => {
  // WHY: ?read= is untrusted input off a URL. It must never throw, never blank
  // the desk, and never be coerced into a lookup — an unrecognised name simply
  // means the reader did not name a bird this library holds.
  const raw = corpusRaw();
  if (raw === null) return;
  const j = normalize(raw);
  for (const aim of ['Nonexistent bird', '', '   ', 'DROP TABLE birds', null, undefined]) {
    const got = pick({
      species: j.species, rows: [], catalog: london, windowHours: 1,
      now: new Date('2026-07-27T09:00:00Z'), aim,
    } as DeskArgs);
    assert.ok(got, `aim ${JSON.stringify(aim)} blanked the desk instead of falling through`);
  }
});

test('I5 the Play reveal uses the ONE selector, and degrades to the old game', () => {
  // WHY: Jardine reached only four files — jardine.ts, config.ts, BirdPopup and
  // the two Library views. Play is the first surface he leaves them for, and the
  // temptation there is a local `species.voice ? … : …`, which is exactly how the
  // Roll, the Index of Silences and the dossier drifted into three different
  // answers about which birds are silent. It must ask counterpointFor().
  //
  // And /play must survive an absent corpus: fetchJardine() resolves to the
  // empty shape, speciesBySci() yields an empty map, get() returns undefined,
  // counterpointFor(undefined) is null, and the block never mounts.
  const src = readFileSync(new URL('../src/play/Play.tsx', import.meta.url), 'utf8')
    .replace(/\s+/g, ' ');
  assert.ok(src.includes('counterpointFor('), '/play hand-rolls the voice/silence branch');
  assert.ok(
    !/\bq\.answer\b[^;]{0,80}\.voice\s*\?/.test(src),
    '/play tests .voice directly instead of asking the selector',
  );
  assert.equal(counterpointFor(undefined as unknown as null), null, 'an absent row must be silent, not a throw');
  assert.equal(speciesBySci(EMPTY).size, 0, 'the empty corpus must yield an empty map');
});

test('I6 every CSS variable the Library uses is actually defined somewhere', () => {
  // WHY: a var() with a fallback NEVER fails loudly. I shipped --pl-ink,
  // --pl-mut, --pl-rule and --rule — four tokens that exist in no stylesheet in
  // this repo — and because each carried a fallback, the pages rendered with
  // hardcoded guesses instead of the theme's own palette. Nothing was red: not
  // tsc, not oxlint, not the browser console, not a single one of the other 59
  // tests. It is the fail-open class in CSS clothing, and the only way to catch
  // it is to check that every token resolves.
  const files = [
    '../src/views/LibraryView.css',
    '../src/views/LibraryFrameView.css',
    '../src/components/BirdPopup.css',
    '../src/play/play.css',
  ];
  const defined = new Set<string>();
  const bodies = new Map<string, string>();
  for (const f of [...files, '../src/index.css', '../src/App.css']) {
    let body = '';
    try {
      body = readFileSync(new URL(f, import.meta.url), 'utf8');
    } catch {
      continue; // an optional stylesheet may not exist
    }
    bodies.set(f, body);
    for (const m of body.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1]);
  }
  // A custom property may also be set INLINE from JS (`{'--pos': …}` as a
  // CSSProperties style object), which is a real definition the stylesheets
  // cannot see. Scan the components for those too, or the audit cries wolf on
  // --pos and --scale and gets weakened by the next person to hit it.
  for (const f of ['../src/views/LibraryView.tsx', '../src/components/BirdPopup.tsx']) {
    try {
      const body = readFileSync(new URL(f, import.meta.url), 'utf8');
      for (const m of body.matchAll(/'(--[a-zA-Z0-9-]+)'\s*:/g)) defined.add(m[1]);
    } catch {
      /* optional */
    }
  }
  assert.ok(defined.size > 5, 'no custom properties found at all — the audit is vacuous');
  const bad: string[] = [];
  for (const f of files) {
    const body = bodies.get(f);
    if (!body) continue;
    for (const m of body.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
      if (!defined.has(m[1])) bad.push(`${f} uses ${m[1]}`);
    }
  }
  assert.deepEqual(
    bad,
    [],
    'these custom properties are used but defined nowhere, so they silently fall back:\n  ' +
      bad.join('\n  '),
  );
});

// ═══ J · THE FULL ACCOUNT ══════════════════════════════════════════════════

test('J1 every passage in the accounts file clears the same walls as the curated one', () => {
  // WHY: this file is 3.6x the curated payload and nobody reads it line by line.
  // It carries the SAME risk the curated file does — a flattened quotation puts
  // a stranger's sentence under a named dead man — and it must clear the same
  // walls: no quotation, no blank speaker, and a volume that is actually on the
  // shelf. A generator is not a guarantee; the shipped bytes are.
  const raw = accountsRaw();
  if (raw === null) return; // optional by contract: absent → no reading affordance
  const acc = raw as Record<string, unknown>;
  const curated = corpusRaw();
  if (curated === null) return;
  const j = normalize(curated);
  const known = new Set(j.species.map((s) => s.sci_name));
  const vols = new Set(j.volumes.map((v) => v.n));
  let n = 0;
  for (const [sci, rows] of Object.entries(acc)) {
    assert.ok(known.has(sci), `${sci} is in the accounts file but not in the curated corpus`);
    assert.ok(Array.isArray(rows) && rows.length > 0, `${sci} has no passages`);
    for (const p of rows as Array<Record<string, unknown>>) {
      n++;
      assert.equal(p.is_quotation, false, `${sci}: a QUOTATION reached the accounts file`);
      assert.ok(
        typeof p.speaker === 'string' && p.speaker.trim(),
        `${sci}: a passage with no speaker reached the accounts file`,
      );
      assert.ok(typeof p.text === 'string' && p.text.trim(), `${sci}: an empty passage`);
      assert.ok(vols.has(p.volume as number), `${sci}: cites volume ${p.volume}, not on the shelf`);
    }
  }
  assert.ok(n > 100, `expected the full reservoir, found ${n} passages`);
});

test('J2 the full account CONTAINS the curated reading, never contradicts it', () => {
  // WHY — the subtle one. Two files now describe the same bird. If the curated
  // voice is not verbatim inside its own account, the tab shows one sentence on
  // the desk and a different set of sentences behind "the whole account", and a
  // reader who notices cannot tell which is the library and which is the museum
  // editing it. They must be the same text, selected differently.
  const raw = accountsRaw();
  const curated = corpusRaw();
  if (raw === null || curated === null) return;
  const acc = raw as Record<string, Array<{ text: string }>>;
  const j = normalize(curated);
  // The curator marks an EXCERPT with a leading and/or trailing ellipsis — "… When
  // roused from this perch, … whistle. …" — an honest convention that says "this
  // is a slice of a paragraph, not the paragraph". So the invariant is not
  // equality but CONTAINMENT: strip the marks and what remains must appear
  // verbatim inside the account. That is the stronger assertion anyway — it
  // proves the curated reading was cut from this prose rather than paraphrased
  // from it, which equality alone would not distinguish from a lucky match.
  const core = (t: string): string => t.trim().replace(/^…\s*/, '').replace(/\s*…$/, '').trim();
  let checked = 0;
  for (const s of j.species) {
    const rows = acc[s.sci_name];
    if (!rows) continue;
    for (const f of ['voice', 'coda'] as const) {
      const p = s[f];
      if (!p) continue;
      checked++;
      const needle = core(p.text);
      assert.ok(needle.length > 20, `${s.sci_name}.${f} is too short to verify`);
      assert.ok(
        rows.some((r) => r.text.includes(needle)),
        `${s.sci_name}.${f} does not appear verbatim in its own full account — the desk and ` +
          `the reading room would show different text for the same bird`,
      );
    }
  }
  assert.ok(checked > 20, `expected to check the curated readings, checked ${checked}`);
});

test('J3 a missing or malformed accounts file degrades to no reading room', async () => {
  // WHY: same contract as every other reader on this tab. The affordance is
  // gated on the fetch resolving to something, so a 404, a non-object body, or
  // a body of empty arrays must all collapse to {} and simply remove the
  // feature — never a throw, never an empty dialog.
  const realFetch = globalThis.fetch;
  try {
    for (const body of ['not json', '[]', '{"x":"y"}', '{"Turdus merula":[]}', 'null']) {
      globalThis.fetch = (async () =>
        new Response(body, { status: 200 })) as unknown as typeof fetch;
      const out = await fetchAccounts();
      assert.deepEqual(out, {}, `body ${body} should collapse to {}`);
    }
    globalThis.fetch = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    assert.deepEqual(await fetchAccounts(), {}, 'a 404 should collapse to {}');
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    assert.deepEqual(await fetchAccounts(), {}, 'a network failure should collapse to {}');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('J4 the accounts file is loaded LAZILY, never on first paint', () => {
  // WHY: it is ~277 KB against the curated file's ~80 KB. The whole reason it is
  // a second file is that the Library's first paint must be unchanged by this
  // feature existing. If fetchAccounts() is ever called from an unconditional
  // mount effect it silently becomes a 3.6x page-weight regression that no test
  // would otherwise notice.
  const src = readFileSync(new URL('../src/views/LibraryView.tsx', import.meta.url), 'utf8')
    .replace(/\s+/g, ' ');
  assert.ok(src.includes('fetchAccounts()'), 'the reading room no longer loads its accounts');
  assert.match(
    src,
    /if \(openSci === null \|\| accounts !== null\) return;/,
    'the accounts fetch is not gated on a reader actually opening an account',
  );
});

test('K1 the frame asks the shared authorities, not its own', () => {
  // WHY: LibraryFrameView is the surface that hangs on a wall, and it was a
  // FOURTH independent renderer of the corpus — its own roman(), its own
  // dayOfYear() (off by one from jardine.ts, so the wall and the desk sat one
  // step apart in their rotations), its own [sic] engine that marked only the
  // first occurrence of each needle and dropped the curator's note entirely, and
  // its own "has this garden heard it" test.
  //
  // That last one was a live fabricated ABSENCE: it asked only whether
  // last_detected parsed, so a species with a real tally and a missing stamp
  // printed "not yet heard in this garden" about a bird the Pi had recorded.
  // I5 protects /play from exactly this class; the wall had no equivalent.
  const src = stripComments(
    readFileSync(new URL('../src/views/LibraryFrameView.tsx', import.meta.url), 'utf8'),
  );
  for (const [fn, why] of [
    ['heardHere', 'it would decide "heard" on last_detected alone and fabricate an absence'],
    ['sicSpans', 'it would mark only the first artefact and drop the curator’s note'],
    ['dayOfYear', 'its rotation would sit one day off the Reading Desk’s'],
    ['volumeRoman', 'a fourth copy of the numerals is a fourth chance to diverge'],
  ] as const) {
    assert.match(src, new RegExp(`${fn}\\s*\\(`), `the frame no longer calls ${fn}() — ${why}`);
  }
  // and it must not have re-grown a private copy of any of them
  for (const fn of ['sicSegments', 'function roman', 'function dayOfYear', 'function heardHere']) {
    assert.ok(!src.includes(fn), `the frame has re-implemented ${fn} instead of importing it`);
  }
});

test('K2 sicSpans honours the recorded offset, and falls back when it lies', () => {
  // WHY: a needle can occur several times while only ONE is the scanner's error
  // — "Ireland" is flagged in one sentence and correct in the next. Marking
  // every occurrence scars correct words; marking the first scars the wrong one.
  // The offset is what makes it precise, and an offset that no longer lands on
  // the needle must be treated as absent rather than trusted, because the text
  // is the authority and the number may have drifted from it.
  const sic = (find: string, offset: number | null) => ({ find, note: 'n', offset });
  const marked = (t: string, s: ReturnType<typeof sic>[]) =>
    sicSpans(t, s).filter((x) => x.sic).map((x) => x.text);

  const t = 'In Ireland it was seen. In Ireland it was not.';
  // the SECOND occurrence is the flagged one
  const second = t.indexOf('Ireland', 10);
  const spans = sicSpans(t, [sic('Ireland', second)]);
  const at = spans.findIndex((x) => x.sic);
  assert.equal(spans.slice(0, at).map((x) => x.text).join('').length, second, 'the wrong occurrence was marked');
  // a lying offset falls back to the first occurrence rather than marking nothing
  assert.deepEqual(marked(t, [sic('Ireland', 999)]), ['Ireland']);
  assert.deepEqual(marked(t, [sic('Ireland', null)]), ['Ireland']);
  // an empty needle matches everywhere and must be dropped, not honoured
  assert.deepEqual(marked(t, [sic('', 0)]), []);
  // a needle that is not present at all is dropped
  assert.deepEqual(marked(t, [sic('Scotland', null)]), []);
  // the note survives to the renderer — the whole reason the frame's copy was wrong
  const withNote = sicSpans('a cælebes b', [{ find: 'cælebes', note: 'scanner error', offset: null }]);
  assert.equal(withNote.find((x) => x.sic)?.sic?.note, 'scanner error');
  // and nothing is ever lost: the runs reassemble to the original text
  for (const s of [[sic('Ireland', second)], [sic('Ireland', null)], []]) {
    assert.equal(sicSpans(t, s).map((x) => x.text).join(''), t, 'sicSpans dropped or duplicated text');
  }
});

// ═══ L · THE LIBRARY OUT OF ITS ROOM ═══════════════════════════════════════

test('L1 every cross-surface reader asks the ONE selector', () => {
  // WHY: Jardine reached five files, and each new surface is a fresh chance to
  // write `s.voice ? … : …` locally. That is precisely how the Roll, the Index
  // of Silences and the dossier drifted into three different answers about which
  // birds are silent. I5 protects /play; this protects the rest.
  for (const f of ['../src/views/CollectionWallView.tsx', '../src/views/StatsView.tsx']) {
    const src = stripComments(readFileSync(new URL(f, import.meta.url), 'utf8')).replace(/\s+/g, ' ');
    assert.ok(
      /counterpointFor\(|silences\(/.test(src),
      `${f} reads the corpus without going through counterpointFor()/silences()`,
    );
    assert.ok(
      !/\.voice\s*\?/.test(src),
      `${f} hand-rolls the voice/silence branch instead of asking the selector`,
    );
  }
});

test('L2 every stylesheet the app ships is actually imported by something', () => {
  // WHY — the orphan-CSS trap, which I walked straight into while writing this
  // phase. I added .acard-ln-1838 to a NEW src/views/AtlasView.css that no
  // module imports. Vite silently omits it, the rule never loads, and the page
  // renders un-styled with nothing red anywhere: not tsc, not oxlint, not the
  // console, not a single test. It is the same fail-open shape as a var() with a
  // fallback — a stylesheet that does nothing is indistinguishable from one that
  // works until somebody looks.
  const dir = new URL('../src/', import.meta.url);
  const sheets: string[] = [];
  const walk = (d: URL): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(new URL(`${e.name}/`, d));
      else if (e.name.endsWith('.css')) sheets.push(new URL(e.name, d).pathname);
    }
  };
  walk(dir);
  assert.ok(sheets.length > 5, 'no stylesheets found — the audit is vacuous');
  const code: string[] = [];
  const walkCode = (d: URL): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walkCode(new URL(`${e.name}/`, d));
      else if (/\.tsx?$/.test(e.name)) code.push(readFileSync(new URL(e.name, d), 'utf8'));
    }
  };
  walkCode(dir);
  const all = code.join('\n');
  const orphans = sheets
    .map((p) => p.split('/').pop() as string)
    .filter((name) => !all.includes(name) && name !== 'index.css');
  assert.deepEqual(
    orphans,
    [],
    `these stylesheets are imported by nothing and silently do nothing: ${orphans.join(', ')}`,
  );
});

test('M1 both spellings of the small-caps path wear the verify marker', () => {
  // WHY: extract.py:974 writes `binomial_source = "scaps_paragraph"`; the
  // committed jardine.json carries `"scaps"`. Accepting only one means the next
  // extractor re-run emits a token the union rejects, asEnum() nulls it, and the
  // corpus's single most weakly-sourced binomial goes back to printing as though
  // the extraction were certain — silently re-opening the exact hole the union
  // was widened to close.
  for (const src of ['scaps', 'scaps_paragraph']) {
    const j = normalize({
      version: 1,
      species: [{ sci_name: 'Anser anser', jardine_binomial: 'Anser ferus', binomial_source: src }],
    });
    assert.equal(j.species[0].binomial_source, src, `normalize() nulled '${src}'`);
    assert.ok(weakSource(j.species[0]), `'${src}' is not classified as a weak path`);
  }
  // and the strong path must NOT be marked, or the marker means nothing
  const strong = normalize({
    version: 1,
    species: [{ sci_name: 'X y', jardine_binomial: 'X y', binomial_source: 'em' }],
  });
  assert.equal(weakSource(strong.species[0]), null, "'em' must not wear a verify marker");
});

test('M2 an unreachable catalog is never reported as an absence', () => {
  // WHY: fetchCatalog() collapses EVERY failure — 404, offline, malformed — to
  // [], never null. So `catalog !== null` cannot distinguish "this garden has
  // never heard it" from "species.json did not load", and the errata slips
  // asserted the former while the truth was the latter. A museum that says
  // "never heard in this garden" because its own ledger failed to load is
  // fabricating an absence, which is the same class as fabricating a presence.
  const src = stripComments(
    readFileSync(new URL('../src/views/LibraryView.tsx', import.meta.url), 'utf8'),
  ).replace(/\s+/g, ' ');
  assert.match(
    src,
    /byCatalog\.size === 0/,
    'gardenFact() no longer distinguishes an empty catalog from a real absence',
  );
  assert.match(src, /unknown/, 'the unknown state was removed from the slip');
  // silences() must agree: no catalog, no rows — never a wall of amber zeroes
  const raw = corpusRaw();
  if (raw !== null) assert.deepEqual(silences(normalize(raw), []), []);
});

test('M3 the Blind Ear claims its own number keys', () => {
  // WHY: the quiz caption reads "press 1, 2 or 3" and App owns 1–6 as global tab
  // shortcuts (App.tsx:442), so pressing 1 answered nothing and threw the reader
  // off the Library tab entirely. The instruction had never once worked.
  //
  // The listener must be CAPTURE phase to run before App's bubble listener on
  // the same target, and it must only swallow a key it actually consumes —
  // 4, 5 and 6 have to keep switching tabs from this screen.
  const src = stripComments(
    readFileSync(new URL('../src/views/LibraryView.tsx', import.meta.url), 'utf8'),
  ).replace(/\s+/g, ' ');
  assert.match(src, /press 1, 2 or 3/, 'the caption changed — re-check this guard');
  assert.match(
    src,
    /addEventListener\('keydown', onKey, true\)/,
    'the quiz listens in BUBBLE phase, so App eats 1/2/3 before it sees them',
  );
  assert.match(src, /stopImmediatePropagation\(\)/, 'the quiz does not stop App from also acting');
  assert.match(
    src,
    /n < 1 \|\| n > round\.options\.length/,
    'the quiz swallows keys outside its own options — 4/5/6 must still switch tabs',
  );
});

// ═══ N · THE PROVENANCE CHAIN ══════════════════════════════════════════════

test('N1 the sha256 printed on the wall is checkable from this repo alone', () => {
  // WHY: the colophon prints a corpus_sha256 and the Roll slices it onto the
  // wall. Until this test existed, the bytes that hash to it lived in exactly
  // ONE place — a session scratchpad under /private/tmp that gets swept — and
  // the HTML cache that could re-derive them is deliberately uncommitted and
  // already gone. The museum's central provenance claim was one `rm -rf /tmp`
  // from being permanently unfalsifiable, and re-fetching c82.net would NOT
  // restore it: a fresh fetch returns today's bytes, and a pin taken over those
  // is a different pin wearing this one's costume.
  //
  // Now the evidence is committed, gzipped, and this re-hashes it every run. If
  // the corpus and the colophon ever disagree, the wall is lying about its own
  // source and the suite says so.
  const gz = new URL('../../tools/jardine/corpus/corpus.txt.gz', import.meta.url);
  if (!existsSync(gz)) {
    assert.fail('the committed corpus is gone — the sha256 on the wall is now unverifiable');
  }
  const bytes = gunzipSync(readFileSync(gz));
  const actual = createHash('sha256').update(bytes).digest('hex');

  const raw = corpusRaw();
  if (raw === null) return;
  const pinned = normalize(raw).colophon?.corpus_sha256 ?? '';
  assert.equal(
    actual,
    pinned,
    'the committed corpus does not hash to the sha256 the colophon prints on the wall',
  );

  // and the standalone .sha256 file must agree with both — three copies of one
  // claim, which is only safe while something checks they still match
  const stated = gunzipSync(readFileSync(new URL('../../tools/jardine/corpus/corpus.sha256.gz', import.meta.url)))
    .toString('utf8')
    .trim()
    .split(/\s+/)[0];
  assert.equal(stated, actual, 'corpus.sha256 disagrees with the corpus it names');

  // the character count the README pins, re-derived rather than trusted
  assert.equal(bytes.toString('utf8').length, 2249715, 'the corpus is not the pinned length');
});

test('N2 the human acceptance documents survived with it', () => {
  // WHY: verify.tsv is the file a human must READ to sign the colophon, and
  // passages.tsv carries the attribution_lead and footnote_text for the ten
  // quotations awaiting a speaker. Both lived only in the scratchpad. Without
  // them the colophon can never honestly be signed and the ten names can never
  // be confirmed — the two open editorial items on this project both die.
  for (const f of ['verify.tsv', 'passages.tsv', 'report.json', 'dropped.tsv', 'depth-audit.tsv']) {
    const p = new URL(`../../tools/jardine/corpus/${f}.gz`, import.meta.url);
    assert.ok(existsSync(p), `${f} is missing — an audit document the corpus cannot be signed without`);
    assert.ok(gunzipSync(readFileSync(p)).length > 1000, `${f} is present but empty`);
  }
});

test('N3 no fabricated asset ships to a public path on the wall', () => {
  // WHY: Vite copies public/ wholesale, so the deployed bundle carried
  // public/dev/species-london.json — a SYNTHETIC 47-row fixture — and 15
  // Nearctic mock PNGs of birds this London garden has never heard, to
  // /collage/dev/ and /collage/mock/, on a museum whose entire claim is that
  // nothing on it is invented. Nothing links them, which is exactly why they
  // survived: no page was wrong, the wall was simply serving inventions at a
  // public URL to anyone who guessed it.
  //
  // The first fix silently did nothing — a generateBundle hook cannot see
  // publicDir, which Vite copies outside the rollup bundle, so it ran, found
  // nothing and reported success. This asserts the OUTCOME on disk, not the
  // presence of a plugin, for exactly that reason.
  const dist = new URL('../dist/', import.meta.url);
  if (!existsSync(dist)) return; // no build in the tree — nothing to assert
  for (const dir of ['dev', 'mock']) {
    assert.ok(
      !existsSync(new URL(dir + '/', dist)),
      `dist/${dir}/ shipped to the wall — that is fabricated content at a public URL`,
    );
  }
  // derived.json is the same class with a worse consequence: the deploy
  // SYMLINKS the live one into the served directory, and shipping the fixture
  // in the bundle replaced that symlink on every rsync. The wall served a
  // 2026-07-02 console (8 species) for 27 days while the real one (48 species)
  // sat on disk beside it.
  assert.ok(
    !existsSync(new URL('derived.json', dist)),
    'dist/derived.json shipped — it will overwrite the live symlink on the next deploy',
  );
  // and the sources must still be present, because dev and the suite need them
  assert.ok(existsSync(new URL('../public/dev/species-london.json', import.meta.url)),
    'the fixture was MOVED rather than excluded — the test suite reads it directly');
});

test('O1 the wall’s garden line comes from the same authority that picks the page', () => {
  // WHY — the fabricated absence, third occurrence, and the second time a FIX
  // for it shipped with a comment saying it was fixed.
  //
  // The pool asks heardHere() (a real tally counts even with no parseable
  // stamp). The footer used to re-derive the answer from heardOnLabel(
  // last_detected) alone — so a bird the Pi HAS recorded, whose stamp is missing
  // or malformed, was selected INTO the heard pool and then printed as "not yet
  // heard in this garden". Fixing the selection and leaving the label is exactly
  // how it survived. The two must not be able to disagree.
  //
  // Asserted at source level because the module has no DOM in this suite; the
  // real defence is that `garden` is derived from heardHere() at the one place
  // the page is built.
  const src = stripComments(
    readFileSync(new URL('../src/views/LibraryFrameView.tsx', import.meta.url), 'utf8'),
  ).replace(/\s+/g, ' ');

  assert.match(src, /garden: unknownLedger \? 'unknown' : !known \? 'unheard' : on \? 'dated' : 'undated'/,
    'the garden state is no longer derived from heardHere() at the point the page is built');
  // FOUR states, not three. The wall printed "not yet heard in this garden"
  // under a bird the station was hearing whenever the nightly failed to
  // publish — a fabricated absence on the one surface that gets photographed
  // and then hangs there all day. An unreadable ledger is not an absence.
  assert.match(src, /const unknownLedger = catalog === null/,
    'the frame can no longer tell an unreadable ledger from an empty one');
  assert.match(src, /page\.garden === 'unknown'[\s\S]{0,200}ledger is not to hand/,
    'the unknown state does not render its own copy — it would fall through to "not yet heard"');
  assert.match(src, /fetchCatalogOrNull\(\)/,
    'the frame reads the collapsing fetchCatalog() again, so catalog can never be null');
  assert.match(src, /const known = c \? heardHere\(c\) : false/,
    'the page no longer asks the shared authority');
  assert.ok(
    !/page\.heardOn \?/.test(src),
    'the footer branches on the DATE again — that is the fabricated absence returning',
  );
  assert.match(src, /page\.garden === 'dated'/, 'the footer no longer reads the garden state');
  // and the three states must each have distinct copy, or the distinction is
  // decorative: a recorded bird with no stamp must not read as never-heard
  assert.match(src, /'undated'[\s\S]{0,200}heard in this garden/,
    'the undated state does not say the bird WAS heard');
  assert.match(src, /not yet heard in this garden/, 'the genuine-absence copy vanished');
});

test('O2 heardHere is true on a tally alone — the predicate the wall depends on', () => {
  // WHY: O1 pins the wiring; this pins the semantics underneath it. If
  // heardHere() ever narrows to last_detected, O1 stays green while the wall
  // silently returns to fabricating absences — the guard and the thing it
  // guards must both be held.
  const row = (over: Partial<CatalogSpecies>): CatalogSpecies =>
    ({ ...london[0], ...over }) as CatalogSpecies;
  assert.equal(heardHere(row({ last_detected: '2026-07-27 06:00:00', detection_count: 0 })), true,
    'a parseable stamp must count as heard');
  assert.equal(heardHere(row({ last_detected: '', detection_count: 310 })), true,
    'A REAL TALLY WITH NO STAMP MUST COUNT AS HEARD — this is the bug');
  assert.equal(heardHere(row({ last_detected: 'not a date', detection_count: 12 })), true,
    'an unparseable stamp with a real tally must still count as heard');
  assert.equal(heardHere(row({ last_detected: '', detection_count: 0 })), false,
    'no stamp and no tally is the only genuine absence');
});

test('O3 the ledger does not count vignettes as plates', () => {
  // WHY: the masthead ledger said "N have a plate" using `plate_ref !== null`,
  // which counts the two VIGNETTES — and Erratum III, three sections further
  // down the same page, argues that the Robin was DENIED a plate. The tab
  // contradicted itself on one screen, in favour of the less flattering reading
  // of its own corpus.
  //
  // The data is right and stays untouched: plate_is_vignette is the corpus's
  // honest record of what the 1838 book actually gave each bird. Only the
  // predicate was wrong.
  const raw = corpusRaw();
  if (raw === null) return;
  const j = normalize(raw);
  const vignettes = j.species.filter((s) => s.plate_ref !== null && s.plate_is_vignette);
  assert.ok(vignettes.length > 0, 'no vignettes in the corpus — this guard is vacuous');
  // the Robin is the exhibit Erratum III is built on
  assert.ok(
    vignettes.some((s) => s.sci_name === 'Erithacus rubecula'),
    'the Robin is no longer a vignette — re-check Erratum III before changing this',
  );
  const src = stripComments(
    readFileSync(new URL('../src/views/LibraryView.tsx', import.meta.url), 'utf8'),
  ).replace(/\s+/g, ' ');
  // ASSERT THE PROPERTY, NOT THE SPELLING. This used to match the exact string
  // `plate_ref !== null && !s.plate_is_vignette`, so it went red when the
  // predicate correctly changed to test `image` instead — while still being
  // unable to catch the same bug written any other way. What Erratum III needs
  // is one thing: whatever the ledger counts, it excludes vignettes.
  const withPlate = /const withPlate = withPage\.filter\(\((\w+)\) => ([^;]*?)\)\.length;/.exec(src);
  assert.ok(withPlate, 'the ledger no longer computes withPlate — find it and re-point this guard');
  const [, param, predicate] = withPlate;
  assert.ok(
    predicate.includes(`!${param}.plate_is_vignette`),
    `the ledger counts vignettes as plates again — it now contradicts Erratum III (predicate: ${predicate})`,
  );
  // And it must count something the museum actually hangs, not merely a
  // reference: a plate_ref with no file behind it is a plate we do not have.
  assert.ok(
    predicate.includes(`${param}.image`),
    `the ledger counts plate REFERENCES, not hung plates (predicate: ${predicate})`,
  );
});

test('P1 every refused quotation is declared by the passage before it', () => {
  // WHY — my own bug from the commit that built the reading room. The builder
  // ships only what the protocol allows, which is right: 15 passages across 10
  // accounts are quotations whose speaker is only 'probable', and a probable
  // name in Cormorant under a real person is this project's one unrecoverable
  // failure. What was missing is that NOTHING RECORDED THE REFUSAL — so
  // Jardine's prose ran into the quotation and stopped mid-clause ("Mr Hewitson
  // relates his knowledge of one which") under a header reading "N passages, as
  // printed".
  //
  // Checked against the COMMITTED CORPUS, not inferred from punctuation. An
  // earlier version of this test flagged eight more passages ending in ':—' and
  // was WRONG to: those introduce a taxonomic characterisation that the
  // EXTRACTOR drops as `generic_characters`/`genus_paragraph` during
  // segmentation — a deliberate editorial exclusion of non-prose, not a
  // withholding for want of a speaker. Calling those 'withheld' would be its own
  // small lie, so this asserts only the class elided_after actually describes.
  const raw = accountsRaw();
  if (raw === null) return;
  const acc = raw as Record<string, Array<{ text: string; elided_after?: number }>>;

  const corpusGz = new URL('../../tools/jardine/corpus/corpus.json.gz', import.meta.url);
  if (!existsSync(corpusGz)) return;
  const corpus = JSON.parse(gunzipSync(readFileSync(corpusGz)).toString('utf8')) as unknown;
  const accountsOf = (o: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> => {
    if (Array.isArray(o)) o.forEach((x) => accountsOf(x, out));
    else if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) {
        if (k === 'accounts' && Array.isArray(v)) out.push(...(v as Array<Record<string, unknown>>));
        else accountsOf(v, out);
      }
    }
    return out;
  };
  const byTitle = new Map<string, Record<string, unknown>>();
  for (const a of accountsOf(corpus)) byTitle.set(String(a.jardine_title), a);

  const j = normalize(corpusRaw());
  let checked = 0;
  const wrong: string[] = [];
  for (const sp of j.species) {
    const rows = acc[sp.sci_name];
    const a = byTitle.get(sp.jardine_title);
    if (!rows || !a) continue;
    // walk the source account and count refusals between shipped passages
    let idx = -1;
    let expected = 0;
    for (const p of a.passages as Array<Record<string, unknown>>) {
      if (p.shippable === true && p.is_quotation === false) {
        if (idx >= 0 && (rows[idx].elided_after ?? 0) !== expected) {
          wrong.push(`${sp.sci_name} row ${idx}: says ${rows[idx].elided_after ?? 0}, source refused ${expected}`);
        }
        idx++;
        expected = 0;
      } else if (idx >= 0) {
        expected++;
        checked++;
      }
    }
    if (idx >= 0 && (rows[idx].elided_after ?? 0) !== expected) {
      wrong.push(`${sp.sci_name} row ${idx}: says ${rows[idx].elided_after ?? 0}, source refused ${expected}`);
    }
  }
  assert.deepEqual(wrong, [], 'the reading room miscounts what it withheld:\n  ' + wrong.join('\n  '));
  assert.ok(checked >= 15, `expected the known refusals, walked ${checked}`);
});

test('P2 the withheld marker names nobody, and is never dressed as 1838', () => {
  // WHY: the whole reason those passages are withheld is that the extraction
  // could not PROVE who was speaking. Jardine's lead-in says "Mr Hewitson" and
  // the corpus carries speaker_candidate values — using either would treat the
  // exact signal the protocol rejects as though it were evidence, which is
  // worse than the gap. And the marker is the museum talking about the book, so
  // it takes the 2026 hand: Cormorant is Jardine's, amber is a Pi measurement.
  const src = stripComments(
    readFileSync(new URL('../src/views/LibraryView.tsx', import.meta.url), 'utf8'),
  ).replace(/\s+/g, ' ');
  const marker = /elided_after > 0 && \([\s\S]{0,600}?\)\}/.exec(src)?.[0] ?? '';
  assert.ok(marker, 'the withheld marker is no longer rendered');
  for (const name of ['Hewitson', 'Thompson', 'Selby', 'Yarrell', 'Laing', 'Macgillivray']) {
    assert.ok(!marker.includes(name), `the marker names ${name} — a candidate, never a proven speaker`);
  }
  assert.ok(!/speaker_candidate/.test(src), 'the view reads speaker_candidate — that field is not evidence');
  // the class must be the mono apparatus register, not the prose one
  assert.match(marker, /lib-acct-elided/, 'the marker lost its own class');
  const css = readFileSync(new URL('../src/views/LibraryView.css', import.meta.url), 'utf8');
  const rule = /\.lib-acct-elided \{[^}]*\}/.exec(css)?.[0] ?? '';
  assert.match(rule, /var\(--mono\)/, 'the marker is not in the 2026 hand');
  assert.ok(!/--amber/.test(rule), 'the marker uses amber — that is reserved for a measured number');
  assert.ok(!/--display/.test(rule), 'the marker is set in Cormorant — that hand belongs to 1838');
});

test('Q1 no curated passage presents a severed sentence as a whole one', () => {
  // WHY: the corpus is excerpts, and the curator marks one with a leading and/or
  // trailing '…'. 41 of the 58 carry a leading marker and 36 a trailing one — so
  // the convention is real, load-bearing and nearly universal. An excerpt that
  // stops mid-clause WITHOUT it is not a smaller claim, it is a different one:
  // it says Jardine ended his thought there.
  //
  // Exactly one passage broke it, and it was the worst possible one — the
  // EPIGRAPH, the first sentence on the tab. It ended "…can only be felt by
  // hearing;" while the source continues "; and it appears to be uttered on
  // alarm…". A semicolon presented as a full stop, in display type, above
  // everything else. Found by reading the tab (tools/read-library.ts), not by
  // any of the 80 tests that were green at the time.
  //
  // P1 guards this class inside the reading room. Nothing guarded the curated
  // passages, which are the ones a visitor actually meets first.
  const raw = corpusRaw();
  if (raw === null) return;
  const j = normalize(raw);
  const all: Array<[string, JardinePassage]> = [];
  if (j.epigraph) all.push(['epigraph', j.epigraph]);
  if (j.roll_closing) all.push(['roll_closing', j.roll_closing]);
  for (const s of j.species) {
    if (s.voice) all.push([`${s.sci_name}.voice`, s.voice]);
    if (s.coda) all.push([`${s.sci_name}.coda`, s.coda]);
  }
  for (const e of j.errata) if (e.quote) all.push([`errata[${e.no}]`, e.quote]);
  assert.ok(all.length > 40, 'too few curated passages to audit');

  const severed = all
    .filter(([, p]) => !/[.!?…”"]$/.test(p.text.trim()))
    .map(([k, p]) => `${k}: …${p.text.trim().slice(-52)}`);
  assert.deepEqual(
    severed,
    [],
    'these curated passages stop mid-clause with no excerpt marker, so they claim ' +
      'Jardine ended his thought there:\n  ' + severed.join('\n  '),
  );

  // and the convention must still be IN USE — if every marker vanished the rule
  // above would pass vacuously on a corpus that had quietly stopped excerpting
  const marked = all.filter(([, p]) => /…/.test(p.text)).length;
  assert.ok(marked > 20, `only ${marked} passages carry an excerpt marker — the convention has lapsed`);
});

test('Q2 a closing that makes a live claim stops printing when it stops being true', () => {
  // WHY: two of the five errata closings are not remarks about the book, they
  // are assertions about THIS garden. "Agreed." concedes Jardine's point that a
  // Nightingale is absent; another asserts which bird is most-recorded. Both
  // printed unconditionally. The card's TONE already flipped on the data — the
  // sentence underneath it did not, so a red slip would have gone on agreeing.
  //
  // The contingency is declared in the data (closing_requires) rather than
  // hardcoded per erratum, so a sixth slip states its own dependency instead of
  // inheriting somebody's memory of which two were special.
  const raw = corpusRaw();
  if (raw === null) return;
  const j = normalize(raw);
  const gated = j.errata.filter((e) => e.closing_requires !== null);
  assert.ok(gated.length >= 2, 'no closing declares a contingency — the gate is vacuous');

  const map = (rows: CatalogSpecies[]) => new Map(rows.map((r) => [r.sci_name, r]));
  const row = (sci: string, n: number) => ({ ...london[0], sci_name: sci, detection_count: n, last_detected: '2026-07-28 06:00:00' }) as CatalogSpecies;

  for (const e of gated) {
    const subj = e.subjects.map((s) => s.sci_name);
    assert.ok(subj.length > 0, `${e.no} declares a contingency but names no subject`);

    if (e.closing_requires === 'all_absent') {
      // holds while the bird is unheard …
      assert.equal(closingHolds(e, map([row('Zzz zzz', 5)])), true, `${e.no} should hold while absent`);
      // … and must go silent the moment it is heard
      assert.equal(closingHolds(e, map([row(subj[0], 1)])), false,
        `${e.no} still concedes after the bird was detected`);
    } else {
      // holds while a subject is the most-recorded bird …
      assert.equal(closingHolds(e, map([row(subj[0], 900), row('Zzz zzz', 10)])), true,
        `${e.no} should hold while its subject is top`);
      // … and must go silent once something outranks it
      assert.equal(closingHolds(e, map([row(subj[0], 10), row('Zzz zzz', 900)])), false,
        `${e.no} still claims the top spot after being outranked`);
    }
    // and an unreachable ledger proves nothing, so it holds nothing
    assert.equal(closingHolds(e, map([])), false, `${e.no} asserts a live claim with no catalog`);
  }

  // a timeless closing must NOT be gated away — the remark about the book stands
  for (const e of j.errata.filter((x) => x.closing_requires === null && x.closing)) {
    assert.equal(closingHolds(e, map([])), true, `${e.no} is a remark about the book and must always print`);
  }

  // and the view must actually consult the gate
  const src = stripComments(
    readFileSync(new URL('../src/views/LibraryView.tsx', import.meta.url), 'utf8'),
  ).replace(/\s+/g, ' ');
  const sites = src.match(/e\.closing &&/g) ?? [];
  const gatedSites = src.match(/e\.closing && closingHolds\(e, byCatalog\)/g) ?? [];
  assert.equal(gatedSites.length, sites.length,
    `${sites.length - gatedSites.length} closing render site(s) bypass the gate`);
});

// ═══ R · THE CORPUS vs A CATALOG THAT GROWS ════════════════════════════════

test('R1 no bird is called silent while its account sits in the corpus', () => {
  // WHY — the fourth and worst fabricated absence on this project.
  //
  // The live Roll printed "Gray Heron — the library is silent." That was FALSE:
  // Jardine's Common Heron (v34-025, vol XXXIV, five paragraphs, binomial
  // byte-identical to the modern one) was inside this museum's own verified
  // extraction the whole time. It was never added because the corpus was pinned
  // on 2026-07-27 and the garden first heard a heron on 2026-07-28. One day.
  //
  // THE ONE-OFF ROW IS NOT THE FIX. The corpus is static and the catalog rebuilds
  // nightly and grows — the station is weeks old and still gaining birds — so
  // every new species is a fresh chance to print the same lie, in the same column
  // as the museum's most carefully earned TRUE silences, indistinguishable from
  // them. This is the fix: the gap must fail a test, not greet a visitor.
  //
  // It asserts against the COMMITTED corpus, so it holds without a network. The
  // catalog it checks is the committed fixture; a species the live station gains
  // is caught the next time the fixture is refreshed or the reader is run with
  // --live. That is a real limit and it is why tools/read-library.ts exists.
  const j = normalize(corpusRaw());
  const have = new Set(j.species.map((s) => s.sci_name));

  const gz = new URL('../../tools/jardine/corpus/corpus.json.gz', import.meta.url);
  if (!existsSync(gz)) {
    assert.fail('the committed corpus is gone — coverage can no longer be checked at all');
  }
  const corpus = JSON.parse(gunzipSync(readFileSync(gz)).toString('utf8')) as unknown;
  const walk = (o: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> => {
    if (Array.isArray(o)) o.forEach((x) => walk(x, out));
    else if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) {
        if (k === 'accounts' && Array.isArray(v)) out.push(...(v as Array<Record<string, unknown>>));
        else walk(v, out);
      }
    }
    return out;
  };
  // an account is only a candidate if its 1838 binomial is byte-identical to a
  // modern one. ANY looser match is the Turdus musicus trap — Jardine's Song
  // Thrush carries the modern binomial of the Redwing — so a fuzzy join here
  // would file the wrong page under the right bird with total confidence.
  const exact = new Map<string, string>();
  for (const a of walk(corpus)) {
    const b = String(a.jardine_binomial ?? '').trim();
    const ps = (a.passages as Array<Record<string, unknown>> | undefined) ?? [];
    const shippable = ps.filter((p) => p.shippable === true && p.is_quotation === false);
    if (/^[A-Z][a-z]+ [a-z]+$/.test(b) && shippable.length > 0) exact.set(b, String(a.account_id));
  }
  assert.ok(exact.size > 50, `only ${exact.size} exact-binomial accounts — the join broke`);

  const lying = london
    .map((c) => c.sci_name)
    .filter((sci) => !have.has(sci) && exact.has(sci))
    .map((sci) => `${sci} (account ${exact.get(sci)})`);

  assert.deepEqual(
    lying,
    [],
    'these birds are in the catalog and have a verified account in the corpus, but no row in ' +
      'jardine.json — so the Roll calls them silent while the library has a page for them:\n  ' +
      lying.join('\n  '),
  );
});

test('S1 an unreadable ledger is UNKNOWN, never a measured zero', () => {
  // WHY — the largest correctness defect a sweep found, and the file DOCUMENTED
  // its own root cause three lines above the gate that suffers from it.
  //
  // fetchCatalog() collapsed a 404, a network error, a parse failure and a
  // genuinely empty file to the same []. Callers wrote `catalog !== null`
  // meaning "the ledger arrived" — a test that could never be false. So on the
  // night the nightly does not publish, the museum did not go quiet. It printed
  // measured zeroes: "0 of 0 species have a page", "never heard in this garden".
  // Confident, and wrong, about a garden it simply could not read.
  //
  // fetchCatalogOrNull() returns null for "could not read" and [] for "read, and
  // empty" — a real state on a station's first night. They must stay distinct.
  const cat = readFileSync(new URL('../src/catalog.ts', import.meta.url), 'utf8');
  assert.match(cat, /export async function fetchCatalogOrNull/,
    'the nullable catalog fetch is gone — every failure collapses to [] again');
  // a 200 with a non-array body is a failure wearing a success: Caddy's php
  // try_files answers 200 text/html for ANY missing path under /collage/
  assert.match(stripComments(cat).replace(/\s+/g, ' '), /if \(!Array\.isArray\(raw\)\) return null/,
    'a non-array body is treated as an empty catalog — that is try_files 200 mistaken for data');

  const view = stripComments(readFileSync(new URL('../src/views/LibraryView.tsx', import.meta.url), 'utf8'));
  assert.match(view, /fetchCatalogOrNull\(\)/,
    'the Library reads the collapsing fetch again, so its catalog !== null gates cannot be false');
  assert.ok(!/\bfetchCatalog\(\)/.test(view),
    'the Library still calls the collapsing fetchCatalog() somewhere');

  // and the derived claims must stay behind that gate
  const flat = view.replace(/\s+/g, ' ');
  for (const claim of ['lib-ledger', 'lib-desk-quiet']) {
    assert.match(flat, new RegExp(`catalog !== null[^)]{0,120}${claim}`),
      `the "${claim}" claim is no longer gated on the ledger being readable`);
  }

  // the selectors must agree: no catalog, no assertions about the garden
  const raw = corpusRaw();
  const j = normalize(raw);
  assert.deepEqual(silences(j, []), [], 'the Index of Silences invents rows without a catalog');
  for (const e of j.errata.filter((x) => x.closing_requires !== null)) {
    assert.equal(closingHolds(e, new Map()), false,
      `erratum ${e.no} asserts a live claim with no ledger to check it against`);
  }
});

test('S2 a tie means nobody is "the most-recorded bird"', () => {
  // WHY: Erratum III's closing — "The most-recorded bird in this garden is the
  // one the library declined to describe" — is a live claim the museum
  // re-checks every render precisely so it stops asserting things that stopped
  // being true. It kept the FIRST row it saw at the maximum, so on a tie the
  // answer depended on how species.json happened to be ordered. That is not a
  // property of the garden, and a museum should not decide a superlative by
  // whichever row the rebuilder wrote first.
  const raw = corpusRaw();
  const j = normalize(raw);
  const e = j.errata.find((x) => x.closing_requires === 'subject_is_top');
  assert.ok(e, 'no subject_is_top erratum — this guard is vacuous');
  const subj = e.subjects[0].sci_name;
  const row = (sci: string, n: number) =>
    ({ ...london[0], sci_name: sci, detection_count: n }) as CatalogSpecies;
  const map = (rows: CatalogSpecies[]) => new Map(rows.map((r) => [r.sci_name, r]));

  // clear winner, either order → holds
  assert.equal(closingHolds(e, map([row(subj, 900), row('Zzz zzz', 10)])), true);
  assert.equal(closingHolds(e, map([row('Zzz zzz', 10), row(subj, 900)])), true);
  // TIE → must not print, regardless of which row comes first
  assert.equal(closingHolds(e, map([row(subj, 500), row('Zzz zzz', 500)])), false,
    'a tie let the claim print — decided by row order, not by the garden');
  assert.equal(closingHolds(e, map([row('Zzz zzz', 500), row(subj, 500)])), false,
    'the same tie gave the OPPOSITE answer when the rows were reordered');
  // an all-zero catalog has no top bird at all
  assert.equal(closingHolds(e, map([row(subj, 0), row('Zzz zzz', 0)])), false);
});

test('T1 every drift class the Roll can print has a band heading', () => {
  // WHY: the Roll is ordered by how far a name travelled between 1838 and 2026,
  // not alphabetically, and until now nothing said so — the alphabet appeared to
  // restart four times, which reads as a broken sort. Each tier now prints a
  // heading, and the heading comes from a lookup keyed on the drift value.
  //
  // A lookup with a missing key does not throw here, it renders NOTHING: the
  // band would silently vanish and the sort would look broken again, for exactly
  // the birds whose names moved in a way nobody had catalogued yet. That is this
  // project's fail-open signature, so the coverage is asserted rather than
  // assumed — over the enum AND over the data, because either can grow first.
  const src = stripComments(
    readFileSync(new URL('../src/views/LibraryView.tsx', import.meta.url), 'utf8'),
  );
  const bandBlock = /const DRIFT_BAND: Record<string, string> = \{([^}]*)\}/.exec(src);
  assert.ok(bandBlock, 'DRIFT_BAND is gone — the Roll prints an unexplained sort again');
  const banded = new Set([...bandBlock[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]));

  const rankBlock = /const DRIFT_RANK: Record<string, number> = \{([^}]*)\}/.exec(src);
  assert.ok(rankBlock, 'DRIFT_RANK is gone — find the Roll sort and re-point this guard');
  const ranked = [...rankBlock[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
  assert.ok(ranked.length > 0, 'no drift classes in DRIFT_RANK — this guard would be vacuous');
  for (const d of ranked) {
    assert.ok(banded.has(d), `drift '${d}' is sorted into its own tier and prints no heading`);
  }

  const raw = corpusRaw();
  if (raw === null) return;
  const j = normalize(raw);
  const inData = new Set(j.species.map((s) => s.drift).filter((d): d is string => d !== null));
  assert.ok(inData.size > 1, 'fewer than two drift classes in the corpus — the banding is vacuous');
  for (const d of inData) {
    assert.ok(banded.has(d), `the corpus contains drift '${d}' and the Roll has no heading for it`);
  }
});
