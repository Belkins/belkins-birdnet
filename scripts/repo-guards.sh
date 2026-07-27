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
ENUMERATED="tests avian/catalog/tests avian/backup/tests frame/tests services/birdgen/tests"
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
#    services/birdgen/ is canonical; avian/scripts/ holds symlinks to it. The
#    ONLY legitimate per-deployment difference is style-refs.json (different
#    style plates — the Koson/Yoshida prints are not redistributable), and that
#    is DATA, deliberately not a symlink.
for f in prompt.template.md creamkey.py pregen.py verify.py species-notes.json; do
  if [ -e "avian/scripts/$f" ]; then
    [ -L "avian/scripts/$f" ] \
      || fail "avian/scripts/$f is a real file again, not a symlink to services/birdgen/$f — this is exactly how 675 lines of pregen.py, the AV_GEN_MODEL override, the defensive-titles fix and the robin species-note ended up on one side only"
    cmp -s "avian/scripts/$f" "services/birdgen/$f" \
      || fail "avian/scripts/$f does not resolve to services/birdgen/$f — the generator reads the birdgen copy, so a fix in the other one is invisible"
  fi
done
# style-refs.json must NOT be a symlink (it carries the real divergence) and BOTH
# copies must cover every category — select_style_ref indexes the dict directly,
# so a missing category is a KeyError for one genus only.
for d in avian/scripts services/birdgen; do
  [ -L "$d/style-refs.json" ] \
    && fail "$d/style-refs.json is a symlink — it must stay a per-deployment file; symlinking it collapses the legitimate style-plate divergence"
  python3 -c "
import json,sys
req={'small_songbird_perched','dark_bird_perched','vivid_perched','vibrant_perched','owl',
     'large_flight','small_flight','wader','pale_perched','waterfowl_perched'}
d=json.load(open('$d/style-refs.json'))
missing=sorted(k for k in req if not isinstance(d.get(k),str) or not d[k])
sys.exit(1 if missing else 0)
" 2>/dev/null \
    || fail "$d/style-refs.json is invalid or missing a style category — select_style_ref would KeyError for one genus only"
done

# 6. Catalog-unit single-definition guard. deploy-christina.sh used to heredoc
#    its OWN /etc/systemd/system/catalog.service with only ONE ExecStart, which
#    dropped derive.py entirely — derived.json then froze for 24 days behind a
#    green unit (2026-07-02..26). The deploy must INSTALL the authored unit via
#    render_unit, never re-declare it, and the authored unit must keep both steps.
#    A substring grep passes on a COMMENTED-OUT or dead-branch call, which is
#    exactly the "unit never actually installed" defect. Require the call to be
#    live: strip comments first, then look for it.
grep -vE '^[[:space:]]*#' deploy-christina.sh | grep -q 'render_unit "$HERE/avian/catalog/catalog.service"' \
  || fail "deploy-christina.sh has no LIVE (uncommented) render_unit call for avian/catalog/catalog.service — a hand-rolled or absent unit is how derive.py got dropped for 24 days"
grep -q 'catalog.service' deploy-christina.sh && grep -qE '^\[Unit\]' <(sed -n '/tee \/etc\/systemd\/system\/catalog.service/,/^UNIT$/p' deploy-christina.sh) \
  && fail "deploy-christina.sh contains a heredoc catalog.service again — delete it and use render_unit (the 2026-07 derive.py drop)"
#    The unit must have exactly ONE ExecStart, running nightly.sh. Two chained
#    ExecStart lines are FORBIDDEN: systemd skips the rest after a non-zero one,
#    so rebuild_catalog.py's exit-3 DEGRADED signal silently skipped derive.py
#    and re-froze derived.json — the loud signal disabling what it protected
#    (verified empirically on the Pi, QA 2026-07-27).
[ "$(grep -c '^ExecStart=' avian/catalog/catalog.service)" = "1" ] \
  || fail "avian/catalog/catalog.service must have exactly ONE ExecStart (nightly.sh). Chained ExecStart lines let a non-zero first step SKIP derive.py — the 24-day-stale-derived.json incident, reintroduced"
grep -q '^ExecStart=.*nightly\.sh' avian/catalog/catalog.service \
  || fail "avian/catalog/catalog.service no longer runs nightly.sh — the wrapper is what guarantees derive.py runs even when the catalog step is degraded"
grep -qE '^ExecStart=-' avian/catalog/catalog.service \
  && fail "avian/catalog/catalog.service uses ExecStart=- (ignore-exit). That fail-open stacked with derive.py's own 'return 0' to hide a 24-day outage — keep failures visible"
grep -qE '^TimeoutStartSec=' avian/catalog/catalog.service \
  || fail "avian/catalog/catalog.service has no TimeoutStartSec — a Type=oneshot with the default infinite start timeout can hang in 'activating' forever on a slow manifest and NEVER be reported failed"
#    nightly.sh must call derive.py UNCONDITIONALLY. Any guard on the catalog's
#    return code recreates the skip.
#    Match the INVOCATION on a non-comment line, not any mention: nightly.sh's
#    own comments discuss derive.py at length, so a bare grep passed even after
#    the call was replaced with /bin/true. (Caught by negative-testing this very
#    guard — the same decorative-grep bug it was written to replace.)
grep -vE '^[[:space:]]*#' avian/catalog/nightly.sh | grep -qE '"\$PY"[[:space:]]+"\$HERE/derive\.py"' \
  || fail "avian/catalog/nightly.sh has no LIVE invocation of derive.py — derived.json will silently freeze (the 24-day incident)"
grep -qE '(if|&&|\|\|)[^\n]*rc_cat[^\n]*\n?[^\n]*derive\.py' avian/catalog/nightly.sh \
  && fail "avian/catalog/nightly.sh appears to gate derive.py on the catalog exit code — it must run unconditionally, that gating IS the bug"

# 7. Freshness-probe guard. The data plane silently served a 24-day-old
#    derived.json while every serving probe stayed green, because nothing
#    compared built_at to now. verify.sh must keep that check.
#    A bare `grep -q freshness_check` could NOT fail: the word also appears in a
#    comment on verify.sh:144, so deleting the whole function still passed. That
#    is precisely the decorative-guard sin these guards exist to prevent. Assert
#    the DEFINITION exists, that it is wired into every dispatch arm, and that it
#    still contains the comparison that does the actual work.
grep -qE '^freshness_check\(\)' scripts/verify.sh \
  || fail "scripts/verify.sh lost the freshness_check() DEFINITION — a stale derived.json/species.json becomes invisible again (the 2026-07 incident)"
[ "$(grep -cE '^[[:space:]]*freshness_check([[:space:]]|;|$)' scripts/verify.sh)" -ge 3 ] \
  || fail "freshness_check is no longer called from all three verify.sh dispatch arms (fresh / wall / point-probe) — a mode that skips it reports all-green on stale data"
grep -q 'age_h" -gt "\$max' scripts/verify.sh \
  || fail "freshness_check no longer compares age against its limit — the function survives as a shell that can never fail"

# 8. Auth fail-closed guard. ONE empty variable (CADDY_PWD) silently disabled two
#    independent auth layers at once, leaving a browser shell (/terminal), a DB
#    admin UI, the whole detection database and an exec("sudo rm $_GET[...]")
#    reachable unauthenticated from the LAN. Neither layer said a word.
grep -q 'hash_equals' scripts/common.php \
  || fail "scripts/common.php no longer uses hash_equals — a loose == comparison is both timing-unsafe and vulnerable to PHP type juggling"
grep -qE '\$expected === .."?\)?' scripts/common.php || grep -q "expected === ''" scripts/common.php \
  || fail "scripts/common.php lost the empty-password guard — an unset CADDY_PWD makes is_authenticated() return true for EVERYONE (the 2026-07 LAN exposure)"
#    Check the ASSIGNMENT, not the usage: `exec("sudo rm $file_pointer ...")` is
#    identical in the safe and unsafe versions — what differs is whether the
#    variable was escaped first. Matching the usage produced a guard that failed
#    on correct code, which trains an operator to ignore it.
grep -vE '^[[:space:]]*(#|//)' scripts/play.php \
  | grep -qE '\$file_pointer[[:space:]]*=[[:space:]]*escapeshellarg\(' \
  || fail "scripts/play.php no longer escapes the deletefile path before exec() — ?deletefile=x;<cmd> is remote command execution, and it is a GET so any page in the house can fire it via <img src>"
grep -vE '^[[:space:]]*(#|//)' scripts/play.php \
  | grep -qE '\$png_pointer[[:space:]]*=[[:space:]]*escapeshellarg\(' \
  || fail "scripts/play.php no longer escapes the .png path before exec() — same injection, second argument"
#    The no-password branch of the Caddyfile generator must DENY the admin plane,
#    never emit an open config.
grep -q 'respond @adminplane' scripts/update_caddyfile.sh \
  || fail "scripts/update_caddyfile.sh no longer denies the admin plane when CADDY_PWD is unset — that branch is what published /terminal and adminer to the LAN"
grep -q 'abort @badhost' scripts/update_caddyfile.sh \
  || fail "scripts/update_caddyfile.sh lost Host pinning — basic auth does not stop DNS rebinding, because browsers replay cached credentials automatically"
for pth in '/play.php\*' '/terminal\*' '/scripts\*' '/log\*' '/By_Date\*'; do
  grep -q "basicauth $pth" scripts/update_caddyfile.sh \
    || fail "scripts/update_caddyfile.sh no longer gates $pth — note /scripts* does NOT cover the root-symlinked /play.php"
done
[ -e scripts/adminer.php ] \
  && fail "scripts/adminer.php is back — a full DB-admin UI with a history of RCE advisories, removed 2026-07-27"

[ "$FAIL" = "0" ] && echo "repo-guards: all green"
exit $FAIL
