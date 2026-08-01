#!/usr/bin/env bash
# repo-guards.sh — $0 static tripwires for the failure classes that have
# actually bitten this repo. Run by CI (python-app.yml) and runnable locally.
# Each guard names the incident it prevents; keep that discipline when adding.
#
# Called with NO ARGUMENTS it runs the static guard list (1..10) — that is the
# python-app.yml entry point. It also has three SCOPED modes, each of which runs
# ONE dist check and exits, because each needs an artefact the python CI has no
# way to produce:
#
#   dist-fresh  <freshly-built-dir>   compare the committed bundle to the source
#                                     (web-ci.yml, after `vite build`)
#   dist-static <dir>                 is this directory a deployable /collage/
#                                     bundle at all (deploy-christina.sh, before
#                                     it copies web/dist onto the wall)
#   dist-served <base-url> <dir>      does the LIVE host actually serve that
#                                     bundle (deploy-christina.sh self-check)
#
# A scoped mode that nobody invokes is decoration, so guard 10 below asserts the
# wiring for all three from source — dropping a call site turns the build red.
set -u
cd "$(dirname "$0")/.."
FAIL=0
fail() { printf 'GUARD FAIL: %s\n' "$*"; FAIL=1; }

# --- shared dist helpers ----------------------------------------------------
# The INDEX ones deliberately read git, never the worktree: worktree-vs-tree
# divergence IS the failure guard 4 was written for, and it is half of the
# failure guard 10 is written for.
_dist_assets_index() { git ls-files 'web/dist/assets/*' | sed 's#^web/dist/assets/##' | sort; }
_dist_html_index()   { git ls-files 'web/dist/*.html'   | sed 's#^web/dist/##'        | sort; }
_dist_refs_index()   { git show ":web/dist/$1" 2>/dev/null | _dist_refs_stdin; }
_dist_assets_dir()   { ls -1 "$1/assets" 2>/dev/null | sort; }
_dist_html_dir()     { ( cd "$1" 2>/dev/null && ls -1 -- *.html 2>/dev/null ) | sort; }
_dist_refs_file()    { _dist_refs_stdin < "$1"; }
# Matches both `/collage/assets/x.js` and a base-less `/assets/x.js` — the base
# prefix is checked separately, on purpose: normalising it away here would make
# a lost --base=/collage/ invisible to every caller.
_dist_refs_stdin()   { grep -oE 'assets/[A-Za-z0-9_.-]+\.(js|css)' | sed 's#^assets/##' | sort -u; }

case "${1:-}" in
dist-fresh)
  # THE STALE-BUNDLE GUARD. web/dist is COMMITTED (force-added past web/.gitignore)
  # and deploy-christina.sh PREFERS it over rebuilding, so the committed bundle is
  # literally what hangs on the wall. Guard 4 proves the committed HTML's assets are
  # in the index and 4b proves they are /collage/-based — but NOTHING compared the
  # bundle to the SOURCE it was built from. Edit a view, forget to rebuild, commit:
  # all four existing gates stay green while the museum serves last week's build.
  # Same shape as both blank-wall incidents, from a third direction.
  #
  # For the CHUNKS: compare the emitted asset-name SET, never a byte diff. Vite is
  # caret-pinned ("vite": "^8.1.1"), so minified bytes may legitimately move under
  # a patch bump; the name set is derived from `npm ci` against the COMMITTED
  # package-lock.json, so it is stable until someone edits the lockfile.
  # The five ~1.2-1.8 KB ENTRY HTML files are the one deliberate exception and ARE
  # compared byte-for-byte — see the reasoning at the per-entry loop below, and the
  # measured gap that forced it (an HTML-only edit moves no chunk hash at all).
  FRESH="${2:-}"
  [ -n "$FRESH" ] || { echo "usage: $0 dist-fresh <freshly-built-dist-dir>" >&2; exit 2; }
  # A missing/empty build dir must be LOUD. If this returned green, the guard
  # would pass hardest exactly when the build step it depends on had failed.
  [ -d "$FRESH/assets" ] \
    || { fail "dist-fresh: '$FRESH/assets' does not exist — the fresh build did not run or wrote elsewhere. Refusing to compare nothing and call it green."; exit 1; }

  _fa=$(_dist_assets_dir "$FRESH"); _ca=$(_dist_assets_index)
  [ -n "$_fa" ] || fail "dist-fresh: the fresh build emitted NO assets — nothing to compare against"
  [ -n "$_ca" ] || fail "dist-fresh: no web/dist/assets/* in the git index — the committed bundle is gone; if that is intentional, remove this guard and the deploy's prefer-committed-dist branch together"

  # The fresh build must itself be /collage/-based, or the reference sets below
  # are not comparable — and a web-ci.yml that lost --base=/collage/ is its own
  # bug (guard 4b's class, caught before it can be committed).
  for _f in $(_dist_html_dir "$FRESH"); do
    grep -qE '(src|href)="/assets/' "$FRESH/$_f" \
      && fail "dist-fresh: the FRESH build's $_f references /assets/... — it was built without --base=/collage/, so this comparison is meaningless. Fix the build step in .github/workflows/web-ci.yml."
  done

  if [ "$_fa" != "$_ca" ]; then
    echo "  committed-only (STALE — these came from an older source tree):"
    comm -23 <(printf '%s\n' "$_ca") <(printf '%s\n' "$_fa") | sed 's/^/    /'
    echo "  fresh-only (what the current source actually builds):"
    comm -13 <(printf '%s\n' "$_ca") <(printf '%s\n' "$_fa") | sed 's/^/    /'
    fail "committed web/dist is STALE — its asset set does not match a build of the current source. Someone edited web/src and did not rebuild. Fix: (cd web && npm run build -- --base=/collage/) && git add -f web/dist && commit. The wall serves the COMMITTED bundle, so until then it shows the old museum."
  fi

  _fh=$(_dist_html_dir "$FRESH"); _ch=$(_dist_html_index)
  [ "$_fh" = "$_ch" ] \
    || fail "committed web/dist HTML entries [$(echo $_ch)] != freshly built [$(echo $_fh)] — an entry page was added to or removed from web/vite.config.ts without rebuilding the committed dist"

  # Per-entry reference sets. Catches the case where two entries happen to share
  # a total asset set but one entry stopped importing a chunk.
  for _f in $_fh; do
    # Membership must be tested line-wise. An earlier draft used
    # `case " $_ch " in *" $_f "*)` — but $_ch is NEWLINE separated, so the
    # " name " pattern never matched, every entry hit `continue`, and BOTH
    # per-entry checks below silently never ran. Green, permanently, doing
    # nothing. Caught only by negative-testing this specific assertion rather
    # than trusting the guard's overall red on a different case.
    printf '%s\n' "$_ch" | grep -qxF "$_f" || continue
    _rf=$(_dist_refs_file "$FRESH/$_f"); _rc=$(_dist_refs_index "$_f")
    [ "$_rf" = "$_rc" ] \
      || fail "committed web/dist/$_f references a different asset set than a fresh build of it — the committed bundle is stale for that entry"
    # Entry-HTML CONTENT. The asset-set checks above cannot see an edit that
    # changes only the emitted HTML shell — a <title>, a <meta>, a favicon path
    # in web/index.html — because no chunk's content hash moves. MEASURED: a
    # title change in web/index.html left all 15 asset names identical and this
    # guard green while the committed HTML was genuinely stale.
    # This IS a byte comparison, deliberately scoped to the five ~1.2-1.8 KB
    # entry files and never to the minified chunks. The caret-pinned-vite
    # false-red the asset-set rule exists to avoid does not really apply here:
    # CI installs from the COMMITTED package-lock.json, so the toolchain only
    # moves when someone edits the lockfile — and a lockfile bump changes chunk
    # hashes too, so the asset-set check would already be red. Either way the
    # remedy is identical and correct: rebuild and commit the dist.
    git show ":web/dist/$_f" 2>/dev/null | cmp -s - "$FRESH/$_f" \
      || fail "committed web/dist/$_f differs from a fresh build of it — an edit to web/$_f (title, meta, entry markup) never made it into the committed bundle. Rebuild: (cd web && npm run build -- --base=/collage/) && git add -f web/dist"
  done
  # Positive evidence in the log. A guard that passes SILENTLY is indistinguishable
  # from a guard that never ran, which is how several of this repo's checks stayed
  # green for weeks while doing nothing.
  [ "$FAIL" = "0" ] && printf 'dist-fresh: committed web/dist matches a build of the current source (%s assets, %s entries)\n' \
    "$(printf '%s\n' "$_ca" | grep -c .)" "$(printf '%s\n' "$_ch" | grep -c .)"
  exit $FAIL
  ;;

dist-static)
  # Is <dir> a deployable /collage/ bundle AT ALL? deploy-christina.sh prefers an
  # on-disk web/dist over rebuilding, and guards 4/4b only ever see the git INDEX
  # — so a local `npm run build` with no --base, or a half-written dist, walks
  # straight onto the wall. Every asset then 404s, and caddy's php try_files
  # turns each 404 into 200 text/html (MEASURED on the live box 2026-07-30:
  # /collage/assets/<missing>.js -> 200 text/html). That is the blank wall.
  D="${2:-}"
  [ -n "$D" ] || { echo "usage: $0 dist-static <dist-dir>" >&2; exit 2; }
  [ -d "$D" ] || { fail "dist-static: '$D' is not a directory"; exit 1; }
  _h=$(_dist_html_dir "$D")
  [ -n "$_h" ] || fail "dist-static: '$D' contains no *.html — copying it onto the wall would publish an empty directory"
  for _f in $_h; do
    grep -qE '(src|href)="/assets/' "$D/$_f" \
      && fail "dist-static: $D/$_f references /assets/... — built without --base=/collage/. Every asset would 404 behind a 200 text/html. Rebuild: (cd web && npm run build -- --base=/collage/)"
    _r=$(_dist_refs_file "$D/$_f")
    [ -n "$_r" ] || fail "dist-static: $D/$_f references no assets at all — that is not a built bundle"
    for _a in $_r; do
      [ -f "$D/assets/$_a" ] \
        || fail "dist-static: $D/$_f references assets/$_a but $D/assets/$_a is MISSING — the 6274ec2 blank-wall class, on disk this time"
    done
  done
  [ "$FAIL" = "0" ] && printf 'dist-static: %s is a complete /collage/-based bundle (%s entries)\n' "$D" "$(printf '%s\n' "$_h" | grep -c .)"
  exit $FAIL
  ;;

dist-served)
  # Post-deploy: does the LIVE host serve the bundle we just copied? An HTTP
  # STATUS check is worthless here — caddy answers 200 for every missing path
  # under /collage/ — so this asserts CONTENT-TYPE and the served reference set.
  BASE="${2:-}"; D="${3:-}"
  [ -n "$BASE" ] && [ -n "$D" ] \
    || { echo "usage: $0 dist-served <base-url> <deployed-dir>" >&2; exit 2; }
  BASE="${BASE%/}"
  [ -f "$D/index.html" ] || { fail "dist-served: no $D/index.html to compare against"; exit 1; }
  _curl_rc=0; _body=$(curl -sS --max-time 15 "$BASE/" 2>/dev/null) || _curl_rc=$?
  [ "$_curl_rc" = "0" ] \
    || fail "dist-served: could not reach $BASE/ at all (curl rc=$_curl_rc) — the web server is down or not listening; the wall shows nothing"
  _rs=$(printf '%s\n' "$_body" | _dist_refs_stdin)
  _rl=$(_dist_refs_file "$D/index.html")
  [ -n "$_rs" ] || [ "$_curl_rc" != "0" ] \
    || fail "dist-served: $BASE/ answered, but served nothing that references a bundle — that is the php try_files fallback, i.e. the wall is blank"
  [ "$_rs" = "$_rl" ] \
    || fail "dist-served: $BASE/ serves a DIFFERENT asset set than $D/index.html — the copy did not take effect (stale cache, wrong docroot, or a half-finished copy)"
  for _a in $_rs; do
    _ct=$(curl -sS --max-time 15 -o /dev/null -w '%{content_type}' "$BASE/assets/$_a" 2>/dev/null) || _ct=""
    case "$_ct" in
      *javascript*|*ecmascript*|*css*) : ;;
      *) fail "dist-served: $BASE/assets/$_a is served as '${_ct:-<none>}', not JS/CSS — that is caddy's php try_files fallback answering 200 text/html for a MISSING file. The wall will render blank." ;;
    esac
  done
  [ "$FAIL" = "0" ] && printf 'dist-served: %s serves the deployed bundle (%s assets, all JS/CSS content-types)\n' "$BASE" "$(printf '%s\n' "$_rs" | grep -c .)"
  exit $FAIL
  ;;

"") : ;;
*) echo "$0: unknown mode '${1:-}' (expected: dist-fresh | dist-static | dist-served, or no argument)" >&2; exit 2 ;;
esac

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
#
#    ./.claude is pruned for the same reason as ./node_modules and ./.venv, and
#    it is not cosmetic: `git worktree add .claude/worktrees/<name>` puts a FULL
#    SECOND CHECKOUT inside the repo, so this find discovered all five suites
#    again under it and the ENTIRE guard suite exited 1 on a clean tree. CI never
#    saw it (a fresh checkout has no worktrees) — it broke the guards only for
#    the person actually working, i.e. exactly when they are needed. .claude is
#    gitignored (.gitignore:55); find does not read .gitignore.
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
  -path ./.claude -prune -o \
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
#    SAME CLASS, DIFFERENT TREE (2026-07-30). avian/api/config.php and
#    birdnet-status.php each gated themselves with
#        getenv('AV_REQUIRE_AUTH') === '1'
#    a guard that is OFF unless an env var is set — and on the live station it
#    never was. Measured unauthenticated over the LAN: config.php GET handed out
#    LATITUDE/LONGITUDE, its POST rewrote birdnet.conf, and birdnet-status.php's
#    action=restart ran `sudo systemctl restart` on any allowlisted unit,
#    livestream included. Same fail-open shape as the CADDY_PWD bug above, three
#    weeks after it. Assert the fix is wired AND that the opt-in shape is gone.
for _f in avian/api/config.php avian/api/birdnet-status.php avian/api/menu.php; do
  grep -q 'av_require_auth()' "$_f" \
    || fail "$_f no longer calls av_require_auth() — it is an admin endpoint (station config, service state, or the admin menu) and without that call it answers the LAN unauthenticated"
done
grep -q 'hash_equals' avian/api/_auth.php \
  || fail "avian/api/_auth.php no longer uses hash_equals — a loose comparison is timing-unsafe and exposed to PHP type juggling"
grep -q "expected === ''" avian/api/_auth.php \
  || fail "avian/api/_auth.php lost its empty-password guard — a station with no CADDY_PWD configured must be LOCKED, never open"
#    STATION_OPEN is an opt-OUT, and an opt-out is one rename away from becoming
#    the very fail-open shape this guard exists for. It must be read from
#    birdnet.conf (never an env var — an unset env var is exactly how
#    AV_REQUIRE_AUTH left three endpoints open), compared STRICTLY to '1' so
#    that 'true'/'yes'/''/absent all mean CLOSED, and it must appear in exactly
#    the two auth entry points and nowhere else.
for _f in scripts/common.php avian/api/_auth.php; do
  grep -qE "STATION_OPEN'\]? *\?\? *''\) === '1'|av_conf_value\('STATION_OPEN'\) === '1'" "$_f" \
    || fail "$_f no longer tests STATION_OPEN with a strict === '1' — a loose comparison makes 'true', 'yes' or any non-empty value open the whole station"
done
_stationopen=$(grep -rlE "STATION_OPEN" --include='*.php' scripts avian 2>/dev/null | sort)
[ "$_stationopen" = "avian/api/_auth.php
scripts/common.php" ] \
  || fail "STATION_OPEN is read in unexpected PHP files (found: $(echo $_stationopen)) — it must gate only the two auth entry points, or a surface can open itself without going through either"
#    Scoped to *.php: this file necessarily CONTAINS the pattern it hunts, so an
#    unscoped grep matches its own source and fails on correct code — the exact
#    self-match that made the Tools-button check lie earlier the same day.
! grep -rq --include='*.php' "getenv('STATION_OPEN')\|getenv(\"STATION_OPEN\")" scripts avian 2>/dev/null \
  || fail "STATION_OPEN is being read from the ENVIRONMENT — an unset env var reads identically to a deliberate 'closed' and that is the AV_REQUIRE_AUTH bug verbatim. Read it from birdnet.conf."
grep -q 'STATION_OPEN.*= *"1"' scripts/update_caddyfile.sh && grep -q 'exit 2' scripts/update_caddyfile.sh \
  || fail "scripts/update_caddyfile.sh no longer refuses to run under STATION_OPEN=1 — regenerating would silently restore every password gate the owner removed"
#    Strip comment lines before searching: the docblocks in these three files
#    NAME the old variable while explaining why it is gone, so a naive grep here
#    would fail on correct code — the precise antipattern flagged below.
if printf '%s\n' "$(grep -rhvE '^[[:space:]]*(//|#|\*|/\*)' avian/api/*.php)" | grep -q 'AV_REQUIRE_AUTH'; then
  fail "AV_REQUIRE_AUTH is back in live code under avian/api/ — that guard defaults to OFF, which is exactly what left config.php and birdnet-status.php unauthenticated on the LAN"
fi
#    Check the ASSIGNMENT, not the usage: `exec("sudo rm $file_pointer ...")` is
#    identical in the safe and unsafe versions — what differs is whether the
#    variable was escaped first. Matching the usage produced a guard that failed
#    on correct code, which trains an operator to ignore it.
#    Scoped to two variables, this guard gave FALSE CONFIDENCE: it passed while
#    THREE other injection sites in the same file were still unescaped (the
#    changefile/newname exec, and $dir in both mkdir calls). Assert every
#    user-derived exec input in the file, and forbid the specific unsafe shapes.
#    Note double quotes are NOT protection: "\"$newname\"" still expands $( ).
_play=$(grep -vE '^[[:space:]]*(#|//)' scripts/play.php)
for v in file_pointer png_pointer; do
  printf '%s\n' "$_play" | grep -qE "\\\$$v[[:space:]]*=[[:space:]]*escapeshellarg\\(" \
    || fail "scripts/play.php: \$$v is no longer escapeshellarg'd before exec() — ?deletefile=x;<cmd> is command execution, and it is a GET so any page in the house can fire it via <img src>"
done
printf '%s\n' "$_play" | grep -qE '\$change_cmd[[:space:]]*=.*escapeshellarg\(' \
  || fail "scripts/play.php: the changefile/newname exec is no longer built from escapeshellarg'd parts — that path runs sudo -u \$BIRDNET_USER, who has NOPASSWD:ALL, so injection there is effectively ROOT"
printf '%s\n' "$_play" | grep -qE '\\"\$(oldname|newname)\\"' \
  && fail "scripts/play.php interpolates \$oldname/\$newname inside DOUBLE QUOTES again — double quotes do not stop \$( ) or backticks (proven: echo \"x\$(id -un)\" executes)"
[ "$(printf '%s\n' "$_play" | grep -cE 'shell_exec\("sudo mkdir -p "\.\$shifted_path')" = "0" ] \
  || fail "scripts/play.php: the mkdir path is unescaped again — \$dir comes from pathinfo(\$_GET['shiftfile']) with NO quotes, so even ; and | execute there"
[ "$(printf '%s\n' "$_play" | grep -cE 'shell_exec\("sudo mkdir -p "\.escapeshellarg\(')" = "2" ] \
  || fail "scripts/play.php: expected BOTH mkdir call sites (ffmpeg + sox) to escapeshellarg their path"
#    The no-password branch of the Caddyfile generator must DENY the admin plane,
#    never emit an open config.
grep -q 'respond @adminplane' scripts/update_caddyfile.sh \
  || fail "scripts/update_caddyfile.sh no longer denies the admin plane when CADDY_PWD is unset — that branch is what published /terminal and adminer to the LAN"
grep -q 'abort @badhost' scripts/update_caddyfile.sh \
  || fail "scripts/update_caddyfile.sh lost Host pinning — basic auth does not stop DNS rebinding, because browsers replay cached credentials automatically"
#    Do NOT hand-enumerate a subset: an earlier version listed 5 of the 11 gated
#    paths, so /stream, /Processed*, /phpsysinfo*, /stats*, /Charts* and
#    /views.php?view=File* could all have been dropped with CI still green —
#    a guard scoped to the paths I happened to remember. Pin the COUNT and the
#    set that must always be present, both derived from the file itself.
_gated=$(grep -oE 'basicauth [^[:space:]]+' scripts/update_caddyfile.sh | awk '{print $2}' | sort -u)
_n=$(printf '%s\n' "$_gated" | grep -c .)
[ "$_n" -ge 11 ] \
  || fail "scripts/update_caddyfile.sh gates only $_n paths (expected >= 11) — a path was dropped from the auth variant; compare against the live Caddyfile before assuming it is intentional"
for pth in '/play.php*' '/terminal*' '/scripts*' '/log*' '/stats*' '/stream' \
           '/phpsysinfo*' '/Processed*' '/By_Date*' '/Charts*' '/views.php?view=File*'; do
  printf '%s\n' "$_gated" | grep -qxF "$pth" \
    || fail "scripts/update_caddyfile.sh no longer gates $pth — note /scripts* does NOT cover the root-symlinked /play.php, and /terminal* fronts a gotty shell"
done
[ -e scripts/adminer.php ] \
  && fail "scripts/adminer.php is back — a full DB-admin UI with a history of RCE advisories, removed 2026-07-27"

# 9. Web test-suite wiring guard. web/tests/ shipped 12 real tests that NOTHING
#    ran: python-app.yml is pytest-only and never invokes npm, and guard 3's
#    enumeration only counts directories containing test_*.py, so the web suite
#    was green by human discipline alone. Three ways that silently rots, one
#    assertion each — the workflow vanishes, it stops calling npm test, or the
#    npm script gets pinned back to ONE filename. The glob is load-bearing
#    because `node --test tests/` cannot be used at all (node resolves a bare
#    directory as a module: MODULE_NOT_FOUND), so a pinned filename means a
#    SECOND web test file never runs while the badge stays green.
if ls web/tests/*.test.ts >/dev/null 2>&1; then
  _wwf=.github/workflows/web-ci.yml
  [ -f "$_wwf" ] \
    || fail "web/tests/*.test.ts exists but $_wwf is missing — the web suite would run in no CI at all"
  grep -qE '^[[:space:]]*run:[[:space:]]*npm test[[:space:]]*$' "$_wwf" \
    || fail "$_wwf no longer runs 'npm test' — restore the step or the web suite silently stops running"
  grep -qF "node --test tests/*.test.ts" web/package.json \
    || fail "web/package.json's test script must glob 'tests/*.test.ts' — a pinned filename means a NEW web test never runs, and 'node --test tests/' is not a legal substitute (node resolves a bare dir as a module)"
fi

# 10. Stale-bundle WIRING guard. The three dist modes at the top of this file are
#     the only things comparing the committed bundle to its source and to the
#     wall — and none of them run in python-app.yml, which is the workflow this
#     script is invoked from. So the modes themselves cannot assert they are
#     alive; this guard does it, from the python CI that always runs.
#     Without it the whole mechanism disarms silently by deleting one YAML line,
#     which is the exact failure shape of guards 3b and 9.
#     Only meaningful while a dist is actually committed: if web/dist stops being
#     committed, this failure class stops existing (and so does the deploy's
#     prefer-committed-dist branch — remove them together).
if [ -n "$(git ls-files 'web/dist/*.html')" ]; then
  _dwf=.github/workflows/web-ci.yml
  if [ -f "$_dwf" ]; then
    # Strip YAML comments first: this file DOCUMENTS the guard at length, so a
    # bare grep for the mode name passes on prose alone — the decorative-grep
    # sin guards 6 and 7 were rewritten to avoid.
    _dci=$(grep -vE '^[[:space:]]*#' "$_dwf")
    printf '%s\n' "$_dci" | grep -qF 'repo-guards.sh dist-fresh' \
      || fail "$_dwf no longer invokes 'repo-guards.sh dist-fresh' — nothing compares the COMMITTED web/dist to the source any more, so an un-rebuilt bundle ships green (guards 4/4b cannot see it: the files are all present and correctly prefixed, they are just OLD)"
    printf '%s\n' "$_dci" | grep -qE 'npm run build( --)? .*--base=/collage/' \
      || fail "$_dwf's build step no longer passes --base=/collage/ — the fresh bundle would then be /assets/-based, dist-fresh would abort as non-comparable, and the stale check would red for the wrong reason (measured: it does)"
    # NOT asserted: that the build writes to a separate --outDir. An earlier draft
    # of this guard claimed an in-place build would make dist-fresh compare the
    # fresh output against itself and always pass. That was FALSE and was caught
    # by testing it: dist-fresh reads the committed side from the GIT INDEX
    # (git ls-files / git show :path), which an in-place build does not touch, so
    # it still goes red correctly. The workflow uses RUNNER_TEMP for tidiness, not
    # correctness — asserting it here would be a guard defending a fiction.
  else
    fail "$_dwf is missing but web/dist is committed — the stale-bundle guard has nowhere to run"
  fi
  # Same for the deploy side: the prefer-committed-dist branch and the post-deploy
  # self-check each have exactly one call site.
  _dep=$(grep -vE '^[[:space:]]*#' deploy-christina.sh)
  printf '%s\n' "$_dep" | grep -qF 'repo-guards.sh" dist-static' \
    || fail "deploy-christina.sh no longer validates web/dist with 'repo-guards.sh dist-static' before copying it onto the wall — an unbased or half-written on-disk dist deploys unchecked (guards 4/4b only see the git index, not the worktree the deploy actually copies)"
  printf '%s\n' "$_dep" | grep -qF 'repo-guards.sh" dist-served' \
    || fail "deploy-christina.sh no longer runs 'repo-guards.sh dist-served' after deploying — nothing then verifies WHAT the wall serves, and the existing http_code probe cannot tell: caddy answers 200 text/html for every missing path under /collage/"
fi

# 11. THE ALERT PATH MUST ACTUALLY REACH THE BOX.
#     Every unit here declares OnFailure=christina-alert@%n.service so a red unit
#     shouts instead of waiting to be discovered by someone typing
#     `systemctl --failed`. That declaration is worthless three ways, and all
#     three had happened at once when this guard was written:
#       a) the handler it names was installed by nothing, so systemd logged
#          "could not enqueue" and said no more;
#       b) birdcast.service is written by an inline HEREDOC in both deploy
#          scripts, not rendered from the repo file — so the repo file grew an
#          OnFailure= line that could never reach the Pi (measured: 0 OnFailure
#          lines in the installed unit);
#       c) a hand-written list of units would have silently omitted
#          avian/forwarding/avian-mqtt.service, which is exactly how an earlier
#          guard here came to assert 5 of 11 gated paths.
#     So this DERIVES the set from find and pins a COUNT. A new unit without an
#     alert path fails the build on the day it is added.
_units=$(find avian -name '*.service' ! -name 'christina-alert@.service' | sort)
_n_units=$(printf '%s\n' "$_units" | grep -c . || true)
[ "$_n_units" -ge 7 ] \
  || fail "only $_n_units units found under avian/ — the OnFailure guard is looking in the wrong place and would pass vacuously"
for _u in $_units; do
  grep -q '^OnFailure=christina-alert@%n\.service' "$_u" \
    || fail "$_u carries no OnFailure=christina-alert@%n.service — when it dies, nothing will say so"
done

# 11a. THE HANDLER ITSELF MUST BE INSTALLED BY SOMETHING. Every OnFailure= line
#      above names christina-alert@%n.service; if that template is not on the box
#      systemd logs "could not enqueue" once and is otherwise silent, so seven
#      units would DECLARE an alert path and none could take it. That was the
#      live state when this guard was written — `ls /etc/systemd/system/ | grep
#      christina` returned nothing.
#      It is checked separately because the handler is excluded from the loop
#      above (it must not alert on itself), and excluding it from the loop is
#      what left it unchecked the first time I wrote this.
if [ -f avian/realtime/christina-alert@.service ]; then
  grep -rqF 'christina-alert@.service' deploy-christina.sh deploy-realtime.sh 2>/dev/null \
    || fail "no deploy script installs christina-alert@.service — every OnFailure= in this repo then points at a unit that does not exist on the box, and systemd will say so exactly once, to nobody"
fi

# 11b. The handler must NOT alert on itself: systemd would enqueue
#      christina-alert@christina-alert@... forever. Its own failure is visible
#      where a red unit is supposed to be, and nowhere else — on purpose.
if [ -f avian/realtime/christina-alert@.service ]; then
  grep -q '^OnFailure=' avian/realtime/christina-alert@.service \
    && fail "christina-alert@.service declares OnFailure= — a failure handler that handles its own failure is an infinite loop"
  grep -q '^User=' avian/realtime/christina-alert@.service \
    || fail "christina-alert@.service has no User= line, so it runs as ROOT and render_unit's User= rewrite is a no-op — every other unit in this repo drops privileges"
fi

# 11c. Every unit that DECLARES the alert path must be installed by something,
#      or the declaration is a comment. Checked against the deploy scripts by
#      name, because that is the gap that let a fully-written, fully-tested
#      off-box backup sit uninstalled on the box for days.
#      A unit with no installer may instead be DECLARED in avian/NOT-INSTALLED
#      with a written reason. That is the only way to answer this guard without
#      installing something, and it costs an explanation — so an uninstalled
#      unit becomes a recorded decision rather than the oversight that left the
#      off-box backup absent from the box for days.
for _u in $_units; do
  _base=$(basename "$_u")
  # NOTE 2026-07-30: install-cloud-backup.sh added when the encrypted R2 backup
  # shipped. This list is the guard's ENTIRE notion of "an installer exists". A
  # new installer that is not named here makes the guard fire on a unit that IS
  # installed, which trains people to silence it with a NOT-INSTALLED exemption
  # (a lie) rather than by writing an installer. Add new installers HERE.
  grep -rqF "$_base" deploy-christina.sh deploy-realtime.sh \
    avian/backup/install-backup.sh avian/backup/install-cloud-backup.sh 2>/dev/null && continue
  grep -qE "^[[:space:]]*$_base[[:space:]]*$" avian/NOT-INSTALLED 2>/dev/null \
    || fail "$_base declares an alert path but NO installer mentions it, and it is not declared in avian/NOT-INSTALLED — it will never reach the Pi (this is how offbox-backup shipped and was never installed)"
done

# 11d. A NOT-INSTALLED entry must name a unit that still exists, or the file
#      rots into permission for units nobody can find.
if [ -f avian/NOT-INSTALLED ]; then
  # PROCESS SUBSTITUTION, NOT A PIPE. `grep ... | while` runs the loop body in a
  # SUBSHELL, so `fail` set FAIL=1 in a child that then exited and took the
  # assignment with it: this guard printed "GUARD FAIL" and returned 0. Worse
  # than a silent guard — it shouted an alarm CI was structurally unable to hear.
  # I wrote it hours ago and my own negative test counted the MESSAGE instead of
  # the exit code, which is how it passed. Test guards by `$?`, never by output.
  while read -r _d; do
    [ -n "$_d" ] || continue
    find avian -name "$_d" | grep -q . \
      || fail "avian/NOT-INSTALLED names $_d, which no longer exists — the exemption outlived the unit"
  done < <(grep -vE '^[[:space:]]*(#.*)?$' avian/NOT-INSTALLED)
fi

# 12. THE GUARD RUNNER MUST RUN ON EVERY BRANCH.
#     Until 2026-08-01 python-app.yml was scoped to `push: [main, test_me]`, so
#     on design/library-recompose — 25 commits carrying the ENTIRE cloud backup,
#     the off-box dead-man's switch, the mic-flatline watchdog fix and
#     Caddyfile.live — this script and ~200 tests never ran once. web-ci.yml has
#     no branch filter and was green throughout, which made the absence of a
#     python verdict look like a pass. Every other guard in this file is worth
#     exactly as much as this one: a guard that does not run is not a guard.
#
#     COMMENT-STRIPPED, and that is load-bearing here: python-app.yml's own
#     docblock explains the ban and therefore CONTAINS the string `branches:`.
#     A bare grep would match the prose forbidding the thing and pass on a file
#     that does the thing — the self-matching-grep sin recorded at guards 6, 7,
#     10 and in scripts/repo-guards.sh's own history.
#     PATH INDIRECTION so this guard is negative-testable without editing the
#     real workflow: PYTHON_WF=/tmp/broken.yml bash scripts/repo-guards.sh must
#     exit 1. CI never sets it. A guard nobody can point at a broken input is a
#     guard nobody has ever seen fail.
_pwf="${PYTHON_WF:-.github/workflows/python-app.yml}"
if [ -f "$_pwf" ]; then
  _pci=$(grep -vE '^[[:space:]]*#' "$_pwf")
  # (a) the push trigger still exists — deleting it disarms this as thoroughly
  #     as scoping it, and leaves no `branches:` for (b) to catch.
  printf '%s\n' "$_pci" | grep -qE '^[[:space:]]*push:' \
    || fail "$_pwf no longer triggers on push — the guard suite and ~200 tests would run on nothing. This is the disarm that hid the entire DR arc for 25 commits."
  # (b) assert the PROPERTY (no branch scoping anywhere in this workflow), not
  #     the spelling of one key. There is no other legitimate `branches:` in
  #     this file, so any occurrence is a re-scope.
  _br=$(printf '%s\n' "$_pci" | grep -cE '^[[:space:]]*branches(-ignore)?:' || true)
  [ "$_br" = "0" ] \
    || fail "$_pwf has re-acquired a branch filter ($_br occurrence(s)) — feature branches would stop running the guard suite, which is exactly the state that let the cloud backup, the dead-man's switch and the watchdog fix land across 25 commits with zero python CI"
  # (c) the disarm one level down: a workflow that still runs but no longer
  #     calls this script leaves 20 guards dark with a green checkmark.
  printf '%s\n' "$_pci" | grep -qF 'bash scripts/repo-guards.sh' \
    || fail "$_pwf no longer invokes 'bash scripts/repo-guards.sh' — every guard in this file is dark, and CI is green"
else
  fail "$_pwf is missing — nothing runs the guard suite or the python tests"
fi

# 13. NO .resolve() IN THE SYMLINKED SET.
#     Guard 5 proves avian/scripts/* ARE symlinks. It cannot see the one thing
#     that makes a symlink invocation behave differently from the canonical one:
#     Path.resolve() collapses avian/scripts/x.py back to services/birdgen/x.py,
#     so a default anchored on parents[] silently jumps trees.
#
#     Measured, 2026-08-01: verify.py carried it. --dir defaulted to a
#     NONEXISTENT services/assets/illustrations, glob() yielded nothing, and the
#     adversarial species-ID gate on the PAID art pipeline printed
#     "verifying 0 illustrations", "0 mismatch(es)" and exited 0. pregen.py had
#     already been fixed for exactly this (see its comment at the _here
#     assignment) and its sibling never got the same treatment -- the instance
#     was fixed, the class was not.
#
#     Derived from the symlinks themselves, never hand-listed, with a vacuity
#     floor: a guard whose input set silently became empty is the shape that
#     asserted 5 of 11 gated paths. Greps the TARGET FILES by path, never `-r`
#     over the repo, so this block's own prose cannot match itself.
_rsyms=$(find avian/scripts -maxdepth 1 -type l -name '*.py' | sort)
_rn=$(printf '%s\n' "$_rsyms" | grep -c . || true)
[ "$_rn" -ge 3 ] \
  || fail "expected at least 3 symlinked .py files under avian/scripts (found $_rn) — either guard 5 is about to fire for a real reason, or this guard just quietly stopped checking anything"
for _s in $_rsyms; do
  grep -q '\.resolve()' "$_s" \
    && fail "$_s uses .resolve() — invoked through the symlink it collapses into services/birdgen/ and every path default anchored on it jumps to the wrong tree. Use Path(os.path.abspath(__file__)) instead (pregen.py records why). This is how verify.py examined zero plates and exited 0."
done

# 14. THE MUSEUM'S SILHOUETTES MUST DESCRIBE THE ART THAT SHIPS.
#     web/public/data/{masks,dims}.json are DERIVED from
#     avian/assets/illustrations/*.png by avian/scripts/build_masks.py, and
#     nothing ever checked that they still matched.
#
#     Measured 2026-08-01: they had not been regenerated since 2026-06-30 and
#     described a SUPERSEDED illustration set. All 249 entries were wrong --
#     accipiter-cooperii carried a 93x93 square silhouette for a plate that is
#     442x849 (48x93) -- and a 250th, apus-apus (Common Swift, a real bird at
#     this station), was absent entirely and packed as a rectangle. The collage
#     had been laying out every bird against the shape of an older drawing for a
#     month, with every test and every guard green.
#
#     A CONTENT cross-check, not an mtime one: mtime says when a file was
#     touched, not whether it is true. PNG width/height are read straight out of
#     the IHDR header (bytes 16..24 of any PNG), so this needs no Pillow and
#     cannot be defeated by a dependency being absent in CI.
if [ -f web/public/data/dims.json ] && [ -d avian/assets/illustrations ]; then
  _mask_report=$(python3 - <<'PY'
import json, struct, pathlib, re, sys

DIM_MAX = 560  # must track build_masks.py
ill = pathlib.Path("avian/assets/illustrations")
data = pathlib.Path("web/public/data")

def png_size(p):
    with p.open("rb") as f:
        head = f.read(24)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return struct.unpack(">II", head[16:24])

valid = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
perched = {p.stem: p for p in ill.glob("*.png")
           if valid.fullmatch(p.stem) and not p.stem.endswith("-2")}
dims = json.loads((data / "dims.json").read_text())
masks = json.loads((data / "masks.json").read_text())

problems = []
missing = sorted(set(perched) - set(dims))
extra = sorted(set(dims) - set(perched))
if missing:
    problems.append(f"{len(missing)} illustration(s) have no dims entry: {missing[:5]}")
if extra:
    problems.append(f"{len(extra)} dims entr(ies) have no illustration: {extra[:5]}")
if set(dims) != set(masks):
    problems.append("dims.json and masks.json cover different slugs")

wrong = []
for slug, p in sorted(perched.items()):
    if slug not in dims:
        continue
    wh = png_size(p)
    if wh is None:
        problems.append(f"{slug}.png is not a PNG")
        continue
    w, h = wh
    s = DIM_MAX / max(w, h)
    want = [round(w * s), round(h * s)]
    if dims[slug] != want:
        wrong.append(f"{slug} art={w}x{h} wants {want} but dims.json says {dims[slug]}")
if wrong:
    problems.append(f"{len(wrong)} silhouette(s) describe a DIFFERENT drawing than the one that ships: {wrong[:3]}")
print(" | ".join(problems))
PY
)
  [ -z "$_mask_report" ] \
    || fail "web/public/data is stale against avian/assets/illustrations — $_mask_report
     Run: python3 avian/scripts/build_masks.py   (then rebuild web/dist)"
  # The committed bundle is what the wall actually serves, so the copy vite
  # emitted must match the source it was built from. dist-fresh compares asset
  # NAMES; it has never compared publicDir CONTENT.
  if [ -f web/dist/data/dims.json ]; then
    cmp -s web/public/data/dims.json  web/dist/data/dims.json \
      && cmp -s web/public/data/masks.json web/dist/data/masks.json \
      || fail "web/dist/data/ differs from web/public/data/ — the museum serves the bundled copy, so regenerating the masks without rebuilding dist changes nothing on the wall"
  fi
fi

[ "$FAIL" = "0" ] && echo "repo-guards: all green"
exit $FAIL
