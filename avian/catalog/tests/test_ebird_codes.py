#!/usr/bin/env python3
"""Tests for the eBird taxon-code table -- the source of the wall's outbound
catalogue link.

WHY THIS FILE EXISTS. The link used to be built from the binomial:
``media.ebird.org/catalog?q=<scientific name>``. eBird retired that parameter
and now answers 301 with ``Location: /catalog``, so every "ebird" chip on the
museum wall opened the unfiltered global archive -- 97.6M photos, no species.
Nothing in the response said so: a real species and a bogus one returned
byte-identical bodies, both HTTP 200. Only a human clicking a plate found it.

The replacement is keyed on eBird's taxon CODE, and a wrong code fails just as
silently as the old link did (``bluti`` is not the Blue Tit -- ``blutit`` is --
and it renders the generic archive at 200; ``rerpar1`` is a real code for a
Red-rumped Parrot). So codes are READ FROM THE TABLE and never derived, and
these tests pin both the parse and the counts it produces.

Pure stdlib / unittest. Run from ``avian/catalog/``:
    python3 -m unittest discover -s tests -v
"""

import json
import os
import sqlite3
import sys
import tempfile
import unittest

# Import the builder regardless of CWD / discovery method.
_CATALOG_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _CATALOG_DIR not in sys.path:
    sys.path.insert(0, _CATALOG_DIR)

import rebuild_catalog  # noqa: E402

_REPO = os.path.abspath(os.path.join(_CATALOG_DIR, "..", ".."))
_REAL_TABLE = os.path.join(_REPO, "scripts", "ebird.php")

# The shipped table, measured 2026-08-02. These are PINNED COUNTS, not
# thresholds: if the table is ever regenerated the numbers must be re-measured
# deliberately, because a silent shrink is exactly how the wall would lose its
# links again without anything turning red.
_TOTAL_PAIRS = 6522
_NULL_ENTRIES = 103
_USABLE_CODES = 6419

_FIXTURE_PHP = """<?php

$ebirds = [
  "Turdus merula" => "eurbla",
  "Erithacus rubecula" => "eurrob1",
  "Acris crepitans" => "null",
  "Cyanistes caeruleus" => "blutit",
  "Alouatta pigra" => "null",
];
"""


class EbirdTableParseTest(unittest.TestCase):
    """The parser, against a fixture whose every branch is exercised."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ebird-test-")
        self.path = os.path.join(self.tmp, "ebird.php")
        with open(self.path, "w", encoding="utf-8") as fh:
            fh.write(_FIXTURE_PHP)

    def test_real_pairs_are_parsed(self):
        codes = rebuild_catalog.load_ebird_codes(self.path)
        self.assertEqual(codes["Turdus merula"], "eurbla")
        self.assertEqual(codes["Erithacus rubecula"], "eurrob1")
        self.assertEqual(codes["Cyanistes caeruleus"], "blutit")

    def test_the_null_sentinel_is_dropped_not_carried(self):
        """THE TRAP. The table spells "no eBird taxon" as the four-character
        STRING "null", never PHP null. Carried through, it would mint
        ``?taxonCode=null`` -- a URL that returns 200 and shows the whole
        archive, indistinguishable from a working link."""
        codes = rebuild_catalog.load_ebird_codes(self.path)
        self.assertNotIn("Acris crepitans", codes)
        self.assertNotIn("Alouatta pigra", codes)
        self.assertNotIn("null", codes.values())
        self.assertEqual(len(codes), 3)  # 5 entries, 2 of them sentinels

    def test_absent_table_degrades_to_silence_and_never_raises(self):
        """An unreadable table costs the link and nothing else. The nightly
        rebuild must not die because an optional lookup went missing."""
        missing = os.path.join(self.tmp, "does-not-exist.php")
        self.assertFalse(os.path.exists(missing))
        self.assertEqual(rebuild_catalog.load_ebird_codes(missing), {})
        # A directory is the other way this call can fail at the OS layer.
        self.assertEqual(rebuild_catalog.load_ebird_codes(self.tmp), {})

    def test_parser_can_actually_fail(self):
        """Prove the probe can return a negative -- a parser that returned {}
        for everything would pass every assertion above about absence."""
        empty = os.path.join(self.tmp, "empty.php")
        with open(empty, "w", encoding="utf-8") as fh:
            fh.write("<?php\n$ebirds = [];\n")
        self.assertEqual(rebuild_catalog.load_ebird_codes(empty), {})
        # ...and the fixture with content does NOT return {}.
        self.assertNotEqual(rebuild_catalog.load_ebird_codes(self.path), {})

    def test_env_override_wins(self):
        """CHRISTINA_EBIRD_CODES is the path indirection that lets a test point
        the builder at a fixture -- the same shape as CHRISTINA_BIRDS_DB."""
        prev = os.environ.get("CHRISTINA_EBIRD_CODES")
        os.environ["CHRISTINA_EBIRD_CODES"] = self.path
        try:
            self.assertEqual(rebuild_catalog.resolve_ebird_table(_REPO), self.path)
        finally:
            if prev is None:
                os.environ.pop("CHRISTINA_EBIRD_CODES", None)
            else:
                os.environ["CHRISTINA_EBIRD_CODES"] = prev
        # Without the override it resolves to the table shipped in the repo.
        self.assertEqual(rebuild_catalog.resolve_ebird_table(_REPO), _REAL_TABLE)


class RealEbirdTableTest(unittest.TestCase):
    """The table that actually ships, pinned by count and by spot-check."""

    def test_the_table_is_committed_to_this_repo(self):
        """Not a BirdNET-Pi-only file: it ships with a fresh clone, which is why
        the builder may depend on it without a new external coupling."""
        self.assertTrue(os.path.isfile(_REAL_TABLE), _REAL_TABLE)

    def test_pinned_counts(self):
        codes = rebuild_catalog.load_ebird_codes(_REAL_TABLE)
        self.assertEqual(len(codes), _USABLE_CODES)
        with open(_REAL_TABLE, encoding="utf-8") as fh:
            pairs = rebuild_catalog._EBIRD_RE.findall(fh.read())
        self.assertEqual(len(pairs), _TOTAL_PAIRS)
        self.assertEqual(_TOTAL_PAIRS - _USABLE_CODES, _NULL_ENTRIES)

    def test_known_mappings(self):
        """Spot-checks against codes verified live against media.ebird.org on
        2026-08-02 -- each returned a species-specific page title."""
        codes = rebuild_catalog.load_ebird_codes(_REAL_TABLE)
        for sci, code in (
            ("Turdus merula", "eurbla"),
            ("Erithacus rubecula", "eurrob1"),
            ("Cyanistes caeruleus", "blutit"),
            ("Apus apus", "comswi"),
            ("Psittacula krameri", "rorpar"),
        ):
            self.assertEqual(codes.get(sci), code, sci)

    def test_every_code_matches_the_shape_the_frontend_enforces(self):
        """web/src/ebird.ts refuses anything outside /^[a-z0-9]{4,10}$/. If the
        table ever carried a code outside that window the link would vanish
        silently, so the two sides are pinned against each other here."""
        import re

        shape = re.compile(r"^[a-z0-9]{4,10}$")
        codes = rebuild_catalog.load_ebird_codes(_REAL_TABLE)
        bad = sorted(c for c in codes.values() if not shape.match(c))
        self.assertEqual(bad, [], "codes the frontend would silently drop")
        # And the shape test is not vacuous: it rejects a binomial and the
        # sentinel, which are the two things that must never become a link.
        self.assertIsNone(shape.match("Turdus merula"))
        self.assertIsNotNone(shape.match("null"))  # why ebird.ts needs BOTH tests


class SpeciesJsonCarriesTheCodeTest(unittest.TestCase):
    """End to end: the field must survive into the one file the frontend reads.

    This is the half that a builder-only change would miss. `normalize()` in
    web/src/catalog.ts constructs an explicit object, so a key the builder emits
    but the frontend does not name is silently dropped -- and a key the frontend
    names but the builder never emits is silently null. Both sides must land.
    """

    ROWS = [
        ("2024-06-01", "06:00:00", "Turdus merula", "Eurasian Blackbird", "0.91", 22),
        ("2024-06-02", "07:00:00", "Cyanistes caeruleus", "Eurasian Blue Tit", "0.93", 23),
        # A real bird the fixture table has no code for -> ebird_code must be
        # null, and the wall must render no chip rather than guess one.
        ("2024-06-03", "08:00:00", "Pica pica", "Eurasian Magpie", "0.95", 23),
    ]
    SCHEMA = (
        "CREATE TABLE detections (Date TEXT, Time TEXT, Sci_Name TEXT, "
        "Com_Name TEXT, Confidence TEXT, Week INTEGER, File_Name TEXT);"
    )
    COLS = ("Date", "Time", "Sci_Name", "Com_Name", "Confidence", "Week")

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ebird-e2e-")
        self.birds = os.path.join(self.tmp, "birds.db")
        self.out = os.path.join(self.tmp, "christina.db")
        self.assets = os.path.join(self.tmp, "assets")
        os.makedirs(self.assets)
        con = sqlite3.connect(self.birds)
        try:
            con.executescript(self.SCHEMA)
            con.executemany(
                "INSERT INTO detections (%s) VALUES (%s)"
                % (", ".join(self.COLS), ",".join("?" * len(self.COLS))),
                self.ROWS,
            )
            con.commit()
        finally:
            con.close()
        table = os.path.join(self.tmp, "ebird.php")
        with open(table, "w", encoding="utf-8") as fh:
            fh.write(_FIXTURE_PHP)
        self._env = {
            k: os.environ.get(k)
            for k in ("CHRISTINA_EBIRD_CODES", "CHRISTINA_DISK_EXCLUDE")
        }
        os.environ["CHRISTINA_EBIRD_CODES"] = table
        # Never let the suite touch the live purge-exclude file on the Pi.
        os.environ["CHRISTINA_DISK_EXCLUDE"] = os.path.join(self.tmp, "exclude.txt")

    def tearDown(self):
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def _species_json(self):
        rebuild_catalog.build_catalog(
            self.birds, self.out, assets_dir=self.assets, built_at="2024-06-04T00:00:00Z"
        )
        with open(os.path.join(self.tmp, "species.json"), encoding="utf-8") as fh:
            return {r["sci_name"]: r for r in json.load(fh)}

    def test_the_code_reaches_species_json(self):
        rows = self._species_json()
        self.assertEqual(rows["Turdus merula"]["ebird_code"], "eurbla")
        self.assertEqual(rows["Cyanistes caeruleus"]["ebird_code"], "blutit")

    def test_a_species_with_no_code_publishes_null_not_a_guess(self):
        """The honest degrade. Never a derived code, never the binomial, never
        the key omitted -- an explicit null the frontend can act on."""
        rows = self._species_json()
        self.assertIn("ebird_code", rows["Pica pica"])
        self.assertIsNone(rows["Pica pica"]["ebird_code"])


if __name__ == "__main__":
    unittest.main()
