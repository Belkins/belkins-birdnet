#!/usr/bin/env bash
# Project Christina — full-stack deploy ON a BirdNET-Pi (run on the Pi, from the repo root).
#
# Idempotent + additive: brings up the realtime spine (birdcast), the React collage at
# /collage, and the auto-gen watcher forwarder + cutout 302 on top of a STOCK BirdNET-Pi
# install. Does NOT touch the detection pipeline beyond the (already-committed) emit hook.
# Safe to re-run. Supersedes deploy-realtime.sh (which does the spine only).
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
ok(){ printf '   \033[32m\xE2\x9C\x93\033[0m %s\n' "$*"; }
warn(){ printf '   \033[33m! %s\033[0m\n' "$*"; }

say "0. preflight"
[ -n "$PY" ] || { echo "python3 required"; exit 1; }
[ -f "$HERE/avian/realtime/birdcast.py" ] || { echo "run from the belkins-birdnet repo root (~/BirdNET-Pi)"; exit 1; }
grep -q emit_detected "$HERE/scripts/birdnet_analysis.py" || warn "emit hook missing in scripts/birdnet_analysis.py (git pull?)"
[ -f "$DB" ] || warn "birds.db not at $DB (set CHRISTINA_BIRDS_DB)"
ok "repo=$HERE  db=$DB  extracted=$EXTRACTED"

say "1. birdcast realtime SSE service (127.0.0.1:8090)"
sudo tee /etc/systemd/system/birdcast.service >/dev/null <<UNIT
[Unit]
Description=Christina birdcast (realtime SSE spine)
After=network.target
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
  rm -rf "$EXTRACTED/collage"; cp -r "$HERE/web/dist" "$EXTRACTED/collage"; ok "served prebuilt web/dist"
elif command -v npm >/dev/null; then
  ( cd "$HERE/web" && npm ci && npm run build -- --base=/collage/ )
  rm -rf "$EXTRACTED/collage"; cp -r "$HERE/web/dist" "$EXTRACTED/collage"; ok "built + served (npm)"
else
  warn "no web/dist committed and no npm on PATH — collage skipped (commit a /collage-based dist, or install node)"
fi
# Serve the nightly species catalog under /collage/ so the life-list "wall" tab
# reads ${BASE}species.json. Overrides the bundled dev fixture that shipped in
# web/dist; a no-op if the collage dir wasn't built above.
[ -d "$EXTRACTED/collage" ] && ln -sf "$HERE/scripts/species.json" "$EXTRACTED/collage/species.json" && ok "species.json -> scripts/species.json (served at /collage/species.json)"

say "5. regenerate collage silhouette masks (so any new illustration is placeable)"
if ( cd "$HERE/avian/scripts" && "$PY" build_masks.py ) >/dev/null 2>&1; then ok "masks rebuilt"; else warn "build_masks failed (Pillow missing?)"; fi

say "6. auto-gen watcher (forwarder + cutout.php 302)"
if [ -n "$RAILWAY_BASE" ] && [ -n "$WEBHOOK_SECRET" ]; then
  POOL="$(ls /etc/php/*/fpm/pool.d/www.conf 2>/dev/null | head -1)"
  FPM="$(systemctl list-units --type=service --no-legend 2>/dev/null | grep -oE 'php[0-9.]+-fpm' | head -1)"
  if [ -n "$POOL" ]; then
    if sudo grep -q 'AV_RAILWAY_ASSET_BASE' "$POOL"; then
      sudo sed -i "s#^env\[AV_RAILWAY_ASSET_BASE\].*#env[AV_RAILWAY_ASSET_BASE] = \"$RAILWAY_BASE\"#" "$POOL"
    else
      echo "env[AV_RAILWAY_ASSET_BASE] = \"$RAILWAY_BASE\"" | sudo tee -a "$POOL" >/dev/null
    fi
    sudo systemctl restart "$FPM"; ok "cutout.php 302 -> $RAILWAY_BASE (via $FPM)"
  fi
  umask 077; mkdir -p "$HOME/.christina"
  cat > "$HOME/.christina/forwarder.env" <<ENV
AV_RAILWAY_BASE=$RAILWAY_BASE
WATCHER_WEBHOOK_SECRET=$WEBHOOK_SECRET
AV_ILLUSTRATIONS=$HERE/avian/assets/illustrations
AV_CONF=0.80
BIRDCAST_EVENTS=http://127.0.0.1:8090/events
ENV
  chmod 600 "$HOME/.christina/forwarder.env"
  sudo cp "$HERE/avian/realtime/forwarder.service" /etc/systemd/system/forwarder.service
  sudo systemctl daemon-reload
  sudo systemctl enable --now forwarder
  sleep 1; ok "forwarder: $(systemctl is-active forwarder) (holds the webhook secret only, never the Gemini key)"
else
  warn "CHRISTINA_RAILWAY_BASE + CHRISTINA_WEBHOOK_SECRET not set -> auto-gen watcher skipped (spine + collage deployed)"
fi

say "7. species catalog (christina.db, derived nightly from birds.db, read-only)"
if [ -f "$HERE/avian/catalog/rebuild_catalog.py" ]; then
  # Railway manifest -> accurate art_status (bundled UNION auto-generated), so the
  # Life List wall shows auto-gen'd paintings, not just locally-bundled art.
  CAT_MANIFEST=""
  [ -n "$RAILWAY_BASE" ] && CAT_MANIFEST=" --manifest-url ${RAILWAY_BASE%/}/manifest"
  sudo tee /etc/systemd/system/catalog.service >/dev/null <<UNIT
[Unit]
Description=Christina species catalog rebuild (christina.db from birds.db, read-only)
After=network-online.target
[Service]
Type=oneshot
User=$USER_NAME
Nice=10
IOSchedulingClass=idle
ExecStart=$PY $HERE/avian/catalog/rebuild_catalog.py$CAT_MANIFEST
UNIT
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
  if "$PY" "$HERE/avian/catalog/rebuild_catalog.py"$CAT_MANIFEST >/dev/null 2>&1; then
    ok "initial catalog built ($(sqlite3 "$HERE/scripts/christina.db" 'SELECT COUNT(*) FROM species' 2>/dev/null) species; birds.db untouched, read-only)"
  else warn "initial catalog build failed (see: $PY $HERE/avian/catalog/rebuild_catalog.py)"; fi
  sudo systemctl daemon-reload
  sudo systemctl enable --now catalog.timer
  ok "catalog.timer: $(systemctl is-active catalog.timer)"
else warn "avian/catalog not present — species catalog skipped (git pull?)"; fi

say "8. self-check"
echo "   collage:   $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/collage/)"
echo "   /events:   $(curl -s -N --max-time 3 http://127.0.0.1/events | head -1)"
echo "   catalog:   $(sqlite3 "$HERE/scripts/christina.db" 'SELECT COUNT(*) FROM species' 2>/dev/null || echo 0) species in christina.db"
[ -n "$RAILWAY_BASE" ] && echo "   forwarder: $(systemctl is-active forwarder)"
echo
echo "============================================================"
echo " Christina deployed. Open  http://$(hostname).local/collage"
echo "============================================================"
