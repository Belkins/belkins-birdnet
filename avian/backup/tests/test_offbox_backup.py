#!/usr/bin/env python3
"""Tests for offbox_backup + restore_offbox -- they EXERCISE the failure modes.

Every test builds a real fixture (a real sqlite birds.db, a real tar.gz) and runs
the real code, then asserts the SPECIFIC exit code / member / message, so a test
cannot stay green if the business logic changes. The whole point of this item is
that a backup must never report success while doing nothing, so most of these
tests exist to make a FALSE GREEN impossible rather than to prove a happy path.

Fully offline: urllib.request.urlopen is replaced by a FakeServer in setUp, and
no test contacts the Pi, Railway, or any network. Pure stdlib / unittest.

Run from ``avian/backup/``:
    python3 -m pytest tests/ -v
    (or: python3 -m unittest discover -s tests -v -- this dir is a package)
"""

import contextlib
import datetime
import io
import json
import os
import shutil
import sqlite3
import sys
import tarfile
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

# Import the scripts regardless of CWD / discovery method.
_BACKUP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKUP_DIR not in sys.path:
    sys.path.insert(0, _BACKUP_DIR)

import offbox_backup  # noqa: E402
import restore_offbox  # noqa: E402


# Column names match the real BirdNET-Pi schema (scripts/createdb.sh), same
# relaxed fixture shape avian/catalog/tests/test_catalog.py uses.
_FIXTURE_SCHEMA = """
CREATE TABLE detections (
  Date TEXT, Time TEXT, Sci_Name TEXT, Com_Name TEXT, Confidence TEXT,
  Lat REAL, Lon REAL, Cutoff REAL, Week INTEGER, Sens REAL, Overlap REAL,
  File_Name TEXT);
"""

# 5 rows, 3 distinct Sci_Name.
_ROWS = [
    ("2026-06-01", "06:14:33", "Erithacus rubecula", "European Robin", "0.91", 22),
    ("2026-06-02", "05:02:10", "Erithacus rubecula", "European Robin", "0.95", 23),
    ("2026-06-02", "05:30:00", "Psittacula krameri", "Rose-ringed Parakeet", "0.88", 23),
    ("2026-06-03", "08:15:00", "Psittacula krameri", "Rose-ringed Parakeet", "0.80", 23),
    ("2026-06-03", "09:00:00", "Turdus merula", "Eurasian Blackbird", "0.99", 23),
]

# Stand-in for the committed 250-slug services/birdgen/manifest.json.
_BUNDLED = ["accipiter-cooperii", "apus-apus"]
_VOLUME_ONLY = ["erithacus-rubecula", "psittacula-krameri"]

_PLATE = b"\x89PNG\r\n\x1a\n" + b"x" * 4096

# Module globals the tests re-point at the fixture. Patched as attributes rather
# than via os.environ + a reload hook: the repo's convention is env read once at
# import (mic_watch.py:57-63, railway_liveness.py:22-25), and a reload hook that
# a future refactor calls too late turns notify() into a silent no-op.
_ENV_ATTRS = ("REPO", "DEST_RAW", "KEEP", "DB_PATH", "LEDGER", "PHENOLOGY", "BUNDLED_MANIFEST",
              "BASE", "NOTIFY", "STATE", "TIMEOUT", "BUDGET", "REALERT", "ALLOW_SAME_DEV")


def _make_birds_db(path, rows):
    con = sqlite3.connect(str(path))
    try:
        con.executescript(_FIXTURE_SCHEMA)
        con.executemany(
            "INSERT INTO detections (Date, Time, Sci_Name, Com_Name, Confidence, Week) VALUES (?,?,?,?,?,?)",
            rows,
        )
        con.commit()
    finally:
        con.close()


class FakeResponse:
    def __init__(self, body, headers=None):
        self._body = body
        self.headers = headers or {}

    def read(self):
        return self._body


class FakeServer:
    """Routes /manifest and /asset/<name>. Anything else 404s, like birdgen."""

    def __init__(self):
        self.manifest = {"slugs": sorted(_BUNDLED + _VOLUME_ONLY)}
        self.manifest_body = None      # raw bytes override (shape tests)
        self.manifest_error = None     # exception to raise instead (outage tests)
        self.assets = {
            "erithacus-rubecula.png": (_PLATE, {}),
            "erithacus-rubecula-2.png": (_PLATE, {}),
            "psittacula-krameri.png": (_PLATE, {}),
            # A pose-2 MISS: app.py:1628-1643 answers with the pose-1 BYTES plus
            # the marker header, NOT a 404.
            "psittacula-krameri-2.png": (_PLATE, {"X-Av-Pose-Fallback": "1"}),
        }

    def __call__(self, url, timeout=None, **kw):
        if not isinstance(url, str):          # a notify() Request object
            return FakeResponse(b"")
        if url.endswith("/manifest"):
            if self.manifest_error is not None:
                raise self.manifest_error
            if self.manifest_body is not None:
                return FakeResponse(self.manifest_body)
            return FakeResponse(json.dumps(self.manifest).encode("utf-8"))
        if "/asset/" in url:
            name = url.rsplit("/asset/", 1)[1]
            if name in self.assets:
                body, headers = self.assets[name]
                return FakeResponse(body, headers)
        raise urllib.error.HTTPError(url, 404, "not found", {}, None)


class BackupCase(unittest.TestCase):
    """Fixture repo + off-box dest + a FakeServer, wired into the module globals."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="offbox-test-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.repo = self.tmp / "repo"
        self.dest = self.tmp / "dest"
        for rel in ("scripts", "services/birdgen", "avian/api", "avian/assets/illustrations"):
            (self.repo / rel).mkdir(parents=True)
        self.dest.mkdir()
        (self.repo / "avian/api/cutout.php").write_text("<?php // marker\n")
        _make_birds_db(self.repo / "scripts/birds.db", _ROWS)
        # PRODUCTION ENVELOPES, not flat maps. rebuild_catalog.py:764-765 emits
        # {"version":..., "entries":[...]} and phenology.py:436-452 emits an
        # 8-key dict that also carries "entries". The original flat-map fixtures
        # made len(doc) equal the real entry count by coincidence, which hid an
        # entry counter that could never fire against either real producer.
        (self.repo / "scripts/accessions.json").write_text(
            json.dumps({"version": 1, "entries": [
                {"sci_name": "erithacus-rubecula", "accession": 1},
                {"sci_name": "psittacula-krameri", "accession": 2}]}) + "\n")
        # RELATIVE, never a literal. check_phenology degrades a ledger whose
        # built_at is older than PHENOLOGY_MAX_AGE_H, so a hardcoded timestamp
        # silently turns every rc==0 assertion in this file red 72h after the day
        # it was written -- on a date nobody would connect to this line.
        _now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
        _fresh = (_now - datetime.timedelta(hours=1)).isoformat()
        (self.repo / "scripts/phenology.json").write_text(
            json.dumps({"version": 1, "built_at": _fresh,
                        "current_year": _now.year, "source_rows": 5, "species_years": 2,
                        "coverage": {"min_date": "%d-01-01" % _now.year,
                                     "max_date": _now.date().isoformat(),
                                     "source_rows": 5, "years": [_now.year]},
                        "notes": [], "entries": [
                            {"year": _now.year - 1, "sci_name": "erithacus-rubecula"},
                            {"year": _now.year, "sci_name": "psittacula-krameri"}]}) + "\n")
        (self.repo / "services/birdgen/manifest.json").write_text(json.dumps({"slugs": _BUNDLED}) + "\n")

        saved = {k: getattr(offbox_backup, k) for k in _ENV_ATTRS}
        self.addCleanup(lambda: [setattr(offbox_backup, k, v) for k, v in saved.items()])
        offbox_backup.REPO = self.repo
        offbox_backup.DEST_RAW = str(self.dest)
        offbox_backup.KEEP = 14
        offbox_backup.DB_PATH = self.repo / "scripts/birds.db"
        offbox_backup.LEDGER = self.repo / "scripts/accessions.json"
        offbox_backup.PHENOLOGY = self.repo / "scripts/phenology.json"
        offbox_backup.BUNDLED_MANIFEST = self.repo / "services/birdgen/manifest.json"
        offbox_backup.BASE = "https://birdgen.invalid"
        offbox_backup.NOTIFY = ""
        offbox_backup.STATE = str(self.tmp / "state" / "backup.state")
        offbox_backup.TIMEOUT = 5.0
        offbox_backup.BUDGET = 600.0
        offbox_backup.REALERT = 7
        # tmp and the repo copy share a filesystem on a dev machine; every test
        # except test_same_filesystem_destination_is_refused needs the hatch.
        offbox_backup.ALLOW_SAME_DEV = True

        self.server = FakeServer()
        p = mock.patch.object(offbox_backup.urllib.request, "urlopen", self.server)
        p.start()
        self.addCleanup(p.stop)

    # --- helpers -----------------------------------------------------------
    def run_backup(self):
        """-> (rc, stdout, stderr). Output is captured so the suite stays readable."""
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = offbox_backup.main()
        return rc, out.getvalue(), err.getvalue()

    def run_restore(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = restore_offbox.main(argv)
        return rc, out.getvalue(), err.getvalue()

    def archives(self, degraded=None):
        names = sorted(p for p in self.dest.glob("christina-backup-*.tar.gz"))
        if degraded is True:
            return [p for p in names if p.name.endswith("-degraded.tar.gz")]
        if degraded is False:
            return [p for p in names if not p.name.endswith("-degraded.tar.gz")]
        return names

    def only_archive(self):
        found = self.archives()
        self.assertEqual(len(found), 1, "expected exactly one archive, got %s" % [p.name for p in found])
        return found[0]

    def members(self, archive):
        """Member names with the top-level ``christina-backup-<stamp>/`` stripped."""
        with tarfile.open(str(archive)) as tf:
            names = [m.name for m in tf.getmembers()]
        return set(n.split("/", 1)[1] for n in names if "/" in n)

    def manifest_of(self, archive):
        with tarfile.open(str(archive)) as tf:
            name = [m.name for m in tf.getmembers() if m.name.endswith("MANIFEST.json")][0]
            return json.loads(tf.extractfile(name).read().decode("utf-8"))

    def rebuild_tar(self, archive, mutate):
        """Extract, apply ``mutate(root)``, re-tar in place, refresh the sidecar."""
        work = Path(tempfile.mkdtemp(dir=str(self.tmp)))
        with tarfile.open(str(archive)) as tf:
            tf.extractall(str(work))
        root = [p for p in work.iterdir() if p.is_dir()][0]
        mutate(root)
        archive.unlink()
        with tarfile.open(str(archive), "w:gz") as tf:
            tf.add(str(root), arcname=root.name)
        archive.with_name(archive.name + ".sha256").write_text(
            "%s  %s\n" % (offbox_backup.sha256_of(archive), archive.name))

    def tree(self, base):
        """(relpath, size) for every file under base -- a 'nothing was touched' snapshot."""
        snap = {}
        for dirpath, _dirs, files in os.walk(str(base)):
            for f in files:
                p = Path(dirpath) / f
                snap[str(p.relative_to(base))] = (p.stat().st_size, p.stat().st_mtime_ns)
        return snap


class TestRefusals(BackupCase):

    def test_dest_unset_is_exit_2_and_writes_nothing(self):
        """A backup unit that returns 0 while writing nowhere is the exact failure
        mode this item exists to kill. If anyone ever softens an unset destination
        into a warning, this goes red."""
        offbox_backup.DEST_RAW = ""
        rc, _out, err = self.run_backup()
        self.assertEqual(rc, 2)
        self.assertIn("CHRISTINA_BACKUP_DEST is unset", err)
        self.assertEqual(list(self.dest.iterdir()), [])

    def test_same_filesystem_destination_is_refused(self):
        """Writing the backup to the SD card is the bug, not the fix -- and the
        escape hatch the offline rehearsal depends on must be proven to exist."""
        inside = self.repo / "scripts" / "backups"
        inside.mkdir()
        offbox_backup.DEST_RAW = str(inside)
        offbox_backup.ALLOW_SAME_DEV = False
        rc, _out, err = self.run_backup()
        self.assertEqual(rc, 2)
        self.assertIn("SAME filesystem", err)
        self.assertEqual(list(inside.iterdir()), [])

        offbox_backup.ALLOW_SAME_DEV = True
        rc, _out, _err = self.run_backup()
        self.assertEqual(rc, 0)
        self.assertEqual(len(list(inside.glob("christina-backup-*.tar.gz"))), 1)

    def test_config_fault_alerts_once_across_three_runs(self):
        """The exit-2 push goes to the SAME ntfy topic as mic-watch's dead-mic and
        railway-liveness's DOWN alerts. Nightly repetition gets the topic muted,
        which silences those two as well -- so an ungated notify here is a
        system-wide alerting failure, not a nuisance."""
        offbox_backup.DEST_RAW = ""
        offbox_backup.NOTIFY = "https://ntfy.invalid/topic"
        with mock.patch.object(offbox_backup, "notify") as spy:
            for _ in range(3):
                self.assertEqual(self.run_backup()[0], 2)
        self.assertEqual(spy.call_count, 1, "exit-2 must push once per transition, not nightly")


class TestHappyPath(BackupCase):

    def test_happy_path_archive_contents(self):
        """The 250 bundled plates are already in git -- re-downloading them nightly
        is waste; missing one London plate is permanent loss. The set difference
        must be exact in BOTH directions."""
        rc, _out, _err = self.run_backup()
        self.assertEqual(rc, 0)
        got = self.members(self.only_archive())
        for want in ("birds.db", "accessions.json", "phenology.json", "MANIFEST.json",
                     "plates/erithacus-rubecula.png", "plates/erithacus-rubecula-2.png",
                     "plates/psittacula-krameri.png"):
            self.assertIn(want, got)
        self.assertFalse([n for n in got if "accipiter-cooperii" in n or "apus-apus" in n],
                         "bundled slugs must never be archived")

    def test_pose2_fallback_is_not_stored(self):
        """app.py:1628-1643 answers a pose-2 miss with the pose-1 BYTES plus
        X-Av-Pose-Fallback: 1. Storing them would restore a perched render into
        the flight tab forever, with no error anywhere. And a pose-2 miss is
        NORMAL -- it must not degrade the run."""
        rc, _out, _err = self.run_backup()
        self.assertEqual(rc, 0)
        archive = self.only_archive()
        self.assertNotIn("plates/psittacula-krameri-2.png", self.members(archive))
        self.assertNotIn("psittacula-krameri-2.png", self.manifest_of(archive)["plates"]["files"])

    def test_manifest_counts_and_hashes_are_truthful(self):
        """A backup whose contents cannot be proven is a belief. These are the
        numbers the quarterly rehearsal reads."""
        self.assertEqual(self.run_backup()[0], 0)
        archive = self.only_archive()
        manifest = self.manifest_of(archive)
        self.assertEqual(manifest["birds_db"]["detections"], 5)
        self.assertEqual(manifest["birds_db"]["species"], 3)
        self.assertEqual(manifest["accessions"]["entries"], 2)
        self.assertEqual(manifest["phenology"]["entries"], 2)
        self.assertEqual(manifest["plates"]["expected"], 2)
        self.assertEqual(manifest["plates"]["fetched"], 2)
        work = Path(tempfile.mkdtemp(dir=str(self.tmp)))
        with tarfile.open(str(archive)) as tf:
            tf.extractall(str(work))
        root = [p for p in work.iterdir() if p.is_dir()][0]
        self.assertEqual(offbox_backup.sha256_of(root / "birds.db"), manifest["birds_db"]["sha256"])
        self.assertEqual(offbox_backup.sha256_of(root / "plates/erithacus-rubecula.png"),
                         manifest["plates"]["files"]["erithacus-rubecula.png"]["sha256"])

    def test_phenology_present_when_it_exists_and_absent_is_not_a_fault(self):
        """scripts/phenology.json freezes per-year phenology BEFORE disk_check.sh
        purges the rows behind it, so it cannot be regenerated once they are gone.
        It is the round's newest irreplaceable file and must be archived
        unconditionally -- but a station that has never built one is not broken."""
        self.assertEqual(self.run_backup()[0], 0)
        self.assertIn("phenology.json", self.members(self.only_archive()))

        for p in self.dest.glob("christina-backup-*"):
            p.unlink()
        (self.repo / "scripts/phenology.json").unlink()
        offbox_backup.STATE = str(self.tmp / "state2" / "backup.state")   # a fresh station
        rc, _out, _err = self.run_backup()
        self.assertEqual(rc, 0, "an absent phenology ledger on a fresh station is a note, not a fault")
        manifest = self.manifest_of(self.only_archive())
        self.assertIsNone(manifest["phenology"])
        self.assertTrue(any("phenology.json absent" in n for n in manifest["notes"]))


class TestDegraded(BackupCase):

    def test_empty_volume_only_set_is_degraded_not_complete(self):
        """THE defect this item exists for. An empty Railway volume still serves
        all 250 bundled slugs from /app and answers /manifest 200, so the naive
        difference is the empty set and a naive job reports SUCCESS on the exact
        catastrophe it was built to survive."""
        self.server.manifest = {"slugs": sorted(_BUNDLED)}
        rc, _out, _err = self.run_backup()
        self.assertEqual(rc, 3)
        manifest = self.manifest_of(self.only_archive())
        self.assertTrue(any("EMPTY" in d and "VOLUME IS GONE" in d for d in manifest["degraded"]),
                        manifest["degraded"])

    def test_manifest_shape_is_asserted_not_defaulted(self):
        """`.get("slugs", [])` on a truncated/HTML/garbage body yields [] silently,
        and [] is indistinguishable from 'the volume is empty'. Both must be loud,
        so neither may arrive as a default."""
        self.server.manifest_body = b"<html>Application failed to respond</html>"
        rc, _out, _err = self.run_backup()
        self.assertEqual(rc, 3)
        self.assertTrue(any("Railway unusable" in d for d in self.manifest_of(self.only_archive())["degraded"]))

        for p in self.dest.glob("christina-backup-*"):
            p.unlink()
        self.server.manifest_body = None
        self.server.manifest = {"slugs": ["apus-apus"]}   # fewer than the bundled set
        rc, _out, _err = self.run_backup()
        self.assertEqual(rc, 3)
        self.assertTrue(any("FEWER than the" in d for d in self.manifest_of(self.only_archive())["degraded"]))

    def test_plate_count_collapse_is_degraded(self):
        """A bundled-manifest drift can silently reclassify real volume plates as
        bundled. The count is the only thing that notices."""
        self.assertEqual(self.run_backup()[0], 0)
        self.server.manifest = {"slugs": sorted(_BUNDLED + ["erithacus-rubecula"])}
        rc, _out, _err = self.run_backup()
        self.assertEqual(rc, 3)
        self.assertTrue(any("COLLAPSED 2 -> 1" in d for d in self.manifest_of(self.archives(True)[0])["degraded"]))

    def test_unfetchable_plate_is_degraded(self):
        """A 500, a cold-start timeout and a genuine 404 demand different reactions
        and must not collapse into one word -- and a run that fetched fewer plates
        than it expected can never be COMPLETE."""
        del self.server.assets["psittacula-krameri.png"]
        rc, _out, _err = self.run_backup()
        self.assertEqual(rc, 3)
        degraded = self.manifest_of(self.only_archive())["degraded"]
        self.assertTrue(any("psittacula-krameri.png missing (HTTP 404)" in d for d in degraded), degraded)
        self.assertTrue(any("fetched 1 of 2" in d for d in degraded), degraded)

    def test_railway_unreachable_still_saves_the_ledgers_but_exits_3(self):
        """Losing the plates must not also lose the ledgers, and a run without
        plates must never look like success."""
        self.server.manifest_error = urllib.error.URLError("connection refused")
        rc, _out, _err = self.run_backup()
        self.assertEqual(rc, 3)
        archive = self.only_archive()
        got = self.members(archive)
        self.assertIn("birds.db", got)
        self.assertIn("accessions.json", got)
        self.assertTrue(any("birdgen.invalid" in d for d in self.manifest_of(archive)["degraded"]))

    def test_railway_base_unset_exits_3(self):
        """An operator who forgets one env var must be told, not quietly given a
        two-thirds backup."""
        offbox_backup.BASE = ""
        rc, _out, _err = self.run_backup()
        self.assertEqual(rc, 3)
        self.assertTrue(any("AV_RAILWAY_BASE unset" in d for d in self.manifest_of(self.only_archive())["degraded"]))

    def test_empty_detections_table_is_degraded(self):
        """A valid-but-empty birds.db (restore.php re-initialising, a wrong
        CHRISTINA_BIRDS_DB, a corrupt-then-recreated file) must not back up as
        COMPLETE -- emptiness is evidence, not a number nobody reads."""
        db = self.repo / "scripts/birds.db"
        db.unlink()
        _make_birds_db(db, [])
        rc, _out, _err = self.run_backup()
        self.assertEqual(rc, 3)
        self.assertTrue(any("ZERO detections" in d for d in self.manifest_of(self.archives(True)[0])["degraded"]))

    def test_unreadable_schema_is_degraded_not_a_silent_null(self):
        """Recording a schema surprise as null and carrying on is the fail-open
        that hid a 24-day staleness behind a green unit. It is also what let the
        rehearsal pass on an unprovable archive."""
        db = self.repo / "scripts/birds.db"
        db.unlink()
        con = sqlite3.connect(str(db))
        con.executescript("CREATE TABLE somethingelse (x TEXT); INSERT INTO somethingelse VALUES ('x');")
        con.commit()
        con.close()
        rc, _out, _err = self.run_backup()
        self.assertEqual(rc, 3)
        self.assertTrue(any("UNREADABLE" in d for d in self.manifest_of(self.archives(True)[0])["degraded"]))

    def test_detection_count_regression_is_degraded(self):
        """detections is append-only. A DROP is evidence of damage upstream, and
        it is the one signal that distinguishes 'a smaller db' from 'a wrong db'."""
        self.assertEqual(self.run_backup()[0], 0)
        db = self.repo / "scripts/birds.db"
        db.unlink()
        _make_birds_db(db, _ROWS[:2])
        rc, _out, _err = self.run_backup()
        self.assertEqual(rc, 3)
        self.assertTrue(any("DROPPED 5 -> 2" in d for d in self.manifest_of(self.archives(True)[0])["degraded"]))

    def test_deleted_ledger_after_a_good_run_is_degraded(self):
        """Absent is a note on a fresh station and a DELETION on a station that
        archived entries last night. Collapsing the two is how an irreplaceable
        file disappears behind a green run."""
        self.assertEqual(self.run_backup()[0], 0)
        (self.repo / "scripts/accessions.json").unlink()
        rc, _out, _err = self.run_backup()
        self.assertEqual(rc, 3)
        self.assertTrue(any("IT HAS BEEN DELETED" in d for d in self.manifest_of(self.archives(True)[0])["degraded"]))

    def test_entry_count_reads_the_envelope_not_the_top_level_keys(self):
        """Both producers emit an envelope, so len(doc) is a CONSTANT (2 for
        accessions, 8 for phenology) no matter how many entries exist. Counting
        keys makes the zero-entry regression check below unreachable in
        production while every fixture-based test stays green."""
        phen = json.loads((self.repo / "scripts/phenology.json").read_text())
        phen["entries"] = [{"year": 2026, "sci_name": "sp-%d" % i} for i in range(5)]
        self.assertEqual(len(phen), 8, "fixture must keep the real 8-key envelope")
        (self.repo / "scripts/phenology.json").write_text(json.dumps(phen) + "\n")
        self.assertEqual(self.run_backup()[0], 0)
        meta = self.manifest_of(self.only_archive())["phenology"]
        self.assertEqual(meta["entries"], 5, "counted top-level keys, not entries")

    def test_an_unrecognised_ledger_envelope_is_corrupt_not_empty(self):
        """A dict carrying no "entries" list is a shape neither producer emits.
        Guessing a count from it is how a mangled ledger passes as healthy."""
        (self.repo / "scripts/accessions.json").write_text(json.dumps({"a": 1, "b": 2}) + "\n")
        rc, _out, _err = self.run_backup()
        self.assertEqual(rc, 3)
        self.assertTrue(any("CORRUPT" in d for d in self.manifest_of(self.archives(True)[0])["degraded"]))

    def test_a_regression_baseline_does_not_self_heal_on_night_three(self):
        """The regression detectors compare against the last KNOWN-GOOD run, not
        the last run. Advancing a baseline on the night it was violated lets the
        damage become the new normal: night 3 returns 0 and pushes RECOVERED over
        permanently lost detections. Every other regression test runs only two
        nights, so this defect lived exactly where they stop looking."""
        self.assertEqual(self.run_backup()[0], 0)          # night 1: baseline 5 detections
        db = self.repo / "scripts/birds.db"
        db.unlink()
        _make_birds_db(db, _ROWS[:2])
        self.assertEqual(self.run_backup()[0], 3)          # night 2: 5 -> 2, degraded
        rc, _out, _err = self.run_backup()                 # night 3: still damaged
        self.assertEqual(rc, 3, "baseline self-healed; damage became the new normal")
        self.assertTrue(any("DROPPED 5 -> 2" in d for d in self.manifest_of(self.archives(True)[0])["degraded"]))


class TestFaults(BackupCase):

    def test_missing_birds_db_is_exit_4(self):
        """Exit 3 and exit 4 must stay distinguishable: one means 'some of it got
        out', the other 'none of it did', and they need different reactions at 4am."""
        (self.repo / "scripts/birds.db").unlink()
        rc, _out, err = self.run_backup()
        self.assertEqual(rc, 4)
        self.assertIn("birds.db missing or empty", err)
        self.assertEqual(self.archives(), [])

    def test_interrupted_archive_leaves_no_partial(self):
        """Rotation sorts by name and keeps the newest -- a truncated tar counted
        as good would silently evict the last real backup."""
        with mock.patch.object(offbox_backup.tarfile, "open", side_effect=IOError("no space left on device")):
            rc, _out, err = self.run_backup()
        self.assertEqual(rc, 4)
        self.assertIn("no space left on device", err)
        self.assertEqual(self.archives(), [])
        self.assertEqual(list(self.dest.glob("*.part")), [])

    def test_staging_dir_is_always_removed(self):
        """An unattended nightly that leaks a full copy of birds.db per run fills
        the mount within a fortnight."""
        self.assertEqual(self.run_backup()[0], 0)
        self.assertEqual(list(self.dest.glob(".staging-*")), [])
        with mock.patch.object(offbox_backup.tarfile, "open", side_effect=IOError("boom")):
            self.assertEqual(self.run_backup()[0], 4)
        self.assertEqual(list(self.dest.glob(".staging-*")), [])

    def test_unexpected_crash_exits_4_and_pushes_once(self):
        """Without a top-level handler the unit's likeliest crashes (ENOSPC on the
        mount, a socket.timeout, an unlink race in rotate) exit with a traceback,
        a red unit and NO push -- the silent-red failure this job exists to kill.
        rotate() stands in here because it is the one step outside every inner
        try/except."""
        offbox_backup.NOTIFY = "https://ntfy.invalid/topic"
        with mock.patch.object(offbox_backup, "notify") as spy:
            with mock.patch.object(offbox_backup, "rotate", side_effect=OSError("ENOSPC")):
                rc, _out, err = self.run_backup()
        self.assertEqual(rc, 4)
        self.assertIn("CRASH", err)
        self.assertEqual(spy.call_count, 1)

    def test_a_read_error_mid_fetch_degrades_rather_than_crashing(self):
        """socket.timeout and http.client.IncompleteRead are NOT urllib.error
        subclasses. Catching only urllib.error would turn a Railway blink into an
        uncaught traceback on a run that otherwise saved the whole database."""
        class Boom:
            headers = {}

            def read(self):
                raise OSError("connection reset by peer")

        real = self.server.__call__

        def flaky(url, timeout=None, **kw):
            if isinstance(url, str) and "/asset/" in url:
                return Boom()
            return real(url, timeout=timeout, **kw)

        with mock.patch.object(offbox_backup.urllib.request, "urlopen", flaky):
            rc, _out, _err = self.run_backup()
        self.assertEqual(rc, 3)
        degraded = self.manifest_of(self.archives(True)[0])["degraded"]
        self.assertTrue(any("OSError" in d for d in degraded), degraded)

    def test_a_transient_timeout_is_retried_once_and_the_run_stays_COMPLETE(self):
        """2026-08-01: the first two weekly continuity-r2 runs BOTH degraded on
        scattered read timeouts -- different plates each run, and the 'failing'
        plate served its 1.3 MB in 0.5 s when probed alone. One retry absorbs a
        spike so the weekly alert stays meaningful. The call count is asserted
        so a retry loop that silently never retries fails HERE, not on the box."""
        real = self.server.__call__
        calls = {"n": 0}

        def spiky(url, timeout=None, **kw):
            if isinstance(url, str) and url.endswith("/asset/erithacus-rubecula.png"):
                calls["n"] += 1
                if calls["n"] == 1:
                    raise TimeoutError("The read operation timed out")
            return real(url, timeout=timeout, **kw)

        with mock.patch.object(offbox_backup.urllib.request, "urlopen", spiky), \
             mock.patch.object(offbox_backup.time, "sleep"):
            rc, _out, _err = self.run_backup()
        self.assertEqual(rc, 0, "one absorbed spike must not degrade the run")
        self.assertEqual(calls["n"], 2)

    def test_a_persistent_timeout_degrades_after_exactly_two_attempts(self):
        """The retry is ONE, not a loop: a genuinely down Railway must still
        produce a loud DEGRADED archive, and must not spin the BUDGET away."""
        real = self.server.__call__
        calls = {"n": 0}

        def dead(url, timeout=None, **kw):
            if isinstance(url, str) and url.endswith("/asset/psittacula-krameri.png"):
                calls["n"] += 1
                raise TimeoutError("The read operation timed out")
            return real(url, timeout=timeout, **kw)

        with mock.patch.object(offbox_backup.urllib.request, "urlopen", dead), \
             mock.patch.object(offbox_backup.time, "sleep"):
            rc, _out, _err = self.run_backup()
        self.assertEqual(rc, 3)
        self.assertEqual(calls["n"], 2, "exactly one retry -- never zero, never unbounded")
        degraded = self.manifest_of(self.archives(True)[0])["degraded"]
        self.assertTrue(any("TimeoutError" in d for d in degraded), degraded)


class TestRotationAndAlerts(BackupCase):

    def test_rotation_keeps_newest_n_with_sidecars(self):
        """An unrotated dir fills the mount and the backup starts failing on the
        night before the card dies."""
        for i in range(16):
            name = "christina-backup-20200101T%06dZ.tar.gz" % i
            (self.dest / name).write_bytes(b"old")
            (self.dest / (name + ".sha256")).write_text("deadbeef  %s\n" % name)
        offbox_backup.KEEP = 3
        self.assertEqual(self.run_backup()[0], 0)
        tars = sorted(p.name for p in self.dest.glob("christina-backup-*.tar.gz"))
        sides = sorted(p.name for p in self.dest.glob("christina-backup-*.tar.gz.sha256"))
        self.assertEqual(len(tars), 3, tars)
        self.assertEqual(len(sides), 3, sides)
        self.assertEqual(tars, sorted(tars)[-3:])
        self.assertEqual(tars[-1], self.archives(False)[-1].name)

    def test_rotation_never_evicts_the_newest_complete_archive(self):
        """With one pool, 14 degraded nights evict all 14 archives that DID hold
        the plates and replace them with 14 that do not -- the backup system as
        the deletion mechanism. This is the test that forbids that."""
        keeper = self.dest / "christina-backup-20200101T000000Z.tar.gz"
        keeper.write_bytes(b"the last complete backup")
        offbox_backup.KEEP = 2
        offbox_backup.BASE = ""      # every run from here is DEGRADED
        for _ in range(5):
            self.assertEqual(self.run_backup()[0], 3)
            for p in self.dest.glob("christina-backup-*-degraded.tar.gz"):
                # each night gets its own stamp on the real timer; force distinct
                # names so rotation has something to actually rotate
                p.rename(p.with_name(p.name.replace("christina-backup-", "christina-backup-x", 1)))
        self.assertTrue(keeper.is_file(), "the newest COMPLETE archive was rotated away by degraded nights")

    def test_degraded_alert_fires_once_then_recovers(self):
        """A nightly job that pushes the same alarm every night gets muted, and a
        muted alarm is no alarm -- but a transition-only gate goes silent on night
        2..N of an outage, which is exactly when the good archives are ageing out.
        Once on the transition, then every REALERT-th night, then RECOVERED."""
        offbox_backup.NOTIFY = "https://ntfy.invalid/topic"
        offbox_backup.BASE = ""
        offbox_backup.REALERT = 3
        with mock.patch.object(offbox_backup, "notify") as spy:
            self.assertEqual(self.run_backup()[0], 3)
            self.assertEqual(spy.call_count, 1)
            self.assertIn("DEGRADED", spy.call_args[0][1])
            self.assertEqual(self.run_backup()[0], 3)
            self.assertEqual(spy.call_count, 1, "night 2 must not re-push")
            self.assertEqual(self.run_backup()[0], 3)
            self.assertEqual(spy.call_count, 2, "night 3 (REALERT) must re-push so an outage cannot fall silent")

            offbox_backup.BASE = "https://birdgen.invalid"
            self.assertEqual(self.run_backup()[0], 0)
            self.assertEqual(spy.call_count, 3)
            self.assertIn("Christina backup OK", spy.call_args[0][1])
            self.assertEqual(spy.call_args[0][2], "white_check_mark")


class TestRestore(BackupCase):

    def _archive(self):
        self.assertEqual(self.run_backup()[0], 0)
        return self.only_archive()

    def test_restore_dry_run_verifies_and_touches_nothing(self):
        """The rehearsal has to be safe to run on the live Pi, or nobody will ever
        run it."""
        archive = self._archive()
        before = self.tree(self.repo)
        rc, out, _err = self.run_restore([str(archive)])
        self.assertEqual(rc, 0)
        self.assertIn("5 detections", out)
        self.assertIn("rehearsal only", out)
        self.assertEqual(self.tree(self.repo), before)

    def test_rehearsing_a_degraded_archive_is_not_a_pass(self):
        """A plate-less archive verifies its own integrity perfectly -- every
        sha256 matches, because nothing is corrupt, only MISSING. If the
        rehearsal still exits 0 then the single mechanism whose job is proving
        the backup is good cannot tell a complete archive from an empty one, at
        the only moment anyone ever looks."""
        self.server.manifest_error = urllib.error.URLError("connection refused")
        self.assertEqual(self.run_backup()[0], 3)
        archive = self.archives(True)[0]
        rc, _out, err = self.run_restore([str(archive)])
        self.assertEqual(rc, 3, "a degraded archive passed its rehearsal")
        self.assertIn("DEGRADED", err)

    def test_restore_detects_a_tampered_member(self):
        """Silent bit-rot on cheap removable storage is the realistic decay mode,
        and an archive that 'extracts fine' is not an archive that is intact."""
        archive = self._archive()

        def flip(root):
            (root / "plates/erithacus-rubecula.png").write_bytes(_PLATE + b"rot")
        self.rebuild_tar(archive, flip)
        rc, _out, err = self.run_restore([str(archive)])
        self.assertEqual(rc, 4)
        self.assertIn("erithacus-rubecula.png", err)
        self.assertIn("FAILED integrity check", err)

    def test_restore_detects_a_wrong_sidecar(self):
        """A truncated transfer over a flaky mount must be caught BEFORE extraction."""
        archive = self._archive()
        archive.with_name(archive.name + ".sha256").write_text("0" * 64 + "  %s\n" % archive.name)
        rc, _out, err = self.run_restore([str(archive)])
        self.assertEqual(rc, 4)
        self.assertIn(archive.name, err)
        self.assertIn("sidecar", err)

    def test_restore_fails_on_a_null_detection_count(self):
        """Skipping the count assertion when the manifest recorded null is what let
        an empty archive pass the rehearsal that exists to catch it. A manifest
        that cannot prove its own contents is not a verified archive."""
        archive = self._archive()

        def blank(root):
            manifest = json.loads((root / "MANIFEST.json").read_text())
            manifest["birds_db"]["detections"] = None
            (root / "MANIFEST.json").write_text(json.dumps(manifest))
        self.rebuild_tar(archive, blank)
        rc, _out, err = self.run_restore([str(archive)])
        self.assertEqual(rc, 4)
        self.assertIn("NULL detection count", err)

    def test_restore_rejects_path_traversal(self):
        """The archive lives on a mount that is not access-controlled; extraction
        must not be a write primitive."""
        payload = self.tmp / "payload.txt"
        payload.write_text("pwned\n")
        evil = self.dest / "christina-backup-20990101T000000Z.tar.gz"
        with tarfile.open(str(evil), "w:gz") as tf:
            tf.add(str(payload), arcname="../evil.txt")
        # Sandbox the workdir's PARENT so a regression writes its escapee here
        # instead of into the real system temp dir (where it would then poison
        # every later run of this test).
        sandbox = self.tmp / "restore-sandbox"
        sandbox.mkdir()
        real_mkdtemp = tempfile.mkdtemp
        with mock.patch.object(restore_offbox.tempfile, "mkdtemp",
                               lambda **kw: real_mkdtemp(dir=str(sandbox))):
            rc, _out, err = self.run_restore([str(evil)])
        self.assertEqual(rc, 4)
        self.assertIn("refusing unsafe archive member", err)
        self.assertFalse((sandbox / "evil.txt").exists(), "extraction escaped its working directory")

    def test_restore_apply_places_plates_in_tier1_and_never_clobbers(self):
        """The whole value of restoring to cutout.php tier 1 is that the wall works
        with Railway dead -- and a restore that destroys the thing it might be
        wrong about is not a recovery, it is a second incident."""
        archive = self._archive()
        manifest = self.manifest_of(archive)
        db = self.repo / "scripts/birds.db"
        db.write_bytes(b"SENTINEL-DB")
        tier1 = self.repo / "avian/assets/illustrations"
        (tier1 / "erithacus-rubecula.png").write_bytes(b"SENTINEL-PLATE")

        rc, out, _err = self.run_restore([str(archive), "--apply", "--repo", str(self.repo)])
        self.assertEqual(rc, 0)
        self.assertTrue((tier1 / "psittacula-krameri.png").is_file())
        self.assertEqual((tier1 / "erithacus-rubecula.png").read_bytes(), b"SENTINEL-PLATE")
        self.assertIn("skip (already present): erithacus-rubecula.png", out)
        self.assertEqual(offbox_backup.sha256_of(db), manifest["birds_db"]["sha256"])
        aside = list((self.repo / "scripts").glob("birds.db.pre-restore-*"))
        self.assertEqual(len(aside), 1)
        self.assertEqual(aside[0].read_bytes(), b"SENTINEL-DB")
        self.assertTrue((self.repo / "scripts/phenology.json").is_file())
        self.assertIn("git clean -fdx", out)

    def test_restore_refuses_a_non_checkout_repo(self):
        """--apply into the wrong directory would scatter a database and 40 plates
        somewhere nobody looks. cutout.php is the marker that this is the wall."""
        archive = self._archive()
        elsewhere = self.tmp / "notarepo"
        elsewhere.mkdir()
        rc, _out, err = self.run_restore([str(archive), "--apply", "--repo", str(elsewhere)])
        self.assertEqual(rc, 2)
        self.assertIn("not a belkins-birdnet checkout", err)

    def test_restore_usage_errors_are_exit_2(self):
        rc, _out, err = self.run_restore(["--wat"])
        self.assertEqual(rc, 2)
        self.assertIn("unknown flag", err)
        self.assertEqual(self.run_restore([str(self.tmp / "nope.tar.gz")])[0], 2)


if __name__ == "__main__":
    unittest.main()
