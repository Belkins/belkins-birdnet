// THE EBIRD LINK — the wall's outbound catalogue link, as a unit test.
//
// The bug this suite exists to prevent shipping again: `?q=<binomial>` looked
// perfect in review and in the browser's address bar, and was dead. eBird
// removed the parameter; the host 301s to a bare /catalog. A real species and a
// deliberately bogus one returned byte-identical 845,086-byte bodies, both
// HTTP 200 — so nothing about the response could tell you, and nobody noticed
// until a human clicked a plate and got the whole world's birds.
//
// Every case below is keyed on the property that matters, not on the string:
// a link is offered ONLY when we hold a real taxon code, and the shape test
// that decides "real" was derived from the source table, never guessed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ebirdMediaUrl } from '../src/ebird.ts';

test('E1: a real code builds a species-filtered catalogue URL', () => {
  // Mutation that breaks this: restoring `?q=` — the parameter eBird dropped.
  const url = ebirdMediaUrl('eurrob1');
  assert.equal(url, 'https://media.ebird.org/catalog?taxonCode=eurrob1&mediaType=audio');
});

test('E2: the link lands on AUDIO — the visitor arrived through a recording', () => {
  // Mutation: dropping mediaType, which silently reverts the wall to photos.
  assert.match(String(ebirdMediaUrl('blutit')), /[?&]mediaType=audio\b/);
});

test('E3 (the original bug): a SCIENTIFIC NAME is not a code and yields no link', () => {
  // eBird accepts `?taxonCode=Turdus merula` with HTTP 200 and renders the
  // generic archive, so passing a name through would recreate the exact defect
  // while looking like it worked. Mutation: removing the shape test.
  assert.equal(ebirdMediaUrl('Turdus merula'), null);
  assert.equal(ebirdMediaUrl('Erithacus rubecula'), null);
});

test('E4 (the sentinel): absence that spelled itself is rejected, as a CLASS', () => {
  // THE TRAP. scripts/ebird.php spells "no eBird taxon for this class" as the
  // four-character STRING "null" — 103 of its 6,522 entries — and "null"
  // matches the code shape perfectly ([a-z0-9]{4,10}). So does "undefined",
  // which is what JavaScript writes when a missing value meets a template. A
  // shape test alone mints https://media.ebird.org/catalog?taxonCode=null and
  // sends the visitor to the generic archive: the original bug, new parameter.
  //
  // Adversarial review 2026-08-02 caught 'undefined' passing the first cut —
  // hence the whole class, verified against the table as costing no real code.
  // Mutation: deleting the NOT_CODES check, or narrowing it back to 'null'.
  for (const sentinel of ['null', 'undefined', 'none', 'nan', 'nil', 'true', 'false', 'void', 'error']) {
    assert.equal(ebirdMediaUrl(sentinel), null, `${sentinel} must not build a URL`);
    assert.equal(ebirdMediaUrl(sentinel.toUpperCase()), null, `${sentinel} upper-cased`);
    assert.equal(ebirdMediaUrl(` ${sentinel} `), null, `${sentinel} padded`);
  }
});

test('E5: absent, empty and non-string inputs yield no link, never a broken one', () => {
  // A build predating the field sends undefined; a class with no taxon sends
  // null; untrusted JSON can send anything. None may produce an href.
  assert.equal(ebirdMediaUrl(null), null);
  assert.equal(ebirdMediaUrl(undefined), null);
  assert.equal(ebirdMediaUrl(''), null);
  assert.equal(ebirdMediaUrl('   '), null);
  assert.equal(ebirdMediaUrl(42 as unknown as string), null);
  assert.equal(ebirdMediaUrl({} as unknown as string), null);
});

test('E6: the ten odd-shaped REAL codes a guessed pattern would have dropped', () => {
  // Derived from the table, not assumed. The obvious guess — six letters plus
  // an optional digit, /^[a-z]{4,8}\d{0,2}$/ — matches 6,409 of the 6,419 real
  // codes and silently drops exactly these ten. They are the whole reason the
  // shape test is [a-z0-9]{4,10}. Mutation: tightening the pattern back.
  const ODD_BUT_REAL = [
    'y00678', 'y00475', 'mao1', 'y00400', 'y00478',
    'y00839', 'y00989', 'tui1', 'y00599', 'y01036',
  ];
  assert.equal(ODD_BUT_REAL.length, 10);
  for (const code of ODD_BUT_REAL) {
    assert.equal(
      ebirdMediaUrl(code),
      `https://media.ebird.org/catalog?taxonCode=${code}&mediaType=audio`,
      `${code} is a real eBird code and must produce a link`,
    );
  }
});

test('E7: the boundary of the shape test holds on both sides', () => {
  // Real codes run 4–8 characters (measured across all 6,419). The window is
  // 4–10, so it is loose enough for the real set and still refuses the things
  // that are categorically not codes.
  assert.notEqual(ebirdMediaUrl('abcd'), null); // shortest real length
  assert.equal(ebirdMediaUrl('abc'), null); // too short to be a code
  assert.equal(ebirdMediaUrl('abcdefghijk'), null); // 11 — past any real code
  assert.equal(ebirdMediaUrl('eur bla'), null); // whitespace inside
  assert.equal(ebirdMediaUrl('eur/bla'), null); // path separator
  assert.equal(ebirdMediaUrl('eur&bla'), null); // query separator
});

test('E8: a code can never smuggle a second parameter into the URL', () => {
  // Defence in depth: the shape test already refuses these, so this asserts we
  // do not regress into interpolating an unvalidated code.
  for (const hostile of ['eurbla&mediaType=photo', 'eurbla#x', 'eurbla?y=1']) {
    assert.equal(ebirdMediaUrl(hostile), null, `${hostile} must not build a URL`);
  }
});
