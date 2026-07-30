#!/usr/bin/env python3
"""Tests for phenology.py -- the per-year ledger that must survive the purge.

Same contract as tests/test_catalog.py: each test builds a fixture birds.db in a
tmp dir, runs the real script, and asserts the SPECIFIC computed value, so a test
cannot stay green if the business logic changes. Pure stdlib / unittest.

Run from ``avian/catalog/``:
    python3 -m unittest discover -s tests -v
(or ``python3 -m unittest tests.test_phenology -v``).
"""

import hashlib
import json
import os
import sqlite3
import sys
import tempfile
import unittest

# Import the script regardless of CWD / discovery method.
_CATALOG_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _CATALOG_DIR not in sys.path:
    sys.path.insert(0, _CATALOG_DIR)

import phenology  # noqa: E402


# Relaxed fixture schema, matching the real BirdNET-Pi columns
# (scripts/createdb.sh) but without the NOT NULLs, so NULL/garbage edge cases
# are reachable.
_FIXTURE_SCHEMA = """
CREATE TABLE detections (
  Date TEXT, Time TEXT, Sci_Name TEXT, Com_Name TEXT, Confidence TEXT,
  Lat REAL, Lon REAL, Cutoff REAL, Week INTEGER, Sens REAL, Overlap REAL,
  File_Name TEXT);
"""

_COLS = ("Date", "Time", "Sci_Name", "Com_Name", "Confidence", "Week")


def _make_birds_db(path, rows):
    con = sqlite3.connect(path)
    try:
        con.executescript(_FIXTURE_SCHEMA)
        con.executemany(
            "INSERT INTO detections (%s) VALUES (%s)"
            % (", ".join(_COLS), ",".join("?" * len(_COLS))),
            rows,
        )
        con.commit()
    finally:
        con.close()


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _row(date, time, sci="Erithacus rubecula", com="European Robin", conf="0.90", week=1):
    return (date, time, sci, com, conf, week)


class YearWeekTestCase(unittest.TestCase):
    """The two clamps. Every assertion here is a date this station will actually
    emit, and every one of them breaks a naive implementation."""

    # -- 1 -----------------------------------------------------------------
    def test_iso_week_53_folds_to_52(self):
        """2026 genuinely HAS an ISO week 53 (date(2026,12,28) -> (2026,53,1)),
        and web/src/almanac.ts:113 renders only 52 cells. An unclamped peak_week
        of 53 renders nowhere at all. FAILS RED if the clamp is reverted to a raw
        isocalendar()[1]."""
        self.assertEqual(phenology.year_week("2026-12-28"), (2026, 52))
        self.assertEqual(phenology.year_week("2026-12-31"), (2026, 52))

    # -- 2 -----------------------------------------------------------------
    def test_december_does_not_leak_into_week_one(self):
        """THE named bug. date(2024,12,30).isocalendar() is (2025,1,1), so a raw
        isocalendar()[1] files New Year's Eve under WEEK 1 (reading as early
        January) and an isocalendar()[0] year files it under 2025, emptying
        December out of 2024. A plain min/max clamp does NOT save this -- week 1
        is already in range -- which is exactly the point."""
        self.assertEqual(phenology.year_week("2024-12-30"), (2024, 52))
        self.assertEqual(phenology.year_week("2024-12-31"), (2024, 52))

    # -- 3 -----------------------------------------------------------------
    def test_early_january_does_not_leak_into_last_year(self):
        """Mirror image: date(2021,1,1).isocalendar() is (2020,53,5). Guards the
        second half of the clamp, which test 2 alone leaves untested."""
        self.assertEqual(phenology.year_week("2021-01-01"), (2021, 1))
        self.assertEqual(phenology.year_week("2021-01-03"), (2021, 1))

    def test_ordinary_dates_keep_their_iso_week(self):
        """The clamps must not distort the 98% case they exist to protect."""
        self.assertEqual(phenology.year_week("2024-06-02"), (2024, 22))
        self.assertEqual(phenology.year_week(None), (None, None))
        self.assertEqual(phenology.year_week("not-a-date"), (None, None))


class PhenologyLedgerTestCase(unittest.TestCase):
    BUILT_AT = "2026-07-27T00:00:00+00:00"
    LATER_AT = "2026-08-01T00:00:00+00:00"

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="phenology-test-")
        self.birds = os.path.join(self.tmp, "birds.db")
        self.out = os.path.join(self.tmp, "phenology.json")

    def _run(self, built_at=None, birds=None, out=None, extra=()):
        argv = ["--birds", birds or self.birds, "--out", out or self.out,
                "--built-at", built_at or self.BUILT_AT]
        return phenology.main(argv + list(extra))

    def _ledger(self):
        with open(self.out, encoding="utf-8") as fh:
            return json.load(fh)

    def _entries(self):
        return {(e["sci_name"], e["year"]): e for e in self._ledger()["entries"]}

    # -- 4 -----------------------------------------------------------------
    def test_year_boundary_splits_one_species_into_two_entries(self):
        """The entire deliverable in one assertion: a plate captioned 2024 must
        not borrow a 2025 detection, and 30/31 December must stay in 2024's week
        52 rather than being filed as 2025 week 1."""
        _make_birds_db(self.birds, [
            _row("2024-12-30", "07:00:00"),
            _row("2024-12-31", "08:00:00"),
            _row("2025-01-02", "09:00:00"),
        ])
        self.assertEqual(self._run(), 0)
        ent = self._entries()
        self.assertEqual(sorted(k[1] for k in ent), [2024, 2025])
        e24 = ent[("Erithacus rubecula", 2024)]
        self.assertEqual(e24["days_heard"], 2)
        self.assertEqual(e24["first_heard"], "2024-12-30 07:00:00")
        self.assertEqual(e24["last_heard"], "2024-12-31 08:00:00")
        self.assertEqual(e24["peak_week"], 52)
        e25 = ent[("Erithacus rubecula", 2025)]
        self.assertEqual(e25["days_heard"], 1)
        self.assertEqual(e25["peak_week"], 1)

    # -- 5 -- THE load-bearing test ----------------------------------------
    def test_frozen_year_survives_partially_purged_rows(self):
        """Purged rows are exactly what this ledger exists to survive.

        The purge is PARTIAL on purpose. A full purge of the year is the easy
        case -- the key simply vanishes from `computed` and any implementation
        that keeps existing-only keys passes it (that branch is covered by
        test_ledger_entry_for_a_species_gone_from_birds_db_is_never_deleted).
        The case that actually exercises THE FREEZE RULE is a closed year whose
        surviving rows would now recompute to a SMALLER number: without the rule,
        2024 quietly drops from 3 days heard to 1 and the ledger reports the
        remnant as the season. The rerun also uses a different --built-at, so a
        recomputed entry is detectable even when the counts coincide."""
        _make_birds_db(self.birds, [
            _row("2024-06-01", "06:00:00"),
            _row("2024-06-02", "06:30:00"),
            _row("2024-06-03", "07:00:00"),
            _row("2025-05-01", "05:00:00"),
        ])
        self.assertEqual(self._run(), 0)
        before = self._entries()[("Erithacus rubecula", 2024)]
        self.assertEqual(before["days_heard"], 3)

        con = sqlite3.connect(self.birds)
        try:
            con.execute("DELETE FROM detections WHERE Date IN ('2024-06-01','2024-06-02')")
            con.commit()
        finally:
            con.close()

        self.assertEqual(self._run(built_at=self.LATER_AT), 0)
        after = self._entries()[("Erithacus rubecula", 2024)]
        self.assertEqual(after["days_heard"], 3,
                         "a closed year must NOT be recomputed from the remnant")
        self.assertEqual(after["first_heard"], "2024-06-01 06:00:00")
        self.assertEqual(after, before)
        self.assertEqual(after["frozen_at"], self.BUILT_AT)

    # -- 6 -----------------------------------------------------------------
    def test_current_year_still_refreshes(self):
        """Freezing the OPEN year would freeze the ledger the day it was created
        and nobody would notice until the following January. Test 5 alone would
        happily pass a fully-frozen implementation."""
        _make_birds_db(self.birds, [_row("2025-05-01", "05:00:00")])
        self.assertEqual(self._run(), 0)
        first = self._entries()[("Erithacus rubecula", 2025)]
        self.assertEqual(first["days_heard"], 1)

        con = sqlite3.connect(self.birds)
        try:
            con.execute(
                "INSERT INTO detections (Date, Time, Sci_Name, Com_Name, Confidence, Week) "
                "VALUES ('2025-05-09','19:00:00','Erithacus rubecula','European Robin','0.9',19)")
            con.commit()
        finally:
            con.close()

        self.assertEqual(self._run(built_at=self.LATER_AT), 0)
        second = self._entries()[("Erithacus rubecula", 2025)]
        self.assertEqual(second["days_heard"], 2)
        self.assertEqual(second["last_heard"], "2025-05-09 19:00:00")
        self.assertEqual(second["frozen_at"], self.LATER_AT)

    # -- 7 -----------------------------------------------------------------
    def test_idempotent_across_repeated_rebuilds(self):
        """The timer runs this ~365x/year. Nondeterministic entry order turns a
        ledger into churn and defeats any diff-based backup (the cmp -s
        skip-if-unchanged logic in backup-accessions.sh is the precedent)."""
        _make_birds_db(self.birds, [
            _row("2024-06-01", "06:00:00"),
            _row("2025-06-01", "06:00:00", sci="Turdus merula", com="Eurasian Blackbird"),
            _row("2025-06-02", "07:00:00"),
        ])
        self.assertEqual(self._run(), 0)
        first = _sha256(self.out)
        self.assertEqual(self._run(), 0)
        self.assertEqual(_sha256(self.out), first)

    # -- 8 -----------------------------------------------------------------
    def test_corrupt_ledger_fails_loud_and_writes_nothing(self):
        """This file holds history that cannot be recomputed. Copying
        rebuild_catalog._load_accessions' degrade-to-empty would let one corrupt
        byte quietly erase every frozen year and write a clean-looking
        replacement derived from live rows only -- the single worst outcome
        available to this item."""
        _make_birds_db(self.birds, [_row("2025-05-01", "05:00:00")])
        with open(self.out, "w", encoding="utf-8") as fh:
            fh.write("{not json")
        before = _sha256(self.out)
        self.assertEqual(self._run(), 5)
        self.assertEqual(_sha256(self.out), before, "a failed run must write NOTHING")

    def test_wrong_shaped_ledger_also_fails_loud(self):
        """A valid-JSON file of the wrong shape is the same hazard as unparseable
        bytes: it must not be treated as 'no history yet'."""
        _make_birds_db(self.birds, [_row("2025-05-01", "05:00:00")])
        with open(self.out, "w", encoding="utf-8") as fh:
            json.dump({"entries": {"not": "a list"}}, fh)
        before = _sha256(self.out)
        self.assertEqual(self._run(), 5)
        self.assertEqual(_sha256(self.out), before)

    # -- 9 -----------------------------------------------------------------
    def test_missing_ledger_is_a_clean_first_run(self):
        """Test 8 must not make a fresh install fail."""
        _make_birds_db(self.birds, [_row("2025-05-01", "05:00:00")])
        self.assertFalse(os.path.exists(self.out))
        self.assertEqual(self._run(), 0)
        self.assertEqual(self._ledger()["species_years"], 1)

    # -- 10 ----------------------------------------------------------------
    def test_missing_birds_db_skips_cleanly(self):
        """A Pi that has not analysed anything yet must not go red -- there is
        nothing to freeze and nothing to lose (derive.py's precedent)."""
        rc = self._run(birds=os.path.join(self.tmp, "nope.db"))
        self.assertEqual(rc, 0)
        self.assertFalse(os.path.exists(self.out))

    # -- 11 ----------------------------------------------------------------
    def test_non_birds_excluded(self):
        """The museum's axis is birds. The cricket binomial is the only case the
        structural is_bird test misses, so gutting NON_BIRD must turn this red --
        the Dog row alone would keep it green."""
        _make_birds_db(self.birds, [
            _row("2025-05-01", "05:00:00"),
            _row("2025-05-01", "06:00:00", sci="Dog", com="Dog"),
            _row("2025-05-01", "07:00:00", sci="Power tools", com="Power tool noise"),
            _row("2025-05-01", "08:00:00", sci="Gryllus assimilis", com="Steppengrille"),
        ])
        self.assertEqual(self._run(), 0)
        names = sorted(e["sci_name"] for e in self._ledger()["entries"])
        self.assertEqual(names, ["Erithacus rubecula"])

    # -- 12 ----------------------------------------------------------------
    def test_days_heard_counts_distinct_dates_not_detections(self):
        """days_heard is the phenology signal. Conflating it with the detection
        count would make one chatty dawn look like a whole season."""
        _make_birds_db(self.birds, [
            _row("2025-05-01", "05:00:00"),
            _row("2025-05-01", "05:10:00"),
            _row("2025-05-02", "05:00:00"),
        ])
        self.assertEqual(self._run(), 0)
        e = self._entries()[("Erithacus rubecula", 2025)]
        self.assertEqual(e["days_heard"], 2)
        self.assertEqual(e["detections"], 3)

    # -- 13 ----------------------------------------------------------------
    def test_peak_week_tie_breaks_to_the_lower_week(self):
        """Determinism: without an explicit tie-break the peak week depends on
        dict order, and test 7's byte-identical rerun is the thing that breaks."""
        _make_birds_db(self.birds, [
            _row("2025-01-06", "05:00:00"),   # ISO week 2
            _row("2025-01-13", "05:00:00"),   # ISO week 3
        ])
        self.assertEqual(self._run(), 0)
        e = self._entries()[("Erithacus rubecula", 2025)]
        self.assertEqual(e["peak_week"], 2)
        self.assertEqual(e["peak_week_n"], 1)

    # -- 14 ----------------------------------------------------------------
    def test_read_only_over_birds_db(self):
        """birds.db is the irreplaceable log. Copied from test_catalog.py's
        existing read-only guard."""
        _make_birds_db(self.birds, [_row("2025-05-01", "05:00:00")])
        before = (os.path.getsize(self.birds), _sha256(self.birds))
        self.assertEqual(self._run(), 0)
        self.assertEqual((os.path.getsize(self.birds), _sha256(self.birds)), before)
        self.assertFalse(os.path.exists(self.birds + "-wal"))
        self.assertFalse(os.path.exists(self.birds + "-journal"))

    # -- 15 ----------------------------------------------------------------
    def test_unparseable_date_contributes_nothing(self):
        """rebuild_catalog.py:343-350's stated rule: silence, never a guess. The
        row still counts as a scanned source row -- it exists -- but it may not
        invent a year, a week or a coverage bound."""
        _make_birds_db(self.birds, [
            _row("2025-05-01", "05:00:00"),
            _row("not-a-date", "05:00:00"),
        ])
        self.assertEqual(self._run(), 0)
        led = self._ledger()
        self.assertEqual(led["source_rows"], 2)
        self.assertEqual(led["species_years"], 1)
        self.assertEqual(led["coverage"]["min_date"], "2025-05-01")
        self.assertEqual(led["coverage"]["max_date"], "2025-05-01")
        self.assertEqual(self._entries()[("Erithacus rubecula", 2025)]["detections"], 1)

    # -- 16 (red-team REQUIRED FIX: provenance) -----------------------------
    def test_provenance_makes_a_frozen_stump_visible(self):
        """A frozen year is UNFALSIFIABLE -- its rows are gone. Without
        provenance, `days_heard: 1` for 2024 reads as a scientific fact forever,
        indistinguishable from a full season. min_date_seen late in the year, a
        small source_rows_at_freeze, and the top-level coverage block are what
        let a future reader bound what the freeze could possibly have known."""
        _make_birds_db(self.birds, [
            _row("2024-11-04", "07:00:00"),
            _row("2025-05-01", "05:00:00"),
        ])
        self.assertEqual(self._run(), 0)
        e = self._entries()[("Erithacus rubecula", 2024)]
        self.assertEqual(e["min_date_seen"], "2024-11-04")
        self.assertEqual(e["source_rows_at_freeze"], 2)
        self.assertEqual(e["frozen_at"], self.BUILT_AT)
        cov = self._ledger()["coverage"]
        self.assertEqual(cov["min_date"], "2024-11-04")
        self.assertEqual(cov["max_date"], "2025-05-01")
        self.assertEqual(cov["years"], [2024, 2025])

    # -- 17 (red-team SILENT-FAILURE risk: dead source, live ledger) --------
    def test_zero_rows_with_a_nonempty_ledger_fails_loud(self):
        """merge_ledger would happily return the existing ledger unchanged and
        the run would print a cheerful summary -- reporting the DEATH OF THE
        SOURCE as success. The ledger is preserved either way; what must not
        happen is a green exit code over an empty birds.db."""
        _make_birds_db(self.birds, [_row("2025-05-01", "05:00:00")])
        self.assertEqual(self._run(), 0)
        before = _sha256(self.out)
        con = sqlite3.connect(self.birds)
        try:
            con.execute("DELETE FROM detections")
            con.commit()
        finally:
            con.close()
        self.assertEqual(self._run(built_at=self.LATER_AT), 5)
        self.assertEqual(_sha256(self.out), before, "the ledger must be untouched")

    def test_empty_birds_db_on_a_first_run_is_not_a_failure(self):
        """Test 17 must not make a cold start red: zero rows AND no ledger is a
        Pi that has simply not heard anything yet."""
        _make_birds_db(self.birds, [])
        self.assertEqual(self._run(), 0)
        self.assertEqual(self._ledger()["entries"], [])
        self.assertIsNone(self._ledger()["current_year"])

    # -- 18 ----------------------------------------------------------------
    def test_dry_run_writes_nothing(self):
        """The manual smoke-test path documented in the README must not mutate a
        ledger someone is inspecting."""
        _make_birds_db(self.birds, [_row("2025-05-01", "05:00:00")])
        self.assertEqual(self._run(extra=["--dry-run"]), 0)
        self.assertFalse(os.path.exists(self.out))

    # -- 19 (THE CURVE) -----------------------------------------------------
    def test_weekly_curve_is_frozen_not_just_the_peak(self):
        """The deliverable. _note_year has always accumulated a full histogram
        and _compute_entries used to keep only peak_week -- and since a closed
        year is NEVER recomputed, that discard becomes permanent the day the year
        closes. Asserting the specific cells (not merely 'a list of 52') is what
        stops a stub implementation from passing."""
        _make_birds_db(self.birds, [
            _row("2025-01-06", "05:00:00"),   # ISO week 2
            _row("2025-01-13", "05:00:00"),   # ISO week 3
            _row("2025-01-14", "06:00:00"),   # ISO week 3
            _row("2025-06-02", "06:00:00"),   # ISO week 23
        ])
        self.assertEqual(self._run(), 0)
        e = self._entries()[("Erithacus rubecula", 2025)]
        cells = e["weekly_detections"]
        self.assertEqual(len(cells), 52)
        self.assertEqual(cells[1], 1)    # week 2
        self.assertEqual(cells[2], 2)    # week 3
        self.assertEqual(cells[22], 1)   # week 23
        self.assertEqual(sum(cells), e["detections"])
        # peak_week is nothing more than this list's highest cell.
        self.assertEqual(cells[e["peak_week"] - 1], e["peak_week_n"])
        self.assertEqual(max(cells), e["peak_week_n"])

    def test_curve_index_matches_the_renderer_that_already_shipped(self):
        """CONSTRAINT 1: the frozen curve uses year_week()'s clamps verbatim, so
        cell i is ISO week i+1 -- the same `min(52, max(1, w)) - 1` arithmetic
        web/src/almanac.ts:113 ships. If the frozen curve disagreed with the
        renderer, the disagreement would become permanent the day the year
        closed. Uses the two dates the clamps exist for."""
        _make_birds_db(self.birds, [
            _row("2024-12-30", "07:00:00"),   # ISO 2025-W01, calendar 2024 -> 52
            _row("2025-01-02", "09:00:00"),   # ISO 2025-W01, calendar 2025 -> 1
        ])
        self.assertEqual(self._run(), 0)
        ent = self._entries()
        c24 = ent[("Erithacus rubecula", 2024)]["weekly_detections"]
        self.assertEqual(c24[51], 1, "30 Dec must land in 2024's LAST cell")
        self.assertEqual(c24[0], 0, "...and must not leak into cell 0 (week 1)")
        c25 = ent[("Erithacus rubecula", 2025)]["weekly_detections"]
        self.assertEqual(c25[0], 1)
        self.assertEqual(sum(c25), 1)
        # And the index the module uses is exactly week-1 across the whole range.
        for wk in (1, 2, 22, 52):
            self.assertEqual(phenology._curve_index(wk), wk - 1)

    def test_iso_week_53_lands_in_cell_52_and_is_never_dropped(self):
        """2026 genuinely has an ISO week 53 (2026-12-28 -> 2026-W53). A 53-cell
        year must fold into cell 52, not fall off the end of a 52-cell list."""
        _make_birds_db(self.birds, [
            _row("2026-12-28", "07:00:00"),
            _row("2026-12-31", "08:00:00"),
            _row("2027-01-05", "08:00:00"),   # keeps 2026 CLOSED
        ])
        self.assertEqual(self._run(), 0)
        e = self._entries()[("Erithacus rubecula", 2026)]
        self.assertEqual(e["weekly_detections"][51], 2)
        self.assertEqual(sum(e["weekly_detections"]), 2,
                         "week 53 must FOLD, never vanish")

    # -- 20 (NEGATIVE TEST of the drop guard) -------------------------------
    def test_a_week_outside_the_fold_fails_loud_in_the_builder(self):
        """The guard, called directly. This project has five recorded incidents
        of guards that could not fire, so _curve_index is asserted to actually
        RAISE rather than clamp, skip or wrap."""
        with self.assertRaises(ValueError):
            phenology._weekly_curve({53: 1})
        with self.assertRaises(ValueError):
            phenology._weekly_curve({0: 1})
        with self.assertRaises(ValueError):
            phenology._weekly_curve({-1: 1})

    def test_a_week_outside_the_fold_fails_loud_in_a_real_run(self):
        """The same guard, wired. Mutation: year_week's fold is reverted to a raw
        isocalendar()[1] -- the exact regression the two-clamp note warns about.
        The run must exit 5 having written NOTHING, rather than freezing curves
        with late December silently missing. Without _curve_index this run exits
        0 and the 53rd week is dropped forever."""
        naive = lambda s: (2026, 53) if s else (None, None)   # noqa: E731
        _make_birds_db(self.birds, [_row("2026-12-28", "07:00:00")])
        real = phenology.year_week
        phenology.year_week = naive
        try:
            self.assertEqual(self._run(), 5)
        finally:
            phenology.year_week = real
        self.assertFalse(os.path.exists(self.out), "a failed run must write NOTHING")
        # ...and with the real fold restored, the very same row succeeds.
        self.assertEqual(self._run(), 0)
        self.assertEqual(
            self._entries()[("Erithacus rubecula", 2026)]["weekly_detections"][51], 1)

    # -- 21 (THE EFFORT FIELD) ----------------------------------------------
    def test_effort_field_counts_distinct_dates_with_any_detection(self):
        """CONSTRAINT 2. birds.db records DETECTIONS, not uptime, so the field is
        named for exactly what it counts: distinct dates that produced at least
        one detection of ANY class. Non-bird rows COUNT -- a Dog row still proves
        the recorder wrote something that day -- while two rows on one date count
        once. Asserting both halves is what keeps this from silently degrading
        into a per-species row count (which days_heard/detections already are)."""
        _make_birds_db(self.birds, [
            _row("2025-06-02", "05:00:00"),                       # wk 23, robin
            _row("2025-06-02", "05:10:00"),                       # same DATE
            _row("2025-06-03", "06:00:00", sci="Dog", com="Dog"),  # wk 23, NOT a bird
            _row("2025-06-10", "06:00:00"),                       # wk 24
        ])
        self.assertEqual(self._run(), 0)
        e = self._entries()[("Erithacus rubecula", 2025)]
        eff = e["station_weekly_dates_with_detections"]
        self.assertEqual(len(eff), 52)
        self.assertEqual(eff[22], 2, "2 distinct dates in week 23, one of them "
                                     "evidenced only by a non-bird row")
        self.assertEqual(eff[23], 1)
        self.assertEqual(sum(eff), 3, "3 distinct dates produced detections")
        # It is STATION-wide, so the robin's own week-23 curve is smaller.
        self.assertEqual(e["weekly_detections"][22], 2)
        self.assertEqual(e["days_heard"], 2, "the robin was heard on 2 of the "
                                             "station's 3 detection-dates")

    def test_effort_field_is_station_wide_and_identical_across_species(self):
        """The field answers 'did the recorder produce rows that week', not
        'was this bird about'. If it were computed per species it would be
        useless as the curve's denominator -- a zero cell could never be told
        apart from a dead station."""
        _make_birds_db(self.birds, [
            _row("2025-06-02", "05:00:00"),
            _row("2025-06-09", "05:00:00", sci="Turdus merula", com="Eurasian Blackbird"),
        ])
        self.assertEqual(self._run(), 0)
        ent = self._entries()
        robin = ent[("Erithacus rubecula", 2025)]
        blackbird = ent[("Turdus merula", 2025)]
        self.assertEqual(robin["station_weekly_dates_with_detections"],
                         blackbird["station_weekly_dates_with_detections"])
        self.assertEqual(robin["station_weekly_dates_with_detections"][22], 1)
        self.assertEqual(robin["station_weekly_dates_with_detections"][23], 1)
        # The robin was NOT heard in week 24 even though the station had a date
        # that week: absence of the bird, not absence of the station.
        self.assertEqual(robin["weekly_detections"][23], 0)

    def test_effort_field_does_not_leak_across_years(self):
        """A per-year field built from a (year, week) key: 2024's December dates
        must not appear in 2025's denominator."""
        _make_birds_db(self.birds, [
            _row("2024-12-30", "07:00:00"),
            _row("2025-01-02", "09:00:00"),
            _row("2025-01-03", "09:00:00"),
        ])
        self.assertEqual(self._run(), 0)
        ent = self._entries()
        eff24 = ent[("Erithacus rubecula", 2024)]["station_weekly_dates_with_detections"]
        eff25 = ent[("Erithacus rubecula", 2025)]["station_weekly_dates_with_detections"]
        self.assertEqual(sum(eff24), 1)
        self.assertEqual(eff24[51], 1)
        self.assertEqual(sum(eff25), 2)
        self.assertEqual(eff25[0], 2)

    def test_effort_field_is_named_for_what_it_counts(self):
        """CONSTRAINT 2, as a contract test. 'Coverage'/'uptime'/'listening'
        names would license the fabricated-absence sentence this project has
        already shipped three times: a March with the microphone unplugged and a
        genuinely silent March are IDENTICAL in birds.db. This test exists to go
        red if a future rename makes the field sound like uptime."""
        _make_birds_db(self.birds, [_row("2025-06-02", "05:00:00")])
        self.assertEqual(self._run(), 0)
        keys = set(self._entries()[("Erithacus rubecula", 2025)])
        self.assertIn("station_weekly_dates_with_detections", keys)
        for k in keys:
            low = k.lower()
            self.assertNotIn("coverage", low)
            self.assertNotIn("uptime", low)
            self.assertNotIn("listening", low)
        notes = self._ledger()["notes"]["effort"]
        self.assertIn("distinct dates", notes.lower())
        self.assertIn("NOT listening coverage", notes)

    # -- 22 (CONSTRAINT 3: strictly additive) -------------------------------
    def test_ledger_written_before_the_curve_existed_still_round_trips(self):
        """CONSTRAINT 3. _load_ledger validates only sci_name+year, so an entry
        frozen before weekly_detections existed must load, merge and survive
        BYTE-FOR-BYTE -- not be dropped, not be crashed on, and above all not be
        'upgraded' from rows that no longer exist. The 13 fields below are the
        exact shape measured on the live Pi's phenology.json (built 2026-07-29).
        """
        old_entry = {
            "sci_name": "Turdus merula",
            "com_name": "Eurasian Blackbird",
            "slug": "turdus-merula",
            "year": 2025,
            "first_heard": "2025-06-01 06:00:00",
            "last_heard": "2025-06-30 07:00:00",
            "days_heard": 12,
            "detections": 44,
            "peak_week": 24,
            "peak_week_n": 9,
            "source_rows_at_freeze": 3803,
            "min_date_seen": "2025-06-01",
            "frozen_at": "2025-12-31T02:30:00+00:00",
        }
        with open(self.out, "w", encoding="utf-8") as fh:
            json.dump({"version": 1, "built_at": "2025-12-31T02:30:00+00:00",
                       "current_year": 2025, "entries": [old_entry]}, fh)
        _make_birds_db(self.birds, [
            _row("2025-06-01", "06:00:00", sci="Turdus merula", com="Eurasian Blackbird"),
            _row("2026-06-01", "06:00:00"),
        ])
        self.assertEqual(self._run(), 0, "an old-shaped ledger must not crash")
        ent = self._entries()
        self.assertEqual(ent[("Turdus merula", 2025)], old_entry,
                         "a closed entry frozen before the curve existed must "
                         "survive byte-for-byte, curve-less")
        self.assertNotIn("weekly_detections", ent[("Turdus merula", 2025)])
        # ...while the OPEN year gets the new fields.
        fresh = ent[("Erithacus rubecula", 2026)]
        self.assertEqual(len(fresh["weekly_detections"]), 52)
        self.assertEqual(len(fresh["station_weekly_dates_with_detections"]), 52)
        # ...and a mixed-shape ledger still reruns byte-identically.
        first = _sha256(self.out)
        self.assertEqual(self._run(), 0)
        self.assertEqual(_sha256(self.out), first)

    def test_ledger_entry_for_a_species_gone_from_birds_db_is_never_deleted(self):
        """The freeze rule's fourth branch, stated on its own: an entry with no
        surviving rows AT ALL (not merely a purged year) is kept verbatim."""
        _make_birds_db(self.birds, [
            _row("2024-06-01", "06:00:00", sci="Turdus merula", com="Eurasian Blackbird"),
            _row("2025-06-01", "06:00:00"),
        ])
        self.assertEqual(self._run(), 0)
        gone = self._entries()[("Turdus merula", 2024)]
        con = sqlite3.connect(self.birds)
        try:
            con.execute("DELETE FROM detections WHERE Sci_Name='Turdus merula'")
            con.commit()
        finally:
            con.close()
        self.assertEqual(self._run(built_at=self.LATER_AT), 0)
        self.assertEqual(self._entries()[("Turdus merula", 2024)], gone)


if __name__ == "__main__":
    unittest.main(verbosity=2)
