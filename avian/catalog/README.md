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

## Accession-clip protection — `disk_check_exclude.txt`

A species is given a **permanent, never-renumbered accession number** the first
time it earns a confident (≥ 0.80) detection. Nothing protected the *recording*
that earned it. BirdNET species precision tops out around 82–86 %, so that
3-second clip is the only thing that can ever adjudicate whether plate No. 17 is
real — purge it and the plate becomes unfalsifiable forever.

After both authorities are on disk (the ledger, then `species.json`), the build
re-derives each accessioned species' **first-confident** clip path and appends
it — plus its `.png` spectrogram sibling — to the BirdNET-Pi exclude file.

- **Line shape: `<Date>/<Com_Name_safe>/<File_Name>`**, plus `…/<File_Name>.png`.
  `disk_check.sh:23` matches with `grep -qxFe "$i"` where `$i` comes from
  `for i in */*/*` after `cd ${EXTRACTED}/By_Date/` — a **full-line** match on a
  By_Date-**relative** path. A leading slash or an unsanitised common name
  silently protects nothing. Sanitisation is copied character-for-character from
  `scripts/utils/classes.py:22` (apostrophes deleted, spaces → `_`), the function
  that actually named the directory. All **three** segments are kept:
  `disk_species_clean.sh:67` greps `-vFf` with **no `-x`** (substring), so a
  shortened form would over-protect and disable the species cap.
- **First-confident, never max-confidence.** `stats.php` already auto-protects
  each species' best-ever clip (`common.php:131-146`, `GROUP BY` + `MAX`).
  Pinning that row again would be a silent no-op that looks like a fix.
- **Pins go strictly AFTER `##end`.** `stats.php:216` regenerates everything from
  `##start` up to `##end` on every Species Stats render, and `disk_check.sh:13`
  curls that page **itself**, seconds before purging. A pin above `##end` is
  destroyed seconds before it is read.
- **The file is never created by the build.** It is gitignored runtime state
  (`.gitignore:39` `scripts/*.txt`), written by the PHP UI (`play.php:45`,
  `stats.php:17`) as user `caddy`. **Verified: while it is absent, BOTH purges
  are no-ops** — `grep -qxFe … <missing>` returns 2 so `disk_check.sh:14` exits,
  and `disk_species_clean.sh:67`'s `grep -vFf <missing>` errors and deletes
  nothing. Creating it would *arm* two dormant purges, so the build refuses,
  prints `UNPROTECTED` with the exact command, and leaves the decision to the
  operator (see the pre-arm gate below).
- **Sentinels:** no `##start` → refuse (a render then truncates the file
  anyway). No `##end` → **self-heal** by appending it; `stats.php` only
  regenerates the region above it, and the no-`##end` state reproduces itself on
  every render, so a permanent refusal would leave it broken for good.
- **Never a blank line.** `disk_species_clean.sh:67` treats an empty pattern as
  matching every path, silently disabling the whole `MAX_FILES_SPECIES` purge —
  it fails *safe*, so nothing alerts and the disk fills instead. Pre-existing
  blanks are warned about, never removed (that region is `stats.php`'s).
- **Write target = the CONSUMERS' path**, `$CHRISTINA_DISK_EXCLUDE` else
  `~/BirdNET-Pi/scripts/disk_check_exclude.txt` — *not* derived from `--out`.
  The two coincide only while the checkout is literally `~/BirdNET-Pi`; anywhere
  else, deriving from `--out` would write a perfectly-formed file into a
  directory no consumer opens and still print a success line. A divergence is
  printed, never assumed.
- **Mode is carried over** on the atomic `tmp` + `os.replace`. The file is
  co-owned: the PHP UI writes it as `caddy`, this builder runs as `belkins`, and
  `os.replace` needs only *directory* write permission — so a naked replace
  seizes it and `stats.php`'s `file_put_contents` then fails in total silence
  (`stats.php:8-9` suppresses errors). When the owner differs the mode is
  widened for group+other and the fact is stated on stderr.
- **Append-only, idempotent, never stats the filesystem, never fails the build.**
  Removal belongs to `play.php`'s unlock UI. An already-purged clip is pinned
  anyway: the line costs nothing and is exactly what a later restore needs
  already in place. Every failure path is loud on stderr and returns 0 —
  `catalog.service`'s 0/3 contract must stay meaningful.
- **The counts are on `main()`'s stdout line**: `clips_pinned=<n>
  clips_refused=<n>`, reported as **state, not delta**, so `journalctl -u
  catalog` can tell "all 36 protected" from "refused, wrote nothing". A delta of
  0 is ambiguous; the state is not.

**Timing (verified):** `catalog.timer` fires at 03:30; the species purge runs at
02:00 (`templates/cleanup.cron:4`). A clip first confirmed after 03:30 is seen by
one 02:00 purge before its first pin — harmless, because
`disk_species_clean.sh` unconditionally spares anything from the last 7 days by
filename date. `disk_check.sh` has no such grace but deletes oldest-first, and a
brand-new clip is the newest.

**BLOCKING pre-arm gate (run on the Pi, before creating the file):** creating
`disk_check_exclude.txt` switches on two purges that are currently inert, and it
cannot be undone after the deletions happen.

```bash
ls -l ~/BirdNET-Pi/scripts/disk_check_exclude.txt
grep -E 'MAX_FILES_SPECIES|PURGE_THRESHOLD|FULL_DISK' /etc/birdnet/birdnet.conf
for d in ~/BirdSongs/Extracted/By_Date/*/*/; do
  echo "$(ls "$d" | grep -c mp3) $d"
done | sort -rn | head
# Only if NO species exceeds MAX_FILES_SPECIES (raise it, or disable
# disk_species_clean, first — Robin alone has ~1385 detections):
printf '##start\n##end\n' > ~/BirdNET-Pi/scripts/disk_check_exclude.txt
```

After the next nightly run, `journalctl -u catalog.service -n 30` should show
`clips_pinned=<accession count>` `clips_refused=0` and no `UNPROTECTED` line, and
the exclude file should have grown by up to 2× the number of accessions, all
lines **after** `##end`.

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

## Per-year phenology ledger — `phenology.json`

`christina.db`'s `week_species(sci_name, week, n)` has **no year component**: a
2026 and a 2027 detection in the same ISO week sum into one cell that can never
be separated again. And every artefact above is rebuilt wholesale each night from
live rows — so the moment rows leave `birds.db`, that period's phenology is gone.

`phenology.py` is the answer: a **standalone stdlib sibling of `derive.py`**
(second read-only pass over `birds.db`, own JSON artefact in `scripts/`, own
exit code) that writes one entry per **(species, calendar year)** and **freezes**
it once the year closes. Same durability class as `accessions.json`. It runs as
**`nightly.sh`'s third step** — `catalog.timer` already fires it, no new unit.

**Entry shape:** `sci_name, com_name, slug, year, first_heard, last_heard,
days_heard, detections, peak_week, peak_week_n` plus provenance
`source_rows_at_freeze, min_date_seen, frozen_at`. The payload carries
`version, built_at, current_year, source_rows, species_years, coverage
{min_date, max_date, source_rows, years}, notes, entries`.

**The freeze rule.** `current_year` comes from the **data's** latest Date, never
the wall clock. A `(sci, year)` already in the ledger with `year < current_year`
is kept **byte-for-byte**; the open year is recomputed every run (freezing it
would freeze the ledger the day it was created); an entry whose rows have left
`birds.db` entirely is kept **verbatim, never deleted** — that case *is* the
point.

**The two clamps** (both verified, both load-bearing):

- `date(2026,12,28).isocalendar() == (2026, 53, 1)` — ISO week 53 exists and 2026
  has one. `web/src/almanac.ts:113` renders **52** cells and already folds 53
  into 52, so `MAX_ISO_WEEK = 52`; the ledger must agree with the renderer that
  already shipped.
- `date(2024,12,30).isocalendar() == (2025, 1, 1)` — the ISO year disagrees with
  the calendar year at every boundary. **A min/max clamp alone does not fix
  this**: week 1 is already in range, so 30 December would file under "week 1"
  and an `isocalendar()[0]` year would empty December out of 2024. So the year is
  always `date.year`, and a disagreeing date is pulled to the matching **end** of
  its own calendar year — 52 for late December, 1 for early January
  (`date(2021,1,1)` is ISO `(2020, 53, 5)`). `min(52, max(1, w))` applies only to
  the ordinary cases.

**Provenance, because a frozen year is unfalsifiable.** Its rows are gone, so
`days_heard: 4` would otherwise read as a scientific fact forever. An entry whose
`min_date_seen` is `2026-11-04` is visibly a **stump** — a partial year frozen on
first deployment — not a season, and `coverage` bounds what the run could
possibly have known.

**Failure behaviour (deliberately unlike `_load_accessions`).** A **missing**
ledger is a clean first run. A ledger that **exists but is unreadable / not JSON
/ wrong-shaped** fails **loud: exit 5, writes nothing.** `_load_accessions` can
safely degrade to empty because accessions re-derive from rows that are still
there; phenology's whole value is rows that are **gone**, so a silent reset is
strictly worse than a crash. Zero scanned rows while the ledger is non-empty is
also exit 5 — the death of the source must not be reported as success. A missing
`birds.db` is exit 0 (nothing to freeze).

```
python3 phenology.py \
  --birds  <birds.db>        # default: <repo>/scripts/birds.db (read-only)
  --out    <phenology.json>  # default: <repo>/scripts/phenology.json
  [--built-at ISO]           # omit -> now (UTC); supply -> reproducible output
  [--dry-run]                # print the summary, write nothing
```

Exit codes: **0** ok (or skipped: no `birds.db`), **5** failed. `nightly.sh`
passes 5 through as its lowest-priority branch, so no pre-existing exit code
changes meaning. **Nothing on the Pi watches `catalog.service`** (unlike
`mic-watch` / `railway-liveness`), so a persistently red unit is visible only in
`systemctl --failed` and the journal — check it after deploying.

**Size:** ~15 KB/year at 47 species with `indent=2`, and nothing is ever deleted.
Fine for a decade; worth knowing, not worth mitigating.

**HANDOFF (irreplaceable, not yet backed up):** `scripts/phenology.json` is
irreplaceable for the same reason `accessions.json` is and **must** be added to
the off-box backup set. This change deliberately does not touch
`backup-accessions.sh` or `catalog.service`.

**First-run loss is already in progress:** the ledger can only freeze what
`birds.db` still holds the night it first runs. Every day this sits undeployed is
a day of phenology that may already be unrecoverable. This is *not* "done" until
it has run on the Pi.

**Tests:** `tests/test_phenology.py`.

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

`tests/test_phenology.py` covers the per-year ledger: both December clamps, the
year boundary split, the freeze rule against a **partially** purged year (a full
purge is the easy case), the open year still refreshing, byte-identical reruns,
a corrupt ledger failing loud without writing, a missing ledger as a clean first
run, provenance/coverage, non-bird exclusion, and read-only over `birds.db`.

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
