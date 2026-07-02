#!/usr/bin/env python3
"""derive -- the honest derived-intelligence single-writer for the companions.

The collage/API read the catalog (``christina.db`` / ``species.json``). The
*companion* surfaces (the ``/lab`` console, the popup extras, the weekly recap)
want a handful of second-order metrics on top of that. If each surface rolled
its own SQL over ``birds.db`` we would re-breed the project's documented
seam-bug class (many readers, many subtly-different aggregations). So this is
the SINGLE WRITER: one nightly pass computes those metrics ONCE into a single
``derived.json``, and every companion reads that one honest source.

Honesty contract (LOCKED):
  * Every value here is COMPUTED and traceable to real rows in ``birds.db``.
    Nothing is interpolated, estimated, smoothed, or fabricated. If a value
    cannot be computed from the data it is OMITTED, never guessed.
  * ``local_rarity`` describes LOCAL ENCOUNTER frequency at THIS station
    (days-heard / station-days) -- it is explicitly NOT conservation status or
    IUCN rarity. The field names (``encounter_frac`` / ``encounter_label``) and
    the ``notes`` block spell that out so no surface can misread it.
  * ``co_occurrence`` is "heard in the same 10-minute window", reported as
    lift/jaccard (NOT raw counts -- a dawn bin packs many species together, so
    raw counts would make the noisiest bird look like everyone's friend). It is
    co-occurrence in TIME, not evidence the birds associate or are "friends":
    causation is not supported.
  * ``first_of_year`` uses the CURRENT year derived from the DATA's latest date,
    not the wall clock, so a stale run is still honest.

Design constraints (mirroring ``rebuild_catalog.py``):
  * stdlib only (sqlite3, json, os, re, argparse, datetime, urllib). No pip --
    it runs on the Pi as a systemd oneshot step after the catalog rebuild.
  * ``birds.db`` is opened READ-ONLY (``file:...?mode=ro`` + ``PRAGMA
    query_only``), exactly as ``rebuild_catalog.py`` opens it. Never written.
  * ONE pass over ``detections``; the post-processing is pure and deterministic
    (every output list is sorted), so two runs on identical input produce
    identical output modulo the injected ``built_at``.
  * Python 3.9 compatible: no match statements, no ``X | Y`` runtime unions.
  * MUST NOT fail the nightly catalog build. ``main`` swallows every error and
    exits 0 (log-and-continue); the catalog has already published by the time
    this step runs, so a derive failure must never mark the service failed.

The slug / confidence / is-bird logic is copied verbatim from
``rebuild_catalog.py`` (rather than imported) to keep this a standalone stdlib
script with no import-path coupling. Those contracts are LOCKED -- if they ever
change in ``rebuild_catalog.py`` they must change here too.
"""

import argparse
import datetime
import json
import os
import re
import sqlite3
import sys
import urllib.request

# ---- locked constants (mirror rebuild_catalog.py) --------------------------

# Matches the forwarder's / catalog's confident-detection threshold.
CONFIDENT_THRESHOLD = 0.80

SCHEMA_VERSION = "1"

# BirdNET's non-bird classes that the structural is_bird() test can miss (see
# rebuild_catalog.py NON_BIRD for the full rationale -- multi-word anthropogenic
# classes + the two cricket binomials whose common name some locales translate).
NON_BIRD = {
    "dog", "engine", "environmental", "fireworks", "gun",
    "human non-vocal", "human vocal", "human whistle",
    "noise", "power tools", "siren",
    "gryllus assimilis", "miogryllus saussurei",
}

_SLUG_RE = re.compile(r"[^a-z0-9]+")

# ---- derive-specific knobs -------------------------------------------------

# Co-occurrence window width, in minutes. Two species share a "window" when they
# are both heard inside the same 10-minute bin of the same day.
BIN_MINUTES = 10
# Minimum shared windows before a co-occurrence edge is reported. Below this the
# jaccard/lift are noise (an edge from one or two coincidental bins).
MIN_PAIR_BINS = 5
# How many co-occurrence edges to publish, ranked by lift (strongest edge first).
TOP_EDGES = 40
# Recent active days shown in the waking line (dawn-onset clock time per day).
WAKING_DAYS = 30
# Minimum distinct days a species must be heard to appear in local_rarity.
MIN_DAYS_HEARD = 1

# Single deterministic pass; ORDER BY makes every derived value reproducible
# (SQLite gives no order guarantee otherwise), mirroring rebuild_catalog.py.
_SCAN_SQL = (
    "SELECT Date, Time, Sci_Name, Com_Name, Confidence "
    "FROM detections ORDER BY Date, Time, rowid"
)

# Honest field notes shipped inside derived.json so every reader gets the
# provenance/caveat inline -- these are the explicit red-team guards.
NOTES = {
    "local_rarity": (
        "encounter_frac = days_heard / station_days and encounter_label "
        "describe how often THIS station heard the species. This is LOCAL "
        "detection frequency, NOT conservation status or IUCN rarity."
    ),
    "co_occurrence": (
        "Species pairs heard in the same 10-minute window. lift > 1 means heard "
        "together more than chance would predict; jaccard is the overlap of "
        "their windows. This is co-occurrence in TIME, NOT evidence the birds "
        "associate or are 'friends' -- causation is not supported."
    ),
    "waking_line": (
        "Earliest bird-detection clock time per day (dawn-chorus onset), from "
        "real timestamps only. Days with no parseable time are skipped."
    ),
    "first_of_year": (
        "Species whose FIRST confident (>= 0.80) detection falls in "
        "current_year. current_year is derived from the data's latest date, "
        "not the wall clock, so a stale run stays honest."
    ),
}


# ---- pure helpers (copied verbatim from rebuild_catalog.py) ----------------

def slugify(s):
    """Locked slug contract: lower-case, every run of non-alphanumerics -> '-',
    ends trimmed. Applied to Sci_Name (the bundled-asset convention)."""
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
    """1 iff this is a real species, else 0 (structural binomial test + the
    NON_BIRD override). Identical to rebuild_catalog.is_bird."""
    if not sci or " " not in sci:
        return 0
    if com is not None and sci == com:
        return 0
    if sci.strip().lower() in NON_BIRD:
        return 0
    return 1


def pick_com(counts):
    """Choose one Com_Name for a species deterministically: higher count wins;
    ties prefer a non-NULL name, then the smallest string. (rebuild_catalog)."""
    items = []
    for com, n in counts.items():
        items.append((n, com is not None, "" if com is None else com))
    items.sort(key=lambda t: (-t[0], not t[1], t[2]))
    top = items[0]
    return top[2] if top[1] else None


# ---- derive-local helpers --------------------------------------------------

def _parse_hm(time_s):
    """Parse a BirdNET Time ('HH:MM:SS') into an (hour, minute) tuple, or None
    if it is missing / unparseable / out of range."""
    if time_s is None:
        return None
    parts = str(time_s).split(":")
    if len(parts) < 2:
        return None
    try:
        h = int(parts[0])
        m = int(parts[1])
    except (TypeError, ValueError):
        return None
    if h < 0 or h > 23 or m < 0 or m > 59:
        return None
    return (h, m)


def _year_of(date_s):
    """ISO year of a Date string, or None if unparseable."""
    if date_s is None:
        return None
    try:
        return datetime.date.fromisoformat(str(date_s)[:10]).year
    except (TypeError, ValueError):
        return None


def _rarity_label(frac):
    """Plain-language LOCAL ENCOUNTER tier (NOT conservation rarity). Describes
    how large a share of the station's active days heard the species."""
    if frac >= 0.5:
        return "seen most days"
    if frac >= 0.2:
        return "seen some days"
    if frac >= 0.05:
        return "occasional"
    return "rare visitor"


def _connect_ro(birds_path):
    """Open birds.db READ-ONLY, exactly as rebuild_catalog.py does."""
    birds_abs = os.path.abspath(birds_path)
    uri = "file:%s?mode=ro" % urllib.request.pathname2url(birds_abs)
    con = sqlite3.connect(uri, uri=True, timeout=5.0)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA query_only=ON")
    return con


def _write_json_atomic(path, obj):
    """tmp + os.replace, mirroring rebuild_catalog._write_json_atomic. Written
    with indent for human inspection (the file is small and read by humans)."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


# ---- the single pass -------------------------------------------------------

def _new_acc():
    return {
        "source_rows": 0,
        "max_date": None,
        "station_dates": set(),
        "com_counts": {},        # sci -> {com: n}
        "sp_days": {},           # sci -> set(date)
        "sp_first_conf": {},     # sci -> earliest 'date time' with conf >= thresh
        "bins": {},              # (date, hour, tenmin) -> set(sci)
        "day_first": {},         # date -> {sci: (h, m)}  earliest time that day
    }


def _note_time(acc, date_s, sci, hm):
    """Record a parseable timestamp into the co-occurrence bins and the per-day
    earliest-time map (used for the waking line)."""
    h, m = hm
    binkey = (date_s, h, m // BIN_MINUTES)
    acc["bins"].setdefault(binkey, set()).add(sci)
    df = acc["day_first"].setdefault(date_s, {})
    prev = df.get(sci)
    if prev is None or hm < prev:
        df[sci] = hm


def _scan_row(acc, row):
    acc["source_rows"] += 1
    sci = row["Sci_Name"] or ""
    com = row["Com_Name"]
    date_s = row["Date"]
    time_s = row["Time"]
    conf = parse_conf(row["Confidence"])

    cc = acc["com_counts"].setdefault(sci, {})
    cc[com] = cc.get(com, 0) + 1

    if date_s is not None:
        acc["station_dates"].add(date_s)
        if acc["max_date"] is None or date_s > acc["max_date"]:
            acc["max_date"] = date_s
        acc["sp_days"].setdefault(sci, set()).add(date_s)

    # first_confident: mirror rebuild_catalog exactly -- only rows with BOTH a
    # date AND a time contribute (dt = 'date time'), and only conf >= threshold.
    dt = None
    if date_s is not None and time_s is not None:
        dt = "%s %s" % (date_s, time_s)
    if conf is not None and conf >= CONFIDENT_THRESHOLD and dt is not None:
        cur = acc["sp_first_conf"].get(sci)
        if cur is None or dt < cur:
            acc["sp_first_conf"][sci] = dt

    hm = _parse_hm(time_s)
    if date_s is not None and hm is not None:
        _note_time(acc, date_s, sci, hm)


def _scan(con):
    acc = _new_acc()
    for row in con.execute(_SCAN_SQL):
        _scan_row(acc, row)
    return acc


# ---- metric builders (pure over the scan accumulators) ---------------------

def _bird_index(acc):
    """Resolve one Com_Name per species and the set of species that are birds
    (using the same is_bird contract as the catalog)."""
    com_by_sci = {}
    bird_set = set()
    for sci, cc in acc["com_counts"].items():
        com = pick_com(cc)
        com_by_sci[sci] = com
        if is_bird(sci, com):
            bird_set.add(sci)
    return bird_set, com_by_sci


def _local_rarity(acc, bird_set, com_by_sci, station_days):
    if station_days <= 0:
        return []
    rows = []
    for sci in bird_set:
        days = acc["sp_days"].get(sci)
        dh = len(days) if days else 0
        if dh < MIN_DAYS_HEARD:
            continue
        frac = dh / station_days
        rows.append({
            "sci_name": sci,
            "com_name": com_by_sci.get(sci),
            "slug": slugify(sci),
            "days_heard": dh,
            "station_days": station_days,
            "encounter_frac": round(frac, 4),
            "encounter_label": _rarity_label(frac),
        })
    # Rarest (lowest local encounter frequency) first; deterministic tiebreak.
    rows.sort(key=lambda r: (r["encounter_frac"], r["days_heard"], r["sci_name"]))
    return rows


def _accumulate_pairs(pair_counts, members):
    n = len(members)
    for i in range(n):
        a = members[i]
        for j in range(i + 1, n):
            key = (a, members[j])
            pair_counts[key] = pair_counts.get(key, 0) + 1


def _build_edges(pair_counts, species_bins, total_bins, com_by_sci):
    edges = []
    for (a, b), pb in pair_counts.items():
        if pb < MIN_PAIR_BINS:
            continue
        ba = species_bins.get(a, 0)
        bb = species_bins.get(b, 0)
        union = ba + bb - pb
        jac = (pb / union) if union > 0 else 0.0
        denom = ba * bb
        lift = (pb * total_bins / denom) if denom > 0 else 0.0
        edges.append({
            "a_sci": a, "a_com": com_by_sci.get(a), "a_slug": slugify(a),
            "b_sci": b, "b_com": com_by_sci.get(b), "b_slug": slugify(b),
            "pair_bins": pb,
            "jaccard": round(jac, 4),
            "lift": round(lift, 4),
        })
    edges.sort(key=lambda e: (-e["lift"], -e["pair_bins"], e["a_sci"], e["b_sci"]))
    return edges[:TOP_EDGES]


def _co_occurrence(acc, bird_set, com_by_sci):
    species_bins = {}
    pair_counts = {}
    total_bins = 0
    for binset in acc["bins"].values():
        members = sorted(s for s in binset if s in bird_set)
        if not members:
            continue
        total_bins += 1
        for s in members:
            species_bins[s] = species_bins.get(s, 0) + 1
        _accumulate_pairs(pair_counts, members)
    return _build_edges(pair_counts, species_bins, total_bins, com_by_sci)


def _waking_line(acc, bird_set):
    rows = []
    for date_s, df in acc["day_first"].items():
        times = [hm for sci, hm in df.items() if sci in bird_set]
        if not times:
            continue
        h, m = min(times)
        rows.append({"date": date_s, "first_time": "%02d:%02d" % (h, m)})
    rows.sort(key=lambda r: r["date"])
    if len(rows) > WAKING_DAYS:
        rows = rows[-WAKING_DAYS:]
    return rows


def _first_of_year(acc, bird_set, com_by_sci, current_year):
    if current_year is None:
        return []
    rows = []
    for sci in bird_set:
        fc = acc["sp_first_conf"].get(sci)
        if fc is None:
            continue
        if _year_of(fc) != current_year:
            continue
        rows.append({
            "sci_name": sci,
            "com_name": com_by_sci.get(sci),
            "slug": slugify(sci),
            "first_confident": fc,
        })
    rows.sort(key=lambda r: (r["first_confident"], r["sci_name"]))
    return rows


def compute_metrics(con):
    """Run the single pass and build every honest metric. Wall-clock free --
    ``built_at`` is stamped by the caller. Returns the full payload dict with a
    ``built_at`` placeholder of None for the caller to fill in place."""
    acc = _scan(con)
    bird_set, com_by_sci = _bird_index(acc)
    station_days = len(acc["station_dates"])
    current_year = _year_of(acc["max_date"])
    return {
        "schema_version": SCHEMA_VERSION,
        "built_at": None,             # filled by the caller (CLI boundary only)
        "station_days": station_days,
        "source_rows": acc["source_rows"],
        "current_year": current_year,
        "species_heard": len(bird_set),
        "notes": NOTES,
        "local_rarity": _local_rarity(acc, bird_set, com_by_sci, station_days),
        "co_occurrence": _co_occurrence(acc, bird_set, com_by_sci),
        "waking_line": _waking_line(acc, bird_set),
        "first_of_year": _first_of_year(acc, bird_set, com_by_sci, current_year),
    }


def derive(birds_path):
    """Open birds.db read-only and compute the metrics payload."""
    con = _connect_ro(birds_path)
    try:
        return compute_metrics(con)
    finally:
        con.close()


# ---- CLI -------------------------------------------------------------------

def default_paths():
    """Pi defaults relative to this script (repo = two dirs up). derived.json
    lands beside species.json in <repo>/scripts, the catalog output dir."""
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.abspath(os.path.join(here, "..", ".."))
    birds = (os.environ.get("CHRISTINA_BIRDS_DB")
             or os.environ.get("AV_BIRDS_DB")
             or os.path.join(repo, "scripts", "birds.db"))
    if not os.path.isfile(birds):
        alt = os.path.expanduser("~/BirdNET-Pi/scripts/birds.db")
        if os.path.isfile(alt):
            birds = alt
    out = os.path.join(repo, "scripts", "derived.json")
    return birds, out


def _summary_line(payload):
    waking = payload["waking_line"]
    earliest = min((r["first_time"] for r in waking), default="--:--")
    return (
        "derive: %d station-days, %d rows, year %s | "
        "local_rarity=%d co_occurrence=%d waking_line=%d(earliest %s) "
        "first_of_year=%d"
        % (
            payload["station_days"], payload["source_rows"],
            payload["current_year"], len(payload["local_rarity"]),
            len(payload["co_occurrence"]), len(waking), earliest,
            len(payload["first_of_year"]),
        )
    )


def run(args, built_at):
    if not os.path.isfile(args.birds):
        sys.stderr.write("derive: birds.db not found at %s (skipping)\n" % args.birds)
        return None
    payload = derive(args.birds)
    payload["built_at"] = built_at
    if args.dry_run:
        sys.stdout.write("[dry-run, writes nothing] " + _summary_line(payload) + "\n")
        return payload
    _write_json_atomic(args.out, payload)
    sys.stdout.write(_summary_line(payload) + " -> %s\n" % args.out)
    return payload


def main(argv=None):
    birds_d, out_d = default_paths()
    ap = argparse.ArgumentParser(
        description="Compute honest derived companion metrics (derived.json) "
                    "from birds.db. Read-only over birds.db; atomic output; "
                    "never fails the nightly catalog build.",
    )
    ap.add_argument("--birds", default=birds_d, help="path to birds.db (read-only)")
    ap.add_argument("--out", default=out_d, help="output derived.json path")
    ap.add_argument("--built-at", default=None,
                    help="ISO timestamp for the provenance header "
                         "(omit -> now, UTC; supply for reproducible output)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print a summary and write NOTHING")
    args = ap.parse_args(argv)

    built_at = args.built_at
    if built_at is None:
        # CLI boundary only -- compute_metrics itself is wall-clock free.
        built_at = datetime.datetime.now(datetime.timezone.utc).replace(
            microsecond=0).isoformat()

    # Must NEVER fail the nightly catalog build: the catalog has already
    # published by the time this runs, so any error is logged and swallowed.
    try:
        run(args, built_at)
    except Exception as exc:  # noqa: BLE001 -- intentional log-and-continue guard
        sys.stderr.write("derive: skipped (%s: %s)\n" % (type(exc).__name__, exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
