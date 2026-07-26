#!/usr/bin/env bash
# backup-accessions.sh — rotate a snapshot of the accession ledger.
#
# scripts/accessions.json is the ONLY irreplaceable file the catalog owns: the
# append-only ledger ("first writer wins, an already-present pin is NEVER
# overwritten") that assigns each species its permanent plate number. birds.db
# is backed up by BirdNET-Pi itself; christina.db, species.json and derived.json
# all regenerate from it. The ledger does not — lose it and every accession
# number in the collection is reassigned on the next rebuild.
#
# Runs as ExecStartPre of catalog.service, i.e. immediately BEFORE the nightly
# rebuild that is the only thing which ever writes it. Keeps N dated copies.
#
# Deliberately cannot fail the unit: a backup problem must not stop the catalog
# from publishing. It is loud on stderr instead, and `-` in the unit is NOT used
# here — ExecStartPre failure would block the rebuild, which is the wrong trade.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
LEDGER="${CHRISTINA_ACCESSIONS:-$REPO/scripts/accessions.json}"
DEST="${CHRISTINA_ACCESSIONS_BACKUP:-$REPO/scripts/accessions-backups}"
KEEP="${CHRISTINA_ACCESSIONS_KEEP:-14}"

if [ ! -s "$LEDGER" ]; then
  # Nothing to protect yet (fresh install, before the first confident species).
  echo "backup-accessions: no ledger at $LEDGER yet — nothing to back up" >&2
  exit 0
fi

mkdir -p "$DEST" 2>/dev/null || {
  echo "backup-accessions: cannot create $DEST — LEDGER IS UNPROTECTED" >&2
  exit 0
}

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/accessions-$STAMP.json"

# Only snapshot if the content actually changed since the newest backup —
# otherwise a nightly timer fills the dir with 14 identical files and the
# retention window silently shrinks to 14 days of *no* change.
NEWEST="$(ls -1t "$DEST"/accessions-*.json 2>/dev/null | head -n1)"
if [ -n "$NEWEST" ] && cmp -s "$LEDGER" "$NEWEST"; then
  exit 0
fi

if cp "$LEDGER" "$OUT.tmp" 2>/dev/null && mv "$OUT.tmp" "$OUT" 2>/dev/null; then
  echo "backup-accessions: snapshot -> $OUT" >&2
else
  rm -f "$OUT.tmp" 2>/dev/null
  echo "backup-accessions: FAILED to write $OUT — LEDGER IS UNPROTECTED" >&2
  exit 0
fi

# Rotate: keep the newest $KEEP. Never touch anything but our own pattern.
ls -1t "$DEST"/accessions-*.json 2>/dev/null | tail -n "+$((KEEP + 1))" | while IFS= read -r old; do
  rm -f "$old"
done

exit 0
