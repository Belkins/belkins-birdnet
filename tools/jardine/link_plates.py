#!/usr/bin/env python3
"""Attach the fetched engravings to the birds, and refuse to do it carelessly.

fetch_plates.py downloads files and says nothing about their contents, by
design. This is the other half: it writes `image` / `image_w` / `image_h` onto
the species and errata records so the museum can print them — and it is built so
that the one dangerous outcome, a plate captioned with a bird that is not the
bird in the picture, is structurally impossible rather than merely discouraged.

THREE RULES, EACH FROM A REAL FAILURE FOUND THIS SESSION.

1. A SHARED PLATE MUST BE ADJUDICATED OR THE SCRIPT FAILS. The corpus anchors
   more than one account to several of these engravings, because Jardine drew
   two birds on one sheet. Volume 34's plate XV carries its own legend —
   "Spotted (Left), Common (Right)" — and figures a Spotted Sandpiper beside the
   Common Sandpiper we claim. Volume 24's plate VIII shows a flame-crested
   Firecrest above a yellow-crested Goldcrest. Captioning either with one name
   puts a different species in the foreground of the label.

   So: every plate the corpus reports as shared must appear in ADJUDICATED
   below, with what is on it and what proved it. A missing entry is exit 2, not
   a warning. Warnings get skimmed.

2. THE DIMENSIONS MUST DESCRIBE THE SHIPPED FILE. The three plates committed
   before the drop carry the SOURCE dimensions (3330x1936) while the file on
   disk is 1200x698. The aspect ratio happens to match so nothing broke, but the
   numbers are false, and a museum whose whole argument is provenance should not
   state a measurement it did not take. Read every file.

3. AN ATTRIBUTION THAT RESTS ON THE INDEX IS NOT AN IDENTIFICATION. Plate XXIII
   is the Wren's by every provenance test — the volume's plate map is strictly
   monotonic and exactly one account claims it — but the engraver drew a longer
   tail and a more dagger-like bill than a Wren has, and a blind identification
   declined to name it. That plate ships with attribution="plate-list", so the
   caption can say the volume assigns it rather than asserting the picture shows
   it. The distinction is the difference between a citation and a claim.

    tools/jardine/link_plates.py --dry-run
    tools/jardine/link_plates.py
"""
import gzip
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
CORPUS = HERE / "corpus" / "corpus.json.gz"
JARDINE = ROOT / "web" / "public" / "jardine.json"
PLATES = ROOT / "web" / "public" / "jardine"
REL = "jardine/"

# Every plate the corpus anchors to more than one account, plus the one that a
# single account anchors while figuring two species. `also` is what ELSE is in
# the picture; `evidence` is what proved it. Nothing here is inferred.
#
# `figures` lists EVERY bird on the sheet, not "the other one". The first draft
# stored only the second bird and each species subtracted itself, which left the
# Blackbird holding a two-bird plate with nothing recorded about the Song Thrush
# standing behind it — the exact asymmetry the whole adjudication exists to
# prevent, reintroduced by the shape of the data.
ADJUDICATED = {
    "24-3.jpg": dict(
        figures=[
            dict(sci_name="Turdus merula", common="Blackbird", where="below, foreground"),
            dict(sci_name="Turdus philomelos", common="Song Thrush", where="above, rear"),
        ],
        evidence="corpus vol 24 anchors v24-014 (Song Thrush, Merula musica) and "
        "v24-015 (The Blackbird, Merula vulgaris); viewed directly — a blue-black "
        "bird with a lemon-yellow bill and yellow orbital ring below, a "
        "cream-breasted bird with crisp dark drop-spots above",
    ),
    "24-8.jpg": dict(
        figures=[
            dict(sci_name="Regulus ignicapilla", common="Firecrest", where="above"),
            dict(sci_name="Regulus regulus", common="Goldcrest", where="below"),
        ],
        evidence="corpus vol 24 anchors 'Common Gold-Crest' (Regulus auricapillus) "
        "and 'The Fire-Crowned Gold-Crest' (Regulus ignicapillus); viewed directly "
        "— the upper bird's crest is flame-orange, the lower bird's plain yellow",
    ),
    "34-15.jpg": dict(
        figures=[
            dict(sci_name="Actitis macularius", common="Spotted Sandpiper", where="left"),
            dict(sci_name="Actitis hypoleucos", common="Common Sandpiper", where="right"),
        ],
        evidence="the plate's OWN engraved legend, in the corpus record: "
        "'Spotted (Left), Common (Right)'; corpus vol 34 anchors v34-064 (The "
        "Common Totanus) and v34-065 (The Spotted Totanus)",
    ),
    "40-3.jpg": dict(
        figures=[
            dict(
                sci_name="Anas carolinensis",
                common="American Green-winged Teal",
                where="left, swimming",
            ),
            dict(sci_name="Anas crecca", common="Common Teal", where="right, on the stone"),
        ],
        evidence="Jardine says so in prose this repo transcribed — vol 40 genus "
        "preamble: 'we have represented our native teal grouped with that from "
        "America, which was long confounded with it' — and then gives the marks: "
        "the white breast crescent and the absent white scapular line",
    ),
}

# Plates whose bird is established by the volume's plate list rather than by the
# picture. They print as a citation, never as an identification.
PLATE_LIST_ONLY = {
    "24-23.jpg": "a blind identification declined to name the bird: the engraver "
    "drew a longer tail and a more dagger-like bill than a Wren has. The volume's "
    "plate map is strictly monotonic and exactly one account claims plate XXIII "
    "(v24-118, The Common Wren), and the domed side-entrance nest is a Wren's — "
    "but the picture does not identify itself, so the museum cites rather than asserts.",
}


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


def dims(path):
    from PIL import Image

    with Image.open(path) as im:
        return im.width, im.height


def plate_file(volume, plate_ref):
    return f"{volume}-{plate_ref.removeprefix('plate-')}.jpg"


def main():
    dry = "--dry-run" in sys.argv
    corpus = accounts(json.loads(gzip.open(CORPUS).read()))
    doc = json.loads(JARDINE.read_text())

    shared = {}
    for a in corpus:
        if a.get("plate_ref"):
            shared.setdefault((a["volume"], a["plate_ref"]), []).append(a)

    wrote, cited, dual, missing, unadjudicated = [], [], [], [], []

    for sp in doc["species"]:
        ref = sp.get("plate_ref")
        if not ref:
            continue
        name = plate_file(sp["volume"], ref)
        path = PLATES / name
        if not path.exists():
            missing.append((sp["sci_name"], name))
            continue

        claimants = shared.get((sp["volume"], ref), [])
        needs = len(claimants) > 1 or name in ADJUDICATED
        if needs and name not in ADJUDICATED:
            unadjudicated.append((sp["sci_name"], name, [c["jardine_title"] for c in claimants]))
            continue

        w, h = dims(path)
        sp["image"] = REL + name
        sp["image_w"] = w
        sp["image_h"] = h
        sp["plate_attribution"] = "plate-list" if name in PLATE_LIST_ONLY else "depicted"
        if name in PLATE_LIST_ONLY:
            sp["plate_note"] = PLATE_LIST_ONLY[name]
            cited.append(sp["sci_name"])
        adj = ADJUDICATED.get(name)
        if adj:
            others = [x for x in adj["figures"] if x["sci_name"] != sp["sci_name"]]
            me = [x for x in adj["figures"] if x["sci_name"] == sp["sci_name"]]
            # Every adjudicated plate must place the bird we are captioning. If
            # it does not, the ledger and the crosswalk disagree about who is in
            # the picture, which is the whole thing we are guarding against.
            if not me:
                unadjudicated.append((sp["sci_name"], name, [f["sci_name"] for f in adj["figures"]]))
                continue
            if others:
                sp["plate_also"] = others
                sp["plate_where"] = me[0]["where"]
                dual.append(sp["sci_name"])
        wrote.append(sp["sci_name"])

    # The errata mounts, which were rendering the empty-mount sliver for files
    # that have been on disk the whole time.
    by_sci = {s["sci_name"]: s for s in doc["species"]}
    ERRATA_VOL = {"Bombycilla garrulus": 24, "Luscinia megarhynchos": 24}
    filled = []
    for e in doc.get("errata", []):
        for s in e.get("subjects", []):
            ref = s.get("jardine_plate")
            if not ref or s.get("image"):
                continue
            vol = by_sci[s["sci_name"]]["volume"] if s["sci_name"] in by_sci else ERRATA_VOL.get(s["sci_name"])
            if vol is None:
                continue
            name = plate_file(vol, ref)
            path = PLATES / name
            if not path.exists():
                missing.append((s["sci_name"], name))
                continue
            if len(shared.get((vol, ref), [])) > 1 and name not in ADJUDICATED:
                unadjudicated.append((s["sci_name"], name, []))
                continue
            # THE SAME MEMBERSHIP CHECK THE SPECIES PATH MAKES. Being IN the
            # ledger is not clearance for any bird that asks: the ledger says
            # WHICH birds are on the sheet. Without this, "24-3.jpg is
            # adjudicated" was read as "24-3.jpg may be mounted under whoever
            # names it", and an errata subject could hang a two-bird engraving
            # that does not contain it -- exit 0, caption confident, wrong bird.
            adj = ADJUDICATED.get(name)
            if adj and not any(f["sci_name"] == s["sci_name"] for f in adj["figures"]):
                unadjudicated.append(
                    (s["sci_name"], name, [f["sci_name"] for f in adj["figures"]])
                )
                continue
            w, h = dims(path)
            s["image"], s["image_w"], s["image_h"] = REL + name, w, h
            filled.append(f"slip {e['no']} · {s['sci_name']}")

    # Correct the three pre-drop records that state SOURCE dimensions for a file
    # that ships at a different size.
    corrected = []
    for e in doc.get("errata", []):
        for s in e.get("subjects", []):
            if not s.get("image"):
                continue
            path = ROOT / "web" / "public" / s["image"]
            if not path.exists():
                continue
            w, h = dims(path)
            if (s.get("image_w"), s.get("image_h")) != (w, h):
                corrected.append(f"{s['sci_name']} {s.get('image_w')}x{s.get('image_h')} -> {w}x{h}")
                s["image_w"], s["image_h"] = w, h

    print(f"plates linked to {len(wrote)} species · {len(dual)} carry a second bird · {len(cited)} cited from the plate list")
    for n in dual:
        print(f"    dual: {n}")
    for n in cited:
        print(f"    cited: {n}")
    if filled:
        print(f"errata mounts filled: {len(filled)}")
        for f in filled:
            print(f"    {f}")
    if corrected:
        print(f"dimensions corrected to the shipped file: {len(corrected)}")
        for c in corrected:
            print(f"    {c}")
    if missing:
        print(f"MISSING FILES: {len(missing)}")
        for sci, n in missing:
            print(f"    {sci} wants {n}")

    # FAIL CLOSED. An unadjudicated shared plate is the one outcome that puts a
    # wrong name under a picture, so it stops the run rather than warning.
    if unadjudicated:
        print(f"\nREFUSING TO WRITE — {len(unadjudicated)} shared plate(s) not adjudicated:")
        for sci, n, who in unadjudicated:
            print(f"    {n} (claimed for {sci}) — corpus accounts: {', '.join(who) or 'see corpus'}")
        print("Add an ADJUDICATED entry with the evidence, or remove the plate_ref.")
        return 2

    # EMIT THE SHARING FACT ITSELF, derived from the corpus, so the web tests can
    # check it without the corpus. Without this, a test can only notice a shared
    # plate when TWO OF OUR OWN SPECIES hang the same file — and the dangerous
    # case is precisely the one where the co-occupant is a bird this garden never
    # hears, so only one of ours hangs it and the check sees nothing to check.
    # That is the third time this session that reasoning from our 52 species
    # instead of the corpus produced a guard blind to its own motivating case.
    # KEYED THE WAY THE SPECIES RECORDS ARE. ADJUDICATED is keyed by bare
    # filename; every `image` in jardine.json is REL-prefixed. Emitting the bare
    # key made every lookup in the web test miss, so its loop body never ran and
    # it passed vacuously on two mutations that should have failed it. A guard
    # whose keys do not match the data it guards is not a weaker guard, it is no
    # guard at all.
    doc["plates_shared"] = {
        REL + image: adj["figures"] for image, adj in sorted(ADJUDICATED.items())
    }

    if dry:
        print("\n--dry-run: nothing written")
        print(f"would record {len(doc['plates_shared'])} shared plates for the web tests")
        return 0
    JARDINE.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    print(f"\nwrote {JARDINE.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
