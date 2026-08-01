#!/usr/bin/env python3
"""Belkins BirdNET - rebuild the collage silhouette masks from the cutouts.

Step 3 of the illustration pipeline (after pregen.py and cutout.py).

The collage packs birds by their actual silhouette, not bounding boxes,
so the frontend ships a tiny 1-bit mask per illustration. This reads every
cutout in avian/assets/illustrations/ and writes BOTH front ends:

  * avian/frontend/apt.js       -- the legacy collage, tables inlined
  * web/public/data/{masks,dims}.json -- the React museum, fetched at boot

WHY BOTH. Until 2026-08-01 this script wrote apt.js ONLY, while
deploy-christina.sh ran it on every deploy. The museum's masks.json had
therefore not been regenerated since it was first created (mtime 2026-06-30)
and had drifted to 249 entries against 250 perched illustrations. The one it
lacked was `apus-apus` -- Common Swift, a real bird at this London station --
so the Swift packed against a RECTANGLE while the legacy UI packed it
correctly. A deploy step that maintains only the surface being retired is
worse than no deploy step: it keeps the old thing accurate and lets the new
one rot.

PERCHED ONLY, DELIBERATELY, for the museum. web/src/data.ts calls
`loadMask(slug, ar)` with the BASE slug -- never `slug + '-2'` -- so a flight
tile looks up the perched mask and sizes its box by FLIGHT_ASPECT instead
(collage.ts:74). Emitting the 250 `-2` masks would therefore add ~276 KB to a
file on the first-paint path that NOTHING reads, against the measured 11.5x
first-load reduction in 6451993. If the renderer ever keys flight masks by
`-2`, pass --include-flight; the capability exists, the cost does not.
apt.js is unaffected by that choice: it has always carried both poses.

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
    ap.add_argument("--web-data", type=Path,
                    default=here.parent / "web" / "public" / "data",
                    help="React museum data dir (default: web/public/data/)")
    ap.add_argument("--include-flight", action="store_true",
                    help="Also emit -2 flight masks to the museum JSON. Off by "
                         "default: nothing reads them and they cost ~276KB on "
                         "the first-paint path (see module docstring).")
    ap.add_argument("--check", action="store_true",
                    help="Report counts and don't write anything")
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

    # The museum. Perched-only unless asked otherwise -- see the module
    # docstring for why emitting -2 here would be 276KB nothing reads.
    web_dims, web_masks = dims, masks
    if not args.include_flight:
        web_dims = {k: v for k, v in dims.items() if not k.endswith("-2")}
        web_masks = {k: v for k, v in masks.items() if not k.endswith("-2")}

    args.web_data.mkdir(parents=True, exist_ok=True)
    for name, table in (("dims.json", web_dims), ("masks.json", web_masks)):
        dest = args.web_data / name
        # Atomic: a half-written masks.json is a museum that packs every bird
        # as a rectangle, and it would be served the moment it appeared.
        tmp = dest.with_suffix(dest.suffix + ".tmp")
        tmp.write_text(json.dumps(table, separators=(",", ":"), sort_keys=True))
        tmp.replace(dest)
        print(f"wrote {dest} ({len(table)} entries, {dest.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
