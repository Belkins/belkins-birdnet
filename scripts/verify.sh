#!/usr/bin/env bash
# verify.sh — one command that PROVES what the wall is serving right now.
#
# P0 of the pipeline-hardening plan (TOP-INSIGHTS §2.1): the two trust-killers
# of the 2026-07-03 session were serving/observability, not generation — every
# "is the fix live?" was answered by hand-typed curls that were then discarded.
# This freezes that recipe. Read-only: no gen, no deploy, no delete, no spend.
#
# Modes:
#   verify.sh <slug-or-"Sci name"> [pose]   point probe (default: both poses)
#   verify.sh wall                          roster table over every tracked job
#
# Env (all optional):
#   AV_PI_BASE               default http://birdnet.local
#   AV_RAILWAY_BASE          default https://birdgen-production.up.railway.app
#   WATCHER_WEBHOOK_SECRET   enables the Railway /job + /jobs legs; without it
#                            the Pi probes still run. NEVER commit the value —
#                            source it at call time, e.g. on the Pi:
#                            set -a; . ~/.christina/forwarder.env; set +a
#
# Exit: 0 all probes healthy; 1 a probe hard-failed (non-200 pose-1, missing
# X-Av-Real on real art, wrong cache header, or Railway-vs-Pi STALE bytes).
set -u

PI_BASE="${AV_PI_BASE:-http://birdnet.local}"
RAIL_BASE="${AV_RAILWAY_BASE:-https://birdgen-production.up.railway.app}"
SECRET="${WATCHER_WEBHOOK_SECRET:-}"
CURL="curl -sS --max-time 15"
FAIL=0
TMPDIR_V="$(mktemp -d "${TMPDIR:-/tmp}/verify-wall.XXXXXX")"
trap 'rm -rf "$TMPDIR_V"' EXIT

say()  { printf '%s\n' "$*"; }
bad()  { printf 'FAIL  %s\n' "$*"; FAIL=1; }

# slug <-> sci: the slug is the lowercased, hyphenated binomial/trinomial
# (cutout.php's own slugify, avian/api/cutout.php ~:145). The probe param is
# sci= — NOT slug= (the 2026-07-02 deploy-verify gotcha).
sci_from_arg() {
  local a="$1"
  if [[ "$a" == *" "* ]]; then printf '%s' "$a"; return; fi
  local s="${a//-/ }"
  printf '%s' "$(tr '[:lower:]' '[:upper:]' <<<"${s:0:1}")${s:1}"
}
slug_from_arg() {
  local a="$1"
  tr '[:upper:] ' '[:lower:]-' <<<"$a"
}
urlenc() { printf '%s' "$1" | sed 's/ /%20/g'; }

sha_of() { # 12-char digest; empty if NO hash tool exists (Pi may lack perl's shasum)
  if command -v shasum >/dev/null 2>&1; then shasum "$1" 2>/dev/null | cut -c1-12
  elif command -v sha1sum >/dev/null 2>&1; then sha1sum "$1" 2>/dev/null | cut -c1-12
  fi
}

hdr() { # hdr <headers-file> <Header-Name>  (case-insensitive, trims CR + leading WS)
  awk -v k="$(tr '[:upper:]' '[:lower:]' <<<"$2")" '
    { line = $0; sub(/\r$/, "", line) }
    tolower(line) ~ "^" k ":" { sub(/^[^:]*:[ \t]*/, "", line); print line; exit }
  ' "$1"
}

probe_pose() { # probe_pose <sci> <slug> <pose>  -> prints one block
  local sci="$1" slug="$2" pose="$3"
  local h="$TMPDIR_V/h.$slug.$pose" b="$TMPDIR_V/b.$slug.$pose.png"
  local url="$PI_BASE/avian/api/cutout.php?sci=$(urlenc "$sci")&pose=$pose"
  local code
  code=$($CURL -D "$h" -o "$b" -w '%{http_code}' "$url" 2>/dev/null) || { bad "pose-$pose: Pi unreachable ($url)"; return; }
  local real sub cc len sha
  real=$(hdr "$h" X-Av-Real); sub=$(hdr "$h" X-Av-Sub); cc=$(hdr "$h" Cache-Control)
  len=$(wc -c < "$b" | tr -d ' ')
  sha=$(sha_of "$b")
  say "pose-$pose  http=$code  X-Av-Real=${real:-—}  X-Av-Sub=${sub:-—}  Cache-Control=${cc:-—}  bytes=$len  sha=$sha  saved=$b"
  [ "$code" = "200" ] || { [ "$pose" = "1" ] && bad "pose-$pose: HTTP $code"; }
  if [ "${real:-0}" = "1" ]; then
    # The propagation contract (locked, TOP-INSIGHTS truth #3): REAL art ships
    # no-cache so a repaint shows on the very next reload. Placeholders keep
    # a short max-age (harmless). This line is what the CI tripwire guards.
    case "${cc:-}" in *no-cache*) : ;; *) bad "pose-$pose: real art served WITHOUT no-cache (got: ${cc:-none}) — the b06254c contract regressed";; esac
  fi
  # Railway-vs-Pi freshness: only meaningful for generated species (Railway 404
  # = bundled art, nothing to compare). The tier-3 Pi cache can serve STALE
  # bytes forever after a Railway-side manual regen/reclean — this is the one
  # command that makes that visible instead of a 'still the same' mystery.
  local rname="$slug"; [ "$pose" != "1" ] && rname="$slug-$pose"
  local rb="$TMPDIR_V/r.$rname.png" rh="$TMPDIR_V/rh.$rname" rcode
  rcode=$($CURL -D "$rh" -o "$rb" -w '%{http_code}' "$RAIL_BASE/asset/$rname.png" 2>/dev/null) || rcode=000
  if [ "$rcode" = "200" ]; then
    local rsha rfb; rsha=$(sha_of "$rb"); rfb=$(hdr "$rh" X-Av-Pose-Fallback)
    if [ "${rfb:-0}" = "1" ]; then
      # Railway served SUBSTITUTE pose-1 bytes for a missing pose-2 (marker
      # header from app.py /asset) — comparing them would emit a false STALE.
      say "        railway: no pose-$pose asset (served pose-1 fallback bytes) — comparison n/a"
    elif [ -z "$sha" ] || [ -z "$rsha" ]; then
      say "        railway=$rsha  hash tool unavailable — freshness comparison n/a"
    elif [ "$sha" = "$rsha" ]; then
      say "        railway=$rsha  FRESH (Pi bytes == Railway bytes)"
    elif [ "${sub:-0}" = "1" ]; then
      say "        railway=$rsha  (Pi served a pose-1 SUBSTITUTE — comparison n/a)"
    else
      bad "pose-$pose: STALE — Pi sha=$sha != Railway sha=$rsha (flush ~/BirdSongs/Extracted/cutouts/$rname.png on the Pi)"
    fi
  else
    say "        railway: no generated asset (http=$rcode — bundled species, nothing to compare)"
  fi
}

health_snapshot() {
  local hj="$TMPDIR_V/health.json"
  if $CURL -o "$hj" "$RAIL_BASE/health" 2>/dev/null && [ -s "$hj" ]; then
    python3 - "$hj" <<'PY'
import json, sys
h = json.load(open(sys.argv[1]))
print("health  done=%s queued=%s spend=$%s/%s manual_frac=%.3f verify_fail_open=%s" % (
    h.get("done_count"), h.get("queue_depth"), h.get("month_spend_usd"),
    h.get("budget_usd"), h.get("manual_frac", 0.0),
    h.get("verify_fail_open_since_boot", "n/a")))
PY
  else
    say "health  (Railway /health unreachable)"
  fi
}

job_state() { # job_state <slug>
  [ -n "$SECRET" ] || { say "job     (set WATCHER_WEBHOOK_SECRET for gen-state — e.g. 'set -a; . ~/.christina/forwarder.env; set +a')"; return; }
  local jj="$TMPDIR_V/job.json" jcode
  jcode=$($CURL -H "Authorization: Bearer $SECRET" -o "$jj" -w '%{http_code}' "$RAIL_BASE/job/$1" 2>/dev/null) || jcode=000
  if [ "$jcode" = "200" ]; then
    python3 - "$jj" <<'PY'
import json, sys
j = json.load(open(sys.argv[1]))
print("job     state=%s attempts=%s fail_reason=%s" % (
    j.get("state"), j.get("attempts"), j.get("fail_reason")))
PY
  else
    # 401/503 = wrong/missing secret (a REPLACE_ME placeholder from a fresh
    # deploy-realtime.sh counts) — say so, don't shrug it into 'unreachable'.
    bad "Railway /job HTTP $jcode (bad/missing WATCHER_WEBHOOK_SECRET? placeholder never replaced?)"
  fi
}

wall_mode() {
  [ -n "$SECRET" ] || { bad "wall mode needs WATCHER_WEBHOOK_SECRET (source ~/.christina/forwarder.env at call time)"; exit 1; }
  local jj="$TMPDIR_V/jobs.json" wcode
  # Capture the status: a 401/503 error body is valid JSON with NO 'jobs' key,
  # and silently rendering it as '0 jobs, 0 anomalies' + exit 0 is exactly the
  # false-all-green this tool exists to kill. Non-200 = hard fail, loudly.
  wcode=$($CURL -H "Authorization: Bearer $SECRET" -o "$jj" -w '%{http_code}' "$RAIL_BASE/jobs" 2>/dev/null) || wcode=000
  [ "$wcode" = "200" ] || { bad "Railway /jobs HTTP $wcode (bad/missing WATCHER_WEBHOOK_SECRET? placeholder never replaced? service down?)"; exit 1; }
  python3 - "$jj" <<'PY' || FAIL=1
import json, sys
d = json.load(open(sys.argv[1]))
if "jobs" not in d:
    print("FAIL  /jobs returned 200 but no 'jobs' key: %r" % (d,))
    sys.exit(1)
jobs = d["jobs"]
print("%-34s %-11s %-10s %8s %7s %9s %9s  %s" % ("slug", "state", "attest", "attempts", "vrej", "p1-bytes", "p2-bytes", "fail_reason"))
bad = 0
for j in jobs:
    flag = ""
    if j["state"] == "done" and j["pose1_bytes"] == 0:
        flag = "  <-- done but NO pose-1 bytes"; bad += 1
    print("%-34s %-11s %-10s %8s %7s %9s %9s  %s%s" % (
        j["slug"], j["state"], j.get("attest", "-"), j["attempts"], j["verify_rejects"],
        j["pose1_bytes"], j["pose2_bytes"], j.get("fail_reason") or "", flag))
print("%d jobs, %d anomalies" % (len(jobs), bad))
if not jobs:
    print("(0 jobs is only healthy on a fresh install with nothing generated yet)")
sys.exit(1 if bad else 0)
PY
  # Assert the cache contract on ONE real plate (the roster's first done slug):
  # the point of wall mode is 'the wall is provably current', and that claim
  # rides on real art revalidating every load.
  local first
  first=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(next((j['slug'] for j in d.get('jobs',[]) if j['state']=='done' and j['pose1_bytes']>0), ''))" "$jj")
  if [ -n "$first" ]; then
    say ""
    say "-- cache-contract spot check ($first) --"
    probe_pose "$(sci_from_arg "$first")" "$first" 1
  fi
  health_snapshot
}

case "${1:-}" in
  ""|-h|--help)
    sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  wall)
    wall_mode ;;
  *)
    ARG="$1"; POSE="${2:-}"
    SCI="$(sci_from_arg "$ARG")"; SLUG="$(slug_from_arg "$ARG")"
    say "== $SCI ($SLUG) via $PI_BASE =="
    if [ -n "$POSE" ]; then
      probe_pose "$SCI" "$SLUG" "$POSE"
    else
      probe_pose "$SCI" "$SLUG" 1
      probe_pose "$SCI" "$SLUG" 2
    fi
    job_state "$SLUG"
    health_snapshot ;;
esac

exit $FAIL
