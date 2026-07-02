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
| `GET`  | `/health`        | none   | `{ok, queue_depth, done_count, month_spend_usd, budget_usd, gens_this_month, verifies_this_month, budget_exhausted}` (spend fields are ops-only ESTIMATES — never surface them on the frontend) |
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
| `AV_STYLES_DIR` | no | `services/birdgen/styles` | curated house-plate style set, **BUNDLED + on by default**; override to mount the real Edo prints, or set empty to disable the style lock |
| `AV_VERIFY` | no | `1` | adversarial ID/anatomy gate (one extra Gemini-Vision call per gen); **on by default** now that the reject loop is bounded; set `0` to disable |
| `AV_VERIFY_MAX_REJECTS` | no | `3` | per-species verify-reject budget before accept-with-flag (keep `< MAX_ATTEMPTS`) |
| `COST_PER_VERIFY_USD` | no | `0.002` | estimated per-verify Gemini cost (feeds the spend ledger estimate) |
| `MONTHLY_BUDGET_USD` | no | `20` | soft ceiling on ESTIMATED month spend; `0` = unlimited; when crossed, gen pauses + species stay queued (auto-resumes next UTC month or on a raise) |
| `PORT` | no | `8000` | injected by Railway |

## Storage / deploy

- Railway **volume mounted at `/data/assets`**. PNGs at `/data/assets/<slug>.png`;
  SQLite lease at `/data/assets/state.db`; the persistent spend ledger at
  `/data/assets/gen-ledger.json`; cached Wikipedia refs under `/data/assets/_refs/`.
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

- `creamkey.py`, `prompt.template.md`, `species-notes.json` are **verbatim copies**
  of the `avian/scripts/` originals — keep them in sync. `pregen.py` **intentionally
  diverges** from `avian/scripts/pregen.py`: a prior defensive-titles fix, plus the
  `STYLE_REFS` remap described below. Do **not** mirror these back into `avian/` —
  the divergence is deliberate and documented here.
- **Style references are now BUNDLED + on by default.** A curated set of 8 of the
  project's own house plates ships at `services/birdgen/styles/` (downscaled copies
  of `avian/assets/illustrations/` cutouts, ~512px long side), and `STYLE_REFS` maps
  every genus/pose to one of them — so the style lock is attached to every auto-gen.
  The original Edo kachō-e prints (Koson/Yoshida) are not redistributable / in this
  repo; mount them on a volume and point `AV_STYLES_DIR` at it to override, or set
  `AV_STYLES_DIR=` (empty) to disable the lock. This is a self-referential bootstrap
  (the plates were themselves largely generated style-less), so it locks in the
  CURRENT house look — the de-facto canon every new species must match.
- **Anti-references are still NOT bundled.** `ANTI_DIR` defaults to `REFS_DIR`, and
  `_anti_bluejay.jpg` / `_anti_barnswallow.jpg` are absent, so the Blue-Jay /
  Barn-Swallow collapse guards are inert in production. Mount those files and set
  `ANTI_DIR` to reactivate them (follow-up; the jpg-only naming loses PNG alpha).
