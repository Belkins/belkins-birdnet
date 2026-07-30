#!/usr/bin/env bash
# PULL THE IRREPLACEABLE DATA OFF THE BOX — one command, from the operator's Mac.
#
# WHY THIS EXISTS, AND WHAT IT IS NOT.
# The nightly job (avian/backup/) writes to CHRISTINA_BACKUP_DEST, which is
# currently a directory on the Pi's own SD card. That is a deliberate operator
# decision and it is genuinely useful: it protects against an accidental delete,
# a nightly rebuild that corrupts a ledger, or a truncated write. It does NOT
# protect against the card itself failing, which is how a Pi running 24/7 usually
# dies. THIS script is the other half — it pulls the same three files to a
# machine that is not the Pi.
#
# It is deliberately a PULL, run by hand or from the Mac's own scheduler, not a
# push from the Pi. The Pi then needs no credentials to anywhere, and a compromise
# of the box cannot reach the backups.
#
#   tools/pull-backup.sh                 # -> ~/Desktop/christina-backups/YYYY-MM-DD
#   DEST=/Volumes/Archive tools/pull-backup.sh
#   KEEP=30 tools/pull-backup.sh         # how many dated copies to retain (default 14)
#
# Exit codes:  0 ok · 2 the box is unreachable · 3 a file failed to copy
#              4 THE COPY LOOKS WRONG — smaller than the last one, or unreadable
set -euo pipefail

HOST="${HOST:-belkins@birdnet.local}"
KEY="${KEY:-$HOME/.ssh/christina_pi}"
REMOTE="${REMOTE:-BirdNET-Pi/scripts}"
DEST="${DEST:-$HOME/Desktop/christina-backups}"
KEEP="${KEEP:-14}"
STAMP="$(date +%Y-%m-%d)"
OUT="$DEST/$STAMP"

say() { printf '  %s\n' "$*"; }
die() { printf 'pull-backup: %s\n' "$1" >&2; exit "${2:-1}"; }

command -v ssh >/dev/null || die "ssh not found" 2
ssh -o ConnectTimeout=8 -o BatchMode=yes -i "$KEY" "$HOST" true 2>/dev/null \
  || die "cannot reach $HOST — is the Pi on this network?" 2

mkdir -p "$OUT"
echo "pulling from $HOST -> $OUT"

# birds.db is the only irreplaceable one; the ledgers are cheap and small but
# phenology.json CANNOT be recomputed for a closed year, so it travels too.
for f in birds.db accessions.json phenology.json; do
  if scp -q -i "$KEY" "$HOST:$REMOTE/$f" "$OUT/" 2>/dev/null; then
    say "✓ $f  ($(du -h "$OUT/$f" | cut -f1))"
  else
    # A missing ledger is not fatal — phenology.json does not exist on a station
    # that has never run the nightly. A missing birds.db is.
    [ "$f" = "birds.db" ] && die "birds.db did not copy" 3
    say "· $f absent on the box (not fatal)"
  fi
done

# ── THE CHECK THAT MAKES THIS A BACKUP AND NOT A RITUAL ──────────────────────
# A copy that silently truncates is worse than no copy, because it looks like
# safety. Prove the database opens, count its rows, and refuse to call the run a
# success if it holds FEWER detections than the previous copy — detections are
# only ever appended, so a shrink means corruption, a wrong source, or a partial
# read of a file being written.
ROWS="$(python3 - "$OUT/birds.db" <<'PY'
import sqlite3, sys
try:
    c = sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True)
    print(c.execute("select count(*) from detections").fetchone()[0])
except Exception as e:
    print("ERR:%s" % e)
PY
)"
case "$ROWS" in
  ERR:*) die "the copied birds.db will not open — ${ROWS#ERR:}" 4 ;;
  ''|*[!0-9]*) die "could not count detections in the copy" 4 ;;
esac
say "✓ birds.db opens · $ROWS detections"

PREV="$(find "$DEST" -maxdepth 1 -type d -name '20*' ! -name "$STAMP" 2>/dev/null | sort | tail -1)"
if [ -n "$PREV" ] && [ -f "$PREV/birds.db" ]; then
  PREV_ROWS="$(python3 - "$PREV/birds.db" <<'PY'
import sqlite3, sys
try:
    c = sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True)
    print(c.execute("select count(*) from detections").fetchone()[0])
except Exception:
    print(0)
PY
)"
  if [ "$ROWS" -lt "$PREV_ROWS" ]; then
    die "THE COPY SHRANK: $ROWS detections against $PREV_ROWS in $(basename "$PREV"). Detections are append-only, so this copy is corrupt, partial, or from the wrong source. Keeping it, refusing to call it good." 4
  fi
  say "✓ grew by $((ROWS - PREV_ROWS)) since $(basename "$PREV")"
fi

# prune, newest KEEP kept
find "$DEST" -maxdepth 1 -type d -name '20*' | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do
  rm -rf "$old" && say "· pruned $(basename "$old")"
done

echo "ok — $OUT"
