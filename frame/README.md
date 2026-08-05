# Belkins BirdNET — e-ink frame

*The last 24h of birds, framed on the wall by your window.*

A [Pimoroni Inky Impression 13.3"](https://amzn.to/4xlAWr3) (Spectra 6) mirroring the live collage. A Pi screenshots the site, mats it onto an A5 opening, and pushes it to the panel — refreshing only when the birds change.

---

### BOM

| Qty | Description | Price | Link |
|-----|-------------|-------|------|
| 1 | Raspberry Pi Zero 2 W | ~$35 | [Amazon](https://amzn.to/49Xp58I) |
| 1 | 13.3" E-Ink Display (Spectra 6) | $299.99 | [Amazon](https://amzn.to/4xlAWr3) |
| 1 | A4 Wood Photo Frame | $21.99 | [Amazon](https://amzn.to/3RWFbJE) |
| 1 | Long, flat micro-USB cable | $7.99 | [Amazon](https://a.co/d/0a59rKSk) |
| 1 | Flat USB brick | $7.59 | [Amazon](https://amzn.to/3S4CtSs) |
| | **Total** | **~$372** | |

CAD + 3D-print files live in [`hardware/`](hardware/).

---

## 1. Flash the SD card

Flash Raspberry Pi OS Lite (64-bit) with [Raspberry Pi Imager](https://www.raspberrypi.com/software/). In the customisation dialog set:

- Username
- WiFi SSID + password
- Hostname: `birdpic`
- Enable SSH with password auth

Then seat it in the Pi and power up.

## 2. Run the installer

```bash
ssh <your-username>@birdpic.local
sudo apt update && sudo apt install -y git
git clone https://github.com/Belkins/belkins-birdnet
cd belkins-birdnet/frame
```

Pick how the frame gets its birds:

```bash
# Pair with your bird mic on the same network (birdnet.local). The default.
./install.sh

# No microphone: draw the collage from BirdWeather for any ZIP code.
./install.sh --bird-weather --zip 94107

# Bird mic hosted at a public URL: point the frame straight at it.
./install.sh --image-url https://bird.example.com/frame.png?k=YOUR_FRAME_KEY
```

Each path enables SPI + I2C, installs the deps and a systemd timer, writes `~/.birdframe/config.toml`, and reboots once to bring SPI up. Full options live in [`config.example.toml`](config.example.toml).

BirdWeather mode renders on the Pi from this repo's illustrations on GitHub, so there is no image set to copy over. ZIP codes with no station nearby fall back to the closest ones. If you are far from any BirdWeather station, add `--ebird-key <key>` (a free key from [ebird.org/api/keygen](https://ebird.org/api/keygen)) and the frame fills from eBird sightings instead.

---

## Hosting on the station Pi itself (one-box install)

The two-Pi split above is the gentle default, but the panel can hang off the
BirdNET station Pi directly — the live Belkins install runs this way on a
Pi 5. Differences that matter on a box that is also recording audio:

```bash
cd ~/BirdNET-Pi/frame           # the station's own checkout, not a fresh clone
./install.sh --no-reboot        # NEVER let an installer reboot the station unasked
sed -i 's|birdnet.local|127.0.0.1|' ~/.birdframe/config.toml   # same box; mDNS flakes
sudo reboot                     # when YOU are ready — this brings SPI up
```

- **Attach with the power off.** Shut down, seat the panel (grip the board
  edges, never press the glass), then boot and install.
- `--no-reboot` is required station etiquette: the installer otherwise
  reboots to bring SPI up, which on this box means a gap in the recording.
- `base_url = "http://127.0.0.1"` — the station screenshots itself; its own
  mDNS name is the one name it may fail to resolve.
- Alerting integrates automatically: both frame units carry
  `OnFailure=christina-alert@%n.service` (the handler is already installed by
  the station deploy scripts), and `frame-watch.service` layers
  `~/.christina/forwarder.env`, so the existing `NOTIFY_URL` works with no
  new secret. The station is LAN-open by choice (`STATION_OPEN`), so no
  `basic_user`/`basic_pass` is needed; the keys exist in
  [`config.example.toml`](config.example.toml) if auth ever returns.
- The service ships co-tenant limits (`MemoryMax=512M`, `OOMScoreAdjust=500`,
  `Nice`, idle I/O): if memory runs short, the kernel kills the screenshot,
  the wall keeps its last picture, and the detector never notices.
- Rollback is two commands and no hardware:
  `sudo systemctl disable --now birdframe.timer frame-watch.timer` — the
  panel keeps its last image unpowered.

---

## The buttons

The Impression's four side switches are views (`birdframe-buttons.service`):

| Button | View | |
|--------|------|---|
| **A** (top) | **Today** | the config default, back from any whim |
| **B** | **This Week** | 7 days |
| **C** | **All Time** | the whole collection |
| **D** | **repaint now** | whatever view is active, painted fresh |

A press is a ceremony, not a click — a Spectra 6 refresh is ~30 seconds of
colour theatre. Presses that land mid-paint are absorbed and delivered when
the panel is free. A pressed view holds for `view_ttl_hours` (default 4),
then the wall reverts to the config on its own; `[views.<name>]` tables in
`config.toml` override or add views. On the 13.3" the C button is GPIO 25,
not the smaller boards' 16 — `buttons.py` already knows.

---

### If the frame ever freezes

`display.py` keeps the last picture on the panel and exits cleanly whenever a refresh fails — that is deliberate (a blank wall is worse than a stale one), but it means a dead screenshotter or a dead panel is completely silent. `frame_watch.py` runs hourly and alerts when the wall stops repainting: it compares the capture file and `~/.birdframe/state.json` against the frame's own configured cadence (`heal_hours` plus any quiet window), so a quiet garden or a muted night can never trigger it.

```bash
systemctl status frame-watch.timer
sudo nano ~/.birdframe/watch.env    # uncomment NOTIFY_URL for phone pushes
```

Installing the timer and watching it exit 0 proves nothing — the healthy path is also the silent path. The only real proof is to make the wall look dead on purpose and wait for the push:

```bash
sudo cp ~/.birdframe/state.json /tmp/state.json.bak
touch -d '3 days ago' ~/.birdframe/state.json
sudo systemctl start frame-watch.service; sudo systemctl start frame-watch.service   # two ticks = one alert
sudo cp /tmp/state.json.bak ~/.birdframe/state.json                                  # then restore
```

It watches for a FROZEN wall, not a wrong one: a blank or half-painted screenshot still refreshes both timestamps and reads as healthy.
