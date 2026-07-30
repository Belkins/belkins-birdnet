#!/usr/bin/env bash
# Christina — install the off-box backup on the Pi, or refuse and say why.
#
# WHY THIS FILE EXISTS
# offbox_backup.py, offbox-backup.service and offbox-backup.timer were written,
# tested and committed on 2026-07-27. Measured on the live Pi on 2026-07-30:
# offbox-backup.timer and .service are NOT INSTALLED there, CHRISTINA_BACKUP_DEST
# is unset, no off-box destination is mounted, and the units have never run once.
# The machinery was built and never switched on, and nothing anywhere said so.
#
# The dangerous fix is a script that installs the timer regardless and prints a
# green tick. A "backup" that lands on /dev/mmcblk0p2 -- the same 29.5 GB SD card
# that holds birds.db -- is not a backup: it survives nothing the original does
# not survive, and it is WORSE than having none, because it looks like safety and
# stops anyone from arranging real safety. So every failure below is a refusal:
# non-zero, named, and nothing installed.
#
#   bash avian/backup/install-backup.sh --dry-run   # validate + print the plan
#   CHRISTINA_BACKUP_DEST=/mnt/christina-backup \
#     bash avian/backup/install-backup.sh           # validate, then install
#
# Idempotent: safe to run twice. Never clobbers an existing backup.env.
#
# EXIT CODES (0 = installed or dry-run clean)
#   1  preflight: no python3, or a path this script cannot safely sed
#   2  REFUSED — CHRISTINA_BACKUP_DEST unset, empty, or still the placeholder
#   3  REFUSED — the destination does not exist or is not a directory
#   4  REFUSED — the destination is on the SAME filesystem as the repo (the SD
#                card), or lives inside the repo. Nothing was installed.
#   5  REFUSED — the destination is not actually writable (proven by writing)
#   6  REFUSED — the OnFailure handler is missing, or has grown an OnFailure= of
#                its own (that would be an infinite alert loop)
#   7  cannot install here: no systemd
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
USER_NAME="$(id -un)"
PY="$(command -v python3 || true)"
ENV_DIR="$HOME/.christina"
BK_ENV="$ENV_DIR/backup.env"
FW_ENV="$ENV_DIR/forwarder.env"
ALERT_UNIT="$REPO/avian/realtime/christina-alert@.service"
DRY=0

say(){ printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok(){ printf '   \033[32m✓\033[0m %s\n' "$*"; }
warn(){ printf '   \033[33m! %s\033[0m\n' "$*"; }
# refuse <exit-code> <reason...> — the ONLY way this script reports a problem.
# Always non-zero, always named, always ends with what was NOT installed.
refuse(){
  local code="$1"; shift
  printf '\n\033[31mREFUSED (%s): %s\033[0m\n' "$code" "$*" >&2
  printf '\033[31mNOTHING WAS INSTALLED. offbox-backup.timer remains %s.\033[0m\n' \
         "$(systemctl is-enabled offbox-backup.timer 2>/dev/null || echo 'not installed')" >&2
  exit "$code"
}

INSTALLED=()
SKIPPED=()

for a in "$@"; do
  case "$a" in
    --dry-run|-n) DRY=1 ;;
    -h|--help) sed -n '2,40p' "$BASH_SOURCE"; exit 0 ;;
    *) printf 'unknown argument: %s (see --help)\n' "$a" >&2; exit 1 ;;
  esac
done

# ---------------------------------------------------------------- 0. preflight
say "0. Preflight"
[ -n "$PY" ] || { printf '\n\033[31mFAIL: python3 not found\033[0m\n' >&2; exit 1; }
# render_unit below seds these into unit files verbatim, exactly as
# deploy-realtime.sh:19-28 does; a '|' breaks the expression and a '&' splices
# the matched text into the path. Refuse rather than install corrupted units.
case "${REPO}${HOME}${PY}" in
  *'|'*|*'&'*) printf '\n\033[31mFAIL: repo/home/python path contains | or & — cannot render units safely\033[0m\n' >&2; exit 1 ;;
esac
ok "repo:   $REPO"
ok "python: $PY ($("$PY" -V 2>&1))"
ok "user:   $USER_NAME"

# ------------------------------------------------- 1. resolve the destination
# Precedence: the environment (so a one-off run can be validated without editing
# anything), then backup.env (what the unit will actually read at 04:30).
env_get(){
  local f="$1" k="$2" v=""
  [ -f "$f" ] || return 0
  v="$(grep -E "^[[:space:]]*${k}=" "$f" 2>/dev/null | tail -n 1 | sed -e "s/^[[:space:]]*${k}=//")" || true
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}

say "1. Destination"
DEST="${CHRISTINA_BACKUP_DEST:-}"
DEST_SRC="the environment"
if [ -z "$DEST" ]; then
  DEST="$(env_get "$BK_ENV" CHRISTINA_BACKUP_DEST)"
  DEST_SRC="$BK_ENV"
fi

# GATE 1 (exit 2) — unset, empty, or still deploy-realtime.sh's placeholder.
case "${DEST}" in
  "")
    refuse 2 "CHRISTINA_BACKUP_DEST is unset (checked the environment and $BK_ENV).
   There is no destination, so there is nothing to install. The Pi's ONLY storage
   is its 29.5 GB SD card; see avian/backup/README.md for the honest options."
    ;;
  REPLACE_ME*|*REPLACE_ME*)
    refuse 2 "CHRISTINA_BACKUP_DEST is still the placeholder ($DEST) in $BK_ENV.
   deploy-realtime.sh writes that placeholder on purpose so a fresh install cannot
   silently arm a backup that writes nowhere. Point it at real off-box storage."
    ;;
esac
DEST="${DEST/#\~/$HOME}"
ok "destination: $DEST  (from $DEST_SRC)"

# GATE 2 (exit 3) — must exist and be a directory. An unplugged USB disk leaves
# the mountpoint behind as an empty directory ON THE CARD, which is why GATE 3
# below is the one that matters and is not merged into this one.
[ -e "$DEST" ] || refuse 3 "CHRISTINA_BACKUP_DEST $DEST does not exist. Is the mount up?"
[ -d "$DEST" ] || refuse 3 "CHRISTINA_BACKUP_DEST $DEST exists but is not a directory."
ok "exists and is a directory"

# GATE 3 (exit 4) — the whole point. st_dev, not `df` parsing and not a string
# compare on the path: it is the same test offbox_backup.py:176-181 applies at
# 04:30, so the installer cannot arm something the runtime will refuse. This also
# catches the nastiest case by construction: a mountpoint whose disk is NOT
# mounted, where writes land on the card while the path still looks right.
DEV_DEST="$("$PY" -c 'import os,sys; print(os.stat(sys.argv[1]).st_dev)' "$DEST")"
DEV_REPO="$("$PY" -c 'import os,sys; print(os.stat(sys.argv[1]).st_dev)' "$REPO")"
if [ "$DEV_DEST" = "$DEV_REPO" ]; then
  refuse 4 "CHRISTINA_BACKUP_DEST $DEST is on the SAME filesystem as the repo (st_dev=$DEV_DEST).
   That is the card birds.db already lives on. A copy there dies with the original
   — card failure, corruption, or 'git clean -fdx' — while looking like safety,
   which is why this is a refusal and not a warning.
   Attach real off-box storage (avian/backup/README.md lists the options).
   To REHEARSE the backup without off-box storage, run the script by hand:
     CHRISTINA_BACKUP_ALLOW_SAME_DEVICE=1 CHRISTINA_BACKUP_DEST=/tmp/rehearsal \\
       python3 avian/backup/offbox_backup.py
   That escape hatch exists for the runtime. It is deliberately NOT honoured here:
   a rehearsal is not a thing to arm on a timer and forget."
fi
ok "on a different filesystem from the repo (dest st_dev=$DEV_DEST, repo st_dev=$DEV_REPO)"

case "$DEST/" in
  "$REPO"/*) refuse 4 "CHRISTINA_BACKUP_DEST $DEST is INSIDE the repo ($REPO) — a bind mount can put it on another device and still be inside the blast radius of 'git clean -fdx'." ;;
esac
ok "outside the repo tree"

# GATE 4 (exit 5) — writability, PROVEN. `test -w` is a permission-bit read: root
# passes it on a read-only mount, and this project already has five recorded
# incidents of a check that could not fail. So: write, read back, compare, delete.
PROBE="$DEST/.christina-install-probe.$$"
NONCE="christina-$(date -u +%Y%m%dT%H%M%SZ)-$$"
if ! printf '%s\n' "$NONCE" >"$PROBE" 2>/dev/null; then
  refuse 5 "CHRISTINA_BACKUP_DEST $DEST is not writable by $USER_NAME (could not create $PROBE).
   offbox-backup.service runs as $USER_NAME, so it would fail every night at 04:30."
fi
READBACK="$(cat "$PROBE" 2>/dev/null || true)"
rm -f "$PROBE" 2>/dev/null || true
[ "$READBACK" = "$NONCE" ] || refuse 5 "CHRISTINA_BACKUP_DEST $DEST accepted a write but read back '$READBACK' instead of '$NONCE' — the filesystem is lying about the write."
ok "writable (wrote, read back, deleted a probe file as $USER_NAME)"

# Measured context, so the operator can see whether the archives will fit.
# Reported, never enforced: this script does not invent a size threshold.
df -P "$DEST" | tail -n 1 | awk '{printf "   \033[32m✓\033[0m free at destination: %.1f GB of %.1f GB (%s used)\n", $4/1048576, $2/1048576, $5}'
for f in scripts/birds.db scripts/accessions.json scripts/phenology.json; do
  [ -f "$REPO/$f" ] && ok "source present: $f ($(du -h "$REPO/$f" | cut -f1))" || warn "source MISSING: $f (offbox_backup.py will report it)"
done

# GATE 5 (exit 6) — the alert handler must exist, and must not be able to loop.
say "2. Failure-alert handler"
[ -f "$ALERT_UNIT" ] || refuse 6 "$ALERT_UNIT is missing. offbox-backup.service declares OnFailure=christina-alert@%n.service; installing the backup without its handler re-creates the exact silence this change exists to end."
if grep -qE '^[[:space:]]*OnFailure=' "$ALERT_UNIT"; then
  refuse 6 "$ALERT_UNIT has grown an OnFailure= line. A failure handler that handles its own failure is an infinite alert loop — systemd would enqueue christina-alert@christina-alert@... forever. Remove it."
fi
ok "christina-alert@.service present and carries no OnFailure= of its own"
if ! "$PY" -c 'import sys,re
src=open(sys.argv[1]).read()
# The push is an inline python one-liner in ExecStart. A literal % there would be
# eaten by systemd as a specifier; catch it here rather than at 4am.
for ln in src.splitlines():
    if ln.startswith("ExecStart=") and "python3 -c" in ln and "%" in ln.split(" %i")[0]:
        sys.exit("ExecStart python payload contains a raw % (systemd specifier): " + ln[:80])
' "$ALERT_UNIT"; then
  refuse 6 "christina-alert@.service failed its self-check (see the line above)."
fi
ok "inline alert payload contains no unescaped systemd specifier"

NOTIFY_SET=0
if [ -n "$(env_get "$FW_ENV" NOTIFY_URL)" ]; then
  NOTIFY_SET=1; ok "NOTIFY_URL is set in $FW_ENV — failures will reach the phone"
else
  warn "NOTIFY_URL is NOT set in $FW_ENV. Failures will still be written to the"
  warn "journal and christina-alert@<unit> will go RED, but NO phone push will be"
  warn "sent. This is recorded in the summary below, not silently swallowed."
fi

# ------------------------------------------------------------- 3. install
say "3. Install"
if [ "$DRY" = "1" ]; then
  SKIPPED+=("EVERYTHING — --dry-run was passed. Validation above passed; re-run without --dry-run to install.")
else
  command -v systemctl >/dev/null 2>&1 || refuse 7 "systemctl not found — this box has no systemd, so the units cannot be installed here. Validation above still passed; run this ON THE PI."

  render_unit(){
    # Byte-identical rendering rules to deploy-realtime.sh:19-28, so a unit
    # installed by this script and one installed by that script agree.
    sed -e "s|^User=.*|User=${USER_NAME}|" \
        -e "s|/home/belkins/BirdNET-Pi|${REPO}|g" \
        -e "s|/home/belkins|${HOME}|g" \
        -e "s|/usr/bin/python3|${PY}|g" \
        "$1" | sudo tee "$2" >/dev/null
    sudo chmod 644 "$2"
  }

  mkdir -p "$ENV_DIR"
  if [ -f "$BK_ENV" ]; then
    SKIPPED+=("$BK_ENV — already exists, left untouched (idempotent). Its CHRISTINA_BACKUP_DEST was validated above.")
  else
    umask 077
    { echo "# Christina off-box backup config. Written by avian/backup/install-backup.sh."
      echo "# CHRISTINA_BACKUP_DEST must stay OFF the SD card; the installer and"
      echo "# offbox_backup.py:176-181 both refuse a destination on the repo's filesystem."
      echo "CHRISTINA_BACKUP_DEST=$DEST"
    } >"$BK_ENV"
    chmod 600 "$BK_ENV"
    INSTALLED+=("$BK_ENV (CHRISTINA_BACKUP_DEST=$DEST, mode 600)")
  fi

  render_unit "$ALERT_UNIT" /etc/systemd/system/christina-alert@.service
  INSTALLED+=("/etc/systemd/system/christina-alert@.service (OnFailure handler for every unit in this repo)")

  render_unit "$REPO/avian/backup/offbox-backup.service" /etc/systemd/system/offbox-backup.service
  INSTALLED+=("/etc/systemd/system/offbox-backup.service")

  sudo install -m 644 "$REPO/avian/backup/offbox-backup.timer" /etc/systemd/system/offbox-backup.timer
  INSTALLED+=("/etc/systemd/system/offbox-backup.timer")

  sudo systemctl daemon-reload
  sudo systemctl enable --now offbox-backup.timer >/dev/null
  INSTALLED+=("offbox-backup.timer ENABLED + STARTED (nightly 04:30 -> $DEST)")

  # Report what systemd actually thinks, not what we intended it to think.
  ok "timer state: $(systemctl is-enabled offbox-backup.timer 2>&1) / $(systemctl is-active offbox-backup.timer 2>&1)"
  systemctl list-timers offbox-backup.timer --no-pager 2>/dev/null | sed -n '2p' | sed 's/^/   next: /' || true
fi

# --------------------------------------------------------------- 4. summary
SKIPPED+=("the FIRST BACKUP — the timer fires at 04:30; nothing has left the box until it does. Force one now with: sudo systemctl start offbox-backup.service ; journalctl -u offbox-backup.service -n 40")
[ "$NOTIFY_SET" = "1" ] || SKIPPED+=("phone pushes — NOTIFY_URL is unset in $FW_ENV, so christina-alert@ will go RED instead of pushing.")
SKIPPED+=("OnFailure coverage for units this script does not own — deploy-realtime.sh / deploy-christina.sh install birdcast, forwarder, mic-watch, railway-liveness and catalog (NOT weekly_digest or avian-mqtt — see avian/NOT-INSTALLED). They now DECLARE OnFailure=christina-alert@%n.service, but they only get the handler when this script (or an updated deploy script) has installed christina-alert@.service. Re-run this script after any deploy.")

printf '\n\033[1;36m== Summary\033[0m\n'
printf '\033[32mINSTALLED (%d):\033[0m\n' "${#INSTALLED[@]}"
if [ "${#INSTALLED[@]}" -eq 0 ]; then printf '   (nothing)\n'; else for i in "${INSTALLED[@]}"; do printf '   + %s\n' "$i"; done; fi
printf '\033[33mNOT INSTALLED / STILL YOUR DECISION (%d):\033[0m\n' "${#SKIPPED[@]}"
for i in "${SKIPPED[@]}"; do printf '   - %s\n' "$i"; done
printf '\n'
