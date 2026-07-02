<!-- ░░░ Belkins BirdNET ░░░ -->
<p align="center">
  <img src="docs/hero.svg" alt="Belkins BirdNET — the dawn chorus, identified" width="100%" />
</p>

<h1 align="center">Belkins BirdNET</h1>
<p align="center"><em>A live, hand-illustrated collage of the birds outside your window — named by ear.</em></p>

<p align="center">
  <img src="https://img.shields.io/badge/License-CC--BY--NC--SA%204.0-2ea44f?style=for-the-badge" alt="License: CC-BY-NC-SA 4.0" />
  <img src="https://img.shields.io/badge/Built%20on-BirdNET--Pi-1f6feb?style=for-the-badge" alt="Built on BirdNET-Pi" />
  <img src="https://img.shields.io/badge/Runs%20on-Raspberry%20Pi-c51a4a?style=for-the-badge&logo=raspberrypi&logoColor=white" alt="Runs on Raspberry Pi" />
  <img src="https://img.shields.io/badge/Model-BirdNET%206K%20v2.4-7c3aed?style=for-the-badge" alt="Model: BirdNET 6K v2.4" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/species-250-0d9488?style=flat-square" alt="250 species" />
  <img src="https://img.shields.io/badge/illustrations-500-db2777?style=flat-square" alt="500 illustrations" />
  <img src="https://img.shields.io/badge/model%20labels-6%2C522-2563eb?style=flat-square" alt="6522 model labels" />
  <img src="https://img.shields.io/badge/detection%20to%20screen-under%203s-d97706?style=flat-square" alt="under 3 seconds" />
  <img src="https://img.shields.io/badge/Python-3.11%2B-3776ab?style=flat-square&logo=python&logoColor=white" alt="Python 3.11+" />
  <img src="https://img.shields.io/badge/PHP-FPM-777bb4?style=flat-square&logo=php&logoColor=white" alt="PHP-FPM" />
</p>

<p align="center">
  <img src="docs/flock.svg" alt="" width="100%" />
</p>

---

## 🐦 What it is

A single $17 USB microphone in your window turns the birds outside into a **living collage**. Belkins BirdNET listens through the mic, lets **Cornell's BirdNET** name every passing call, and blooms each species onto the screen as a hand-painted *kachō-e* illustration — sized by how often it's been heard and repainted within seconds of each new detection.

500 bundled illustrations across 250 species, a Gemini pipeline to restyle them for *your* region, an optional e-ink frame for your wall — and one read-only SQLite file at the heart of it all.

> Belkins BirdNET is a standalone build of [**BirdNET-Pi**](https://github.com/Nachtzuster/BirdNET-Pi); the live-collage concept is inspired by [**AvianVisitors**](https://github.com/Twarner491/AvianVisitors/tree/avian-visitors). Kudos, license, and full Cornell attribution are [below](#-kudos).

<p align="center">
  <img src="docs/ui-collage.png" alt="Belkins BirdNET — the Living Gallery (nocturne theme)" width="92%" />
</p>

<p align="center">
  <img src="docs/ui-hero.png"  width="32.5%" alt="One bird, spotlit" />
  <img src="docs/ui-index.png" width="32.5%" alt="Species index" />
  <img src="docs/ui-atlas.png" width="32.5%" alt="Atlas — museum cards" />
</p>
<p align="center"><sub>The <strong>Living Gallery</strong> — a dark <em>nocturne</em> theme (with a light day theme), where every detected bird is spotlit. <strong>Collage · Index · Stats · Atlas.</strong></sub></p>

<p align="center">
  <img src="avian/assets/illustrations/turdus-migratorius.png"   height="116" alt="American Robin" />
  <img src="avian/assets/illustrations/calypte-anna-2.png"        height="116" alt="Anna's Hummingbird" />
  <img src="avian/assets/illustrations/cyanocitta-stelleri.png"   height="116" alt="Steller's Jay" />
  <img src="avian/assets/illustrations/selasphorus-rufus-2.png"   height="116" alt="Rufous Hummingbird" />
  <img src="avian/assets/illustrations/tachycineta-bicolor-2.png" height="116" alt="Tree Swallow" />
  <img src="avian/assets/illustrations/megascops-kennicottii-2.png" height="116" alt="Western Screech-Owl" />
  <img src="avian/assets/illustrations/asio-flammeus-2.png"       height="116" alt="Short-eared Owl" />
</p>
<p align="center"><sub>A handful of the 500 bundled <em>kachō-e</em> illustrations — every species ships in a perched <strong>and</strong> a flight pose.</sub></p>

---

## 🗺️ How it works

From a microphone in the window to a hand-painted bird on the wall — every arrow is real data flow.

```mermaid
flowchart LR
    classDef cap fill:#fde68a,stroke:#d97706,color:#3f2d00;
    classDef det fill:#bfdbfe,stroke:#2563eb,color:#0b2447;
    classDef sto fill:#c7f9e5,stroke:#0d9488,color:#06372b;
    classDef ill fill:#fbcfe8,stroke:#db2777,color:#4a0d2b;
    classDef disp fill:#ddd6fe,stroke:#7c3aed,color:#2a1259;
    classDef fwd fill:#fecaca,stroke:#dc2626,color:#4c0519;
    classDef frm fill:#fed7aa,stroke:#ea580c,color:#451a03;

    subgraph LISTEN [" Listen "]
        mic["USB lavalier mic"]:::cap
        rec["BirdNET-Pi recorder"]:::cap
    end
    subgraph IDENT [" Identify "]
        model["BirdNET 6K v2.4<br/>6,522 labels"]:::det
        ana["birdnet_analysis.py"]:::det
    end
    subgraph CORE [" Store + Read API "]
        db[("birds.db<br/>SQLite")]:::sto
        media["By_Date<br/>mp3 + spectrogram"]:::sto
        api["birdnet-api.php"]:::sto
        cut["cutout.php<br/>image resolver"]:::sto
    end
    subgraph ART [" Illustrate (optional) "]
        gemini["Gemini 2.5<br/>Flash Image"]:::ill
        pregen["pregen.py"]:::ill
        cutpy["cutout.py<br/>BiRefNet matte"]:::ill
        illus["500 illustrations<br/>250 species"]:::ill
    end
    subgraph SHOW [" Show "]
        ui["Collage UI<br/>apt.js"]:::disp
        web["web/ React shell"]:::disp
        cast["birdcast<br/>SSE :8090"]:::disp
        caddy["Caddy + PHP-FPM<br/>birdnet.local"]:::disp
    end
    subgraph WALL [" Wall frame "]
        bw["BirdWeather<br/>GraphQL"]:::frm
        shoot["shoot.py"]:::frm
        disp["display.py"]:::frm
        inky["Inky 13.3in<br/>e-ink Spectra-6"]:::frm
    end
    subgraph OUT [" Forward "]
        cf["Cloudflare Tunnel"]:::fwd
        ha["Home Assistant"]:::fwd
        mqtt["MQTT bridge"]:::fwd
    end

    mic --> rec -->|"WAV segment"| ana
    model --> ana
    ana -->|"detection row"| db
    ana -->|"clip + png"| media
    ana -. "emit_detected" .-> cast
    db --> api
    db --> cast
    media --> api
    illus --> cut
    gemini --> pregen --> cutpy --> illus
    api --> ui
    cut --> ui
    api --> web
    cast -. "bird.detected, under 3s" .-> web
    ui --> caddy
    web --> caddy
    caddy --> cf
    api --> ha
    api --> mqtt
    ui -->|"1200x1600 shot"| shoot
    bw --> shoot
    shoot --> disp --> inky
```

<table>
<tr>
<td align="center"><strong>500</strong><br/><sub>bundled illustrations</sub></td>
<td align="center"><strong>250</strong><br/><sub>species (perched + flight)</sub></td>
<td align="center"><strong>6,522</strong><br/><sub>BirdNET model labels</sub></td>
<td align="center"><strong>under 3s</strong><br/><sub>detection → screen</sub></td>
</tr>
<tr>
<td align="center"><strong>158</strong><br/><sub>photo-cutout fallbacks</sub></td>
<td align="center"><strong>3</strong><br/><sub>off-LAN forwarding recipes</sub></td>
<td align="center"><strong>13.3"</strong><br/><sub>Spectra-6 e-ink panel</sub></td>
<td align="center"><strong>~$70</strong><br/><sub>mic + Pi build cost</sub></td>
</tr>
</table>

<p align="center">
  <img src="docs/flock.svg" alt="" width="100%" />
</p>

---

## 🛠️ Bill of materials

| Qty | Description | Price | Link | Notes |
|-----|-------------|-------|------|-------|
| 1 | Raspberry Pi (4B / 5 / Zero 2 W) | ~$35–80 | [Amazon](https://amzn.to/43yLDZJ) | [RPi0W2 note](https://github.com/mcguirepr89/BirdNET-Pi/wiki/RPi0W2-Installation-Guide) |
| 1 | Micro SD card (≥32 GB) | ~$10 | [Amazon](https://amzn.to/4eGy7te) | |
| 1 | USB lavalier microphone | $16.95 | [Amazon](https://amzn.to/4vLSaMK) | |
| 1 | Pi power supply | ~$10 | — | |

Optional: a [Gemini API key](https://aistudio.google.com/apikey) to restyle illustrations, and an [eBird API key](https://ebird.org/api/keygen) to filter species by region.

---

## 🚀 Quickstart

### 1 · Flash the SD card

Use [Raspberry Pi Imager](https://www.raspberrypi.com/software/) → Raspberry Pi OS Lite (64-bit). In the customisation dialog set a **username**, **WiFi SSID + password**, hostname `birdnet`, and enable **SSH with password auth**. Plug the USB mic into the Pi, place the capsule in a window, and boot.

### 2 · Run the installer

> Assumes passwordless sudo (the Raspberry Pi OS Lite default).

```bash
ssh <your-username>@birdnet.local
curl -s https://raw.githubusercontent.com/Belkins/belkins-birdnet/main/newinstaller.sh | bash
```

Clones this repo, installs BirdNET-Pi, and symlinks the Belkins BirdNET overlay into the Caddy web root. Takes 20–40 minutes and reboots when done.

- **Collage:** `http://birdnet.local/`
- **Stock BirdNET-Pi UI:** `http://birdnet.local/index.php`
- The menu button (top-right) opens an admin overlay with settings, system, log, and tool panels.

### 3 · (Optional) Restyle the illustrations

The repo ships with 500 bundled illustrations. To restyle them or generate a set for your own region:

```bash
pip install -r ~/BirdNET-Pi/avian/scripts/requirements.txt
export GEMINI_API_KEY='your-key'   # image generation requires billing enabled

# generate on a cream ground → cut the ground off → rebuild the collage masks
python3 ~/BirdNET-Pi/avian/scripts/pregen.py --labels ~/BirdNET-Pi/model/labels.txt --force
python3 ~/BirdNET-Pi/avian/scripts/cutout.py
python3 ~/BirdNET-Pi/avian/scripts/build_masks.py
```

Filter to your region with `--ebird-region US-CA` (needs `EBIRD_API_KEY`). The full pipeline, prompt, reference images, and per-species tuning live in [`avian/scripts/README.md`](avian/scripts/README.md); the style lives in [`prompt.template.md`](avian/scripts/prompt.template.md).

---

## ⚡ Realtime (birdcast)

New work in this build: a stdlib **Server-Sent-Events** spine so detections paint the instant BirdNET writes them.

- [`avian/realtime/birdcast.py`](avian/realtime/) — `POST /emit` in, `GET /events` out, ~500-event replay ring buffer, reads `birds.db` read-only.
- [`web/`](web/) — a Vite + React + TypeScript collage shell that seeds from the snapshot API, subscribes to the SSE stream, and paints in each new bird (Canvas2D fade + scale, no re-pack). Runs with **no backend at all** via `npm run dev:mock`.

```bash
# on the Pi — additive, idempotent, non-destructive. Brings up the SSE spine +
# the React collage at /collage (and the auto-gen watcher below, if its env is set).
bash deploy-christina.sh
```

`deploy-realtime.sh` is the spine-only subset if you don't want the collage yet.

---

## 🎨 Auto-gen — birds that aren't in the library yet

The collage ships **250 illustrated species**. When BirdNET hears one that *isn't*
bundled, the **auto-gen watcher** generates its *kachō-e* illustration on the fly and
paints it in — no human in the loop.

```
detection → forwarder (Pi) ──HTTPS──▶ birdgen (Railway) ──▶ Gemini + cream-key cutout
                                                              │
   collage  ◀── cutout.php 302 ◀── /asset/<slug>.png  ◀───────┘   (frontend retries → paints)
```

- **[`services/birdgen/`](services/birdgen/)** — a small **FastAPI** service that deploys to **Railway**: a Bearer-auth `POST /detected` webhook, a single-flight queue, `pregen.gen_one` + the cream-key cutout, an SQLite-lease dedup state machine (`queued → generating → done/dead`), and `GET /asset/<slug>.png` off a persistent volume. The **Gemini key lives only here** — never on the Pi.
- **[`avian/realtime/forwarder.py`](avian/realtime/)** — a Pi-side daemon that subscribes to the birdcast SSE, drops bundled / low-confidence (`<0.70`) detections, and forwards genuinely-new species to Railway (plus a reconcile sweep every 6 h that heals anything the live stream missed). Holds only a rotatable webhook secret.
- **[`avian/api/cutout.php`](avian/api/cutout.php)** — with `AV_RAILWAY_ASSET_BASE` set, a long-tail miss `302`-redirects to the Railway asset (unset → unchanged behavior).
- **[`avian/realtime/railway_liveness.py`](avian/realtime/)** — a 6-hourly systemd timer that pushes a phone alert (ntfy) if the Railway service ever goes dark.
- **[`avian/api/regen.php`](avian/api/regen.php)** — the **repaint** gesture: anyone on the LAN can ask the museum to repaint a plate from the bird dossier (`repaint ↺`). The old plate stays on the wall until its replacement passes every QA gate (never-worse, atomic swap, previous plate archived to `_prev/`); presses are cooled down per species (15 min) and globally, spend is fenced by a **$6/month manual sub-budget** inside the $20 ledger, and the endpoint stays **dark until armed** with pool-env credentials (`AV_RAILWAY_API_BASE` + `AV_REGEN_SECRET` in the php-fpm pool — the secret never reaches a browser). The popup's control budget is constitutional: see [`docs/POPUP-BUDGET.md`](docs/POPUP-BUDGET.md).

```bash
# deploy the generator (needs a Railway account + a billing-enabled Gemini key)
cd services/birdgen
railway up
railway volume add -m /data/assets
railway variables set GEMINI_API_KEY=… WATCHER_WEBHOOK_SECRET=…
railway domain
# then on the Pi, wire it (same secret + the Railway URL):
CHRISTINA_RAILWAY_BASE=https://<svc>.up.railway.app \
CHRISTINA_WEBHOOK_SECRET=<secret> bash deploy-christina.sh
```

Cost: **~$0.04 per genuinely-new species**, on-demand. Generation requires a
billing-enabled Gemini key; the worker is single-flight, deduped, and degrades
gracefully — if Railway is down the collage keeps running, just without new art.

---

## 📡 Forward off your LAN

Three independent recipes in [`avian/forwarding/`](avian/forwarding/):

- **Cloudflare Tunnel** — a public HTTPS URL with no port-forwarding.
- **Home Assistant** — a REST sensor exposing the latest detection.
- **MQTT bridge** — publishes every new detection to your broker.

---

## 🖼️ Wall frame

An optional e-ink frame mirrors the last 24h of birds onto a panel by your window — in the **nocturne** or **day** theme. Build it from [`frame/`](frame/README.md). It can run off your own BirdNET mic, or **standalone from BirdWeather** for any ZIP code with no mic at all.

<p align="center">
  <img src="docs/ui-wall.png" alt="Belkins BirdNET — ambient wall mode (nocturne)" width="92%" />
</p>
<p align="center">
  <img src="docs/ui-eink.png" alt="The 13.3-inch Spectra-6 e-ink frame — day and night" width="80%" />
</p>
<p align="center"><sub>Left running on a wall screen, or printed to the 13.3" Spectra-6 e-ink frame — same composition, six inks, day <strong>or</strong> night.</sub></p>

<details>
<summary>Stock BirdNET-Pi dashboards (still there under the hood)</summary>
<br>
<p align="center">
  <img src="docs/overview.png" alt="BirdNET-Pi overview dashboard" width="48%" />
  <img src="docs/spectrogram.png" alt="Live spectrogram" width="48%" />
</p>
</details>

---

## 📂 Repo layout

```
avian/                  # everything Belkins BirdNET adds to BirdNET-Pi
├── frontend/           # static HTML/JS/CSS for the collage
├── assets/             # bundled kachō-e illustrations + photo-cutout fallbacks
├── api/                # PHP shims served by BirdNET-Pi's PHP-FPM (cutout.php 302)
├── scripts/            # generate → cutout (creamkey) → masks pipeline + prompt
├── realtime/           # birdcast SSE spine + forwarder + liveness monitor
└── forwarding/         # optional HA / MQTT / Cloudflare configs
web/                    # next-gen React + TS collage shell (live SSE)
services/birdgen/       # Railway: on-demand kachō-e generator (Gemini + cream-key)
frame/                  # optional e-ink wall display
deploy-christina.sh     # one-shot full-stack deploy on the Pi (spine + collage + watcher)
```

Everything outside `avian/`, `web/`, `services/`, and `frame/` is upstream BirdNET-Pi.

---

## 🙏 Kudos

Belkins BirdNET stands on the work of others:

- [**AvianVisitors** by Twarner491](https://github.com/Twarner491/AvianVisitors/tree/avian-visitors) — the original live-collage idea, the *kachō-e* bird treatment, and the overlay this build grew from. Thank you for the inspiration. 🐦
- [**BirdNET-Pi**](https://github.com/Nachtzuster/BirdNET-Pi) (Nachtzuster · Patrick McGuire) — the recording + detection foundation.
- The [**K. Lisa Yang Center for Conservation Bioacoustics, Cornell Lab of Ornithology**](https://www.birds.cornell.edu/ccb/) — the BirdNET model itself.

---

## 📜 License

CC-BY-NC-SA-4.0, inherited from [BirdNET-Pi](https://github.com/Nachtzuster/BirdNET-Pi/blob/main/LICENSE). **Non-commercial use only.** See the [BirdNET-Pi README](https://github.com/Nachtzuster/BirdNET-Pi/blob/main/README.md) for full Cornell attribution.

> BirdNET-Lite and the BirdNET model are © the **K. Lisa Yang Center for Conservation Bioacoustics, Cornell Lab of Ornithology**. BirdNET-Pi is © Patrick McGuire. Belkins BirdNET is a derivative work distributed under the same CC-BY-NC-SA-4.0 terms — see [`LICENSE`](LICENSE).

---

<p align="center">
  <img src="docs/flock.svg" alt="" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/Belkins/belkins-birdnet/fork">Fork</a> ·
  <a href="https://github.com/Belkins/belkins-birdnet/subscription">Watch</a> ·
  <a href="https://github.com/Belkins/belkins-birdnet/issues/new">Open an issue</a>
</p>

<p align="center"><sub>Made by Belkins · inspired by <a href="https://github.com/Twarner491/AvianVisitors/tree/avian-visitors">AvianVisitors</a> · built on the shoulders of BirdNET-Pi and the Cornell Lab of Ornithology.</sub></p>
