#!/usr/bin/env python3
"""Tests for almanac_preview -- the three REFUSALS, not "it drew something".

Every case here guards a claim the card could make and must not:

  * a stump presented as a season (one closed year is not "year over year",
    and phenology.py's PROVENANCE note says so in the file that freezes it);
  * a week-53 date silently dropped or crashing the run, because this module
    re-derived the ISO fold instead of reusing the one that froze the cells;
  * a synthetic ledger rendered without its FIXTURE DATA stamp -- an unstamped
    preview of invented birds is exactly the fabricated-proof failure this
    repo treats as a hard stop.

The pure logic (the gate, the clamps, the row text) is deliberately importable
with no Pillow: only the drawing tests are skipped on a box without it, so a
PIL-less CI still runs the refusals.

Run from ``frame/``:
    /usr/bin/python3 -m pytest tests/ -q
    python3 -m unittest discover -s tests -v
"""

import datetime
import json
import os
import sys
import tempfile
import unittest
from io import StringIO
from contextlib import redirect_stderr, redirect_stdout

# Import the module regardless of CWD / discovery method (test_frame_watch.py's
# convention).
_FRAME_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _FRAME_DIR not in sys.path:
    sys.path.insert(0, _FRAME_DIR)

import almanac_preview  # noqa: E402
import phenology  # noqa: E402  -- put on sys.path by almanac_preview's import

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "fixtures", "phenology-synthetic.json")

# Pillow AND display (which also needs tomllib/tomli) -- the render tests need
# both, and "can we draw" is the honest condition, not "is PIL installed".
try:
    from PIL import Image  # noqa: F401
    import display  # noqa: F401
    HAVE_RENDER = True
except Exception:  # noqa: BLE001
    HAVE_RENDER = False


def _entry(sci, year, week_counts, min_date, curve=True):
    """One species-year in phenology.py's frozen entry shape."""
    cells = [0] * phenology.MAX_ISO_WEEK
    for wk, n in week_counts.items():
        cells[phenology._curve_index(wk)] = n
    e = {
        "sci_name": sci, "com_name": sci, "slug": phenology.slugify(sci),
        "year": year, "first_heard": None, "last_heard": None,
        "days_heard": sum(1 for n in cells if n), "detections": sum(cells),
        "peak_week": None, "peak_week_n": 0,
        "station_weekly_dates_with_detections": [0] * phenology.MAX_ISO_WEEK,
        "source_rows_at_freeze": 1, "min_date_seen": min_date,
        "frozen_at": "2026-01-01T00:00:00+00:00",
    }
    if curve:
        e["weekly_detections"] = cells
    return e


def _ledger(current_year, entries, fixture=False):
    payload = {
        "version": 1, "built_at": "2026-01-01T00:00:00+00:00",
        "current_year": current_year, "source_rows": 1,
        "species_years": len(entries),
        "coverage": {"min_date": None, "max_date": None, "source_rows": 1,
                     "years": sorted({e["year"] for e in entries})},
        "notes": {}, "entries": entries,
    }
    if fixture:
        payload["fixture"] = True
    return payload


def _run_cli(argv):
    """main() with its streams captured -> (exit_code, stdout, stderr)."""
    out, err = StringIO(), StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = almanac_preview.main(argv)
    return code, out.getvalue(), err.getvalue()


class TheStumpGate(unittest.TestCase):
    """RULE 1: fewer than two CLOSED years -> render NOTHING.

    Matters because the ledger's first year is routinely a stump -- phenology
    freezes ``min_date_seen`` precisely so a partial year stays visibly partial
    -- and a card headed "the same ISO week, year over year" showing one row is
    a season claim the data cannot support."""

    def test_one_closed_year_refuses(self):
        # 2026 is open (current_year), so only 2025 is closed: one year.
        payload = _ledger(2026, [_entry("Aa bb", 2025, {20: 5}, "2025-01-06"),
                                 _entry("Aa bb", 2026, {20: 9}, "2026-01-05")])
        self.assertEqual(almanac_preview.closed_years(payload), [2025])
        with self.assertRaises(almanac_preview.TooFewClosedYears):
            almanac_preview.build_card(payload, 20)

    def test_zero_closed_years_refuses(self):
        payload = _ledger(2026, [_entry("Aa bb", 2026, {20: 9}, "2026-01-05")])
        self.assertEqual(almanac_preview.closed_years(payload), [])
        with self.assertRaises(almanac_preview.TooFewClosedYears):
            almanac_preview.build_card(payload, 20)

    def test_two_closed_years_is_the_boundary_and_renders(self):
        """The gate must not be so wide it never passes -- pin the first year
        that IS allowed through, or the refusal above proves nothing."""
        payload = _ledger(2026, [_entry("Aa bb", 2024, {20: 5}, "2024-01-08"),
                                 _entry("Aa bb", 2025, {20: 7}, "2025-01-06"),
                                 _entry("Aa bb", 2026, {20: 9}, "2026-01-05")])
        card = almanac_preview.build_card(payload, 20)
        self.assertEqual(card["years"], [2024, 2025])
        self.assertEqual(len(card["rows"]), 2)

    def test_cli_writes_no_file_and_exits_4(self):
        """'Renders nothing' is a claim about the FILESYSTEM, so check the
        filesystem: a refusal that still left a PNG behind would be a card
        someone could screenshot."""
        payload = _ledger(2026, [_entry("Aa bb", 2026, {20: 9}, "2026-01-05")])
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "phenology.json")
            png = os.path.join(tmp, "card.png")
            with open(src, "w", encoding="utf-8") as fh:
                json.dump(payload, fh)
            code, _out, err = _run_cli([src, "--preview", png, "--week", "20"])
            self.assertEqual(code, 4)
            self.assertFalse(os.path.exists(png), "refused but wrote a PNG anyway")
            self.assertIn("REFUSED", err)

    def test_a_closed_year_whose_ledger_starts_later_is_dated_not_zeroed(self):
        """The per-row form of the same rule. 2023's rows only begin in ISO week
        45; printing '0 species' for week 20 would be a claim the ledger never
        made."""
        payload = _ledger(2026, [_entry("Aa bb", 2023, {46: 30}, "2023-11-06"),
                                 _entry("Aa bb", 2024, {20: 5}, "2024-01-08")])
        rows = almanac_preview.build_card(payload, 20)["rows"]
        self.assertEqual(rows[0], "2023 — ledger begins 2023-11-06")
        self.assertNotIn("species", rows[0])
        # ...and inside its covered range it reports normally.
        rows = almanac_preview.build_card(payload, 46)["rows"]
        self.assertEqual(rows[0], "2023 — 1 species · 30 detections")


class TheWeekFold(unittest.TestCase):
    """RULE 2: the ISO fold is phenology.py's, reused -- not re-derived here.

    A 53-week ISO year is the case that breaks naive week code, and this module
    indexes curves that were FROZEN on the 1..52 fold. Re-deriving it would let
    the card and the ledger disagree with nobody noticing."""

    def test_week_53_would_have_been_fatal_unfolded(self):
        """Prove the hazard is real before proving it is handled: 28 Dec 2026 is
        genuinely ISO week 53, and an unfolded 53 raises in the ledger's own
        curve indexer -- i.e. the run would have died, not silently mis-drawn."""
        self.assertEqual(datetime.date(2026, 12, 28).isocalendar()[1], 53)
        with self.assertRaises(ValueError):
            phenology._curve_index(53)

    def test_week_53_date_folds_to_52(self):
        self.assertEqual(almanac_preview.current_week("2026-12-28"), (2026, 52))

    def test_iso_year_disagreement_stays_in_its_calendar_year(self):
        """phenology's second clamp: 30 Dec 2024 is ISO 2025-W01 and 1 Jan 2021
        is ISO 2020-W53. Both must stay in their own calendar year, at the
        matching end."""
        self.assertEqual(almanac_preview.current_week("2024-12-30"), (2024, 52))
        self.assertEqual(almanac_preview.current_week("2021-01-01"), (2021, 1))

    def test_a_week_53_card_builds_without_crashing(self):
        payload = _ledger(2026, [_entry("Aa bb", 2024, {52: 4}, "2024-01-08"),
                                 _entry("Aa bb", 2025, {52: 6}, "2025-01-06")])
        week = almanac_preview.current_week("2026-12-28")[1]
        card = almanac_preview.build_card(payload, week)
        self.assertEqual(card["headline"], "WEEK 52")
        self.assertEqual(card["rows"],
                         ["2024 — 1 species · 4 detections",
                          "2025 — 1 species · 6 detections"])

    def test_an_out_of_range_week_argument_fails_loud(self):
        payload = _ledger(2026, [_entry("Aa bb", 2024, {20: 4}, "2024-01-08"),
                                 _entry("Aa bb", 2025, {20: 6}, "2025-01-06")])
        for week in (0, 53, 99):
            with self.assertRaises(ValueError):
                almanac_preview.build_card(payload, week)

    def test_an_unplaceable_date_fails_loud(self):
        with self.assertRaises(ValueError):
            almanac_preview.current_week("not-a-date")


class TheHonestCounts(unittest.TestCase):
    """RULE 3 and its neighbour: a zero prints bare, and a missing curve is
    excluded rather than read as zero."""

    def test_a_zero_week_prints_the_count_bare(self):
        """No 'quiet', no 'silent', no adjective at all. birds.db records
        detections, not uptime (phenology.NOTES['effort']), so any word
        describing the WEEK rather than the COUNT is a claim about the station
        that this data cannot support."""
        payload = _ledger(2026, [_entry("Aa bb", 2024, {5: 4}, "2024-01-08"),
                                 _entry("Aa bb", 2025, {5: 6}, "2025-01-06")])
        rows = almanac_preview.build_card(payload, 30)["rows"]
        self.assertEqual(rows, ["2024 — 0 species · 0 detections",
                                "2025 — 0 species · 0 detections"])
        for banned in ("quiet", "silent", "nothing heard", "no birds",
                       "uptime", "coverage", "listening"):
            for row in rows:
                self.assertNotIn(banned, row.lower())

    def test_the_card_cannot_express_the_effort_field(self):
        """station_weekly_dates_with_detections is NOT uptime, NOT listening
        coverage and NOT observation hours (phenology.NOTES['effort']) -- and a
        word-blocklist cannot police that, because the honest note the card DOES
        carry has to say the word 'uptime' to deny it.

        So the guarantee is structural instead: move the effort field as far as
        it can go and the card must not change by one character. A card that is
        invariant under the field cannot be rendering it under any name."""
        def card_for(effort):
            payload = _ledger(2026, [_entry("Aa bb", 2024, {5: 4}, "2024-01-08"),
                                     _entry("Aa bb", 2025, {5: 6}, "2025-01-06")])
            for e in payload["entries"]:
                e["station_weekly_dates_with_detections"] = \
                    [effort] * phenology.MAX_ISO_WEEK
            return almanac_preview.build_card(payload, 5)

        self.assertEqual(card_for(0), card_for(7))
        self.assertEqual(card_for(0), card_for(999999))

    def test_the_zero_disclaimer_is_always_on_the_card(self):
        """The counterpart to printing a zero bare: the card must carry the
        sentence that stops a reader supplying the missing adjective."""
        payload = _ledger(2026, [_entry("Aa bb", 2024, {5: 4}, "2024-01-08"),
                                 _entry("Aa bb", 2025, {5: 6}, "2025-01-06")])
        for week in (5, 30):        # a week with rows and a week without
            notes = " ".join(almanac_preview.build_card(payload, week)["notes"])
            self.assertIn("not evidence of absence", notes)
            self.assertIn("detections, not uptime", notes)

    def test_an_entry_without_a_curve_is_excluded_not_zeroed(self):
        """Entries frozen before 2026-07-30 legitimately lack weekly_detections
        and a closed year is never recomputed, so the curve is gone for good.
        Folding it in as 0 would invent a fact about a week nobody measured."""
        payload = _ledger(2026, [
            _entry("Aa bb", 2024, {20: 5}, "2024-01-08"),
            _entry("Cc dd", 2024, {20: 9}, "2024-01-08", curve=False),
            _entry("Aa bb", 2025, {20: 7}, "2025-01-06"),
        ])
        row = almanac_preview.year_row(payload, 2024, 20)
        self.assertEqual(row["no_curve"], 1)
        self.assertEqual((row["species"], row["detections"]), (1, 5))
        card = almanac_preview.build_card(payload, 20)
        self.assertTrue(any("frozen before the weekly curve" in n
                            for n in card["notes"]),
                        "a dropped curve must be named, not absorbed")

    def test_a_null_current_year_treats_every_year_as_closed(self):
        """Mirrors phenology.merge_ledger: with no parseable Date anywhere, no
        year can be PROVEN open, so none is treated as still accumulating."""
        payload = _ledger(None, [_entry("Aa bb", 2024, {20: 5}, "2024-01-08"),
                                 _entry("Aa bb", 2025, {20: 7}, "2025-01-06")])
        self.assertEqual(almanac_preview.closed_years(payload), [2024, 2025])


class TheFixtureStamp(unittest.TestCase):
    """RULE 4: a card built from invented birds says so, on the card."""

    def test_the_committed_fixture_declares_itself(self):
        payload = almanac_preview.load_payload(FIXTURE)
        self.assertTrue(payload.get(almanac_preview.FIXTURE_KEY),
                        "the synthetic ledger lost its 'fixture' marker")
        self.assertTrue(almanac_preview.is_fixture(payload, FIXTURE))

    def test_either_signal_alone_still_stamps(self):
        """The marker and the path are independent on purpose: copying the
        entries out of the file, or moving the file, must each still stamp."""
        marked = _ledger(2026, [_entry("Aa bb", 2024, {20: 5}, "2024-01-08")],
                         fixture=True)
        self.assertTrue(almanac_preview.is_fixture(marked, "/tmp/anywhere.json"))
        unmarked = _ledger(2026, [_entry("Aa bb", 2024, {20: 5}, "2024-01-08")])
        self.assertTrue(almanac_preview.is_fixture(
            unmarked, os.path.join("/tmp", "fixtures", "x.json")))
        self.assertFalse(almanac_preview.is_fixture(unmarked, "/tmp/real.json"))

    def test_the_fixture_species_are_visibly_invented(self):
        """No row of this ledger may be mistakable for a real detection."""
        payload = almanac_preview.load_payload(FIXTURE)
        for e in payload["entries"]:
            self.assertTrue(e["sci_name"].startswith("Fictus "), e["sci_name"])

    def test_the_fixture_curves_never_precede_their_own_coverage(self):
        """2023 is a deliberate stump; a cell before its min_date_seen week
        would make the fixture itself dishonest and would hide the stump row
        this preview exists to demonstrate."""
        payload = almanac_preview.load_payload(FIXTURE)
        for e in payload["entries"]:
            curve = e.get("weekly_detections")
            if curve is None:
                continue
            first = phenology.year_week(e["min_date_seen"])
            if first[0] != e["year"]:
                continue
            self.assertEqual(
                sum(curve[:phenology._curve_index(first[1])]), 0,
                "%s %d has detections before %s" % (e["sci_name"], e["year"],
                                                    e["min_date_seen"]))

    @unittest.skipUnless(HAVE_RENDER, "Pillow / display.py unavailable")
    def test_the_rendered_fixture_card_carries_the_band(self):
        """Probed as a PIXEL, not as a flag: the band is a flat fill of an exact
        Spectra-6 ink, so quantisation maps it with no dither error and the
        stamp's presence is a colour equality."""
        payload = almanac_preview.load_payload(FIXTURE)
        card = almanac_preview.build_card(
            payload, 31, fixture=almanac_preview.is_fixture(payload, FIXTURE))
        self.assertTrue(card["fixture"])
        with tempfile.TemporaryDirectory() as tmp:
            png = os.path.join(tmp, "card.png")
            almanac_preview.render_card(card, png)
            img = Image.open(png).convert("RGB")
            self.assertEqual(img.size, (display.PANEL_W, display.PANEL_H))
            probe = (display.PANEL_W // 2, almanac_preview.FIXTURE_BAND_H // 2)
            self.assertEqual(img.getpixel(probe), display.SPECTRA6[2],
                             "no FIXTURE DATA band on a card built from the "
                             "synthetic ledger")

    @unittest.skipUnless(HAVE_RENDER, "Pillow / display.py unavailable")
    def test_an_unstamped_card_has_no_band(self):
        """The other direction -- without it the probe above would pass on any
        card that happened to have ink at the top."""
        payload = _ledger(2026, [_entry("Aa bb", 2024, {20: 5}, "2024-01-08"),
                                 _entry("Aa bb", 2025, {20: 7}, "2025-01-06")])
        card = almanac_preview.build_card(payload, 20, fixture=False)
        with tempfile.TemporaryDirectory() as tmp:
            png = os.path.join(tmp, "card.png")
            almanac_preview.render_card(card, png)
            img = Image.open(png).convert("RGB")
            probe = (display.PANEL_W // 2, almanac_preview.FIXTURE_BAND_H // 2)
            self.assertEqual(img.getpixel(probe), display.SPECTRA6[0])

    @unittest.skipUnless(HAVE_RENDER, "Pillow / display.py unavailable")
    def test_cli_end_to_end_on_the_committed_fixture(self):
        with tempfile.TemporaryDirectory() as tmp:
            png = os.path.join(tmp, "card.png")
            code, out, _err = _run_cli([FIXTURE, "--preview", png,
                                        "--today", "2026-12-28"])
            self.assertEqual(code, 0)
            self.assertIn("FIXTURE DATA", out)
            self.assertIn("week 52", out)          # the week-53 fold, end to end
            self.assertTrue(os.path.isfile(png))


class TheCli(unittest.TestCase):
    def test_week_and_today_together_are_refused(self):
        """Two different weeks named at once is an ambiguous card, not a
        preference to resolve silently."""
        with tempfile.TemporaryDirectory() as tmp:
            png = os.path.join(tmp, "card.png")
            code, _out, err = _run_cli([FIXTURE, "--preview", png,
                                        "--week", "20", "--today", "2026-12-28"])
            self.assertEqual(code, 2)
            self.assertFalse(os.path.exists(png))
            self.assertIn("two different weeks", err)

    def test_a_non_ledger_file_fails_loud_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "junk.json")
            png = os.path.join(tmp, "card.png")
            with open(src, "w", encoding="utf-8") as fh:
                fh.write('{"not": "a ledger"}')
            code, _out, err = _run_cli([src, "--preview", png, "--week", "20"])
            self.assertEqual(code, 5)
            self.assertFalse(os.path.exists(png))
            self.assertIn("FAILED", err)


if __name__ == "__main__":
    unittest.main()
