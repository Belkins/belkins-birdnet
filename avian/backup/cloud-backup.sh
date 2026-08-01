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

<<<<<<< HEAD
log()  { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
fail() { log "FAILED($2): $1"; exit "$2"; }

=======
# Indirection so a test can substitute a stub. This file is 300+ lines of shell
# holding the ONLY off-site copy of 4,396 irreplaceable recordings, and until
# 2026-08-01 it had zero tests -- every one of its six measured fail-opens was
# found in production, by hand, after the fact. `rclone` cannot be made to fail
# on demand; "$RCLONE" can. Everything below calls "$RCLONE", never rclone.
RCLONE="${RCLONE:-rclone}"

log()  { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
fail() { log "FAILED($2): $1"; exit "$2"; }

# Every `-lt`/`-gt` in this file must run against a validated integer. An empty
# or non-numeric operand makes `[` error out, and an errored comparison in an
# `if` reads as FALSE -- which is the guard passing. Line 183 already learned
# this for $ROWS; the counts 120 lines below had the same hole.
is_int() { case "${1:-}" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }

>>>>>>> origin/main
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

<<<<<<< HEAD
command -v rclone  >/dev/null || fail "rclone is not installed -- NOTHING WAS UPLOADED." 2
command -v sqlite3 >/dev/null || fail "sqlite3 is not installed -- NOTHING WAS UPLOADED." 2
=======
# A remote with NO COLON is not a remote at all -- rclone treats `r2crypt` as a
# LOCAL DIRECTORY, so one deleted character silently turns the off-site backup
# into a second copy on the very SD card it exists to survive, while the crypt
# guard and the round-trip verify both report success. Refuse it explicitly.
case "$CHRISTINA_CLOUD_REMOTE" in
  *:*) ;;
  *) fail "CHRISTINA_CLOUD_REMOTE ('$CHRISTINA_CLOUD_REMOTE') has no ':' -- rclone would treat it as a
     LOCAL PATH and write the 'off-site' backup onto this same SD card. NOTHING WAS UPLOADED." 2 ;;
esac

command -v "$RCLONE" >/dev/null || fail "rclone ('$RCLONE') is not installed -- NOTHING WAS UPLOADED." 2
command -v sqlite3 >/dev/null || fail "sqlite3 is not installed -- NOTHING WAS UPLOADED." 2
# shuf and sha256sum were UNDECLARED dependencies of the sampled read-back. With
# either missing, the sample loop drew nothing, `checked` stayed 0, and the run
# printed "no recordings in the remote yet to sample (seed still in progress)"
# and exited 0 -- a missing coreutil wearing the costume of an incomplete seed.
# Both ship with coreutils and are present on the Pi; name them anyway, because
# the way this file fails must never be by looking like something else.
command -v shuf      >/dev/null || fail "shuf is not installed -- the sampled read-back cannot draw
     objects to verify, and a verifier that samples nothing must not run. NOTHING WAS UPLOADED." 2
command -v sha256sum >/dev/null || fail "sha256sum is not installed -- the round-trip and sampled
     integrity checks both compare hashes and cannot run. NOTHING WAS UPLOADED." 2
>>>>>>> origin/main
[ -f "$DB" ] || fail "birds.db not found at $DB -- NOTHING WAS UPLOADED." 2

# Refuse a remote that is not the crypt layer. Writing to the bare S3 remote
# would ship readable filenames and playable audio to the provider, silently
# undoing the entire encryption decision.
<<<<<<< HEAD
if ! rclone config show "${CHRISTINA_CLOUD_REMOTE%%:*}" 2>/dev/null | grep -q '^type = crypt'; then
=======
if ! "$RCLONE" config show "${CHRISTINA_CLOUD_REMOTE%%:*}" 2>/dev/null | grep -q '^type = crypt'; then
>>>>>>> origin/main
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

<<<<<<< HEAD
=======
# --- transfer helpers, defined BEFORE any use ---------------------------------
# Hoisted here after a real fail-open on 2026-07-30: the media copy was moved
# above these definitions, so `copy_one` did not exist yet, the call returned
# 127 (command not found) with no `|| fail` at the CALL SITE to catch it, and
# the script printed "=== complete ===" and exited 0 having uploaded ZERO
# recordings. Defining them first makes that class impossible.
# A SINGLE FILE must use `copyto` (file -> file), NOT `copy`.
# `rclone copy SRC DEST` treats DEST as a DIRECTORY, so
#   rclone copy /tmp/birds-cloud-AbC123.db r2crypt:/db/birds.db
# creates a DIRECTORY called birds.db holding birds-cloud-AbC123.db -- and because
# the snapshot is a fresh mktemp name every run, each night added ANOTHER file to
# it. `rclone cat` on that path then concatenates them all. Caught 2026-07-30 when
# a downloaded birds.db was exactly 2x the live size with both halves identical.
# SQLite reads page_count from the header and ignores trailing bytes, so
# integrity_check and the row count BOTH passed on the doubled file -- which is
# why the round-trip check below now compares sha256, not just contents.
copyto_one() {  # $1=source FILE  $2=remote path  $3=label  [$4..]=extra flags
  local src="$1" dst="$2" label="$3"; shift 3
  log "copying $label"
  "$RCLONE" copyto "$src" "${CHRISTINA_CLOUD_REMOTE%/}/$dst" "${RCLONE_FLAGS[@]}" "$@" 2>&1 \
    | sed 's/^/    /'
  local rc=${PIPESTATUS[0]}
  [ "$rc" -eq 0 ] || fail "rclone copyto of $label exited $rc" 4
}

copy_one() {  # $1=source DIRECTORY  $2=remote subpath  $3=label  [$4..]=extra flags
  local src="$1" dst="$2" label="$3"; shift 3
  log "copying $label"
  "$RCLONE" copy "$src" "${CHRISTINA_CLOUD_REMOTE%/}/$dst" "${RCLONE_FLAGS[@]}" "$@" 2>&1 \
    | sed 's/^/    /'
  local rc=${PIPESTATUS[0]}
  [ "$rc" -eq 0 ] || fail "rclone copy of $label exited $rc" 4
}


>>>>>>> origin/main
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

<<<<<<< HEAD
# --- 2. append-only invariant ------------------------------------------------
# detections is append-only. FEWER rows than last time is evidence of damage
# upstream, not a fresher backup, and uploading it would overwrite a good copy
# with a worse one. Same check offbox_backup.py makes for the same reason.
PREV=0
[ -f "$STATE" ] && PREV=$(grep -oE '"detections":[0-9]+' "$STATE" 2>/dev/null | grep -oE '[0-9]+' || echo 0)
=======
# --- 2. THE RECORDINGS FIRST, and unconditionally --------------------------------
# Deliberately ABOVE the append-only gate. The recordings are independent of the
# database, and coupling them meant that on the one night birds.db was damaged --
# exactly the night an off-site copy matters most -- the 4,396 irreplaceable
# recordings were not uploaded either.
#
# And this is a REFUSAL, not a skip. The previous `[ -d "$MEDIA_SRC" ] &&` form
# meant a renamed or unmounted media directory produced "=== complete ===",
# exit 0, a green unit and zero recordings uploaded: a backup reporting success
# while backing up nothing, which is this project's signature failure.
[ -d "$MEDIA_SRC" ] || fail "media directory $MEDIA_SRC does not exist -- refusing to report success
     while backing up ZERO recordings. If the path moved, set CHRISTINA_MEDIA_DIR." 2
copy_one "$MEDIA_SRC" "By_Date" "recordings + spectrograms"

# --- 3. append-only invariant ------------------------------------------------
# detections is append-only. FEWER rows than last time is evidence of damage
# upstream, not a fresher backup, and uploading it would overwrite a good copy
# with a worse one. Same check offbox_backup.py makes for the same reason.
# Never compare a value you have not validated: a non-integer here would make
# every `-lt` comparison error out and the guard fail OPEN.
case "$ROWS" in ''|*[!0-9]*) fail "SELECT COUNT(*) returned a non-integer ('$ROWS') -- refusing to
     evaluate the damage guard against a value it cannot compare." 4 ;; esac

PREV=0
[ -f "$STATE" ] && PREV=$(grep -oE '"detections":[0-9]+' "$STATE" 2>/dev/null | grep -oE '[0-9]+' || echo 0)
case "$PREV" in ''|*[!0-9]*) PREV=0 ;; esac
>>>>>>> origin/main
if [ "$ROWS" -lt "$PREV" ]; then
  fail "birds.db has $ROWS detections but the last upload had $PREV. The table is append-only, so a
     DROP is damage. NOTHING WAS UPLOADED; the previous cloud copy is untouched and still good." 3
fi
<<<<<<< HEAD
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
=======
# Say so LOUDLY when the guard is inert. Silently skipping it meant a lost state
# file disabled the one check standing between a damaged database and the cloud,
# and printed nothing at all.
if [ "$PREV" -gt 0 ]; then
  log "append-only invariant holds ($PREV -> $ROWS)"
else
  log "NOTE: no previous detection count on record ($STATE absent or unreadable) --"
  log "      the append-only damage guard is INERT this run. It re-arms next run."
fi

# --- 3. upload. copy, never sync. --------------------------------------------
copyto_one "$SNAP" "db/birds.db" "birds.db" --no-traverse
for f in accessions.json phenology.json species.json derived.json; do
  [ -f "$REPO/scripts/$f" ] && copyto_one "$REPO/scripts/$f" "ledgers/$f" "ledger $f" --no-traverse
done
>>>>>>> origin/main

# --- 4. prove it, rather than assume it --------------------------------------
# An rclone exit of 0 proves bytes moved. It does not prove they are readable,
# correctly encrypted, or the right bytes. Read the database back THROUGH the
# crypt layer and open it.
if [ "$DRY" != "1" ]; then
  BACK="$(mktemp -t birds-verify-XXXXXX.db)"
<<<<<<< HEAD
  trap 'rm -f "$SNAP" "$BACK" 2>/dev/null' EXIT
  if rclone cat "${CHRISTINA_CLOUD_REMOTE%/}/db/birds.db" > "$BACK" 2>/dev/null \
=======
  _lsf_out="$(mktemp -t cloudlsf-XXXXXX)"
  _lsf_err="$(mktemp -t cloudlsferr-XXXXXX)"
  # A second `trap ... EXIT` REPLACES the first, it does not add to it. The
  # earlier form here listed only "$SNAP" "$BACK" and so silently dropped the
  # -journal/-wal/-shm cleanup the trap at the snapshot above installs -- every
  # run that got this far left sqlite sidecars in $TMPDIR.
  #
  # This is now the ONE authoritative trap for the whole verify section, and
  # every temp it covers is created immediately above it. Do not add a third
  # trap further down to pick up a new temp file -- that is precisely how the
  # sidecars got dropped. Create the file here, name it here.
  trap 'rm -f "$SNAP" "$SNAP-journal" "$SNAP-wal" "$SNAP-shm" \
              "$BACK" "$BACK-journal" "$BACK-wal" "$BACK-shm" \
              "$_lsf_out" "$_lsf_err" 2>/dev/null' EXIT
  if "$RCLONE" cat "${CHRISTINA_CLOUD_REMOTE%/}/db/birds.db" > "$BACK" 2>/dev/null \
>>>>>>> origin/main
     && [ -s "$BACK" ]; then
    BACK_ROWS=$(sqlite3 "$BACK" 'SELECT COUNT(*) FROM detections;' 2>/dev/null || echo -1)
    if [ "$BACK_ROWS" != "$ROWS" ]; then
      fail "round-trip check FAILED: uploaded $ROWS detections, read back $BACK_ROWS.
     The upload reported success but the stored object is not the database we sent." 5
    fi
<<<<<<< HEAD
    log "round-trip verified: $BACK_ROWS detections read back through the crypt layer"
=======
    # BYTE-EXACT, not just "sqlite could open it". SQLite ignores trailing bytes
    # beyond page_count, so a doubled or padded object passes integrity_check AND
    # the row count while being the wrong object. That exact failure happened on
    # 2026-07-30. Compare hashes.
    if [ "$(sha256sum "$SNAP" | cut -d" " -f1)" != "$(sha256sum "$BACK" | cut -d" " -f1)" ]; then
      fail "round-trip check FAILED: the object read back is not byte-identical to what was sent
     (row count matched, so this is a padding/duplication fault, not a data fault).
     Local $(stat -c %s "$SNAP") bytes vs retrieved $(stat -c %s "$BACK") bytes." 5
    fi
    log "round-trip verified: $BACK_ROWS detections, byte-identical (sha256) through the crypt layer"
>>>>>>> origin/main
  else
    fail "could not read birds.db back from the remote -- the upload cannot be proven readable" 5
  fi

<<<<<<< HEAD
  printf '{"detections":%s,"at":"%s"}\n' "$ROWS" "$(date -Is)" > "$STATE"
=======
  # --- SAMPLED READ-BACK OF THE RECORDINGS ---------------------------------
  # Until now the only thing ever verified was birds.db: 1.2 MB of a 1.56 GB
  # archive. The 4,396 recordings -- the part that genuinely cannot be
  # regenerated, being microphone audio from one specific second of one specific
  # day -- were uploaded and never once read back. An rclone exit of 0 proves
  # bytes left the box, not that they can be decrypted and returned intact.
  # Sample a handful each run: a few MB of egress (free on R2), no writes to the
  # station, nothing deleted, and over weeks it walks the whole archive.
  # THE ARCHIVE LISTING, TAKEN ONCE, WITH ITS EXIT STATUS CHECKED.
  #
  # This is the fix for the worst fail-open in this file. Three separate checks
  # below -- the sampled read-back, the path-collision scan and the completeness
  # count -- each ran `rclone lsf ... 2>/dev/null` in a command substitution and
  # read the result. A command substitution's exit status is discarded, and
  # 2>/dev/null threw away the reason, so a FAILED LISTING produced an empty
  # string, which every one of the three read as good news: "nothing to sample",
  # "no collisions", "no shortfall". The script printed "=== complete ===" and
  # exited 0 while structurally unable to see whether anything beyond
  # db/birds.db had survived.
  #
  # This is not hypothetical. install-cloud-backup.sh:100 already anticipates an
  # R2 token "scoped to object-level permissions" -- such a token permits
  # GetObject but NOT ListObjects. `rclone cat` keeps working, so the round-trip
  # check above still passes, and all three list-based checks go quietly green.
  #
  # Taken once rather than three times: --fast-list makes this one bulk listing,
  # and the archive is ~8,800 objects.
  if ! "$RCLONE" lsf "${CHRISTINA_CLOUD_REMOTE%/}/By_Date" \
        --recursive --files-only >"$_lsf_out" 2>"$_lsf_err"; then
    _rc=$?
    fail "could not LIST the remote archive (rclone lsf exited $_rc): $(head -3 "$_lsf_err" | tr '\n' ' ')
     Every integrity and completeness check below reads that listing, so this run
     is structurally unable to tell whether anything beyond db/birds.db is intact.
     An API token scoped to object-level permissions allows GetObject but not
     ListObjects -- 'rclone cat' still works, which is exactly why the round-trip
     check above passed. NOT a clean backup; treat the archive as unverified." 5
  fi
  REMOTE_N=$(wc -l < "$_lsf_out" | tr -d ' ')
  is_int "$REMOTE_N" || fail "remote object count is not a number ('$REMOTE_N') -- refusing to
     evaluate completeness against a value it cannot compare." 5

  SAMPLE_N="${CLOUD_BACKUP_SAMPLE:-5}"
  # Validate BEFORE comparing. `[ x -gt 0 ]` errors out and returns 2, the `if`
  # reads false, and the ENTIRE sampled read-back is skipped while the run still
  # exits 0 -- the same class this file already closed for $ROWS at line 183.
  is_int "$SAMPLE_N" || fail "CLOUD_BACKUP_SAMPLE is not a number ('$SAMPLE_N') -- refusing to
     silently skip the sampled read-back and report success anyway." 2
  if [ "$SAMPLE_N" -gt 0 ] && [ -d "$MEDIA_SRC" ]; then
    # Sample from what the REMOTE actually holds, not from what is on disk.
    # Drawing from local paths conflated two different things: "not uploaded yet"
    # (expected during an incomplete seed) and "uploaded but wrong" (a real
    # fault). The first produced a false RED alert at 29% complete on 2026-07-30.
    # INTEGRITY is what this check is for; COMPLETENESS is the count check below.
    log "sample-verifying $SAMPLE_N uploaded recordings by sha256 through the crypt layer"
    bad=0; checked=0; missing_local=0
    while IFS= read -r rel; do
      [ -z "$rel" ] && continue
      local_f="$MEDIA_SRC/$rel"
      # A file in R2 with no local counterpart is NOT an error: nothing is ever
      # deleted from the archive, so it legitimately outlives the station copy.
      [ -f "$local_f" ] || { missing_local=$((missing_local+1)); continue; }
      tmp="$(mktemp -t cloudverify-XXXXXX)"
      if "$RCLONE" cat "${CHRISTINA_CLOUD_REMOTE%/}/By_Date/$rel" > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
        checked=$((checked+1))
        if [ "$(sha256sum "$local_f" | cut -d" " -f1)" != "$(sha256sum "$tmp" | cut -d" " -f1)" ]; then
          bad=$((bad+1)); log "  MISMATCH: $rel"
        fi
      else
        bad=$((bad+1)); log "  LISTED BUT UNREADABLE: $rel"
      fi
      rm -f "$tmp"
    done <<< "$(grep '\.mp3$' "$_lsf_out" | shuf -n "$SAMPLE_N")"
    # $bad counts BOTH mismatches and listed-but-unreadable objects, and $checked
    # counts only the ones that read back, so the old "$bad of $((bad+checked))"
    # was right by accident for mismatches and wrong for unreadables. Report the
    # attempted total, which is what an operator at 2am needs.
    _attempted=$((bad + checked))
    [ "$bad" -eq 0 ] || fail "$bad of $_attempted sampled recordings were not byte-identical or
     could not be read back. The upload reported success; the stored objects are
     not what was sent." 5
    if [ "$checked" -gt 0 ]; then
      log "  $checked/$checked sampled recordings byte-identical${missing_local:+ ($missing_local archived-only, not an error)}"
    elif [ "$REMOTE_N" -gt 0 ]; then
      # The listing SUCCEEDED and says the archive holds objects, yet the sampler
      # examined none of them. That is not a seed in progress; that is a sampler
      # that has stopped working (every draw missing locally, a grep that matches
      # nothing, a shuf that returned nothing). Before this branch existed both
      # cases printed the same reassuring "seed still in progress".
      fail "the archive lists $REMOTE_N objects but NOT ONE was sample-verified
     ($missing_local of the draws had no local counterpart). A sampler that
     examines nothing must not report success." 5
    else
      log "  no recordings in the remote yet to sample (seed still in progress)"
    fi
  fi

  # COMPLETENESS, reported separately from integrity. During the initial seed the
  # remote is legitimately behind; once seeded, a shortfall is the signal.
  # RESTORABILITY, not just presence. An object store has no real directories, so
  # `rclone copy <file> remote:a/b` happily creates the KEY "a/b/<basename>" --
  # and then "a/b" exists as BOTH a file and a directory prefix, which no
  # filesystem can materialise. A restore of that path fails outright.
  #
  # This bit on 2026-07-30: db/birds.db and all four ledgers were simultaneously
  # file and directory, so the irreplaceable core was un-restorable while the
  # completeness line below reported green on every run of its life -- it counted
  # By_Date only. A verifier structurally unable to see the fault it exists to
  # catch is this project's signature bug. `rclone cat` still worked, which is
  # why the earlier recovery drill passed and missed it.
  for _p in db ledgers; do
    # rc CHECKED. `_dirs=$(rclone lsf ... 2>/dev/null)` read a failed listing as
    # an empty one, i.e. as "no collisions" -- so the check added BECAUSE the
    # irreplaceable core was un-restorable could itself be blinded by the same
    # token scope that hides everything else. A listing that did not happen is
    # not a clean result.
    _derr="$(mktemp -t clouddirs-XXXXXX)"
    if ! _dirs=$("$RCLONE" lsf --dirs-only "${CHRISTINA_CLOUD_REMOTE%/}/$_p" 2>"$_derr"); then
      _drc=$?
      rm -f "$_derr"
      fail "could not list $_p/ to check restorability (rclone lsf exited $_drc). The
     path-collision check exists because db/birds.db was once BOTH a file and a
     directory, making the archive's core un-restorable while every other check
     passed. It cannot run blind." 5
    fi
    rm -f "$_derr"
    _dirs=$(printf '%s' "$_dirs" | tr '\n' ' ')
    if [ -n "${_dirs// /}" ]; then
      fail "PATH COLLISION in $_p/: these names are both a file and a directory -- $_dirs
     No filesystem can restore that. Move the nested copies aside with
     'rclone moveto' (never delete) and re-run. The archive is NOT restorable
     until this is clear." 5
    fi
  done
  log "  restorability: db/ and ledgers/ hold files only, no path collisions"

  # COMPLETENESS. Until 2026-08-01 this whole check was:
  #
  #     [ "$REMOTE_N" -lt "$LOCAL_N" ] && log "  (seed still catching up ...)"
  #
  # A `log`, never a `fail`, in a file whose own fail() is used twenty times.
  # An archive permanently stuck at 29% reported green every night of its life.
  # The comment above it even said "COMPLETENESS is the count check below" --
  # the check was real, its teeth were not.
  #
  # The reason it was written as a log is real too, and the fix has to keep it:
  # during the initial seed the remote is LEGITIMATELY behind, and a bare fail
  # would red every night for a week. So the shortfall is only a fault once the
  # archive has been observed complete at least once. Two independent failures,
  # two exit codes:
  LOCAL_N=$(find "$MEDIA_SRC" -type f \( -name '*.mp3' -o -name '*.png' \) | wc -l | tr -d ' ')
  is_int "$LOCAL_N" || fail "local media count is not a number ('$LOCAL_N')." 5
  log "  completeness: $REMOTE_N/$LOCAL_N media objects in the archive"

  PREV_REMOTE=0; SEEDED=0; SEED_EPOCH=0
  if [ -f "$STATE" ]; then
    PREV_REMOTE=$(grep -oE '"remote_n":[0-9]+'   "$STATE" 2>/dev/null | grep -oE '[0-9]+' || echo 0)
    SEED_EPOCH=$(grep  -oE '"seed_epoch":[0-9]+' "$STATE" 2>/dev/null | grep -oE '[0-9]+' || echo 0)
    grep -q '"seeded":true' "$STATE" 2>/dev/null && SEEDED=1
  fi
  is_int "$PREV_REMOTE" || PREV_REMOTE=0
  is_int "$SEED_EPOCH"  || SEED_EPOCH=0
  NOW_EPOCH=$(date +%s)
  [ "$SEED_EPOCH" -eq 0 ] && SEED_EPOCH="$NOW_EPOCH"

  # (a) DAMAGE, unconditional and independent of the seed. Nothing is ever
  #     deleted from this archive -- cloud-backup uses `copy`, never `sync` --
  #     so the remote count going DOWN is the media-side twin of the append-only
  #     detections invariant enforced at line 189. It means objects were removed
  #     out from under us (a lifecycle rule, a console delete, a wrong prefix).
  if [ "$REMOTE_N" -lt "$PREV_REMOTE" ]; then
    fail "the archive has SHRUNK: $PREV_REMOTE objects last run, $REMOTE_N now.
     Nothing in this system ever deletes from the remote, so objects have been
     removed by something else. The local copy is still intact -- do NOT run
     again until you know what deleted them, or this run's listing becomes the
     new baseline and the loss becomes invisible." 3
  fi

  # (b) SHORTFALL, once the archive has ever been complete.
  if [ "$SEEDED" = "1" ] && [ "$REMOTE_N" -lt "$LOCAL_N" ]; then
    fail "the archive is INCOMPLETE: $REMOTE_N of $LOCAL_N media objects.
     This archive was observed complete on a previous run, so a shortfall now is
     a fault, not a seed. $((LOCAL_N - REMOTE_N)) recording(s) exist only on the
     SD card this backup exists to survive." 5
  fi

  # (c) A SEED THAT NEVER FINISHES. The 29%-forever case: legitimately behind on
  #     night one, still legitimately behind on night ninety, green throughout.
  _seed_days=$(( (NOW_EPOCH - SEED_EPOCH) / 86400 ))
  _seed_limit="${CLOUD_BACKUP_SEED_DAYS:-30}"
  is_int "$_seed_limit" || _seed_limit=30
  if [ "$SEEDED" = "0" ] && [ "$REMOTE_N" -lt "$LOCAL_N" ]; then
    if [ "$_seed_days" -ge "$_seed_limit" ]; then
      fail "the initial seed has not completed in $_seed_days days ($REMOTE_N/$LOCAL_N).
     A seed that has not finished in $_seed_limit days is not a seed in progress,
     it is a seed that is stuck. Raise CLOUD_BACKUP_SEED_DAYS only if you have
     checked WHY it is behind." 5
    fi
    log "  (seed still catching up, day $_seed_days of at most $_seed_limit --"
    log "   the next run resumes; nothing is re-uploaded)"
  fi

  # Latch `seeded` the first time the archive is observed whole. Once latched it
  # never unlatches: that is what turns (b) from advisory into a real check.
  if [ "$REMOTE_N" -ge "$LOCAL_N" ]; then
    [ "$SEEDED" = "1" ] || log "  archive observed COMPLETE for the first time -- the shortfall check is now armed"
    SEEDED=1
  fi

  printf '{"detections":%s,"remote_n":%s,"seeded":%s,"seed_epoch":%s,"at":"%s"}\n' \
    "$ROWS" "$REMOTE_N" "$([ "$SEEDED" = "1" ] && echo true || echo false)" \
    "$SEED_EPOCH" "$(date -Is 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%S%z)" > "$STATE"
>>>>>>> origin/main
fi

log "=== complete ==="
