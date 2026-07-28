#!/usr/bin/env python3
"""Build web/public/jardine-accounts.json — THE FULL ACCOUNT.

WHAT THIS IS FOR
----------------
jardine.json ships the CURATED reading: one voice passage per bird, sometimes a
coda, chosen by ear. That is 58 passages. The corpus holds **211** shippable,
non-quotation, fully attributed passages for the same 51 species — so 153 of
them, already through the entire provenance chain, were reaching nobody.

This file is the rest of the account: every passage for a bird, in the order it
was printed, so a reader can stop reading a quotation wall and read the library.

    RUN ONCE, OFF THE VERIFIED CORPUS. NEVER AT BUILD TIME. NEVER AT RUNTIME.

THE SHAPE IS FLAT, AND THAT WAS MEASURED
----------------------------------------
Each row is a complete JardinePassage, so web/src/jardine.ts parses it with its
EXISTING asPassage() — the same function, with the same speaker wall, that the
curated file goes through. No second parser, no expansion step, no drift.

Hoisting the per-account volume metadata (all passages in one account cite the
same volume) looks like an obvious saving and is not: measured at 243.7 KB
against the flat 234.6 KB raw, and 78.4 KB against 77.5 KB gzipped, because gzip
already collapses the repeated strings and the nesting adds its own overhead.
Flat is smaller AND simpler. Do not "optimise" it.

THE SAME WALLS AS EVERY OTHER GENERATOR IN THIS DIRECTORY
---------------------------------------------------------
Copied deliberately from add_seven.py / add_live_four.py rather than abstracted,
because these asserts are the thing that must not drift:
  * shippable, or it does not go
  * NOT is_quotation — a quotation puts a stranger's sentence under a named dead
    man; the whole corpus ships zero of them and that stays true here
  * non-blank speaker
  * HIGH-precision [sic] only — the low-precision net flags correct words
    (it flags "Ireland" as an interior capital)
Every string is verbatim. Nothing is paraphrased, corrected or generated.
"""
import json, sys, pathlib

CORPUS = pathlib.Path(sys.argv[1])
CURATED = pathlib.Path(sys.argv[2])
OUT = pathlib.Path(sys.argv[3])


def accounts(o, out=None):
    out = [] if out is None else out
    if isinstance(o, dict):
        for k, v in o.items():
            if k == 'accounts' and isinstance(v, list):
                out += [x for x in v if isinstance(x, dict)]
            else:
                accounts(v, out)
    elif isinstance(o, list):
        for x in o:
            accounts(x, out)
    return out


def ship_sic(raw):
    return [{'find': a['find'], 'offset': a.get('offset', 0), 'note': a['note']}
            for a in (raw or []) if a.get('precision') == 'high']


def passage(p, elided_after=0):
    assert p['shippable'], p['passage_id'] + ' is not shippable'
    assert not p['is_quotation'], p['passage_id'] + ' is a QUOTATION'
    assert p['speaker'].strip(), p['passage_id'] + ' has a blank speaker'
    return {
        'text': p['text'], 'speaker': p['speaker'],
        'is_quotation': False, 'volume': p['volume'],
        'volume_title': p['volume_title'], 'volume_author': p['volume_author'],
        'source_url': p['source_url'], 'sic': ship_sic(p.get('sic')),
        # HOW MANY PASSAGES WERE REFUSED AFTER THIS ONE. Uniform on every row,
        # zeros included: the header above forbids shape optimisation, and an
        # absent field would be indistinguishable from a zero.
        'elided_after': elided_after,
    }


def main():
    A = accounts(json.loads(CORPUS.read_text()))
    curated = json.loads(CURATED.read_text())

    # THE JOIN IS THE CURATED FILE'S OWN CROSSWALK, never a fresh title match.
    # jardine.json's rows were hand-written precisely because a programmatic
    # binomial join files the wrong page under the right bird with total
    # confidence (Jardine's Song Thrush is Turdus musicus, which is the MODERN
    # binomial of the Redwing). Reusing that decision means this file cannot
    # invent a mapping the curator did not already make and check.
    by_title = {}
    for s in curated['species']:
        by_title.setdefault(s['jardine_title'], []).append(s['sci_name'])
    dupes = {t: v for t, v in by_title.items() if len(v) > 1}
    assert not dupes, 'two species share a jardine_title, the join is ambiguous: %r' % dupes

    vols = {v['n'] for v in curated['volumes']}
    out, skipped = {}, []
    for a in A:
        names = by_title.get(a['jardine_title'])
        if not names:
            continue
        sci = names[0]
        # WALK THE WHOLE ACCOUNT IN PRINTED ORDER and count what is refused
        # between the passages that ship, instead of silently closing the gap.
        #
        # Without this the reading room prints 'N passages, as printed' over
        # prose that stops mid-clause — 'Mr Hewitson relates his knowledge of
        # one which' — because Jardine's lead-in introduces a quotation the
        # protocol will not publish. Six of the 211 shipped rows end with no
        # sentence punctuation at all for exactly this reason.
        #
        # NOTE the real mechanism, which is not the obvious one: all 15 refused
        # passages in these 51 accounts carry shippable=False (their speaker is
        # 'probable', never certain), so the `not is_quotation` clause is
        # REDUNDANT here and deleting it would restore nothing. The refusal is
        # correct and stays; what was missing was any record that it happened.
        rows = []
        for p in a['passages']:
            if p['shippable'] and not p['is_quotation']:
                rows.append(passage(p, 0))
            elif rows:
                # a refusal AFTER something shipped attaches to that row; a
                # refusal before the first shipped passage has nothing to hang
                # on and is simply the account opening mid-conversation.
                rows[-1]['elided_after'] += 1
        if not rows:
            skipped.append(sci)
            continue
        for r in rows:
            assert r['volume'] in vols, '%s cites volume %s, absent from the shelf' % (sci, r['volume'])
        out[sci] = rows

    # every species here must exist in the curated file — this is the SAME
    # museum, deepened, never a second and slightly different one
    assert set(out) <= {s['sci_name'] for s in curated['species']}, 'a species escaped the curated set'

    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')))
    n = sum(len(v) for v in out.values())
    print('wrote %s' % OUT.name)
    print('  species  : %d' % len(out))
    print('  passages : %d  (the curated file ships 58)' % n)
    print('  bytes    : %.1f KB' % (len(OUT.read_bytes()) / 1024))
    if skipped:
        print('  no shippable prose: %s' % ', '.join(skipped))


main()
