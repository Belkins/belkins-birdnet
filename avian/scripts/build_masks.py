#!/usr/bin/env python3
"""Belkins BirdNET - rebuild the collage silhouette masks from the cutouts.

Step 3 of the illustration pipeline (after pregen.py and cutout.py).

The collage packs birds by their actual silhouette, not bounding boxes,
so the frontend ships a tiny 1-bit mask per illustration inlined in
apt.js. This reads every cutout in avian/assets/illustrations/ and
rewrites the DIMS and MASKS tables in avian/frontend/apt.js:

    DIMS[slug]  = [w, h]  aspect, scaled so the long side is 560
    MASKS[slug] = {w, h, bits}  silhouette downscaled to <=93px, 1-bit
                  packed MSB-first row-major, base64. A bit is 1 where
                  the cutout is opaque (alpha > 127). This is exactly
                  what loadMask() in apt.js decodes.

Run after changing the illustration set, then bump SKETCH_VERSION and
IMG_VERSION in apt.js so browsers drop their cached copies.

Usage:
    python3 build_masks.py            # rewrite apt.js in place
    python3 build_masks.py --check    # report only, don't write
"""
from __future__ import annotations
import argparse
import base64
import json
import re
import sys
from pathlib import Path

DIM_MAX = 560   # long side of the stored aspect
MASK_MAX = 93   # long side of the stored silhouette
ALPHA_ON = 127  # opaque above this -> silhouette bit set


def build_tables(illus_dir: Path):
    """Return (dims, masks) dicts keyed by slug, in sorted order."""
    from PIL import Image
    dims, masks = {}, {}
    pngs = sorted(p for p in illus_dir.glob("*.png")
                  if re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", p.stem))
    for p in pngs:
        slug = p.stem
        im = Image.open(p).convert("RGBA")
        w, h = im.size
        scale = DIM_MAX / max(w, h)
        dims[slug] = [round(w * scale), round(h * scale)]

        ms = MASK_MAX / max(w, h)
        mw, mh = max(1, round(w * ms)), max(1, round(h * ms))
        alpha = im.getchannel("A").resize((mw, mh), Image.LANCZOS)
        px = alpha.load()
        bits = bytearray((mw * mh + 7) // 8)
        for y in range(mh):
            for x in range(mw):
                if px[x, y] > ALPHA_ON:
                    i = y * mw + x
                    bits[i >> 3] |= 1 << (7 - (i & 7))
        masks[slug] = {"w": mw, "h": mh, "bits": base64.b64encode(bytes(bits)).decode()}
    return dims, masks


def replace_decl(src: str, name: str, value: str) -> str:
    """Replace `var <name> = {...};` (single line) with the new value."""
    pat = re.compile(r"  var " + name + r" = \{.*?\};")
    repl = f"  var {name} = {value};"
    new, n = pat.subn(lambda _m: repl, src, count=1)
    if n != 1:
        raise SystemExit(f"error: could not find `var {name} = {{...}};` in apt.js")
    return new


def main() -> int:
    here = Path(__file__).resolve().parents[1]
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--illustrations", type=Path, default=here / "assets" / "illustrations",
                    help="Cutout directory (default: avian/assets/illustrations/)")
    ap.add_argument("--apt", type=Path, default=here / "frontend" / "apt.js",
                    help="Frontend file to patch (default: avian/frontend/apt.js)")
    ap.add_argument("--check", action="store_true",
                    help="Report counts and don't write apt.js")
    args = ap.parse_args()

    dims, masks = build_tables(args.illustrations)
    perched = sum(1 for k in dims if not k.endswith("-2"))
    flight = sum(1 for k in dims if k.endswith("-2"))
    print(f"built {len(dims)} masks ({perched} perched + {flight} flight) "
          f"from {args.illustrations}")
    if not dims:
        print("error: no cutouts found", file=sys.stderr)
        return 1

    dims_json = json.dumps(dims, separators=(",", ":"))
    masks_json = json.dumps(masks, separators=(",", ":"))

    if args.check:
        src = args.apt.read_text()
        cur = json.loads(re.search(r"var DIMS = (\{.*?\});", src).group(1))
        added = sorted(set(dims) - set(cur))
        removed = sorted(set(cur) - set(dims))
        print(f"apt.js currently has {len(cur)} entries; "
              f"+{len(added)} new, -{len(removed)} removed")
        if added:
            print("  new:", ", ".join(added[:8]) + (" ..." if len(added) > 8 else ""))
        if removed:
            print("  gone:", ", ".join(removed[:8]) + (" ..." if len(removed) > 8 else ""))
        return 0

    src = args.apt.read_text()
    src = replace_decl(src, "DIMS", dims_json)
    src = replace_decl(src, "MASKS", masks_json)
    args.apt.write_text(src)
    print(f"patched {args.apt}\nremember to bump SKETCH_VERSION + IMG_VERSION in apt.js")
    return 0


if __name__ == "__main__":
    sys.exit(main())
