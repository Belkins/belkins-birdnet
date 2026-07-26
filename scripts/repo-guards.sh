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

# 3b. Reverse direction of guard 3: every ENUMERATED suite must still have its
#     scoped pytest line in the workflow. Guard 3 only checks disk-dirs are in
#     ENUMERATED — if the workflow LINE is dropped/renamed while the dir stays,
#     the guard's own copy of the list outlives the workflow it mirrors and the
#     suite silently never runs again (green badge, green guard).
WF=.github/workflows/python-app.yml
for d in $ENUMERATED; do
  ok=0
  case "$d" in
    tests) grep -qE '^[[:space:]]*python -m pytest tests/' "$WF" && ok=1 ;;
    */tests) grep -qF "cd ${d%/tests} && python -m pytest tests/" "$WF" && ok=1 ;;
  esac
  [ "$ok" = "1" ] || fail "ENUMERATED suite '$d' has no matching scoped pytest line in $WF — restore the line or remove it from ENUMERATED in this script"
done

# 4. Committed-dist integrity: every hashed asset a committed web/dist HTML
#    references must itself be IN THE GIT INDEX. The 6274ec2 blank-wall
#    incident: `git add -A` silently skips NEW files under gitignored
#    web/dist/, so index.html shipped referencing bundles that existed only
#    in the worktree — and caddy's php try_files fallback 200-masked every
#    missing module into text/html. Check the INDEX (git show :path), never
#    the worktree — worktree-vs-tree divergence IS the failure.
for h in $(git ls-files 'web/dist/*.html'); do
  for a in $(git show ":$h" 2>/dev/null | grep -oE 'assets/[A-Za-z0-9_.-]+\.(js|css)' | sort -u); do
    git ls-files --error-unmatch "web/dist/$a" >/dev/null 2>&1 \
      || fail "committed $h references $a which is NOT in the git tree — 'git add -f web/dist' was skipped (the 6274ec2 blank-wall class)"
  done
done

# 4b. Dist BASE-PATH guard. The collage is served from /collage/, so the bundle
#     must be built with `--base=/collage/`. A plain `npm run build` emits
#     src="/assets/..." instead of src="/collage/assets/...", and because the
#     deploy copies web/dist wholesale into Extracted/collage/, EVERY asset then
#     404s — which caddy's php try_files turns into a 200 text/html, i.e. the
#     6274ec2 blank wall again, from the opposite direction. Guard 4 cannot see
#     it: the files ARE all committed, they are just referenced at the wrong URL.
#     (Caught exactly once, 2026-07-26, by probing before copying.)
for h in $(git ls-files 'web/dist/*.html'); do
  if git show ":$h" 2>/dev/null | grep -qE '(src|href)="/assets/'; then
    fail "$h references /assets/... — built without --base=/collage/. Rebuild: (cd web && npm run build -- --base=/collage/). Every asset would 404 behind a 200."
  fi
done

# 5. Forked-file divergence guard. services/birdgen/ is a fork of avian/scripts/,
#    and a fix applied to only ONE copy has already shipped: the robin-legs root
#    fix (28 commits to find) landed in services/birdgen/prompt.template.md while
#    avian/scripts/ kept the buggy "toes curled gently forward as if grasping a
#    thin perch" text — and pregen.py's own docstring pointed maintainers at the
#    STALE copy. The template is now a symlink so it CANNOT diverge; this guard
#    keeps it that way and covers the other known-identical pair.
if [ -e avian/scripts/prompt.template.md ]; then
  [ -L avian/scripts/prompt.template.md ] \
    || fail "avian/scripts/prompt.template.md is a real file again, not a symlink to services/birdgen/prompt.template.md — the two prompt copies can now silently diverge (the robin-legs class)"
  cmp -s avian/scripts/prompt.template.md services/birdgen/prompt.template.md \
    || fail "avian/scripts/prompt.template.md does not resolve to services/birdgen/prompt.template.md — the generator reads the birdgen copy (app.py:144); a fix in the other one is invisible"
fi
cmp -s avian/scripts/creamkey.py services/birdgen/creamkey.py \
  || fail "avian/scripts/creamkey.py and services/birdgen/creamkey.py have diverged — they are a known byte-identical pair; a one-sided fix will not reach the generator"

# 6. Catalog-unit single-definition guard. deploy-christina.sh used to heredoc
#    its OWN /etc/systemd/system/catalog.service with only ONE ExecStart, which
#    dropped derive.py entirely — derived.json then froze for 24 days behind a
#    green unit (2026-07-02..26). The deploy must INSTALL the authored unit via
#    render_unit, never re-declare it, and the authored unit must keep both steps.
grep -q 'render_unit "$HERE/avian/catalog/catalog.service"' deploy-christina.sh \
  || fail "deploy-christina.sh no longer installs avian/catalog/catalog.service via render_unit — a hand-rolled unit is how derive.py got dropped for 24 days"
grep -q 'catalog.service' deploy-christina.sh && grep -qE '^\[Unit\]' <(sed -n '/tee \/etc\/systemd\/system\/catalog.service/,/^UNIT$/p' deploy-christina.sh) \
  && fail "deploy-christina.sh contains a heredoc catalog.service again — delete it and use render_unit (the 2026-07 derive.py drop)"
[ "$(grep -c '^ExecStart=' avian/catalog/catalog.service)" = "2" ] \
  || fail "avian/catalog/catalog.service must have exactly 2 ExecStart lines (rebuild_catalog.py then derive.py) — dropping the derive step is the 24-day-stale-derived.json incident"
grep -q '^ExecStart=.*derive\.py' avian/catalog/catalog.service \
  || fail "avian/catalog/catalog.service lost the derive.py ExecStart — derived.json will silently freeze"
grep -qE '^ExecStart=-' avian/catalog/catalog.service \
  && fail "avian/catalog/catalog.service uses ExecStart=- (ignore-exit). That fail-open stacked with derive.py's own 'return 0' to hide a 24-day outage — keep failures visible"

# 7. Freshness-probe guard. The data plane silently served a 24-day-old
#    derived.json while every serving probe stayed green, because nothing
#    compared built_at to now. verify.sh must keep that check.
grep -q 'freshness_check' scripts/verify.sh \
  || fail "scripts/verify.sh lost freshness_check() — a stale derived.json/species.json becomes invisible again (the 2026-07 incident)"

[ "$FAIL" = "0" ] && echo "repo-guards: all green"
exit $FAIL
