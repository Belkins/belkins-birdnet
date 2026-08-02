// THE EBIRD LINK — one home for a contract that was wrong in two places.
//
// The old link was `https://media.ebird.org/catalog?q=<scientific name>`, built
// independently in AtlasView and BirdPopup from a duplicated constant. eBird has
// since removed the `q=` parameter: the host answers 301 with `Location:
// /catalog`, so the query never arrives, and every "ebird ↗" on the wall landed
// on the unfiltered global archive — 97.6M photos, no species selected.
//
// Measured 2026-08-02, logged out: `?q=Erithacus rubecula`, `?q=Psittacula
// krameri` and a deliberately bogus `?q=Zzzzus fakeus` all returned the SAME
// 845,086-byte body with the same generic <title>. That byte-identity is the
// only test that can tell a dead link from a live one on this host, because it
// answers 200 for a nonexistent taxon too — no status code will ever tell you.
//
// The surviving contract is keyed on eBird's TAXON CODE and never on a name:
// `?taxonCode=Turdus+merula` renders the generic page just as happily. Codes
// come from the nightly catalog (scripts/ebird.php, keyed on the exact label set
// BirdNET emits) and are NEVER derived here — `bluti` is not the Blue Tit's code
// (`blutit` is) and it fails silently to the generic page, while `rerpar1` is a
// perfectly real code for an entirely different bird.
//
// mediaType=audio because of how the visitor got here: the station HEARD this
// bird. Spectrograms and playable cuts continue that thread; a wall of
// photographs breaks it.

const EBIRD_MEDIA = 'https://media.ebird.org/catalog';

/** The shape of a real eBird taxon code, DERIVED FROM THE TABLE rather than
 *  assumed: all 6,419 non-null codes in scripts/ebird.php match this and none
 *  fall outside it. The obvious guess — six letters and an optional digit —
 *  would have silently dropped ten real ones (`y00678`, `mao1`, `tui1`).
 *
 *  It is deliberately a shape test and not a membership test: the frontend must
 *  not carry a 63 KB gzipped copy of the table to render a link. */
const CODE_RE = /^[a-z0-9]{4,10}$/;

/** ABSENCE THAT LEARNED TO SPELL ITSELF. The source table writes "this class has
 *  no eBird taxon" as the four-character STRING "null", and JavaScript will
 *  happily stringify a missing value into "undefined" on the way through a
 *  template. Every one of these matches CODE_RE, so a shape test alone would
 *  mint `?taxonCode=null` — a URL that returns 200 and shows the entire archive,
 *  indistinguishable from a working link. That is the original bug wearing a
 *  new parameter name.
 *
 *  This is the CLASS, not the one instance: verified against the table that none
 *  of these nine is a real eBird code, so refusing them costs no species. */
const NOT_CODES = new Set([
  'null',
  'undefined',
  'none',
  'nan',
  'nil',
  'true',
  'false',
  'void',
  'error',
]);

/** The catalogue's media page for one species, or null when we have no code and
 *  therefore no honest link to offer. Callers MUST render nothing on null — a
 *  dead "ebird ↗" is worse than an absent one, because the wall is a museum
 *  label and a label that points nowhere is a false claim. */
export function ebirdMediaUrl(code: string | null | undefined): string | null {
  if (typeof code !== 'string') return null;
  const c = code.trim().toLowerCase();
  if (NOT_CODES.has(c) || !CODE_RE.test(c)) return null;
  return `${EBIRD_MEDIA}?taxonCode=${encodeURIComponent(c)}&mediaType=audio`;
}
