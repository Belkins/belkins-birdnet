#!/usr/bin/env bash
# plates-to-r2.sh — archive the volume-only Railway plates into R2.
#
# The plates a Railway volume loss would permanently repaint DIFFERENTLY get
# staged by the proven offbox_backup.py downloader and copied through the crypt
# remote. Runs weekly via continuity-r2.timer once installed; run it by hand
# after any accession or repaint you want off-box tonight. First proven
# 2026-08-01: 78 plate files, sha256 round-trip verified through the crypt layer.
#
# Staging on the SD card is deliberate (CHRISTINA_BACKUP_ALLOW_SAME_DEVICE=1):
# the same-device refusal exists to stop an ARCHIVE living on the disk it
# protects; a mktemp staging dir that is rclone-copied off-box and deleted in
# the same run is not that failure.
#
# EXIT CODES — offbox_backup.py's own taxonomy, propagated honestly:
#   0  COMPLETE  archive built, uploaded, read back byte-identical
#   2  REFUSED   config missing / remote not crypt / offbox refused — NOTHING uploaded
#   3  DEGRADED  offbox built a REAL archive but flagged it. The archive is
#                STILL uploaded and verified, THEN 3 is propagated so the
#                unit's OnFailure alert fires with the copy already safe.
#                (Until 2026-08-01 `set -e` aborted on the 3 and the trap
#                deleted the staging dir — the flagged night was exactly the
#                night no copy left the box. Arsenal bias-lens finding #3.)
#   4  FAULT     nothing usable from offbox, or the R2 read-back mismatched
set -uo pipefail

ENV_FILE="${CLOUD_BACKUP_ENV:-$HOME/.christina/cloud-backup.env}"
FWD_FILE="${FORWARDER_ENV:-$HOME/.christina/forwarder.env}"
[ -f "$ENV_FILE" ] || { echo "plates-to-r2: no config at $ENV_FILE -- NOTHING UPLOADED" >&2; exit 2; }
set -a; . "$ENV_FILE"; set +a
if [ -f "$FWD_FILE" ]; then set -a; . "$FWD_FILE"; set +a
else echo "plates-to-r2: WARNING no $FWD_FILE -- offbox will run without AV_RAILWAY_BASE (DEGRADED per its contract)" >&2; fi

[ -n "${CHRISTINA_CLOUD_REMOTE:-}" ] || { echo "plates-to-r2: CHRISTINA_CLOUD_REMOTE unset -- NOTHING UPLOADED" >&2; exit 2; }
R="${CHRISTINA_CLOUD_REMOTE%/}"
# Refuse a non-crypt remote — same check cloud-backup.sh:95 makes, same reason.
rclone config show "${R%%:*}" 2>/dev/null | grep -q '^type = crypt' \
  || { echo "plates-to-r2: ${R%%:*} is not a crypt remote -- refusing to upload plates unencrypted" >&2; exit 2; }

sha() { python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"; }

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/plates-oneshot.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
export CHRISTINA_BACKUP_DEST="$STAGE" CHRISTINA_BACKUP_ALLOW_SAME_DEVICE=1

OFFBOX="${CHRISTINA_OFFBOX_SCRIPT:-$(dirname "${BASH_SOURCE[0]}")/offbox_backup.py}"
rc=0; python3 "$OFFBOX" || rc=$?
case "$rc" in
  0|3) : ;;  # archive exists and is usable (3 = flagged; upload FIRST, alert after)
  2)   echo "plates-to-r2: offbox REFUSED (2) -- nothing staged, nothing uploaded" >&2; exit 2 ;;
  *)   echo "plates-to-r2: offbox FAULT ($rc) -- no usable archive, nothing uploaded" >&2; exit 4 ;;
esac

A=""
for f in "$STAGE"/*.tar.gz; do [ -f "$f" ] && A="$f" && break; done
[ -n "$A" ] || { echo "plates-to-r2: offbox exited $rc but no archive exists in staging -- FAULT" >&2; exit 4; }

rclone copy "$STAGE" "$R/plates-oneshot/" --retries 3 \
  || { echo "plates-to-r2: rclone copy failed -- the archive did NOT leave the box" >&2; exit 4; }

# Round-trip through the crypt layer — the upload is not the proof, the read-back is.
A_BASE=$(basename "$A")
want=$(cut -d' ' -f1 "$A.sha256")
got=$(rclone cat "$R/plates-oneshot/$A_BASE" | python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())')
[ "$want" = "$got" ] || { echo "plates-to-r2: ROUND-TRIP MISMATCH for $A_BASE -- the R2 copy is not the archive" >&2; exit 4; }

if [ "$rc" = "3" ]; then
  echo "plates-to-r2: DEGRADED -- $A_BASE uploaded and sha256-verified, but offbox flagged this run (exit 3). The copy is safe; the flag still needs eyes." >&2
else
  echo "plates-to-r2: $A_BASE uploaded and sha256-verified through the crypt layer"
fi
exit "$rc"
