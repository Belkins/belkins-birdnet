# birdgen — Railway on-demand bird generation service

Phase A of the auto-gen watcher. When BirdNET-Pi first hears a species that is
**not** in the bundled 250-illustration set, a Pi-side forwarder POSTs it here;
this service generates exactly one perched (pose-1) kachō-e illustration, keys it
to a transparent PNG, QA-gates it, and serves it from a persistent volume so the
live collage can paint it in.

The LOCKED behavioral contract is `_plan/auto-gen-watcher/CONTRACT.md`. This
service obeys it exactly; any change here is a coordinated change with the Pi
forwarder.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET`  | `/health`        | none   | `{ok, queue_depth, done_count}` |
| `GET`  | `/manifest`      | none   | `{slugs:[...]}` = bundled ∪ generated (single dedup SoT) |
| `GET`  | `/asset/<slug>.png` | none | serve the transparent PNG; 404 if not generated yet |
| `POST` | `/detected`      | Bearer | enqueue a first-hearing; dedup + conf gate + rate-limit |

### `POST /detected`
- Header: `Authorization: Bearer <WATCHER_WEBHOOK_SECRET>` (else `401`).
- In-memory token-bucket rate-limit (else `429`).
- Body: `{"sci":"Apus apus","com":"Common Swift","slug":"apus-apus","conf":0.93}`
  (extra fields like `v`/`type`/`cursor` are accepted and ignored).
- `conf < 0.80` → `{"status":"low_confidence"}`.
- Dedup against the authoritative SQLite terminal state on the volume:
  - already generated/`done` → `{"status":"cached"}`
  - `queued`/`generating` → `{"status":"in_progress"}`
  - terminally `dead` (un-generatable) → `{"status":"dead"}`
  - in the bundled manifest → `{"status":"bundled"}`
  - otherwise → insert `queued`, enqueue, `{"status":"queued"}`

## Generation pipeline (single-flight worker)

`dequeue → mark generating → pregen.gen_one(sci, com, pose=1) → creamkey cutout
→ QA gate (opaque fraction ∈ [0.015, 0.75]) → atomic save /data/assets/<slug>.png
→ mark done`. **pose-1 only** (generating flight is wasted spend per the contract).

- `MIN_SPACING = 6s` between Gemini calls (re-instates pregen's inter-call spacing
  that `main()` did and direct `gen_one` calls bypass).
- `gen_one` does the per-call exponential backoff on `429/5xx` internally; the
  worker adds job-level exponential backoff on failure (15m → 30m → 60m, capped 6h).
- **4 consecutive failures → `dead`** (terminal; never auto-retried). A clear
  Gemini `SAFETY` block is marked `dead` immediately.
- QA failure → `dead` per spec; the PNG is **not** published.

## Environment variables

| Var | Required | Default | Notes |
|---|---|---|---|
| `GEMINI_API_KEY` | **yes** | — | paid Gemini key; sent via `x-goog-api-key` header, **never logged** |
| `WATCHER_WEBHOOK_SECRET` | **yes** | — | Bearer secret the Pi holds; low-value, rotatable |
| `CONF_THRESHOLD` | no | `0.80` | confidence gate |
| `MIN_SPACING` | no | `6` | seconds between Gemini calls |
| `MAX_ATTEMPTS` | no | `4` | consecutive fails → dead |
| `QA_MIN_FRAC` / `QA_MAX_FRAC` | no | `0.015` / `0.75` | creamkey opaque-fraction QA band |
| `ASSETS_DIR` | no | `/data/assets` | volume mount (set by the Dockerfile) |
| `FETCH_REFS` | no | `1` | fetch+cache the Wikipedia anatomy reference per species |
| `AV_STYLES_DIR` | no | unset | optional Edo kachō-e style-print dir (not bundled) |
| `PORT` | no | `8000` | injected by Railway |

## Storage / deploy

- Railway **volume mounted at `/data/assets`**. PNGs at `/data/assets/<slug>.png`;
  SQLite lease at `/data/assets/state.db`; cached Wikipedia refs under
  `/data/assets/_refs/`.
- **`numReplicas = 1`** — the single-flight worker, single-attach volume,
  in-memory rate-limiter, and in-memory wakeup queue all assume one instance.

```
# build + run locally (writes to ./_localdata)
docker build -t birdgen .
docker run -p 8000:8000 \
  -e GEMINI_API_KEY=... -e WATCHER_WEBHOOK_SECRET=devsecret \
  -e ASSETS_DIR=/data/assets -v "$PWD/_localdata:/data/assets" birdgen
```

## Notes / known limitations

- `pregen.py`, `creamkey.py`, `prompt.template.md`, `species-notes.json` are
  **verbatim copies** of the `avian/scripts/` originals — keep them in sync.
- Style references and anti-references are **not bundled** (the contract's copy
  list is the 4 files above). The service still fetches the per-species Wikipedia
  anatomy reference at runtime; if you want the Edo style prints / Blue-Jay /
  Barn-Swallow anti-refs, mount them and set `AV_STYLES_DIR` (+ `ANTI_DIR`).
  Output quality is lower without the style ref than the offline `pregen.py` run.
