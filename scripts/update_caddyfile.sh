#!/usr/bin/env bash
source /etc/birdnet/birdnet.conf
my_dir=$HOME/BirdNET-Pi/scripts
set -x

# Find the active PHP-FPM Unix socket. The path is version-specific on
# modern Raspberry Pi OS (e.g. /run/php/php8.2-fpm.sock); the generic
# /run/php/php-fpm.sock only exists if a compat shim is installed, so
# hardcoding it breaks Caddy's php_fastcgi handler on stock Bookworm.
FPM_SOCK=$(ls /run/php/php*-fpm.sock 2>/dev/null | head -n1)
FPM_SOCK=${FPM_SOCK:-/run/php/php-fpm.sock}

[ -d /etc/caddy ] || sudo mkdir -p /etc/caddy
# TIMESTAMPED, not a fixed name. `cp Caddyfile{,.original}` meant a SECOND run
# overwrote the only good copy with the bad one the first run had just left --
# so the backup taken to survive a mistake was destroyed by repeating it.
if [ -f /etc/caddy/Caddyfile ]; then
  sudo cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%Y%m%d-%H%M%S)"
fi

# RENDER TO A TEMP FILE, VALIDATE THAT, THEN INSTALL.
#
# Both heredocs below used to write straight to /etc/caddy/Caddyfile, and the
# `caddy validate` at the bottom ran AFTER the live file had already been
# overwritten. On a validation failure the script exited 1 without reloading --
# correct as far as it went -- but left an UNPARSEABLE config on disk. Caddy
# keeps serving from memory, so nothing looks wrong until the next restart or
# reboot, at which point the station has no web server at all: no museum, no
# API, no /events, and the failure is hours or weeks detached from its cause.
#
# CADDYFILE is the write target for everything below; the live path is only
# touched by the atomic install at the end.
CADDYFILE="$(mktemp -t Caddyfile-XXXXXX)"
trap 'rm -f "$CADDYFILE" 2>/dev/null' EXIT
# STATION_OPEN="1" — the deliberate LAN-open opt-out (owner's choice, 2026-07-30).
# REFUSE rather than regenerate. Every path below re-emits basic_auth, so running
# this script would silently put the passwords back and undo that choice.
#
# This is a refusal, not a TODO. The script already could not reproduce the live
# /etc/caddy/Caddyfile — it emits the pre-2.7 `basicauth` spelling that Caddy
# 2.11 rejects outright, and it knows nothing about the hand-added /events SSE
# route or the extra Host pins. Teaching it a third branch would make it look
# safe to run while it still is not. Edit the live file surgically instead.
#
# ADDED 2026-07-30, and this is now the bigger loss: the live file also carries
# the SERVING WORK that made the museum 11.5x lighter, none of which this script
# knows how to emit --
#   @nostream / encode @nostream zstd gzip   first-load text 690,437 -> 182,160 B.
#     The exclusion is load-bearing: SSE is text/event-stream, which matches
#     encode's default text/* list, so a bare `encode` BUFFERS the realtime
#     spine dead while every asset check still passes.
#   @immutable path /collage/assets/*        immutable caching on content-hashed
#     assets, scoped so species.json and derived.json (nightly-rebuilt symlinks)
#     never get it.
# Regenerating silently reverts both. Nothing would look broken: the wall would
# just quietly serve 3.8x more bytes again, and the only symptom is slowness
# nobody attributes to a config rewrite weeks earlier.
if [ "${STATION_OPEN}" = "1" ];then
  echo "update_caddyfile: REFUSING to run — STATION_OPEN=1 in birdnet.conf." >&2
  echo "  This script re-emits basic_auth on 11 paths and would restore every" >&2
  echo "  password gate the owner deliberately removed on 2026-07-30." >&2
  echo "  It also cannot reproduce the live file (old 'basicauth' spelling," >&2
  echo "  no /events route, no extra Host pins, and NO encode/@immutable --" >&2
  echo "  regenerating would silently undo the 11.5x serving win), so it must" >&2
  echo "  not be used to" >&2
  echo "  re-gate either. To restore the gates: edit /etc/caddy/Caddyfile by" >&2
  echo "  hand, or unset STATION_OPEN first and diff before applying." >&2
  exit 2
fi
# STATION_OPEN="1" — the deliberate LAN-open opt-out (owner's choice, 2026-07-30).
# REFUSE rather than regenerate. Every path below re-emits basic_auth, so running
# this script would silently put the passwords back and undo that choice.
#
# This is a refusal, not a TODO. The script already could not reproduce the live
# /etc/caddy/Caddyfile — it emits the pre-2.7 `basicauth` spelling that Caddy
# 2.11 rejects outright, and it knows nothing about the hand-added /events SSE
# route or the extra Host pins. Teaching it a third branch would make it look
# safe to run while it still is not. Edit the live file surgically instead.
if [ "${STATION_OPEN}" = "1" ];then
  echo "update_caddyfile: REFUSING to run — STATION_OPEN=1 in birdnet.conf." >&2
  echo "  This script re-emits basic_auth on 11 paths and would restore every" >&2
  echo "  password gate the owner deliberately removed on 2026-07-30." >&2
  echo "  It also cannot reproduce the live file (old 'basicauth' spelling," >&2
  echo "  no /events route, no extra Host pins), so it must not be used to" >&2
  echo "  re-gate either. To restore the gates: edit /etc/caddy/Caddyfile by" >&2
  echo "  hand, or unset STATION_OPEN first and diff before applying." >&2
  exit 2
fi
if ! [ -z ${CADDY_PWD} ];then
HASHWORD=$(caddy hash-password --plaintext ${CADDY_PWD})
cat << EOF > "$CADDYFILE"
http:// ${BIRDNETPI_URL} {
  root * ${EXTRACTED}
  # The wall's front door. Without this, `/` resolves via try_files to
  # ${EXTRACTED}/index.html -- the symlink install_services.sh points at the
  # LEGACY avian/frontend collage (779 KB apt.js, superseded) -- so the natural
  # URL served the old gallery while the real museum sat at /collage/. Exact
  # root only: /index.html still reaches the legacy page for anyone who wants it.
  redir / /collage/ 302
  file_server browse
  handle /By_Date/* {
    file_server browse
  }
  handle /Charts/* {
    file_server browse
  }
  basicauth /views.php?view=File* {
    birdnet ${HASHWORD}
  }
  basicauth /Processed* {
    birdnet ${HASHWORD}
  }
  basicauth /scripts* {
    birdnet ${HASHWORD}
  }
  basicauth /stream {
    birdnet ${HASHWORD}
  }
  basicauth /phpsysinfo* {
    birdnet ${HASHWORD}
  }
  basicauth /terminal* {
    birdnet ${HASHWORD}
  }
  # play.php is symlinked to the WEB ROOT by install_services.sh, so /scripts*
  # does not cover it -- and it holds an exec("sudo rm ...") of a GET parameter.
  basicauth /play.php* {
    birdnet ${HASHWORD}
  }
  basicauth /log* {
    birdnet ${HASHWORD}
  }
  basicauth /stats* {
    birdnet ${HASHWORD}
  }
  # The recordings/charts archives are browsable indexes of what is audible at
  # the operator's home, with timestamps. The museum never fetches these
  # directly (it goes through /avian/api/recording.php + spectrogram.php), so
  # gating them costs nothing and removes an occupancy-inference leak.
  basicauth /By_Date* {
    birdnet ${HASHWORD}
  }
  basicauth /Charts* {
    birdnet ${HASHWORD}
  }
  # DNS-rebinding defence: a hostile page cannot rebind its own hostname to this
  # box and drive it, because the Host header will not match. Basic auth alone
  # does NOT cover this -- browsers replay cached credentials automatically.
  @badhost not host ${BIRDNETPI_URL} birdnet.local birdnet localhost 127.0.0.1
  abort @badhost
  reverse_proxy /stream localhost:8000
  # Belkins BirdNET overlay drops an index.html alongside BirdNET-Pi's
  # index.php. The default try_files for php_fastcgi prefers index.php
  # over index.html, so override it - this is a no-op on stock installs
  # since EXTRACTED has no index.html there.
  php_fastcgi unix/${FPM_SOCK} {
    try_files {path} {path}/index.html {path}/index.php index.php
  }
  reverse_proxy /log* localhost:8080
  reverse_proxy /stats* localhost:8501
  reverse_proxy /terminal* localhost:8888
}
EOF
else
# ---------------------------------------------------------------------------
# NO CADDY_PWD SET. This branch used to emit a completely UNAUTHENTICATED
# config, which is how /terminal (a browser shell), scripts/adminer.php,
# scripts/birds.db and play.php's exec("sudo rm $_GET[...]") ended up reachable
# by anything on the LAN. The same empty variable also made
# is_authenticated() return true for everyone, so ONE unset value silently
# disabled BOTH auth layers at once.
#
# It now still serves the MUSEUM (the wall and the e-ink frame must keep
# working on a fresh install), but the admin plane is DENIED outright rather
# than left open. Set CADDY_PWD in birdnet.conf and re-run this script to get
# a password prompt instead of a 403.
# ---------------------------------------------------------------------------
echo "update_caddyfile: WARNING - CADDY_PWD is empty." >&2
echo "  Serving the gallery, but DENYING the admin plane (/scripts*, /terminal*," >&2
echo "  /play.php, /log*, /stats*, /stream, /phpsysinfo*, /Processed*, archives)." >&2
echo "  Set CADDY_PWD in /etc/birdnet/birdnet.conf and re-run to enable them." >&2
  cat << EOF > "$CADDYFILE"
http:// ${BIRDNETPI_URL} {
  root * ${EXTRACTED}
  # The wall's front door. Without this, `/` resolves via try_files to
  # ${EXTRACTED}/index.html -- the symlink install_services.sh points at the
  # LEGACY avian/frontend collage (779 KB apt.js, superseded) -- so the natural
  # URL served the old gallery while the real museum sat at /collage/. Exact
  # root only: /index.html still reaches the legacy page for anyone who wants it.
  redir / /collage/ 302
  # Fail closed: no password configured => the admin plane is refused, not open.
  @adminplane path /scripts* /play.php* /terminal* /log* /stats* /stream /phpsysinfo* /Processed* /By_Date* /Charts*
  respond @adminplane "Admin surfaces are disabled because CADDY_PWD is not set. Set it in birdnet.conf and re-run scripts/update_caddyfile.sh." 403
  @badhost not host ${BIRDNETPI_URL} birdnet.local birdnet localhost 127.0.0.1
  abort @badhost
  file_server browse
  handle /By_Date/* {
    file_server browse
  }
  handle /Charts/* {
    file_server browse
  }
  reverse_proxy /stream localhost:8000
  # Belkins BirdNET overlay drops an index.html alongside BirdNET-Pi's
  # index.php. The default try_files for php_fastcgi prefers index.php
  # over index.html, so override it - this is a no-op on stock installs
  # since EXTRACTED has no index.html there.
  php_fastcgi unix/${FPM_SOCK} {
    try_files {path} {path}/index.html {path}/index.php index.php
  }
  reverse_proxy /log* localhost:8080
  reverse_proxy /stats* localhost:8501
  reverse_proxy /terminal* localhost:8888
}
EOF
fi

# Format and validate THE CANDIDATE, while the live config is still the last
# known-good one. Fail loudly on a Caddyfile caddy can't parse rather than
# reloading a broken config and reporting success.
caddy fmt --overwrite "$CADDYFILE"
caddy validate --config "$CADDYFILE" --adapter caddyfile || {
  echo "generated Caddyfile failed validation; /etc/caddy/Caddyfile is UNCHANGED" >&2
  echo "  (the candidate was rendered to $CADDYFILE and discarded — the box is" >&2
  echo "   still serving the config it was serving before this ran)" >&2
  exit 1
}

# Only now does the live path change. `install` is a single rename-like
# operation with the mode set, so there is no window in which /etc/caddy/Caddyfile
# is half-written.
sudo install -m 644 "$CADDYFILE" /etc/caddy/Caddyfile || {
  echo "could not install the validated Caddyfile to /etc/caddy/Caddyfile" >&2
  exit 1
}

# reload-or-restart so this also works at install time, when caddy may not be
# running yet (a plain reload would fail there); tolerate a not-yet-ready unit.
sudo systemctl reload-or-restart caddy 2>/dev/null || true
