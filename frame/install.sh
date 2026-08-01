#!/usr/bin/env bash
# Install the Belkins BirdNET e-ink frame (display side) on a Raspberry Pi.
# Enables SPI + I2C, installs deps, makes a venv, installs the systemd timer.
#
# Three ways to feed the frame, pick one:
#   ./install.sh                            mirror the BirdNET-Pi on your network
#                                           (birdnet.local), rendered on this Pi
#   ./install.sh --image-url <URL>          fetch a ready-made frame PNG instead
#                                           (e.g. a public Cloudflare Worker)
#   ./install.sh --bird-weather --zip <ZIP> standalone from BirdWeather, no mic
#                                           (add --ebird-key <KEY> for remote ZIPs)
#
# --no-reboot: print the reboot instruction instead of rebooting. REQUIRED
# form on a box that does anything besides drive the panel (the station Pi
# records audio around the clock; an installer must not bounce it unasked).
set -euo pipefail
cd "$(dirname "$0")"
FRAME="$(pwd)"

MODE=local            # local | image | birdweather
ZIP=""
IMAGE_URL=""
EBIRD_KEY=""
NO_REBOOT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-reboot) NO_REBOOT=1; shift ;;
    --bird-weather) MODE=birdweather; shift ;;
    --zip) [ $# -ge 2 ] || { echo "--zip needs a value, e.g. --zip 94107" >&2; exit 1; }
           ZIP="$2"; shift 2 ;;
    --zip=*) ZIP="${1#*=}"; shift ;;
    --image-url) [ $# -ge 2 ] || { echo "--image-url needs a URL, e.g. --image-url https://bird.example/frame.png" >&2; exit 1; }
                 MODE=image; IMAGE_URL="$2"; shift 2 ;;
    --image-url=*) MODE=image; IMAGE_URL="${1#*=}"; shift ;;
    --ebird-key) [ $# -ge 2 ] || { echo "--ebird-key needs a value (a free key from ebird.org/api/keygen)" >&2; exit 1; }
                 EBIRD_KEY="$2"; shift 2 ;;
    --ebird-key=*) EBIRD_KEY="${1#*=}"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ -n "$ZIP" ] && [ "$MODE" != birdweather ]; then
  echo "--zip only applies with --bird-weather" >&2
  exit 1
fi
if [ -n "$EBIRD_KEY" ] && [ "$MODE" != birdweather ]; then
  echo "--ebird-key only applies with --bird-weather" >&2
  exit 1
fi

# Validate inputs up front: a bad value would otherwise land in a config file or
# a systemd unit verbatim. These checks also reject a flag passed as a value
# (e.g. "--zip --image-url"), which would fail the format below.
if [ "$MODE" = birdweather ]; then
  if [ -z "$ZIP" ]; then
    echo "--bird-weather needs --zip <ZIP code>, e.g. install.sh --bird-weather --zip 94107" >&2
    exit 1
  fi
  if ! printf '%s' "$ZIP" | LC_ALL=C grep -qE '^[A-Za-z0-9][A-Za-z0-9 -]{1,9}$'; then
    echo "--zip should look like a postal code, e.g. 94107 or SW1A 1AA" >&2
    exit 1
  fi
  if [ -n "$EBIRD_KEY" ] && ! printf '%s' "$EBIRD_KEY" | LC_ALL=C grep -qE '^[A-Za-z0-9]+$'; then
    echo "--ebird-key should be the alphanumeric token from ebird.org/api/keygen" >&2
    exit 1
  fi
fi
if [ "$MODE" = image ]; then
  if [ -z "$IMAGE_URL" ]; then
    echo "--image-url needs a URL, e.g. install.sh --image-url https://bird.example/frame.png" >&2
    exit 1
  fi
  case "$IMAGE_URL" in
    http://*|https://*) ;;
    *) echo "--image-url must start with http:// or https://" >&2; exit 1 ;;
  esac
  if printf '%s' "$IMAGE_URL" | LC_ALL=C grep -q '[^A-Za-z0-9._~:/?#@!$&()*+,;=%-]'; then
    echo "--image-url has characters that are not allowed in a URL" >&2
    exit 1
  fi
fi

# local + birdweather render on the Pi (need a browser); image only fetches.
NEEDS_BROWSER=1
if [ "$MODE" = image ]; then NEEDS_BROWSER=0; fi

CONFIG_TXT=/boot/firmware/config.txt
[ -f "$CONFIG_TXT" ] || CONFIG_TXT=/boot/config.txt

echo "1/5  Enabling SPI + I2C (Inky needs both; SPI with no chip-select)..."
sudo raspi-config nonint do_spi 0
sudo raspi-config nonint do_i2c 0
grep -q "^dtoverlay=spi0-0cs" "$CONFIG_TXT" || echo "dtoverlay=spi0-0cs" | sudo tee -a "$CONFIG_TXT" >/dev/null

echo "2/5  Installing system packages (build tools to compile spidev, libatlas3-base for numpy)..."
sudo apt-get update -qq
sudo apt-get install -y python3-venv python3-dev build-essential libatlas3-base

echo "3/5  Creating venv and installing Python deps..."
python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements-frame.txt
if [ "$NEEDS_BROWSER" = 1 ]; then
  # Chromium + its apt deps cost roughly 450-650MB. Warn (not fail) below 2GB
  # free: the operator may know better, but must not find out from a full SD.
  _free_mb=$(df -Pm . | awk 'NR==2 {print $4}')
  if [ "${_free_mb:-0}" -lt 2048 ]; then
    echo "     WARNING: only ${_free_mb}MB free on this filesystem; Chromium needs ~650MB." >&2
  fi
  echo "     Installing Playwright + Chromium so the Pi can render the collage (a few minutes)..."
  .venv/bin/pip install -q playwright
  sudo .venv/bin/playwright install-deps chromium
  .venv/bin/playwright install chromium
fi

echo "4/5  Writing config..."
mkdir -p "$HOME/.birdframe"
CONFIG="$HOME/.birdframe/config.toml"
if [ -f "$CONFIG" ]; then
  EXISTING="$(sed -n 's/^# birdframe-mode: //p' "$CONFIG" | head -1)"
  if [ -n "$EXISTING" ] && [ "$EXISTING" != "$MODE" ]; then
    echo "     $CONFIG is set up for '$EXISTING' mode, not '$MODE'." >&2
    echo "     To switch, remove it and re-run:  rm $CONFIG" >&2
    exit 1
  fi
  echo "     $CONFIG already exists, leaving it untouched."
elif [ "$MODE" = local ]; then
  cat > "$CONFIG" <<'CFG'
# birdframe-mode: local
# Belkins BirdNET frame, local mode: mirrors the BirdNET-Pi on your network.
# This Pi screenshots birdnet.local itself, so there is nothing else to set up.
base_url = "http://birdnet.local"
shoot = true
shoot_title = "Belkins BirdNET"
shoot_subtitle = "Heard Today"
rotate = 90          # flip to 270 if the frame hangs the other way up
saturation = 0.6
timeout = 45
# If your BirdNET-Pi is behind basic-auth, uncomment and set these:
# basic_user = "..."
# basic_pass = "..."
CFG
elif [ "$MODE" = image ]; then
  BASE="$(printf '%s' "$IMAGE_URL" | sed -E 's#^(https?://[^/]+).*#\1#')"
  # printf, not a heredoc: the URL is written literally, never shell-expanded.
  {
    printf '%s\n' '# birdframe-mode: image'
    printf '%s\n' '# Belkins BirdNET frame, image mode: fetches a ready-made frame PNG.'
    printf 'base_url = "%s"\n' "$BASE"
    printf 'image_url = "%s"\n' "$IMAGE_URL"
    printf '%s\n' 'shoot = false'
    printf '%s\n' 'rotate = 90          # flip to 270 if the frame hangs the other way up'
    printf '%s\n' 'saturation = 0.6'
  } > "$CONFIG"
else
  # shoot=false is the load-bearing line: the example ships shoot=true (right
  # for local mode), and display.py checks `shoot` BEFORE image_url — verbatim,
  # this mode rendered frame.png, discarded it, and screenshotted a
  # birdnet.local that a standalone box does not have. Green unit, blank wall.
  { printf '%s\n' '# birdframe-mode: birdweather'
    sed 's/^shoot = true$/shoot = false/' config.example.toml; } > "$CONFIG"
fi

echo "5/5  Installing systemd service + timer..."
if [ "$MODE" = birdweather ]; then
  PY="$FRAME/.venv/bin/python"
  PNG="$HOME/.birdframe/frame.png"
  sudo tee /etc/systemd/system/birdframe.service >/dev/null <<SERVICE
[Unit]
Description=Belkins BirdNET frame, BirdWeather mode (ZIP $ZIP)
Documentation=https://github.com/Belkins/belkins-birdnet
Wants=network-online.target
After=network-online.target
# Same alert path as the repo template (systemd/birdframe.service). This unit
# is written by heredoc, not rendered from that template — guard 11e exists
# because exactly this split once cost birdcast its OnFailure= line.
OnFailure=christina-alert@%n.service

[Service]
Type=oneshot
User=$USER
WorkingDirectory=$FRAME
# --no-signature already forces "changed" on every 6h tick; --force would ALSO
# bypass quiet_start/quiet_end and the min-refresh floor, flashing the panel
# at 3am against the operator's own config. Cadence gates stay honored.
ExecStart=/bin/sh -c '$PY $FRAME/shoot.py --bird-weather --zip "$ZIP" --out $PNG && $PY $FRAME/display.py --config $HOME/.birdframe/config.toml --image-url $PNG --no-signature'
Environment=PYTHONUNBUFFERED=1
Nice=10
# Deliberately NO MemoryMax/OOMScoreAdjust here, unlike the station template:
# BirdWeather mode is by definition the standalone no-mic box (often a 512MB
# Zero 2 W with nothing to protect), and shoot.py runs pre-&& as its own
# process — a cgroup OOM kill of it would exit non-zero and turn the
# template's documented silent keep-last-panel case into a hard unit failure
# that re-alerts every 6h. Guard 11e pins the limits on the template only.
# 360 for the same ceiling-sum reason as the template: 3×45s page waits +
# 2×30s Playwright defaults + cutout fetches from GitHub + panel ≤65s.
TimeoutStartSec=360
SERVICE
  # Remote ZIPs with no nearby station fall back to eBird, which needs a key.
  # ORDER-DEPENDENT append: this lands in [Service] only because the heredoc
  # above ends inside [Service] and has no [Install]. Guard 11e pins that.
  if [ -n "$EBIRD_KEY" ]; then
    echo "Environment=EBIRD_API_KEY=$EBIRD_KEY" | sudo tee -a /etc/systemd/system/birdframe.service >/dev/null
  fi
  # BirdWeather's recent-species list drifts slowly, so refresh a few times a day.
  sed 's|OnUnitActiveSec=.*|OnUnitActiveSec=6h|' systemd/birdframe.timer \
    | sudo tee /etc/systemd/system/birdframe.timer >/dev/null
else
  # local + image both run display.py against the config; only the config differs.
  sed "s|/home/monalisa/belkins-birdnet/frame|$FRAME|g; s|/home/monalisa|$HOME|g; s|User=monalisa|User=$USER|" \
    systemd/birdframe.service | sudo tee /etc/systemd/system/birdframe.service >/dev/null
  sudo cp systemd/birdframe.timer /etc/systemd/system/birdframe.timer
fi

# Frame-freshness watchdog (all three modes): display.py keeps the last panel
# image and exits 0 on every recoverable failure, so a dead shooter or a dead
# panel is otherwise completely silent.
sed "s|/home/monalisa/belkins-birdnet/frame|$FRAME|g; s|/home/monalisa|$HOME|g; s|User=monalisa|User=$USER|" \
  systemd/frame-watch.service | sudo tee /etc/systemd/system/frame-watch.service >/dev/null
sudo cp systemd/frame-watch.timer /etc/systemd/system/frame-watch.timer
# One env file, created here with a commented placeholder rather than left for
# the operator to invent: the frame's convention is one reference file per
# surface (config.example.toml says so of itself), and 600 because a topic URL
# is a write capability for anyone who can read it.
WATCH_ENV="$HOME/.birdframe/watch.env"
if [ ! -f "$WATCH_ENV" ]; then
  printf '%s\n' '# NOTIFY_URL=https://ntfy.sh/your-topic-here' > "$WATCH_ENV"
  chmod 600 "$WATCH_ENV"
fi

sudo systemctl daemon-reload
sudo systemctl enable --now birdframe.timer  # --now starts it immediately, not only on the next boot
sudo systemctl enable --now frame-watch.timer
echo "     Frame watchdog installed (frame-watch.timer, hourly). For a phone push when"
echo "     the wall freezes, uncomment NOTIFY_URL in $WATCH_ENV"
echo "     (ntfy app, subscribe the topic, no account)."

case "$MODE" in
  local)
    cat <<DONE

Installed. The frame mirrors birdnet.local on your network and refreshes every
15 min, only when the birds change. Until the mic has heard its first bird it
shows a plain title card. If the panel hangs upside down, set rotate = 270 in
~/.birdframe/config.toml.
DONE
    ;;
  image)
    cat <<DONE

Installed. The frame fetches its image from
  $IMAGE_URL
and refreshes every 15 min, only when the birds change.
DONE
    ;;
  birdweather)
    cat <<DONE

Installed in BirdWeather mode for ZIP $ZIP. The frame renders the top birds
near you on the Pi and refreshes every 6 hours. Cutouts come from the repo on
GitHub, so add illustrations there for any local birds it is missing.
DONE
    ;;
esac

# SPI only takes effect on a reboot, so do it for the user. Skip if SPI is
# already up (e.g. a re-run) so we don't bounce a working frame. --no-reboot
# hands the moment back to the operator: on a co-tenant box (the station Pi
# records audio continuously) the reboot must be a decision, not a side effect.
if [ -e /dev/spidev0.0 ]; then
  echo "SPI already active, no reboot needed."
elif [ "$NO_REBOOT" = 1 ]; then
  echo "SPI is enabled but not yet live (--no-reboot). Reboot when ready:  sudo reboot"
else
  echo "Rebooting to bring SPI up (back on its own in ~1 min)..."
  sleep 4
  sudo reboot
fi
