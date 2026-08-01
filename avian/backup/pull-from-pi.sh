#!/usr/bin/env bash
# pull-from-pi.sh — README §2 Option 3, implemented.
#
# WHY THIS FILE EXISTS
# --------------------
# README §2 lists "pull instead of push" as a legitimate option and then admits:
# "This repo has no unit for it." That gap is why the only off-box copy of this
# station's data was 1.1 MB of ledgers, 13 hours stale, taken by hand.
#
# It also closes a scope hole in offbox_backup.py. That file's docstring calls
# itself a backup of "the ONLY irreplaceable state this project owns" and lists
# birds.db + the two ledgers + the Railway plates, asserting "everything else
# regenerates". The 4,396 mp3 recordings in BirdSongs/Extracted/By_Date do NOT
# regenerate — they are microphone audio from a specific second of a specific
# day — and the string "By_Date" appears nowhere in offbox_backup.py or
# install-backup.sh. This script covers them.
#
# WHY PULL RATHER THAN PUSH
# -------------------------
# The push path needs CHRISTINA_BACKUP_DEST: a writable directory on a different
# filesystem from the SD card. On this station that means buying a USB SSD, a NAS
# or cloud storage. Pulling needs none of that, and has a real security property:
# the Pi holds no credentials and no mount, so a compromised Pi cannot reach into
# the backups.
#
# THE ONE RULE
# ------------
# NOTHING IS EVER DELETED. There is no --delete, no purge, no retention window.
# rsync only adds and updates. If a file vanishes from the Pi it REMAINS here —
# that is the entire point of an archive, and it is the operator's stated
# requirement. The recordings and the detection ledger are the record; the card
# is just where they happen to be written first.
#
# WHAT IT REFUSES TO DO
# ---------------------
# It will not overwrite a good birds.db with a worse one. detections is an
# append-only table, so a copy with FEWER rows than the copy already held is
# evidence of damage upstream, not a fresher backup — the same reasoning as
# offbox_backup.py's "detections DROPPED" check. On that, it keeps the old copy,
# writes the new one aside as birds.db.SUSPECT, and exits non-zero.
#
# USAGE
#   ./pull-from-pi.sh                 # pull into the default archive dir
#   DEST=/path/to/archive ./pull-from-pi.sh
#   DRY=1 ./pull-from-pi.sh           # show what would transfer, change nothing
#
# EXIT CODES
#   0  complete
#   1  the Pi was unreachable, or a transfer failed
#   2  birds.db snapshot failed or failed its integrity check
#   3  REFUSED: the incoming birds.db has fewer detections than the copy held

set -uo pipefail

PI_HOST="${PI_HOST:-192.168.1.236}"
PI_USER="${PI_USER:-belkins}"
PI_KEY="${PI_KEY:-$HOME/.ssh/christina_pi}"
DEST="${DEST:-$HOME/Desktop/christina-backups/station}"
SSH_OPTS=(-o ConnectTimeout=20 -i "$PI_KEY" -o IdentitiesOnly=yes)
DRY="${DRY:-0}"

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { log "FAILED: $*"; exit "${2:-1}"; }

mkdir -p "$DEST"/{ledgers,recordings,spectrograms}
LOG="$DEST/pull.log"
exec > >(tee -a "$LOG") 2>&1

log "=== pull from ${PI_USER}@${PI_HOST} -> $DEST ==="

ssh "${SSH_OPTS[@]}" "${PI_USER}@${PI_HOST}" true 2>/dev/null \
  || die "the Pi is unreachable (ssh)" 1

# --- 1. birds.db, via the SQLite ONLINE-BACKUP API ---------------------------
# Never `cp` a live SQLite file: birdnet_analysis writes to it continuously and a
# plain copy can capture a torn page. `.backup` takes a consistent snapshot of a
# database that is being written.
log "snapshotting birds.db (online-backup API)"
ssh "${SSH_OPTS[@]}" "${PI_USER}@${PI_HOST}" \
  'rm -f /tmp/birds-pull.db && sqlite3 ~/BirdNET-Pi/scripts/birds.db ".backup /tmp/birds-pull.db"' \
  || die "sqlite .backup on the Pi" 2

INTEG=$(ssh "${SSH_OPTS[@]}" "${PI_USER}@${PI_HOST}" 'sqlite3 /tmp/birds-pull.db "PRAGMA integrity_check;" | head -1')
[ "$INTEG" = "ok" ] || die "snapshot failed integrity_check: $INTEG" 2

NEW_ROWS=$(ssh "${SSH_OPTS[@]}" "${PI_USER}@${PI_HOST}" 'sqlite3 /tmp/birds-pull.db "SELECT COUNT(*) FROM detections;"')
log "  snapshot: integrity ok, $NEW_ROWS detections"

if [ "$DRY" = "1" ]; then
  log "DRY: would pull birds.db ($NEW_ROWS rows) and mirror media; nothing written"
else
  scp -q "${SSH_OPTS[@]}" "${PI_USER}@${PI_HOST}:/tmp/birds-pull.db" "$DEST/birds.db.incoming" \
    || die "pulling birds.db" 1

  # Append-only invariant: a DROP is damage, not a fresher backup.
  if [ -f "$DEST/birds.db" ]; then
    OLD_ROWS=$(sqlite3 "$DEST/birds.db" "SELECT COUNT(*) FROM detections;" 2>/dev/null || echo 0)
    if [ "$NEW_ROWS" -lt "$OLD_ROWS" ]; then
      mv "$DEST/birds.db.incoming" "$DEST/birds.db.SUSPECT"
      die "incoming birds.db has $NEW_ROWS detections but the held copy has $OLD_ROWS.
     The table is append-only, so this is evidence of damage upstream.
     KEPT the existing copy; wrote the incoming one to birds.db.SUSPECT." 3
    fi
    log "  rows $OLD_ROWS -> $NEW_ROWS (append-only invariant holds)"
  fi
  mv "$DEST/birds.db.incoming" "$DEST/birds.db"
fi

# --- 2. the ledgers ----------------------------------------------------------
for f in accessions.json phenology.json species.json derived.json; do
  scp -q "${SSH_OPTS[@]}" "${PI_USER}@${PI_HOST}:BirdNET-Pi/scripts/$f" "$DEST/ledgers/$f" 2>/dev/null \
    && log "  ledger $f" || log "  ledger $f (absent on the box — not an error)"
done

# --- 3. the media --------------------------------------------------------------
# NO --delete, deliberately and permanently. See THE ONE RULE above.
# --stats, NOT --info=stats2: macOS ships rsync 2.6.9, which predates the
# --info flag entirely and exits with "unrecognized option" — silently, if the
# caller pipes it to grep. --stats works on both 2.6.9 and 3.x.
RSYNC_FLAGS=(-a --partial --stats)
# In DRY mode add -i (itemize) and count its lines instead of trusting --stats.
# macOS openrsync reports "Number of files transferred: 0" under --dry-run even
# when it would send thousands (verified: stats said 0, -i listed 4396). A dry
# run that reports zero work is worse than no dry run at all.
[ "$DRY" = "1" ] && RSYNC_FLAGS+=(--dry-run -i)

mirror() {  # $1=label  $2=glob  $3=subdir
  log "mirroring $1 — additive only (no --delete)"
  local out
  out=$(rsync "${RSYNC_FLAGS[@]}" --include='*/' --include="$2" --exclude='*' \
        -e "ssh ${SSH_OPTS[*]}" \
        "${PI_USER}@${PI_HOST}:BirdSongs/Extracted/By_Date/" "$DEST/$3/" 2>&1) \
    || { log "  rsync failed for $1"; return 1; }
  if [ "$DRY" = "1" ]; then
    # Count into a variable, NOT via `xargs -I{} log ...`: xargs cannot see shell
    # functions and would run macOS's /usr/bin/log instead of this script's.
    local n
    n=$(printf '%s\n' "$out" | grep -c "${2#\*}\$" || true)
    log "  DRY: would transfer $n $1"
  else
    printf '%s\n' "$out" | grep -E 'Number of files transferred|Total transferred file size' \
      | sed 's/^/    /' || true
  fi
}

mirror "recordings (mp3)" '*.mp3' recordings || die "mirroring recordings" 1

mirror "spectrograms (png)" '*.png' spectrograms || die "mirroring spectrograms" 1

# --- 4. prove it, rather than assume it --------------------------------------
if [ "$DRY" != "1" ]; then
  L_MP3=$(find "$DEST/recordings" -name '*.mp3' | wc -l | tr -d ' ')
  R_MP3=$(ssh "${SSH_OPTS[@]}" "${PI_USER}@${PI_HOST}" 'find ~/BirdSongs/Extracted/By_Date -name "*.mp3" | wc -l' | tr -d ' ')
  L_DB=$(sqlite3 "$DEST/birds.db" "SELECT COUNT(*) FROM detections;" 2>/dev/null || echo "?")
  log "VERIFY  mp3 here=$L_MP3 on-Pi=$R_MP3   birds.db detections=$L_DB"
  # The archive may legitimately hold MORE than the Pi (nothing is ever deleted
  # here, and the station may purge one day). Fewer is the failure.
  if [ "$L_MP3" -lt "$R_MP3" ]; then
    die "the archive holds FEWER recordings than the Pi ($L_MP3 < $R_MP3) — transfer incomplete" 1
  fi
  log "  archive size: $(du -sh "$DEST" | cut -f1)"
fi

log "=== complete ==="
