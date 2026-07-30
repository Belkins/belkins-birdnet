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
    shared = [p for p in plates.values() if len(p["claimants"]) > 1]
    for p in shared:
        who = ", ".join(c["jardine_title"] for c in p["claimants"])
        print(f"  ! {p['file']} is claimed by {len(p['claimants'])} accounts ({who}) — link_plates.py must adjudicate")

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
