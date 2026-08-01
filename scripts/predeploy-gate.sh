#!/usr/bin/env bash
# predeploy-gate.sh — the Mac-side deploy gate.
#
# deploy-christina.sh validates the dist ON the Pi (dist-static before copy,
# dist-served after) — but the ROUTINE deploy is the Mac-side rsync recipe,
# which had no gate at all: a dist built without --base=/collage/, or a bare
# --delete that clobbers the species.json/derived.json symlinks, walks straight
# onto the wall (both happened; 2026-07-30 for the symlink clobber). This gate
# runs the same repo-guard the Pi runs, then PRINTS the correct rsync so the
# flags are copied, never remembered.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="${1:-$HERE/web/dist-collage}"

bash "$HERE/scripts/repo-guards.sh" dist-static "$DIST"

cat <<EOF

gate PASSED for: $DIST
Deploy with EXACTLY (the two --exclude flags are load-bearing — a bare
--delete clobbers the catalog symlinks and the wall shows fixture birds):

  rsync -az --delete --exclude='species.json' --exclude='derived.json' \\
    "$DIST/" belkins@birdnet.local:BirdSongs/Extracted/collage/

  ssh belkins@birdnet.local 'set -e; ln -sfn ~/BirdNET-Pi/scripts/species.json ~/BirdSongs/Extracted/collage/species.json; if [ -f ~/BirdNET-Pi/scripts/derived.json ]; then ln -sfn ~/BirdNET-Pi/scripts/derived.json ~/BirdSongs/Extracted/collage/derived.json; fi; echo SYMLINKS-OK'
  # (set -e + the echoed SYMLINKS-OK make a failed ln loud — a silently missing
  #  symlink renders as a calm empty museum, the documented signature failure)

Then the durable pin (rsync to BirdNET-Pi/web/dist/, git add -f web/dist,
commit "chore(pi): pin dist — <what>") and the annotated tag pi-$(date +%Y-%m-%d)
per docs/DECISIONS.md D13. Verify with:
  bash scripts/repo-guards.sh dist-served http://birdnet.local/collage "$DIST"
EOF
