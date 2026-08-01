"""config-to-r2.sh + plates-to-r2.sh — the weekly continuity pass, offline.

Same doctrine as test_cloud_backup.py: a real (stubbed) object store on disk via
stub_rclone.py, the scripts run for real, and almost every test is a NEGATIVE
test of a refusal or a propagation rule. The sharpest case here is the one the
arsenal bias lens found in the shipped 2026-08-01 plates-to-r2.sh: offbox exit 3
(DEGRADED — a real, usable archive with a flag) hit `set -e`, the trap deleted
the staging dir, and the flagged night was exactly the night no copy left the
box. Proven against the OLD script at authoring time (see the fix commit):
old = exit 3 with an EMPTY store; fixed = exit 3 with the archive UPLOADED.
"""
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_STUB = _HERE / "stub_rclone.py"
_CONFIG_SH = _HERE.parent / "config-to-r2.sh"
_PLATES_SH = _HERE.parent / "plates-to-r2.sh"


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


class _Base(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="contr2-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.remote = self.tmp / "remote"
        self.remote.mkdir()
        self.envfile = self.tmp / "cloud-backup.env"
        self.envfile.write_text("CHRISTINA_CLOUD_REMOTE=stub:\n")
        b = self.tmp / "bin"
        b.mkdir()
        rclone = b / "rclone"
        rclone.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{_STUB}" "$@"\n')
        rclone.chmod(0o755)
        self.bin = b

    def env(self, **extra) -> dict:
        e = {
            "PATH": f"{self.bin}:/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": str(self.tmp),
            "TMPDIR": str(self.tmp),
            "STUB_REMOTE_DIR": str(self.remote),
            "CLOUD_BACKUP_ENV": str(self.envfile),
        }
        e.update({k: str(v) for k, v in extra.items()})
        return e

    def run_sh(self, script: Path, **envkw):
        return subprocess.run(["bash", str(script)], env=self.env(**envkw),
                              capture_output=True, text=True, timeout=60)

    def stored(self) -> list:
        return sorted(str(p.relative_to(self.remote))
                      for p in self.remote.rglob("*") if p.is_file())


class ConfigToR2(_Base):
    """The identity set: derived, pinned, refuse-before-first-upload."""

    def setUp(self) -> None:
        super().setUp()
        self.conf = self.tmp / "birdnet.conf"
        self.conf.write_text('STATION_OPEN="1"\nCADDY_PWD="s3cret"\n')
        self.caddy = self.tmp / "Caddyfile"
        self.caddy.write_text("http:// {\n  encode zstd gzip\n}\n")
        self.rconf = self.tmp / "rclone.conf"
        self.rconf.write_text("[r2crypt]\ntype = crypt\n")
        self.envdir = self.tmp / ".christina"
        self.envdir.mkdir()
        (self.envdir / "forwarder.env").write_text("AV_RAILWAY_BASE=x\n")
        (self.envdir / "catalog.env").write_text("CHRISTINA_MANIFEST_URL=y\n")
        self.overrides = dict(
            CHRISTINA_BIRDNET_CONF=self.conf,
            CHRISTINA_CADDYFILE=self.caddy,
            CHRISTINA_RCLONE_CONF=self.rconf,
            CHRISTINA_ENV_DIR=self.envdir,
        )

    def test_uploads_the_full_pinned_set_byte_identical(self) -> None:
        r = self.run_sh(_CONFIG_SH, **self.overrides)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.stored(), [
            "config/Caddyfile.live", "config/birdnet.conf",
            "config/christina/catalog.env", "config/christina/forwarder.env",
            "config/rclone.conf",
        ])
        self.assertEqual((self.remote / "config/birdnet.conf").read_bytes(),
                         self.conf.read_bytes())
        self.assertIn("5/5", r.stdout)

    def test_missing_birdnet_conf_refuses_and_uploads_NOTHING(self) -> None:
        self.conf.unlink()
        r = self.run_sh(_CONFIG_SH, **self.overrides)
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertEqual(self.stored(), [], "a partial identity set was uploaded past a refusal")

    def test_zero_env_files_refuses_the_empty_derived_set(self) -> None:
        for f in self.envdir.glob("*.env"):
            f.unlink()
        r = self.run_sh(_CONFIG_SH, **self.overrides)
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertEqual(self.stored(), [])
        self.assertIn("EMPTY", r.stderr)

    def test_non_crypt_remote_is_refused(self) -> None:
        r = self.run_sh(_CONFIG_SH, STUB_NOT_CRYPT="1", **self.overrides)
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertEqual(self.stored(), [])
        self.assertIn("crypt", r.stderr)


class PlatesToR2(_Base):
    """The exit-code contract: 0/3 upload, 2/4 never do — and 3 STILL uploads."""

    def _offbox_stub(self, rc: int, write_archive: bool) -> Path:
        stub = self.tmp / "offbox_stub.py"
        body = ""
        if write_archive:
            body = (
                "d = Path(os.environ['CHRISTINA_BACKUP_DEST'])\n"
                "blob = b'fake-tar-bytes-for-continuity-test'\n"
                "(d / 'christina-backup-TEST.tar.gz').write_bytes(blob)\n"
                "import hashlib\n"
                "(d / 'christina-backup-TEST.tar.gz.sha256').write_text(\n"
                "    hashlib.sha256(blob).hexdigest() + '  christina-backup-TEST.tar.gz\\n')\n"
            )
        stub.write_text("import os, sys\nfrom pathlib import Path\n" + body + f"sys.exit({rc})\n")
        return stub

    def _fwd(self) -> Path:
        f = self.tmp / "forwarder.env"
        f.write_text("AV_RAILWAY_BASE=http://unused.invalid\n")
        return f

    def run_plates(self, rc: int, write_archive: bool):
        return self.run_sh(
            _PLATES_SH,
            CHRISTINA_OFFBOX_SCRIPT=self._offbox_stub(rc, write_archive),
            FORWARDER_ENV=self._fwd(),
        )

    def test_complete_run_uploads_and_verifies(self) -> None:
        r = self.run_plates(0, True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.stored(), [
            "plates-oneshot/christina-backup-TEST.tar.gz",
            "plates-oneshot/christina-backup-TEST.tar.gz.sha256",
        ])

    def test_DEGRADED_archive_is_still_uploaded_then_3_propagates(self) -> None:
        # THE arsenal finding: the old script lost exactly this archive.
        r = self.run_plates(3, True)
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertIn("plates-oneshot/christina-backup-TEST.tar.gz", self.stored(),
                      "DEGRADED must upload the flagged archive BEFORE propagating the flag")
        self.assertIn("DEGRADED", r.stderr)

    def test_REFUSED_uploads_nothing_and_stays_2(self) -> None:
        r = self.run_plates(2, False)
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertEqual(self.stored(), [])

    def test_FAULT_uploads_nothing(self) -> None:
        r = self.run_plates(4, False)
        self.assertEqual(r.returncode, 4, r.stderr)
        self.assertEqual(self.stored(), [])

    def test_success_exit_with_missing_archive_is_a_FAULT_not_a_green(self) -> None:
        # offbox lies "0" but staged nothing -> the wrapper must not report success.
        r = self.run_plates(0, False)
        self.assertEqual(r.returncode, 4, r.stderr)
        self.assertEqual(self.stored(), [])


if __name__ == "__main__":
    unittest.main()
