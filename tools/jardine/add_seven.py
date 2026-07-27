#!/usr/bin/env python3
"""Add the seven London birds the corpus HAS and jardine.json lacked.

THE CROSSWALK IS HAND-WRITTEN AND STAYS THAT WAY — the extractor README is
explicit that any programmatic binomial join files the wrong page under the
right bird with total confidence (Jardine's Song Thrush is `Turdus musicus`,
which is the MODERN binomial of the Redwing). Every line below was read and
verified against the account text by a human-in-the-loop before being written.

Every string that reaches jardine.json is copied VERBATIM out of the verified
corpus (sha256 9f1746f1…, re-derived from a fresh fetch and VERIFIED on
2026-07-27). Nothing here paraphrases, corrects or generates prose. The only
authored strings are the two `note` fields, which are museum labels in the
MODERN hand (Space Mono, per the two-hand law) — apparatus, never 1838 text.
"""
import json, re, sys, pathlib

CORPUS = pathlib.Path(sys.argv[1])
TARGET = pathlib.Path(sys.argv[2])

# ── THE HAND-WRITTEN CROSSWALK ──────────────────────────────────────────────
# voice/coda are passage ids chosen BY EAR after reading the full account.
# A null voice is a finding, not a gap: it means the account genuinely
# describes no sound this bird makes, and `note` says what he wrote instead.
CROSSWALK = [
    dict(sci='Apus apus', acc='v24-136',
         binom='Cypselus apus', auth=None, drift='genus',
         voice='v24-136-p01', coda=None, note=None),
    dict(sci='Passer domesticus', acc='v24-091',
         binom='Pyrgitta domestica', auth='Flem', drift='genus',
         voice='v24-091-p00', coda=None, note=None),
    dict(sci='Sturnus vulgaris', acc='v24-080',
         binom='Sturnus vulgaris', auth='Linn', drift='unchanged',
         voice=None, coda=None,
         note='seven paragraphs and not one word on its voice; the only '
              'starlings he hears chatter are in the Rock Dove’s cave, '
              'in another volume'),
    dict(sci='Larus argentatus', acc='v40-099',
         binom='Larus argentatus', auth=None, drift='unchanged',
         voice=None, coda=None,
         note='three paragraphs on range and plumage; no sound in them'),
    dict(sci='Columba livia', acc='v34-005',
         binom='Columba livia', auth='Linn', drift='unchanged',
         voice='v34-005-p01', coda=None, note=None),
    dict(sci='Sylvia atricapilla', acc='v24-032',
         binom='Curruca atricapilla', auth=None, drift='genus',
         voice='v24-032-p00', coda=None, note=None),
    # Merula Iliaca -> Turdus iliacus is a GENUS move. The `collision` drift
    # stays on Turdus philomelos, which is where the name Turdus musicus
    # actually equivocates; this row is the slip's other half, not its cause.
    dict(sci='Turdus iliacus', acc='v24-013',
         binom='Merula Iliaca', auth=None, drift='genus',
         voice='v24-013-p00', coda=None, note=None),
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
    """Only HIGH-precision artefacts become a visible [sic].

    The low-precision net is kept for recall and is mostly correct words —
    it flags `Ireland` as an interior capital. Shipping that would hang a
    scar on a correctly spelled proper noun, which is the opposite of the
    point. Matches what the curator already did for the first forty.
    """
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

        # the split of "Sturnus vulgaris, Linn" into binomial + authority is
        # hand-written above; assert both halves are verbatim in the source.
        src = a['jardine_binomial']
        assert row['binom'] in src, row['sci'] + ': binomial not verbatim'
        if row['auth']:
            assert row['auth'] in src, row['sci'] + ': authority not verbatim'

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
        # a row must carry either a voice or an explanation of its absence
        assert rec['voice'] or rec['note'], row['sci'] + ': silent AND unexplained'
        doc['species'].append(rec)
        added.append(row['sci'])

    doc['species'].sort(key=lambda s: s['sci_name'])
    TARGET.write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')))
    print('added %d: %s' % (len(added), ', '.join(added)))
    print('species now: %d' % len(doc['species']))


main()
