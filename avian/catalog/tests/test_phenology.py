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
