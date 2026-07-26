#!/usr/bin/env python3
"""rebuild_catalog -- derive christina.db (the species catalog) from birds.db.

christina.db is a *disposable, fully-rebuildable* projection of the BirdNET-Pi
``detections`` table. It is the naming + timestamp + art-state authority behind
"the birds we're tracking" -- the thing the collage / API read instead of
re-aggregating raw detections on every request.

Design constraints (LOCKED -- see avian/catalog/README.md):
  * stdlib only (sqlite3, json, os, re, argparse, urllib, hashlib, datetime).
    No third-party deps -- it runs on the Pi as a systemd oneshot.
  * birds.db is opened READ-ONLY (``mode=ro``). It is NEVER written or migrated.
    The build also REFUSES to run when ``--out`` resolves to the same file as
    ``--birds`` -- the final ``os.replace()`` is the only birds.db mutation
    vector, and birds.db (unlike christina.db) is irreplaceable.
  * The core logic uses NO wall-clock: ``--built-at`` is injectable so two runs
    on identical inputs produce byte-identical output (modulo built_at). The
    only place ``datetime.now`` is touched is the CLI default for ``--built-at``.
  * Python 3.9 compatible: no match statements, no ``X | Y`` runtime unions.

The build is atomic: rows are written to ``christina.db.tmp`` then
``os.replace()``-d over ``christina.db`` -- there is never a half-written
catalog. ``species.json`` (birds only) is written beside it the same way.
"""

import argparse
import datetime
import json
import os
import re
import sqlite3
import sys
import urllib.parse
import urllib.request

# ---- locked constants ------------------------------------------------------

# The catalog's own confident-DETECTION bar for derived stats. Independent of
# the paint gate: the forwarder/birdgen pair moved to 0.70 in 987d9da, so this
# deliberately no longer matches it.
CONFIDENT_THRESHOLD = 0.80

SCHEMA_VERSION = "1"

# On-disk schema version of the append-only accessions.json ledger (the pinned
# permanent accession numbers). Bumped only if the ledger's shape ever changes.
ACCESSIONS_VERSION = 1

# BirdNET's non-bird classes. Most have ``Sci_Name == Com_Name`` (and most are
# single-word), so the structural test in is_bird() already excludes them. This
# set is the explicit safety net for the ones the structural test MISSES, i.e.
# classes whose Sci_Name contains a space AND can differ from Com_Name:
#   * multi-word anthropogenic classes ("Power tools", the "Human *" variants).
#     Verified NEVER translated in any of the 36 shipped locales, so they stay
#     Sci==Com -- but listed here as belt-and-suspenders.
#   * non-bird *binomials* that read exactly like a real species. BirdNET V2.4
#     ships two cricket binomials -- "Gryllus assimilis" and
#     "Miogryllus saussurei" -- whose COMMON name several shipped locales
#     TRANSLATE (de: "Steppengrille", fr: "Grillon des steppes", ...). On those
#     Pis birds.db stores Sci != Com with a space, so the structural heuristic
#     would flag the cricket is_bird=1 and publish it. This override is the ONLY
#     guard there, so it is load-bearing (not merely a rare safety net) the
#     moment DATABASE_LANG != en. Keys are lower-cased; is_bird matches
#     ``Sci_Name.lower()``.
NON_BIRD = {
    "dog", "engine", "environmental", "fireworks", "gun",
    "human non-vocal", "human vocal", "human whistle",
    "noise", "power tools", "siren",
    "gryllus assimilis", "miogryllus saussurei",
}

# christina.db schema (CANON-locked).
SCHEMA_SQL = """
CREATE TABLE species(
  sci_name TEXT PRIMARY KEY, com_name TEXT, slug TEXT, birdnet_label TEXT,
  genus TEXT, is_bird INTEGER,
  first_detected TEXT, first_confident TEXT, last_detected TEXT,
  detection_count INTEGER, confident_count INTEGER, max_confidence REAL,
  art_status TEXT, art_source TEXT, poses TEXT);
CREATE TABLE daily_counts(sci_name TEXT, date TEXT, n INTEGER, PRIMARY KEY(sci_name,date));
CREATE TABLE hour_buckets(sci_name TEXT, hour INTEGER, n INTEGER, PRIMARY KEY(sci_name,hour));
CREATE TABLE week_species(sci_name TEXT, week INTEGER, n INTEGER, PRIMARY KEY(sci_name,week));
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
"""

# Image extensions an asset may use. The bundled art is PNG, but we accept the
# common web set so the scan keeps working if a pose is later shipped as webp.
_IMG_EXTS = (".png", ".webp", ".jpg", ".jpeg", ".svg")

# A trailing ``-<n>`` on an asset stem is an alternate pose (the bundle ships
# ``<slug>.png`` = pose 1 and ``<slug>-2.png`` = pose 2). Mirrors birdcast.py's
# ``re.sub(r"-2$", "", base)`` but generalised to any pose number.
_POSE_RE = re.compile(r"^(?P<base>.+?)-(?P<n>\d+)$")

_SLUG_RE = re.compile(r"[^a-z0-9]+")


# ---- pure helpers ----------------------------------------------------------

def slugify(s):
    """The locked slug contract (identical to birdcast.py / the PHP/JS side):
    lower-case, every run of non-alphanumerics -> ``-``, trim leading/trailing.

    Applied to ``Sci_Name`` -- that is the EXISTING bundled-asset convention
    (``cyanocitta-cristata.png``, manifest ``slugs[]``), not the common name.
    """
    return _SLUG_RE.sub("-", (s or "").lower()).strip("-")


def parse_conf(x):
    """Confidence may arrive as REAL or TEXT. Return a float, or None if it is
    NULL / unparseable garbage."""
    if x is None:
        return None
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def is_bird(sci, com):
    """1 iff this is a real species, else 0.

    A bird's ``Sci_Name`` is a binomial (contains a space) and differs from its
    common name. BirdNET's non-bird classes (Dog, Engine, Siren, ...) are
    single-word and/or have ``Sci_Name == Com_Name``; NON_BIRD is the explicit
    override for any that slip through (the multi-word classes and the cricket
    binomials whose common name a locale translates -- see NON_BIRD).
    """
    if not sci or " " not in sci:
        return 0
    if com is not None and sci == com:
        return 0
    if sci.strip().lower() in NON_BIRD:
        return 0
    return 1


def pick_com(counts):
    """Choose one ``Com_Name`` for a species. Common names drift across BirdNET
    versions/locales, so we pick the most frequent, deterministically:
    higher count wins; ties prefer a non-NULL name, then the smallest string."""
    best = None
    chosen_is_real = False
    items = []
    for com, n in counts.items():
        items.append((n, com is not None, "" if com is None else com))
    # Sort: count desc, non-None first, then lexical asc -> fully deterministic.
    items.sort(key=lambda t: (-t[0], not t[1], t[2]))
    top = items[0]
    chosen_is_real = top[1]
    best = top[2] if chosen_is_real else None
    return best


# ---- asset / manifest scan -------------------------------------------------

def scan_assets(assets_dir):
    """Read the bundled-art directory and learn the convention from the files
    on disk. Returns ``{base_slug: [pose, ...]}`` with poses sorted numerically.

    ``<slug>.png`` -> pose ``"1"``; ``<slug>-2.png`` -> pose ``"2"``. A missing
    directory yields an empty index (art_status='none'), never a crash.
    """
    index = {}
    if not assets_dir or not os.path.isdir(assets_dir):
        return index
    try:
        names = os.listdir(assets_dir)
    except OSError:
        return index
    for fn in names:
        stem, ext = os.path.splitext(fn)
        if ext.lower() not in _IMG_EXTS:
            continue
        m = _POSE_RE.match(stem)
        if m:
            base = m.group("base")
            pose = m.group("n")
        else:
            base = stem
            pose = "1"
        if not base:
            continue
        index.setdefault(base, set()).add(pose)
    return {base: sorted(poses, key=int) for base, poses in index.items()}


def fetch_manifest_slugs(manifest_url, timeout):
    """Best-effort GET of the birdgen manifest (``{"slugs": [...]}``). A slug in
    the manifest but not on local disk means the art is autogen-pending.

    Returns ``(slugs, answered)``.

    ``answered`` is False whenever a URL WAS supplied but could not be turned
    into a slug list (unreachable, timeout, bad JSON, wrong shape). The caller
    MUST NOT report those species as "no art" -- we do not know, and saying
    "none" is a confident lie. With NO url supplied, ``answered`` is True: the
    operator has declared a bundled-only install, so "none" IS the honest
    answer there.

    This still never CRASHES the build on a bad manifest (that guarantee was
    load-bearing and is kept). What changed: an unanswerable manifest is now
    RECORDED as unanswered instead of silently collapsing into "none". The
    2026-07-02..26 incident -- 40 of 47 species reported 'none' while their art
    served fine -- was this function's empty set being read as fact.
    """
    if not manifest_url:
        return set(), True
    try:
        with urllib.request.urlopen(manifest_url, timeout=timeout) as resp:
            payload = resp.read()
        data = json.loads(payload.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001 -- intentional network guard
        sys.stderr.write("catalog: manifest UNANSWERED (%s): %s\n" % (manifest_url, exc))
        return set(), False
    slugs = data.get("slugs") if isinstance(data, dict) else None
    if not isinstance(slugs, list):
        sys.stderr.write(
            "catalog: manifest UNANSWERED (%s): expected {\"slugs\": [...]}, got %s\n"
            % (manifest_url, type(data).__name__)
        )
        return set(), False
    return set(s for s in slugs if isinstance(s, str) and s), True


# ---- aggregation -----------------------------------------------------------

def _hour_of(time_s):
    if time_s is None:
        return None
    try:
        return int(str(time_s).split(":")[0])
    except (ValueError, IndexError):
        return None


def aggregate(con):
    """Single deterministic pass over ``detections``. Returns
    ``(species, com_counts, daily, hours, weeks, source_rows)``.

    ``ORDER BY Date, Time, rowid`` makes the row order -- and therefore every
    derived value -- reproducible (SQLite gives no order guarantee otherwise).
    """
    sql = (
        "SELECT Date, Time, Sci_Name, Com_Name, Confidence, Week "
        "FROM detections ORDER BY Date, Time, rowid"
    )
    species = {}
    com_counts = {}
    daily = {}
    hours = {}
    weeks = {}
    source_rows = 0

    for row in con.execute(sql):
        source_rows += 1
        sci = row["Sci_Name"]
        if sci is None:
            sci = ""
        com = row["Com_Name"]
        date_s = row["Date"]
        time_s = row["Time"]
        conf = parse_conf(row["Confidence"])

        dt = None
        if date_s is not None and time_s is not None:
            dt = "%s %s" % (date_s, time_s)

        sp = species.get(sci)
        if sp is None:
            sp = {
                "first_dt": None, "last_dt": None, "first_conf_dt": None,
                "count": 0, "conf_count": 0, "max_conf": None,
            }
            species[sci] = sp
            com_counts[sci] = {}

        sp["count"] += 1
        if dt is not None:
            if sp["first_dt"] is None or dt < sp["first_dt"]:
                sp["first_dt"] = dt
            if sp["last_dt"] is None or dt > sp["last_dt"]:
                sp["last_dt"] = dt
        if conf is not None:
            if sp["max_conf"] is None or conf > sp["max_conf"]:
                sp["max_conf"] = conf
            if conf >= CONFIDENT_THRESHOLD:
                sp["conf_count"] += 1
                if dt is not None and (sp["first_conf_dt"] is None or dt < sp["first_conf_dt"]):
                    sp["first_conf_dt"] = dt

        cc = com_counts[sci]
        cc[com] = cc.get(com, 0) + 1

        if date_s is not None:
            key = (sci, date_s)
            daily[key] = daily.get(key, 0) + 1
        hour = _hour_of(time_s)
        if hour is not None:
            key = (sci, hour)
            hours[key] = hours.get(key, 0) + 1
        # ISO week derived from Date (ground truth), NOT the Week column:
        # BirdNET-Pi populates Week with the analyzer's 48-week species-filter
        # scheme (4/month), which would drift the phenology ribbon's calendar
        # axis by up to ~4 weeks and leave cells 49-52 permanently dark. An
        # unparseable date contributes nothing (silence, never a guess).
        wk = None
        if date_s is not None:
            try:
                wk = datetime.date.fromisoformat(str(date_s)[:10]).isocalendar()[1]
            except (ValueError, TypeError):
                wk = None
        if wk is not None:
            key = (sci, wk)
            weeks[key] = weeks.get(key, 0) + 1

    return species, com_counts, daily, hours, weeks, source_rows


# ---- build -----------------------------------------------------------------

def _classify_art(slug, asset_index, manifest_slugs, manifest_answered=True):
    """Return ``(art_status, art_source, poses_list)`` for a slug.

    Three states, deliberately. 'none' means CONFIRMED no art; 'unknown' means
    WE COULD NOT TELL because the manifest went unanswered. Collapsing the two
    is the bug that shipped 40 wrong labels for 24 days: the bundled art set is
    Nearctic, so on a non-US station the manifest is not a supplement, it is the
    ONLY path that can ever answer 'ready' -- and when it fails, every species
    it would have covered must say 'unknown', never 'none'.

    Readers treat 'unknown' exactly like 'none' for rendering (both fall to the
    live X-Av-Real probe, which resolves real art anyway), so this is safe to
    ship: it changes what we CLAIM, not what we draw.
    """
    if slug in asset_index:
        return "ready", "bundled", asset_index[slug]
    if slug in manifest_slugs:
        return "ready", "autogen", []
    if not manifest_answered:
        return "unknown", None, []
    return "none", None, []


def _write_json_atomic(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def _load_accessions(path):
    """Read the accessions.json ledger as AUTHORITY. A missing file or ANY
    corruption (OSError / bad JSON / wrong shape) degrades to an empty ledger --
    the build never crashes on a garbled ledger, it just re-pins from scratch.

    Returns ``(by_sci, max_no)`` where by_sci maps sci_name -> entry (FIRST
    writer wins -- an already-present pin is NEVER overwritten) and max_no is the
    highest accession integer seen so the next pin continues the sequence.
    """
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}, 0
    entries = data.get("entries") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        return {}, 0
    by_sci, max_no = {}, 0
    for e in entries:
        if not isinstance(e, dict):
            continue
        sci, no = e.get("sci_name"), e.get("accession")
        if not isinstance(sci, str) or not isinstance(no, int):
            continue
        if sci not in by_sci:          # append-only: first pin wins, never rewritten
            by_sci[sci] = e
            max_no = max(max_no, no)
    return by_sci, max_no


def _pin_accessions(ledger_path, species, com_counts, built_at):
    """Assign each newly-confident bird a PERMANENT accession number and persist
    it to the append-only ledger. A species is pinned the first time it earns a
    confident detection (``first_conf_dt`` is set); the number then never moves,
    even if the species later disappears from birds.db (an admin delete). Only
    the DERIVED ``absent`` flag is recomputed each run.

    Keyed on sci_name (christina.db PRIMARY KEY, guaranteed unique) rather than
    slug -- slug is a lossy derivation, and two sci_names could collide to one
    slug; keying on the PK removes any renumber-by-collision risk.

    NOTE on non-monotonicity: a later birds.db backfill that introduces a NEW
    species whose first_confident predates an already-pinned one gives the new
    species a HIGHER number -- numbers follow the order of PINNING, anchored to
    the real first-confident date, not a strict global sort. The normal
    append-only detection flow never hits this.

    Returns ``(accession_by_sci, ledger_obj)``.
    """
    by_sci, max_no = _load_accessions(ledger_path)
    new_pins = []
    for sci, sp in species.items():
        if sci in by_sci:
            continue
        if sp.get("first_conf_dt") is None:
            continue
        if not is_bird(sci, pick_com(com_counts.get(sci, {}))):
            continue
        new_pins.append(sci)
    # Real first-confident chronology; ties by com then sci (mirrors catalogOrder).
    new_pins.sort(key=lambda s: (species[s]["first_conf_dt"],
                                 pick_com(com_counts.get(s, {})) or "", s))
    no = max_no
    for sci in new_pins:
        no += 1
        by_sci[sci] = {
            "accession": no,
            "sci_name": sci,
            "slug": slugify(sci),
            "com_name": pick_com(com_counts.get(sci, {})),
            "first_confident": species[sci]["first_conf_dt"],
            "pinned_at": built_at or "",
            "absent": False,
        }
    accession_by_sci = {}
    for sci, entry in by_sci.items():
        present = sci in species and species[sci].get("first_conf_dt") is not None
        entry["absent"] = not present           # derived only; never touches accession/first_confident
        accession_by_sci[sci] = entry["accession"]
    ledger_obj = {"version": ACCESSIONS_VERSION,
                  "entries": sorted(by_sci.values(), key=lambda e: e["accession"])}
    return accession_by_sci, ledger_obj


def build_catalog(birds_path, out_path, assets_dir, manifest_url=None,
                  built_at=None, manifest_timeout=3.0):
    """Rebuild christina.db + species.json from birds.db. Read-only over the
    source; atomic over the outputs. Returns a small summary dict.

    REFUSES when ``out_path`` resolves to the same file as ``birds_path``: the
    source is opened read-only, but the final ``os.replace(tmp, out)`` would
    overwrite ``birds.db`` -- the irreplaceable, append-only detection log --
    with the christina schema. christina.db is disposable; birds.db is not.
    """
    birds_abs = os.path.abspath(birds_path)
    out_abs = os.path.abspath(out_path)
    if out_abs == birds_abs:
        raise ValueError(
            "refusing to run: --out (%s) resolves to the same file as --birds "
            "(%s). birds.db is the irreplaceable detection log -- it is opened "
            "read-only, but the final os.replace() would overwrite it. "
            "Choose a different --out." % (out_path, birds_path)
        )

    asset_index = scan_assets(assets_dir)
    manifest_slugs, manifest_answered = fetch_manifest_slugs(manifest_url, manifest_timeout)

    uri = "file:%s?mode=ro" % urllib.request.pathname2url(birds_abs)
    con = sqlite3.connect(uri, uri=True, timeout=5.0)
    con.row_factory = sqlite3.Row
    try:
        con.execute("PRAGMA query_only=ON")
        species, com_counts, daily, hours, weeks, source_rows = aggregate(con)
    finally:
        con.close()

    tmp_path = out_path + ".tmp"
    if os.path.exists(tmp_path):
        os.remove(tmp_path)

    # Pin permanent accession numbers into the append-only ledger beside
    # species.json BEFORE stamping rows, so every row carries its pinned number.
    ledger_path = os.path.join(os.path.dirname(os.path.abspath(out_path)), "accessions.json")
    accession_by_sci, ledger_obj = _pin_accessions(ledger_path, species, com_counts, built_at)

    # Compact per-species weeks[] for species.json: sparse [[isoWeek, n], ...]
    # sorted ascending, from the already-aggregated week rollup.
    weeks_by_sci = {}
    for (s, w), n in weeks.items():
        weeks_by_sci.setdefault(s, []).append([w, n])
    for s in weeks_by_sci:
        weeks_by_sci[s].sort(key=lambda t: t[0])

    out = sqlite3.connect(tmp_path)
    try:
        out.executescript(SCHEMA_SQL)

        species_rows = []
        json_rows = []
        for sci in sorted(species.keys()):
            sp = species[sci]
            com = pick_com(com_counts[sci])
            bird = is_bird(sci, com)
            slug = slugify(sci)
            genus = sci.split()[0] if (bird and sci.split()) else None
            label = "%s_%s" % (sci, com if com is not None else sci)
            art_status, art_source, poses = _classify_art(
                slug, asset_index, manifest_slugs, manifest_answered)
            poses_json = json.dumps(poses, separators=(",", ":"))

            species_rows.append((
                sci, com, slug, label, genus, bird,
                sp["first_dt"], sp["first_conf_dt"], sp["last_dt"],
                sp["count"], sp["conf_count"], sp["max_conf"],
                art_status, art_source, poses_json,
            ))
            if bird:
                json_rows.append({
                    "sci_name": sci,
                    "com_name": com,
                    "slug": slug,
                    "first_confident": sp["first_conf_dt"],
                    "last_detected": sp["last_dt"],
                    "detection_count": sp["count"],
                    "art_status": art_status,
                    # Pinned permanent accession No. (int) once confident, else
                    # null (heard but never confidently detected -> not accessioned).
                    "accession": accession_by_sci.get(sci),
                    # Sparse [[isoWeek, count], ...] ascending; [] if none.
                    "weeks": weeks_by_sci.get(sci, []),
                })

        out.executemany(
            "INSERT INTO species VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            species_rows,
        )
        out.executemany(
            "INSERT INTO daily_counts VALUES (?,?,?)",
            [(s, d, n) for (s, d), n in sorted(daily.items())],
        )
        out.executemany(
            "INSERT INTO hour_buckets VALUES (?,?,?)",
            [(s, h, n) for (s, h), n in sorted(hours.items())],
        )
        out.executemany(
            "INSERT INTO week_species VALUES (?,?,?)",
            [(s, w, n) for (s, w), n in sorted(weeks.items())],
        )
        out.executemany(
            "INSERT INTO meta VALUES (?,?)",
            [
                ("built_at", built_at if built_at is not None else ""),
                ("source_rows", str(source_rows)),
                ("schema_version", SCHEMA_VERSION),
            ],
        )
        out.commit()
    finally:
        out.close()

    os.replace(tmp_path, out_path)

    # Persist the append-only accession ledger FIRST -- it is the AUTHORITY the
    # derived species.json merely mirrors. Written the other way round, a crash
    # between the two writes would publish accession numbers the ledger never
    # recorded, and the next rebuild could silently renumber them. (Pi-local
    # only -- the frontend reads `accession` off species.json, never this file.)
    _write_json_atomic(ledger_path, ledger_obj)

    # species.json -- birds only, sorted by first_confident then com_name.
    # Never-confident birds (None) sort last via the ￿ sentinel.
    json_rows.sort(key=lambda r: (
        r["first_confident"] if r["first_confident"] is not None else "￿",
        r["com_name"] if r["com_name"] is not None else "",
    ))
    json_path = os.path.join(os.path.dirname(os.path.abspath(out_path)), "species.json")
    _write_json_atomic(json_path, json_rows)

    return {
        "species": len(species_rows),
        "birds": len(json_rows),
        "source_rows": source_rows,
        "out": out_path,
        "json": json_path,
        "accessions": ledger_path,
        # False => a manifest URL was supplied but went unanswered, so some rows
        # say 'unknown'. main() turns this into a NON-ZERO exit so a nightly
        # timer cannot keep publishing a degraded catalog behind a green unit.
        "manifest_answered": manifest_answered,
        "manifest_slugs": len(manifest_slugs),
        "manifest_url": manifest_url,
    }


# ---- CLI -------------------------------------------------------------------

def default_paths():
    """Sensible Pi defaults relative to this script (repo root = two up)."""
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.abspath(os.path.join(here, "..", ".."))
    birds = (os.environ.get("CHRISTINA_BIRDS_DB")
             or os.environ.get("AV_BIRDS_DB")
             or os.path.join(repo, "scripts", "birds.db"))
    if not os.path.isfile(birds):
        alt = os.path.expanduser("~/BirdNET-Pi/scripts/birds.db")
        if os.path.isfile(alt):
            birds = alt
    assets = os.path.join(repo, "avian", "assets", "illustrations")
    out = os.path.join(repo, "scripts", "christina.db")
    return birds, assets, out


def main(argv=None):
    birds_d, assets_d, out_d = default_paths()
    ap = argparse.ArgumentParser(
        description="Rebuild christina.db (the species catalog) from birds.db. "
                    "Read-only over birds.db; atomic, fully reproducible output.",
    )
    ap.add_argument("--birds", default=birds_d, help="path to birds.db (read-only)")
    ap.add_argument("--out", default=out_d, help="output christina.db path")
    ap.add_argument("--assets", default=assets_d, help="bundled-art directory to scan")
    # Default from the environment, NOT only from a flag baked at deploy time.
    # The 24-day incident happened because the flag was rendered ONCE into a
    # systemd unit from a shell env that happened to be unset -- after which no
    # amount of correct configuration could reach it without a redeploy. Reading
    # it at RUN time means an operator can fix it in one env file.
    _manifest_env = (
        os.environ.get("CHRISTINA_MANIFEST_URL")
        or (os.environ.get("CHRISTINA_RAILWAY_BASE", "").rstrip("/") + "/manifest"
            if os.environ.get("CHRISTINA_RAILWAY_BASE") else None)
    )
    ap.add_argument("--manifest-url", default=_manifest_env,
                    help="birdgen manifest URL. Defaults to $CHRISTINA_MANIFEST_URL, "
                         "else $CHRISTINA_RAILWAY_BASE/manifest. On a non-US station "
                         "the bundled art set (Nearctic) covers almost nothing, so "
                         "this is the ONLY path that can report art as ready.")
    ap.add_argument("--manifest-timeout", type=float, default=3.0,
                    help="manifest GET timeout in seconds (default 3.0)")
    ap.add_argument("--built-at", default=None,
                    help="ISO timestamp injected into meta.built_at "
                         "(omit -> now, UTC; supply for reproducible builds)")
    args = ap.parse_args(argv)

    built_at = args.built_at
    if built_at is None:
        # CLI boundary only -- the core build logic is wall-clock free.
        built_at = datetime.datetime.now(datetime.timezone.utc).replace(
            microsecond=0).isoformat()

    if not os.path.isfile(args.birds):
        sys.stderr.write("catalog: birds.db not found at %s\n" % args.birds)
        return 2

    # Guard the only birds.db mutation vector before doing any work: the final
    # os.replace() would clobber birds.db if --out points at it.
    if os.path.abspath(args.out) == os.path.abspath(args.birds):
        sys.stderr.write(
            "catalog: refusing to run -- --out (%s) is the same file as "
            "--birds (%s); the atomic replace would overwrite the detection "
            "log\n" % (args.out, args.birds)
        )
        return 2

    result = build_catalog(
        args.birds, args.out, args.assets,
        manifest_url=args.manifest_url, built_at=built_at,
        manifest_timeout=args.manifest_timeout,
    )
    sys.stdout.write(
        "catalog: %d species (%d birds) from %d rows -> %s\n"
        % (result["species"], result["birds"], result["source_rows"], result["out"])
    )

    # FAIL LOUD on a degraded catalog. The catalog still PUBLISHED above (a
    # partial catalog beats no catalog, and art_status now says 'unknown'
    # rather than lying) -- but the process exits non-zero so systemd marks the
    # unit failed, `systemctl --failed` shows it, and repo-guards/verify can
    # see it. The 24-day incident was invisible precisely because this path
    # returned 0.
    if not result["manifest_answered"]:
        sys.stderr.write(
            "catalog: DEGRADED -- manifest %s went unanswered; species with no "
            "bundled art are labelled 'unknown', not 'none'. Art coverage is "
            "UNVERIFIED until this resolves.\n" % (result["manifest_url"],)
        )
        return 3
    if args.manifest_url and result["manifest_slugs"] == 0:
        sys.stderr.write(
            "catalog: DEGRADED -- manifest %s answered with ZERO slugs. That is "
            "almost never real (birdgen ships ~290); treating as a fault rather "
            "than silently reporting every autogen species as 'none'.\n"
            % (args.manifest_url,)
        )
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
