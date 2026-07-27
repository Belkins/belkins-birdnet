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
