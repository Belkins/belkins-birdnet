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

say "0. Preflight"
[ -n "$PY" ] || die "python3 not found"
for f in scripts/utils/realtime.py avian/realtime/birdcast.py; do
  [ -f "$HERE/$f" ] || die "missing $f — are you in the pulled Belkins/belkins-birdnet repo?"
done
ok "repo: $HERE"
ok "python: $PY ($("$PY" -V 2>&1))"
# render_unit seds ${HERE}/${HOME}/${PY} into unit files verbatim: a '|' would
# break the sed expression, a '&' would splice the matched text into the path.
# Refuse loudly rather than install silently corrupted units.
case "${HERE}${HOME}${PY}" in
  *'|'*|*'&'*) die "repo/home/python path contains '|' or '&' — render_unit cannot escape it; relocate and re-run" ;;
esac
[ "$PY" = "/usr/bin/python3" ] || warn "python3 resolves to $PY — rendered units will pin THIS interpreter (deactivate any venv and re-run if unintended)"

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

say "2b. Install the OnFailure alert handler (every unit here points at it)"
render_unit "$HERE/avian/realtime/christina-alert@.service" /etc/systemd/system/christina-alert@.service
sudo systemctl daemon-reload
ok "christina-alert@ installed"

say "3. Install + start the birdcast systemd service (port $PORT, reads birds.db read-only)"
UNIT=/etc/systemd/system/birdcast.service
sudo tee "$UNIT" >/dev/null <<UNITEOF
[Unit]
Description=Belkins BirdNET birdcast (realtime SSE spine)
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

say "6. Install the auto-gen watcher forwarder + Railway liveness (POSTs new species to Railway)"
for f in avian/realtime/forwarder.py avian/realtime/railway_liveness.py \
         avian/realtime/forwarder.service avian/realtime/railway-liveness.service \
         avian/realtime/railway-liveness.timer avian/realtime/mic_watch.py \
         avian/realtime/mic-watch.service avian/realtime/mic-watch.timer \
         avian/backup/offbox_backup.py avian/backup/restore_offbox.py \
         avian/backup/offbox-backup.service avian/backup/offbox-backup.timer \
         avian/realtime/weekly_digest.py avian/realtime/weekly_digest.service \
         avian/realtime/weekly_digest.timer; do
  [ -f "$HERE/$f" ] || die "missing $f — pull the full Belkins/belkins-birdnet repo"
done

# 6a. Compile the forwarder pythons before installing (catch syntax issues early).
"$PY" -m py_compile "$HERE/avian/realtime/forwarder.py" "$HERE/avian/realtime/railway_liveness.py" \
                    "$HERE/avian/realtime/mic_watch.py"
ok "forwarder python compiles"

# 6b. Provision the forwarder env. IDEMPOTENT: never clobber an operator-filled
#     secret on re-run — only create it (with a clearly-marked placeholder) when absent.
ENV_DIR="$HOME/.christina"
ENV_FILE="$ENV_DIR/forwarder.env"
mkdir -p "$ENV_DIR"
SECRET_PLACEHOLDER=0
if [ -f "$ENV_FILE" ]; then
  ok "forwarder.env already present — leaving it untouched ($ENV_FILE)"
  if [ ! -r "$ENV_FILE" ]; then
    # Can't verify → don't judge: never stop a possibly-healthy forwarder on
    # a permissions hiccup. 6d leaves the service exactly as it is.
    SECRET_PLACEHOLDER=skip
    warn "cannot read $ENV_FILE — leaving the forwarder's current state unchanged"
  else
    # Parse the way systemd does: LAST assignment wins, leading whitespace
    # tolerated, optional quotes stripped. (A plain anchored grep flagged a
    # real secret appended below a stale REPLACE_ME line — and would have
    # stopped a healthy production forwarder over it.)
    SECRET_VAL="$(sed -n 's/^[[:space:]]*WATCHER_WEBHOOK_SECRET=//p' "$ENV_FILE" | tail -n1 | tr -d '"' | tr -d "'")"
    case "$SECRET_VAL" in
      ''|REPLACE_ME*)
        SECRET_PLACEHOLDER=1
        warn "WATCHER_WEBHOOK_SECRET in $ENV_FILE is missing/empty or still the REPLACE_ME placeholder"
        ;;
    esac
  fi
else
  cat > "$ENV_FILE" <<ENVEOF
# Christina auto-gen watcher forwarder config (Pi-side, low-value secrets only).
# NEVER put the Gemini key here — that lives only on Railway.
AV_RAILWAY_BASE=https://birdgen-production.up.railway.app
# >>> REPLACE THIS PLACEHOLDER <<< must equal WATCHER_WEBHOOK_SECRET on the Railway birdgen service.
WATCHER_WEBHOOK_SECRET=REPLACE_ME_with_the_Railway_WATCHER_WEBHOOK_SECRET
# 0.70 matches the forwarder default + birdgen's CONF_THRESHOLD (a 0.80 pair
# here strands 0.70-0.79 birds as forever-silhouettes — the 987d9da regression;
# deploy-christina.sh already writes 0.70).
AV_CONF=0.70
ENVEOF
  chmod 600 "$ENV_FILE"
  SECRET_PLACEHOLDER=1
  warn "wrote $ENV_FILE with a PLACEHOLDER secret — edit it, set WATCHER_WEBHOOK_SECRET to the Railway value, then: sudo systemctl restart forwarder"
fi

# 6c. Render + install the authored systemd units for this user/repo
#     (idempotent overwrite; on a belkins Pi the render is byte-identical
#     to the checked-in unit, so re-runs on the live box change nothing).
render_unit "$HERE/avian/realtime/forwarder.service" /etc/systemd/system/forwarder.service
render_unit "$HERE/avian/realtime/railway-liveness.service" /etc/systemd/system/railway-liveness.service
sudo install -m 644 "$HERE/avian/realtime/railway-liveness.timer" /etc/systemd/system/railway-liveness.timer
sudo systemctl daemon-reload
ok "installed forwarder.service + railway-liveness.service + .timer (User=${USER_NAME})"

# 6d. Enable + start — but REFUSE to start the forwarder with a placeholder
#     secret (it would 401 at Railway forever and new birds would silently
#     never paint; fail loud instead).
if [ "$SECRET_PLACEHOLDER" = skip ]; then
  warn "forwarder left in its current state — fix the permissions on $ENV_FILE and re-run"
elif [ "$SECRET_PLACEHOLDER" = 1 ]; then
  sudo systemctl disable --now forwarder >/dev/null 2>&1 || true
  warn "REFUSING to start forwarder: WATCHER_WEBHOOK_SECRET in $ENV_FILE is missing or still the placeholder."
  warn "Fix: edit $ENV_FILE, set it to the Railway WATCHER_WEBHOOK_SECRET, then: sudo systemctl enable --now forwarder"
else
  sudo systemctl enable --now forwarder
  sleep 2
  systemctl is-active --quiet forwarder && ok "forwarder is running" || { sudo journalctl -u forwarder -n 20 --no-pager; warn "forwarder not active — check $ENV_FILE"; }
fi
sudo systemctl enable --now railway-liveness.timer && ok "railway-liveness timer enabled (runs every 6h)" || warn "could not enable railway-liveness.timer"

say "7. Mic-loss watchdog (catches a dead/re-enumerated USB mic — a quiet night stays quiet)"
render_unit "$HERE/avian/realtime/mic-watch.service" /etc/systemd/system/mic-watch.service
sudo install -m 644 "$HERE/avian/realtime/mic-watch.timer" /etc/systemd/system/mic-watch.timer
sudo systemctl daemon-reload
sudo systemctl enable --now mic-watch.timer && ok "mic-watch timer enabled (checks every 15min)" || warn "could not enable mic-watch.timer"

say "7b. Weekly recap push (Sunday 18:00 — the honest digest, quiet when nothing is new)"
# The units were committed on 2026-07-03 and this installer never referenced
# them, so on the live Pi the timer simply did not exist and the recap had NEVER
# been sent — for four weeks, silently. A weekly push that never fires reads
# exactly like a quiet season, which is the failure mode the digest itself is
# written to avoid. Installed here so a fresh box gets it too; hand-installing
# it on the Pi (2026-07-30) fixed that box and nothing else.
"$PY" -m py_compile "$HERE/avian/realtime/weekly_digest.py"
render_unit "$HERE/avian/realtime/weekly_digest.service" /etc/systemd/system/weekly_digest.service
sudo install -m 644 "$HERE/avian/realtime/weekly_digest.timer" /etc/systemd/system/weekly_digest.timer
sudo systemctl daemon-reload
sudo systemctl enable --now weekly_digest.timer && ok "weekly_digest timer enabled (Sundays 18:00)" || warn "could not enable weekly_digest.timer"

say "8. Off-box backup (birds.db + accession ledger + phenology ledger + Railway plates leave the card nightly)"
# 8a. Compile here rather than folding into 6a: that call's success line says
#     "forwarder python compiles", and a component's own compile check belongs
#     with the component, not inside another one's message.
"$PY" -m py_compile "$HERE/avian/backup/offbox_backup.py" "$HERE/avian/backup/restore_offbox.py"
ok "backup python compiles"

# 8b. Provision the backup env. IDEMPOTENT, same shape as 6b: never clobber an
#     operator-filled destination on re-run — only create it (with a clearly
#     marked placeholder) when absent.
BK_ENV="$ENV_DIR/backup.env"
BK_DEST=""
BK_PLACEHOLDER=0
if [ -f "$BK_ENV" ]; then
  ok "backup.env already present — leaving it untouched ($BK_ENV)"
  if [ ! -r "$BK_ENV" ]; then
    BK_PLACEHOLDER=skip
    warn "cannot read $BK_ENV — leaving offbox-backup's current state unchanged"
  else
    # Parse the way systemd does: LAST assignment wins, leading whitespace
    # tolerated, optional quotes stripped (same reasoning as 6b).
    BK_DEST="$(sed -n 's/^[[:space:]]*CHRISTINA_BACKUP_DEST=//p' "$BK_ENV" | tail -n1 | tr -d '"' | tr -d "'")"
    case "$BK_DEST" in
      ''|REPLACE_ME*)
        BK_PLACEHOLDER=1
        warn "CHRISTINA_BACKUP_DEST in $BK_ENV is missing/empty or still the REPLACE_ME placeholder"
        ;;
    esac
  fi
else
  cat > "$BK_ENV" <<ENVEOF
# Christina off-box backup config.
# >>> REPLACE THIS PLACEHOLDER <<< with a directory on storage that is NOT this
# SD card: an NFS/CIFS/sshfs mount (best), or a USB stick (second-best — it does
# not survive theft or fire). The job REFUSES to run (exit 2 + one ntfy push) if
# this is unset or resolves to the repo's own filesystem.
CHRISTINA_BACKUP_DEST=REPLACE_ME_with_an_offbox_mount
CHRISTINA_BACKUP_KEEP=14
ENVEOF
  chmod 600 "$BK_ENV"
  BK_PLACEHOLDER=1
  warn "wrote $BK_ENV with a PLACEHOLDER destination — see avian/backup/REHEARSAL.md"
fi

# 8c. Render + install the authored units (never hand-roll a rival unit in a
#     deploy heredoc — catalog.service's own comment names that as the
#     2026-07-02..26 incident).
render_unit "$HERE/avian/backup/offbox-backup.service" /etc/systemd/system/offbox-backup.service
sudo install -m 644 "$HERE/avian/backup/offbox-backup.timer" /etc/systemd/system/offbox-backup.timer
sudo systemctl daemon-reload

# 8d. Enable + start — but REFUSE to arm the timer on a placeholder destination,
#     exactly as 6d refuses to start the forwarder on a placeholder secret. An
#     armed job with no destination pushes a high-priority "UNCONFIGURED" to the
#     SAME ntfy topic that carries mic-watch's dead-mic and railway-liveness's
#     DOWN alerts — every night, until the operator mutes the topic and thereby
#     silences those two as well.
if [ "$BK_PLACEHOLDER" = skip ]; then
  warn "offbox-backup left in its current state — fix the permissions on $BK_ENV and re-run"
elif [ "$BK_PLACEHOLDER" = 1 ]; then
  sudo systemctl disable --now offbox-backup.timer >/dev/null 2>&1 || true
  warn "REFUSING to arm offbox-backup.timer: CHRISTINA_BACKUP_DEST in $BK_ENV is missing or still the placeholder."
  warn "Fix: edit $BK_ENV, point it at an off-box mount, then: sudo systemctl enable --now offbox-backup.timer"
else
  sudo systemctl enable --now offbox-backup.timer && ok "offbox-backup timer enabled (nightly 04:30 -> $BK_DEST)" || warn "could not enable offbox-backup.timer"
fi

cat <<DONE

============================================================
✅ Phase 0 backend spine deployed.
   • birdcast SSE:   http://$(hostname).local:$PORT/events   (and /health)
   • New detections push the instant BirdNET writes them (after step 4 restart).
   • forwarder:      POSTs new species to Railway for on-demand illustration.
     ⚠ REQUIRED: set WATCHER_WEBHOOK_SECRET in $HOME/.christina/forwarder.env
       to the Railway value, then: sudo systemctl restart forwarder
     watch it:  journalctl -u forwarder -f   (expect: forwarded <slug> -> 200)
   • railway-liveness: 6h timer alerts if the Railway gen-service silently dies.
   • mic-watch: 15-min timer detects a dead/unplugged/re-enumerated USB mic,
     restarts recording, and pings once (never on a merely quiet night).
   • off-box backup: nightly 04:30 -> \$CHRISTINA_BACKUP_DEST (see
     avian/backup/REHEARSAL.md). NOT armed until you point backup.env at a real
     off-box mount — birds.db, both ledgers and the Railway plates are the only
     irreplaceable state on this box, and today they share one card.

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
