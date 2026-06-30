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

# Matches the forwarder's confident-detection threshold.
CONFIDENT_THRESHOLD = 0.80

SCHEMA_VERSION = "1"

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

    Network-guarded: ANY failure (no URL, unreachable, bad JSON, timeout)
    returns an empty set. The build never fails because of the manifest.
    """
    if not manifest_url:
        return set()
    try:
        with urllib.request.urlopen(manifest_url, timeout=timeout) as resp:
            payload = resp.read()
        data = json.loads(payload.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001 -- intentional network guard
        sys.stderr.write("catalog: manifest skipped (%s): %s\n" % (manifest_url, exc))
        return set()
    slugs = data.get("slugs") if isinstance(data, dict) else None
    if not isinstance(slugs, list):
        return set()
    return set(s for s in slugs if isinstance(s, str) and s)


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
        wk = None
        try:
            if row["Week"] is not None:
                wk = int(row["Week"])
        except (ValueError, TypeError):
            wk = None
        if wk is not None:
            key = (sci, wk)
            weeks[key] = weeks.get(key, 0) + 1

    return species, com_counts, daily, hours, weeks, source_rows


# ---- build -----------------------------------------------------------------

def _classify_art(slug, asset_index, manifest_slugs):
    """Return ``(art_status, art_source, poses_list)`` for a slug."""
    if slug in asset_index:
        return "ready", "bundled", asset_index[slug]
    if slug in manifest_slugs:
        return "ready", "autogen", []
    return "none", None, []


def _write_json_atomic(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


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
    manifest_slugs = fetch_manifest_slugs(manifest_url, manifest_timeout)

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
            art_status, art_source, poses = _classify_art(slug, asset_index, manifest_slugs)
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
    ap.add_argument("--manifest-url", default=None,
                    help="optional birdgen manifest URL (best-effort, network-guarded)")
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
