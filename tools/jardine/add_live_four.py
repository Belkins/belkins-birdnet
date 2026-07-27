#!/usr/bin/env python3
"""Add the four birds the LIVE STATION hears that the corpus had and we lacked.

WHY THIS EXISTS, AND WHY IT IS SEPARATE FROM add_seven.py
---------------------------------------------------------
add_seven.py filled the gap between the corpus and the committed 47-row FIXTURE
and its commit claimed "47 of 47 — every bird the station hears". That claim was
true of the fixture and FALSE of the station. Measured against the live catalog
on 2026-07-27 (http://birdnet.local/collage/species.json, 47 rows / 3,684
detections): the fixture and the station are DIFFERENT sets of 47, disjoint by
five in each direction. Real coverage was 42/47.

    live, no corpus entry : Anas crecca, Anas platyrhynchos, Calidris alpina,
                            Falco peregrinus, Streptopelia decaocto
    corpus, never heard   : Columba livia, Larus argentatus, Sturnus vulgaris,
                            Sylvia atricapilla, Turdus iliacus

Four of the five have accounts and are added here, taking the station to 46/47.

THE FIFTH IS REFUSED, ON PURPOSE
---------------------------------
`Streptopelia decaocto` — the Eurasian Collared Dove, 40 detections on the live
station — is NOT added, though the corpus contains v9-025 "Collared Turtle".
That account is *Turtur risorius* / *Columba risoria*, whose own synonymy reads
"Turtur torquatus Senegalensis" and whose first sentence is "From a very remote
period this species appears to have been domesticated". It is the Barbary or
African collared dove, a cage bird, and a different species. Matching it on the
word "Collared" would file a domesticated African dove under a wild British
garden bird — the exact failure the extractor README warns about with Turdus
musicus. The row stays absent and the Roll keeps printing "the library is
silent." against it, which is the true answer.

Every string that reaches jardine.json is copied VERBATIM from the corpus
(sha256 9f1746f1..., re-derived from a fresh fetch and VERIFIED 2026-07-27).
The only authored strings are the three `note` fields — museum labels in the
MODERN hand, apparatus, never 1838 text.
"""
import json, re, sys, pathlib

CORPUS = pathlib.Path(sys.argv[1])
TARGET = pathlib.Path(sys.argv[2])

# ── THE HAND-WRITTEN CROSSWALK ──────────────────────────────────────────────
# Each row was accepted only on evidence in the account's OWN synonymy line,
# quoted in `why`. A common-name resemblance is never sufficient.
CROSSWALK = [
    # "Falco peregrinus, Auctorum" — the binomial has not moved in 188 years.
    dict(sci='Falco peregrinus', acc='v20-009',
         binom='Falco peregrinus', auth='Linnæus', drift='unchanged',
         voice='v20-009-p05', coda=None, note=None,
         why='synonymy: "Falco peregrinus, Auctorum"'),

    # "Anas crecca, Linn." stands verbatim in the synonymy of a Boschas account.
    dict(sci='Anas crecca', acc='v40-019',
         binom='Boschas crecca', auth=None, drift='genus',
         voice=None, coda=None,
         note='four paragraphs on its plumage and its range; no sound in any of them',
         why='synonymy: "Anas crecca, Linn."'),

    # "Anas Boschas, Linn. — Mallard of British authors": boschas is the junior
    # synonym of platyrhynchos, and the account names the Mallard outright.
    dict(sci='Anas platyrhynchos', acc='v40-018',
         binom='Boschas fera', auth='Briss', drift='genus',
         voice=None, coda=None,
         note='ten paragraphs on the most familiar duck in Britain and never once '
              'its quack; the only noise he sets down is a Florida flock leaving '
              'the water, and those are another man’s words',
         why='synonymy: "Anas Boschas, Linn., &c.—Common Wild Duck—Mallard of British authors."'),

    # "Tringa alpina, variabilis of authors. ... Purre, Dunlin, or Stint".
    dict(sci='Calidris alpina', acc='v34-069',
         binom='Tringa variabilis', auth=None, drift='genus',
         voice=None, coda=None,
         note='the most abundant sandpiper on his shores, described from two '
              'specimens that had been killed; no sound in it',
         why='synonymy: "Tringa alpina, variabilis of authors.—...Purre, Dunlin, or Stint"'),
]

# Recorded so the refusal is auditable rather than an omission nobody can see.
REFUSED = [
    dict(sci='Streptopelia decaocto', acc='v9-025',
         why='v9-025 is Turtur risorius / Columba risoria — "Turtur torquatus '
             'Senegalensis", "appears to have been domesticated". The Barbary or '
             'African collared dove, a different species. Name-similarity only.'),
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
        'is_quotation': p['is_quotation'], 'volume': p['volume'],
        'volume_title': p['volume_title'], 'volume_author': p['volume_author'],
        'source_url': p['source_url'], 'sic': ship_sic(p.get('sic')),
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
        assert row['binom'] in src, row['sci'] + ': binomial not verbatim in ' + repr(src)
        # The authority is verbatim either INSIDE the binomial string ("Boschas
        # fera, Briss") or in the account's own jardine_authority field — the
        # extractor splits it one way or the other depending on the source line.
        # Assert it came from one of them and was not typed from memory.
        if row['auth']:
            assert row['auth'] in src or row['auth'] == a.get('jardine_authority'), \
                row['sci'] + ': authority not verbatim in binomial %r or field %r' % (
                    src, a.get('jardine_authority'))

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
        doc['species'].append(rec)
        added.append(row['sci'])

    for r in REFUSED:
        assert r['sci'] not in {s['sci_name'] for s in doc['species']}, \
            r['sci'] + ' was REFUSED but is present — ' + r['why']
        print('REFUSED: %s (%s)' % (r['sci'], r['acc']))

    doc['species'].sort(key=lambda s: s['sci_name'])
    TARGET.write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')))
    print('added %d: %s' % (len(added), ', '.join(added)))
    print('species now: %d' % len(doc['species']))


main()
