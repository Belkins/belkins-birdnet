#!/usr/bin/env python3
"""A stand-in for `rclone`, backed by a real directory, for cloud-backup.sh tests.

WHY IT IS A REAL LITTLE OBJECT STORE rather than a canned-output script: the
thing cloud-backup.sh checks hardest is that what it reads back is BYTE-IDENTICAL
to what it sent (sha256, after a doubled birds.db passed both integrity_check and
a row count on 2026-07-30). A stub that printed fixed bytes could not exercise
that at all. So `copyto`/`copy` really write into $STUB_REMOTE_DIR and `cat`
really reads back out of it.

Failure injection is by environment variable, so a test names the fault it wants
and nothing else changes:

    STUB_LSF_RC=1        every recursive `lsf` exits non-zero (the ListObjects-
                         denied case: an R2 token scoped to object-level perms
                         permits GetObject, so `cat` keeps working)
    STUB_DIRSONLY_RC=1   every `lsf --dirs-only` exits non-zero
    STUB_FAKE_DIRS=a,b   `lsf --dirs-only` reports these as directories, i.e. a
                         path collision where a name is both file and prefix
    STUB_DROP_N=6        hide N objects from the recursive listing (a shortfall
                         without touching what is actually stored)
    STUB_NOT_CRYPT=1     `config show` reports a plain remote, not a crypt one
    STUB_COPY_SKIP=1     `copy` exits 0 having transferred NOTHING. Real rclone
                         can do exactly this -- files it cannot read are logged
                         and the run still exits 0 -- and it is the only way to
                         hold the remote still while the local side changes,
                         which is what separates "behind" from "shrunk".

Deliberately NOT a mock of rclone's full surface: it implements exactly the six
invocations cloud-backup.sh makes. If the script grows a seventh, this stub
should fail loudly (exit 64) rather than quietly return success -- a stub that
silently succeeds on an unknown command is its own fail-open.
"""

import os
import shutil
import sys
from pathlib import Path


def remote_root() -> Path:
    d = os.environ.get("STUB_REMOTE_DIR")
    if not d:
        print("stub_rclone: STUB_REMOTE_DIR unset", file=sys.stderr)
        sys.exit(64)
    return Path(d)


def to_local(spec: str) -> Path:
    """'stub:/By_Date/a/b.mp3' -> <remote>/By_Date/a/b.mp3"""
    _, _, path = spec.partition(":")
    return remote_root() / path.lstrip("/")


def first_spec(args) -> str:
    for a in args:
        if not a.startswith("-") and ":" in a:
            return a
    print(f"stub_rclone: no remote spec in {args}", file=sys.stderr)
    sys.exit(64)


def env_int(name: str, default: int = 0) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def cmd_lsf(args) -> int:
    """`lsf` in its two shapes: a recursive file listing, and --dirs-only.

    Split out of main() to stay under the repo's max-complexity of 15 (.flake8),
    which `flake8` enforces as an error on PRs to main.
    """
    base = to_local(first_spec(args))

    if "--dirs-only" in args:
        rc = env_int("STUB_DIRSONLY_RC")
        if rc:
            print("stub_rclone: ListObjects denied", file=sys.stderr)
            return rc
        fake = [f for f in os.environ.get("STUB_FAKE_DIRS", "").split(",") if f]
        if fake:
            for name in fake:
                print(f"{name}/")
            return 0
        if base.is_dir():
            for child in sorted(p for p in base.iterdir() if p.is_dir()):
                print(f"{child.name}/")
        return 0

    rc = env_int("STUB_LSF_RC")
    if rc:
        # Mirrors a real object-level-scoped token: listing is refused while
        # GetObject (`cat`, above) still succeeds. That asymmetry is exactly
        # what let three checks go blind while the round-trip check passed.
        print("stub_rclone: ListObjects denied by policy", file=sys.stderr)
        return rc
    if not base.is_dir():
        return 0
    rels = sorted(str(p.relative_to(base)) for p in base.rglob("*") if p.is_file())
    drop = env_int("STUB_DROP_N")
    if drop > 0:
        rels = rels[: max(0, len(rels) - drop)]
    for r in rels:
        print(r)
    return 0


def main() -> int:
    args = sys.argv[1:]
    if not args:
        return 64
    cmd = args[0]

    if cmd == "config":  # config show <remote-name>
        print("type = s3" if os.environ.get("STUB_NOT_CRYPT") == "1" else "type = crypt")
        return 0

    if cmd == "copyto":  # copyto <src-file> <remote:path> [flags]
        src, dst = args[1], to_local(args[2])
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
        return 0

    if cmd == "copy":  # copy <src-dir> <remote:path> [flags]
        if os.environ.get("STUB_COPY_SKIP") == "1":
            return 0  # exits clean having moved nothing, as rclone can
        src, dst = Path(args[1]), to_local(args[2])
        dst.mkdir(parents=True, exist_ok=True)
        shutil.copytree(src, dst, dirs_exist_ok=True)
        return 0

    if cmd == "cat":  # cat <remote:path>
        p = to_local(args[1])
        if not p.is_file():
            print(f"stub_rclone: not found {p}", file=sys.stderr)
            return 1
        sys.stdout.buffer.write(p.read_bytes())
        return 0

    if cmd == "lsf":
        return cmd_lsf(args)

    print(f"stub_rclone: unimplemented command {cmd!r} -- refusing to fake success",
          file=sys.stderr)
    return 64


if __name__ == "__main__":
    sys.exit(main())
