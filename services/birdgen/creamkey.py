#!/usr/bin/env python3
"""chromakey — fast deterministic cutout for kachō-e illustrations rendered on a
flat MAGENTA chroma screen (#FF00FF). No 1GB matting model: the bird is painted
on a known flat solid magenta ground (see prompt.template.md), so a single global
colour test + a connected-from-edge fill keys it cleanly — including the pale
birds (gulls, egrets, doves) that the old cream flood-fill used to eat.

Used by the auto-gen pipeline (pregen.py renders on magenta -> chromakey cuts it).
Falls back gracefully: if the result looks wrong (almost-everything or
almost-nothing keyed) the CLI returns a nonzero exit so the caller can reject +
mark the species failed (the QA gate).

Usage:  python3 creamkey.py SRC.png DST.png [--tol 60]
Deps:   Pillow only (stdlib otherwise).
"""
from __future__ import annotations
import argparse
from PIL import Image, ImageDraw, ImageChops, ImageFilter


def _kill_magenta_fringe(out: Image.Image, alpha: Image.Image) -> Image.Image:
    """Decontaminate the semi-transparent edge band: pull R and B down toward G
    so no magenta/purple halo survives on feathered edge pixels. Magenta is
    high-R + high-B + low-G, so clamping R and B to ~G neutralises the tint while
    leaving fully-opaque interior pixels untouched."""
    R, G, B, A = out.split()
    g_plus = G.point(lambda v: v + 20 if v + 20 < 255 else 255)
    clean_R = ImageChops.darker(R, g_plus)   # min(R, G+20)
    clean_B = ImageChops.darker(B, g_plus)   # min(B, G+20)
    band = alpha.point(lambda v: 255 if 0 < v < 255 else 0)
    R = Image.composite(clean_R, R, band)
    B = Image.composite(clean_B, B, band)
    return Image.merge("RGBA", (R, G, B, A))


def chromakey(src: str, dst: str, tol: int = 60) -> float:
    """Key the flat magenta ground out of `src`, write RGBA `dst`.
    Returns the opaque fraction of the (pre-crop) frame, for a QA gate.
    """
    im = Image.open(src).convert("RGB")
    w, h = im.size
    R, G, B = im.split()
    # Magenta ground = high R, low G, high B. A single global point-op test (no
    # per-pixel Python loop, no tonal gradient for a flood to stall on).
    lo, hi = tol, 255 - tol
    m_R = R.point(lambda v: 255 if v >= hi else 0)
    m_G = G.point(lambda v: 255 if v <= lo else 0)
    m_B = B.point(lambda v: 255 if v >= hi else 0)
    key = ImageChops.multiply(ImageChops.multiply(m_R, m_G), m_B)  # 255 = ground
    # Keep ONLY the ground connected to the frame edge: flood a scratch copy from
    # 8 border seeds so interior magenta specks can never punch holes in the bird.
    scratch = key.copy()
    seeds = [(1, 1), (w - 2, 1), (1, h - 2), (w - 2, h - 2),
             (w // 2, 1), (w // 2, h - 2), (1, h // 2), (w - 2, h // 2)]
    for s in seeds:
        if key.getpixel(s) == 255:
            ImageDraw.floodfill(scratch, s, 128)
    ground = scratch.point(lambda v: 255 if v == 128 else 0)
    alpha = ImageChops.invert(ground)                     # 255 = bird
    opaque_frac = sum(1 for a in alpha.getdata() if a > 10) / float(w * h)
    # Despeckle: drop stray opaque specks, erode the 1px key halo, feather.
    alpha = alpha.filter(ImageFilter.MedianFilter(3))
    alpha = alpha.filter(ImageFilter.MinFilter(3))        # erode 1px -> no halo
    alpha = alpha.filter(ImageFilter.GaussianBlur(0.6))   # feather
    out = im.convert("RGBA")
    out = _kill_magenta_fringe(out, alpha)                # neutralise edge tint
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
    ap.add_argument("--tol", type=int, default=60)
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
