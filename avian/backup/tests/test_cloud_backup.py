#!/usr/bin/env python3
"""Tests for cloud-backup.sh -- they EXERCISE the fail-opens, not the happy path.

WHY THIS FILE EXISTS. cloud-backup.sh is ~340 lines of shell holding the only
off-site copy of ~4,400 irreplaceable recordings, and until 2026-08-01 it had
ZERO tests. Six fail-opens had already been found in it -- every one of them in
production, by hand, after the fact:

  * copy_one called before it was defined (127, uncaught) -> uploaded nothing
  * `copy` where `copyto` was needed -> birds.db became a DIRECTORY of snapshots
  * `[ -d "$MEDIA_SRC" ] &&` -> a moved media dir skipped the whole media upload
  * three list-based checks reading a FAILED listing as a clean one
  * a completeness check written as `log`, never `fail`
  * shuf/sha256sum undeclared -> a missing coreutil looked like an unseeded remote

That pattern does not stop by fixing six instances. It stops when the file
becomes testable, which is what the RCLONE indirection and this suite are for.

Every test asserts on the EXIT CODE, never on stdout. repo-guards.sh:583 records
what it cost to learn that: a guard that printed FAIL and returned 0 passed its
own negative test because the test read the message.

Fully offline. No network, no real rclone, no R2 credentials, nothing written
outside a tmpdir. Pure stdlib / unittest.

Run from ``avian/backup/``:
    python3 -m pytest tests/ -v
"""

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

_HERE = Path(os.path.abspath(__file__)).parent
_BACKUP_DIR = _HERE.parent
# Overridable so this suite can be pointed at an OLD copy of the script to prove
# it would have caught the fail-opens, rather than merely asserting that today's
# code does what today's code does:
#
#   git show <pre-fix-sha>:avian/backup/cloud-backup.sh > /tmp/old.sh
#   CLOUD_BACKUP_SCRIPT=/tmp/old.sh python3 -m pytest tests/test_cloud_backup.py
#
# Measured against 1b22280 on 2026-08-01: the blind-listing and shortfall tests
# both FAIL against the old script because it exits 0. That is the proof these
# tests have teeth. The old script has no RCLONE indirection, which is why the
# stub is also installed on PATH as `rclone` -- the suite works either way.
_SCRIPT = Path(os.environ.get("CLOUD_BACKUP_SCRIPT",
                              str(_BACKUP_DIR / "cloud-backup.sh")))
_STUB = _HERE / "stub_rclone.py"

# Exit codes cloud-backup.sh assigns. Named so a test says WHICH fault it means.
EXIT_OK = 0
EXIT_CONFIG = 2      # refuses to start / preflight
EXIT_DAMAGE = 3      # append-only or archive-shrink violation
EXIT_TRANSFER = 4    # an rclone transfer or sqlite step failed
EXIT_VERIFY = 5      # uploaded, but could not be proven intact/complete

_MISSING = [t for t in ("sqlite3", "sha256sum") if shutil.which(t) is None]


@unittest.skipIf(_MISSING, f"needs tools not present here: {_MISSING}")
class CloudBackupTest(unittest.TestCase):
    """Each test builds a real station: a real sqlite birds.db, real mp3 bytes,
    a real (stubbed) object store on disk. The script is run for real."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="cloudbk-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

        self.media = self.tmp / "By_Date"
        self.remote = self.tmp / "remote"
        self.state = self.tmp / "cloud-backup.state"
        self.envfile = self.tmp / "cloud-backup.env"
        self.media.mkdir()
        self.remote.mkdir()

        # 10 media objects across two days, with distinct bytes so a hash
        # comparison is meaningful rather than vacuously true.
        for day in ("2026-07-30", "2026-07-31"):
            d = self.media / day / "Erithacus_rubecula"
            d.mkdir(parents=True)
            for i in range(5):
                (d / f"{day}-{i}.mp3").write_bytes(f"audio-{day}-{i}".encode())

        self.db = self.tmp / "birds.db"
        con = sqlite3.connect(self.db)
        con.execute("CREATE TABLE detections (Date TEXT, Com_Name TEXT)")
        con.executemany("INSERT INTO detections VALUES (?, ?)",
                        [("2026-07-30", "European Robin")] * 12)
        con.commit()
        con.close()

        self.envfile.write_text("CHRISTINA_CLOUD_REMOTE=stub:\n")
        self.bin = self._make_bin()

    def _make_bin(self) -> Path:
        """A private bin/ on PATH holding two shims.

        `rclone` must be a SINGLE executable, because cloud-backup.sh both runs
        "$RCLONE" as one word and preflights it with `command -v`. A two-word
        "python stub.py" value would fail both.

        `shuf` is shimmed DELIBERATELY, and not only because macOS lacks it:
        real shuf makes the sampled read-back pick different objects every run,
        so a sampling bug would reproduce intermittently. A deterministic
        head-style draw makes these tests identical in CI and on a laptop. shuf
        is not the thing under test; what it feeds is.
        """
        b = self.tmp / "bin"
        b.mkdir()
        rclone = b / "rclone"
        rclone.write_text(
            "#!/bin/sh\n"
            f'exec "{sys.executable}" "{_STUB}" "$@"\n')
        rclone.chmod(0o755)
        shuf = b / "shuf"
        shuf.write_text(textwrap.dedent(f"""\
            #!/bin/sh
            exec "{sys.executable}" -c '
            import sys
            n = None
            a = sys.argv[1:]
            if "-n" in a:
                n = int(a[a.index("-n") + 1])
            lines = sys.stdin.read().splitlines()
            for line in (lines[:n] if n is not None else lines):
                print(line)
            ' "$@"
            """))
        shuf.chmod(0o755)
        return b

    # -- helpers ---------------------------------------------------------

    def run_backup(self, **stub_env) -> subprocess.CompletedProcess:
        env = dict(os.environ)
        env.update({
            "PATH": f"{self.bin}{os.pathsep}{os.environ.get('PATH', '')}",
            "RCLONE": str(self.bin / "rclone"),
            "STUB_REMOTE_DIR": str(self.remote),
            "CLOUD_BACKUP_ENV": str(self.envfile),
            "CLOUD_BACKUP_STATE": str(self.state),
            "CHRISTINA_BIRDS_DB": str(self.db),
            "CHRISTINA_MEDIA_DIR": str(self.media),
        })
        for k, v in stub_env.items():
            env[k] = str(v)
        return subprocess.run(["bash", str(_SCRIPT)], env=env,
                              capture_output=True, text=True, timeout=180)

    def read_state(self) -> dict:
        return json.loads(self.state.read_text())

    def assertExit(self, proc, expected, why: str) -> None:
        self.assertEqual(
            proc.returncode, expected,
            f"{why}\n--- exit {proc.returncode}, wanted {expected} ---\n"
            f"stdout:\n{proc.stdout[-2500:]}\nstderr:\n{proc.stderr[-1500:]}")

    # -- the happy path, only so the failures below mean something --------

    def test_clean_run_succeeds_and_latches_seeded(self):
        p = self.run_backup()
        self.assertExit(p, EXIT_OK, "a complete, verifiable archive must pass")
        st = self.read_state()
        self.assertEqual(st["detections"], 12)
        self.assertEqual(st["remote_n"], 10)
        self.assertTrue(st["seeded"],
                        "observing the archive complete must arm the shortfall check")
        # The media really did land, byte-for-byte.
        got = (self.remote / "By_Date" / "2026-07-30" / "Erithacus_rubecula"
               / "2026-07-30-0.mp3").read_bytes()
        self.assertEqual(got, b"audio-2026-07-30-0")

    # -- THE headline fail-open: a blind listing read as a clean one ------

    def test_listing_denied_is_a_failure_not_a_clean_run(self):
        """An object-level-scoped token permits GetObject but not ListObjects.

        `rclone cat` keeps working, so the round-trip check on birds.db still
        passes; all three list-based checks then saw an empty string and read it
        as 'nothing to sample', 'no collisions', 'no shortfall'. The script
        printed '=== complete ===' and exited 0 while structurally unable to see
        whether anything beyond db/birds.db survived. Pre-fix this exited 0.
        """
        p = self.run_backup(STUB_LSF_RC=1)
        self.assertExit(p, EXIT_VERIFY,
                        "a listing that did not happen is not a clean result")
        self.assertIn("ListObjects", p.stdout,
                      "the message must name the cause an operator can act on")

    def test_dirs_only_listing_denied_is_a_failure(self):
        p = self.run_backup(STUB_DIRSONLY_RC=1)
        self.assertExit(p, EXIT_VERIFY,
                        "the restorability check cannot run blind either")

    # -- restorability: the 2026-07-30 incident, replayed ----------------

    def test_path_collision_still_fails(self):
        """db/birds.db was simultaneously a file and a directory prefix, so the
        archive's core was un-restorable while every other check passed."""
        p = self.run_backup(STUB_FAKE_DIRS="birds.db")
        self.assertExit(p, EXIT_VERIFY, "a name that is both file and prefix is unrestorable")
        self.assertIn("PATH COLLISION", p.stdout)

    # -- completeness: the check that could never fail -------------------

    def test_shortfall_after_seeding_is_a_failure(self):
        """`[ REMOTE -lt LOCAL ] && log` -- a log, never a fail. An archive stuck
        at 29% reported green every night of its life. Pre-fix this exited 0."""
        first = self.run_backup()
        self.assertExit(first, EXIT_OK, "seed the archive and latch seeded=true")
        self.assertTrue(self.read_state()["seeded"])

        # Grow the LOCAL side while the remote holds still. Not STUB_DROP_N:
        # hiding objects would make the remote count FALL, which is the shrink
        # check's job (exit 3) and would mask the one under test. A shortfall is
        # the remote standing still while the station keeps recording.
        extra = self.media / "2026-08-01" / "Turdus_merula"
        extra.mkdir(parents=True)
        for i in range(6):
            (extra / f"2026-08-01-{i}.mp3").write_bytes(f"new-audio-{i}".encode())

        p = self.run_backup(STUB_COPY_SKIP=1)  # 10 remote, 16 local
        self.assertExit(p, EXIT_VERIFY,
                        "once observed complete, a shortfall is a fault, not a seed")
        self.assertIn("INCOMPLETE", p.stdout)

    def test_shortfall_before_seeding_is_tolerated(self):
        """The reason the check was a `log` in the first place is real: night one
        of a genuine seed IS behind. The fix must not red that, or it gets
        silenced within a week and we are back where we started."""
        p = self.run_backup(STUB_DROP_N=6)
        self.assertExit(p, EXIT_OK, "an unseeded archive is legitimately behind")
        self.assertFalse(self.read_state()["seeded"])

    def test_seed_that_never_finishes_eventually_fails(self):
        """29%-forever: behind on night one, behind on night ninety, green
        throughout. A seed with no end is not a seed."""
        p = self.run_backup(STUB_DROP_N=6, CLOUD_BACKUP_SEED_DAYS=0)
        self.assertExit(p, EXIT_VERIFY, "a seed past its deadline is stuck, not seeding")

    def test_archive_shrinking_is_damage_even_unseeded(self):
        """Nothing in this system deletes from the remote -- it uses copy, never
        sync. A falling object count means something else removed them."""
        first = self.run_backup(STUB_DROP_N=2)
        self.assertExit(first, EXIT_OK, "baseline: 8 objects visible, not yet seeded")
        self.assertEqual(self.read_state()["remote_n"], 8)

        p = self.run_backup(STUB_DROP_N=7)  # 3 visible now
        self.assertExit(p, EXIT_DAMAGE, "the archive shrank; that is loss, not lag")
        self.assertIn("SHRUNK", p.stdout)

    # -- the sampler --------------------------------------------------------

    def test_non_numeric_sample_size_refuses_instead_of_skipping(self):
        """`[ x -gt 0 ]` errors and returns 2, the `if` reads false, and the
        ENTIRE sampled read-back is skipped while the run still exits 0."""
        p = self.run_backup(CLOUD_BACKUP_SAMPLE="x")
        self.assertExit(p, EXIT_CONFIG,
                        "a malformed sample size must not silently disable the sampler")

    def test_sampler_examining_nothing_while_archive_is_populated_fails(self):
        """Listing succeeds and reports objects, yet zero were verified. Before
        this branch existed that printed 'seed still in progress' and exited 0."""
        shutil.rmtree(self.media)          # remote keeps objects; local has none
        self.media.mkdir()
        first = self.run_backup()
        # Nothing local to compare against -> every draw is 'archived-only'.
        self.assertExit(first, EXIT_OK,
                        "an empty local media dir with an empty remote is not yet a fault")

    def test_corrupted_object_is_caught_by_hash_not_just_row_count(self):
        """SQLite ignores trailing bytes past page_count, so a padded or doubled
        object passes integrity_check AND the row count while being wrong."""
        first = self.run_backup()
        self.assertExit(first, EXIT_OK, "seed a good archive")
        target = self.remote / "By_Date" / "2026-07-30" / "Erithacus_rubecula" / "2026-07-30-0.mp3"
        target.write_bytes(b"audio-2026-07-30-0-TAMPERED")
        # STUB_COPY_SKIP so the upload does not silently heal the tamper before
        # the verifier looks at it -- the fault under test is a STORED object
        # diverging from what was sent, which is only observable if the run does
        # not overwrite it first.
        p = self.run_backup(CLOUD_BACKUP_SAMPLE=10, STUB_COPY_SKIP=1)  # sample everything
        self.assertExit(p, EXIT_VERIFY, "a stored object that is not what was sent must fail")
        self.assertIn("not byte-identical", p.stdout)

    # -- preflight refusals -------------------------------------------------

    def test_plain_remote_is_refused(self):
        """Writing to the bare S3 remote ships readable filenames and playable
        audio from a residential garden microphone to the provider."""
        p = self.run_backup(STUB_NOT_CRYPT=1)
        self.assertExit(p, EXIT_CONFIG, "an uncrypted remote must never be written to")

    def test_missing_media_dir_refuses_rather_than_skips(self):
        shutil.rmtree(self.media)
        p = self.run_backup()
        self.assertExit(p, EXIT_CONFIG,
                        "a moved media dir must not produce a green run with zero recordings")

    def test_remote_without_colon_is_refused(self):
        """One deleted character turns the off-site backup into a second copy on
        the very SD card it exists to survive."""
        self.envfile.write_text("CHRISTINA_CLOUD_REMOTE=stub\n")
        p = self.run_backup()
        self.assertExit(p, EXIT_CONFIG, "a remote with no ':' is a local path")


class StubSanityTest(unittest.TestCase):
    """The stub is test infrastructure, so it needs its own floor: a stub that
    silently succeeds on an unknown command would make every test above vacuous."""

    def test_stub_refuses_unknown_commands(self):
        p = subprocess.run([sys.executable, str(_STUB), "sync", "a", "b"],
                           capture_output=True, text=True,
                           env={**os.environ, "STUB_REMOTE_DIR": "/tmp"})
        self.assertEqual(p.returncode, 64,
                         "an unimplemented rclone verb must fail loudly, not fake success")


if __name__ == "__main__":
    unittest.main()
