# Realtime spine (`birdcast`)

The Phase-0 realtime layer that paints a new BirdNET detection onto the collage
**< ~3s after the DB write**, with no full-page reload. It is purely additive:
`birds.db`, the detection pipeline, the `By_Date` filesystem, and the PHP read
API are all untouched. The only change to the pipeline is one guarded,
fire-and-forget line.

## What's here

| File | What it is |
|------|------------|
| `birdcast.py` | Standalone asyncio SSE service. Receives detections on `POST /emit`, fans them out as Server-Sent Events on `GET /events`, replays gaps via the SQLite `rowid` cursor (ring buffer -> read-only DB tail). stdlib only. |
| `birdcast.service` | systemd unit (mirrors `avian/forwarding/avian-mqtt.service`). |
| `caddy-events.snippet` | The `reverse_proxy /events` block to add to the Caddyfile, above `php_fastcgi`. |

The emit side lives in the backend tree:

| File | What it is |
|------|------------|
| `scripts/utils/realtime.py` | `emit_detected(detection)` -- guarded, non-blocking. Pushes onto a queue drained by one daemon thread that `POST`s to `127.0.0.1:8090/emit` with a 0.25s timeout. A down/slow service costs the detection loop nothing. |
| `scripts/birdnet_analysis.py` | ONE additive line: `emit_detected(detection)` right after `write_to_db(...)` in the reporting worker, inside the existing try/except. |

## The event (LOCKED contract)

SSE frame on `/events`:

```
event: bird.detected
id: 48217
data: {"v":1,"type":"bird.detected","cursor":48217,"sci":"Cyanocitta cristata","com":"Blue Jay","slug":"cyanocitta-cristata","conf":0.91,"conf_pct":91,"iso8601":"2026-06-30T14:03:22-07:00","date":"2026-06-30","time":"14:03:22","week":27,"file":"Blue_Jay-91-2026-06-30-birdnet-14:03:22.mp3"}
```

On connect, the first frame is always:

```
event: hello
data: {"v":1,"type":"hello","cursor":<high-water rowid>}
```

- `slug = re.sub(r"[^a-z0-9]+","-", sci.lower()).strip("-")` -- identical across
  Python / PHP / JS. The frontend resolves the image via the unchanged
  `cutout.php?sci=<sci>&pose=1`.
- `cursor` / `id` = SQLite implicit **`rowid`** (monotonic). On reconnect the
  browser's `EventSource` automatically sends `Last-Event-ID: <rowid>`; the
  service replays newer events from its in-memory ring buffer (~500), falling
  back to a **read-only** `SELECT rowid,* FROM detections WHERE rowid > :since`
  against `birds.db`.

## Run locally on a Mac (no Pi, no DB)

```bash
cd "avian/realtime"
python3 birdcast.py --mock --port 8099
```

`--mock` synthesizes a `bird.detected` every ~4s, cycling real species slugs
derived from `avian/assets/illustrations/*.png` (the `-2` alt-pose suffix is
stripped). No `birds.db` required.

Watch the stream:

```bash
curl -N -s http://127.0.0.1:8099/events
```

You should see the `hello` frame immediately, then a `bird.detected` frame
every few seconds. `curl http://127.0.0.1:8099/health` returns a small JSON
liveness blob.

To drive the React app off this service instead of its built-in mock, set
`VITE_MOCK=0` and `VITE_EVENTS_URL=http://127.0.0.1:8099/events` in `web/`.

## Done-when test (the Phase-0 gate)

1. `python3 -m py_compile scripts/utils/realtime.py scripts/birdnet_analysis.py avian/realtime/birdcast.py` -> no output (all compile).
2. Start `python3 avian/realtime/birdcast.py --mock --port 8099`.
3. `curl -N -s --max-time 6 http://127.0.0.1:8099/events | head -20` shows the
   `hello` frame **and** at least one `event: bird.detected` frame with a valid
   `data:` JSON line.

Manual emit sanity check (live mode, no DB needed for ingest):

```bash
python3 avian/realtime/birdcast.py --port 8099 &
curl -s -XPOST http://127.0.0.1:8099/emit \
  -H 'Content-Type: application/json' \
  -d '{"sci":"Cyanocitta cristata","com":"Blue Jay","conf":0.91}'
# -> {"ok":true,"cursor":<n>}; any open /events client receives the frame.
```

## Deploy on the Pi

```bash
# 1. Put the service in the user's home (mirrors the mqtt-bridge recipe).
cp ~/BirdNET-Pi/avian/realtime/birdcast.py ~/birdcast.py

# 2. Install + start the systemd unit.
sudo cp ~/BirdNET-Pi/avian/realtime/birdcast.service /etc/systemd/system/
# Edit /etc/systemd/system/birdcast.service: set User= to your account.
sudo systemctl daemon-reload
sudo systemctl enable --now birdcast

# 3. Route /events through Caddy (above the php_fastcgi catch-all).
#    Paste avian/realtime/caddy-events.snippet into each site block in
#    scripts/update_caddyfile.sh, then re-run it (or edit the Caddyfile) and:
sudo systemctl reload caddy
```

The analysis process already emits to `127.0.0.1:8090/emit` via the hook -- no
extra wiring. Restart `birdnet_analysis` once so it picks up the new import:
`sudo systemctl restart birdnet_analysis`.

## Environment variables

| Var | Used by | Default |
|-----|---------|---------|
| `AV_BIRDS_DB` | `birdcast.py` | tries `scripts/birds.db` then `~/BirdNET-Pi/scripts/birds.db` |
| `AV_BIRDCAST_URL` | `realtime.py` (emit) | `http://127.0.0.1:8090/emit` |
| `AV_BIRDCAST_TIMEOUT` | `realtime.py` (emit) | `0.25` (seconds) |

Flags: `birdcast.py --host --port --mock --verbose`.

## Refusals honored

- `birds.db` schema and the detection writer are never modified. The emit is a
  single additive, guarded, fire-and-forget call.
- `birdcast` opens `birds.db` **read-only** (`mode=ro`) with a `busy_timeout`,
  and only for cold-start high-water seeding + reconnect gap-fill -- never on
  the hot broadcast path.
- No secrets in the tree. `/emit` is loopback-only and never proxied by Caddy.
- Mock data is gated strictly behind `--mock`; the prod path never fabricates.

## Not in Phase 0 (deliberately deferred)

- The slow `MAX(rowid)` crash-safety backstop tick (recovers POSTs dropped
  while the service was down). Reconnect already covers this via the read-only
  DB tail; the backstop is a Phase-1 belt-and-suspenders.
- `isNewSpecies` / repaint-cooldown dedup and the WebGL ink-shader paint are
  Phase 1 (the frontend's Canvas2D fade/scale is the Phase-0 reveal).
