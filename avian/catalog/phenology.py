#!/usr/bin/env python3
"""phenology -- the per-year seasonal ledger that OUTLIVES the detection rows.

Everything else this catalog produces is DISPOSABLE and recomputed from live
rows: ``christina.db`` and ``species.json`` are rebuilt wholesale every night,
``derived.json`` is rewritten wholesale by ``derive.py``. And the time axis they
publish has NO year component -- ``week_species(sci_name, week, n)`` sums a 2026
and a 2027 detection in the same ISO week into ONE cell that can never be
separated again. So the moment rows leave ``birds.db``, that period's phenology
is gone and year-over-year comparison is impossible from the shipped artifacts.

This file is the answer: one JSON ledger, one entry per (species, CALENDAR
year), FROZEN once the year closes. It is the same durability class as
``scripts/accessions.json`` -- append-only, first-writer-wins, never rewritten
from live rows -- and for the same reason: what it holds cannot be recomputed.

THE FREEZE RULE
  * ``current_year`` comes from the DATA's latest Date, never the wall clock
    (derive.py's honesty contract, so a stale run stays honest).
  * (sci, year) already in the ledger with ``year < current_year`` -> KEPT
    BYTE-FOR-BYTE. It is frozen.
  * (sci, year) with ``year == current_year`` -> recomputed every run. The open
    year is still accumulating; freezing it would freeze the ledger the day it
    was created and nobody would notice until the following January.
  * (sci, year) in the ledger but no longer in ``birds.db`` at all -> KEPT
    VERBATIM, never deleted. That case IS the point of this file.

THE TWO CLAMPS (both load-bearing, both verified with python3 on a real date)
  * ``date(2026,12,28).isocalendar() == (2026, 53, 1)`` -- ISO week 53 exists and
    2026 has one. ``web/src/almanac.ts:113`` already folds 53 into cell 52
    (``Math.min(52, Math.max(1, w)) - 1``); the ledger must agree with the
    renderer that already shipped, so MAX_ISO_WEEK is 52, not 53.
  * ``date(2024,12,30).isocalendar() == (2025, 1, 1)`` -- the ISO year disagrees
    with the calendar year at every boundary. A min/max clamp alone does NOT
    save this: week 1 is already in range, so 30 December would file under
    "week 1" (reading as early January) and an ``isocalendar()[0]`` year would
    file it under 2025, emptying December out of 2024 entirely. Mirror image:
    ``date(2021,1,1).isocalendar() == (2020, 53, 5)``.
  So: the year is ALWAYS the calendar year (``date.year``), and a date whose ISO
  year disagrees is pulled to the matching END of its own calendar year -- 52 for
  late December, 1 for early January. ``min(52, max(1, iso_week))`` applies only
  to the remaining, ordinary cases.

PROVENANCE (why every entry carries three extra fields)
  A frozen year is unfalsifiable: the rows behind it are gone. So each entry
  records ``source_rows_at_freeze``, ``min_date_seen`` and ``frozen_at``, and the
  payload carries a top-level ``coverage`` block. A 2026 entry whose
  ``min_date_seen`` is 2026-11-04 is visibly a STUMP -- a partial year frozen on
  a first deployment -- not a season. Without that, ``days_heard: 4`` reads as a
  scientific fact forever.

DELIBERATE DIVERGENCE FROM rebuild_catalog._load_accessions
  A ledger file that EXISTS but is unreadable / not JSON / wrong-shaped FAILS
  LOUD (exit 5, writes nothing). ``_load_accessions`` can safely degrade to an
  empty ledger because accessions re-derive from rows that are still there.
  Phenology's whole value is rows that are GONE: silently starting over would
  destroy exactly what the file exists to hold. A MISSING file is still a clean
  first run.

Design constraints (mirroring ``derive.py``):
  * stdlib only. No pip -- it runs on the Pi as nightly.sh's third step.
  * ``birds.db`` opened READ-ONLY (``file:...?mode=ro`` + ``PRAGMA query_only``).
    Never written, never migrated.
  * ONE deterministic pass; every output list sorted, every tie-break explicit,
    so two runs on identical input produce a byte-identical file.
  * Wall-clock free core; ``datetime.now`` is touched ONLY at the CLI boundary.
  * Python 3.9 compatible: no match statements, no ``X | Y`` runtime unions.

The slug / is-bird / com-name helpers are COPIED verbatim from ``derive.py``
(which copied them from ``rebuild_catalog.py``) rather than imported, keeping
this a standalone stdlib script with no import-path coupling. Those contracts
are LOCKED -- if they change there they must change here too.

Exit codes: 0 ok (or skipped: no birds.db), 5 failed. 5 because 2/3/4/7 are
already taken by rebuild_catalog.py and nightly.sh.
"""

import argparse
import datetime
import json
import os
import re
import sqlite3
import sys
import urllib.request

# ---- locked constants ------------------------------------------------------

# On-disk schema version of the append-only ledger (mirrors ACCESSIONS_VERSION).
PHENOLOGY_VERSION = 1

# Locked to web/src/almanac.ts:113's 52-cell fold. See the two-clamp note above.
MAX_ISO_WEEK = 52

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

# Single deterministic pass; ORDER BY makes every derived value reproducible
# (SQLite gives no order guarantee otherwise), mirroring rebuild_catalog.py.
_SCAN_SQL = (
    "SELECT Date, Time, Sci_Name, Com_Name "
    "FROM detections ORDER BY Date, Time, rowid"
)

# Honest field notes shipped inside phenology.json so a reader in 2027 gets the
# provenance inline, without this file.
NOTES = {
    "freeze": (
        "An entry for a CLOSED year (year < current_year) is frozen the first "
        "time it is written and is never recomputed. current_year comes from the "
        "data's latest Date, not the wall clock. Entries whose rows have since "
        "been purged from birds.db are kept verbatim -- that is why this file "
        "exists."
    ),
    "week": (
        "peak_week is an ISO week clamped to 1..52 with the year taken as the "
        "CALENDAR year: a date whose ISO year disagrees with its calendar year "
        "(30 Dec 2024 is ISO 2025-W01) is pulled to the matching end of its own "
        "calendar year. 52 rather than 53 matches the 52-cell renderer in "
        "web/src/almanac.ts."
    ),
    "counts": (
        "days_heard counts DISTINCT dates, detections counts rows. "
        "first_heard/last_heard are null -- never guessed -- when no row that "
        "year carried both a Date and a Time. source_rows_at_freeze, "
        "min_date_seen and coverage bound what the ledger could possibly have "
        "known: an entry whose min_date_seen is late in its year is a partial "
        "stump, not a season."
    ),
}


# ---- pure helpers (copied verbatim from derive.py) -------------------------

def slugify(s):
    """Locked slug contract: lower-case, every run of non-alphanumerics -> '-',
    ends trimmed. Applied to Sci_Name (the bundled-asset convention)."""
    return _SLUG_RE.sub("-", (s or "").lower()).strip("-")


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


# ---- the two clamps --------------------------------------------------------

def year_week(date_s):
    """Return ``(calendar_year, week 1..52)`` for a BirdNET Date string, or
    ``(None, None)`` if it is missing or unparseable.

    TWO clamps, both load-bearing (see the module docstring):
      1. the year is ALWAYS ``date.year``, never ``isocalendar()[0]``;
      2. a date whose ISO year disagrees is pulled to the matching END of its own
         calendar year -- 52 for late December, 1 for early January. Only the
         remaining cases get ``min(52, max(1, iso_week))``.
    """
    if date_s is None:
        return (None, None)
    try:
        d = datetime.date.fromisoformat(str(date_s)[:10])
    except (TypeError, ValueError):
        return (None, None)
    iso = d.isocalendar()
    iso_year, iso_week = iso[0], iso[1]
    if iso_year > d.year:
        # Late December: ISO calls it week 1 of NEXT year. It is still December.
        return (d.year, MAX_ISO_WEEK)
    if iso_year < d.year:
        # Early January: ISO calls it week 52/53 of LAST year. It is still January.
        return (d.year, 1)
    return (d.year, min(MAX_ISO_WEEK, max(1, iso_week)))


# ---- io --------------------------------------------------------------------

def _connect_ro(birds_path):
    """Open birds.db READ-ONLY, exactly as rebuild_catalog.py / derive.py do."""
    birds_abs = os.path.abspath(birds_path)
    uri = "file:%s?mode=ro" % urllib.request.pathname2url(birds_abs)
    con = sqlite3.connect(uri, uri=True, timeout=5.0)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA query_only=ON")
    return con


def _write_json_atomic(path, obj):
    """tmp + os.replace, mirroring derive._write_json_atomic. Indented, because
    this file is the one a human opens in 2027 to ask what 2026 sounded like."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


# ---- the single pass -------------------------------------------------------

def _new_acc():
    return {
        "source_rows": 0,
        "min_date": None,       # coverage: earliest PARSEABLE Date in birds.db
        "max_date": None,       # coverage: latest   PARSEABLE Date in birds.db
        "com_counts": {},       # sci -> {com: n}
        "yr": {},               # (sci, calendar_year) -> per-year accumulator
    }


def _note_coverage(acc, date_s):
    if acc["min_date"] is None or date_s < acc["min_date"]:
        acc["min_date"] = date_s
    if acc["max_date"] is None or date_s > acc["max_date"]:
        acc["max_date"] = date_s


def _new_year_acc():
    return {"days": set(), "first_dt": None, "last_dt": None,
            "detections": 0, "weeks": {}, "min_date": None}


def _note_year(acc, key, date_s, week, dt):
    e = acc["yr"].get(key)
    if e is None:
        e = _new_year_acc()
        acc["yr"][key] = e
    e["days"].add(date_s)
    e["detections"] += 1
    e["weeks"][week] = e["weeks"].get(week, 0) + 1
    if e["min_date"] is None or date_s < e["min_date"]:
        e["min_date"] = date_s
    if dt is None:
        return
    if e["first_dt"] is None or dt < e["first_dt"]:
        e["first_dt"] = dt
    if e["last_dt"] is None or dt > e["last_dt"]:
        e["last_dt"] = dt


def _scan_row(acc, row):
    acc["source_rows"] += 1
    sci = row["Sci_Name"] or ""
    com = row["Com_Name"]
    raw_date = row["Date"]
    time_s = row["Time"]

    cc = acc["com_counts"].setdefault(sci, {})
    cc[com] = cc.get(com, 0) + 1

    year, week = year_week(raw_date)
    if year is None:
        # Silence, never a guess -- rebuild_catalog.py:343-350's stated rule. An
        # unparseable Date contributes to source_rows and to nothing else.
        return
    date_s = str(raw_date)[:10]
    _note_coverage(acc, date_s)
    # dt mirrors rebuild_catalog.aggregate() exactly: only rows carrying BOTH a
    # Date and a Time contribute a timestamp.
    dt = "%s %s" % (raw_date, time_s) if time_s is not None else None
    _note_year(acc, (sci, year), date_s, week, dt)


def _scan(con):
    acc = _new_acc()
    for row in con.execute(_SCAN_SQL):
        _scan_row(acc, row)
    return acc


# ---- pure builders over the scan -------------------------------------------

def _bird_index(acc):
    """Resolve one Com_Name per species and the set of species that are birds
    (the same is_bird contract as the catalog -- the museum's axis is birds)."""
    com_by_sci = {}
    bird_set = set()
    for sci, cc in acc["com_counts"].items():
        com = pick_com(cc)
        com_by_sci[sci] = com
        if is_bird(sci, com):
            bird_set.add(sci)
    return bird_set, com_by_sci


def _peak_week(week_counts):
    """Highest-count week; ties break to the LOWEST week number. Written as an
    explicit scan over sorted weeks rather than a clever max() key, because the
    tie-break is what makes reruns byte-identical."""
    best_week, best_n = None, 0
    for wk in sorted(week_counts):
        n = week_counts[wk]
        if n > best_n:
            best_week, best_n = wk, n
    return (best_week, best_n)


def _compute_entries(acc, bird_set, com_by_sci, built_at):
    """Build ``{(sci, year): entry}`` from LIVE rows only. Entry shape LOCKED."""
    out = {}
    for key, e in acc["yr"].items():
        sci, year = key
        if sci not in bird_set:
            continue
        peak_week, peak_n = _peak_week(e["weeks"])
        out[key] = {
            "sci_name": sci,
            "com_name": com_by_sci.get(sci),
            "slug": slugify(sci),
            "year": year,
            "first_heard": e["first_dt"],
            "last_heard": e["last_dt"],
            "days_heard": len(e["days"]),
            "detections": e["detections"],
            "peak_week": peak_week,
            "peak_week_n": peak_n,
            # PROVENANCE. A frozen year is unfalsifiable -- its rows are gone --
            # so the entry has to bound what the freeze could possibly have seen.
            "source_rows_at_freeze": acc["source_rows"],
            "min_date_seen": e["min_date"],
            "frozen_at": built_at,
        }
    return out


# ---- the ledger ------------------------------------------------------------

def _load_ledger(path):
    """Return ``{(sci, year): entry}`` from an existing ledger, or ``{}`` if the
    file is MISSING (fresh install).

    A file that EXISTS but is unreadable / not JSON / wrong-shaped RAISES. This
    is the deliberate divergence from rebuild_catalog._load_accessions, which
    degrades to an empty ledger -- see the module docstring.
    """
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)                # ValueError propagates -> exit 5
    entries = data.get("entries") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        raise ValueError(
            "phenology ledger %s is not {\"entries\": [...]} -- refusing to "
            "overwrite a file whose contents cannot be recomputed" % (path,))
    out = {}
    for e in entries:
        if not isinstance(e, dict):
            raise ValueError("phenology ledger %s has a non-object entry" % (path,))
        sci, yr = e.get("sci_name"), e.get("year")
        if not isinstance(sci, str) or not isinstance(yr, int):
            raise ValueError(
                "phenology ledger %s has an entry with no usable "
                "(sci_name, year) key" % (path,))
        out.setdefault((sci, yr), e)        # first writer wins
    return out


def merge_ledger(existing, computed, current_year):
    """THE FREEZE RULE. Returns a NEW dict; mutates neither argument.

      * key in existing AND its year is CLOSED -> keep existing VERBATIM.
      * key in existing AND its year == current_year -> replace with computed
        (the open year is still accumulating).
      * key only in computed -> insert.
      * key only in existing -> keep VERBATIM. Its rows were purged; surviving
        that is the entire purpose of this ledger. NEVER deleted.

    ``current_year is None`` (no parseable Date anywhere) means no year can be
    proven open, so EVERY existing entry is treated as closed rather than
    recomputed from a source we cannot date.
    """
    merged = dict(existing)
    for key, entry in computed.items():
        if key in existing and (current_year is None or key[1] < current_year):
            continue
        merged[key] = entry
    return merged


def build_ledger(birds_path, ledger_path, built_at):
    """Scan birds.db read-only, merge into the existing ledger under the freeze
    rule, and return the full payload. Writes NOTHING -- the caller writes."""
    con = _connect_ro(birds_path)
    try:
        acc = _scan(con)
    finally:
        con.close()

    bird_set, com_by_sci = _bird_index(acc)
    current_year = year_week(acc["max_date"])[0]
    if current_year is None:
        # Explicit, not an accidental TypeError deeper in merge_ledger.
        sys.stderr.write(
            "phenology: current_year is UNKNOWN (no parseable Date in %d scanned "
            "row(s)); every existing entry is treated as CLOSED and frozen "
            "rather than recomputed from undatable rows\n" % (acc["source_rows"],))

    existing = _load_ledger(ledger_path)
    if acc["source_rows"] == 0 and existing:
        # The ledger would survive (merge keeps it), but reporting the death of
        # the source as a cheerful success is exactly the class of silence this
        # project's guards exist to kill.
        raise ValueError(
            "birds.db at %s scanned ZERO rows while the ledger already holds %d "
            "species-year(s). The source is empty (wrong --birds, a restore in "
            "progress, or a truncated db). Refusing to write; the existing "
            "ledger is untouched." % (birds_path, len(existing)))

    computed = _compute_entries(acc, bird_set, com_by_sci, built_at)
    merged = merge_ledger(existing, computed, current_year)
    years = sorted(set(k[1] for k in merged))
    return {
        "version": PHENOLOGY_VERSION,
        "built_at": built_at,
        "current_year": current_year,
        "source_rows": acc["source_rows"],
        "species_years": len(merged),
        # Bounds what this run could possibly have known, so a future reader can
        # tell a stump year from a season without re-deriving anything.
        "coverage": {
            "min_date": acc["min_date"],
            "max_date": acc["max_date"],
            "source_rows": acc["source_rows"],
            "years": years,
        },
        "notes": NOTES,
        "entries": sorted(merged.values(), key=lambda e: (e["year"], e["sci_name"])),
    }


# ---- CLI -------------------------------------------------------------------

def default_paths():
    """Pi defaults relative to this script (repo = two dirs up). phenology.json
    lands beside species.json / derived.json in <repo>/scripts."""
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.abspath(os.path.join(here, "..", ".."))
    birds = (os.environ.get("CHRISTINA_BIRDS_DB")
             or os.environ.get("AV_BIRDS_DB")
             or os.path.join(repo, "scripts", "birds.db"))
    if not os.path.isfile(birds):
        alt = os.path.expanduser("~/BirdNET-Pi/scripts/birds.db")
        if os.path.isfile(alt):
            birds = alt
    out = os.path.join(repo, "scripts", "phenology.json")
    return birds, out


def _summary_line(payload):
    years = payload["coverage"]["years"]
    span = "%d..%d" % (years[0], years[-1]) if years else "no years"
    return (
        "phenology: %d species-years (%s), current_year %s, %d rows, "
        "coverage %s..%s"
        % (payload["species_years"], span, payload["current_year"],
           payload["source_rows"], payload["coverage"]["min_date"],
           payload["coverage"]["max_date"])
    )


def main(argv=None):
    birds_d, out_d = default_paths()
    ap = argparse.ArgumentParser(
        description="Freeze per-year phenology (phenology.json) from birds.db "
                    "before the disk purge removes the rows behind it. "
                    "Read-only over birds.db; atomic, append-only output.",
    )
    ap.add_argument("--birds", default=birds_d, help="path to birds.db (read-only)")
    ap.add_argument("--out", default=out_d, help="output phenology.json path")
    ap.add_argument("--built-at", default=None,
                    help="ISO timestamp stamped into built_at / frozen_at "
                         "(omit -> now, UTC; supply for reproducible output)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print a summary and write NOTHING")
    args = ap.parse_args(argv)

    built_at = args.built_at
    if built_at is None:
        # CLI boundary only -- build_ledger itself is wall-clock free.
        built_at = datetime.datetime.now(datetime.timezone.utc).replace(
            microsecond=0).isoformat()

    if not os.path.isfile(args.birds):
        # A Pi that has not analysed anything yet must not go red (derive.py's
        # precedent). There is nothing to freeze and nothing to lose.
        sys.stderr.write("phenology: birds.db not found at %s (skipping)\n" % args.birds)
        return 0

    # FAIL LOUD. Unlike derive.py's disposable output, this ledger holds history
    # that cannot be recomputed -- so every failure writes NOTHING and exits 5,
    # and systemd marks the unit failed. Silently starting over from an empty
    # ledger would be strictly worse than crashing.
    try:
        payload = build_ledger(args.birds, args.out, built_at)
        if args.dry_run:
            sys.stdout.write("[dry-run, writes nothing] " + _summary_line(payload) + "\n")
            return 0
        _write_json_atomic(args.out, payload)
    except Exception as exc:  # noqa: BLE001 -- name the cause, then fail loudly
        sys.stderr.write(
            "phenology: FAILED (%s: %s) -- NOTHING was written and the per-year "
            "ledger did NOT advance\n" % (type(exc).__name__, exc))
        return 5
    sys.stdout.write(_summary_line(payload) + " -> %s\n" % args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
