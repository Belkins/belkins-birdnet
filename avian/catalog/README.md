# Species catalog — `christina.db`

`rebuild_catalog.py` derives **`christina.db`** (and **`species.json`**) from the
BirdNET-Pi **`birds.db`** detection log. It is the **naming + timestamp +
art-state authority** behind *"the birds we're tracking"* — the small, indexed
projection the collage / API read instead of re-aggregating raw detections on
every request.

## What / why

`birds.db` is an append-only firehose of `detections` rows. The collage needs
the *opposite* shape: one row per **species**, with first/last timestamps,
counts, confidence, and whether we have art for it. `christina.db` is that
shape — **disposable and fully rebuildable**. No state lives outside
`birds.db` + the on-disk art inventory, so you can `rm christina.db` at any time
and the next build reconstructs it exactly.

- **Read-only over `birds.db`.** Opened `file:…?mode=ro` + `PRAGMA query_only`.
  The builder never writes or migrates the source. (Tested: size/mtime/sha256
  unchanged; no `-wal`/`-journal` side files.) As an extra guard it **refuses to
  run when `--out` resolves to the same file as `--birds`** — the final
  `os.replace()` is the one path that could overwrite `birds.db`, and `birds.db`
  (unlike `christina.db`) is irreplaceable.
- **stdlib only.** `sqlite3, json, os, re, argparse, urllib, hashlib, datetime`.
  No pip install — it runs on the Pi.
- **Atomic.** Rows go to `christina.db.tmp`, then `os.replace()` → `christina.db`.
  Readers never see a half-built catalog. `species.json` is written the same way.

## Identity / naming (locked)

- **Primary key = `Sci_Name`.** Scientific names are stable across BirdNET
  versions and locales; common names drift, so they are *derived*, not keyed on.
- **`slug = slugify(Sci_Name)`** — lower-case, every run of non-alphanumerics →
  `-`, ends trimmed. This is the **existing bundled-asset convention**
  (`avian/assets/illustrations/cyanocitta-cristata.png`,
  `services/birdgen/manifest.json` `slugs[]`), identical to the slug contract in
  `avian/realtime/birdcast.py`. The slug is stored explicitly so there is one
  binding: `sci_name → slug → asset`. (NB: this deliberately keys on `Sci_Name`,
  not `Com_Name` — a common-name slug like `american-robin` would never bind to
  the bundled `turdus-migratorius.png`. The CONTRACT's "default = slugify(Com_Name)"
  clause is stale; disk, the manifest, and `birdcast.py` all use `Sci_Name`.)
- **`birdnet_label = "<Sci_Name>_<Com_Name>"`** — the canonical BirdNET label.
  When `Com_Name` is NULL it falls back to `"<Sci_Name>_<Sci_Name>"`; the stored
  `is_bird` column is authoritative, never re-derive `is_bird` from the label.
- **`CONFIDENT_THRESHOLD = 0.80`** (the catalog's own confident-*detection* bar
  for derived stats; independent of the paint gate — the forwarder/birdgen pair
  moved to 0.70 in 987d9da, so these deliberately no longer match):
  - `first_detected` = MIN(`Date Time`) over **all** rows,
  - `first_confident` = MIN(`Date Time`) over rows with `Confidence ≥ 0.80`,
  - `last_detected` = MAX(`Date Time`).
- **`is_bird`** = 1 iff `Sci_Name` contains a space **and** `Sci_Name != Com_Name`
  **and** it is not a known BirdNET non-bird class. `genus = Sci_Name.split()[0]`
  for birds, else `NULL`. The `NON_BIRD` override set is the **only** guard for
  non-bird classes that the structural rule misses, i.e. those whose `Sci_Name`
  contains a space *and* can differ from `Com_Name`:
  - the multi-word anthropogenic classes (`Power tools`, the `Human *` variants);
  - the two BirdNET V2.4 **cricket binomials** `Gryllus assimilis` /
    `Miogryllus saussurei`, whose **common name several shipped locales
    translate** (de `Steppengrille`, fr `Grillon des steppes`, …). On a
    non-English Pi `birds.db` then stores `Sci != Com` with a space, so without
    the override the cricket would be published as a bird. The set is load-
    bearing the moment `DATABASE_LANG != en`, not merely a rare safety net.

## Art status (derived by scan — never hand-maintained)

Same anti-drift discipline as the sudoers fix: the truth is computed from what
is on disk, not a maintained list.

1. The species' `slug` matches a file in the bundled-art dir →
   `art_source='bundled'`, `art_status='ready'`, `poses` = the pose numbers
   found (`<slug>.png` → `"1"`, `<slug>-2.png` → `"2"`).
2. Else, if `--manifest-url` is given and the slug is in the birdgen manifest
   (but not local) → `art_source='autogen'`, `art_status='ready'`.
   **Network-guarded:** any failure (unreachable, timeout, bad JSON) is skipped
   silently — the manifest never fails the build.
3. Else → `art_status='none'`. **Every** species is cataloged, art or not; the
   collage decides what to show.

## Output schema

`species` (PK `sci_name`): `com_name, slug, birdnet_label, genus, is_bird,
first_detected, first_confident, last_detected, detection_count,
confident_count, max_confidence, art_status, art_source, poses`.
Rollups: `daily_counts(sci_name,date,n)`, `hour_buckets(sci_name,hour,n)`,
`week_species(sci_name,week,n)`. `meta(key,value)`: `built_at`, `source_rows`,
`schema_version`.

`species.json` (beside `christina.db`): **birds only**, sorted by
`first_confident` then `com_name`; fields `sci_name, com_name, slug,
first_confident, last_detected, detection_count, art_status`. Never-confident
birds (`first_confident` NULL) sort last. Compact JSON.

## Reproducibility / cold start

The core build logic uses **no wall-clock**: `--built-at` is injectable, so two
runs on identical inputs produce identical `species`/rollup rows and a
byte-identical `species.json` (only `meta.built_at` varies). Omit `--built-at`
and the CLI stamps "now (UTC)" — used by the live nightly build. **Cold start:**
on a fresh Pi with an empty `birds.db` (0 rows), the build still succeeds and
writes an empty catalog (exit 0) — nothing downstream has to special-case
"catalog not built yet".

## CLI

```
python3 rebuild_catalog.py \
  --birds  <birds.db>        # default: <repo>/scripts/birds.db (read-only)
  --out    <christina.db>    # default: <repo>/scripts/christina.db
  --assets <dir>             # default: <repo>/avian/assets/illustrations
  [--manifest-url URL]       # optional, best-effort, network-guarded
  [--manifest-timeout 3.0]
  [--built-at ISO]           # omit -> now (UTC); supply -> reproducible build
```

Paths default to the Pi layout relative to the script (`repo = two dirs up`),
or `CHRISTINA_BIRDS_DB` / `AV_BIRDS_DB` for `birds.db`. The CLI **exits 2**
without running if `birds.db` is missing **or** if `--out` resolves to the same
file as `--birds`.

## Install on the Pi (systemd)

```bash
sudo cp avian/catalog/catalog.service /etc/systemd/system/
sudo cp avian/catalog/catalog.timer   /etc/systemd/system/
# edit User= / the ExecStart path if BirdNET-Pi isn't at /home/birdnet/BirdNET-Pi
sudo systemctl daemon-reload
sudo systemctl enable --now catalog.timer
sudo systemctl start catalog.service      # build once now
systemctl list-timers catalog.timer
```

`catalog.service` is a `Type=oneshot`; `catalog.timer` fires nightly at
`03:30` **and** 2 min after boot (`Persistent=true` catches up a missed run).
The unit names don't collide with the existing units (`birdcast`, `forwarder`,
`avian-mqtt`, `railway-liveness`, `birdframe`, `birdnet_*`).

## Tests

```bash
# from avian/catalog/ (where this README lives)
python3 -m unittest discover -s tests -v
# equivalently, since tests/ is a package:
#   python3 -m unittest tests.test_catalog -v
```

> The bare `python3 -m unittest` run from `avian/catalog/` only finds these
> tests because `tests/__init__.py` makes the subdir a package; the explicit
> `discover -s tests -v` form above is CWD-robust and is what any CI / `make
> test` gate must call. (A bare `python3 -m unittest` from `avian/catalog/`
> with **no** `tests/__init__.py` discovers nothing and falsely prints
> "Ran 0 tests … OK" — the green gate must not depend on that.)

`tests/test_catalog.py` builds a fixture `birds.db` in a tmp dir and asserts the
specific computed values: first-detected vs first-confident split; non-bird
exclusion via **both** the `Sci_Name==Com_Name` path (Dog) **and** the multi-word
`NON_BIRD` override (a locale-translated cricket binomial + `Power tools`);
daily/hour/week rollups; art-status by scan + autogen-via-manifest; `species.json`
**sort order** and **exact row shape/values** (no field leakage, no aliasing);
`pick_com` drift disambiguation; `birdnet_label` (incl. the NULL-`Com_Name`
fallback); idempotency (two builds identical); read-only over `birds.db`;
**refusal when `--out == --birds`**; the empty-db cold start; and NULL `Com_Name`
/ text-`Confidence` handling.

## Refusals

Never writes or migrates `birds.db`; refuses to run if `--out` resolves to it.
No third-party Python deps. `christina.db` is throwaway-derived — rebuild it,
don't back it up. `art_status` is computed by scanning disk, never a maintained
list.
