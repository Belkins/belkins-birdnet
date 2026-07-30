#!/usr/bin/env python3
"""webp_variants.py — build .webp siblings for the cutout plates.

WHY THIS EXISTS
---------------
A measured wall load on 2026-07-30 pulled 9,488,094 B of full-size PNG across the
13 species in the default 24h window — 93.3% of ALL first-load bytes — to draw
them into boxes roughly 130-190 CSS px wide. Nothing else on the box came close:
the entire JS/CSS/JSON payload was 690,437 B by comparison.

Re-encoding three real plates measured:

    Erithacus rubecula  878x848  1,238,784 B -> lossless 331,946 (26.8%) | q90 89,200 (7.2%)
    Carduelis carduelis 571x487    474,359 B -> lossless 140,098 (29.5%) | q90 37,146 (7.8%)
    Pica pica           634x575    609,285 B -> lossless 133,834 (22.0%) | q90 36,846 (6.0%)

DELIBERATELY NOT RESIZING
-------------------------
q90 at full resolution already removes ~93% of the bytes, and the plates are the
point of this museum: the popup shows them far larger than a wall tile, and a
high-dpi phone asks for 2-3x the CSS box. Downscaling to a tile-sized variant
would buy a few more percent and cost resolution we cannot get back without a
repaint. If a display-sized variant is ever wanted it belongs BESIDE this one,
negotiated separately — not as a replacement.

STALENESS IS HANDLED BY THE READER, NOT HERE
--------------------------------------------
cutout.php uses a .webp only when its mtime is >= the .png it stands for. So a
repaint/reclean that rewrites a plate instantly demotes the old variant and the
PNG is served until this script catches up. That is why this step is allowed to
be best-effort and must NEVER fail the nightly unit: falling back to the PNG is a
completely correct outcome, just a heavier one.

Alpha is preserved (these are background-removed cutouts; RGBA in, RGBA out).
"""

from __future__ import annotations

import argparse
import os
import sys

# NEVER resolve()/realpath() here — avian/scripts/ holds symlinks INTO
# services/birdgen/, and resolving would anchor on the wrong tree. See
# the architecture invariants.
HERE = os.path.dirname(os.path.abspath(__file__))

QUALITY_DEFAULT = 90


def _needs_build(png: str, webp: str) -> bool:
    """True when the variant is missing, empty, or older than its plate."""
    if not os.path.isfile(webp):
        return True
    try:
        p = os.stat(png)
        w = os.stat(webp)
    except OSError:
        return True
    # Mirrors cutout.php's guard exactly: a variant older than its plate is
    # stale, and a zero-byte one is a previous crash mid-write.
    return w.st_size <= 0 or w.st_mtime < p.st_mtime


def build(directory: str, quality: int, dry_run: bool) -> tuple[int, int, int, int]:
    """Returns (built, skipped, failed, bytes_saved)."""
    try:
        from PIL import Image
    except ImportError:
        print("webp_variants: Pillow is not importable — nothing done", file=sys.stderr)
        return (0, 0, 1, 0)

    if not os.path.isdir(directory):
        print(f"webp_variants: not a directory: {directory}", file=sys.stderr)
        return (0, 0, 1, 0)

    built = skipped = failed = saved = 0
    for name in sorted(os.listdir(directory)):
        if not name.lower().endswith(".png"):
            continue
        png = os.path.join(directory, name)
        if not os.path.isfile(png):
            continue
        webp = png[: -len(".png")] + ".webp"

        if not _needs_build(png, webp):
            skipped += 1
            continue
        if dry_run:
            print(f"  would build {os.path.basename(webp)}")
            built += 1
            continue

        # Write to a temp path in the SAME directory and rename, so a reader can
        # never observe a half-written variant (rename is atomic within a
        # filesystem). A partial .webp would be served as a broken image.
        tmp = webp + ".tmp"
        try:
            with Image.open(png) as im:
                im.load()
                if im.mode not in ("RGBA", "RGB"):
                    im = im.convert("RGBA")
                im.save(tmp, "WEBP", quality=quality, method=6)
            os.replace(tmp, webp)
            saved += max(0, os.path.getsize(png) - os.path.getsize(webp))
            built += 1
        except Exception as exc:  # noqa: BLE001 - best-effort by design
            failed += 1
            print(f"webp_variants: {name}: {exc}", file=sys.stderr)
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except OSError:
                pass

    return (built, skipped, failed, saved)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "dirs",
        nargs="*",
        default=None,
        help="directories of .png plates (default: the Pi's cutout cache)",
    )
    ap.add_argument("--quality", type=int, default=QUALITY_DEFAULT)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    dirs = args.dirs or [os.path.expanduser("~/BirdSongs/Extracted/cutouts")]

    total_built = total_failed = total_saved = 0
    for d in dirs:
        b, s, f, saved = build(d, args.quality, args.dry_run)
        total_built += b
        total_failed += f
        total_saved += saved
        print(
            f"webp_variants: {d}: built={b} skipped={s} failed={f} "
            f"saved={saved} bytes"
        )

    if total_saved:
        print(f"webp_variants: total saved {total_saved} bytes ({total_saved/1048576:.1f} MB)")

    # Exit non-zero ONLY so a human running it by hand sees trouble. nightly.sh
    # deliberately ignores this status: a missing variant is not a fault, it just
    # means the PNG is served.
    return 1 if total_failed and not total_built else 0


if __name__ == "__main__":
    raise SystemExit(main())
