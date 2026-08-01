#!/usr/bin/env bash
# plates-to-r2.sh — archive the volume-only Railway plates into R2, one shot.
#
# The durable nightly (offbox-backup.timer) is designed for an off-box MOUNT,
# and no such hardware exists yet — see avian/NOT-INSTALLED. Until it does,
# THIS is the mechanism protecting the ~40 volume-only species whose plates a
# volume loss would permanently repaint DIFFERENTLY. Run it on the Pi after any
# accession or repaint. Proven 2026-08-01: 78 plate files, sha256 round-trip
# verified through the crypt layer.
#
# Staging on the SD card is deliberate (CHRISTINA_BACKUP_ALLOW_SAME_DEVICE=1):
# the same-device refusal exists to stop an ARCHIVE living on the disk it
# protects; a mktemp staging dir that is rclone-copied off-box and deleted in
# the same run is not that failure.
set -euo pipefail
set -a
. "$HOME/.christina/cloud-backup.env"
. "$HOME/.christina/forwarder.env"
set +a
: "${CHRISTINA_CLOUD_REMOTE:?cloud-backup.env did not provide CHRISTINA_CLOUD_REMOTE}"
R="${CHRISTINA_CLOUD_REMOTE%/}"

STAGE=$(mktemp -d /tmp/plates-oneshot.XXXXXX)
trap 'rm -rf "$STAGE"' EXIT
export CHRISTINA_BACKUP_DEST="$STAGE" CHRISTINA_BACKUP_ALLOW_SAME_DEVICE=1

python3 "$(dirname "${BASH_SOURCE[0]}")/offbox_backup.py"

rclone copy "$STAGE" "$R/plates-oneshot/" --retries 3

# Round-trip through the crypt layer — the upload is not the proof, the read-back is.
A=$(basename "$(ls "$STAGE"/*.tar.gz | head -1)")
want=$(cut -d' ' -f1 "$STAGE/$A.sha256")
got=$(rclone cat "$R/plates-oneshot/$A" | sha256sum | cut -d' ' -f1)
[ "$want" = "$got" ] || { echo "plates-to-r2: ROUND-TRIP MISMATCH for $A -- the R2 copy is not the archive" >&2; exit 4; }
echo "plates-to-r2: $A uploaded and sha256-verified through the crypt layer"
