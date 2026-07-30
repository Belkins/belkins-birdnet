#!/usr/bin/env python3
"""Fetch Jardine's engravings for the species this garden actually hears.

WHY THIS IS THE ONE PART OF THE CORPUS THAT IS CLEANLY LICENSED
---------------------------------------------------------------
Rougeux's CC0 1.0 grant covers the restored ILLUSTRATIONS specifically — the
site footer's "All rights reserved" sits over the whole, and his OCR-cleaning
labour on the prose is unlicensed, which is why every quoted passage in this
museum carries `source_url` and his name. The plates are the opposite case: they
are the most clearly reusable thing on the site. We still credit him by name in
the colophon, because that was never a licence question.

A 47-agent evaluation earlier dropped the plates on COVERAGE, not licence — 25
of our 52 species have one and 27 do not, and a gallery that silently shows
half a collection asserts a completeness it does not have. That verdict stands
as a design constraint, not a prohibition: ship the plates, and make the 27
absences deliberate and visible rather than hidden.

WHAT THIS SCRIPT WILL NOT DO
----------------------------
It will not decide which bird a plate depicts. The manifest below is derived
from the corpus, and the corpus is honest about a thing that matters: in volume
24, accounts v24-014 (Song Thrush) and v24-015 (The Blackbird) BOTH point at
plate-3.jpg. One image, two birds, and the corpus cannot say whether the plate
shows both figures or whether the extractor attached it to the wrong neighbour.
Shipping it under one name would be the fabrication class this museum exists to
refuse, so this script fetches the file and writes NOTHING about who is in it.
`link_plates.py` does that, after a human or an agent has looked at the picture.

Politeness is the extractor's, unchanged: one desktop UA, 1.5 s between
requests, everything cached, no crawling — the URLs come from an extraction that
already happened.

    tools/jardine/fetch_plates.py            # fetch what is missing
    tools/jardine/fetch_plates.py --dry-run  # print the plan, request nothing
"""
import gzip
import io
import json
import os
import pathlib
import sys
import time
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
CORPUS = HERE / "corpus" / "corpus.json.gz"
JARDINE = ROOT / "web" / "public" / "jardine.json"
OUT = ROOT / "web" / "public" / "jardine"
CACHE = pathlib.Path(
    os.environ.get("JARDINE_PLATE_CACHE", str(HERE / "cache" / "plates"))
)

HOST = "https://www.c82.net"
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
POLITE_DELAY_S = 1.5

# The shipped box, read off the three plates committed before the drop:
# 19-vignette 654x700, 24-vignette 584x700, 24-11 1200x698. Portrait fills the
# height, landscape fills the width. Matching it is not aesthetics — a museum
# whose plates are three different sizes looks like a scrape.
BOX_W, BOX_H = 1200, 700
QUALITY = 82


def accounts(o, out=None):
    out = [] if out is None else out
    if isinstance(o, dict):
        for k, v in o.items():
            if k == "accounts" and isinstance(v, list):
                out += [x for x in v if isinstance(x, dict)]
            else:
                accounts(v, out)
    elif isinstance(o, list):
        for x in o:
            accounts(x, out)
    return out


# Errata subjects carry sci_name and jardine_plate but NO volume and NO title —
# and two of them are birds this garden has never recorded, so they have no
# species row to borrow a volume from. Same rule as every other join in this
# directory: hand-written, and each entry states what proves it. A programmatic
# guess here would file a plate under the wrong bird with total confidence.
ERRATA_ONLY = {
    "Bombycilla garrulus": dict(
        volume=24,
        jardine_title="The Bohemian Waxwing",
        # I guessed "The Waxen Chatterer" from memory of period usage and the
        # manifest promptly reported the plate as unplaceable. Read, don't
        # recall: corpus v24-066, binomial `Bombycilla garrula` — one letter off
        # the modern name, which is exactly the drift this museum exists to show.
        why="corpus account v24-066 'The Bohemian Waxwing', volume 24, plate-11; "
        "matches the 24-11.jpg committed before the plate drop",
    ),
    "Luscinia megarhynchos": dict(
        volume=24,
        jardine_title="The Nightingale",
        why="corpus account v24-030 'The Nightingale', volume 24, plate-7 — "
        "read before it was accepted",
    ),
}


# A THIRD CASE THE CORPUS CANNOT SEE. The claimant check below counts accounts
# anchored to a plate, which catches every plate two accounts point at. It does
# NOT catch a plate that ONE account anchors while the engraving figures two
# species — because nothing in the structured data records the second bird.
# Volume 40's plate III is that case: a single Common Teal account, and an
# engraving of the European teal beside the American one. Jardine says so
# himself, in prose this repo has already transcribed:
#
#   "In illustration, we have represented our native teal grouped with that from
#    America, which was long confounded with it."
#
# and then gives the marks to tell them apart — the white breast crescent and
# the absent white scapular line — which is exactly what the two figures show.
# There is no general check for this; it is found by reading. Entries here are
# reviewed findings, each with the evidence that produced it.
TWO_BIRD_SINGLE_ACCOUNT = {
    "40-3.jpg": dict(
        also="Anas carolinensis (American Green-winged Teal), swimming at left",
        we_caption="Anas crecca",
        evidence="jardine-accounts.json, volume 40 genus preamble para 7 and the "
        "Anas crecca account para 3; the two figures show a clean swap of both "
        "diagnostic marks",
    ),
}


def wants_a_plate(doc):
    """Every place in the museum that can PRINT a plate.

    There are two, and the first version of this function knew about one. The
    errata slips mount engravings through their own `subjects[].image`, entirely
    separately from `species[].plate_ref`, so deriving the manifest from the
    species list alone silently missed the Nightingale — whose slip has been
    rendering the empty-mount sliver this whole time while its plate sat one
    request away. If a third surface ever prints a plate it must be added here;
    nothing will catch that for you.
    """
    out = []
    by_sci = {s["sci_name"]: s for s in doc["species"]}
    for sp in doc["species"]:
        if sp.get("plate_ref"):
            out.append((sp["volume"], sp["plate_ref"], sp["jardine_title"], sp["sci_name"]))
    for e in doc.get("errata", []):
        for s in e.get("subjects", []):
            plate = s.get("jardine_plate")
            if not plate:
                continue
            sci = s["sci_name"]
            if sci in by_sci:
                sp = by_sci[sci]
                out.append((sp["volume"], plate, sp["jardine_title"], sci))
            elif sci in ERRATA_ONLY:
                k = ERRATA_ONLY[sci]
                out.append((k["volume"], plate, k["jardine_title"], sci))
            else:
                # Loud, not silent: an errata slip that wants a plate we cannot
                # place is a mount that will render empty forever.
                print(f"  ! {sci} wants {plate} but has no species row and no ERRATA_ONLY entry")
    return out


def manifest():
    """Every plate reachable from anywhere in this museum.

    Derived, never hardcoded: a hardcoded list goes stale the first time a new
    bird is added to jardine.json, and goes stale SILENTLY.
    """
    corpus = accounts(json.loads(gzip.open(CORPUS).read()))
    doc = json.loads(JARDINE.read_text())
    by_plate = {}
    unmatched = []
    seen = set()
    for volume, plate_ref, jardine_title, sci_name in wants_a_plate(doc):
        if (volume, plate_ref, sci_name) in seen:
            continue
        seen.add((volume, plate_ref, sci_name))
        sp = {
            "volume": volume,
            "plate_ref": plate_ref,
            "jardine_title": jardine_title,
            "sci_name": sci_name,
        }
        hits = [
            a
            for a in corpus
            if a["volume"] == sp["volume"]
            and a.get("plate_ref") == sp["plate_ref"]
            and a["jardine_title"] == sp["jardine_title"]
        ]
        if not hits or not hits[0].get("plate"):
            unmatched.append(sp["sci_name"])
            continue
        p = hits[0]["plate"]
        # {volume}-{plate_ref minus the "plate-" prefix}.jpg — the convention the
        # three committed files already use (24-11.jpg, 24-vignette.jpg).
        stem = sp["plate_ref"].removeprefix("plate-")
        name = f"{sp['volume']}-{stem}.jpg"
        # THE CLAIMANT COUNT MUST COME FROM THE CORPUS, NOT FROM jardine.json.
        #
        # My first version counted claimants among OUR 52 species, and that
        # guard cannot fail on the case it exists for. Volume 34's plate XV
        # figures a Spotted Sandpiper beside a Common Sandpiper — the plate's
        # own legend literally reads "Spotted (Left), Common (Right)" — but
        # Actitis macularius is a Nearctic vagrant this London garden never
        # records, so it was filtered out BEFORE the manifest was built. One
        # claimant survived, the guard passed, and the plate was cleared to be
        # captioned "Common Sandpiper" with a different species filling its
        # foreground. Volume 40's plate III is the same story: Jardine drew the
        # European Teal beside the American one deliberately, and says so in
        # prose this repo has already transcribed.
        #
        # The guard was blind to precisely the plates where a co-claimant is a
        # bird this garden does not hear — which is most of them, because the
        # garden hears 52 species and the corpus holds 718 accounts. Counting
        # in the corpus is the only version of this check that can fire.
        corpus_claimants = [
            {
                "account_id": a["account_id"],
                "title": a["jardine_title"],
                "binomial": a.get("jardine_binomial"),
            }
            for a in corpus
            if a["volume"] == sp["volume"] and a.get("plate_ref") == sp["plate_ref"]
        ]
        rec = by_plate.setdefault(
            name,
            {
                "file": name,
                "url": HOST + p["image"],
                "src_w": p["w"],
                "src_h": p["h"],
                "title": p.get("title"),
                "legend": p.get("legend"),
                "claimants": [],
                "corpus_claimants": corpus_claimants,
            },
        )
        rec["claimants"].append(
            {"sci_name": sp["sci_name"], "jardine_title": sp["jardine_title"]}
        )
    return by_plate, unmatched


def fetch(url):
    """Cached GET. A cache hit costs no request and no delay."""
    key = CACHE / url.rsplit("/naturalists-library/", 1)[-1].replace("/", "_")
    if key.exists():
        return key.read_bytes(), True
    key.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        body = r.read()
    key.write_bytes(body)
    return body, False


def shrink(raw):
    """Fit inside the box, re-encode, return (bytes, w, h).

    Refuses anything that is not a decodable JPEG — a 404 page saved under a
    .jpg name is exactly the sort of thing that ships looking like an image and
    renders as a broken frame on a wall nobody is standing in front of.
    """
    from PIL import Image

    im = Image.open(io.BytesIO(raw))
    if im.format != "JPEG":
        raise ValueError(f"not a JPEG, got {im.format!r}")
    im = im.convert("RGB")
    im.thumbnail((BOX_W, BOX_H), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=QUALITY, optimize=True, progressive=True)
    return buf.getvalue(), im.width, im.height


def main():
    dry = "--dry-run" in sys.argv
    plates, unmatched = manifest()
    OUT.mkdir(parents=True, exist_ok=True)

    todo = [p for p in plates.values() if not (OUT / p["file"]).exists()]
    have = len(plates) - len(todo)
    print(f"{len(plates)} plates reachable from jardine.json · {have} present · {len(todo)} to fetch")
    if unmatched:
        print(f"  ! {len(unmatched)} species claim a plate_ref with no corpus plate: {', '.join(unmatched)}")
    for p in sorted(plates.values(), key=lambda x: x["file"]):
        if len(p["corpus_claimants"]) > 1:
            who = " · ".join(f"{c['title']} ({c['binomial']})" for c in p["corpus_claimants"])
            mine = ", ".join(c["sci_name"] for c in p["claimants"])
            print(f"  ! SHARED PLATE {p['file']}: the CORPUS anchors {len(p['corpus_claimants'])} accounts here")
            print(f"      on the plate: {who}")
            print(f"      we caption:   {mine}")
            if p["legend"]:
                print(f"      plate legend: {p['legend']!r}")
            print("      -> a single-species caption asserts something false about the other bird")
        elif p["file"] in TWO_BIRD_SINGLE_ACCOUNT:
            k = TWO_BIRD_SINGLE_ACCOUNT[p["file"]]
            print(f"  ! TWO-BIRD PLATE {p['file']}: one account, two species figured")
            print(f"      also on the plate: {k['also']}")
            print(f"      we caption:        {k['we_caption']}")
            print(f"      found by reading:  {k['evidence']}")

    # A reviewed finding that no longer matches a shipped plate is a stale note,
    # and a stale note about provenance is worse than none.
    for f in TWO_BIRD_SINGLE_ACCOUNT:
        if f not in plates:
            print(f"  ! STALE: TWO_BIRD_SINGLE_ACCOUNT names {f}, which this manifest does not reach")

    if dry:
        for p in sorted(todo, key=lambda x: x["file"]):
            print(f"  would GET {p['url']}  ({p['src_w']}x{p['src_h']})")
        return 0

    out_manifest, failed = [], []
    for i, p in enumerate(sorted(todo, key=lambda x: x["file"]), 1):
        try:
            raw, cached = fetch(p["url"])
            body, w, h = shrink(raw)
        except Exception as e:  # noqa: BLE001 — report every failure, skip none
            print(f"  [{i}/{len(todo)}] FAILED {p['file']}: {e}")
            failed.append((p["file"], str(e)))
            continue
        (OUT / p["file"]).write_bytes(body)
        out_manifest.append({**{k: p[k] for k in ("file", "url", "src_w", "src_h")}, "w": w, "h": h})
        print(
            f"  [{i}/{len(todo)}] {p['file']:<18} {p['src_w']}x{p['src_h']} -> {w}x{h}"
            f"  {len(body)/1024:5.0f} KB{'  (cached)' if cached else ''}"
        )
        if not cached and i < len(todo):
            time.sleep(POLITE_DELAY_S)

    print(f"\nwrote {len(out_manifest)} · failed {len(failed)}")
    for f, e in failed:
        print(f"  FAILED {f}: {e}")
    # Non-zero on ANY failure: a partial plate set that reports success is how a
    # gallery ends up with holes nobody knows about.
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
