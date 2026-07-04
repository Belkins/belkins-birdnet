#!/usr/bin/env bash
# repo-guards.sh — $0 static tripwires for the failure classes that have
# actually bitten this repo. Run by CI (python-app.yml) and runnable locally.
# Each guard names the incident it prevents; keep that discipline when adding.
set -u
cd "$(dirname "$0")/.."
FAIL=0
fail() { printf 'GUARD FAIL: %s\n' "$*"; FAIL=1; }

# 1. species-notes.json must parse. It is a hand-edited file of 1.5-4.8k-char
#    prompt blobs (churned 4x on 2026-07-03 alone) and app.py loads it with a
#    bare json.loads AT IMPORT — one stray comma bricks every future Railway
#    deploy until someone reads the build log.
python3 -m json.tool services/birdgen/species-notes.json >/dev/null 2>&1 \
  || fail "services/birdgen/species-notes.json is not valid JSON — this would crash birdgen at import and block every deploy"

# 2. Cache-header tripwire: REAL art must ship Cache-Control: no-cache
#    (avian/api/cutout.php serve_png). This header has regressed twice
#    (max-age=86400 'the mutilated gull outlived its own fix', then
#    max-age=600 'every feet-fix looked like still the same' — b06254c).
#    The propagation contract is LOCKED (pipeline-hardening TOP-INSIGHTS #3);
#    a third silent creep should fail CI, not a live repaint session.
grep -qF "\$cc = \$real ? 'no-cache'" avian/api/cutout.php \
  || fail "avian/api/cutout.php lost the real-art no-cache contract (b06254c) — repaints will look stale for the max-age window again"

# 3. Test-suite enumeration guard: CI runs pytest scoped per component
#    (8284ca8 — three like-named tests/ packages collide at the root), so the
#    workflow hardcodes the suite list. A NEW tests/ dir that isn't enumerated
#    silently never runs while the badge stays green. This guard turns that
#    silent skip into a red build with instructions.
ENUMERATED="tests avian/catalog/tests services/birdgen/tests"
while IFS= read -r d; do
  d="${d#./}"
  case " $ENUMERATED " in
    *" $d "*) : ;;
    *) fail "test suite '$d' is NOT enumerated in .github/workflows/python-app.yml — add a scoped 'python -m pytest' line for it (and this list) or it will never run in CI" ;;
  esac
done < <(find . \
  -path ./.git -prune -o \
  -path ./node_modules -prune -o -path '*/node_modules' -prune -o \
  -path ./_design-plan -prune -o -path ./_plan -prune -o \
  -name venv -prune -o -name .venv -prune -o -name .tox -prune -o \
  -path '*/site-packages/*' -prune -o \
  -type d -name tests -print | while IFS= read -r t; do
    # only dirs that actually contain pytest files count as a suite
    if ls "$t"/test_*.py >/dev/null 2>&1; then printf '%s\n' "$t"; fi
  done)

[ "$FAIL" = "0" ] && echo "repo-guards: all green"
exit $FAIL
