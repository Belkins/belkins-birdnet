#!/usr/bin/env python3
"""chromakey — fast deterministic cutout for kachō-e illustrations rendered on a
flat, UNIFORM studio ground (warm off-white / pale cream — see prompt.template.md).

No 1GB matting model and no hardcoded key colour: Gemini does NOT reliably paint a
clean flat magenta, so a fixed-colour test keyed nothing and left the whole frame
opaque. Instead we AUTO-DETECT the actual background from the four frame corners
(the prompt guarantees the bird never touches an edge, so the corners are always
pure ground), then a single global colour-distance test + a connected-from-edge
fill keys the ground cleanly — including pale birds (gulls, egrets, doves) that a
naive interior flood-fill used to eat.

Used by the auto-gen pipeline (pregen.py renders on the flat ground -> chromakey
cuts it). Falls back gracefully: if the result looks wrong (almost-everything or
almost-nothing keyed) the CLI returns a nonzero exit so the caller can reject +
mark the species failed (the QA gate).

Usage:  python3 creamkey.py SRC.png DST.png [--tol 42]
Deps:   Pillow only (stdlib otherwise).
"""
from __future__ import annotations
import argparse
from statistics import median
from PIL import Image, ImageChops, ImageDraw, ImageFilter


def _detect_bg(im: Image.Image, patch: int = 10) -> tuple[int, int, int]:
    """Auto-detect the flat ground colour by sampling the four frame corners.

    Take a ~patch×patch square from each corner, pool the pixels, and return the
    per-channel MEDIAN. The median across four corners is robust to one corner
    being contaminated (a wing tip intruding, a stray speck) — three clean
    corners still carry the vote."""
    w, h = im.size
    p = max(4, min(patch, w // 4, h // 4))
    boxes = [(0, 0, p, p), (w - p, 0, w, p), (0, h - p, p, h), (w - p, h - p, w, h)]
    rs: list[int] = []
    gs: list[int] = []
    bs: list[int] = []
    for box in boxes:
        for (r, g, b) in im.crop(box).getdata():
            rs.append(r)
            gs.append(g)
            bs.append(b)
    return (int(median(rs)), int(median(gs)), int(median(bs)))


def _ground_mask(im: Image.Image, bg: tuple[int, int, int], tol: int) -> Image.Image:
    """Binary L mask (255 = ground): pixels whose MAX per-channel distance to `bg`
    is <= tol. Built from global point-ops (no per-pixel Python loop): for each
    channel |chan - bg_c| via ImageChops.difference against a flat fill, threshold
    at tol, then AND the three channels together with multiply."""
    w, h = im.size
    R, G, B = im.split()

    def chan_mask(chan: Image.Image, c: int) -> Image.Image:
        flat = Image.new("L", (w, h), c)
        dist = ImageChops.difference(chan, flat)          # |chan - c|
        return dist.point(lambda v: 255 if v <= tol else 0)

    mR = chan_mask(R, bg[0])
    mG = chan_mask(G, bg[1])
    mB = chan_mask(B, bg[2])
    # multiply of 0/255 masks == logical AND -> 255 only where ALL channels close.
    return ImageChops.multiply(ImageChops.multiply(mR, mG), mB)


def chromakey(src: str, dst: str, tol: int = 42) -> float:
    """Key the flat auto-detected ground out of `src`, write RGBA `dst`.
    Returns the opaque fraction of the (pre-crop) frame, for a QA gate.
    """
    im = Image.open(src).convert("RGB")
    w, h = im.size
    bg = _detect_bg(im)
    ground_all = _ground_mask(im, bg, tol)

    # Keep ONLY the ground connected to the frame edge: flood a scratch copy from
    # 8 border seeds so interior light patches (a pale belly, a white cheek) can
    # never punch holes in the bird.
    scratch = ground_all.copy()
    seeds = [(1, 1), (w - 2, 1), (1, h - 2), (w - 2, h - 2),
             (w // 2, 1), (w // 2, h - 2), (1, h // 2), (w - 2, h // 2)]
    for s in seeds:
        if ground_all.getpixel(s) == 255:
            ImageDraw.floodfill(scratch, s, 128)
    ground = scratch.point(lambda v: 255 if v == 128 else 0)
    alpha = ImageChops.invert(ground)                     # 255 = bird

    # opaque fraction on the RAW alpha (pre-clean), for the QA band.
    on_mask = alpha.point(lambda v: 255 if v > 10 else 0)
    opaque_frac = on_mask.histogram()[255] / float(w * h)

    # Clean the alpha: drop stray opaque specks, erode the 1px key halo (this also
    # eats the outermost ground-contaminated ring, so no colour-specific fringe
    # kill is needed), then feather. Generic — works for any auto-detected ground.
    alpha = alpha.filter(ImageFilter.MedianFilter(3))     # despeckle
    alpha = alpha.filter(ImageFilter.MinFilter(3))        # erode 1px -> no halo
    alpha = alpha.filter(ImageFilter.GaussianBlur(0.6))   # feather

    out = im.convert("RGBA")
    out.putalpha(alpha)
    bbox = alpha.getbbox()
    if bbox:
        m = int(0.03 * max(w, h))
        l, t, r, b = bbox
        out = out.crop((max(0, l - m), max(0, t - m), min(w, r + m), min(h, b + m)))
    out.save(dst)
    return opaque_frac


# Back-compat alias: app.py does `from creamkey import creamkey`.
creamkey = chromakey


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--tol", type=int, default=42)
    # QA gate bounds: a real bird occupies a sane slice of the frame. Outside
    # this range the key almost certainly failed (full-frame or near-empty).
    ap.add_argument("--min-frac", type=float, default=0.015)
    ap.add_argument("--max-frac", type=float, default=0.75)
    a = ap.parse_args()
    frac = chromakey(a.src, a.dst, a.tol)
    ok = a.min_frac <= frac <= a.max_frac
    print(f"chromakey {a.dst}: opaque={frac*100:.1f}% -> {'OK' if ok else 'REJECT (QA gate)'}")
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
