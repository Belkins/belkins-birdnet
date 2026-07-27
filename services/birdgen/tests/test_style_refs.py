#!/usr/bin/env python3
"""Tests for the per-deployment style-reference mapping (style-refs.json).

WHY THIS EXISTS. pregen.py used to be TWO forked copies — services/birdgen/ and
avian/scripts/ — because the two deployments legitimately ship different style
plates (the Edo kachō-e prints by Koson/Yoshida are not redistributable, so the
service uses the project's own bundled house plates instead).

That real, data-shaped difference was being carried by duplicating 675 lines of
pipeline CODE, so every fix reached only one side: the AV_GEN_MODEL override, a
defensive-titles IndexError fix, and the robin species-note (28 commits to
develop) all landed in one copy and not the other.

The mapping now lives in style-refs.json beside each entry point, and
avian/scripts/pregen.py is a SYMLINK to this file. These tests pin the two
invariants that make that safe:

  1. The sidecar is resolved from the SYMLINK's directory (abspath), never the
     real file's (realpath) — otherwise both deployments load the birdgen
     mapping and the divergence silently returns.
  2. A missing/partial/malformed sidecar degrades to the bundled mapping LOUDLY
     and completely — never to a half-populated dict, because select_style_ref
     indexes STYLE_REFS directly and a partial dict raises KeyError for one
     genus only ("that one bird looks wrong").

Run from ``services/birdgen/``:
    python3 -m pytest tests/ -v
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import pregen

HERE = Path(__file__).resolve().parent
BIRDGEN = HERE.parent
REPO = BIRDGEN.parent.parent
AVIAN = REPO / "avian" / "scripts"

REQUIRED = set(pregen._STYLE_REFS_FALLBACK)


def _load_via(cwd: Path) -> dict:
    """Import pregen with `cwd` as the script dir and dump STYLE_REFS.

    A subprocess, deliberately: STYLE_REFS is built at import time, so an
    in-process reimport would reuse the cached module and prove nothing.
    """
    out = subprocess.check_output(
        [sys.executable, "-c",
         "import json,pregen;print(json.dumps(pregen.STYLE_REFS))"],
        cwd=str(cwd), text=True,
    )
    return json.loads(out.strip().splitlines()[-1])


# --------------------------------------------------------------------------- #
# 1. The de-duplication invariant: one code file, two data files
# --------------------------------------------------------------------------- #
def test_avian_pregen_is_a_symlink_to_birdgen():
    p = AVIAN / "pregen.py"
    assert p.is_symlink(), (
        "avian/scripts/pregen.py must stay a symlink — a real file there is how "
        "the two copies silently diverged for 675 lines")
    assert os.path.realpath(p) == os.path.realpath(BIRDGEN / "pregen.py")


def test_each_deployment_loads_its_own_style_refs():
    """The whole point. Same module, different data, decided by which directory
    it was invoked from."""
    service = _load_via(BIRDGEN)
    local = _load_via(AVIAN)
    assert service["small_songbird_perched"].endswith(".png")
    assert local["small_songbird_perched"].endswith(".jpg")
    assert service != local, (
        "both deployments resolved the SAME mapping — style-refs.json is being "
        "read via realpath (which follows the symlink) instead of abspath")


def test_local_pipeline_cli_defaults_point_into_avian_not_services():
    """REGRESSION (QA 2026-07-27): the symlink made Path(__file__).resolve() in
    argparse defaults collapse to services/birdgen/, so --out/--refs/--styles
    pointed at a NONEXISTENT services/assets/... The documented command in
    README.md (python3 avian/scripts/pregen.py --labels ... --force) would then
    read no reference photos and write plates outside the tree the collage
    serves. The style-refs sidecar was guarded against exactly this trap; these
    three defaults three lines below it were not."""
    out = subprocess.check_output(
        [sys.executable, "-c",
         "import os,json;from pathlib import Path;"
         "h=Path(os.path.abspath('pregen.py')).parent;"
         "print(json.dumps({'out':str(h.parent/'assets'/'illustrations'),"
         "'refs':str(h.parent/'assets'/'references')}))"],
        cwd=str(AVIAN), text=True)
    d = json.loads(out.strip().splitlines()[-1])
    assert "/avian/assets/" in d["out"], "local --out escaped avian/: " + d["out"]
    assert "/avian/assets/" in d["refs"], "local --refs escaped avian/: " + d["refs"]
    assert Path(d["out"]).is_dir(), "local --out points at a nonexistent dir: " + d["out"]
    assert Path(d["refs"]).is_dir(), "local --refs points at a nonexistent dir: " + d["refs"]


def test_no_resolve_based_path_defaults_remain_in_pregen():
    """Belt and braces: resolve()/realpath() anywhere in pregen's path defaults
    reintroduces the symlink collapse. Keep them out."""
    src = (BIRDGEN / "pregen.py").read_text(encoding="utf-8")
    offenders = [ln.strip() for ln in src.split("\n")
                 if "Path(__file__).resolve()" in ln or "os.path.realpath(__file__)" in ln]
    assert not offenders, "symlink-unsafe path defaults reintroduced: " + repr(offenders)


def test_both_sidecars_cover_every_required_category():
    """select_style_ref indexes STYLE_REFS directly, so a category missing from
    a sidecar is a KeyError for one genus only — the hardest kind to notice."""
    for name, path in (("birdgen", BIRDGEN / "style-refs.json"),
                       ("avian", AVIAN / "style-refs.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        missing = REQUIRED - set(data)
        assert not missing, "%s style-refs.json missing categories: %s" % (name, sorted(missing))
        for k in REQUIRED:
            assert isinstance(data[k], str) and data[k], "%s: %s is empty" % (name, k)


def test_birdgen_sidecar_files_actually_exist_on_disk():
    """The service's plates ARE bundled, so a typo is checkable here. (The local
    Koson/Yoshida prints are deliberately not in the repo, so they are not.)"""
    data = json.loads((BIRDGEN / "style-refs.json").read_text(encoding="utf-8"))
    for k in REQUIRED:
        assert (BIRDGEN / "styles" / data[k]).is_file(), \
            "style plate %r (category %s) is not bundled at services/birdgen/styles/" % (data[k], k)


# --------------------------------------------------------------------------- #
# 2. Degradation: loud and COMPLETE, never partial
# --------------------------------------------------------------------------- #
def _load_with_sidecar(tmp_path, payload) -> dict:
    p = tmp_path / "sr.json"
    p.write_text(payload if isinstance(payload, str) else json.dumps(payload), encoding="utf-8")
    env = dict(os.environ, AV_STYLE_REFS=str(p))
    out = subprocess.check_output(
        [sys.executable, "-c", "import json,pregen;print(json.dumps(pregen.STYLE_REFS))"],
        cwd=str(BIRDGEN), text=True, env=env, stderr=subprocess.DEVNULL,
    )
    return json.loads(out.strip().splitlines()[-1])


def test_missing_sidecar_falls_back_to_bundled(tmp_path):
    env = dict(os.environ, AV_STYLE_REFS=str(tmp_path / "does-not-exist.json"))
    out = subprocess.check_output(
        [sys.executable, "-c", "import json,pregen;print(json.dumps(pregen.STYLE_REFS))"],
        cwd=str(BIRDGEN), text=True, env=env, stderr=subprocess.DEVNULL,
    )
    assert json.loads(out.strip().splitlines()[-1]) == pregen._STYLE_REFS_FALLBACK


def test_partial_sidecar_is_refused_whole(tmp_path):
    """A partial mapping must NOT be merged in. Half-applying it would work for
    owls and KeyError for everything else."""
    got = _load_with_sidecar(tmp_path, {"owl": "custom-owl.png"})
    assert got == pregen._STYLE_REFS_FALLBACK
    assert got["owl"] != "custom-owl.png"


def test_malformed_sidecar_falls_back(tmp_path):
    assert _load_with_sidecar(tmp_path, "{not json") == pregen._STYLE_REFS_FALLBACK


def test_non_object_sidecar_falls_back(tmp_path):
    assert _load_with_sidecar(tmp_path, ["a", "list"]) == pregen._STYLE_REFS_FALLBACK


def test_complete_valid_sidecar_is_honoured(tmp_path):
    """The happy path must actually take effect — otherwise the fallback would
    mask a real misconfiguration forever."""
    custom = {k: "custom-%s.png" % k for k in REQUIRED}
    got = _load_with_sidecar(tmp_path, custom)
    assert got == custom


# --------------------------------------------------------------------------- #
# 3. select_style_ref still routes correctly on top of the loaded mapping
# --------------------------------------------------------------------------- #
def test_select_style_ref_routes_pose_and_genus():
    assert pregen.select_style_ref("Apus apus", 2) == pregen.STYLE_REFS["small_flight"]
    assert pregen.select_style_ref("Aquila chrysaetos", 2) == pregen.STYLE_REFS["large_flight"]
    # Uncategorised genus falls back to the songbird plate, never KeyError.
    assert pregen.select_style_ref("Zzzgenus madeup", 1) == \
        pregen.STYLE_REFS["small_songbird_perched"]
