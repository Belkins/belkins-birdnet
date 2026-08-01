#!/usr/bin/env python3
"""Rhyme Mode preview: the almanac card, rendered straight from phenology.json.

One question, one card: *what did this same ISO week sound like in the years
that have already closed?* No browser, no station, no network -- the frozen
ledger ``avian/catalog/phenology.py`` writes is the only input, PIL is the only
renderer, and the output is a 1200x1600 PNG quantised through display.py's own
``quantize_spectra6`` so the wall's palette is what you are judging.

WHY IT IMPORTS phenology.py RATHER THAN RE-DERIVING
  The card indexes a frozen curve by ISO week, and that fold is not obvious:
  ``date(2026,12,28)`` is ISO week 53 (which the ledger folds to 52) and
  ``date(2024,12,30)`` is ISO year 2025 week 1 while still being December 2024.
  phenology.year_week() owns both clamps and ``_curve_index()`` owns the raise
  that keeps a 53rd week from being silently dropped. A second implementation
  here could drift from the one that actually froze the cells, so there is only
  one: this module imports the owner.

THE THREE THINGS IT REFUSES TO DO
  1. RENDER A STUMP AS A SEASON. Fewer than two CLOSED years -> nothing is
     written and the process exits 4 with a message. "Year over year" needs two
     years; phenology's own PROVENANCE note (its docstring, and the
     ``min_date_seen`` field it freezes for exactly this reason) says a partial
     first year is not a season. The same test applies per row: a closed year
     whose ledger did not begin until AFTER the week being drawn prints when it
     begins, never "0 species", because a zero there would be a claim the ledger
     never made.
  2. NARRATE A ZERO. A zero week prints bare -- "0 species · 0 detections" --
     and never as "a quiet week". birds.db records DETECTIONS, not uptime, so a
     week with the microphone unplugged and a genuinely silent week are
     identical in this data (phenology.NOTES["effort"]). For the same reason the
     effort field itself is deliberately NOT drawn on this card: rendered beside
     a count it reads as listening coverage, which is the one thing it is not.
  3. COUNT A MISSING CURVE AS ZERO. Entries frozen before 2026-07-30 predate
     ``weekly_detections`` and a closed year is never recomputed, so their curve
     is gone for good. Those entries are excluded from the row and NAMED in a
     footnote rather than folded into the total as zeros.

FIXTURE DATA
  No multi-year phenology.json exists outside the station, so the previews in
  this repo are rendered from a SYNTHETIC ledger. Any card built from one is
  stamped -- an accent bar top and bottom and a line of text -- so a screenshot
  of it can never be mistaken for a recording. The stamp fires on two
  independent signals (a truthy top-level ``fixture`` key in the payload, or a
  ``fixtures`` path component), because a preview that quietly loses its stamp
  is the failure that matters here.

  python3 almanac_preview.py tests/fixtures/phenology-synthetic.json \\
      --week 31 --preview /tmp/week31.png

Exit codes: 0 ok, 4 refused (fewer than two closed years -- nothing written),
5 failed. 4 and 5 rather than 1 so a caller can tell "this ledger is too young"
from "this run broke"; 2 stays argparse's.
"""

import argparse
import datetime
import json
import os
import sys

# phenology.py OWNS the ISO-week fold these curves were frozen on, so it is
# imported, not re-implemented. abspath and never resolve(): birdgen is the
# canonical tree with avian/scripts symlinked onto it, and resolve() would walk
# the link and rewrite the path out from under that layout (repo invariant).
_HERE = os.path.dirname(os.path.abspath(__file__))
_CATALOG = os.path.abspath(os.path.join(_HERE, "..", "avian", "catalog"))
for _p in (_CATALOG, _HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import phenology  # noqa: E402

# The committed legacy face; no download, ever. RobotoFlex ships in this repo
# for the homepage, and it is the only variable-weight face already here.
FONT_PATH = os.path.abspath(os.path.join(_HERE, "..", "homepage", "static",
                                         "RobotoFlex-Regular.ttf"))

# Payload key that self-declares a synthetic ledger. Checked alongside the path,
# so losing either one alone still stamps the card.
FIXTURE_KEY = "fixture"

# Height of the solid accent bar the stamp draws at the top and bottom of a
# fixture card. Exported because the test probes a pixel inside it: the bar is a
# flat fill of an exact Spectra-6 ink, so quantisation maps it with no dither
# error and "is the stamp there" is a colour equality, not an OCR problem.
FIXTURE_BAND_H = 24
FIXTURE_LABEL = "FIXTURE DATA — SYNTHETIC LEDGER, NOT A RECORDING"

MARGIN = 96


class TooFewClosedYears(ValueError):
    """The ledger cannot answer 'year over year' yet. Maps to exit 4."""


# ---- pure logic (no PIL, so the gate and the clamps stay testable) ----------

def load_payload(path):
    """Read a phenology.json. Shape-checked on the two fields this card reads;
    anything else is carried through untouched (entries are OPAQUE here, exactly
    as phenology._load_ledger treats them)."""
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict) or not isinstance(data.get("entries"), list):
        raise ValueError(
            "%s is not a phenology ledger ({\"entries\": [...]}); refusing to "
            "draw a card from a file whose shape is unknown" % (path,))
    return data


def is_fixture(payload, path):
    """True if this card must carry the FIXTURE DATA stamp.

    TWO independent signals, OR-ed: the payload declaring itself, and the file
    living under a ``fixtures`` directory. Either alone is enough, so moving the
    file or hand-copying the entries does not silently strip the stamp. A
    synthetic ledger that loses BOTH would render unstamped -- that is the known
    hole, and it is why the marker is written into the fixture itself."""
    if payload.get(FIXTURE_KEY):
        return True
    return "fixtures" in os.path.abspath(path).split(os.sep)


def current_week(today=None):
    """``(calendar_year, week 1..52)`` for today, on phenology's own fold.

    ``today`` is an ISO date string; None reads the wall clock. Week 53 dates do
    not crash and do not wrap -- year_week() folds them to 52, the same cell the
    ledger froze them into."""
    if today is None:
        today = datetime.date.today().isoformat()
    year, week = phenology.year_week(today)
    if week is None:
        raise ValueError(
            "%r is not a date phenology.year_week() can place" % (today,))
    return year, week


def closed_years(payload):
    """The years the FREEZE RULE considers closed, ascending.

    ``current_year`` is the ledger's, taken from the data's latest Date rather
    than the wall clock. Mirrors merge_ledger: a null current_year means no year
    can be PROVEN open, so every year present is treated as closed."""
    current = payload.get("current_year")
    years = sorted({e.get("year") for e in payload["entries"]
                    if isinstance(e.get("year"), int)})
    if not isinstance(current, int):
        return list(years)
    return [y for y in years if y < current]


def year_row(payload, year, week):
    """One year's slice of one week.

    Returns ``{"year", "species", "detections", "no_curve", "begins"}``.
    ``begins`` is a date string when the ledger for that year did not start
    until after this week -- the stump case, which prints as a date and never as
    a zero. ``no_curve`` counts entries frozen before ``weekly_detections``
    existed; they are excluded, never read as 0."""
    cell = phenology._curve_index(week)   # reuse the ledger's own range raise
    species = detections = no_curve = 0
    first_seen = None
    for e in payload["entries"]:
        if e.get("year") != year:
            continue
        seen = e.get("min_date_seen")
        if isinstance(seen, str) and (first_seen is None or seen < first_seen):
            first_seen = seen
        curve = e.get("weekly_detections")
        if (not isinstance(curve, list)
                or len(curve) != phenology.MAX_ISO_WEEK
                or not isinstance(curve[cell], int)
                or isinstance(curve[cell], bool)):
            no_curve += 1
            continue
        n = curve[cell]
        detections += n
        if n > 0:
            species += 1
    begins = None
    if first_seen is not None:
        fy, fw = phenology.year_week(first_seen)
        if fy == year and fw is not None and fw > week:
            begins = first_seen
    return {"year": year, "species": species, "detections": detections,
            "no_curve": no_curve, "begins": begins}


def build_card(payload, week, fixture=False):
    """The whole card as data, so every refusal is testable without a renderer.

    RAISES TooFewClosedYears when the ledger holds fewer than two closed years:
    there is no rhyme with one year, and phenology's PROVENANCE note is explicit
    that a partial year is a stump, not a season."""
    years = closed_years(payload)
    if len(years) < 2:
        raise TooFewClosedYears(
            "phenology ledger holds %d closed year(s) %s -- 'the same week, year "
            "over year' needs at least 2. A single (possibly partial) year is a "
            "stump, not a season, and this card will not present it as one."
            % (len(years), years))

    rows, missing = [], 0
    for year in years:
        r = year_row(payload, year, week)
        missing += r["no_curve"]
        if r["begins"] is not None:
            text = "%d — ledger begins %s" % (year, r["begins"])
        else:
            # BARE. No adjective, no "quiet", not even at zero.
            text = "%d — %d species · %d detections" % (
                year, r["species"], r["detections"])
        rows.append(text)

    notes = [
        "0 means the ledger holds no detections for that week. birds.db records "
        "detections, not uptime, so it is not evidence of absence and not a "
        "measure of listening time.",
        "Closed years only — the open year is still accumulating and is never "
        "frozen until it ends.",
    ]
    if missing:
        notes.insert(1, "%d entr%s frozen before the weekly curve existed and "
                        "%s excluded — not counted as 0."
                        % (missing, "y" if missing == 1 else "ies",
                           "is" if missing == 1 else "are"))
    return {
        "week": week,
        "eyebrow": "BELKINS BIRDNET · ALMANAC",
        "headline": "WEEK %02d" % week,
        "subhead": "the same ISO week, year over year",
        "rows": rows,
        "notes": notes,
        "years": years,
        "fixture": bool(fixture),
    }


# ---- rendering (PIL + display are imported HERE, not at module load, so a box
#      without Pillow can still run the gate and the clamps) -------------------

def _font(size):
    from PIL import ImageFont
    if os.path.isfile(FONT_PATH):
        try:
            return ImageFont.truetype(FONT_PATH, size)
        except OSError:
            pass
    # Loud, because load_default() ignores `size`: the card still renders, at a
    # size nobody would choose, and silently looking wrong is worse than a line
    # on stderr.
    sys.stderr.write("almanac-preview: %s unusable; falling back to PIL's "
                     "default bitmap font (the card will be tiny)\n" % FONT_PATH)
    return ImageFont.load_default()


def _wrap(draw, text, font, max_w):
    """Greedy wrap on spaces. Measured, not guessed at a character count, so a
    footnote cannot run off the panel edge when the face changes."""
    words, lines, line = text.split(), [], ""
    for w in words:
        trial = w if not line else line + " " + w
        if line and draw.textlength(trial, font=font) > max_w:
            lines.append(line)
            line = w
        else:
            line = trial
    if line:
        lines.append(line)
    return lines


def render_card(card, out_path):
    """Draw the card and write a Spectra-6 quantised PNG. Returns out_path."""
    from PIL import Image, ImageDraw
    import display

    w, h = display.PANEL_W, display.PANEL_H
    paper, ink, accent = (display.SPECTRA6[0], display.SPECTRA6[1],
                          display.SPECTRA6[2])
    img = Image.new("RGB", (w, h), paper)
    d = ImageDraw.Draw(img)
    inner = w - 2 * MARGIN

    y = 120
    if card["fixture"]:
        # Flat fills of an exact ink, top and bottom: they survive quantisation
        # without a dither pixel, which is what makes the stamp probeable.
        d.rectangle((0, 0, w, FIXTURE_BAND_H), fill=accent)
        d.rectangle((0, h - FIXTURE_BAND_H, w, h), fill=accent)
        d.text((MARGIN, FIXTURE_BAND_H + 20), FIXTURE_LABEL,
               font=_font(30), fill=accent)
        y = 150

    d.text((MARGIN, y), card["eyebrow"], font=_font(30), fill=ink)
    y += 62
    d.text((MARGIN, y), card["headline"], font=_font(150), fill=ink)
    y += 196
    d.text((MARGIN, y), card["subhead"], font=_font(36), fill=ink)
    y += 88
    d.rectangle((MARGIN, y, w - MARGIN, y + 2), fill=ink)
    y += 72

    row_font = _font(52)
    for text in card["rows"]:
        d.text((MARGIN, y), text, font=row_font, fill=ink)
        y += 96

    note_font = _font(26)
    lines = []
    for note in card["notes"]:
        lines.extend(_wrap(d, note, note_font, inner))
        lines.append("")
    if lines:
        lines.pop()
    ny = h - MARGIN - FIXTURE_BAND_H - 38 * len(lines)
    for line in lines:
        d.text((MARGIN, ny), line, font=note_font, fill=ink)
        ny += 38

    display.quantize_spectra6(img).save(out_path)
    return out_path


# ---- CLI -------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Render the Rhyme Mode almanac card from a phenology.json "
                    "ledger. Browser-free; writes a 1200x1600 Spectra-6 PNG.")
    ap.add_argument("phenology_json",
                    help="path to phenology.json (avian/catalog/phenology.py's "
                         "frozen per-year ledger)")
    ap.add_argument("--preview", required=True,
                    help="output PNG path (1200x1600, quantised via display.py)")
    ap.add_argument("--week", type=int, default=None,
                    help="ISO week 1..52 to draw (default: today's, on "
                         "phenology's own fold)")
    ap.add_argument("--today", default=None,
                    help="ISO date to take the week from instead of the wall "
                         "clock (a week-53 date folds to 52, as the ledger did)")
    args = ap.parse_args(argv)

    if args.week is not None and args.today is not None:
        sys.stderr.write("almanac-preview: --week and --today name two different "
                         "weeks; pass one\n")
        return 2

    try:
        payload = load_payload(args.phenology_json)
        if args.week is not None:
            phenology._curve_index(args.week)   # the ledger's own range check
            week = args.week
        else:
            week = current_week(args.today)[1]
        card = build_card(payload, week,
                          fixture=is_fixture(payload, args.phenology_json))
    except TooFewClosedYears as exc:
        sys.stderr.write("almanac-preview: REFUSED -- %s NOTHING was written.\n"
                         % exc)
        return 4
    except Exception as exc:  # noqa: BLE001 -- name the cause, then fail loudly
        sys.stderr.write("almanac-preview: FAILED (%s: %s) -- NOTHING was "
                         "written\n" % (type(exc).__name__, exc))
        return 5

    try:
        render_card(card, args.preview)
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write("almanac-preview: FAILED while rendering (%s: %s) -- "
                         "NOTHING was written\n" % (type(exc).__name__, exc))
        return 5

    sys.stdout.write(
        "almanac-preview: week %d, closed years %s%s -> %s\n"
        % (card["week"], card["years"],
           " [FIXTURE DATA]" if card["fixture"] else "", args.preview))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
