#!/usr/bin/env python3
"""creamkey — fast deterministic cutout for kachō-e illustrations on a flat
cream ground. No 1GB matting model: the bird is rendered on a known flat ground
(see prompt.template.md), so a corner-seeded flood-fill keys it cleanly.

Used by the auto-gen pipeline (pregen.py renders on cream -> creamkey cuts it).
Reconciler-endorsed over BiRefNet for FRESH cream-ground renders (RELIABILITY +
ARCHITECTURE docs, _plan/auto-gen-watcher/). Falls back gracefully: if the result
looks wrong (almost-everything or almost-nothing keyed) it returns a nonzero exit
so the caller can reject + mark the species failed (the QA gate).

Usage:  python3 creamkey.py SRC.png DST.png [--thresh 46]
Deps:   Pillow only (stdlib otherwise).
"""
from __future__ import annotations
import sys
import argparse
from PIL import Image, ImageDraw, ImageChops, ImageFilter

SENT = (255, 0, 255)  # sentinel colour for the keyed background


def creamkey(src: str, dst: str, thresh: int = 46) -> float:
    """Cut the flat cream ground from `src`, write RGBA `dst`.
    Returns the opaque fraction of the (pre-crop) frame, for a QA gate.
    """
    im = Image.open(src).convert("RGB")
    w, h = im.size
    work = im.copy()
    # Flood-fill the background from light border seeds (connected-from-edge ⇒
    # never punches holes in the bird). Only seed where the border looks cream.
    seeds = [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3),
             (w // 2, 2), (w // 2, h - 3), (2, h // 2), (w - 3, h // 2)]
    for s in seeds:
        p = im.getpixel(s)
        if sum(p) / 3 > 150:
            ImageDraw.floodfill(work, s, SENT, thresh=thresh)
    # Sentinel pixels -> transparent (fast point ops, no per-pixel Python loop).
    R, G, B = work.split()
    mR = R.point(lambda v: 255 if v == 255 else 0)
    mG = G.point(lambda v: 255 if v == 0 else 0)
    mB = B.point(lambda v: 255 if v == 255 else 0)
    sent = ImageChops.multiply(ImageChops.multiply(mR, mG), mB)
    alpha = ImageChops.invert(sent)                       # 0 bg, 255 bird
    opaque_frac = sum(1 for a in alpha.getdata() if a > 10) / float(w * h)
    alpha = alpha.filter(ImageFilter.MinFilter(3))        # erode 1px -> no halo
    alpha = alpha.filter(ImageFilter.GaussianBlur(0.7))   # feather
    out = im.convert("RGBA")
    out.putalpha(alpha)
    bbox = alpha.getbbox()
    if bbox:
        m = int(0.02 * max(w, h))
        l, t, r, b = bbox
        out = out.crop((max(0, l - m), max(0, t - m), min(w, r + m), min(h, b + m)))
    out.save(dst)
    return opaque_frac


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--thresh", type=int, default=46)
    # QA gate bounds: a real bird occupies a sane slice of the frame. Outside
    # this range the key almost certainly failed (full-frame or near-empty).
    ap.add_argument("--min-frac", type=float, default=0.015)
    ap.add_argument("--max-frac", type=float, default=0.75)
    a = ap.parse_args()
    frac = creamkey(a.src, a.dst, a.thresh)
    ok = a.min_frac <= frac <= a.max_frac
    print(f"creamkey {a.dst}: opaque={frac*100:.1f}% -> {'OK' if ok else 'REJECT (QA gate)'}")
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
