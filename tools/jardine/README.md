# tools/jardine — THE LIBRARY, Lane A (the extraction)

One-time, deterministic, hand-verifiable extraction of Sir William Jardine's
*The Naturalist's Library* (Edinburgh, 1833–1843) from Nicholas Rougeux's
restoration at [c82.net](https://www.c82.net/naturalists-library/), segmented
**per species**, with every passage carrying its **resolved speaker**.

> **RUN ONCE ON 2026-07-27. NEVER AT BUILD TIME. NEVER AT RUNTIME.**
> A future re-run is a **re-verification** job, not a refresh.

There is no LLM anywhere in this pipeline. Every string in the output is a
verbatim substring of the fetched HTML after a fixed, auditable sequence of
tag-stripping operations. Nothing is paraphrased, summarised, modernised or
spell-corrected. OCR artefacts are **detected and reported**, never repaired —
the owner keeps them with a visible `[sic]` marker, because they are the proof
that no model touched the text.

---

## Run it

```bash
# 15 polite requests (index + 14 ornithology volumes), 1.5 s apart, cached
python3 tools/jardine/extract.py --fetch --cache "$SCRATCH/jardine-cache"

# extract from the cache — no network at all
python3 tools/jardine/extract.py --cache "$SCRATCH/jardine-cache" \
                                 --out   "$SCRATCH/jardine-corpus"

# prove nothing drifted since the pinned run
python3 tools/jardine/extract.py --cache "$SCRATCH/jardine-cache" \
  --verify 9f1746f1f020658cffca019863a3d4fd9a54b1dcf7fcd253151f4f542c87d6cc
```

That command is executable and is expected to print
`VERIFIED 9f1746f1…` and exit 0. If you change the extractor, it exits 1 and
prints `DRIFTED <newsha>` — copy the new hash into **this file, the five
artefacts and `corpus.sha256` in the same commit**, then re-run
`r3work/verify_corpus_pin.py`, which fails if any of them disagree.

`--cache` also reads `$JARDINE_CACHE`. **The raw HTML is never committed** —
it is ~4.8 MB of someone else's bytes, and the pinned sha256 below is what
proves the extraction, not the cache. Python 3.11+, standard library only.

### Politeness

15 requests total, 1.5 s apart, one desktop UA, no crawling, everything cached
and worked from locally. `robots.txt` disallows exactly one thing this project
could want — the faceted `?tags=` URLs — and `fetch()` raises rather than build
one. Volume pages, the volume index, detail pages and memoirs are all allowed.

---

## Outputs

| file | what it is |
|---|---|
| `corpus.json` | every volume, account, passage, evidence trail and artefact |
| `corpus.txt` | the exact concatenated plain text the sha256 is taken over |
| `corpus.sha256` | that hash |
| `verify.tsv` | **one row per account — the human's acceptance test** |
| `passages.tsv` | one row per passage, with `attribution_lead` and `footnote_text` — the blockquote audit |
| `dropped.tsv` | every paragraph the genus guard removed, verbatim, with its reason |
| `depth-audit.tsv` | **P6's exception ledger** — every passage the two depth methods did not simply agree on, plus every passage at depth ≥ 2. Header-only is the correct state |
| `report.json` | counts, the unresolved list, the artefact census, what could not be segmented |

### The pinned hash

```
corpus_sha256 = 9f1746f1f020658cffca019863a3d4fd9a54b1dcf7fcd253151f4f542c87d6cc
corpus_chars  = 2,249,715
```

**Two earlier hashes are dead and must never be re-pinned.**
`fbc115b1…` (2,236,634 chars) is the pre-P6 corpus that carried 23 blockquote
misattributions. `e9a265d4…` (2,236,685 chars) fixed those but predates the
scaps-paragraph discriminator, so it is missing three real accounts. Both are
listed in `r3work/verify_corpus_pin.py`, which fails if either reappears.

Defined precisely so it can be reproduced by hand: every extracted passage's
verbatim text, in (volume ascending, account order, passage order), joined by a
single `\n`, no trailing newline, UTF-8. It is the hash of the **extracted
text**, not of any JSON file — the JSON carries a timestamp and would never be
stable.

**Determinism is measured, not assumed.** Two independent fetch sessions of all
14 volumes produced byte-*different* raw HTML (Cloudflare ray-ids, a randomised
poster carousel) and a byte-*identical* corpus. The transcription
non-determinism that motivated this whole design was the LLM channel; the
source is exactly reproducible. That measurement was taken on the
2,236,634-character corpus; the cache has not been re-fetched since, and the
two subsequent hash moves were both caused by **extractor changes, never by the
source** — which is exactly what a stable source and an honest hash look like.

---

## THE BLOCKQUOTE PROTOCOL

**335** passages in the 14 ornithology volumes sit inside `<blockquote>` markup
(326 at depth 1, 9 at depth 2 — a quote inside a quote).
They are **other naturalists** the volume author was quoting. Flattening them
puts a stranger's sentences in a named dead man's mouth on a wall that prints
citations. The `<blockquote>` element carries no `cite`, no `class` and no `id`:
**attribution is never in the markup and always in the prose.**

**P1 — Outside a blockquote** is the volume author's own prose.
`speaker` = the volume author from `p.hero-vol-byline`, `is_quotation = false`,
`speaker_source = "volume_byline"`, `speaker_confidence = "certain"`.

**P2 — Inside a blockquote** is someone else. `is_quotation = true`, and the
speaker is resolved from three independent channels:

| | evidence | strength |
|---|---|---|
| **E1** | a trailing `<p style="text-align: right"><span class="scaps">Alex. Wilson.</span></p>` inside the quote | certain |
| **E2** | a `<sup><a href="#fn:N">` inside the quote; the name is read from the head of footnote N | probable |
| **E3** | a naming clause in the last 240 chars of plain text before the quote ("Mr Hewitson relates", "Dr Richardson writes,—") | probable |
| **E4** | `tools/jardine/speakers.json`, written by the curator | certain |

**P3 — the resolution rule.** `speaker` is emitted **non-empty only when the
evidence is certain**: E4, or E1, or E2-and-E3 independently agreeing on the
same surname. A single probable signal is not certainty — it is emitted as
`speaker_candidate`, `speaker` stays `""`, and `shippable` is `false`.

**P4 — never guess.** A quotation with no evidence gets `speaker: ""`,
`speaker_confidence: "unresolved"`, `shippable: false`, and is listed in
`report.json → unresolved_quotations`. It is dropped, not attributed.

**P5 — the hard invariant.** No `is_quotation: true` passage may carry
`speaker == volume_author`, and no `shippable` passage may have a blank speaker.
Asserted at the end of every run; on violation the run **aborts and writes
nothing**. Negative-tested: forcing `"v24-048-p02": "William Jardine"` into
`speakers.json` exits 3 and produces zero output files.

**P6 — the invariant that can actually fire (exit code 4).** P5 asks *"does any
`is_quotation: true` passage name the volume author?"*, so it can never see a
passage whose `is_quotation` is **itself wrong** — and 23 of them were. P6 asks
a question that does not mention `is_quotation` until its last line: *what does
a completely separate reading of the raw cached bytes say this paragraph's
blockquote depth is?* — then demands the two answers agree.

`independent_depth_index()` reads the **raw cached page**, calls no parser
function, builds no stack and pairs no tags: it counts `<blockquote` and
`</blockquote` byte sequences starting before an offset and subtracts, and it
is keyed by the passage **text**, not by an offset the parser recorded. The
only thing it shares with the parser is `plain()`.

P6 runs **first** — before P5, before the authorship gate, before `--verify`
and before the first `open()`-for-write. On disagreement it prints every
offending passage with its byte offset, **writes nothing**, and returns **4**.
Every passage carries `bq_depth`, `independent_depth` and `depth_check` into
`corpus.json` and `passages.tsv`; the exceptions land in `depth-audit.tsv`.

Negative-tested four ways against the real cache, all with **zero files
written**: restoring the old non-greedy blockquote pairing globally (23 rows),
restoring it in one volume only (7 rows), forcing a **single** paragraph to
depth 0 (1 row), and the inverse — forcing a genuine depth-0 passage to depth 1
(1 row). It is sensitive at single-passage granularity in both directions.

**Declared limits of P6, because a guard oversold is a guard.** It asserts the
in/out binary `(independent_depth > 0) == is_quotation`. It does **not** assert
`bq_depth == independent_depth`, so a parser that mis-scored a depth-2 passage
as depth-1 would pass. An `unresolvable` passage — text unlocatable, or found
at two different depths — does not abort; it is forced `shippable: false` and
reported, and that path has never executed on real data (0 unresolvable across
all 2,806 passages), so it is unproven beyond code reading. And the two methods
scan different extents, which is only sound because `<blockquote` occurrences
before `<main>` measure **0** in all 14 volumes; that count is republished
per-volume in `report.json` so a re-fetch that moves the footnote list is
auditable. Divergence there fails loud (mass disagreement, exit 4), never
silent.

Downstream, `web/src/jardine.ts` `normalize()` drops any passage with a blank
speaker. Belt **and** braces: this file refuses to name a speaker it cannot
prove, and the loader refuses to render a passage that has no name.

### Where that leaves the 335 quotations

| | count |
|---|---|
| certain (shippable) | **3** — all E2+E3 concordant: Montague (v20), Yarrell (v24), Thompson (v34) |
| probable — candidate offered, **not shipped** | 150 |
| unresolved — no evidence, **dropped** | 182 |

This is the protocol working, not the protocol failing. The 150 probable rows
are the human afternoon: `passages.tsv` carries `speaker_candidate`, the
verbatim `attribution_lead` and the `footnote_text` on every one of them, so
confirming a name is a read, not a research task. Write the confirmed names
into `speakers.json` and re-run.

The canonical example, for calibration:

```
v24-048-p02  The Blue Titmouse, Volume XXIV
  lead-in : "…we have seen it occupy the end of a leaden water-pipe, which had
             fallen into disuse. Mr Hewitson relates his knowledge of one which"
  quote   : "continued building its nest for many days together, under the
             handle of a pump, although its labours were daily destroyed by its
             action."
  footnote 68 : "Oology, i."          (a work, not a name)
  → candidate "Hewitson", confidence probable, speaker "", shippable false
```

A human reads that in four seconds and writes `"v24-048-p02": "William
Hewitson"`. A machine that wrote it by itself would be guessing, and the one
time it guessed wrong it would be in 30px Cormorant under a real name.

---

## THE AUTHORSHIP GATE — and what it caught

Step 0 of the plan, run before anything is typeset: read the stated author of
every volume rather than assuming Jardine. `p.hero-vol-byline` carries it
machine-readably. Result — **all 14 non-null, and 5 of the 14 are not
Jardine**:

| vol | author | title |
|---:|---|---|
| 1, 3, 5, 6, 20, 24, 34, 36, 40 | **William Jardine** | |
| 9 | **John Selby** | Pigeons |
| 15 | **John Selby** | Parrots |
| 17 | **William Swainson** | Birds of Western Africa, Part I |
| **19** | **William Swainson** | **Birds of Western Africa, Part II** |
| 21 | **William Swainson** | Flycatchers |

**Volume XIX is Swainson, not Jardine.** That is the Rose-ringed Parakeet
volume — Erratum No. II, the "misfiled against it" slip, the
`render\it` "objectionable inmate of the drawing-room" line. Every draft in the
design round attributed it to Jardine. It is William Swainson's sentence, and
the corpus says so on every passage of that account. Correcting it is better
content than the error was: the bird that is a third of this garden was filed
by a *different man* in a *different man's* Africa volume.

Volume titles carry a **U+00AD soft hyphen** in two places — `Gallina\xadceous`
(vol 5) and `Nectarini\xadadæ` (vol 36). Preserved verbatim; invisible when
rendered, but it will break a naive string comparison.

---

## Segmentation

**Primary discriminator (as planned): `p.synonymy`, never heading level.**
Every `h2|h3|h4` inside `<main id="main">` up to `section#footnotes` starts a
chunk running to the next heading; the chunk is a species account iff it
contains a `p.synonymy`. Level is unusable: vol 24 uses `h4` in
Incessores/Dentirostres and `h3` in Scansores/Tenuirostres, vol 19 uses `h3`
throughout, and `h3` also names families (Lanaidæ, Merulinæ, Sylviadæ).

**Secondary discriminator (measured necessity, not in the plan).**
Volume 36 (Sun-Birds) hoists all 51 of its `p.synonymy` into two
`<dl class="synopsis">` tables, so the primary rule found **2** accounts in a
volume with 32 real species narratives. There the marker is the heading's own
`class="plate-title"` plus an opening `<em>` binomial line. Restricted to
`plate-title` headings so a family/genus heading can never qualify, and gated on
a binomial shape so plate-of-eggs headings cannot either. `account_source`
records which path found each account, in both the JSON and `verify.tsv`.

**Tertiary discriminator (measured necessity, added 2026-07-27).**
A third marker style exists that neither rule above can see: the binomial is a
`<span class="scaps">` at the head of an **ordinary narrative `<p>`** — no
`p.synonymy`, no leading `<em>`, no `plate-title` heading. Volume 40 opens the
Grey Lag-goose as `<h3>Grey Lag-goose</h3><p><span class="scaps">Anser
ferus.</span>&mdash;…`, and that account — 421 words, a real bird, one of the
London 40 — was simply **absent from the corpus**, which let an artefact state
that the library had no Grey-lag Goose section. It has one.

The pattern is anchored at the chunk head, so a `scaps` run in mid-narrative
(an author's surname) can never open a false account. It recovers **3** real
accounts — Grey Lag-goose (`v40-003`), Bean Goose (`v40-002`), Dalmation
Gold-Crest (`v24-046`) — and correctly refuses **6** genus headings written the
same way (Buteo, Pernis, Milvus, Strix, Curruca, Crakes), every one of them a
single word that `_RE_BINOM_SHAPE` rejects for wanting a second token.
`account_source` records it as `scaps_paragraph`.

Guarded by `f2work/verify_segmentation.py`, which asserts all 3 required and
all 6 forbidden segmentations **and** that widening the net renumbered nothing
— `account_id` is chunk-indexed, so every id the crosswalk, voices and errata
files already cite is stable.

> **`binomial_source` vs. `account_source`.** The data contract's
> **RECONCILED 2026-07-28.** `web/src/jardine.ts` now types `binomial_source` as
> `'em' | 'synonymy' | 'scaps' | 'scaps_paragraph'`, and `weakSource()` has a case
> for BOTH small-caps spellings. That matters because this file writes
> `scaps_paragraph` (line 974) while the committed `jardine.json` carries `scaps`:
> accepting only one means the next re-run emits a token `asEnum()` rejects, which
> nulls it and puts the corpus's most weakly-sourced binomial back to printing as
> though the extraction were certain. Do not re-narrow the enum.

**718 accounts** — 637 via `synonymy`, 78 via `plate_title_binomial`,
3 via `scaps_paragraph`.

| vol | 1 | 3 | 5 | 6 | 9 | 15 | 17 | 19 | 20 | 21 | 24 | 34 | 36 | 40 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| accounts | 34 | 56 | 26 | 28 | 31 | 34 | 58 | 73 | 29 | 25 | 112 | 83 | 32 | 97 |

### The genus bleed — the error that puts a wrong sentence under a right bird

Between `<h4>Chiff-Chaff Warbler</h4>` and `<h4>Common Gold-Crest</h4>` sit five
paragraphs of *Regulus* genus material with no `<hr>`, no `<section>` boundary
and no heading. Pattern-matching one paragraph is not enough — the bleed is a
**tail**. The rule:

* a paragraph under 60 chars → `short_fragment`
* `Genus, Authority.` opener, `Note.—`, `Generic Characters` → dropped
* at paragraph index ≥ 1, an explicit **transition** — *we may pass to the…*,
  *brings us to the…* — ends the species: that paragraph and **everything after
  it in the chunk** is cut as `genus_bleed_tail`
* a paragraph merely opening *"The genus Ortyx was formed by Stephens…"* is
  background about the account's **own** genus and is dropped alone, not as a
  tail

Both narrowings are measured, not stylistic. Cutting the tail on the second
pattern threw away six real paragraphs of Virginian Partridge prose in vol 6.
Accepting any `to <article>` object cut four real paragraphs of Senegal species
prose in vol 17, on the phrase *"naturally leads us to expect many slight
variations"* — so the transition's object must be taxonomic.

Result: the Chiffchaff account is **2 passages, both Chiffchaff.** Every dropped
paragraph is in `dropped.tsv`, verbatim, with its reason:

| reason | n |
|---|--:|
| short_fragment | 698 |
| genus_bleed_tail | 36 |
| genus_paragraph | 31 |
| editorial_note | 25 |
| generic_characters | 10 |
| genus_heading | 10 |
| short_quotation | 2 |

Machine guards are not the acceptance test. Step 6 of the plan stands: the human
confirms every shipped passage plainly concerns its own species.

---

## Cleaning — this exact order, and no further

1. `<ins>` content **in**, `<del>` content **out**. Reversing this republishes
   the error Rougeux corrected. (Some `<del>` have no matching `<ins>` — pure
   deletions; counts differ per volume and that is expected.)
2. `<sup>…</sup>` stripped **first**, before any other tag, or footnote digits
   glue onto words ("wheat stubbles.18"). `glued_footnote_digit` is a
   self-check detector for exactly this; it reports **0**.
3. MathJax `\(\frac{a}{b}\)` → `a/b` (472 in vol 19, 347 in vol 17, 189 in
   vol 21); other `\(…\)` delimiters stripped.
4. `<br>` → space, remaining tags stripped, `html.unescape`, whitespace runs
   collapsed.

**Curly quotes and æ/œ are kept** — they are the period voice, and they are why
this museum picked Cormorant. **Nothing is spell-corrected.**

---

## OCR artefacts — found, never fixed

Detectors carry a **precision tier**. `high` hits are near-certainly scanner
damage and are what the curator reads (`sic_high` in the TSVs). `low` hits are a
wide net kept for recall and tallied separately, so the verification TSV stays
readable in one sitting. Nothing is ever filtered out of the record.

**37 high-precision hits across 2.25 M chars.** Every artefact named in the
feasibility probes was found verbatim, plus several the probes missed:

| artefact | where | kind |
|---|---|---|
| `[unintelligble]` | v24 The Robin, or Redbreast | the transcriber's own misspelt placeholder |
| `render\it` | v19 Rose-Ringed Parrakeet | backslash in word |
| `gene rally` | v24 The Blackbird | space-split word |
| `thacked` | v24 The Blue Titmouse | space-split word |
| `upper tail Averts` | v24 The Common Goldfinch | *coverts* |
| `Its` in "while Its cheerful song" | v24 The Common Wren | capital I for l |
| `The’ nest` | v24 The Common Wren | floating apostrophe |
| `arid the` | v24 Missel-Thrush, v9 Blue and Green Turteline | *and* |
| `some what` | v40 The Solan Goose | space-split word |
| `the: ` `is: ` `and: ` `its: ` `with: ` | v6, v17, v19 | colon scanned for a comma |
| `..` `;;` | v6, v15, v17, v19 | doubled punctuation |
| 11 more capital-I-for-l | v5, v9, v15, v17, v19, v21, v24, v40 | mid-sentence |

Census: `interior_capital` 16, `stray_colon` 6, `space_split_word` 6,
`doubled_punct` 5, `floating_apostrophe` 2, `backslash_in_word` 1,
`unintelligible_marker` 1, `glued_footnote_digit` **0**.
Low-precision: `interior_capital_wide` 620 (mostly *India*, *Islands*,
*Illinois*), `plural_possessive_apostrophe` 12 (mostly correct — *wasps' nests*).

---

## What could NOT be extracted — report honestly

* **No page numbers exist.** Measured across all 14 volumes: zero `data-page`,
  zero `class="page*"`, zero `pagenum`. Every passage ships `page: null`, and
  every citation is volume + species heading. This is not a shortcut; the
  markup carries no page grain and none should be promised.
* **No per-species anchor exists.** c82 has one `id` across 141 headings, so a
  citation can only deep-link the volume page (`/volumes/24`), never the
  passage. `source_url` is the volume URL on every row, deliberately.
* **Volume 36's two synopsis tables are not segmented per species** — 37 + 14
  `p.synonymy` rows inside `<dl class="synopsis">`. Listed in
  `report.json → unsegmented_regions`. The 32 narrative accounts in that volume
  *are* extracted, via the secondary discriminator. Volume 36 is
  Nectariniadæ — African and Asian sunbirds — and contains none of this
  garden's species, so building a `<dt>/<dd>` parser for it would be
  maintenance with no reader.
* **332 of 335 quotations do not ship** until a human writes their speaker.
  By design. See P3/P4.
* **The 47→Jardine crosswalk is not in here.** Step 7 is 47 hand-written lines
  and stays that way: Jardine's Song Thrush is `Turdus musicus`, which is the
  *modern* binomial of the Redwing — a separate account two headings away in
  the same volume (`v24-013` and `v24-014` in this corpus, both present, both
  correct). Any programmatic binomial join files the wrong page under the right
  bird with total confidence.
* **This extractor writes no `web/public/jardine.json`.** It produces the raw
  corpus; the curator selects the voice passages from it by *ear quality* (32 as shipped), not
  by detection count. Measured, and the reason the selection cannot be
  automated: this garden's top three birds are this library's three worst
  subjects.

---

## Where the target species landed

| account | volume | Jardine's name | binomial | authority | plate |
|---|---:|---|---|---|---|
| `v24-014` | XXIV | Song Thrush | *Merula musica* | — | plate-3 |
| `v24-013` | XXIV | Redwing | *Merula Iliaca* | — | — |
| `v24-015` | XXIV | The Blackbird | *Merula vulgaris* | Ray | plate-3 |
| `v24-025` | XXIV | The Robin, or Redbreast | *Erythaca rubecula* | Swainson | **vignette** |
| `v24-030` | XXIV | The Nightingale | *Philomela luscinia* | — | plate-7 |
| `v24-032` | XXIV | Black-Cap | *Curruca atricapilla* | — | — |
| `v24-043` | XXIV | Chiff-Chaff Warbler | *Sylvia hippolais* | Selby | — |
| `v24-048` | XXIV | The Blue Titmouse | *Parus cæruleus* | Willughby | plate-9 |
| `v24-049` | XXIV | Greater Titmouse | *Parus major* | Will. | — |
| `v24-085` | XXIV | The Common Goldfinch | *Carduelis elegans* | Stephens | plate-16 |
| `v24-102` | XXIV | The Skylark | *Alauda arvensis* | Linn. | — |
| `v24-114` | XXIV | Green Woodpecker | *Brachylophus viridis* | Swainson | plate-21 |
| `v24-118` | XXIV | The Common Wren | *Troglodytes Europeus* | Cuvier | plate-23 |
| `v34-003` | XXXIV | Wood Pigeon or Ring Dove | *Columba palumbus* | Linnæus | plate-1 |
| `v19-063` | **XIX (Swainson)** | Rose-Ringed Parrakeet | *Palæornis torquatus* | Vigors | **vignette** |

The epigraph is `v24-114-p00`, `speaker: "William Jardine"`, `is_quotation:
false` — verbatim, and its authorship is now proven rather than assumed:

> The scream or cry of the Green Woodpecker, when heard for the first time, in a
> retired place or lonely wood, the bird being unseen, strikes the hearer as
> most remarkable and startling. The tone and expression is not to be explained
> by words, and can only be felt by hearing…

---

## Credit and licence

Sir William Jardine, *The Naturalist's Library*, Edinburgh 1833–1843. Restored
and transcribed by **Nicholas Rougeux, c82.net**. His CC0 1.0 grant covers the
restored **illustrations** only; the site footer reads "All rights reserved"
over the whole. The 1833–43 prose is public domain by age, and Rougeux's
OCR-cleaning labour is unlicensed — so credit him by name and link the source
page on every quoted passage regardless. `source_url` is on every row for
exactly that reason.
