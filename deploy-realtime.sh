#!/usr/bin/env bash
# Belkins BirdNET — Phase 0 realtime deploy (RUN THIS ON THE PI).
# Additive + idempotent + non-destructive: installs the `birdcast` SSE service on
# port 8090 and loads the emit hook. It does NOT modify your existing BirdNET-Pi
# site, Caddy, or the birds.db schema. Safe to re-run.
#
#   cd <this repo on the Pi> && bash deploy-realtime.sh
#
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_NAME="$(id -un)"
PY="$(command -v python3 || true)"
PORT="${BIRDCAST_PORT:-8090}"

say(){ printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok(){ printf '   \033[32m✓\033[0m %s\n' "$*"; }
warn(){ printf '   \033[33m! %s\033[0m\n' "$*"; }
die(){ printf '\n\033[31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }

say "0. Preflight"
[ -n "$PY" ] || die "python3 not found"
for f in scripts/utils/realtime.py avian/realtime/birdcast.py; do
  [ -f "$HERE/$f" ] || die "missing $f — are you in the pulled Belkins/belkins-birdnet repo?"
done
ok "repo: $HERE"
ok "python: $PY ($("$PY" -V 2>&1))"

# locate birds.db (read-only source of truth)
DB=""
for c in "$HERE/scripts/birds.db" "$HOME/BirdNET-Pi/scripts/birds.db" "/home/$USER_NAME/BirdNET-Pi/scripts/birds.db"; do
  [ -f "$c" ] && { DB="$c"; break; }
done
[ -n "$DB" ] && ok "birds.db: $DB" || warn "birds.db not found — birdcast will still start; live events need it. Set BIRDCAST_DB=/path and re-run."
DB="${BIRDCAST_DB:-$DB}"

say "1. Verify the emit hook is present in the detection pipeline"
if grep -q "emit_detected" "$HERE/scripts/birdnet_analysis.py" 2>/dev/null; then
  ok "emit hook present in scripts/birdnet_analysis.py"
else
  warn "emit hook NOT found in $HERE/scripts/birdnet_analysis.py."
  warn "If your live install lives elsewhere, run this from THAT directory, or pull the fork into it."
fi

say "2. Compile the Python (catch syntax issues before installing)"
"$PY" -m py_compile "$HERE/scripts/utils/realtime.py" "$HERE/avian/realtime/birdcast.py"
ok "python compiles"

say "3. Install + start the birdcast systemd service (port $PORT, reads birds.db read-only)"
UNIT=/etc/systemd/system/birdcast.service
sudo tee "$UNIT" >/dev/null <<UNITEOF
[Unit]
Description=Belkins BirdNET birdcast (realtime SSE spine)
After=network.target

[Service]
Type=simple
User=${USER_NAME}
WorkingDirectory=${HERE}
Environment=AV_BIRDS_DB=${DB}
ExecStart=${PY} ${HERE}/avian/realtime/birdcast.py --port ${PORT}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNITEOF
sudo systemctl daemon-reload
sudo systemctl enable --now birdcast
sleep 2
systemctl is-active --quiet birdcast && ok "birdcast is running on :$PORT" || { sudo journalctl -u birdcast -n 20 --no-pager; die "birdcast failed to start (logs above)"; }

say "4. Load the emit hook into the live detector (restart birdnet_analysis)"
if systemctl list-unit-files 2>/dev/null | grep -q '^birdnet_analysis'; then
  read -r -p "   Restart birdnet_analysis now to load the hook? [y/N] " a || a=n
  if [ "${a:-n}" = "y" ] || [ "${a:-n}" = "Y" ]; then
    sudo systemctl restart birdnet_analysis && ok "birdnet_analysis restarted"
  else
    warn "skipped — run 'sudo systemctl restart birdnet_analysis' when ready (new birds won't push until you do)"
  fi
else
  warn "birdnet_analysis.service not found — restart your detection process manually to load the hook"
fi

say "5. Self-check: prove REAL detections flow through the spine"
sleep 1
echo "   --- /health ---"
curl -s --max-time 4 "http://127.0.0.1:$PORT/health" || warn "health check failed"
echo; echo "   --- replay recent real detections (Last-Event-ID: 0) ---"
curl -sN --max-time 5 -H "Last-Event-ID: 0" "http://127.0.0.1:$PORT/events" | head -12 || warn "events stream check failed"

cat <<DONE

============================================================
✅ Phase 0 backend spine deployed.
   • birdcast SSE:   http://$(hostname).local:$PORT/events   (and /health)
   • New detections push the instant BirdNET writes them (after step 4 restart).

▶ WATCH IT LIVE (from your Mac, in your OWN terminal — has LAN access):
     cd "<repo>/web"
     VITE_EVENTS_URL=http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT/events \\
     VITE_API_BASE=http://$(hostname -I 2>/dev/null | awk '{print $1}')/avian/api \\
     npm install && npm run dev
   open the printed URL → birds paint in as they're heard.

   (Snapshot may be empty cross-origin; live SSE still paints. Same-origin
    serving from the Pi's Caddy at /collage is the next step — ask Claude.)

⚠ Before exposing anything publicly: remove the caddy NOPASSWD sudoers line and
   restrict birdcast's Access-Control-Allow-Origin (currently * for LAN dev).
============================================================
DONE
