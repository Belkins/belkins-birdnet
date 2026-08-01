#!/usr/bin/env python3
"""Belkins BirdNET - adversarial species-ID + anatomy check on illustrations.

An independent quality gate for the generated library. Each illustration
goes through a fresh Gemini Vision call that is NOT told the target
species: it's asked to identify the bird, count wings/legs/heads/tails,
and flag any twig, perch, or anatomical anomaly. The guess is then
compared to the intended species. This catches drift that passes a quick
visual review - a stylized bird that reads as the wrong species, an extra
wing, a stray perch the prompt said not to draw.

Results are appended to verify-results.csv (slug, pose, target, guess,
match, confidence, anatomy counts, flags).

Usage:
    export GEMINI_API_KEY='your-key'
    python3 verify.py --labels labels.txt                 # whole library
    python3 verify.py --labels labels.txt calypte-anna    # one slug
"""
from __future__ import annotations
import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# Vision model for the adversarial verify gate. Env-overridable like
# pregen's AV_GEN_MODEL: verify_one fails OPEN on error, so a deprecated model
# id here silently disarms the gate — bump AV_VERIFY_MODEL on Railway instead
# of redeploying (and watch /health's verify_fail_open_since_boot).
GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    # `or` so a BLANK Railway variable falls back too (a blank here would 404
    # every verify call -> the gate fails open on every render, silently).
    "%s:generateContent" % (os.environ.get("AV_VERIFY_MODEL") or "gemini-2.5-flash")
)

VERIFY_PROMPT = """You are a rigorous ornithologist examining a stylized kachō-e woodblock-style bird illustration. The bird in the image is intended to be a {target_com} ({target_sci}).

Analyze the image and respond ONLY with a valid JSON object (no other text, no markdown fences) with these fields:

{{
  "guessed_species_sci": "<your best guess at the scientific name, Latin binomial, e.g. 'Calypte anna'>",
  "guessed_species_com": "<your best guess at the English common name>",
  "guess_confidence": "<low | medium | high>",
  "matches_target": <true if your guess matches {target_sci} or {target_com}, otherwise false>,
  "wing_count": <integer number of wings visible>,
  "leg_count": <integer number of legs/feet visible>,
  "head_count": <integer number of heads>,
  "tail_count": <integer number of tails>,
  "has_stick_or_perch": <true if any twig, stick, branch, perch, leaf, or substrate is visible in the image; false if the bird floats alone>,
  "whole_bird": <true if the ENTIRE bird is visible as one complete figure (head, body, wing(s), tail); false if the image shows only a fragment - e.g. a lone wing, a severed part, or a bird whose body is missing or transparent>,
  "diagnostic_features_present": "<comma-separated list of species-diagnostic field marks you can see, e.g. 'red cap, pink breast, streaked back, conical bill'>",
  "diagnostic_features_missing": "<features the species SHOULD have but you don't see, or empty string if all match>",
  "anatomy_issues": "<any anomalies (extra wings, missing feet, deformed beak), or empty string>",
  "style_assessment": "<one of: 'true kachō-e' | 'kachō-e-influenced watercolor' | 'field guide illustration' | 'photographic'>"
}}

Be honest. If the bird looks more like a different species, say so. If the anatomy has issues, say so. Empty strings for fields where there's nothing to report."""


def slugify(sci: str) -> str:
    """Match avian/frontend/apt.js slugify() exactly."""
    return re.sub(r"[^a-z0-9]+", "-", sci.lower()).strip("-")


def load_labels(path: Path) -> dict[str, tuple[str, str]]:
    """Parse a Sci|Com label file into {slug: (sci, com)}."""
    out = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "|" not in line:
            continue
        sci, com = (s.strip() for s in line.split("|", 1))
        out[slugify(sci)] = (sci, com)
    return out


def call_gemini(api_key: str, parts: list) -> dict:
    payload = {"contents": [{"parts": parts}]}
    req = urllib.request.Request(
        GEMINI_URL,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
        method="POST",
    )
    backoff = 4.0
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < 3:
                time.sleep(backoff)
                backoff *= 2
                continue
            raise RuntimeError(f"HTTP {e.code}: {e.read().decode(errors='ignore')[:300]}")
        except urllib.error.URLError:
            if attempt < 3:
                time.sleep(backoff)
                backoff *= 2
                continue
            raise
    raise RuntimeError("retries exhausted")


def extract_json(resp: dict) -> dict | None:
    for cand in resp.get("candidates", []):
        for part in cand.get("content", {}).get("parts", []):
            text = part.get("text", "").strip()
            if not text:
                continue
            if text.startswith("```"):
                lines = text.split("\n")
                text = "\n".join(lines[1:-1] if lines[-1].startswith("```") else lines[1:])
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                start, end = text.find("{"), text.rfind("}")
                if start >= 0 and end > start:
                    try:
                        return json.loads(text[start:end + 1])
                    except json.JSONDecodeError:
                        pass
    return None


VERDICT_KEYS = (
    "guessed_species_sci", "guessed_species_com", "guess_confidence",
    "matches_target", "wing_count", "leg_count", "head_count", "tail_count",
    "has_stick_or_perch", "whole_bird", "diagnostic_features_present",
    "diagnostic_features_missing", "anatomy_issues", "style_assessment",
)


def _normalize(raw: dict) -> dict:
    """Coerce a raw Gemini verdict into a typed, guaranteed-shape dict.

    Every key the CSV writer and the app.py QA hook read is present with a
    stable type: bools are real bools, counts are ints, strings are strings.
    Missing counts default to the healthy value so incomplete data fails
    *open* (a QA gate should not reject/regenerate on a partial response).
    """
    def as_bool(key: str, default: bool = False) -> bool:
        val = raw.get(key, default)
        if isinstance(val, bool):
            return val
        if isinstance(val, str):
            return val.strip().lower() in ("true", "yes", "1")
        return bool(val)

    def as_int(key: str, default: int) -> int:
        try:
            return int(raw.get(key, default))
        except (TypeError, ValueError):
            return default

    def as_str(key: str) -> str:
        val = raw.get(key, "")
        return "" if val is None else str(val)

    return {
        "guessed_species_sci": as_str("guessed_species_sci"),
        "guessed_species_com": as_str("guessed_species_com"),
        "guess_confidence": as_str("guess_confidence").lower(),
        "matches_target": as_bool("matches_target", False),
        "wing_count": as_int("wing_count", 2),
        "leg_count": as_int("leg_count", 2),
        "head_count": as_int("head_count", 1),
        "tail_count": as_int("tail_count", 1),
        "has_stick_or_perch": as_bool("has_stick_or_perch", False),
        # Default True = fail OPEN (a partial response must never reject).
        "whole_bird": as_bool("whole_bird", True),
        "diagnostic_features_present": as_str("diagnostic_features_present"),
        "diagnostic_features_missing": as_str("diagnostic_features_missing"),
        "anatomy_issues": as_str("anatomy_issues"),
        "style_assessment": as_str("style_assessment"),
    }


def verify_one(api_key: str, png: Path, sci: str, com: str) -> dict | None:
    """Adversarially identify one illustration and return a structured verdict.

    Importable and side-effect-free (no printing, no CSV) so the Railway
    worker can call it as a QA hook. Returns a normalized dict with the
    guaranteed keys in VERDICT_KEYS (matches_target, guess_confidence,
    wing_count, leg_count, has_stick_or_perch, ...), or None when the model
    response could not be parsed into JSON.
    """
    parts = [
        {"text": VERIFY_PROMPT.format(target_sci=sci, target_com=com)},
        {"inlineData": {"mimeType": "image/png",
                        "data": base64.b64encode(png.read_bytes()).decode()}},
    ]
    raw = extract_json(call_gemini(api_key, parts))
    return _normalize(raw) if raw else None


CSV_HEADER = ("slug,pose,target_sci,guessed_sci,guessed_com,matches,confidence,"
              "wings,legs,head,tail,has_stick,diag_present,diag_missing,"
              "anatomy_issues,style\n")


def csv_row(slug: str, pose: int, sci: str, v: dict) -> str:
    def q(key):
        return '"' + str(v.get(key, "")).replace('"', "'") + '"'
    return ",".join([
        slug, str(pose), sci.replace(",", " "),
        str(v.get("guessed_species_sci", "")).replace(",", " "),
        str(v.get("guessed_species_com", "")).replace(",", " "),
        str(v.get("matches_target", False)), str(v.get("guess_confidence", "")),
        str(v.get("wing_count", "")), str(v.get("leg_count", "")),
        str(v.get("head_count", "")), str(v.get("tail_count", "")),
        str(v.get("has_stick_or_perch", "")),
        q("diagnostic_features_present"), q("diagnostic_features_missing"),
        q("anatomy_issues"), str(v.get("style_assessment", "")),
    ]) + "\n"


def main() -> int:  # noqa: C901  (complexity 17; pre-existing debt, see .flake8)
    # abspath, NOT resolve() -- the same symlink invariant pregen.py:614 records,
    # which this file (its sibling in the same symlinked set) never received.
    # resolve() follows avian/scripts/verify.py back to services/birdgen/, so
    # parents[1] became services/ and --dir defaulted to a NONEXISTENT
    # services/assets/illustrations. glob() on a missing directory raises
    # nothing and yields nothing, so the documented command in
    # avian/scripts/README.md:85 printed "verifying 0 illustrations",
    # "0 mismatch(es)" and exited 0 -- an adversarial QA gate that had never
    # examined a single plate, reporting a clean bill of health. Anchoring on
    # the INVOKED path keeps avian/ -> avian/assets/illustrations.
    _here = Path(os.path.abspath(__file__)).parent
    here = _here.parent
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("slugs", nargs="*", help="Slugs to verify. Default: all in --dir.")
    ap.add_argument("--labels", type=Path, required=True,
                    help="Sci|Com label file (same one passed to pregen.py)")
    ap.add_argument("--dir", type=Path, default=here / "assets" / "illustrations",
                    help="Illustration directory (default: avian/assets/illustrations/)")
    ap.add_argument("--out", type=Path, default=Path("verify-results.csv"),
                    help="CSV output path (default: ./verify-results.csv)")
    ap.add_argument("--gemini-key", help="Gemini API key (or GEMINI_API_KEY env)")
    args = ap.parse_args()

    api_key = args.gemini_key or os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        print("error: GEMINI_API_KEY required (--gemini-key or env)", file=sys.stderr)
        return 2
    labels = load_labels(args.labels)

    if args.slugs:
        pngs = [args.dir / f"{s}.png" for s in args.slugs]
    else:
        pngs = sorted(args.dir.glob("*.png"))
    if not args.out.exists():
        args.out.write_text(CSV_HEADER)

    print(f"verifying {len(pngs)} illustrations against {len(labels)} labels\n")
    mismatches = 0
    checked = 0  # plates that actually came back with a verdict, not skips
    for png in pngs:
        if not png.exists():
            print(f"  [skip] missing {png.name}")
            continue
        name = png.stem
        pose, slug = (2, name[:-2]) if name.endswith("-2") else (1, name)
        if slug not in labels:
            print(f"  [skip] no label for {slug}")
            continue
        sci, com = labels[slug]
        try:
            v = verify_one(api_key, png, sci, com)
        except Exception as e:
            print(f"  [fail] {png.name}: {e}", file=sys.stderr)
            continue
        if not v:
            print(f"  [fail] {png.name}: could not parse response", file=sys.stderr)
            continue

        checked += 1
        match = v.get("matches_target", False)
        tag = "[ok]   " if match else "[MISS] "
        print(f"  {tag}{png.name}: reads as {v.get('guessed_species_com', '?')} "
              f"(conf={v.get('guess_confidence', '?')})" + ("" if match else f", expected {com}"))
        if not match:
            mismatches += 1
        flags = []
        if v.get("wing_count", 2) != 2:
            flags.append(f"wings={v.get('wing_count')}")
        if v.get("leg_count", 2) and v.get("leg_count", 2) > 2:
            flags.append(f"legs={v.get('leg_count')}")
        if v.get("has_stick_or_perch"):
            flags.append("has perch/stick")
        if v.get("anatomy_issues"):
            flags.append(str(v["anatomy_issues"]))
        if v.get("diagnostic_features_missing"):
            flags.append(f"missing: {v['diagnostic_features_missing']}")
        if flags:
            print(f"         [warn] {'; '.join(flags)}")
        with args.out.open("a") as f:
            f.write(csv_row(slug, pose, sci, v))

    print(f"\ndone. checked {checked} of {len(pngs)} plate(s), "
          f"{mismatches} mismatch(es). results -> {args.out}")

    # EXIT CODES. This returned a bare 0 for its whole life: a caller could not
    # tell "every plate reads as the right bird" from "I looked at nothing" or
    # from "12 plates are the wrong species". Both halves of that are the
    # fail-open class this project keeps re-finding -- a check that cannot fail,
    # reporting success -- and this one guards the PAID art pipeline.
    #
    # 4 before 1 deliberately: examining nothing is a worse answer than finding
    # faults, because it is the one an operator is most likely to read as clean.
    if checked == 0:
        print("REFUSING to report success: not one plate was examined. "
              f"--dir was {args.dir} (exists={args.dir.is_dir()}). "
              "An empty or wrong directory is a broken invocation, not a pass.",
              file=sys.stderr)
        return 4
    if mismatches:
        print(f"{mismatches} plate(s) do not read as the target species.",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
