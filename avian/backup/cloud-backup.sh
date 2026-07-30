#!/usr/bin/env bash
# cloud-backup.sh — encrypted off-site backup of the whole station to object storage.
#
# WHY THIS EXISTS
# ---------------
# Every recording and every detection this station has produced lives on ONE SD
# card. README.md §2 already makes the argument ("a copy on the same card is not
# a backup: it survives nothing the original does") and then rules cloud out of
# scope: "this option needs code that does not exist yet. Do not pretend
# otherwise." This is that code.
#
# It also covers what offbox_backup.py does not. That file backs up birds.db, the
# two ledgers and the Railway plates, and asserts "everything else regenerates".
# The 4,396 mp3 in BirdSongs/Extracted/By_Date do NOT regenerate — they are
# microphone audio from one specific second of one specific day — and the string
# "By_Date" appears nowhere in it. Those recordings are the point of this file.
#
# THE ONE RULE: NOTHING IS EVER DELETED
# -------------------------------------
# This script uses `rclone copy`, NEVER `rclone sync`.
#   copy — adds and updates only. A file that disappears from the Pi REMAINS in
#          the cloud, forever. That is what an archive is.
#   sync — mirrors, which means it DELETES from the destination anything absent
#          from the source. One bad mount, one purge, one accident on the Pi and
#          the cloud faithfully reproduces the loss.
# There is no retention window, no --max-age, no prune. If you are editing this
# file and reaching for `sync`, stop.
#
# ENCRYPTION
# ----------
# Everything is written through an rclone `crypt` remote, so contents AND
# filenames are encrypted on the Pi before they leave it. The provider stores
# opaque blobs and can neither play the audio nor read the species names — which
# matters, because these are 15-second clips from a microphone in a residential
# garden and can capture human conversation.
#
# THE FAILURE MODE THAT MATTERS MOST
# ----------------------------------
# If the crypt passphrase exists ONLY on this SD card, this backup is worthless:
# the card dies, and the cloud holds 1.6 GB nothing can open. The passphrase must
# live in the operator's password manager. install-cloud-backup.sh refuses to
# install until that has been explicitly confirmed, because a backup that cannot
# be decrypted after the event it was built for is worse than none — it is a
# false sense of safety.
#
# EXIT CODES
#   0  complete and verified
#   2  REFUSED  — config missing/incomplete (nothing was uploaded)
#   3  REFUSED  — birds.db has FEWER detections than the last run (damage, not a backup)
#   4  FAULT    — a transfer failed
#   5  FAULT    — uploaded, but the round-trip verification did not prove it readable

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${CLOUD_BACKUP_ENV:-$HOME/.christina/cloud-backup.env}"
STATE="${CLOUD_BACKUP_STATE:-$HOME/.christina/cloud-backup.state}"
DB="${CHRISTINA_BIRDS_DB:-$REPO/scripts/birds.db}"
MEDIA_SRC="${CHRISTINA_MEDIA_DIR:-$HOME/BirdSongs/Extracted/By_Date}"
DRY="${DRY:-0}"

log()  { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
fail() { log "FAILED($2): $1"; exit "$2"; }

# --- config, fail-closed -----------------------------------------------------
# Every refusal names what is missing and states plainly that nothing was
# uploaded, so a half-configured install can never look like a working backup.
[ -f "$ENV_FILE" ] || fail "no config at $ENV_FILE -- NOTHING WAS UPLOADED. Run install-cloud-backup.sh." 2
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

: "${CHRISTINA_CLOUD_REMOTE:=}"
[ -n "$CHRISTINA_CLOUD_REMOTE" ] || fail "CHRISTINA_CLOUD_REMOTE unset in $ENV_FILE -- NOTHING WAS UPLOADED." 2
case "$CHRISTINA_CLOUD_REMOTE" in
  *REPLACE_ME*) fail "CHRISTINA_CLOUD_REMOTE is still the placeholder -- NOTHING WAS UPLOADED." 2 ;;
esac

command -v rclone  >/dev/null || fail "rclone is not installed -- NOTHING WAS UPLOADED." 2
command -v sqlite3 >/dev/null || fail "sqlite3 is not installed -- NOTHING WAS UPLOADED." 2
[ -f "$DB" ] || fail "birds.db not found at $DB -- NOTHING WAS UPLOADED." 2

# Refuse a remote that is not the crypt layer. Writing to the bare S3 remote
# would ship readable filenames and playable audio to the provider, silently
# undoing the entire encryption decision.
if ! rclone config show "${CHRISTINA_CLOUD_REMOTE%%:*}" 2>/dev/null | grep -q '^type = crypt'; then
  fail "$CHRISTINA_CLOUD_REMOTE is not a crypt remote. Refusing to upload UNENCRYPTED audio from a
     residential garden microphone. Point CHRISTINA_CLOUD_REMOTE at the crypt remote." 2
fi

RCLONE_FLAGS=(
  --fast-list                 # one bulk listing instead of per-directory: with ~8,800
                              # files this is the difference between a few hundred and
                              # a few thousand Class B operations per run.
  --transfers 4
  --checkers 8
  --s3-upload-concurrency 4   # stabilises large multipart uploads to R2
  --retries 3
  --low-level-retries 10
  --stats-one-line
  --stats 30s
)
[ -n "${CHRISTINA_CLOUD_BWLIMIT:-}" ] && RCLONE_FLAGS+=(--bwlimit "$CHRISTINA_CLOUD_BWLIMIT")
[ "$DRY" = "1" ] && RCLONE_FLAGS+=(--dry-run)

log "=== cloud backup -> $CHRISTINA_CLOUD_REMOTE ==="

# --- 1. a CONSISTENT birds.db snapshot ---------------------------------------
# .backup, not cp: birdnet_analysis writes to this database continuously and a
# plain copy can capture a torn page. Same reasoning as offbox_backup.py.
SNAP="$(mktemp -t birds-cloud-XXXXXX.db)"
trap 'rm -f "$SNAP" "$SNAP-journal" "$SNAP-wal" "$SNAP-shm" 2>/dev/null' EXIT
sqlite3 "$DB" ".backup '$SNAP'" || fail "sqlite .backup of birds.db" 4
[ "$(sqlite3 "$SNAP" 'PRAGMA integrity_check;' | head -1)" = "ok" ] \
  || fail "the birds.db snapshot failed integrity_check -- refusing to publish a corrupt database" 4
ROWS=$(sqlite3 "$SNAP" 'SELECT COUNT(*) FROM detections;')
log "birds.db snapshot: integrity ok, $ROWS detections"

# --- 2. append-only invariant ------------------------------------------------
# detections is append-only. FEWER rows than last time is evidence of damage
# upstream, not a fresher backup, and uploading it would overwrite a good copy
# with a worse one. Same check offbox_backup.py makes for the same reason.
PREV=0
[ -f "$STATE" ] && PREV=$(grep -oE '"detections":[0-9]+' "$STATE" 2>/dev/null | grep -oE '[0-9]+' || echo 0)
if [ "$ROWS" -lt "$PREV" ]; then
  fail "birds.db has $ROWS detections but the last upload had $PREV. The table is append-only, so a
     DROP is damage. NOTHING WAS UPLOADED; the previous cloud copy is untouched and still good." 3
fi
[ "$PREV" -gt 0 ] && log "append-only invariant holds ($PREV -> $ROWS)"

# --- 3. upload. copy, never sync. --------------------------------------------
copy_one() {  # $1=source  $2=remote subpath  $3=label  [$4..]=extra flags
  local src="$1" dst="$2" label="$3"; shift 3
  log "copying $label"
  rclone copy "$src" "${CHRISTINA_CLOUD_REMOTE%/}/$dst" "${RCLONE_FLAGS[@]}" "$@" 2>&1 \
    | sed 's/^/    /'
  local rc=${PIPESTATUS[0]}
  [ "$rc" -eq 0 ] || fail "rclone copy of $label exited $rc" 4
}

copy_one "$SNAP" "db/birds.db" "birds.db" --no-traverse
for f in accessions.json phenology.json species.json derived.json; do
  [ -f "$REPO/scripts/$f" ] && copy_one "$REPO/scripts/$f" "ledgers/$f" "ledger $f" --no-traverse
done
[ -d "$MEDIA_SRC" ] && copy_one "$MEDIA_SRC" "By_Date" "recordings + spectrograms"

# --- 4. prove it, rather than assume it --------------------------------------
# An rclone exit of 0 proves bytes moved. It does not prove they are readable,
# correctly encrypted, or the right bytes. Read the database back THROUGH the
# crypt layer and open it.
if [ "$DRY" != "1" ]; then
  BACK="$(mktemp -t birds-verify-XXXXXX.db)"
  trap 'rm -f "$SNAP" "$BACK" 2>/dev/null' EXIT
  if rclone cat "${CHRISTINA_CLOUD_REMOTE%/}/db/birds.db" > "$BACK" 2>/dev/null \
     && [ -s "$BACK" ]; then
    BACK_ROWS=$(sqlite3 "$BACK" 'SELECT COUNT(*) FROM detections;' 2>/dev/null || echo -1)
    if [ "$BACK_ROWS" != "$ROWS" ]; then
      fail "round-trip check FAILED: uploaded $ROWS detections, read back $BACK_ROWS.
     The upload reported success but the stored object is not the database we sent." 5
    fi
    log "round-trip verified: $BACK_ROWS detections read back through the crypt layer"
  else
    fail "could not read birds.db back from the remote -- the upload cannot be proven readable" 5
  fi

  printf '{"detections":%s,"at":"%s"}\n' "$ROWS" "$(date -Is)" > "$STATE"
fi

log "=== complete ==="
