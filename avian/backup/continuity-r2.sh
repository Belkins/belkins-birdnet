#!/usr/bin/env bash
# continuity-r2.sh — the weekly continuity pass, as one unit-runnable step:
# refresh the station's identity in R2 (config-to-r2.sh), then the volume-only
# plates archive (plates-to-r2.sh). Either failing must redden the unit so
# christina-alert@ fires — the whole point is that staleness is LOUD.
#
# Exit code = config-to-r2's on its failure, else plates-to-r2's verbatim
# (so a DEGRADED-but-uploaded plates run still alerts with the copy safe).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bash "$HERE/config-to-r2.sh" || exit "$?"
exec bash "$HERE/plates-to-r2.sh"
