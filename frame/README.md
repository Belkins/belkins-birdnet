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
