// READ THE LIBRARY — print, as prose, what a visitor would actually read.
//
// WHY THIS EXISTS. Every surface on this tab has been reviewed by its tests and
// by nobody's eyes: browser tooling is unreliable in this environment, and until
// the catalog fix landed a dev server rendered the tab DEGRADED anyway. So the
// content — the sentences, the counts, the empty states, the order things
// appear in — has never once been read end to end.
//
// This is not a renderer and it does not pretend to be one. It calls the SHIPPED
// selectors in src/jardine.ts against a real catalog and prints what they
// return, so the DERIVED half of the page (which is where the errors live) can
// be read in a terminal. Typography, layout and colour remain unverified and
// still need a human at a screen.
//
//   node tools/read-library.ts                    # against the London fixture
//   node tools/read-library.ts <catalog.json>     # against a real species.json
//   node tools/read-library.ts --live             # against the Pi, if reachable
//
// It writes nothing and imports the real modules — no second copy of any rule.
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import type { LoadHookSync, ResolveHookSync } from 'node:module';

// The same two-line bundler shim tests/jardine.test.ts uses, for the same two
// reasons: Vite resolves extensionless specifiers and Node does not, and
// `import.meta.env` is a Vite define that config.ts dereferences on line one.
const resolve: ResolveHookSync = (spec, ctx, next) => {
  if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) {
    try {
      return next(`${spec}.ts`, ctx);
    } catch {
      /* not a .ts sibling */
    }
  }
  return next(spec, ctx);
};
const load: LoadHookSync = (url, ctx, next) => {
  const r = next(url, ctx);
  if (url.endsWith('/src/config.ts')) {
    return { ...r, source: String(r.source).replaceAll('import.meta.env', '({})'), format: 'module-typescript' };
  }
  return r;
};
registerHooks({ resolve, load });

const SRC = new URL('../src/', import.meta.url);
const J = (await import(new URL('jardine.ts', SRC).href)) as Record<string, any>;

const arg = process.argv[2];
const catalogPath =
  !arg || arg === '--live'
    ? new URL('../public/dev/species-london.json', import.meta.url)
    : new URL(arg, `file://${process.cwd()}/`);

let rawCatalog: unknown;
if (arg === '--live') {
  const res = await fetch('http://birdnet.local/collage/species.json').catch(() => null);
  if (!res || !res.ok) {
    console.error('the station is not reachable — falling back to the committed fixture');
    rawCatalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  } else rawCatalog = await res.json();
} else {
  rawCatalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
}

// catalog.ts does not export its normaliser (it is internal to fetchCatalog),
// so the rows are read as-is — exactly as tests/jardine.test.ts reads them.
const catalog = (Array.isArray(rawCatalog) ? rawCatalog : []) as any[];
const jardine = J.normalize(JSON.parse(readFileSync(new URL('../public/jardine.json', import.meta.url), 'utf8')));
const accounts = JSON.parse(readFileSync(new URL('../public/jardine-accounts.json', import.meta.url), 'utf8'));

const W = 88;
const rule = (c = '─') => c.repeat(W);
const wrap = (s: string, indent = '  ') => {
  const out: string[] = [];
  let line = '';
  for (const word of s.split(/\s+/)) {
    if ((line + ' ' + word).trim().length > W - indent.length) {
      out.push(indent + line.trim());
      line = word;
    } else line += ' ' + word;
  }
  if (line.trim()) out.push(indent + line.trim());
  return out.join('\n');
};
const head = (k: string, t: string) => {
  console.log('\n' + rule('━'));
  console.log(k.toUpperCase() + (t ? '   ' + t : ''));
  console.log(rule());
};

const bySci = J.speciesBySci(jardine) as Map<string, any>;
const byCat = new Map(catalog.map((c) => [c.sci_name, c]));
const total = catalog.reduce((n, c) => n + (c.detection_count || 0), 0);
const com = (sci: string) => byCat.get(sci)?.com_name || sci;

console.log(rule('═'));
console.log(`THE LIBRARY — as a reader would find it`);
console.log(`catalog: ${arg === '--live' ? 'LIVE STATION' : catalogPath.pathname.split('/').pop()}` +
  `  ·  ${catalog.length} species  ·  ${total.toLocaleString()} detections`);
console.log(rule('═'));

// ── 1 · masthead ledger ─────────────────────────────────────────────────────
head('1 · masthead', 'the one derived ledger sentence');
const volumes = jardine.volumes as any[];
const orn = volumes.filter((v: any) => v.division === 'birds').length;
const withPage = jardine.species.filter((s: any) => byCat.has(s.sci_name));
const withPlate = withPage.filter((s: any) => s.plate_ref !== null && !s.plate_is_vignette);
console.log(wrap(`${volumes.length} volumes · ${orn} ornithology · ${withPage.length} of the ` +
  `${catalog.length} species heard in this garden have a page · ${withPlate.length} have a plate`));
if (jardine.epigraph) {
  console.log('\n  EPIGRAPH:');
  console.log(wrap(jardine.epigraph.text, '    '));
  console.log(`    — ${jardine.epigraph.speaker}, vol. ${J.volumeRoman(jardine.epigraph.volume)}`);
}

// ── 2 · the reading desk ────────────────────────────────────────────────────
head('2 · the reading desk', 'what it opens on today');
for (const [label, args] of [
  ['no live birds, 24H window', { species: jardine.species, rows: [], catalog, windowHours: 24, now: new Date() }],
  ['aimed at the Blue Tit (a silence)', { species: jardine.species, rows: [], catalog, windowHours: 24, now: new Date(), aim: 'Cyanistes caeruleus' }],
] as const) {
  const pick = J.pickDeskSpecies(args as any);
  console.log(`\n  [${label}] → ${pick ? `${pick.species.jardine_title} (${pick.source})` : 'NOTHING — the desk is silent'}`);
  if (pick) {
    const cp = J.counterpointFor(pick.species);
    if (cp?.kind === 'voice') console.log(wrap('“' + J.firstSentence(cp.passage.text) + '”', '    '));
    else if (cp?.kind === 'silence') console.log(wrap('(silence) ' + cp.note, '    '));
  }
}

// ── 3 · the errata ──────────────────────────────────────────────────────────
head('3 · the errata', `${jardine.errata.length} slips`);
for (const e of jardine.errata as any[]) {
  console.log(`\n  No. ${e.no} — ${e.headline}   [${e.kind}]`);
  if (e.quote) console.log(wrap('“' + e.quote.text + '”  — ' + e.quote.speaker, '    '));
  for (const sub of e.subjects) {
    const c = byCat.get(sub.sci_name);
    const pct = c && total ? ((c.detection_count / total) * 100).toFixed(2) + '%' : '—';
    console.log(`    · ${com(sub.sci_name)}: ` +
      (c ? `${c.detection_count.toLocaleString()} recordings (${pct})` : 'NOT IN THIS CATALOG → “no recording — never heard in this garden.”'));
  }
  // through the SAME gate the page uses — a reader that prints a closing the
  // page would suppress is worse than no reader at all.
  if (e.closing && J.closingHolds(e, byCat)) console.log(wrap('› ' + e.closing, '    '));
  else if (e.closing) console.log(wrap('› [closing SUPPRESSED — its claim no longer holds]', '    '));
}

// ── 4 · the index of silences ───────────────────────────────────────────────
const sil = J.silences(jardine, catalog) as any[];
head('4 · the index of silences', `${sil.length} rows, loudest first`);
for (const r of sil) {
  console.log(`  ${String(r.count).padStart(6)}  ${com(r.species.sci_name).padEnd(26)} ${r.species.note}`);
}
console.log('\n  › The book has no word for these. The microphone does.');

// ── 5 · the shelf ───────────────────────────────────────────────────────────
const lit = new Set(withPage.map((s: any) => s.volume));
head('5 · the shelf', `${volumes.length} volumes, ${lit.size} lit`);
console.log(wrap(volumes.filter((v: any) => lit.has(v.n)).map((v: any) => `${J.volumeRoman(v.n)} ${v.title}`).join(' · ')));

// ── 6 · the roll ────────────────────────────────────────────────────────────
const roll = [...catalog].sort((a, b) => (b.detection_count || 0) - (a.detection_count || 0));
const silentRows = roll.filter((c) => !bySci.has(c.sci_name));
head('6 · the roll', `${roll.length} rows · ${roll.length - silentRows.length} have an account · ` +
  `${silentRows.length} ${silentRows.length === 1 ? 'does' : 'do'} not`);
for (const c of roll.slice(0, 8)) {
  const j = bySci.get(c.sci_name);
  const weak = j ? J.weakSource(j) : null;
  console.log(`  ${String(c.detection_count).padStart(6)}  ${(c.com_name || c.sci_name).padEnd(26)} ` +
    (j ? `${j.jardine_binomial}${weak ? ' †' : ''}` : 'the library is silent.'));
}
console.log(`  … ${Math.max(0, roll.length - 8)} more`);
if (silentRows.length) console.log(`\n  SILENT ROWS: ${silentRows.map((c) => c.com_name || c.sci_name).join(', ')}`);
console.log('  († = weakly sourced, wears a dotted verify marker)');
if (jardine.roll_closing) {
  console.log(`\n  ${(jardine.roll_closing.subject || '').toUpperCase()}`);
  console.log(wrap('“' + jardine.roll_closing.text + '”', '  '));
  console.log(`  — ${jardine.roll_closing.speaker}, vol. ${J.volumeRoman(jardine.roll_closing.volume)}`);
}

// ── 7 · the full account ────────────────────────────────────────────────────
const withGaps = Object.entries(accounts).filter(([, v]: any) => v.some((p: any) => p.elided_after > 0));
head('7 · the full account', `${Object.keys(accounts).length} accounts · ` +
  `${Object.values(accounts).reduce((n: number, v: any) => n + v.length, 0)} passages · ${withGaps.length} carry a withheld gap`);
const [sampleSci, sample] = withGaps[0] as [string, any[]];
console.log(`  sample — ${com(sampleSci)}: ${sample.length} passages, as printed`);
for (const p of sample) {
  console.log(wrap('…' + p.text.slice(-90), '    '));
  if (p.elided_after > 0) {
    console.log(`      [${p.elided_after} passage${p.elided_after === 1 ? '' : 's'} withheld here — ` +
      `quotation${p.elided_after === 1 ? '' : 's'} whose speaker this extraction could not prove]`);
  }
}

// ── 8 · the colophon ────────────────────────────────────────────────────────
head('8 · the colophon', 'the museum’s own honesty label');
const c = jardine.colophon;
console.log(wrap(`text extracted once on ${c.extracted_at} from ${c.volumes_fetched} volume pages · ` +
  `sha256 ${c.corpus_sha256.slice(0, 12)} · ${J.sealLine(c)} · every sentence here is served verbatim ` +
  `from that extraction · none is written, paraphrased or generated by a model`));
console.log(wrap(`Sir William Jardine, The Naturalist's Library, Edinburgh 1833–1843. ${c.credit} ${c.licence}`));

console.log('\n' + rule('═'));
console.log('TYPOGRAPHY, LAYOUT AND COLOUR ARE NOT CHECKED HERE. This reads the derived');
console.log('half only — the half where the errors live. The rest still needs eyes.');
console.log(rule('═'));
