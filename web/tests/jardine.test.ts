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
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import type { LoadHookSync, ResolveHookSync } from 'node:module';
import { parseCatalogDate } from '../src/almanac.ts';
import type { CatalogSpecies } from '../src/catalog.ts';
import type { Jardine, JardinePassage, JardineSpecies } from '../src/jardine.ts';

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

// ── THE READING DESK selector ────────────────────────────────────────────────
// The desk's two-tier pick is the tab's signature and the only job the shared
// 1H/12H/24H/7D filter has anywhere in the museum. It MUST live in a .ts, not
// inside LibraryView.tsx: `node --test` strips types but cannot parse JSX, so a
// selector inside the view is a selector nothing can ever test.
interface DeskArgs {
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
const IMAGE_MANIFEST = ['jardine/19-vignette.jpg', 'jardine/24-vignette.jpg', 'jardine/24-11.jpg'];

const london = JSON.parse(readFileSync(LONDON_PATH, 'utf8')) as CatalogSpecies[];

/** The corpus is written by the extraction lane and assembled last. When it is
 *  not in the tree the tab must degrade to silence — every corpus test asserts
 *  THAT instead, so this file is never vacuously green. */
function corpusRaw(): unknown | null {
  if (!existsSync(CORPUS_PATH)) return null;
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

test('E3 every errata engraving is one of the three committed files, and it is on disk', () => {
  // WHY: the Precedence vitrine hangs three plates at Jardine's own relative
  // sizes; the SMALLNESS of the two vignettes beside the Waxwing's full plate is
  // the entire argument. A fourth path, or a path whose file was never
  // committed, renders as a broken mount that reads as a broken feature — and
  // an <img> 404 is invisible to every other check in this repo.
  const raw = corpusRaw();
  if (raw === null) {
    assert.deepEqual(normalize(raw), EMPTY, 'no corpus in the tree — the tab must degrade to silence');
    return;
  }
  const j = normalize(raw);
  let hung = 0;
  for (const e of j.errata) {
    for (const s of e.subjects) {
      if (s.image === null) continue;
      hung++;
      assert.ok(
        IMAGE_MANIFEST.includes(s.image),
        `errata ${e.no}/${s.sci_name}: ${s.image} is not one of the three committed engravings`,
      );
      assert.ok(
        existsSync(new URL(`../public/${s.image}`, import.meta.url)),
        `errata ${e.no}/${s.sci_name}: ${s.image} is not in the tree`,
      );
      assert.ok(s.image_w !== null && s.image_h !== null, `${s.image}: no intrinsic size — the vitrine will jump`);
      assert.ok(s.scale > 0, `${s.image}: a non-positive scale erases Jardine's own proportion`);
    }
  }
  assert.ok(hung > 0, 'the vitrine hangs nothing — the errata carry no images at all');
  for (const f of IMAGE_MANIFEST) {
    assert.ok(existsSync(new URL(`../public/${f}`, import.meta.url)), `${f} was committed and is now gone`);
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
  assert.deepEqual(j.species[0].sic, [{ find: 'cælebes', note: 'scanner error for “cælebs”.' }]);
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

test('G4 every surface that prints a binomial ROUTES it through sicNodes()', () => {
  // WHY: G2 proves the data is markable; nothing else proves the page marks it.
  // Tidy the JSX to `{j.jardine_binomial}` and G2 stays green while every [sic]
  // silently disappears from the wall.
  //
  // THE GUARD ITSELF WAS THE BUG ONCE. It used to be a bare
  // `src.includes("sicNodes(j.X, j.sic)")` over one whitespace-collapsed file,
  // which is fail-open AND fragile at the same time: a commented-out call, a
  // dead `{false && …}` branch or an unmounted component all satisfied a
  // substring match, while a behaviour-preserving prettier reformat across two
  // lines broke it. So: comments are STRIPPED before matching (a mention in a
  // comment must not count as an invocation), whitespace is tolerant, and every
  // file that reads `.jardine_binomial` is checked rather than one hard-coded
  // path — a new surface printing the name unmarked fails here.
  for (const file of ['../src/views/LibraryView.tsx']) {
    const src = stripComments(readFileSync(new URL(file, import.meta.url), 'utf8'));
    for (const field of ['jardine_binomial', 'jardine_authority']) {
      assert.match(
        src,
        new RegExp(`sicNodes\\(\\s*j\\.${field}\\s*,\\s*j\\.sic\\s*,?\\s*\\)`),
        `${file} prints j.${field} without routing it through sicNodes() — its [sic] markers would vanish`,
      );
    }
  }
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

    // (b) a file that PRINTS a binomial must ASK about its provenance. Removing
    //     the marker outright leaves no hand-rolled comparison for (a) to catch,
    //     which is exactly how 11 of the 16 silence rows shipped unmarked.
    if (/\.jardine_binomial/.test(body)) {
      assert.match(
        body,
        /weakSource\s*\(/,
        `${file} renders a Jardine binomial but never calls weakSource() — ` +
          `a weakly-sourced name would print as though the extraction were certain`,
      );
    }

    // (c) PER RENDER SITE, derived from the source rather than hard-coded: for
    //     every `sicNodes(X.jardine_binomial, X.sic)` the same X must reach
    //     weakSource(X). Rename-proof, and a NEW section that prints a binomial
    //     bare fails here on the day it is written.
    for (const m of body.matchAll(/sicNodes\(\s*([A-Za-z_$][\w$]*)\.jardine_binomial/g)) {
      const v = m[1];
      assert.ok(
        new RegExp(`weakSource\\(\\s*${v}\\s*\\)`).test(body),
        `${file} prints ${v}.jardine_binomial but never calls weakSource(${v}) — ` +
          `that row would carry no verify marker while the Roll marks the same name`,
      );
    }
  }
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
