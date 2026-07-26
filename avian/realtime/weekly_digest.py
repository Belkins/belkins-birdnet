#!/usr/bin/env python3
"""weekly_digest -- the honest weekly recap push for Christina.

Once a week this composes a calm, factual summary of what the station heard --
"N species heard, M new to the collection, first-of-year: ..., rarest visitor:
..." -- and pushes it via the same ntfy/apprise channel the Railway liveness
check uses. If a RECAP_URL is configured it appends a link to the browser
``/recap`` route so the push carries a tap-through to the illustrated sheet.

Honesty / anti-dark-pattern contract:
  * Every number is REAL and traceable to the catalog (species.json) and the
    derived single-writer (derived.json). Nothing estimated or fabricated.
  * NO streak / FOMO / guilt / "don't break the chain" language. A quiet week
    is a quiet week.
  * Silence-when-nothing-happened is a FEATURE. If nothing new arrived this
    week the default is to stay silent; ``--force`` sends a calm one-liner
    anyway (used for an on-demand recap, not the timer).
  * The "week" is anchored to the DATA's latest detection date, not the wall
    clock, so a stale catalog still produces an honest window.

stdlib only (Python 3.9+); no pip. The ``notify()`` function + the NOTIFY_URL
env var are copied VERBATIM from avian/realtime/railway_liveness.py so both
tools push through the exact same guarded channel -- if that pattern changes
there, change it here too.
"""
import argparse
import datetime
import json
import os
import sys
import urllib.request

# --- ntfy/apprise push: copied verbatim from railway_liveness.py ------------
NOTIFY = os.environ.get("NOTIFY_URL", "").strip()
# Optional link to the browser /recap route, appended to the push body.
RECAP_URL = os.environ.get("RECAP_URL", "").strip()


def notify(msg, title, tag):
    print(msg, flush=True)
    if not NOTIFY:
        return
    try:
        req = urllib.request.Request(
            NOTIFY, data=msg.encode("utf-8"),
            headers={"Title": title, "Priority": "high", "Tags": tag})
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        print(f"notify failed: {e}", flush=True)


# --- data loading -----------------------------------------------------------

# Max age of derived.json before this digest refuses to push. It rebuilds
# nightly, so 72h means three consecutive misses -- unambiguous, not a blip.
STALE_HOURS = 72


def load_json(path):
    """Best-effort read: a missing file or ANY corruption returns None so the
    digest degrades gracefully (never crashes on a half-written source)."""
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _derived_age_hours(derived):
    """Whole hours since derived.json's built_at, or None if unusable.

    None is treated as a REFUSAL upstream, not as freshness: an unparseable
    provenance stamp is exactly as untrustworthy as an old one."""
    if not isinstance(derived, dict):
        return None
    raw = derived.get("built_at")
    if not isinstance(raw, str) or not raw:
        return None
    try:
        built = datetime.datetime.fromisoformat(raw)
    except ValueError:
        return None
    if built.tzinfo is None:
        built = built.replace(tzinfo=datetime.timezone.utc)
    now = datetime.datetime.now(datetime.timezone.utc)
    return int((now - built).total_seconds() // 3600)


def _as_date(s):
    if s is None:
        return None
    try:
        return datetime.date.fromisoformat(str(s)[:10])
    except (TypeError, ValueError):
        return None


def _name(com, sci):
    """Prefer the common name; fall back to the scientific name."""
    if com:
        return com
    return sci or "unknown"


# --- week computation -------------------------------------------------------

def _anchor_date(species):
    """The data's latest detection date (max last_detected). This is the honest
    'now' -- a stale catalog still yields the right window."""
    latest = None
    for sp in species:
        d = _as_date(sp.get("last_detected"))
        if d is not None and (latest is None or d > latest):
            latest = d
    return latest


def compute_week(species, window_days):
    """Return the week window + the species heard / newly-added within it."""
    anchor = _anchor_date(species)
    if anchor is None:
        return None
    start = anchor - datetime.timedelta(days=window_days - 1)
    heard, new_species = [], []
    for sp in species:
        last = _as_date(sp.get("last_detected"))
        if last is not None and start <= last <= anchor:
            heard.append(sp)
        first = _as_date(sp.get("first_confident"))
        if first is not None and start <= first <= anchor:
            new_species.append(sp)
    new_species.sort(key=lambda s: (str(s.get("first_confident") or ""),
                                    _name(s.get("com_name"), s.get("sci_name"))))
    return {
        "anchor": anchor,
        "start": start,
        "heard": heard,
        "new": new_species,
        "heard_scis": set(s.get("sci_name") for s in heard),
    }


def _rarest(derived, heard_scis):
    """The rarest LOCAL visitor (lowest encounter_frac). Prefer one heard this
    week; else fall back to the rarest overall. None if unavailable."""
    if not isinstance(derived, dict):
        return None
    rows = derived.get("local_rarity")
    if not isinstance(rows, list) or not rows:
        return None
    in_week = [r for r in rows if r.get("sci_name") in heard_scis]
    pool = in_week if in_week else rows
    return min(pool, key=lambda r: r.get("encounter_frac", 1.0))


def _foy_names(derived):
    """First-of-year species names (current year, from derived.json)."""
    if not isinstance(derived, dict):
        return [], None
    rows = derived.get("first_of_year")
    year = derived.get("current_year")
    if not isinstance(rows, list):
        return [], year
    names = [_name(r.get("com_name"), r.get("sci_name")) for r in rows]
    return names, year


def _week_dawn(derived, window):
    """Earliest dawn-onset time among the days that fall inside the week."""
    if not isinstance(derived, dict):
        return None
    rows = derived.get("waking_line")
    if not isinstance(rows, list):
        return None
    times = []
    for r in rows:
        d = _as_date(r.get("date"))
        t = r.get("first_time")
        if d is not None and window["start"] <= d <= window["anchor"] and t:
            times.append(t)
    return min(times) if times else None


# --- message ----------------------------------------------------------------

def _fmt_pct(frac):
    return "%.0f%%" % (float(frac) * 100.0)


def build_message(window, derived, max_names=8):
    anchor = window["anchor"].isoformat()
    heard_n = len(window["heard"])
    new = window["new"]
    lines = []

    if new:
        names = [_name(s.get("com_name"), s.get("sci_name")) for s in new]
        lines.append("This week (through %s): %d species heard, %d new to the "
                     "collection." % (anchor, heard_n, len(new)))
        lines.append("New: " + ", ".join(names))
    else:
        lines.append("This week (through %s): %d species heard, nothing new to "
                     "the collection -- a steady week." % (anchor, heard_n))

    foy_names, year = _foy_names(derived)
    if foy_names:
        shown = foy_names[:max_names]
        extra = len(foy_names) - len(shown)
        tail = (" (+%d more)" % extra) if extra > 0 else ""
        lines.append("First-of-year %s: %s%s"
                     % (year, ", ".join(shown), tail))

    rare = _rarest(derived, window["heard_scis"])
    if rare is not None:
        lines.append("Rarest visitor: %s -- heard on %s of active days (%s)."
                     % (_name(rare.get("com_name"), rare.get("sci_name")),
                        _fmt_pct(rare.get("encounter_frac", 0.0)),
                        rare.get("encounter_label", "")))

    dawn = _week_dawn(derived, window)
    if dawn:
        lines.append("Earliest dawn onset this week: %s." % dawn)

    if RECAP_URL:
        lines.append("Full sheet: %s" % RECAP_URL)

    return "\n".join(lines)


# --- CLI --------------------------------------------------------------------

def default_dir():
    """Nightly catalog output dir (where species.json + derived.json live):
    <repo>/scripts, with repo = two dirs up from this file."""
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.abspath(os.path.join(here, "..", ".."))
    return os.path.join(repo, "scripts")


def run(args):
    species = load_json(args.species)
    derived = load_json(args.derived)
    if not isinstance(species, list) or not species:
        sys.stderr.write("weekly-digest: no species.json at %s -- skipping\n"
                         % args.species)
        return 0
    if derived is None:
        sys.stderr.write("weekly-digest: derived.json missing at %s -- "
                         "degrading (rarity/first-of-year omitted)\n" % args.derived)
    elif not args.ignore_stale:
        # A STALE bundle is the dangerous case, not a missing one. Missing was
        # already handled above (we degrade and omit). Stale is present, valid,
        # and silently wrong -- and this is the one surface that PUSHES, so it
        # would deliver 24-day-old "rarest bird this week" straight to a phone
        # with no way to tell. Refuse to send rather than lie in a notification.
        age_h = _derived_age_hours(derived)
        if age_h is None:
            sys.stderr.write("weekly-digest: derived.json has no usable built_at -- "
                             "refusing to push unverifiable figures "
                             "(--ignore-stale to override)\n")
            return 5
        if age_h > STALE_HOURS:
            sys.stderr.write(
                "weekly-digest: derived.json is %dh old (limit %dh) -- REFUSING to "
                "push stale figures. Fix the nightly catalog first: "
                "systemctl status catalog.service  (--ignore-stale to override)\n"
                % (age_h, STALE_HOURS))
            return 5

    window = compute_week(species, args.window_days)
    if window is None:
        sys.stderr.write("weekly-digest: no dated detections -- staying quiet\n")
        return 0

    notable = bool(window["new"])
    if not notable and not args.force:
        sys.stdout.write(
            "weekly-digest: nothing new through %s; staying quiet "
            "(use --force to send anyway)\n" % window["anchor"].isoformat())
        return 0

    msg = build_message(window, derived)
    title = "Christina -- weekly recap"
    if args.dry_run:
        sys.stdout.write("[dry-run, not sent]\n%s\n" % msg)
        return 0
    notify(msg, title, "bird")
    return 0


def main(argv=None):
    d = default_dir()
    ap = argparse.ArgumentParser(
        description="Push the honest weekly recap (species.json + derived.json) "
                    "via the ntfy channel. Quiet by default when nothing is new.")
    ap.add_argument("--dir", default=d,
                    help="nightly catalog output dir (species.json + derived.json)")
    ap.add_argument("--species", default=None, help="override species.json path")
    ap.add_argument("--derived", default=None, help="override derived.json path")
    ap.add_argument("--recap-url", default=None,
                    help="override the /recap link (else RECAP_URL env)")
    ap.add_argument("--window-days", type=int, default=7,
                    help="length of the recap window in days (default 7)")
    ap.add_argument("--force", action="store_true",
                    help="send even when nothing is new (calm one-liner)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the message and send NOTHING")
    ap.add_argument("--ignore-stale", action="store_true",
                    help="push even when derived.json is older than %dh "
                         "(default: refuse, exit 5)" % STALE_HOURS)
    args = ap.parse_args(argv)

    if args.species is None:
        args.species = os.path.join(args.dir, "species.json")
    if args.derived is None:
        args.derived = os.path.join(args.dir, "derived.json")
    if args.recap_url is not None:
        # Late override of the module-level RECAP_URL used by build_message.
        globals()["RECAP_URL"] = args.recap_url.strip()

    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
