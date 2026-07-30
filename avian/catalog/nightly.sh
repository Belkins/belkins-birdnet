#!/usr/bin/env bash
# nightly.sh — the catalog unit's ONE ExecStart. Runs BOTH nightly steps, always,
# then reports an aggregate failure.
#
# WHY THIS EXISTS (regression found by QA on 2026-07-27, introduced 2026-07-26):
# catalog.service used to carry two un-prefixed ExecStart lines, rebuild_catalog.py
# then derive.py. systemd.service(5): "If any of those commands (not prefixed with
# -) fail, the rest are not executed." Verified empirically on this Pi with a
# throwaway unit: a first step exiting 3 means the second NEVER runs.
#
# That interacted disastrously with the exit-3 "degraded catalog" signal added the
# same day: a single slow/blipping Railway manifest fetch would make
# rebuild_catalog.py exit 3, which SKIPPED derive.py, which froze derived.json —
# the exact 24-day silent-staleness incident that whole change set was written to
# eliminate. The loud signal was silently disabling the thing it was protecting.
#
# The two steps are genuinely independent: derive.py reads birds.db only (never
# christina.db), so neither needs the other to have succeeded. They must BOTH run
# every night, and the unit must still go red if either is unhappy.
#
# Exit codes are preserved rather than collapsed, so the journal names the fault:
#   0  all three fine
#   3  catalog published but DEGRADED (manifest unanswered / zero slugs)
#   4  derive failed (companion metrics are now going stale)
#   5  phenology ledger failed (the year-over-year archive is NOT advancing)
#   7  catalog AND derive both failed
# Any other non-zero from a step is passed through as-is when it is the only fault.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="${CHRISTINA_PYTHON:-/usr/bin/python3}"

rc_cat=0
"$PY" "$HERE/rebuild_catalog.py" "$@" || rc_cat=$?

# UNCONDITIONAL. Never guard this on rc_cat -- that is the bug this file exists
# to prevent. A degraded catalog is still a published catalog, and the companion
# metrics must keep tracking birds.db regardless.
rc_der=0
"$PY" "$HERE/derive.py" || rc_der=$?

# UNCONDITIONAL, for the same reason as derive. The phenology ledger FREEZES the
# per-year first/last/days/peak-week BEFORE the purge removes the rows behind
# them. Unlike christina.db and derived.json -- both rebuilt wholesale every
# night -- this one cannot be recomputed later: a night it does not run is a
# night of history that no future run can recover.
rc_phen=0
"$PY" "$HERE/phenology.py" || rc_phen=$?

# BEST-EFFORT, AND DELIBERATELY EXCLUDED FROM THE EXIT CODE.
# Builds .webp siblings for the cutout plates (93.3% of a measured wall load was
# full-size PNG). This must never make the unit red, because cutout.php only
# serves a variant whose mtime is >= its plate's: if this step is missing, stale
# or failing, the PNG is served instead, which is completely correct — just
# heavier. Adding it to the rc_* chain would let an image optimisation mask a
# real catalog or phenology fault, which is the exact class of bug the header of
# this file exists to prevent. Errors go to the journal and nowhere else.
# nice/ionice because this unit fires at 03:30 and the DAWN CHORUS is this
# station's busiest hour (measured 2026-07-30: 43 detections in the 04:00 hour, 84
# in 06:00, against 1 in 12:00). webp encoding is single-core CPU-bound and
# saturates that core; the detector must always win the tie. Measured during the
# first full run: load 1.20 of 4 cores with the analyser still logging 36
# inference lines a minute, so this is belt-and-braces rather than a fix.
# BOTH tiers that can serve a plate need variants, or a species whose art comes
# from the bundled set silently keeps shipping full-size PNG. cutout.php checks
# assets/illustrations BEFORE the dynamic cache, and the two Holarctic species
# this UK station hears (e.g. anas-crecca) resolve there, not in the cache.
# The bundled dir is static, so its 500 plates are built once and skipped every
# night after; the cache dir is where new art actually lands.
nice -n 19 ionice -c 3 "$PY" "$HERE/webp_variants.py" \
        "$HOME/BirdSongs/Extracted/cutouts" \
        "$HERE/../assets/illustrations" >/dev/null 2>&1 \
    || echo "nightly: webp_variants step failed -- plates will serve as PNG (not a fault)" >&2

if [ "$rc_cat" -ne 0 ] && [ "$rc_der" -ne 0 ]; then
    echo "nightly: BOTH steps failed (catalog rc=$rc_cat, derive rc=$rc_der, phenology rc=$rc_phen)" >&2
    exit 7
fi
if [ "$rc_cat" -ne 0 ]; then
    echo "nightly: catalog step rc=$rc_cat (derive rc=$rc_der, phenology rc=$rc_phen)" >&2
    exit "$rc_cat"
fi
if [ "$rc_der" -ne 0 ]; then
    echo "nightly: derive step rc=$rc_der -- companion surfaces (/lab, rarity, first-of-year) will go STALE" >&2
    exit "$rc_der"
fi
# LAST and lowest priority, so every pre-existing exit code for every
# pre-existing fault is unchanged. NB: nothing on this box watches
# catalog.service, so a persistently red unit is only visible in
# `systemctl --failed` / journalctl -- see avian/catalog/README.md.
if [ "$rc_phen" -ne 0 ]; then
    echo "nightly: phenology step rc=$rc_phen -- the per-year ledger is NOT advancing; any year whose rows are purged before this is fixed is lost" >&2
    exit "$rc_phen"
fi
exit 0
