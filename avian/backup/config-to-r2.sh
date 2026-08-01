#!/usr/bin/env bash
# config-to-r2.sh — the station's IDENTITY into R2, freshly, every week.
#
# R2's config/ prefix was first populated by one-shot hand commands on
# 2026-08-01 and nothing re-uploaded it — so a rebuild months later would
# restore THAT day's CADDY_PWD, STATION_OPEN posture and Caddyfile, not the
# live ones (arsenal future-lens finding #1; both values have already changed
# in this project's history). This script makes the prefix track the box.
#
# Uploads (the identity set — count is computed up front and PINNED):
#   birdnet.conf              -> config/birdnet.conf      (STATION_OPEN, CADDY_PWD, mic, lat/lon)
#   /etc/caddy/Caddyfile      -> config/Caddyfile.live    (the file no generator can reproduce)
#   ~/.config/rclone/rclone.conf -> config/rclone.conf
#   ~/.christina/*.env        -> config/christina/<name>  (derived glob, must be non-empty)
#
# EXIT CODES: 0 all uploaded + read back byte-identical · 2 REFUSED (a fixed
# identity file missing, remote not crypt, or zero env files — NOTHING uploaded)
# · 4 FAULT (an upload or read-back failed after refusals passed)
set -uo pipefail

ENV_FILE="${CLOUD_BACKUP_ENV:-$HOME/.christina/cloud-backup.env}"
[ -f "$ENV_FILE" ] || { echo "config-to-r2: no config at $ENV_FILE -- NOTHING UPLOADED" >&2; exit 2; }
set -a; . "$ENV_FILE"; set +a
[ -n "${CHRISTINA_CLOUD_REMOTE:-}" ] || { echo "config-to-r2: CHRISTINA_CLOUD_REMOTE unset -- NOTHING UPLOADED" >&2; exit 2; }
R="${CHRISTINA_CLOUD_REMOTE%/}"
rclone config show "${R%%:*}" 2>/dev/null | grep -q '^type = crypt' \
  || { echo "config-to-r2: ${R%%:*} is not a crypt remote -- refusing to upload credentials unencrypted" >&2; exit 2; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIRDNET_CONF="${CHRISTINA_BIRDNET_CONF:-$REPO/birdnet.conf}"
CADDYFILE="${CHRISTINA_CADDYFILE:-/etc/caddy/Caddyfile}"
RCLONE_CONF="${CHRISTINA_RCLONE_CONF:-$HOME/.config/rclone/rclone.conf}"
ENV_DIR="${CHRISTINA_ENV_DIR:-$HOME/.christina}"

# Refuse BEFORE the first upload: a partial identity set restored later is a
# subtler failure than no set at all.
for f in "$BIRDNET_CONF" "$CADDYFILE" "$RCLONE_CONF"; do
  [ -f "$f" ] || { echo "config-to-r2: identity file MISSING: $f -- NOTHING UPLOADED" >&2; exit 2; }
done
n_env=0
for f in "$ENV_DIR"/*.env; do [ -f "$f" ] && n_env=$((n_env+1)); done
[ "$n_env" -ge 1 ] || { echo "config-to-r2: zero *.env files in $ENV_DIR -- the derived set is EMPTY, refusing (an empty glob passing green is the fail-open class)" >&2; exit 2; }
expected=$((3 + n_env))

sha() { python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"; }
put() { # put <src> <dst-key>  — upload + immediate read-back compare
  rclone copyto "$1" "$R/$2" --retries 3 \
    || { echo "config-to-r2: upload FAILED for $2" >&2; exit 4; }
  local want got
  want=$(sha "$1")
  got=$(rclone cat "$R/$2" | python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())')
  [ "$want" = "$got" ] || { echo "config-to-r2: ROUND-TRIP MISMATCH for $2" >&2; exit 4; }
  uploaded=$((uploaded+1))
}

uploaded=0
put "$BIRDNET_CONF" "config/birdnet.conf"
put "$CADDYFILE"    "config/Caddyfile.live"
put "$RCLONE_CONF"  "config/rclone.conf"
for f in "$ENV_DIR"/*.env; do [ -f "$f" ] && put "$f" "config/christina/$(basename "$f")"; done

# The pinned count: every file the derivation found must have been uploaded and
# verified — a silent skip may not pass.
[ "$uploaded" -eq "$expected" ] \
  || { echo "config-to-r2: uploaded $uploaded of $expected expected files -- FAULT" >&2; exit 4; }
echo "config-to-r2: $uploaded/$expected identity files uploaded and sha256-verified through the crypt layer"
