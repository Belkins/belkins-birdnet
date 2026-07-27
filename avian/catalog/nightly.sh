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
#   0  both fine
#   3  catalog published but DEGRADED (manifest unanswered / zero slugs)
#   4  derive failed (companion metrics are now going stale)
#   7  both failed
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

if [ "$rc_cat" -ne 0 ] && [ "$rc_der" -ne 0 ]; then
    echo "nightly: BOTH steps failed (catalog rc=$rc_cat, derive rc=$rc_der)" >&2
    exit 7
fi
if [ "$rc_cat" -ne 0 ]; then
    echo "nightly: catalog step rc=$rc_cat (derive ran and returned 0 -- derived.json IS current)" >&2
    exit "$rc_cat"
fi
if [ "$rc_der" -ne 0 ]; then
    echo "nightly: derive step rc=$rc_der -- companion surfaces (/lab, rarity, first-of-year) will go STALE" >&2
    exit "$rc_der"
fi
exit 0
