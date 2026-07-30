#!/usr/bin/env python3
"""Add Ardea cinerea — the bird the wall was calling silent while it had a page.

THE DEFECT THIS CLOSES
----------------------
The live Roll printed "Gray Heron — the library is silent." That was FALSE.
Jardine's account of the Common Heron has been inside this museum's own verified
extraction the whole time: `v34-025`, volume XXXIV, five shippable paragraphs,
binomial `Ardea cinerea` — the same name Linnaeus gave it and the same name
BirdNET returns, with zero drift.

It was never added because the extraction was pinned on 2026-07-27 and this
garden first heard a heron on 2026-07-28. One day. The corpus is static and
correct; the catalog rebuilds nightly and grows. Nothing kept them in step, so
the museum asserted an absence about a bird it had recorded.

That is the fabricated-absence class again — the fourth time on this project —
and the worst instance yet, because it is printed in the same column as the
museum's most carefully earned true silences and cannot be told apart from them.

THE RECURRENCE IS THE REAL BUG. Every new species this station hears is a fresh
chance to print the same lie, and it will keep happening — the station is four
weeks old and still gaining birds. A one-off row does not fix that; the guard in
web/tests/jardine.test.ts (R1) does, by failing whenever the catalog contains a
species the corpus HAS an account for and jardine.json lacks a row for.

WHY THE CROSSWALK STAYS HAND-WRITTEN
------------------------------------
Same reason as always: a programmatic binomial join files the wrong page under
the right bird with total confidence. Jardine's Song Thrush is `Turdus musicus`,
which is the MODERN binomial of the Redwing. Here there is no ambiguity — the
1838 and 2026 names are byte-identical — but the rule is the rule, and the
account was read before it was accepted.

Every string that reaches jardine.json is verbatim from the verified corpus
(sha256 9f1746f1…, committed under tools/jardine/corpus/). The only authored
string is the `note`, which is a museum label in the modern hand.
"""
import json, re, sys, pathlib

CORPUS = pathlib.Path(sys.argv[1])
TARGET = pathlib.Path(sys.argv[2])

CROSSWALK = [
    dict(
        sci='Ardea cinerea', acc='v34-025',
        binom='Ardea cinerea', auth='Linnæus',
        # byte-identical to the modern binomial, so it joins the amber set —
        # one of the handful of names that has not moved in 188 years.
        drift='unchanged',
        voice=None, coda=None,
        # Verified by reading all five paragraphs: hawking and the game law,
        # habitat by rivers and shore, European range, then two paragraphs of
        # plumage measured to the half-inch. Not one sound word in any of them.
        note='five paragraphs — hawking, habitat, range, and the bill measured to '
             'the half-inch; not one sound in any of them',
        why='binomial is byte-identical: corpus "Ardea cinerea" == BirdNET "Ardea cinerea"',
    ),
]


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


def slugify(s):
    return re.sub(r'^-+|-+$', '', re.sub(r'[^a-z0-9]+', '-', s.lower()))


def ship_sic(raw):
    """HIGH-precision artefacts only — the low-precision net flags correct words."""
    return [{'find': a['find'], 'offset': a.get('offset', 0), 'note': a['note']}
            for a in (raw or []) if a.get('precision') == 'high']


def passage(p):
    assert p['shippable'], p['passage_id'] + ' is not shippable'
    assert not p['is_quotation'], p['passage_id'] + ' is a QUOTATION'
    assert p['speaker'].strip(), p['passage_id'] + ' has a blank speaker'
    return {
        'text': p['text'], 'speaker': p['speaker'],
        'is_quotation': False, 'volume': p['volume'],
        'volume_title': p['volume_title'], 'volume_author': p['volume_author'],
        'source_url': p['source_url'], 'sic': ship_sic(p.get('sic')),
        'elided_after': 0, 'subject': None,
    }


def main():
    A = {a['account_id']: a for a in accounts(json.loads(CORPUS.read_text()))}
    doc = json.loads(TARGET.read_text())
    have = {s['sci_name'] for s in doc['species']}
    added = []

    for row in CROSSWALK:
        if row['sci'] in have:
            print('SKIP (already present): ' + row['sci'])
            continue
        a = A[row['acc']]
        P = {p['passage_id']: p for p in a['passages']}
        src = a['jardine_binomial']
        assert row['binom'] in src, '%s: binomial not verbatim in %r' % (row['sci'], src)
        if row['auth']:
            assert row['auth'] in src or row['auth'] == a.get('jardine_authority'), \
                '%s: authority not verbatim' % row['sci']

        rec = {
            'sci_name': row['sci'], 'slug': slugify(row['sci']),
            'jardine_title': a['jardine_title'],
            'jardine_binomial': row['binom'],
            'jardine_authority': row['auth'],
            'sic': [],
            'binomial_source': a['binomial_source'],
            'volume': a['volume'], 'volume_title': a['volume_title'],
            'volume_author': a['volume_author'], 'source_url': a['source_url'],
            'plate_ref': a['plate_ref'],
            'plate_is_vignette': bool(a['plate_is_vignette']),
            'drift': row['drift'],
            'voice': passage(P[row['voice']]) if row['voice'] else None,
            'coda': passage(P[row['coda']]) if row['coda'] else None,
            'note': row['note'],
        }
        assert rec['voice'] or rec['note'], row['sci'] + ': silent AND unexplained'
        # drift 'unchanged' puts the name in amber, so prove it really is unchanged
        if row['drift'] == 'unchanged':
            assert rec['jardine_binomial'] == row['sci'], \
                '%s claims drift=unchanged but the names differ' % row['sci']
        doc['species'].append(rec)
        added.append(row['sci'])

    doc['species'].sort(key=lambda s: s['sci_name'])
    TARGET.write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')))
    print('added %d: %s' % (len(added), ', '.join(added) or '(none)'))
    print('species now: %d' % len(doc['species']))


main()
