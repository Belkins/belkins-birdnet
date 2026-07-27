#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
extract.py — THE LIBRARY, Lane A.

Deterministic, one-time extraction of Sir William Jardine's *The Naturalist's
Library* (Edinburgh, 1833-1843) from Nicholas Rougeux's restoration at c82.net,
segmented PER SPECIES, with every passage carrying its resolved SPEAKER.

    RUN ONCE ON 2026-07-27. NEVER AT BUILD TIME. NEVER AT RUNTIME.
    A future re-run is a RE-VERIFICATION job, not a refresh.

There is no LLM anywhere in this pipeline. Every string in the output is a
verbatim substring of the fetched HTML after a fixed, auditable sequence of
tag-stripping operations. Nothing is paraphrased, summarised, modernised or
spell-corrected. OCR artefacts are DETECTED AND REPORTED, never repaired.

--------------------------------------------------------------------------
THE BLOCKQUOTE PROTOCOL  (the highest-consequence rule in this file)
--------------------------------------------------------------------------
Roughly 371 passages across the 14 ornithology volumes sit inside
<blockquote> markup. They are OTHER NATURALISTS the volume author was
QUOTING. Flattening them puts a stranger's sentences in a named dead man's
mouth. The protocol is:

  P1. Every <p> outside a <blockquote> is the VOLUME AUTHOR's own prose.
      speaker      = the volume author, read from p.hero-vol-byline
      is_quotation = False
      speaker_source = "volume_byline", speaker_confidence = "certain"

  P2. Every <p> inside a <blockquote> is SOMEONE ELSE's. is_quotation = True,
      and the speaker is resolved from three kinds of source evidence, in
      this order, because the <blockquote> element itself carries no cite,
      no class and no id — attribution is never in the markup:

        E1 INLINE      a trailing  <p style="text-align: right"><span
                       class="scaps">Alex. Wilson.</span></p>  inside the
                       blockquote.                       -> certain
        E2 FOOTNOTE    a <sup><a href="#fn:N"> inside the quote; the name is
                       taken from the head of footnote N.  -> probable
        E3 LEAD-IN     a naming clause in the last 240 chars of plain text
                       immediately before the blockquote ("Mr Hewitson
                       relates", "Mr Eyton thus describes"). -> probable
        E4 HUMAN       tools/jardine/speakers.json, keyed by passage_id,
                       written by the curator during the human afternoon.
                                                          -> certain

  P3. RESOLUTION RULE. `speaker` is emitted NON-EMPTY only when the evidence
      is CERTAIN:
          E4 human override, OR
          E1 inline attribution, OR
          E2 and E3 independently agreeing on the same surname.
      A single probable signal is NOT certainty. It is emitted as
      `speaker_candidate` for the human, `speaker` stays "", and the passage
      is marked shippable=False.

  P4. NEVER GUESS. A quotation with no evidence at all gets speaker "",
      status "unresolved", shippable=False, and is listed in the report's
      unresolved bucket. It is dropped, not attributed.

  P5. HARD INVARIANT, asserted at the end of every run and non-bypassable:
      no passage with is_quotation=True may carry speaker == volume_author.
      If that ever fires the run aborts and writes nothing.

      P5 IS NOT ENOUGH, AND THE REASON MATTERS MORE THAN THE RULE.
      On 2026-07-27 three independent verifiers found 23 passages that sat
      inside a <blockquote> in the source and were nevertheless emitted with
      is_quotation=FALSE, speaker="William Jardine", speaker_source=
      "volume_byline", speaker_confidence="certain", shippable=TRUE. P5 was
      negative-tested, P5 passed, and P5 was STRUCTURALLY INCAPABLE of firing:
      its trigger is `is_quotation and speaker == volume_author`, and the
      misattributed rows carried is_quotation=False. A check whose predicate
      depends on the very flag that is wrong cannot detect that the flag is
      wrong. That is a check that reports success because it cannot fail.

  P6. HARD INVARIANT, THE ONE THAT CAN ACTUALLY CATCH IT. Blockquote depth is
      derived a SECOND time, by a method that shares no code with the parser:
      a raw byte-offset scan of the cached HTML that counts how many
      '<blockquote' and '</blockquote' sequences begin before each <p>, and
      calls the difference the depth (independent_depth_index()). For EVERY
      emitted passage, (independent_depth > 0) must equal is_quotation.
        - any disagreement                -> the run ABORTS and writes nothing
        - a passage the independent method cannot locate, or locates at two
          different depths, is UNRESOLVABLE: it is forced shippable=False and
          reported. It is never re-attributed, and its speaker is never
          rewritten to make the numbers agree.
      P6 does not consult is_quotation to decide whether to look. It looks at
      all 2,790 passages, every run.

Downstream, web/src/jardine.ts normalize() drops any passage with a blank
speaker, so an unresolved passage cannot reach the museum even by accident.
That is belt AND braces: this file refuses to name a speaker it cannot prove,
and the loader refuses to render a passage that has no name.

--------------------------------------------------------------------------
USAGE
--------------------------------------------------------------------------
    python3 tools/jardine/extract.py --fetch      # 15 polite requests, caches
    python3 tools/jardine/extract.py              # extract from the cache
    python3 tools/jardine/extract.py --verify <sha256>   # prove no drift

Outputs (all under --out, default: the scratchpad cache dir):
    corpus.json      every account, every passage, every artefact, all evidence
    corpus.txt       the exact concatenated plain text the sha256 is taken over
    corpus.sha256    that sha256
    verify.tsv       one row per account — the human's acceptance test
    passages.tsv     one row per passage — the blockquote audit
    depth-audit.tsv  every passage the two depth methods did not simply agree
                     on, plus every passage at nesting depth >= 2. Header-only
                     is the correct state.
    report.json      counts, unresolved list, artefact census, what failed

Exit codes: 0 ok · 1 sha drifted (--verify) · 2 no cache · 3 P5 violation ·
4 P6 blockquote-depth disagreement.
"""

from __future__ import annotations

import argparse
import bisect
import hashlib
import html as htmllib
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request

# ─────────────────────────────────────────────────────────────────────────────
# 0 · CONSTANTS
# ─────────────────────────────────────────────────────────────────────────────

BASE = "https://www.c82.net"
INDEX_URL = f"{BASE}/naturalists-library/"
VOLUME_URL = f"{BASE}/naturalists-library/volumes/%d"

# robots.txt Disallows exactly one thing this project could want: the faceted
# ?tags= URLs. Every tag is already embedded in the per-plate detail pages, so
# a compliant extractor never needs them. We never build such a URL.
FORBIDDEN_URL_MARK = "?tags="

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
POLITE_DELAY_S = 1.5

# The raw HTML cache is NEVER committed — it is ~4.8 MB of someone else's
# bytes and the pinned sha256 is what proves the extraction, not the cache.
# Set JARDINE_CACHE (or pass --cache) to a scratchpad path.
DEFAULT_CACHE = os.environ.get(
    "JARDINE_CACHE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")
)

# The 14 ornithology volumes. Derived from the index page's `li.vol-item birds`
# class token at run time; this list is the pinned expectation, not the source
# of truth — a mismatch is reported, never silently accepted.
EXPECTED_BIRD_VOLUMES = [1, 3, 5, 6, 9, 15, 17, 19, 20, 21, 24, 34, 36, 40]

# ─────────────────────────────────────────────────────────────────────────────
# 1 · FETCH  (polite, cached, never at build or runtime)
# ─────────────────────────────────────────────────────────────────────────────


def fetch(url: str, dest: str) -> str:
    if FORBIDDEN_URL_MARK in url:
        raise SystemExit(f"refusing a robots.txt-disallowed URL: {url}")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read().decode("utf-8", "strict")
    with open(dest, "w", encoding="utf-8") as fh:
        fh.write(body)
    return body


def do_fetch(cache: str) -> None:
    os.makedirs(cache, exist_ok=True)
    print(f"fetch: index -> {cache}/index.html")
    idx = fetch(INDEX_URL, os.path.join(cache, "index.html"))
    vols = [n for n, div, _t in parse_index(idx) if div == "birds"]
    if vols != EXPECTED_BIRD_VOLUMES:
        print(f"  ! bird volume set moved: {vols} != {EXPECTED_BIRD_VOLUMES}")
    for n in vols:
        time.sleep(POLITE_DELAY_S)
        dest = os.path.join(cache, f"vol-{n}.html")
        body = fetch(VOLUME_URL % n, dest)
        print(f"fetch: vol {n:>2} -> {dest} ({len(body)} chars)")


# ─────────────────────────────────────────────────────────────────────────────
# 2 · HTML PRIMITIVES
#     Attribute quoting on c82 is MIXED — class='fig-title' beside
#     class="synonymy" — so every attribute pattern must accept both.
# ─────────────────────────────────────────────────────────────────────────────

_ATTR = r"""["']"""


def attr(tag_html: str, name: str) -> str | None:
    m = re.search(rf"{name}\s*=\s*{_ATTR}(.*?){_ATTR}", tag_html)
    return m.group(1) if m else None


def has_class(tag_html: str, cls: str) -> bool:
    v = attr(tag_html, "class") or ""
    return cls in v.split()


def parse_index(page: str) -> list[tuple[int, str, str]]:
    """40 rows of (volume number, division, title) from li.vol-item."""
    out = []
    for m in re.finditer(r"<li[^>]*\sclass=['\"]vol-item ([a-z]+)['\"][^>]*>(.*?)</li>", page, re.S):
        div, body = m.group(1), m.group(2)
        num = re.search(r"/naturalists-library/volumes/(\d+)", body)
        tit = re.search(r"<span[^>]*class=['\"]vols-title['\"][^>]*>(.*?)</span>", body, re.S)
        if not num or not tit:
            continue
        out.append((int(num.group(1)), div, plain(tit.group(1))))
    return out


def main_region_span(page: str) -> tuple[int, int]:
    """Byte offsets of <main id="main"> .. section#footnotes IN THE RAW PAGE.

    The offsets, not just the slice, because the blockquote depth index and the
    independent verifier both need to speak in page-absolute coordinates.
    """
    i = page.find("<main")
    if i < 0:
        raise ValueError("no <main>")
    m = re.search(r"<section[^>]*id=['\"]footnotes['\"]", page[i:])
    j = i + (m.start() if m else len(page) - i)
    return i, j


def main_region(page: str) -> str:
    """<main id="main"> up to section#footnotes — the article body and nothing else."""
    i, j = main_region_span(page)
    return page[i:j]


def parse_footnotes(page: str) -> dict[int, str]:
    """section#footnotes ol > li, 1-indexed to match #fn:N."""
    m = re.search(r"<section[^>]*id=['\"]footnotes['\"][^>]*>(.*?)</section>", page, re.S)
    if not m:
        return {}
    ol = re.search(r"<ol[^>]*>(.*)</ol>", m.group(1), re.S)
    if not ol:
        return {}
    out, depth, start, idx = {}, 0, None, 0
    for t in re.finditer(r"</?li\b[^>]*>", ol.group(1)):
        if t.group(0).startswith("</"):
            depth -= 1
            if depth == 0 and start is not None:
                idx += 1
                out[idx] = plain(ol.group(1)[start : t.start()])
                start = None
        else:
            if depth == 0:
                start = t.end()
            depth += 1
    return out


# ─────────────────────────────────────────────────────────────────────────────
# 3 · CLEAN — the exact order, and no further.
#     (a) <ins> in, <del> out     (b) <sup> markers out FIRST
#     (c) MathJax fractions       (d) remaining tags
#     (e) unescape                (f) collapse whitespace
#     Curly quotes and æ/œ are KEPT: they are the period voice.
#     Nothing is spell-corrected. An automatic cleaner is the paraphrase
#     failure mode this brief forbids.
# ─────────────────────────────────────────────────────────────────────────────

_RE_DEL = re.compile(r"<del\b[^>]*>.*?</del>", re.S)
_RE_INS = re.compile(r"</?ins\b[^>]*>", re.S)
_RE_SUP = re.compile(r"<sup\b[^>]*>.*?</sup>", re.S)
_RE_FRAC = re.compile(r"\\\(\\frac\{(\d+)\}\{(\d+)\}\\\)")
_RE_MATH = re.compile(r"\\\((.*?)\\\)", re.S)
_RE_BR = re.compile(r"<br\s*/?>", re.I)
_RE_TAG = re.compile(r"<[^>]+>", re.S)
_RE_WS = re.compile(r"[\s ]+")


def plain(fragment: str) -> str:
    """HTML fragment -> verbatim plain text. Deterministic and lossless of prose."""
    s = _RE_DEL.sub("", fragment)  # (a) drop the error Rougeux corrected
    s = _RE_INS.sub("", s)  #             keep his correction
    s = _RE_SUP.sub("", s)  # (b) BEFORE any other stripping, or digits glue on
    s = _RE_FRAC.sub(lambda m: f"{m.group(1)}/{m.group(2)}", s)  # (c)
    s = _RE_MATH.sub(lambda m: m.group(1), s)
    s = _RE_BR.sub(" ", s)
    s = _RE_TAG.sub("", s)  # (d)
    s = htmllib.unescape(s)  # (e)
    s = _RE_WS.sub(" ", s)  # (f)
    return s.strip()


# ─────────────────────────────────────────────────────────────────────────────
# 4 · SEGMENT — on p.synonymy, never on heading level.
#     vol 24 uses h4 in Incessores/Dentirostres and h3 in Scansores/
#     Tenuirostres; vol 19 uses h3 throughout; and h3 also names FAMILIES
#     (Lanaidæ, Merulinæ, Sylviadæ). The reliable discriminator is a
#     p.synonymy inside the chunk.
# ─────────────────────────────────────────────────────────────────────────────

_RE_HEAD = re.compile(r"<h([234])([^>]*)>(.*?)</h\1>", re.S)
_RE_FIGURE = re.compile(r"<figure\b.*?</figure>", re.S)
_RE_TABLE = re.compile(r"<table\b.*?</table>", re.S)


_RE_SYNOPSIS_DL = re.compile(r"<dl[^>]*class=['\"]synopsis['\"]", re.S)
# The binomial line that opens a species account when the volume centralises its
# synonymy elsewhere: <p><em>Nectarinia chalybeia.</em>&mdash;<span
# class="scaps">Linnæus</span>.</p>
_RE_BINOM_LINE = re.compile(r"<p\b[^>]*>\s*<em>([^<]{4,80})</em>", re.S)
# A binomial opens with a capitalised genus and carries at least one more token
# ("Perdix cinerea.—var. Montana." is a real account and must survive). The
# single-word forms are what the secondary path must reject — volume 20's
# <h4 data-plate="plate-11">Eggs of Golden Eagle and Osprey</h4> opens with
# <em>Note.</em>, and the plate-of-eggs headings are not species.
_RE_BINOM_SHAPE = re.compile(r"^[A-Z][a-zæœ\-]{2,}[.,]?\s+\S")
# The scaps-headed narrative paragraph: <p><span class="scaps">Anser ferus.</span>
# &mdash;… and the authority-carrying variant <span class="scaps">Anser segetum
# </span>, <em>Pennant.</em>&mdash;… . Anchored at the chunk head so a scaps run
# in mid-narrative (an author's surname) can never open a false account.
_RE_SCAPS_BINOM_P = re.compile(
    r"^\s*<p\b(?![^>]*class=['\"](?:synonymy|chars))[^>]*>\s*"
    r"<span[^>]*class=['\"]scaps['\"][^>]*>([^<]{4,80})</span>"
    r"(?:\s*,?\s*<em>[^<]{1,40}</em>)?\s*[.,]?\s*(?:&mdash;|\u2014)",
    re.S,
)
NOT_A_TAXON = {"Note", "Notes", "Types", "Type", "Plate", "Fig", "Vide", "See",
               "Genus", "Sub", "Eggs", "Head", "Nest"}


def segment(region: str) -> list[dict]:
    heads = list(_RE_HEAD.finditer(region))
    chunks = []
    for i, h in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else len(region)
        body = region[h.end() : end]
        attrs = h.group(2)
        has_syn = bool(re.search(r"<p[^>]*class=['\"]synonymy['\"]", body))
        is_synopsis = bool(_RE_SYNOPSIS_DL.search(body))
        # PRIMARY discriminator (steps 2/3 of the plan): a chunk is a species
        # account iff it contains p.synonymy. Never filter by heading level —
        # vol 24 uses h4 in Incessores and h3 in Scansores, vol 19 uses h3
        # throughout, and h3 also names families (Lanaidæ, Merulinæ, Sylviadæ).
        #
        # SECONDARY discriminator, measured necessity: volume 36 (Sun-Birds)
        # hoists every p.synonymy into one <dl class="synopsis"> table, so all
        # 51 of them land in ONE chunk and its 32 real species narratives carry
        # none. There the account marker is the heading's own class="plate-title"
        # plus an opening <em> binomial line. Restricted to plate-title headings
        # so family/genus headings can never qualify; `account_source` records
        # which path found each account.
        src = None
        if has_syn and not is_synopsis:
            src = "synonymy"
        elif not has_syn and not is_synopsis and "plate-title" in (
            attr("<h" + h.group(1) + attrs + ">", "class") or ""
        ):
            bl = _RE_BINOM_LINE.search(body)
            cand = plain(bl.group(1)).strip(" .,") if bl else ""
            if cand and _RE_BINOM_SHAPE.match(cand) and cand.split()[0].strip(".,") not in NOT_A_TAXON:
                src = "plate_title_binomial"
        # TERTIARY discriminator, measured necessity (F2-greylag, 2026-07-27).
        # A THIRD marker style exists that neither path above sees: the binomial
        # is a <span class="scaps"> at the head of an ORDINARY NARRATIVE <p> —
        # no p.synonymy, no leading <em>, no plate-title heading. vol 40's
        # <h3>Grey Lag-goose</h3><p><span class="scaps">Anser ferus.</span>&mdash;…
        # is the case that made a voices row state "the Naturalist's Library has
        # no Grey-lag Goose section", which is false. Measured across the 15
        # cached volumes: 3 real accounts recovered (v40 Grey Lag-goose, v40 Bean
        # Goose, v24 Dalmation Gold-Crest) and 6 GENUS headings correctly refused
        # (Buteo, Pernis, Milvus, Strix, Curruca, Crakes) — every one of them a
        # single word, which _RE_BINOM_SHAPE rejects for wanting a second token.
        elif not has_syn and not is_synopsis:
            sp = _RE_SCAPS_BINOM_P.match(body)
            cand = plain(sp.group(1)).strip(" .,") if sp else ""
            if cand and _RE_BINOM_SHAPE.match(cand) and cand.split()[0].strip(".,") not in NOT_A_TAXON:
                src = "scaps_paragraph"
        chunks.append(
            {
                "level": int(h.group(1)),
                "attrs": attrs,
                "title": plain(h.group(3)),
                "body": body,
                # REGION-ABSOLUTE offsets of `body`. Blockquote depth is a
                # property of a position in the WHOLE document, so a chunk that
                # does not know where it sits cannot ask what its depth is.
                "body_start": h.end(),
                "body_end": end,
                "is_account": src is not None,
                "account_source": src,
                # A synopsis table is a per-VOLUME index, not a per-species
                # account. It is excluded and reported, never emitted as one
                # fat pseudo-account.
                "is_synopsis_table": is_synopsis,
                "synonymy_count": len(re.findall(r"<p[^>]*class=['\"]synonymy['\"]", body)),
            }
        )
    return chunks


# ─────────────────────────────────────────────────────────────────────────────
# 5 · GUARD THE GENUS BLEED — a verified false positive, never skipped.
#     Between <h4>Chiff-Chaff Warbler</h4> and <h4>Common Gold-Crest</h4> sit
#     five paragraphs of Regulus GENUS material with no separator, no <hr> and
#     no heading. A naive splitter hands the Chiffchaff a paragraph about
#     goldcrests. This is the class of error that puts a wrong sentence under a
#     right bird ON A WALL, so machine-dropped paragraphs are RECORDED, and
#     everything that survives is still confirmed by the human in step 6.
# ─────────────────────────────────────────────────────────────────────────────

_GENUS_HEAD = re.compile(
    r"^[A-Z][a-zæœ]+(us|a|ia|ella|inae|idae|æ),\s+"
    r"(Linn|Ray|Cuv|Swainson|Will|Willughby|Selby|Steph|Temm|Vig|Vigors|Briss|Lath|Bonap)\.",
)
_NOTE_HEAD = re.compile(r"^Note\s*\.?—")
_GEN_CHAR_HEAD = re.compile(r"^(Generic Characters?|Sub-?genus|Genus)\b", re.I)

# THE TRANSITION CUT. The measured false positive is not a paragraph that looks
# generic — it is a paragraph that ANNOUNCES THE NEXT TAXON and then keeps
# going. Between <h4>Chiff-Chaff Warbler</h4> and <h4>Common Gold-Crest</h4>
# sit "From those Tree Warblers, we may pass to the beautiful and active
# Gold-crests" followed by 2,215 chars about the genus Regulus, with no <hr>,
# no <section> boundary and no heading. Pattern-matching that ONE paragraph is
# not enough; everything after it in the chunk belongs to the next taxon too.
#
# Rule: at paragraph index >= 1, the first transition sentence ends the
# species. That paragraph and every paragraph after it are cut as
# `genus_bleed_tail` and written to dropped.tsv, verbatim, so the human sees
# exactly what was removed. Index 0 is exempt: a transition in the OPENING
# paragraph introduces the species you are already reading.
# The object of the transition must be a NOUN PHRASE ("to the Quails", "to the
# beautiful and active Gold-crests"), never an infinitive. Measured: without the
# article requirement, "naturally leads us to expect many slight variations"
# in volume 17 cut four real paragraphs of Senegal species prose.
_TRANSITION = re.compile(
    r"(?i:\b(?:we\s+(?:may|shall|now|will|here)\s+(?:now\s+)?(?:pass|proceed|turn|come)"
    r"|we\s+(?:now\s+)?pass|(?:brings?|leads?|conducts?)\s+us)"
    r"(?:\s+(?:at once|on|now))*\s+to\s+(?:the|those|these|a|an|our|another)\b)"
    # …and the object must be TAXONOMIC. Measured: "We may now proceed to a
    # short description of the plumage" is the same bird still being described,
    # and cutting there threw away volume 19's plumage paragraphs.
    r"(?=.{0,60}?\b(?:genus|genera|group|sub-?genus|sub-?famil|famil|division|"
    r"section|form|tribe|order|species|[A-Z][a-zæœ][a-zæœ-]{2,}))",
    re.S,
)
_NEXT_TAXON_OPENER = re.compile(
    r"^(?:This|The|Our|In this|Of this)\s+(?:little\s+|small\s+|beautiful\s+|next\s+)?"
    r"(?:genus|group|sub-?genus|subgenus|family|section|form|division)\b",
    re.I,
)
MIN_PARA_CHARS = 60


def bleed_reason(text: str, index: int) -> str | None:
    if len(text) < MIN_PARA_CHARS:
        return "short_fragment"
    if _GENUS_HEAD.match(text):
        return "generic_characters"
    if _NOTE_HEAD.match(text):
        return "editorial_note"
    if _GEN_CHAR_HEAD.match(text):
        return "genus_heading"
    # Only an explicit TRANSITION ends the species. A paragraph that merely
    # opens "The genus Ortyx was formed by Stephens…" is background about the
    # account's OWN genus — measured on volume 6, where a tail-cut there threw
    # away six real paragraphs of Virginian Partridge prose. It is dropped on
    # its own, and the tail keeps flowing.
    if index >= 1 and _TRANSITION.search(text[:220]):
        return "genus_bleed_tail"
    if index >= 1 and _NEXT_TAXON_OPENER.match(text):
        return "genus_paragraph"
    return None


# ─────────────────────────────────────────────────────────────────────────────
# 6 · OCR ARTEFACT DETECTORS
#     The owner keeps these VERBATIM with a visible [sic] marker. This code
#     therefore FINDS them and never touches them. Every hit is emitted with
#     its exact matched substring so the curator can eyeball it in the TSV.
# ─────────────────────────────────────────────────────────────────────────────

# Each detector carries a PRECISION tier. `high` hits are near-certainly scanner
# damage and are what the curator reads. `low` hits are a wide net whose recall
# matters more than its precision (a real error hides among proper nouns); they
# are counted and kept, but tallied in their own column so the verification TSV
# stays readable in one sitting. Nothing is ever filtered out of the record.
ARTEFACT_DETECTORS: list[tuple[str, re.Pattern, str, str]] = [
    ("unintelligible_marker", re.compile(r"\[unintellig[a-z]*le\]"), "high",
     "the transcriber's own placeholder, itself misspelled in the source"),
    ("backslash_in_word", re.compile(r"[A-Za-z]\\[A-Za-z]"), "high",
     r"a stray backslash inside a word (e.g. render\it)"),
    ("space_split_word", re.compile(
        r"\b(gene rally|upper tail Averts|thacked|arid the|to wards|some what|"
        r"there fore|him self|them selves|be fore|with out)\b"), "high",
     "a word broken by a space, or a letter substituted, by the scanner"),
    ("stray_colon", re.compile(
        r"\b(the|a|an|of|with|and|is|in|on|by|its|this|that|our|his|her):\s"), "high",
     "a colon scanned in place of a comma or nothing"),
    # "while Its cheerful song" — a capital I standing in for a lower-case l/i.
    # Narrowed to function words so 'West India Islands' and 'Illinois' do not
    # drown the real hits; the wide version is `interior_capital_wide` below.
    ("interior_capital", re.compile(r"(?<=[a-z]\s)(Its|It|In|Is|If|Ile|Ike)\b"), "high",
     "a capital I scanned for a lower-case l or i, mid-sentence"),
    ("floating_apostrophe", re.compile(r"(?<![Ss])[A-Za-rt-z][’']\s[a-z]"), "high",
     "an apostrophe scanned into the wrong slot (e.g. The’ nest)"),
    ("doubled_punct", re.compile(r"[,;]{2,}|\.\s*\.(?!\s*\.)"), "high",
     "doubled punctuation from the scan"),
    ("glued_footnote_digit", re.compile(r"[a-z]\.\d{1,3}(?=\s|$)"), "high",
     "SELF-CHECK: a footnote marker glued to a word — must be zero if <sup> "
     "was stripped before the other tags"),
    ("plural_possessive_apostrophe", re.compile(r"[Ss][’']\s[a-z]"), "low",
     "an apostrophe after a plural — usually correct (wasps’ nests), "
     "occasionally the same scan error (extends’ down)"),
    ("interior_capital_wide", re.compile(r"(?<=[a-z]\s)I[a-z]{1,}"), "low",
     "any mid-sentence capital I — mostly proper nouns (India, Islands, "
     "Illinois); kept for recall, read only when hunting"),
    ("midword_capital", re.compile(r"\b[a-z]{2,}[A-Z][a-z]{2,}\b"), "low",
     "a capital inside a lower-case word"),
]

HIGH_KINDS = {k for k, _rx, prec, _n in ARTEFACT_DETECTORS if prec == "high"}


def find_artefacts(text: str) -> list[dict]:
    out = []
    for name, rx, prec, note in ARTEFACT_DETECTORS:
        for m in rx.finditer(text):
            lo, hi = max(0, m.start() - 34), min(len(text), m.end() + 34)
            out.append(
                {
                    "kind": name,
                    "precision": prec,
                    "find": m.group(0),
                    "note": note,
                    "context": text[lo:hi],
                    "offset": m.start(),
                }
            )
    return out


# ─────────────────────────────────────────────────────────────────────────────
# 7 · THE BLOCKQUOTE PROTOCOL — implementation of P1..P5 above.
# ─────────────────────────────────────────────────────────────────────────────

SPEECH_VERB = (
    r"(?:says?|said|relates?|observes?|remarks?|writes?|states?|describes?|adds?|"
    r"continues?|mentions?|informs? us|tells? us|notices?|records?|reports?|"
    r"thus describes|thus writes|has the following|gives the following|"
    r"in his words|expresses? (?:it|himself))"
)
TITLE = r"(?:Mr|Mrs|Dr|Sir|Rev\.?|Revd\.?|Captain|Capt\.?|Colonel|Col\.?|Major|Professor|Prof\.?|Lord|Monsieur|M\.)"
NAME = r"[A-Z][A-Za-z’'æœ-]+(?:\s+(?:de|von|van|le|la|du)\s+[A-Z][A-Za-z’'-]+)?"

# E3 — a naming clause in the lead-in. Two strengths: an explicit speech verb
# after the name (strong), or a title+name with no verb (weak, and weak is not
# certainty).
_RE_LEAD_STRONG = re.compile(rf"(?:{TITLE}\s+)?({NAME})(?:,)?\s+(?:thus\s+)?{SPEECH_VERB}\b")
_RE_LEAD_TITLED = re.compile(rf"{TITLE}\s+({NAME})")

# E2 — the head of a footnote is a bibliographic citation whose first token is
# the authority: "Selby, Br. Ornith. i. p. 149." / "Hewitson, Ool. …"
_RE_FN_NAME = re.compile(rf"^(?:See\s+)?(?:{TITLE}\s+)?({NAME})\s*,")

LEAD_WINDOW = 240

# Surnames that are never a speaker: works, places, taxa that survive the
# name regex. Kept explicit and short rather than clever.
NOT_A_SPEAKER = {
    "The", "This", "That", "These", "Those", "There", "It", "He", "She", "We",
    "They", "His", "Her", "Its", "Their", "Our", "One", "Some", "Many", "Such",
    "But", "And", "When", "While", "Although", "Though", "If", "In", "On",
    "At", "By", "For", "From", "With", "Of", "To", "As", "So", "Thus",
    "British", "English", "American", "Scotch", "Irish", "French", "German",
    "Note", "See", "Vide", "Ibid", "Edit", "Vol", "Plate", "Fig", "Genus",
    "Species", "Order", "Family", "Sub", "Part", "Nat", "Hist", "Zool",
    "Ornith", "Ool", "Mag", "Trans", "Proc", "Journ", "Ann", "Birds", "Bird",
}


def surname(name: str) -> str:
    """Last capitalised token — 'Mr William Hewitson' and 'Hewitson' agree."""
    toks = [t for t in re.split(r"\s+", name.strip()) if t]
    return toks[-1] if toks else ""


def _clean_name(raw: str | None) -> str | None:
    if not raw:
        return None
    n = raw.strip().strip(".,;:")
    if not n or n in NOT_A_SPEAKER or surname(n) in NOT_A_SPEAKER:
        return None
    return n


def resolve_speaker(ev: dict, volume_author: str) -> dict:
    """
    P3/P4. Turn the three evidence channels into a decision. Emits:
      speaker            non-empty ONLY when certain
      speaker_candidate  the best guess when merely probable
      speaker_source     which channel decided
      speaker_confidence certain | probable | unresolved
      shippable          may this passage be typeset at all
    """
    inline = _clean_name(ev.get("inline"))
    fn = _clean_name(ev.get("footnote_name"))
    lead = _clean_name(ev.get("lead_name"))
    lead_strong = bool(ev.get("lead_strong"))

    if ev.get("human"):
        return dict(speaker=ev["human"], speaker_candidate=None, speaker_source="human_override",
                    speaker_confidence="certain", shippable=True)

    if inline:
        return dict(speaker=inline, speaker_candidate=None, speaker_source="inline_attribution",
                    speaker_confidence="certain", shippable=True)

    if fn and lead and surname(fn).lower() == surname(lead).lower() and lead_strong:
        return dict(speaker=lead, speaker_candidate=None, speaker_source="footnote+lead_in",
                    speaker_confidence="certain", shippable=True)

    cand = lead if (lead and lead_strong) else (fn or lead)
    if cand:
        return dict(speaker="", speaker_candidate=cand,
                    speaker_source=("lead_in" if cand is lead else "footnote"),
                    speaker_confidence="probable", shippable=False)

    return dict(speaker="", speaker_candidate=None, speaker_source=None,
                speaker_confidence="unresolved", shippable=False)


# Walk a chunk body as an ordered stream of <p> nodes, each tagged with whether
# it sat inside a <blockquote>, and carrying the evidence attached to its
# blockquote. Figures and tables are blanked first: p.fig-title and
# p.fig-legend are real <p> elements and would otherwise enter the prose.
_RE_P = re.compile(r"<p\b([^>]*)>(.*?)</p>", re.S)
_RE_FNREF = re.compile(r"href=['\"]#fn:(\d+)['\"]")
_RE_BQ_TAG = re.compile(r"</?blockquote\b[^>]*>", re.S)

# How far back to look for a lead-in when the blockquote OPENED BEFORE this
# account's heading (a quote that spans a heading). Measured: zero such spans
# exist in the 14 cached volumes today, but the old code silently mis-scored
# that shape too, so the new code answers it rather than assuming it away.
LEAD_CONTEXT = 3000


def blank_markup(doc: str, rx: re.Pattern) -> str:
    """Replace every match with spaces of IDENTICAL LENGTH.

    THIS IS THE POINT: `_RE_FIGURE.sub(" ", body)` shifts every offset after
    the first figure, which makes byte offsets — the only thing a depth counter
    can be built on — meaningless. Blanking in place keeps every offset in the
    document true while still removing p.fig-title / p.fig-legend from the
    prose stream. plain() collapses runs of whitespace, so the extracted text
    is byte-identical to the old single-space substitution.
    """
    return rx.sub(lambda m: " " * len(m.group(0)), doc)


class DepthIndex:
    """AUTHORITATIVE running <blockquote> depth over a whole document.

    THE BUG THIS REPLACES. The previous implementation paired blockquotes with
    one non-greedy regex, `<blockquote\\b[^>]*>(.*?)</blockquote>`. On a NESTED
    blockquote the non-greedy close binds to the INNER `</blockquote>`, so the
    outer quote is truncated and every paragraph from the inner close to the
    outer close scores as depth 0 — i.e. as the volume author's own prose,
    speaker "William Jardine", confidence "certain", shippable TRUE.

    Measured on the cached HTML: 13 nested blockquotes across volumes 5, 6, 9
    and 20; the clearest is vol-6.html, where the outer quote opens at byte
    81933 and closes at 91094 (9,161 chars) around three inner quotes, and
    seven Wood Grouse passages are handed to Jardine that belong to Lloyd's
    *Northern Field Sports*.

    A running counter cannot have that bug. Depth is a property of a POSITION,
    computed once by walking every blockquote tag in document order; it is
    never inferred from a regex pairing, never recomputed per element, and
    never restarted at a chunk boundary. Unbalanced markup is recorded in
    `anomalies`, never silently absorbed.
    """

    def __init__(self, doc: str) -> None:
        self.starts: list[int] = []
        self.depths: list[int] = []
        self.top_spans: list[tuple[int, int]] = []
        self.anomalies: list[dict] = []
        depth, open_at = 0, None
        for m in _RE_BQ_TAG.finditer(doc):
            if m.group(0).startswith("</"):
                if depth == 0:
                    self.anomalies.append({"kind": "close_without_open", "offset": m.start()})
                else:
                    depth -= 1
                    if depth == 0 and open_at is not None:
                        self.top_spans.append((open_at, m.end()))
                        open_at = None
            else:
                if depth == 0:
                    open_at = m.start()
                depth += 1
            self.starts.append(m.start())
            self.depths.append(depth)
        if depth != 0:
            self.anomalies.append({"kind": "unclosed_at_eof", "depth": depth, "offset": open_at})
            if open_at is not None:
                self.top_spans.append((open_at, len(doc)))
        self.max_depth = max(self.depths) if self.depths else 0
        self._tstarts = [s for s, _e in self.top_spans]

    def at(self, pos: int) -> int:
        """Nesting depth in effect at `pos` — 0 means the volume author's prose."""
        i = bisect.bisect_left(self.starts, pos)
        return self.depths[i - 1] if i else 0

    def top_span(self, pos: int) -> tuple[int, int] | None:
        """The OUTERMOST blockquote enclosing `pos`, or None."""
        i = bisect.bisect_right(self._tstarts, pos) - 1
        if i >= 0 and self.top_spans[i][1] > pos:
            return self.top_spans[i]
        return None


def blockquote_evidence(region: str, span: tuple[int, int], chunk_start: int,
                        footnotes: dict[int, str]) -> dict:
    """E1/E2/E3 for one OUTERMOST blockquote span, in region coordinates."""
    s, e = span
    inner = region[s:e]
    # E1 — a trailing right-aligned scaps paragraph inside the quote.
    inline = None
    for pm in _RE_P.finditer(inner):
        st = attr(pm.group(0), "style") or ""
        if "text-align: right" in st or "text-align:right" in st:
            sc = re.search(r"<span[^>]*class=['\"]scaps['\"][^>]*>(.*?)</span>", pm.group(2), re.S)
            inline = plain(sc.group(1) if sc else pm.group(2))
    # E2 — a footnote reference inside the quote.
    fn_id, fn_text, fn_name = None, None, None
    fm = _RE_FNREF.search(inner)
    if fm:
        fn_id = int(fm.group(1))
        fn_text = footnotes.get(fn_id)
        if fn_text:
            nm = _RE_FN_NAME.match(fn_text)
            fn_name = nm.group(1) if nm else None
    # E3 — the lead-in: the last LEAD_WINDOW chars of plain text before it.
    lead_from = chunk_start if s > chunk_start else max(0, s - LEAD_CONTEXT)
    lead_text = plain(region[lead_from:s])[-LEAD_WINDOW:]
    lead_name, lead_strong = None, False
    sm = None
    for sm in _RE_LEAD_STRONG.finditer(lead_text):
        pass  # keep the LAST naming clause before the quote
    if sm:
        lead_name, lead_strong = sm.group(1), True
    else:
        tm = None
        for tm in _RE_LEAD_TITLED.finditer(lead_text):
            pass
        if tm:
            lead_name = tm.group(1)
    return {
        "inline": inline,
        "footnote_id": fn_id,
        "footnote_text": fn_text,
        "footnote_name": fn_name,
        "lead_name": lead_name,
        "lead_strong": lead_strong,
        "attribution_lead": lead_text,
    }


def walk_paragraphs(region: str, chunk_start: int, chunk_end: int,
                    footnotes: dict[int, str], dx: DepthIndex,
                    ev_cache: dict) -> list[dict]:
    """One account's <p> stream, each node carrying its AUTHORITATIVE depth.

    `region` is the volume's <main> region with figures and tables blanked in
    place (offsets preserved); `dx` is a DepthIndex over that same string, so
    a node's depth is looked up, never re-derived.
    """
    out: list[dict] = []
    for m in _RE_P.finditer(region, chunk_start, chunk_end):
        pos = m.start()
        depth = dx.at(pos)
        if depth == 0:
            out.append({"in_blockquote": False, "depth": 0, "attrs": m.group(1),
                        "html": m.group(2), "pos": pos, "evidence": {}})
            continue
        span = dx.top_span(pos)
        if span is None:
            # depth > 0 with no enclosing outermost span means the markup is
            # unbalanced (see DepthIndex.anomalies). Fail loudly rather than
            # quietly demoting the paragraph to the volume author's prose —
            # quiet demotion is the exact defect this rewrite exists to kill.
            raise ValueError(
                f"blockquote depth {depth} at offset {pos} with no enclosing span; "
                f"markup anomalies: {dx.anomalies[:5]}"
            )
        key = (span, chunk_start)
        ev = ev_cache.get(key)
        if ev is None:
            ev = blockquote_evidence(region, span, chunk_start, footnotes)
            ev_cache[key] = ev
        if ev.get("inline") is not None and "text-align" in (attr(m.group(0), "style") or ""):
            continue  # the signature line is evidence, not a passage
        out.append({"in_blockquote": True, "depth": depth, "attrs": m.group(1),
                    "html": m.group(2), "pos": pos, "evidence": ev})
    return out


# ─────────────────────────────────────────────────────────────────────────────
# 8 · PER-VOLUME EXTRACTION
# ─────────────────────────────────────────────────────────────────────────────

_RE_FIG = re.compile(r"<figure\b([^>]*)>(.*?)</figure>", re.S)


def parse_figures(region: str) -> dict[str, dict]:
    figs = {}
    for m in _RE_FIG.finditer(region):
        tag, inner = m.group(1), m.group(2)
        fid = attr("<figure" + tag + ">", "id")
        if not fid:
            continue
        link = re.search(r"<a\b([^>]*class=['\"][^'\"]*fig-link[^'\"]*['\"][^>]*)>", inner)
        style = attr("<a" + link.group(1) + ">", "style") if link else None
        href = attr("<a" + link.group(1) + ">", "href") if link else None
        w = h = None
        if style:
            ar = re.search(r"aspect-ratio:\s*(\d+)\s*/\s*(\d+)", style)
            if ar:
                w, h = int(ar.group(1)), int(ar.group(2))
        t = re.search(r"<p[^>]*class=['\"]fig-title['\"][^>]*>(.*?)</p>", inner, re.S)
        lg = re.search(r"<p[^>]*class=['\"]fig-legend['\"][^>]*>(.*?)</p>", inner, re.S)
        figs[fid] = {
            "id": fid,
            "is_plate": "fig-plate" in (attr("<figure" + tag + ">", "class") or ""),
            "image": href,
            "title": plain(t.group(1)) if t else None,
            "legend": plain(lg.group(1)) if lg else None,
            "w": w,
            "h": h,
        }
    return figs


def roman(n: int) -> str:
    vals = [(1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"),
            (50, "L"), (40, "XL"), (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")]
    out = ""
    for v, s in vals:
        while n >= v:
            out += s
            n -= v
    return out


def extract_volume(n: int, page: str, division: str, index_title: str,
                   human: dict) -> tuple[dict, list[dict], list[dict]]:
    region_start, region_end = main_region_span(page)
    region = page[region_start:region_end]
    footnotes = parse_footnotes(page)
    figures = parse_figures(region)

    # The prose stream: figures and tables blanked IN PLACE so every offset in
    # `bregion` is also an offset in `region` and (plus region_start) in `page`.
    bregion = blank_markup(region, _RE_FIGURE)
    bregion = blank_markup(bregion, _RE_TABLE)
    dx = DepthIndex(bregion)
    ev_cache: dict = {}

    byline_raw = None
    bm = re.search(r"<p[^>]*class=['\"]hero-vol-byline['\"][^>]*>(.*?)</p>", page, re.S)
    if bm:
        byline_raw = plain(bm.group(1))
    author, year = None, None
    if byline_raw:
        am = re.match(r"By\s+(.+?),\s*(\d{4})\s*$", byline_raw)
        if am:
            author, year = am.group(1).strip(), int(am.group(2))
        else:
            author = re.sub(r"^By\s+", "", byline_raw).strip()

    hero_t = re.search(r"<h1[^>]*>(.*?)</h1>", region, re.S)
    hero_s = re.search(r"<p[^>]*class=['\"]hero-vol-subtitle['\"][^>]*>(.*?)</p>", region, re.S)
    title = plain(hero_t.group(1)) if hero_t else index_title
    subtitle = plain(hero_s.group(1)) if hero_s else None
    full_title = f"{title}, {subtitle}" if subtitle else title

    source_url = VOLUME_URL % n

    vol = {
        "n": n,
        "roman": roman(n),
        "division": division,
        "title": title,
        "subtitle": subtitle,
        "full_title": full_title,
        "index_title": index_title,
        "byline_raw": byline_raw,
        "author": author,
        "year": year,
        "source_url": source_url,
        "footnote_count": len(footnotes),
        "figure_count": len(figures),
        # NO PAGE MARKERS EXIST. Measured: zero data-page / class="page" /
        # pagenum attributes in any of the 14 volumes. Every passage therefore
        # ships page: null, and the citation is volume + species heading.
        "has_page_markers": bool(
            re.search(r"data-page=|class=['\"]page(num)?['\"]", page)
        ),
    }

    accounts, dropped = [], []
    chunks = segment(region)
    unsegmented = [
        {
            "volume": n,
            "heading": ch["title"],
            "level": ch["level"],
            "synonymy_paragraphs": ch["synonymy_count"],
            "reason": "synopsis_table_not_per_species" if ch["is_synopsis_table"] else "synonymy_without_account",
        }
        for ch in chunks
        if (ch["is_synopsis_table"] and ch["synonymy_count"]) or (not ch["is_account"] and ch["synonymy_count"])
    ]
    vol["unsegmented_regions"] = unsegmented
    vol["blockquote_tags"] = len(dx.starts)
    vol["blockquote_top_level_spans"] = len(dx.top_spans)
    vol["blockquote_max_depth"] = dx.max_depth
    vol["blockquote_anomalies"] = dx.anomalies
    for ci, ch in enumerate(chunks):
        if not ch["is_account"]:
            continue
        head_tag = "<h" + str(ch["level"]) + ch["attrs"] + ">"
        data_plate = attr(head_tag, "data-plate")
        body = ch["body"]

        syn_m = re.search(r"<p[^>]*class=['\"]synonymy['\"][^>]*>(.*?)</p>", body, re.S)
        synonymy = plain(syn_m.group(1)) if syn_m else None
        chars_m = re.search(r"<p[^>]*class=['\"]chars['\"][^>]*>(.*?)</p>", body, re.S)

        # BINOMIAL. Strong path: the first <em> in a <p> BEFORE p.synonymy.
        # Weak path (~74% of accounts): p.synonymy up to the first em dash.
        binomial, binomial_source, authority = None, None, None
        pre = body[: syn_m.start()] if syn_m else body
        em = re.search(r"<p\b[^>]*>\s*<em>(.*?)</em>", pre, re.S)
        if em:
            binomial = plain(em.group(1)).strip(" .,")
            binomial_source = "em"
            owner = re.search(r"<p\b[^>]*>\s*<em>.*?</em>(.*?)</p>", pre, re.S)
            if owner:
                sc = re.search(r"<span[^>]*class=['\"]scaps['\"][^>]*>(.*?)</span>", owner.group(1), re.S)
                if sc:
                    authority = plain(sc.group(1)).strip(" .,")
        elif synonymy:
            binomial = synonymy.split("—")[0].strip(" .,")
            binomial_source = "synonymy"
        elif ch["account_source"] == "scaps_paragraph":
            # The scaps-headed narrative paragraph (F2-greylag). Reported as its
            # own source so the UI's "weak path, verify" treatment can cover it
            # without the row claiming a p.synonymy line that does not exist.
            sp = _RE_SCAPS_BINOM_P.match(body)
            if sp:
                binomial = plain(sp.group(1)).strip(" .,")
                binomial_source = "scaps_paragraph"
                au = re.match(
                    r"^\s*<p\b[^>]*>\s*<span[^>]*class=['\"]scaps['\"][^>]*>[^<]*</span>"
                    r"\s*,?\s*<em>([^<]{1,40})</em>", body, re.S)
                if au:
                    authority = plain(au.group(1)).strip(" .,")

        acc_id = f"v{n}-{ci:03d}"
        passages, bq_dropped = [], []
        pi = 0
        prose_i = 0
        tail_cut = False
        for node in walk_paragraphs(bregion, ch["body_start"], ch["body_end"],
                                    footnotes, dx, ev_cache):
            cls = attr("<p" + node["attrs"] + ">", "class") or ""
            if cls.split() and cls.split()[0] in ("synonymy", "chars", "fig-title", "fig-legend"):
                continue
            text = plain(node["html"])
            if not text:
                continue
            if tail_cut:
                dropped.append({"account": acc_id, "reason": "genus_bleed_tail", "text": text[:220]})
                continue

            if not node["in_blockquote"]:
                reason = bleed_reason(text, prose_i)
                prose_i += 1
                if reason:
                    if reason == "genus_bleed_tail":
                        tail_cut = True
                    dropped.append({"account": acc_id, "reason": reason, "text": text[:220]})
                    continue
                res = dict(speaker=author or "", speaker_candidate=None,
                           speaker_source="volume_byline",
                           speaker_confidence="certain" if author else "unresolved",
                           shippable=bool(author))
                ev = {}
            else:
                if len(text) < 25:
                    dropped.append({"account": acc_id, "reason": "short_quotation", "text": text})
                    continue
                ev = dict(node["evidence"])
                pid = f"{acc_id}-p{pi:02d}"
                ev["human"] = human.get(pid)
                if node["depth"] >= 2 and not ev.get("human"):
                    # A QUOTE INSIDE A QUOTE HAS TWO CANDIDATE SPEAKERS and the
                    # markup names neither. The enclosing span's E1/E2/E3
                    # evidence belongs to the OUTER speaker, so applying it here
                    # would manufacture a confident wrong name — the same class
                    # of error as flattening a blockquote, one level down.
                    # P4 governs: never guess. Only a human override (E4) can
                    # name a nested quotation.
                    res = dict(speaker="", speaker_candidate=None,
                               speaker_source="nested_quotation",
                               speaker_confidence="unresolved", shippable=False)
                else:
                    res = resolve_speaker(ev, author or "")

            pid = f"{acc_id}-p{pi:02d}"
            p = {
                "passage_id": pid,
                "text": text,
                "is_quotation": node["in_blockquote"],
                # The parser's authoritative depth, and the page-absolute byte
                # offset of the <p that produced this passage. Both exist so a
                # human — or P6 — can go back to the cached bytes and check.
                "bq_depth": node["depth"],
                "src_offset": region_start + node["pos"],
                # Filled in by P6 (verify_blockquote_depth) before anything is
                # written: agreed | disagreed | unlocatable | ambiguous.
                "depth_check": None,
                "independent_depth": None,
                "speaker": res["speaker"],
                "speaker_candidate": res["speaker_candidate"],
                "speaker_source": res["speaker_source"],
                "speaker_confidence": res["speaker_confidence"],
                "shippable": res["shippable"],
                "volume": n,
                "volume_title": full_title,
                "volume_author": author,
                "page": None,  # measured: c82 carries no page markers anywhere
                "source_url": source_url,
                "char_count": len(text),
                "word_count": len(text.split()),
                "sic": find_artefacts(text),
            }
            if node["in_blockquote"]:
                p["attribution_lead"] = ev.get("attribution_lead")
                p["footnote_id"] = ev.get("footnote_id")
                p["footnote_text"] = ev.get("footnote_text")
                if not res["shippable"]:
                    bq_dropped.append(pid)
            passages.append(p)
            pi += 1

        plate = figures.get(data_plate) if data_plate else None
        accounts.append(
            {
                "account_id": acc_id,
                "volume": n,
                "volume_title": full_title,
                "volume_author": author,
                "source_url": source_url,
                "heading_level": ch["level"],
                "account_source": ch["account_source"],
                "jardine_title": ch["title"],
                "jardine_binomial": binomial,
                "jardine_authority": authority,
                "binomial_source": binomial_source,
                "synonymy": synonymy,
                "chars": plain(chars_m.group(1)) if chars_m else None,
                "plate_ref": data_plate,
                "plate_is_vignette": data_plate == "vignette" if data_plate else False,
                "plate": plate,
                "passages": passages,
                "unshippable_quotations": bq_dropped,
            }
        )
    return vol, accounts, dropped


# ─────────────────────────────────────────────────────────────────────────────
# 8b · P6 — THE INVARIANT THAT CAN ACTUALLY FIRE
#
# P5 asks "does any is_quotation=True passage name the volume author?" and can
# therefore never see a passage whose is_quotation is itself wrong. P6 asks a
# question that does not mention is_quotation until the last line: "what does a
# completely separate reading of the raw cached bytes say this paragraph's
# blockquote depth is?" — and then demands the two answers agree.
#
# INDEPENDENCE, precisely. The function below:
#   * reads the RAW cached page, not the region, not the blanked region;
#   * does not call main_region_span(), segment(), DepthIndex, walk_paragraphs
#     or blockquote_evidence, and does not know a chunk or an account exists;
#   * builds no stack and pairs no tags: it counts how many '<blockquote' and
#     '</blockquote' byte sequences START before an offset and subtracts;
#   * is keyed by the passage TEXT, not by an offset the parser recorded, so a
#     parser that mislocates a paragraph cannot smuggle its own answer in.
# The only thing it shares with the parser is plain(), which normalises text
# and has nothing to do with depth.
#
# THE ONE UNDECLARED THING, NOW DECLARED (R3, 2026-07-27). The two methods scan
# DIFFERENT EXTENTS — the parser indexes the blanked <main> region, this counts
# over the whole page — so their depths are only comparable because every
# out-of-main blockquote sits AFTER </main>. Measured over all 14 cached
# volumes: '<blockquote' occurrences before <main> = 0, against 21 top-level
# pairs after </main> in the footnote lists (v9 +5, v20 +3, v21 +1, v24 +6,
# v34 +3, v36 +1, v40 +2). Tags after an offset cannot change a bisect count
# taken at that offset, so the extra pairs cancel. This is a property of the
# cached bytes, not an invariant this code enforces; it is stated here and
# republished per-volume in report.json so a re-fetch that moves the footnotes
# is auditable. It fails LOUD if it ever changes — mass disagreement, exit 4,
# zero files written — never silently.
# ─────────────────────────────────────────────────────────────────────────────

_RE_P_ANY = re.compile(r"<p\b[^>]*>(.*?)</p>", re.S)


def independent_depth_index(page: str) -> dict[str, set[int]]:
    """plain(<p> text) -> the set of blockquote depths it is found at."""
    opens = [m.start() for m in re.finditer(r"<blockquote\b", page)]
    closes = [m.start() for m in re.finditer(r"</blockquote\b", page)]
    out: dict[str, set[int]] = {}
    for m in _RE_P_ANY.finditer(page):
        o = m.start()
        depth = bisect.bisect_left(opens, o) - bisect.bisect_left(closes, o)
        t = plain(m.group(1))
        if not t:
            continue
        out.setdefault(t, set()).add(depth)
    return out


def verify_blockquote_depth(accounts: list[dict],
                            pages: dict[int, str]) -> tuple[list[dict], list[dict]]:
    """Second opinion on EVERY passage. Returns (disagreements, unresolvable).

    A disagreement is fatal — main() aborts and writes nothing. An unresolvable
    passage (the independent method cannot find its text, or finds it at two
    different depths) is forced shippable=False and reported. Neither case ever
    rewrites a speaker: a depth argument is never settled by re-attribution.
    """
    idx = {n: independent_depth_index(p) for n, p in pages.items()}
    disagreements: list[dict] = []
    unresolvable: list[dict] = []
    for a in accounts:
        for p in a["passages"]:
            found = idx.get(p["volume"], {}).get(p["text"])
            if found is None:
                p["depth_check"] = "unlocatable"
                p["shippable"] = False
                unresolvable.append({"passage_id": p["passage_id"], "volume": p["volume"],
                                     "reason": "unlocatable", "is_quotation": p["is_quotation"],
                                     "text": p["text"][:160]})
            elif len(found) > 1:
                p["depth_check"] = "ambiguous"
                p["shippable"] = False
                unresolvable.append({"passage_id": p["passage_id"], "volume": p["volume"],
                                     "reason": "ambiguous", "depths": sorted(found),
                                     "is_quotation": p["is_quotation"], "text": p["text"][:160]})
            else:
                dep = next(iter(found))
                p["independent_depth"] = dep
                if (dep > 0) != bool(p["is_quotation"]):
                    p["depth_check"] = "disagreed"
                    disagreements.append({
                        "passage_id": p["passage_id"], "volume": p["volume"],
                        "account": a["jardine_title"], "source_url": a["source_url"],
                        "parser_is_quotation": p["is_quotation"],
                        "parser_depth": p.get("bq_depth"),
                        "independent_depth": dep,
                        "speaker": p["speaker"], "shippable": p["shippable"],
                        "src_offset": p.get("src_offset"),
                        "words": p["word_count"], "text": p["text"][:160],
                    })
                else:
                    p["depth_check"] = "agreed"
            if (p["depth_check"] != "agreed" and p["is_quotation"]
                    and p["passage_id"] not in a["unshippable_quotations"]):
                a["unshippable_quotations"].append(p["passage_id"])
    return disagreements, unresolvable


# ─────────────────────────────────────────────────────────────────────────────
# 9 · EMIT + PIN
# ─────────────────────────────────────────────────────────────────────────────


def corpus_text(accounts: list[dict]) -> str:
    """
    THE HASHED STRING, defined exactly so it can be reproduced by hand:
    every extracted passage's verbatim text, in (volume asc, account order,
    passage order), joined by a single \\n, no trailing newline. This is the
    concatenated EXTRACTED TEXT — not the JSON, which carries timestamps.
    """
    parts = []
    for a in sorted(accounts, key=lambda a: (a["volume"], a["account_id"])):
        for p in a["passages"]:
            parts.append(p["text"])
    return "\n".join(parts)


def write_tsvs(out: str, accounts: list[dict]) -> None:
    rows = [
        "binomial_source\taccount_source\tvolume\tvolume_author\tjardine_title\tjardine_binomial\t"
        "jardine_authority\tplate_ref\tpassages\tquotations\tunshippable_quotations\t"
        "word_count\tsic_high\tsic_low\tsource_url"
    ]
    for a in sorted(accounts, key=lambda a: (a["binomial_source"] or "zz", a["volume"], a["jardine_title"])):
        wc = sum(p["word_count"] for p in a["passages"])
        hi = sum(1 for p in a["passages"] for s in p["sic"] if s["precision"] == "high")
        lo = sum(1 for p in a["passages"] for s in p["sic"] if s["precision"] == "low")
        q = sum(1 for p in a["passages"] if p["is_quotation"])
        rows.append(
            "\t".join(
                str(x).replace("\t", " ")
                for x in [
                    a["binomial_source"], a["account_source"], a["volume"], a["volume_author"],
                    a["jardine_title"], a["jardine_binomial"], a["jardine_authority"],
                    a["plate_ref"], len(a["passages"]), q,
                    len(a["unshippable_quotations"]), wc, hi, lo, a["source_url"],
                ]
            )
        )
    with open(os.path.join(out, "verify.tsv"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(rows) + "\n")

    prows = [
        "passage_id\tvolume\tvolume_author\tjardine_title\tis_quotation\tspeaker\t"
        "speaker_candidate\tspeaker_source\tspeaker_confidence\tshippable\tsic_high\twords\t"
        # The four depth columns are APPENDED, after `text`, so no existing
        # column index moves for anything already reading this file.
        "attribution_lead\tfootnote_text\ttext\tbq_depth\tindependent_depth\tdepth_check\tsrc_offset"
    ]
    for a in sorted(accounts, key=lambda a: (a["volume"], a["account_id"])):
        for p in a["passages"]:
            hi = sum(1 for s in p["sic"] if s["precision"] == "high")
            prows.append(
                "\t".join(
                    str(x).replace("\t", " ").replace("\n", " ")
                    for x in [
                        p["passage_id"], p["volume"], p["volume_author"], a["jardine_title"],
                        p["is_quotation"], p["speaker"], p["speaker_candidate"] or "",
                        p["speaker_source"] or "", p["speaker_confidence"], p["shippable"],
                        hi, p["word_count"],
                        (p.get("attribution_lead") or "")[-160:], (p.get("footnote_text") or "")[:120],
                        p["text"],
                        p.get("bq_depth"),
                        "" if p.get("independent_depth") is None else p["independent_depth"],
                        p.get("depth_check") or "",
                        p.get("src_offset"),
                    ]
                )
            )
    with open(os.path.join(out, "passages.tsv"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(prows) + "\n")

    # depth-audit.tsv — every passage the two independent depth methods did NOT
    # simply agree on, plus every passage sitting at depth >= 2. Empty but for
    # its header is the expected, correct state.
    drows = ["passage_id\tvolume\tjardine_title\tbq_depth\tindependent_depth\tdepth_check\t"
             "is_quotation\tspeaker\tspeaker_source\tshippable\tsrc_offset\ttext"]
    for a in sorted(accounts, key=lambda a: (a["volume"], a["account_id"])):
        for p in a["passages"]:
            if p.get("depth_check") == "agreed" and p.get("bq_depth", 0) < 2:
                continue
            drows.append("\t".join(
                str(x).replace("\t", " ").replace("\n", " ")
                for x in [
                    p["passage_id"], p["volume"], a["jardine_title"], p.get("bq_depth"),
                    "" if p.get("independent_depth") is None else p["independent_depth"],
                    p.get("depth_check") or "", p["is_quotation"], p["speaker"],
                    p["speaker_source"] or "", p["shippable"], p.get("src_offset"),
                    p["text"][:400],
                ]))
    with open(os.path.join(out, "depth-audit.tsv"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(drows) + "\n")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fetch", action="store_true", help="re-fetch the 15 pages into the cache (polite, 1.5s apart)")
    ap.add_argument("--cache", default=DEFAULT_CACHE)
    ap.add_argument("--out", default=None, help="where the corpus is written (default: --cache)")
    ap.add_argument("--speakers", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "speakers.json"),
                    help="curator's passage_id -> speaker overrides (E4)")
    ap.add_argument("--verify", metavar="SHA256", default=None,
                    help="assert the corpus text still hashes to this; exit 1 if it drifted")
    args = ap.parse_args()

    cache = args.cache
    out = args.out or cache
    if args.fetch:
        do_fetch(cache)
    os.makedirs(out, exist_ok=True)

    idx_path = os.path.join(cache, "index.html")
    if not os.path.exists(idx_path):
        print(f"no cache at {cache}; run with --fetch first", file=sys.stderr)
        return 2
    index = open(idx_path, encoding="utf-8").read()
    manifest = parse_index(index)
    birds = [(n, t) for n, d, t in manifest if d == "birds"]

    human = {}
    if os.path.exists(args.speakers):
        raw = json.load(open(args.speakers, encoding="utf-8"))
        # keys beginning with '_' are documentation, not passage ids
        human = {k: v for k, v in raw.items() if not k.startswith("_") and isinstance(v, str) and v.strip()}

    volumes, accounts, dropped = [], [], []
    missing = []
    pages: dict[int, str] = {}
    for n, t in birds:
        p = os.path.join(cache, f"vol-{n}.html")
        if not os.path.exists(p):
            missing.append(n)
            continue
        page = open(p, encoding="utf-8").read()
        pages[n] = page
        v, accs, drp = extract_volume(n, page, "birds", t, human)
        volumes.append(v)
        accounts.extend(accs)
        dropped.extend(drp)

    # ── P6 · THE SECOND OPINION, TAKEN BEFORE ANYTHING ELSE IS BELIEVED ────
    disagreements, unresolvable = verify_blockquote_depth(accounts, pages)
    if disagreements:
        print("BLOCKQUOTE DEPTH DISAGREEMENT (P6) — writing nothing.", file=sys.stderr)
        print(f"  {len(disagreements)} passage(s): the parser and an independent "
              f"byte-offset scan of the cached HTML do not agree on whether these "
              f"sat inside a <blockquote>.", file=sys.stderr)
        for d in disagreements[:25]:
            print(f"  {d['passage_id']:>16}  vol {d['volume']:>2}  "
                  f"parser is_quotation={str(d['parser_is_quotation']):<5} "
                  f"parser_depth={d['parser_depth']}  independent_depth={d['independent_depth']}  "
                  f"speaker={d['speaker']!r} shippable={d['shippable']}  "
                  f"byte {d['src_offset']}  {d['account']}", file=sys.stderr)
        if len(disagreements) > 25:
            print(f"  … and {len(disagreements) - 25} more", file=sys.stderr)
        return 4

    # ── P5 · THE HARD INVARIANT ────────────────────────────────────────────
    violations = []
    for a in accounts:
        for p in a["passages"]:
            if p["is_quotation"] and p["speaker"] and p["volume_author"] \
               and p["speaker"].strip().lower() == p["volume_author"].strip().lower():
                violations.append(p["passage_id"])
            if p["shippable"] and not p["speaker"]:
                violations.append(p["passage_id"] + " (shippable with no speaker)")
    if violations:
        print("BLOCKQUOTE PROTOCOL VIOLATION — writing nothing:", violations[:20], file=sys.stderr)
        return 3

    # ── AUTHORSHIP GATE ────────────────────────────────────────────────────
    null_authors = [v["n"] for v in volumes if not v["author"]]

    text = corpus_text(accounts)
    sha = hashlib.sha256(text.encode("utf-8")).hexdigest()

    if args.verify:
        ok = sha == args.verify.strip().lower()
        print(("VERIFIED " if ok else "DRIFTED ") + sha)
        return 0 if ok else 1

    qs = [p for a in accounts for p in a["passages"] if p["is_quotation"]]
    art_hi: dict[str, int] = {}
    art_lo: dict[str, int] = {}
    for a in accounts:
        for p in a["passages"]:
            for s in p["sic"]:
                bucket = art_hi if s["precision"] == "high" else art_lo
                bucket[s["kind"]] = bucket.get(s["kind"], 0) + 1
    drop_reasons: dict[str, int] = {}
    for d in dropped:
        drop_reasons[d["reason"]] = drop_reasons.get(d["reason"], 0) + 1
    acct_src: dict[str, int] = {}
    for a in accounts:
        k = a["account_source"] or "unknown"
        acct_src[k] = acct_src.get(k, 0) + 1

    report = {
        "extracted_at": time.strftime("%Y-%m-%d"),
        "generator": "tools/jardine/extract.py",
        "source": INDEX_URL,
        "pages_fetched": [INDEX_URL] + [VOLUME_URL % n for n, _ in birds],
        "volumes_in_manifest": len(manifest),
        "bird_volumes": [n for n, _ in birds],
        "missing_from_cache": missing,
        "authorship_gate": {
            "volumes_with_null_author": null_authors,
            "passed": not null_authors,
            "authors": {v["n"]: v["author"] for v in volumes},
            "not_jardine": {v["n"]: v["author"] for v in volumes if v["author"] and "Jardine" not in v["author"]},
        },
        "accounts": len(accounts),
        "accounts_per_volume": {v["n"]: sum(1 for a in accounts if a["volume"] == v["n"]) for v in volumes},
        "accounts_by_discriminator": acct_src,
        "unsegmented_regions": [r for v in volumes for r in v["unsegmented_regions"]],
        "passages": sum(len(a["passages"]) for a in accounts),
        "quotations": len(qs),
        "blockquote_depth_check": {
            # SCOPE OF THIS METHOD LINE, stated exactly (R3, 2026-07-27).
            # It describes the P6 CHECK ONLY — passages_checked / agreed /
            # disagreed / unresolvable. It does NOT describe the two per-volume
            # span maps below, which are parser figures over the blanked <main>
            # region and are labelled as such in their own key names. An earlier
            # revision let this string sit next to those maps unqualified, and an
            # auditor counting <blockquote> in the raw cached file could not
            # reproduce them.
            "method": "P6: parser DepthIndex over the blanked <main> region vs. an "
                      "independent byte-offset scan of the RAW cached page, keyed "
                      "by plain() passage text. Governs passages_checked, agreed, "
                      "disagreed and unresolvable only.",
            "method_scope_note": "The independent scan counts '<blockquote' and "
                                 "'</blockquote' byte sequences over the WHOLE page "
                                 "while the parser indexes the <main> region only. "
                                 "Measured over all 14 cached volumes: blockquote "
                                 "opens occurring BEFORE <main> = 0, so every "
                                 "out-of-main blockquote sits after </main> in the "
                                 "footnote list and contributes an equal count to "
                                 "both sides of every in-main offset. This positional "
                                 "fact is what makes the two methods comparable; it "
                                 "is not an assumption the code enforces. If a future "
                                 "re-fetch moves the footnote list above <main>, the "
                                 "two methods diverge en masse and the run exits 4 — "
                                 "loudly, never silently.",
            "passages_checked": sum(len(a["passages"]) for a in accounts),
            "agreed": sum(1 for a in accounts for p in a["passages"] if p["depth_check"] == "agreed"),
            "disagreed": len(disagreements),
            "unresolvable": len(unresolvable),
            "unresolvable_detail": unresolvable[:200],
            "passages_by_depth": {
                str(d): sum(1 for a in accounts for p in a["passages"] if p["bq_depth"] == d)
                for d in sorted({p["bq_depth"] for a in accounts for p in a["passages"]})
            },
            "nested_quotations_unshipped": sum(
                1 for a in accounts for p in a["passages"]
                if p["speaker_source"] == "nested_quotation"),
            "markup_anomalies": [
                {"volume": v["n"], **an} for v in volumes for an in v["blockquote_anomalies"]
            ],
            # NAMED FOR WHAT THEY ARE. These are DepthIndex figures over the
            # parser's BLANKED <main> region — not a count of '<blockquote' in
            # the raw cached file, and not a tag count either: top_level_spans
            # counts OUTERMOST spans, so a nested pair contributes one. Both
            # numbers are the correct ones for attribution, which is why they
            # are reported; only the old key names invited the wrong reading.
            "outermost_blockquote_spans_per_volume_main_region": {
                v["n"]: v["blockquote_top_level_spans"] for v in volumes},
            "max_nesting_depth_per_volume_main_region": {
                v["n"]: v["blockquote_max_depth"] for v in volumes},
            "raw_page_blockquote_open_tags_per_volume": {
                v["n"]: len(re.findall(r"<blockquote\b", pages[v["n"]])) for v in volumes},
            "blockquote_open_tags_before_main_per_volume": {
                v["n"]: len(re.findall(r"<blockquote\b",
                                       pages[v["n"]][: main_region_span(pages[v["n"]])[0]]))
                for v in volumes},
        },
        "quotation_resolution": {
            "certain": sum(1 for p in qs if p["speaker_confidence"] == "certain"),
            "probable_not_shipped": sum(1 for p in qs if p["speaker_confidence"] == "probable"),
            "unresolved_dropped": sum(1 for p in qs if p["speaker_confidence"] == "unresolved"),
            "by_source": {
                s: sum(1 for p in qs if (p["speaker_source"] or "no_evidence") == s)
                for s in sorted({p["speaker_source"] or "no_evidence" for p in qs})
            },
        },
        "unresolved_quotations": [
            {"passage_id": p["passage_id"], "volume": p["volume"],
             "candidate": p["speaker_candidate"], "confidence": p["speaker_confidence"],
             "lead": (p.get("attribution_lead") or "")[-120:], "text": p["text"][:160]}
            for p in qs if p["speaker_confidence"] != "certain"
        ],
        "paragraphs_dropped_by_the_genus_guard": len(dropped),
        "dropped_by_reason": drop_reasons,
        "ocr_artefact_census_high_precision": art_hi,
        "ocr_artefact_census_low_precision": art_lo,
        "page_markers_present_in_any_volume": any(v["has_page_markers"] for v in volumes),
        "corpus_chars": len(text),
        "corpus_sha256": sha,
    }

    with open(os.path.join(out, "corpus.json"), "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "report": report, "volumes": volumes,
                   "accounts": accounts}, fh, ensure_ascii=False, indent=1)
    with open(os.path.join(out, "corpus.txt"), "w", encoding="utf-8") as fh:
        fh.write(text)
    with open(os.path.join(out, "corpus.sha256"), "w", encoding="utf-8") as fh:
        fh.write(sha + "\n")
    with open(os.path.join(out, "report.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=1)
    write_tsvs(out, accounts)
    with open(os.path.join(out, "dropped.tsv"), "w", encoding="utf-8") as fh:
        fh.write("account\treason\ttext\n")
        for d in dropped:
            fh.write("\t".join(str(x).replace("\t", " ").replace("\n", " ")
                               for x in (d["account"], d["reason"], d["text"])) + "\n")

    # The console summary omits only unresolvable_detail (it can be long); the
    # full record is in report.json and depth-audit.tsv.
    summary = {k: report[k] for k in
               ("accounts", "accounts_by_discriminator", "passages", "quotations",
                "blockquote_depth_check",
                "quotation_resolution", "authorship_gate",
                "ocr_artefact_census_high_precision", "ocr_artefact_census_low_precision",
                "dropped_by_reason", "corpus_chars", "corpus_sha256",
                "page_markers_present_in_any_volume")}
    summary["blockquote_depth_check"] = {
        k: v for k, v in summary["blockquote_depth_check"].items() if k != "unresolvable_detail"
    }
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
