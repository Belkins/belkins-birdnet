#!/usr/bin/env bash
# Project Christina — full-stack deploy ON a BirdNET-Pi (run on the Pi, from the repo root).
#
# Idempotent + additive: brings up the realtime spine (birdcast), the React collage at
# /collage, and the auto-gen watcher forwarder + cutout Railway proxy on top of a STOCK BirdNET-Pi
# install. Does NOT touch the detection pipeline beyond the (already-committed) emit hook.
# Safe to re-run.
#
# It does NOT supersede deploy-realtime.sh (an earlier header claimed it did --
# it never has). deploy-realtime.sh installs the mic-watch and railway-liveness
# WATCHDOGS, and this script installs none of them. Running only this one on a
# fresh box leaves you with no watchdog at all -- i.e. it removes the very
# things that exist to catch silent failure. Run deploy-realtime.sh too.
#
#   cd ~/BirdNET-Pi            # the belkins-birdnet clone the installer makes
#   CHRISTINA_RAILWAY_BASE=https://<your-svc>.up.railway.app \
#   CHRISTINA_WEBHOOK_SECRET=<webhook-secret> \
#   bash deploy-christina.sh
#
# Without the two CHRISTINA_* envs it deploys the spine + collage only (no auto-gen).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_NAME="$(id -un)"
PY="$(command -v python3)"
DB="${CHRISTINA_BIRDS_DB:-$HERE/scripts/birds.db}"
EXTRACTED="${CHRISTINA_EXTRACTED:-$HOME/BirdSongs/Extracted}"
RAILWAY_BASE="${CHRISTINA_RAILWAY_BASE:-}"
WEBHOOK_SECRET="${CHRISTINA_WEBHOOK_SECRET:-}"
say(){ printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
die(){ printf '\n\033[31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }
ok(){ printf '   \033[32m\xE2\x9C\x93\033[0m %s\n' "$*"; }
warn(){ printf '   \033[33m! %s\033[0m\n' "$*"; }
render_unit(){
  # Render an authored unit for THIS user/repo (frame/install.sh pattern):
  # checked-in units keep valid belkins defaults; sed rewrites them at install.
  sed -e "s|^User=.*|User=${USER_NAME}|" \
      -e "s|/home/belkins/BirdNET-Pi|${HERE}|g" \
      -e "s|/home/belkins|${HOME}|g" \
      -e "s|/usr/bin/python3|${PY}|g" \
      "$1" | sudo tee "$2" >/dev/null
  sudo chmod 644 "$2"
}

say "0. preflight"
[ -n "$PY" ] || { echo "python3 required"; exit 1; }
# render_unit seds ${HERE}/${HOME}/${PY} into unit files verbatim: a '|' would
# break the sed expression, a '&' would splice the matched text into the path.
case "${HERE}${HOME}${PY}" in
  *'|'*|*'&'*) echo "repo/home/python path contains '|' or '&' — render_unit cannot escape it; relocate and re-run" >&2; exit 1 ;;
esac
[ "$PY" = "/usr/bin/python3" ] || warn "python3 resolves to $PY — rendered units will pin THIS interpreter (deactivate any venv and re-run if unintended)"
[ -f "$HERE/avian/realtime/birdcast.py" ] || { echo "run from the belkins-birdnet repo root (~/BirdNET-Pi)"; exit 1; }
grep -q emit_detected "$HERE/scripts/birdnet_analysis.py" || warn "emit hook missing in scripts/birdnet_analysis.py (git pull?)"
[ -f "$DB" ] || warn "birds.db not at $DB (set CHRISTINA_BIRDS_DB)"
ok "repo=$HERE  db=$DB  extracted=$EXTRACTED"

say "0b. the OnFailure alert handler"
# EVERY OnFailure=christina-alert@%n.service in this repo points here. Without
# this file installed, systemd logs that it could not enqueue the handler and
# says nothing else — a silent alerting path, which is the exact disease the
# alerting was added to cure.
render_unit "$HERE/avian/realtime/christina-alert@.service" /etc/systemd/system/christina-alert@.service
sudo systemctl daemon-reload
ok "christina-alert@ handler installed"

say "1. birdcast realtime SSE service (127.0.0.1:8090)"
sudo tee /etc/systemd/system/birdcast.service >/dev/null <<UNIT
[Unit]
Description=Christina birdcast (realtime SSE spine)
After=network.target
OnFailure=christina-alert@%n.service
# Restart=on-failure against systemd's DEFAULT start limit (5 starts / 10s) means
# a hard crash loop can never reach 'failed': one restart per RestartSec never
# fills the window, so birdcast could die and be resurrected forever, silently,
# and the OnFailure= above would never fire once. Widened so 20 crashes inside
# 10 minutes ends in 'failed' and shouts. birdcast.py serves forever, so exiting
# at all is a real fault. A frame that is visibly dead beats one invisibly dying.
StartLimitIntervalSec=600
StartLimitBurst=20
[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$HERE
Environment=AV_BIRDS_DB=$DB
ExecStart=$PY $HERE/avian/realtime/birdcast.py --port 8090
Restart=on-failure
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now birdcast
sleep 1; ok "birdcast: $(systemctl is-active birdcast)"

say "2. load the emit hook into the detector"
sudo systemctl restart birdnet_analysis && ok "birdnet_analysis restarted"

say "3. Caddy /events route (SSE proxy, unbuffered)"
if ! sudo grep -q 'reverse_proxy /events' /etc/caddy/Caddyfile; then
  sudo cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.christina" 2>/dev/null || true
  sudo "$PY" - <<'PYEOF'
p="/etc/caddy/Caddyfile"; s=open(p).read()
b="\n\t# Christina realtime SSE spine\n\treverse_proxy /events localhost:8090 {\n\t\tflush_interval -1\n\t}\n"
i=s.rstrip().rfind("}"); open(p,"w").write(s[:i]+b+s[i:])
PYEOF
  ok "events route inserted"
else ok "events route already present"; fi
sudo systemctl reload caddy

say "4. serve the React collage at /collage"
if [ -d "$HERE/web/dist" ]; then
  # This branch PREFERS whatever is on disk over rebuilding, so the worktree copy
  # is what reaches the wall. repo-guards 4/4b only ever inspect the git INDEX,
  # which means a local `npm run build` with no --base, a partial checkout or a
  # half-written dist deploys completely unchecked: every asset 404s, and caddy's
  # php try_files answers each 404 with 200 text/html (measured on this box), so
  # nothing downstream can tell. Validate the DIRECTORY before it is copied.
  # ASSERT THE GUARD CAN DO THE JOB BEFORE TRUSTING ITS EXIT CODE. A repo-guards.sh
  # from before these subcommands existed IGNORES the extra arguments, runs its
  # ordinary list and exits 0 — so this step would print "validated" having
  # validated nothing. Measured, not assumed: the pre-change script does exactly
  # that. git moves both files together so the window is narrow, but a fail-open
  # step wearing a green label is the one thing this deploy must not have.
  for _mode in dist-fresh dist-static dist-served; do
    grep -qE "^${_mode}\)" "$HERE/scripts/repo-guards.sh" \
      || die "scripts/repo-guards.sh has no '${_mode}' mode — it is older than this deploy script and would silently pass. Update the checkout before deploying."
  done
  bash "$HERE/scripts/repo-guards.sh" dist-static "$HERE/web/dist" \
    || { echo "REFUSING TO DEPLOY: $HERE/web/dist is not a serveable /collage/ bundle (see above). Rebuild with: (cd $HERE/web && npm run build -- --base=/collage/)" >&2; exit 1; }
  rm -rf "$EXTRACTED/collage"; cp -r "$HERE/web/dist" "$EXTRACTED/collage"; ok "served prebuilt web/dist (validated)"
elif command -v npm >/dev/null; then
  ( cd "$HERE/web" && npm ci && npm run build -- --base=/collage/ )
  rm -rf "$EXTRACTED/collage"; cp -r "$HERE/web/dist" "$EXTRACTED/collage"; ok "built + served (npm)"
else
  warn "no web/dist committed and no npm on PATH — collage skipped (commit a /collage-based dist, or install node)"
fi
# Serve the nightly catalog under /collage/ so the life-list "wall" tab reads
# ${BASE}species.json and /lab reads ${BASE}derived.json. Both OVERRIDE the
# bundled dev fixture that ships inside web/dist.
#
# WHY THIS IS A FUNCTION WITH HARD FAILURES. This used to be
#     [ -d X ] && ln -sf A B && ok "..."
# and under `set -euo pipefail` that is NOT protected: in `A && B && C`, only
# the LAST command's status is checked by set -e. A failing `ln` — or a missing
# collage dir — simply fell through, `ok` never printed, and the deploy carried
# on to announce success. Two lines above, `rm -rf $EXTRACTED/collage` followed
# by `cp -r web/dist` has just dropped the 8-species Nearctic DEV FIXTURE
# (American Robin, Cardinal, Blue Jay — birds this London station has never
# heard) into place with a brand-new mtime. Only these symlinks put the real
# catalog back. If they don't, the wall serves invented birds and every
# timestamp looks perfect.
#
# The link is asserted LOCALLY — no HTTP, no clock, no catalog run — because
# that is the thing this step is responsible for and it can be checked
# deterministically. Whether the TARGET exists yet is a different question with
# a legitimate answer on a fresh box, so it warns rather than dies.
link_catalog_data() { # $1=basename  $2=what reads it
  local src="$HERE/scripts/$1" dst="$EXTRACTED/collage/$1"
  [ -d "$EXTRACTED/collage" ] \
    || die "$EXTRACTED/collage does not exist, so $1 cannot be linked — the collage was not deployed above, and the wall has no data plane"
  ln -sf "$src" "$dst" \
    || die "could not link $1 onto the wall. web/dist ships an 8-species Nearctic DEV FIXTURE and the copy above just put it there; without this symlink the museum serves invented birds with a perfect mtime."
  [ -L "$dst" ] \
    || die "$dst is not a symlink after ln -sf — it is the bundled fixture, and the wall would serve 8 Nearctic species as if they had been heard here"
  [ "$(readlink "$dst")" = "$src" ] \
    || die "$dst points at $(readlink "$dst"), not $src — the wall is reading the wrong catalog"
  if [ -e "$dst" ]; then
    ok "$1 -> scripts/$1 (served at /collage/$1)"
  else
    warn "$1 is linked but scripts/$1 does not exist yet — $2 stays empty until catalog.service has run once (expected on a fresh box; NOT expected on a station that has been up a day)"
  fi
}
link_catalog_data species.json "the life-list wall"
link_catalog_data derived.json "the /lab console"

say "5. regenerate collage silhouette masks (so any new illustration is placeable)"
if ( cd "$HERE/avian/scripts" && "$PY" build_masks.py ) >/dev/null 2>&1; then ok "masks rebuilt"; else warn "build_masks failed (Pillow missing?)"; fi

say "6. auto-gen watcher (forwarder + cutout.php Railway proxy)"
if [ -n "$RAILWAY_BASE" ] && [ -n "$WEBHOOK_SECRET" ]; then
  POOL="$(ls /etc/php/*/fpm/pool.d/www.conf 2>/dev/null | head -1)"
  FPM="$(systemctl list-units --type=service --no-legend 2>/dev/null | grep -oE 'php[0-9.]+-fpm' | head -1)"
  if [ -n "$POOL" ]; then
    if sudo grep -q 'AV_RAILWAY_ASSET_BASE' "$POOL"; then
      sudo sed -i "s#^env\[AV_RAILWAY_ASSET_BASE\].*#env[AV_RAILWAY_ASSET_BASE] = \"$RAILWAY_BASE\"#" "$POOL"
    else
      echo "env[AV_RAILWAY_ASSET_BASE] = \"$RAILWAY_BASE\"" | sudo tee -a "$POOL" >/dev/null
    fi
    sudo systemctl restart "$FPM"; ok "cutout.php proxy -> $RAILWAY_BASE (via $FPM)"
  fi
  umask 077; mkdir -p "$HOME/.christina"
  cat > "$HOME/.christina/forwarder.env" <<ENV
AV_RAILWAY_BASE=$RAILWAY_BASE
WATCHER_WEBHOOK_SECRET=$WEBHOOK_SECRET
AV_ILLUSTRATIONS=$HERE/avian/assets/illustrations
AV_CONF=0.70
BIRDCAST_EVENTS=http://127.0.0.1:8090/events
ENV
  chmod 600 "$HOME/.christina/forwarder.env"
  render_unit "$HERE/avian/realtime/forwarder.service" /etc/systemd/system/forwarder.service
  sudo systemctl daemon-reload
  sudo systemctl enable --now forwarder
  sleep 1; ok "forwarder: $(systemctl is-active forwarder) (holds the webhook secret only, never the Gemini key)"
else
  warn "CHRISTINA_RAILWAY_BASE + CHRISTINA_WEBHOOK_SECRET not set -> auto-gen watcher skipped (spine + collage deployed)"
fi

say "7. species catalog (christina.db, derived nightly from birds.db, read-only)"
if [ -f "$HERE/avian/catalog/rebuild_catalog.py" ]; then
  # Install THE authored unit (avian/catalog/catalog.service) via render_unit --
  # never a heredoc copy. A second, hand-rolled definition is what dropped
  # derive.py's ExecStart and froze derived.json for 24 days (2026-07-02..26).
  # One file, one source of truth, and `repo-guards.sh` asserts there is no
  # rival catalog.service heredoc in this script.
  #
  # The manifest URL is written to an EnvironmentFile read at RUN time rather
  # than baked into the unit as a flag: baking it meant an unset shell env at
  # deploy time permanently disabled the ONLY path that can mark art ready on a
  # non-US station (the bundled set is Nearctic).
  mkdir -p "$HOME/.christina"
  if [ -n "$RAILWAY_BASE" ]; then
    printf 'CHRISTINA_MANIFEST_URL=%s/manifest\n' "${RAILWAY_BASE%/}" \
      > "$HOME/.christina/catalog.env"
    chmod 600 "$HOME/.christina/catalog.env"
    ok "catalog.env -> ${RAILWAY_BASE%/}/manifest (art_status = bundled UNION auto-generated)"
  else
    warn "CHRISTINA_RAILWAY_BASE unset -- catalog cannot see auto-generated art."
    warn "On a non-US station the bundled illustrations (Nearctic) cover almost"
    warn "nothing, so nearly every species will report art_status='unknown'."
    warn "Fix without redeploying:  echo CHRISTINA_MANIFEST_URL=<base>/manifest > ~/.christina/catalog.env"
  fi
  render_unit "$HERE/avian/catalog/catalog.service" /etc/systemd/system/catalog.service
  sudo tee /etc/systemd/system/catalog.timer >/dev/null <<'UNIT'
[Unit]
Description=Nightly + boot rebuild of the Christina species catalog
[Timer]
OnCalendar=*-*-* 03:30:00
OnBootSec=2min
Persistent=true
Unit=catalog.service
[Install]
WantedBy=timers.target
UNIT
  # Initial build + derive, through the SAME env the unit will use, so a green
  # deploy proves the nightly path rather than a different one. Exit 3 =
  # published but degraded (manifest unanswered); that must WARN, not pass.
  set -a; [ -f "$HOME/.christina/catalog.env" ] && . "$HOME/.christina/catalog.env"; set +a
  cat_rc=0; "$PY" "$HERE/avian/catalog/rebuild_catalog.py" >/dev/null 2>&1 || cat_rc=$?
  case "$cat_rc" in
    0) ok "initial catalog built ($(sqlite3 "$HERE/scripts/christina.db" 'SELECT COUNT(*) FROM species' 2>/dev/null) species; birds.db untouched, read-only)" ;;
    3) warn "catalog published but DEGRADED — the birdgen manifest went unanswered."
       warn "art_status will read 'unknown' (not 'none') until it resolves."
       warn "check: $PY $HERE/avian/catalog/rebuild_catalog.py" ;;
    *) warn "initial catalog build FAILED rc=$cat_rc (see: $PY $HERE/avian/catalog/rebuild_catalog.py)" ;;
  esac
  der_rc=0; "$PY" "$HERE/avian/catalog/derive.py" >/dev/null 2>&1 || der_rc=$?
  if [ "$der_rc" -eq 0 ]; then
    ok "derived.json built ($(python3 -c "import json;print(json.load(open('$HERE/scripts/derived.json'))['built_at'])" 2>/dev/null || echo '?'))"
  else warn "derive FAILED rc=$der_rc — companion surfaces (/lab, rarity, first-of-year) will be STALE"; fi
  sudo systemctl daemon-reload
  sudo systemctl enable --now catalog.timer
  ok "catalog.timer: $(systemctl is-active catalog.timer)"
else warn "avian/catalog not present — species catalog skipped (git pull?)"; fi

say "8. self-check"
# NOTE the %{http_code} below is INFORMATIONAL ONLY and must never be trusted as
# a collage health signal: caddy's php try_files fallback answers 200 text/html
# for EVERY missing path under /collage/ (measured 2026-07-30 — a nonexistent
# .js returns `200 text/html`). The real check is the dist-served one after it,
# which asserts content-type and the served asset set instead of the status.
echo "   collage:   $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/collage/) (status only — 200 here proves nothing)"
echo "   /events:   $(curl -s -N --max-time 3 http://127.0.0.1/events | head -1)"
echo "   catalog:   $(sqlite3 "$HERE/scripts/christina.db" 'SELECT COUNT(*) FROM species' 2>/dev/null || echo 0) species in christina.db"
[ -n "$RAILWAY_BASE" ] && echo "   forwarder: $(systemctl is-active forwarder)"
# Did the bundle we just copied actually reach the wall? Content-type + served
# asset set, never status. Hard-fails: a blank wall is the one outcome this
# whole script exists to avoid, and it is invisible to every other probe here.
if [ -d "$EXTRACTED/collage" ]; then
  echo "   bundle:"
  bash "$HERE/scripts/repo-guards.sh" dist-served "http://127.0.0.1/collage" "$EXTRACTED/collage" 2>&1 | sed 's/^/     /' \
    || { echo "DEPLOY FAILED VERIFICATION: the wall is not serving the bundle just copied (see above)." >&2; exit 1; }
fi
# Serving-chain smoke (pipeline-hardening P0): prove headers + cache contract
# on one plate through the REAL cutout path. Warn-only — a transient probe
# flake must not fail an otherwise-good deploy (open question in the plan).
# Gate on -f, NOT -x: verify.sh was committed mode 100644, so an -x gate was
# never satisfiable and this whole block silently never ran — a check that
# could not fire while the deploy reported success. It is invoked through
# `bash`, so the exec bit is irrelevant to running it; only the gate needed it.
if [ -f "$HERE/scripts/verify.sh" ]; then
  echo "   serving:"
  AV_PI_BASE=http://127.0.0.1 bash "$HERE/scripts/verify.sh" erithacus-rubecula 1 2>&1 | sed 's/^/     /' \
    || warn "verify.sh smoke flagged a serving problem (see above) — deploy completed, but eyeball the wall"
fi
echo
echo "============================================================"
echo " Christina deployed. Open  http://$(hostname).local/collage"
echo "============================================================"
