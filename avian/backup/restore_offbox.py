#!/usr/bin/env python3
"""Rehearse or perform a restore from an offbox_backup.py archive.

DEFAULT IS A REHEARSAL: it verifies and prints, and touches NOTHING -- safe to
run on the live Pi, and safe on a laptop with no Pi and no Railway anywhere near
it. An archive nobody has ever opened is a belief, not a backup.

    python3 restore_offbox.py <archive.tar.gz>                  # rehearse (default)
    python3 restore_offbox.py <archive.tar.gz> --apply [--repo DIR] [--force]

Exit codes:
  0  the archive verified (and, with --apply, was installed)
  2  usage error, missing archive, or --repo is not a belkins-birdnet checkout
  4  the archive FAILED verification -- it is not a backup

This file is deliberately standalone (its own sha256_of, no import of
offbox_backup) so that copying just this one script next to an archive off the
mount is enough to rehearse a restore on any machine.
"""
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tarfile
import tempfile
import time
import urllib.request
from pathlib import Path

USAGE = "usage: restore_offbox.py <archive.tar.gz> [--apply] [--force] [--repo DIR]"


def sha256_of(path):
    h = hashlib.sha256()
    with open(str(path), "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def safe_members(tf):
    """Reject anything that is not a plain relative file/dir.

    Python < 3.12 extracts tar members wherever they say to go. This archive
    comes off a mount that anyone with physical access can write to, so
    extraction must not be a write primitive.
    """
    members = tf.getmembers()
    for m in members:
        parts = m.name.replace("\\", "/").split("/")
        if m.name.startswith("/") or ".." in parts or not (m.isfile() or m.isdir()):
            raise ValueError("refusing unsafe archive member: %s" % m.name)
    return members


def _check(root, rel, expected_sha):
    p = root / rel
    if not p.is_file():
        raise ValueError("member %s is MISSING from the archive" % rel)
    got = sha256_of(p)
    if got != expected_sha:
        raise ValueError("member %s FAILED integrity check (manifest %s, actual %s)" % (rel, expected_sha, got))


def verify(archive, workdir):
    """-> (manifest, root). Raises ValueError on anything that is not intact."""
    sidecar = archive.with_name(archive.name + ".sha256")
    if sidecar.is_file():
        want = sidecar.read_text().split()[0] if sidecar.read_text().split() else ""
        got = sha256_of(archive)
        if want != got:
            raise ValueError("archive %s FAILED its .sha256 sidecar (sidecar %s, actual %s)" % (archive.name, want, got))
    with tarfile.open(str(archive), "r:gz") as tf:
        members = safe_members(tf)
        tf.extractall(str(workdir), members=members)
    tops = [p for p in workdir.iterdir() if p.is_dir()]
    if len(tops) != 1:
        raise ValueError("expected exactly one top-level directory in %s, found %d" % (archive.name, len(tops)))
    root = tops[0]
    manifest = json.loads((root / "MANIFEST.json").read_text())

    _check(root, "birds.db", manifest["birds_db"]["sha256"])
    for key, rel in (("accessions", "accessions.json"), ("phenology", "phenology.json")):
        if manifest.get(key):
            _check(root, rel, manifest[key]["sha256"])
    for name, meta in sorted(manifest["plates"]["files"].items()):
        _check(root, os.path.join("plates", name), meta["sha256"])

    want_det = manifest["birds_db"].get("detections")
    if want_det is None:
        # A manifest that cannot prove its own contents is not a verified
        # archive. Skipping the assertion here is what let an empty birds.db
        # pass the rehearsal that exists to catch it.
        raise ValueError("MANIFEST.json records a NULL detection count -- this archive cannot prove its own contents")
    db = root / "birds.db"
    con = sqlite3.connect("file:%s?mode=ro" % urllib.request.pathname2url(str(db.resolve())), uri=True)
    try:
        got_det = con.execute("SELECT COUNT(*) FROM detections").fetchone()[0]
    except sqlite3.Error as e:
        raise ValueError("extracted birds.db is not queryable: %s" % e)
    finally:
        con.close()
    if got_det != want_det:
        raise ValueError("extracted birds.db holds %d detections, MANIFEST.json claims %d" % (got_det, want_det))
    return manifest, root


def report(manifest):
    db = manifest["birds_db"]
    led = manifest.get("accessions") or {}
    phen = manifest.get("phenology") or {}
    pl = manifest["plates"]
    print("-" * 68)
    print("archive stamp   : %s" % manifest["stamp"])
    print("birds.db        : %d bytes, %s detections, %s species" % (db["bytes"], db["detections"], db["species"]))
    print("accessions.json : %s entries" % led.get("entries", "ABSENT"))
    print("phenology.json  : %s entries" % phen.get("entries", "ABSENT"))
    print("plates          : %d fetched of %d expected (%d files incl. pose-2)"
          % (pl["fetched"], pl["expected"], len(pl["files"])))
    for line in manifest.get("notes") or []:
        print("note     : %s" % line)
    for line in manifest.get("degraded") or []:
        print("DEGRADED : %s" % line)
    print("-" * 68)


def _install(src, dst, stamp, force):
    if dst.exists() and not force:
        aside = dst.with_name(dst.name + ".pre-restore-" + stamp)
        os.replace(str(dst), str(aside))
        print("moved existing %s aside -> %s" % (dst.name, aside.name))
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(str(src), str(dst))
    print("restored %s" % dst)


def apply_restore(root, repo, force):
    if not (repo / "avian/api/cutout.php").is_file():
        print("not a belkins-birdnet checkout: %s" % repo, file=sys.stderr)
        return 2
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    for rel, dst in (("birds.db", repo / "scripts/birds.db"),
                     ("accessions.json", repo / "scripts/accessions.json"),
                     ("phenology.json", repo / "scripts/phenology.json")):
        src = root / rel
        if src.is_file():
            _install(src, dst, stamp, force)
    tier1 = repo / "avian/assets/illustrations"
    tier1.mkdir(parents=True, exist_ok=True)
    plates = root / "plates"
    for src in sorted(plates.glob("*.png")) if plates.is_dir() else []:
        dst = tier1 / src.name
        if dst.exists():
            # A restore that destroys the thing it might be wrong about is not a
            # recovery, it is a second incident.
            print("skip (already present): %s" % src.name)
            continue
        shutil.copy2(str(src), str(dst))
        print("restored plate %s" % dst.name)
    print("""
Restored plates serve from cutout.php tier 1 (avian/api/cutout.php:178) BEFORE
the Railway proxy -- the wall works with Railway dead. They are NOT tracked by
git: `git clean -fdx` WILL delete them, exactly like scripts/accessions.json
(.gitignore:76-79). Then:
    sudo systemctl start catalog.service

NOT in this archive: the e-ink frame's operating config (~/.birdframe/) -- on a
rebuilt station Pi redo frame/README.md's one-box section, especially the
base_url = "http://127.0.0.1" line (its absence resurrects the mDNS flakiness
that override exists to kill).
""")
    return 0


def parse_args(argv):
    """-> (archive, apply, force, repo). Raises ValueError on anything unknown."""
    archive = None
    apply_it = force = False
    repo = Path(__file__).resolve().parent.parent.parent
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--apply":
            apply_it = True
        elif a == "--force":
            force = True
        elif a == "--repo":
            i += 1
            if i >= len(argv):
                raise ValueError("--repo needs a directory")
            repo = Path(argv[i]).expanduser()
        elif a.startswith("-"):
            raise ValueError("unknown flag: %s" % a)
        elif archive is None:
            archive = Path(a).expanduser()
        else:
            raise ValueError("unexpected extra argument: %s" % a)
        i += 1
    if archive is None:
        raise ValueError("no archive given")
    return archive, apply_it, force, repo


def main(argv=None):
    argv = sys.argv[1:] if argv is None else list(argv)
    try:
        archive, apply_it, force, repo = parse_args(argv)
    except ValueError as e:
        print("%s\n%s" % (e, USAGE), file=sys.stderr)
        return 2
    if not archive.is_file():
        print("no such archive: %s\n%s" % (archive, USAGE), file=sys.stderr)
        return 2
    work = Path(tempfile.mkdtemp(prefix="christina-restore-"))
    try:
        try:
            manifest, root = verify(archive, work)
        except Exception as e:
            print("ARCHIVE FAILED VERIFICATION: %s" % e, file=sys.stderr)
            return 4
        report(manifest)
        degraded = manifest.get("degraded") or []
        if not apply_it:
            if degraded:
                # A DEGRADED archive is restorable but INCOMPLETE, and the whole
                # point of the rehearsal is to prove the backup is good. Printing
                # the findings and still returning 0 makes an archive missing
                # every plate indistinguishable from a clean one at the only
                # moment anybody looks -- the same can't-fail-so-reports-success
                # shape this job exists to detect in the data.
                print("REHEARSAL FAILED: this archive is DEGRADED -- %d finding(s) listed above. "
                      "It is restorable but INCOMPLETE; do not record this as a passed rehearsal."
                      % len(degraded), file=sys.stderr)
                return 3
            print("rehearsal only -- nothing was written. Add --apply to restore for real.")
            return 0
        # --apply is deliberately still allowed on a degraded archive: an
        # incomplete restore beats no restore when it is the only copy left.
        return apply_restore(root, repo, force)
    finally:
        shutil.rmtree(str(work), ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
