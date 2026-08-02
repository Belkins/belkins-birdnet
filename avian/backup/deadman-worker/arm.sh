#!/usr/bin/env bash
# arm.sh — the dead-man's switch from wrangler-login to a PROVEN alarm, one command.
#
# Measured 2026-08-01: this Worker had never been deployed — the "written,
# never switched on" failure at the meta level, with no wrangler log on the
# operator's machine since July 10. This script exists so the gap between
# `wrangler login` and a fire-tested alarm is one command, not a README.
#
# Prereq (interactive, once): npx wrangler login
# The ntfy URL is read from the Pi at RUN TIME — never stored here, never echoed.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

npx wrangler whoami >/dev/null 2>&1 \
  || { echo "arm: not logged in — run: npx wrangler login" >&2; exit 2; }

N="${NOTIFY_URL:-$(ssh -i ~/.ssh/christina_pi -o BatchMode=yes belkins@birdnet.local '. ~/.christina/forwarder.env && printf %s "$NOTIFY_URL"')}"
[ -n "$N" ] || { echo "arm: could not obtain NOTIFY_URL (Pi unreachable and env unset)" >&2; exit 2; }
printf %s "$N" | npx wrangler secret put NOTIFY_URL

OUT=$(npx wrangler deploy 2>&1); echo "$OUT"
URL=$(grep -oE 'https://[a-z0-9.-]+\.workers\.dev' <<<"$OUT" | head -1)
[ -n "$URL" ] || { echo "arm: deploy printed no workers.dev URL — read the output above" >&2; exit 4; }

echo "── healthy verdict (expect \"stale\": false) ──"
curl -s "$URL"; echo

# ── FIRE TEST: an alarm nobody has watched fire is a hope, not an alarm ──────
# Temporarily set the threshold below any real archive age, deploy, trigger,
# then restore — the trap guarantees worker.js is never left mutated.
cp worker.js worker.js.arm-bak
trap 'mv -f worker.js.arm-bak worker.js 2>/dev/null || true' EXIT
sed -i.sedbak 's/const STALE_HOURS = [0-9.]*/const STALE_HOURS = 0.001/' worker.js && rm -f worker.js.sedbak
grep -q 'STALE_HOURS = 0.001' worker.js || { echo "arm: threshold edit did not take" >&2; exit 4; }
npx wrangler deploy >/dev/null 2>&1
echo "── firing (your phone should buzz within seconds) ──"
curl -s "$URL"; echo
mv -f worker.js.arm-bak worker.js
trap - EXIT
npx wrangler deploy >/dev/null 2>&1
echo "── restored to STALE_HOURS=30; final healthy verdict ──"
curl -s "$URL"; echo
echo "arm: DONE — record the fired alert in docs/RUNBOOK.md's evidence line"
