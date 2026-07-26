#!/usr/bin/env python3
"""Tests for rebuild_catalog -- they EXERCISE the derivation, not just "it ran".

Each test builds a fixture birds.db in a tmp dir, runs the real builder, then
asserts the SPECIFIC computed value (a timestamp, a count, an art_status) so a
test cannot stay green if the business logic changes. Pure stdlib / unittest.

Run from ``avian/catalog/``:
    python3 -m unittest discover -s tests -v
(or ``python3 -m unittest tests.test_catalog`` -- this dir is a package).
"""

import hashlib
import json
import os
import sqlite3
import sys
import tempfile
import unittest
import urllib.parse
import urllib.request

# Import the builder regardless of CWD / discovery method.
_CATALOG_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _CATALOG_DIR not in sys.path:
    sys.path.insert(0, _CATALOG_DIR)

import rebuild_catalog  # noqa: E402


# Fixture detections table -- relaxed (no NOT NULL, Confidence as TEXT) so we
# can exercise the NULL/garbage Com_Name and text-Confidence edge cases. The
# column names match the real BirdNET-Pi schema (scripts/createdb.sh).
_FIXTURE_SCHEMA = """
CREATE TABLE detections (
  Date TEXT, Time TEXT, Sci_Name TEXT, Com_Name TEXT, Confidence TEXT,
  Lat REAL, Lon REAL, Cutoff REAL, Week INTEGER, Sens REAL, Overlap REAL,
  File_Name TEXT);
"""

# (Date, Time, Sci_Name, Com_Name, Confidence, Week)
_ROWS = [
    # Robin: detected (sub-confident) on day A 06:xx, confident on day B 05:xx,
    # plus a duplicate-hour confident hit on day B for count/rollup checks.
    ("2024-06-01", "06:14:33", "Turdus migratorius", "American Robin", "0.55", 22),
    ("2024-06-02", "05:02:10", "Turdus migratorius", "American Robin", "0.91", 23),
    ("2024-06-02", "05:30:00", "Turdus migratorius", "American Robin", "0.95", 23),
    # Dog: BirdNET non-bird class (Sci_Name == Com_Name, single word).
    ("2024-06-01", "07:00:00", "Dog", "Dog", "0.99", 22),
    # Blue Jay: a real bird with NO local art in this fixture's asset dir.
    ("2024-06-03", "08:15:00", "Cyanocitta cristata", "Blue Jay", "0.88", 23),
    # Garbage Com_Name (NULL) on a real bird -> must not crash; is_bird from sci.
    ("2024-06-03", "09:00:00", "Spinus tristis", None, "garbage", 23),
    # Multi-word NON_BIRD override cases -- Sci_Name HAS a space AND differs
    # from Com_Name, so the structural heuristic alone would let them through;
    # only the NON_BIRD set excludes them. These two rows make the NON_BIRD
    # branch fail RED if the set is gutted (the Dog row only covers Sci==Com).
    #   * "Gryllus assimilis"/"Steppengrille": a BirdNET V2.4 cricket binomial
    #     translated by 5 shipped locales (de here), so Sci != Com on those Pis.
    #   * "Power tools"/"Power tool noise": anthropogenic multi-word class.
    ("2024-06-01", "12:00:00", "Gryllus assimilis", "Steppengrille", "0.95", 22),
    ("2024-06-01", "12:30:00", "Power tools", "Power tool noise", "0.95", 22),
]


def _make_birds_db(path, rows):
    con = sqlite3.connect(path)
    try:
        con.executescript(_FIXTURE_SCHEMA)
        con.executemany(
            "INSERT INTO detections "
            "(Date, Time, Sci_Name, Com_Name, Confidence, Week) "
            "VALUES (?,?,?,?,?,?)",
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


def _fetch_species(db_path, sci):
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        return con.execute(
            "SELECT * FROM species WHERE sci_name=?", (sci,)
        ).fetchone()
    finally:
        con.close()


def _file_url(path):
    return urllib.parse.urljoin("file:", urllib.request.pathname2url(os.path.abspath(path)))


class CatalogTestCase(unittest.TestCase):
    BUILT_AT = "2024-06-04T00:00:00+00:00"

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="catalog-test-")
        self.birds = os.path.join(self.tmp, "birds.db")
        self.assets = os.path.join(self.tmp, "assets")
        self.out = os.path.join(self.tmp, "christina.db")
        os.makedirs(self.assets)
        # Bundled art for the Robin only: base pose + alt pose "-2".
        for fn in ("turdus-migratorius.png", "turdus-migratorius-2.png"):
            with open(os.path.join(self.assets, fn), "wb") as fh:
                fh.write(b"\x89PNG\r\n")  # token bytes; the scan is name-based
        _make_birds_db(self.birds, _ROWS)

    def _build(self, **kw):
        kw.setdefault("assets_dir", self.assets)
        kw.setdefault("built_at", self.BUILT_AT)
        return rebuild_catalog.build_catalog(self.birds, self.out, **kw)

    def _species_json(self):
        with open(os.path.join(self.tmp, "species.json"), encoding="utf-8") as fh:
            return json.load(fh)

    def _accessions(self):
        with open(os.path.join(self.tmp, "accessions.json"), encoding="utf-8") as fh:
            return json.load(fh)

    # -- 1. first_detected vs first_confident ------------------------------
    def test_robin_first_detected_vs_confident(self):
        self._build()
        robin = _fetch_species(self.out, "Turdus migratorius")
        self.assertIsNotNone(robin)
        # Sub-confident sighting on day A is the first *detection*.
        self.assertTrue(robin["first_detected"].startswith("2024-06-01"))
        self.assertEqual(robin["first_detected"], "2024-06-01 06:14:33")
        # First >=0.80 hit is on day B -- distinct from first_detected.
        self.assertTrue(robin["first_confident"].startswith("2024-06-02"))
        self.assertEqual(robin["first_confident"], "2024-06-02 05:02:10")
        self.assertEqual(robin["last_detected"], "2024-06-02 05:30:00")
        self.assertEqual(robin["is_bird"], 1)
        self.assertEqual(robin["genus"], "Turdus")
        self.assertEqual(robin["detection_count"], 3)
        self.assertEqual(robin["confident_count"], 2)
        self.assertAlmostEqual(robin["max_confidence"], 0.95)
        # slug is keyed on Sci_Name (the bundled-asset convention), not Com_Name.
        self.assertEqual(robin["slug"], "turdus-migratorius")
        # birdnet_label is "<Sci>_<Com>".
        self.assertEqual(robin["birdnet_label"], "Turdus migratorius_American Robin")
        slugs = [r["sci_name"] for r in self._species_json()]
        self.assertIn("Turdus migratorius", slugs)

    # -- 2. Dog is a non-bird (Sci_Name == Com_Name path) ------------------
    def test_dog_excluded(self):
        self._build()
        dog = _fetch_species(self.out, "Dog")
        self.assertIsNotNone(dog)            # present in species...
        self.assertEqual(dog["is_bird"], 0)  # ...but flagged non-bird
        self.assertIsNone(dog["genus"])
        names = [r["sci_name"] for r in self._species_json()]
        self.assertNotIn("Dog", names)       # ...and absent from species.json

    # -- 2b. NON_BIRD override: multi-word / locale-de-synced binomials ----
    def test_non_bird_multiword_override(self):
        """The ONLY guard for non-bird classes whose Sci_Name has a space AND
        differs from Com_Name. The structural heuristic passes them, so without
        the NON_BIRD set these would be published as birds. Gutting NON_BIRD
        (e.g. ``NON_BIRD=set()``) MUST turn this test red -- the Dog test alone
        keeps green because Dog hits the Sci==Com path instead."""
        self._build()
        # Cricket binomial whose common name a locale translates (de here):
        # Sci="Gryllus assimilis" != Com="Steppengrille", contains a space.
        cricket = _fetch_species(self.out, "Gryllus assimilis")
        self.assertIsNotNone(cricket)              # cataloged...
        self.assertEqual(cricket["is_bird"], 0)    # ...but flagged non-bird
        self.assertIsNone(cricket["genus"])        # no genus for non-birds
        # Anthropogenic multi-word class, same branch.
        tools = _fetch_species(self.out, "Power tools")
        self.assertIsNotNone(tools)
        self.assertEqual(tools["is_bird"], 0)
        self.assertIsNone(tools["genus"])
        # Neither is published to species.json (birds only).
        names = [r["sci_name"] for r in self._species_json()]
        self.assertNotIn("Gryllus assimilis", names)
        self.assertNotIn("Power tools", names)

    # -- 3. rollups across dates / hours / weeks ---------------------------
    def test_rollups(self):
        self._build()
        con = sqlite3.connect(self.out)
        try:
            daily = dict(con.execute(
                "SELECT date, n FROM daily_counts WHERE sci_name=? ORDER BY date",
                ("Turdus migratorius",)).fetchall())
            hours = dict(con.execute(
                "SELECT hour, n FROM hour_buckets WHERE sci_name=? ORDER BY hour",
                ("Turdus migratorius",)).fetchall())
            weeks = dict(con.execute(
                "SELECT week, n FROM week_species WHERE sci_name=? ORDER BY week",
                ("Turdus migratorius",)).fetchall())
        finally:
            con.close()
        # Robin spans 2 distinct dates.
        self.assertEqual(set(daily.keys()), {"2024-06-01", "2024-06-02"})
        self.assertEqual(daily["2024-06-01"], 1)
        self.assertEqual(daily["2024-06-02"], 2)   # two hits that day
        # Hour parsed from HH:MM:SS; 05:02 and 05:30 collapse to hour 5 (n=2).
        self.assertEqual(hours[6], 1)
        self.assertEqual(hours[5], 2)
        # Weeks derive from the Date column's ISO week, NOT the Week column
        # (BirdNET's Week uses the analyzer's 48-week scheme — trusting it
        # would drift the phenology ribbon's calendar axis). The fixture's
        # Week values (22/23/23) deliberately DISAGREE with the dates: both
        # 2024-06-01 and 2024-06-02 fall in ISO week 22, so all 3 robin
        # detections must land there — proving the column is ignored.
        self.assertEqual(weeks, {22: 3})

    # -- 4. art_status by scan ---------------------------------------------
    def test_art_status(self):
        self._build()
        robin = _fetch_species(self.out, "Turdus migratorius")
        self.assertEqual(robin["art_status"], "ready")
        self.assertEqual(robin["art_source"], "bundled")
        self.assertEqual(json.loads(robin["poses"]), ["1", "2"])
        # A bird with no asset and no manifest -> none.
        jay = _fetch_species(self.out, "Cyanocitta cristata")
        self.assertEqual(jay["art_status"], "none")
        self.assertIsNone(jay["art_source"])
        self.assertEqual(json.loads(jay["poses"]), [])

    def test_art_status_autogen_via_manifest(self):
        # A slug present in the manifest but not on local disk -> autogen.
        manifest = os.path.join(self.tmp, "manifest.json")
        with open(manifest, "w", encoding="utf-8") as fh:
            json.dump({"slugs": ["cyanocitta-cristata"]}, fh)
        self._build(manifest_url=_file_url(manifest))
        jay = _fetch_species(self.out, "Cyanocitta cristata")
        self.assertEqual(jay["art_status"], "ready")
        self.assertEqual(jay["art_source"], "autogen")

    def test_manifest_unreachable_does_not_crash(self):
        """A dead manifest must still PUBLISH a catalog (that guarantee is
        load-bearing: a partial catalog beats a blank wall) -- but it must NOT
        claim the art is absent. It does not know."""
        bad = _file_url(os.path.join(self.tmp, "does-not-exist.json"))
        result = self._build(manifest_url=bad)
        self.assertGreater(result["species"], 0)
        self.assertFalse(result["manifest_answered"])

    def test_manifest_unreachable_says_unknown_not_none(self):
        """REGRESSION (2026-07-02..26): an unanswered manifest labelled 40 of 47
        species 'none' while their art was serving fine. 'none' is a claim we
        had no basis for. The honest value is 'unknown'.

        This test previously asserted 'none' and therefore CERTIFIED the bug --
        any correct fix would have failed it. Asserting the specific string is
        the point: it is the difference between "we checked, there is no art"
        and "we could not check"."""
        bad = _file_url(os.path.join(self.tmp, "does-not-exist.json"))
        self._build(manifest_url=bad)
        jay = _fetch_species(self.out, "Cyanocitta cristata")
        self.assertEqual(jay["art_status"], "unknown")
        # The bundled-art species is unaffected: local disk answered for it.
        robin = _fetch_species(self.out, "Turdus migratorius")
        self.assertEqual(robin["art_status"], "ready")
        self.assertEqual(robin["art_source"], "bundled")

    def test_no_manifest_url_still_means_none(self):
        """Bundled-only install: the operator supplied no manifest, so nothing
        was left unanswered and 'none' IS the honest answer. Guards against
        over-correcting every miss into 'unknown'."""
        result = self._build()
        self.assertTrue(result["manifest_answered"])
        jay = _fetch_species(self.out, "Cyanocitta cristata")
        self.assertEqual(jay["art_status"], "none")

    def test_manifest_wrong_shape_is_unanswered(self):
        """A 200 carrying the wrong JSON shape is a failure, not an empty
        answer -- the old code read `{"birds": [...]}` as "zero slugs"."""
        wrong = os.path.join(self.tmp, "wrong-shape.json")
        with open(wrong, "w", encoding="utf-8") as fh:
            json.dump({"birds": ["cyanocitta-cristata"]}, fh)
        result = self._build(manifest_url=_file_url(wrong))
        self.assertFalse(result["manifest_answered"])
        jay = _fetch_species(self.out, "Cyanocitta cristata")
        self.assertEqual(jay["art_status"], "unknown")

    def test_main_exits_nonzero_on_unanswered_manifest(self):
        """The incident was invisible because this path exited 0 behind a green
        systemd unit. A degraded catalog must now FAIL LOUD while still having
        published."""
        bad = _file_url(os.path.join(self.tmp, "does-not-exist.json"))
        rc = rebuild_catalog.main([
            "--birds", self.birds, "--out", self.out, "--assets", self.assets,
            "--manifest-url", bad, "--built-at", self.BUILT_AT,
        ])
        self.assertEqual(rc, 3)
        # ...and the catalog still exists, degraded but published.
        self.assertTrue(os.path.isfile(self.out))
        jay = _fetch_species(self.out, "Cyanocitta cristata")
        self.assertEqual(jay["art_status"], "unknown")

    def test_main_exits_nonzero_on_empty_manifest(self):
        """An empty slug list from a reachable manifest is almost never real
        (birdgen ships ~290). Treat it as a fault, not as 'no art anywhere'."""
        empty = os.path.join(self.tmp, "empty.json")
        with open(empty, "w", encoding="utf-8") as fh:
            json.dump({"slugs": []}, fh)
        rc = rebuild_catalog.main([
            "--birds", self.birds, "--out", self.out, "--assets", self.assets,
            "--manifest-url", _file_url(empty), "--built-at", self.BUILT_AT,
        ])
        self.assertEqual(rc, 3)

    def test_main_exits_zero_on_healthy_manifest(self):
        """The happy path must stay quiet -- otherwise the loud failure above
        becomes noise the operator learns to ignore."""
        good = os.path.join(self.tmp, "good.json")
        with open(good, "w", encoding="utf-8") as fh:
            json.dump({"slugs": ["cyanocitta-cristata"]}, fh)
        rc = rebuild_catalog.main([
            "--birds", self.birds, "--out", self.out, "--assets", self.assets,
            "--manifest-url", _file_url(good), "--built-at", self.BUILT_AT,
        ])
        self.assertEqual(rc, 0)
        jay = _fetch_species(self.out, "Cyanocitta cristata")
        self.assertEqual(jay["art_status"], "ready")
        self.assertEqual(jay["art_source"], "autogen")

    # -- 4b. species.json sort order ---------------------------------------
    def test_species_json_sort_order(self):
        """Birds sorted by first_confident then com_name; never-confident birds
        sort LAST via the ￿ sentinel. Robin (confident 2024-06-02) before Jay
        (2024-06-03) before the never-confident finch (None). Catches both a
        com_name-only sort and an inverted sentinel."""
        self._build()
        order = [r["sci_name"] for r in self._species_json()]
        self.assertEqual(
            order,
            ["Turdus migratorius", "Cyanocitta cristata", "Spinus tristis"],
        )

    # -- 4c. species.json row shape AND values -----------------------------
    def test_species_json_row_shape_and_values(self):
        """species.json must carry EXACTLY the CANON fields with the right
        values -- no is_bird/genus/confident_count leakage, no wrong-field
        aliasing (e.g. last_detected written into first_confident). The two
        additive fields land together: `accession` (Robin is the earliest
        confident bird -> No. 1) and `weeks` (Date-derived ISO week — both
        fixture dates are week 22, whatever the Week column claims)."""
        self._build()
        robin = next(r for r in self._species_json()
                     if r["sci_name"] == "Turdus migratorius")
        self.assertEqual(robin, {
            "sci_name": "Turdus migratorius",
            "com_name": "American Robin",
            "slug": "turdus-migratorius",
            "first_confident": "2024-06-02 05:02:10",
            "last_detected": "2024-06-02 05:30:00",
            "detection_count": 3,
            "art_status": "ready",
            "accession": 1,
            "weeks": [[22, 3]],
        })
        self.assertEqual(set(robin.keys()), {
            "sci_name", "com_name", "slug", "first_confident",
            "last_detected", "detection_count", "art_status",
            "accession", "weeks",
        })

    # -- 4d. accession pins survive a species deletion (no renumber) -------
    def test_accession_pins_survive_species_deletion(self):
        """The whole point of the append-only ledger: an admin delete
        (species_tools.php DELETE ... WHERE Sci_Name) can drop the EARLIEST
        species from birds.db, but a later species must KEEP its accession No.
        -- never silently renumber. Fails RED against today's client-only i+1
        numbering (no ledger exists) and against any renumber-on-delete scheme."""
        # Full build: Robin (confident 06-02) accessioned before Blue Jay (06-03).
        self._build()
        j1 = {r["sci_name"]: r.get("accession") for r in self._species_json()}
        self.assertEqual(j1["Turdus migratorius"], 1)
        self.assertEqual(j1["Cyanocitta cristata"], 2)
        self.assertIsNone(j1["Spinus tristis"])          # never-confident -> not pinned
        jay_no = j1["Cyanocitta cristata"]
        # Simulate species_tools.php DELETE ... WHERE Sci_Name wiping the EARLIER
        # species, then a nightly rebuild. The append-only ledger must NOT renumber.
        os.remove(self.birds)
        _make_birds_db(self.birds, [r for r in _ROWS if r[2] != "Turdus migratorius"])
        self._build()
        j2 = {r["sci_name"]: r.get("accession") for r in self._species_json()}
        self.assertNotIn("Turdus migratorius", j2)        # Robin gone from birds.db
        self.assertEqual(j2["Cyanocitta cristata"], jay_no)  # Jay keeps No. 2 -> no renumber
        led = {e["sci_name"]: e for e in self._accessions()["entries"]}
        self.assertIn("Turdus migratorius", led)          # pin retained...
        self.assertTrue(led["Turdus migratorius"]["absent"])   # ...marked absent
        self.assertFalse(led["Cyanocitta cristata"]["absent"])
        self.assertEqual(led["Cyanocitta cristata"]["accession"], jay_no)
        self.assertEqual(led["Cyanocitta cristata"]["first_confident"], "2024-06-03 08:15:00")

    # -- 5. idempotency / rebuildability -----------------------------------
    def test_idempotent(self):
        out1 = os.path.join(self.tmp, "a", "christina.db")
        out2 = os.path.join(self.tmp, "b", "christina.db")
        os.makedirs(os.path.dirname(out1))
        os.makedirs(os.path.dirname(out2))
        rebuild_catalog.build_catalog(self.birds, out1, assets_dir=self.assets,
                                      built_at=self.BUILT_AT)
        rebuild_catalog.build_catalog(self.birds, out2, assets_dir=self.assets,
                                      built_at=self.BUILT_AT)

        def dump(db):
            con = sqlite3.connect(db)
            try:
                sp = con.execute("SELECT * FROM species ORDER BY sci_name").fetchall()
                dc = con.execute("SELECT * FROM daily_counts ORDER BY sci_name,date").fetchall()
                hb = con.execute("SELECT * FROM hour_buckets ORDER BY sci_name,hour").fetchall()
                ws = con.execute("SELECT * FROM week_species ORDER BY sci_name,week").fetchall()
            finally:
                con.close()
            return sp, dc, hb, ws

        self.assertEqual(dump(out1), dump(out2))
        # And species.json is byte-identical across runs.
        with open(os.path.join(self.tmp, "a", "species.json"), "rb") as fh:
            j1 = fh.read()
        with open(os.path.join(self.tmp, "b", "species.json"), "rb") as fh:
            j2 = fh.read()
        self.assertEqual(j1, j2)
        # Deleting + rebuilding reconstructs the same catalog (no external state).
        os.remove(out1)
        rebuild_catalog.build_catalog(self.birds, out1, assets_dir=self.assets,
                                      built_at=self.BUILT_AT)
        self.assertEqual(dump(out1), dump(out2))

    # -- 6. read-only over birds.db ----------------------------------------
    def test_birds_db_read_only(self):
        before = (os.path.getsize(self.birds), os.path.getmtime(self.birds), _sha256(self.birds))
        self._build()
        after = (os.path.getsize(self.birds), os.path.getmtime(self.birds), _sha256(self.birds))
        self.assertEqual(before, after)
        # No write-ahead / journal side files were created next to birds.db.
        self.assertFalse(os.path.exists(self.birds + "-wal"))
        self.assertFalse(os.path.exists(self.birds + "-journal"))

    # -- 6b. refuse to overwrite birds.db (out == birds) -------------------
    def test_refuses_out_equals_birds(self):
        """The final os.replace(tmp, out) is the only birds.db mutation vector.
        If --out resolves to birds.db it would clobber the irreplaceable
        detection log, so build_catalog must refuse and leave birds.db byte-
        for-byte unchanged."""
        before = _sha256(self.birds)
        with self.assertRaises(ValueError):
            rebuild_catalog.build_catalog(self.birds, self.birds,
                                          assets_dir=self.assets,
                                          built_at=self.BUILT_AT)
        # birds.db untouched, and no stray christina.db.tmp was written next to it.
        self.assertEqual(_sha256(self.birds), before)
        self.assertFalse(os.path.exists(self.birds + ".tmp"))

    # -- 7. empty birds.db --------------------------------------------------
    def test_empty_db(self):
        empty = os.path.join(self.tmp, "empty.db")
        _make_birds_db(empty, [])
        out = os.path.join(self.tmp, "empty-out", "christina.db")
        os.makedirs(os.path.dirname(out))
        result = rebuild_catalog.build_catalog(empty, out, assets_dir=self.assets,
                                               built_at=self.BUILT_AT)
        self.assertEqual(result["species"], 0)
        self.assertEqual(result["source_rows"], 0)
        con = sqlite3.connect(out)
        try:
            self.assertEqual(con.execute("SELECT COUNT(*) FROM species").fetchone()[0], 0)
            sv = con.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0]
            self.assertEqual(sv, rebuild_catalog.SCHEMA_VERSION)
        finally:
            con.close()
        with open(os.path.join(os.path.dirname(out), "species.json"), encoding="utf-8") as fh:
            self.assertEqual(json.load(fh), [])

    # -- extra: garbage/NULL Com_Name handled, text confidence parsed ------
    def test_garbage_com_and_text_confidence(self):
        self._build()
        finch = _fetch_species(self.out, "Spinus tristis")
        self.assertIsNotNone(finch)
        self.assertEqual(finch["is_bird"], 1)        # is_bird from sci, not com
        self.assertIsNone(finch["com_name"])         # NULL com carried through
        # NULL com -> birdnet_label falls back to "<sci>_<sci>".
        self.assertEqual(finch["birdnet_label"], "Spinus tristis_Spinus tristis")
        self.assertEqual(finch["confident_count"], 0)  # "garbage" conf -> unparseable
        self.assertIsNone(finch["max_confidence"])
        self.assertEqual(finch["detection_count"], 1)

    # -- extra: pick_com disambiguation (the reason pick_com exists) -------
    def test_pick_com_disambiguation(self):
        """Common names drift across BirdNET versions/locales; pick_com must
        choose the most frequent deterministically (count desc, then non-NULL
        first, then lexical). Every shared-fixture species has a single
        Com_Name, so this builds its own fixture to exercise the tie-break."""
        db = os.path.join(self.tmp, "drift.db")
        _make_birds_db(db, [
            ("2024-06-01", "06:00:00", "Sturnus vulgaris", "European Starling", "0.90", 22),
            ("2024-06-01", "07:00:00", "Sturnus vulgaris", "European Starling", "0.90", 22),
            ("2024-06-01", "08:00:00", "Sturnus vulgaris", "Starling", "0.90", 22),
            ("2024-06-01", "09:00:00", "Sturnus vulgaris", None, "0.90", 22),
        ])
        out = os.path.join(self.tmp, "drift-out", "christina.db")
        os.makedirs(os.path.dirname(out))
        rebuild_catalog.build_catalog(db, out, assets_dir=self.assets,
                                      built_at=self.BUILT_AT)
        sp = _fetch_species(out, "Sturnus vulgaris")
        # "European Starling" (count 2) beats "Starling" (1) and NULL (1).
        self.assertEqual(sp["com_name"], "European Starling")
        self.assertEqual(sp["birdnet_label"], "Sturnus vulgaris_European Starling")


if __name__ == "__main__":
    unittest.main(verbosity=2)
