#!/usr/bin/env python3
"""Off-box backup of the ONLY irreplaceable state this project owns.

birds.db, the accession ledger (scripts/accessions.json), the phenology ledger
(scripts/phenology.json) and the ~40 Railway-generated London plates cannot be
regenerated -- and today all of them sit on ONE SD card or ONE rented volume.
The ledger's only existing backup, avian/catalog/backup-accessions.sh, writes to
$REPO/scripts/accessions-backups, i.e. the same card, inside the same
`git clean -fdx` blast radius the .gitignore comment (lines 76-78) already
admits. This job pulls all four off the box, nightly, into one dated tar.gz on a
mount that is NOT the card, and screams on any outcome that is not complete.

Everything else regenerates: christina.db, species.json and derived.json rebuild
from birds.db every night, and the 250 bundled nearctic plates are in git.

Run from a systemd timer (offbox-backup.timer, nightly 04:30 -- an hour after
catalog.timer's 03:30 rebuild, so the ledger that leaves the box is the CURRENT
night's). Config via env (EnvironmentFile):
  CHRISTINA_BACKUP_DEST      (REQUIRED) off-box mount dir. Unset => exit 2.
  CHRISTINA_BACKUP_KEEP      (opt) dated archives kept per class (default 14)
  CHRISTINA_BIRDS_DB         (opt) default <repo>/scripts/birds.db
  CHRISTINA_ACCESSIONS       (opt) default <repo>/scripts/accessions.json
  CHRISTINA_PHENOLOGY        (opt) default <repo>/scripts/phenology.json
  CHRISTINA_BUNDLED_MANIFEST (opt) default <repo>/services/birdgen/manifest.json
  AV_RAILWAY_BASE            (opt) birdgen base URL; unset => DEGRADED (exit 3)
  NOTIFY_URL                 (opt) ntfy topic, same one mic-watch + railway-liveness push to
  BACKUP_STATE               (opt) state file (default ~/.christina/backup.state)
  CHRISTINA_BACKUP_TIMEOUT   (opt) per-request seconds (default 20)
  CHRISTINA_BACKUP_BUDGET    (opt) wall-clock seconds for the plate loop (default 1200)
  CHRISTINA_BACKUP_REALERT   (opt) re-push a stuck alert every Nth night (default 7)
  CHRISTINA_BACKUP_ALLOW_SAME_DEVICE  (opt) 1 = allow a dest on the repo's own filesystem
                                      (the offline-rehearsal escape hatch ONLY)

Exit codes (the taxonomy of avian/catalog/nightly.sh: 0 fine, 3 published-but-
DEGRADED, other non-zero = named fault). 3 and 4 must stay distinguishable at 4am:
  0  COMPLETE -- db + ledgers + every expected plate archived and rotated.
  2  REFUSED  -- CHRISTINA_BACKUP_DEST unset/missing/unwritable, or on the SAME
                 filesystem as the repo. NOTHING is written.
  3  DEGRADED -- the archive EXISTS and holds the db + ledgers, but something is
                 missing or suspect (no plates, an EMPTY volume-only plate set, a
                 zero/regressed detection count, a vanished ledger). A backup
                 without plates can NEVER return 0.
  4  FAULT    -- nothing usable was published: birds.db unreadable, the archive
                 could not be written, or the run crashed.

Note on exit 2 vs 3 for a missing env var: railway_liveness.py:62-64 returns 2 for
an unset AV_RAILWAY_BASE because it then has nothing at all to do. Here an unset
AV_RAILWAY_BASE still leaves a real archive on the mount, so it is DEGRADED (3),
not REFUSED (2). Exit 2 is reserved for "nothing was written this run".
"""
import datetime
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tarfile
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent

DEST_RAW = os.environ.get("CHRISTINA_BACKUP_DEST", "").strip()
KEEP = int(os.environ.get("CHRISTINA_BACKUP_KEEP", "14"))               # backup-accessions.sh:23
DB_PATH = Path(os.environ.get("CHRISTINA_BIRDS_DB", str(REPO / "scripts/birds.db")))
LEDGER = Path(os.environ.get("CHRISTINA_ACCESSIONS", str(REPO / "scripts/accessions.json")))
PHENOLOGY = Path(os.environ.get("CHRISTINA_PHENOLOGY", str(REPO / "scripts/phenology.json")))
BUNDLED_MANIFEST = Path(os.environ.get("CHRISTINA_BUNDLED_MANIFEST", str(REPO / "services/birdgen/manifest.json")))
BASE = os.environ.get("AV_RAILWAY_BASE", "").rstrip("/")
NOTIFY = os.environ.get("NOTIFY_URL", "").strip()
STATE = os.path.expanduser(os.environ.get("BACKUP_STATE", "~/.christina/backup.state"))
TIMEOUT = float(os.environ.get("CHRISTINA_BACKUP_TIMEOUT", "20"))
BUDGET = float(os.environ.get("CHRISTINA_BACKUP_BUDGET", "1200"))
REALERT = int(os.environ.get("CHRISTINA_BACKUP_REALERT", "7"))
# nightly.sh rewrites phenology.json at 03:30; this job runs at 04:30. 72h is
# THREE missed nights, so one skipped night (a reboot, a Persistent=true
# catch-up) is not an alert -- but a stopped ledger is caught inside a week.
PHENOLOGY_MAX_AGE_H = float(os.environ.get("CHRISTINA_PHENOLOGY_MAX_AGE_H", "72"))
# Days into a NEW calendar year before a current_year still naming the OLD year
# is evidence the source stopped, rather than a station that has simply not
# heard anything yet this January.
PHENOLOGY_YEAR_GRACE_D = int(os.environ.get("CHRISTINA_PHENOLOGY_YEAR_GRACE_D", "45"))
ALLOW_SAME_DEV = os.environ.get("CHRISTINA_BACKUP_ALLOW_SAME_DEVICE", "") not in ("", "0", "false", "False")

TITLE_FAIL = "Christina backup FAILED"
TITLE_DEGRADED = "Christina backup DEGRADED"

# Minimum bytes for a plate to count as real art -- the same floor cutout.php:179
# applies before it will serve a tier-1 illustration.
MIN_PLATE_BYTES = 1024


class ConfigError(Exception):
    """The destination is unusable. Nothing is written; exit 2."""


class CaptureError(Exception):
    """A local irreplaceable file could not be captured; exit 4.

    Deliberately NOT ConfigError: two exit codes routed off one exception class,
    distinguished only by call-site position, is one refactor away from turning
    every missing-db run into a config fault.
    """


def notify(msg, title, tag):
    # Verbatim from railway_liveness.py:28-38 (identical in mic_watch.py and
    # weekly_digest.py). Same topic, same headers, same swallow-and-print.
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


def load_state():
    try:
        return json.load(open(STATE))
    except Exception:
        return {"fails": 0, "down": False}


def save_state(s):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    json.dump(s, open(STATE, "w"))


def alert_once(state, msg, title, tag):
    """Push on the DOWN transition, then again every REALERT-th consecutive night.

    Every non-zero path routes through here. An ungated notify() on the config or
    fault paths would push high-priority to the SAME ntfy topic that carries
    mic-watch's dead-mic and railway-liveness's DOWN alerts, every night, until
    someone mutes the topic -- which silences those two as well. The re-alert
    cadence exists because pure transition-gating (railway_liveness.py:76) goes
    quiet on night 2..N of a multi-week outage, which is exactly when the archives
    that still held the plates are ageing out.
    """
    state["fails"] = state.get("fails", 0) + 1
    if not state.get("down"):
        state["down"] = True
        notify(msg, title, tag)
    elif REALERT > 0 and state["fails"] % REALERT == 0:
        notify("%s (still failing -- night %d)" % (msg, state["fails"]), title, tag)
    else:
        print(msg, flush=True)


def sha256_of(path):
    h = hashlib.sha256()
    with open(str(path), "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def resolve_dest():
    if not DEST_RAW:
        raise ConfigError(
            "CHRISTINA_BACKUP_DEST is unset -- NOTHING IS BACKED UP OFF-BOX. "
            "Set it in ~/.christina/backup.env to a mount that is not the SD card.")
    d = Path(DEST_RAW).expanduser()
    if not d.is_dir():
        raise ConfigError("CHRISTINA_BACKUP_DEST %s does not exist or is not a directory -- is the mount up?" % d)
    if not os.access(str(d), os.W_OK):
        raise ConfigError("CHRISTINA_BACKUP_DEST %s is not writable by uid %d" % (d, os.getuid()))
    dev = os.stat(str(d)).st_dev
    if dev == os.stat(str(REPO)).st_dev and not ALLOW_SAME_DEV:
        raise ConfigError(
            "CHRISTINA_BACKUP_DEST %s is on the SAME filesystem as the repo (st_dev=%d) -- that is the SD card "
            "this backup exists to survive. Mount real off-box storage, or set CHRISTINA_BACKUP_ALLOW_SAME_DEVICE=1 "
            "if you are rehearsing on a laptop." % (d, dev))
    return d


def snapshot_db(src, out):
    if not src.is_file() or src.stat().st_size == 0:
        raise CaptureError("birds.db missing or empty at %s" % src)
    # SQLite online-backup API, not shutil.copy -- birds.db is being written by
    # birdnet_analysis.py while this runs, and a torn copy is a backup that only
    # fails on the day you need it. pathname2url matches rebuild_catalog.py:497 /
    # derive.py:212; this repo's own checkout path contains a space, so raw
    # interpolation into a file: URI is a real (and confusing) failure here.
    src_conn = sqlite3.connect("file:%s?mode=ro" % urllib.request.pathname2url(str(src.resolve())), uri=True)
    try:
        dst_conn = sqlite3.connect(str(out))
        try:
            src_conn.backup(dst_conn)
        finally:
            dst_conn.close()
    finally:
        src_conn.close()
    detections = species = None
    con = sqlite3.connect("file:%s?mode=ro" % urllib.request.pathname2url(str(out.resolve())), uri=True)
    try:
        detections = con.execute("SELECT COUNT(*) FROM detections").fetchone()[0]
        species = con.execute("SELECT COUNT(DISTINCT Sci_Name) FROM detections").fetchone()[0]
    except sqlite3.Error:
        # Recorded as null AND degraded by check_db(), never as a silent null:
        # a manifest that cannot prove its own contents is not a verified archive.
        pass
    finally:
        con.close()
    return {"bytes": out.stat().st_size, "sha256": sha256_of(out), "detections": detections, "species": species}


def _ledger_entry_count(path):
    """Count LEDGER ENTRIES, never top-level keys. -> int | None (unknown/corrupt).

    Both producers write an ENVELOPE, not a flat map: rebuild_catalog.py:764-765
    emits {"version":..., "entries":[...]} and phenology.py:436-452 emits an
    8-key dict that also carries "entries". len(doc) on either is the CONSTANT 2
    and 8 forever, which silently disarms the zero-entry regression check in
    copy_optional -- a check that can never fire, reporting success, which is
    this project's signature bug. Count the list, or admit we cannot.
    """
    try:
        doc = json.loads(path.read_text())
    except ValueError:
        return None
    if isinstance(doc, list):
        return len(doc)
    if isinstance(doc, dict):
        inner = doc.get("entries")
        if isinstance(inner, list):
            return len(inner)
    # A dict with no "entries" list is not a shape either producer emits. Do not
    # guess a count from it -- an unrecognised envelope is unknown, not empty.
    return None


def copy_optional(src, out, label, prev_entries):
    """Archive a JSON ledger. -> (meta|None, degraded|None, note|None).

    Absent is NOT a fault on a fresh station (backup-accessions.sh:25-29's
    contract) -- but absent AFTER a run that archived entries means it was
    DELETED, which is the loss this job exists to catch.
    """
    if not src.is_file() or src.stat().st_size == 0:
        gone = "%s absent at %s" % (label, src)
        if prev_entries:
            return None, gone + " -- the previous run archived %d entries. IT HAS BEEN DELETED." % prev_entries, None
        return None, None, gone + " -- nothing pinned yet on this station (not a fault)"
    shutil.copy2(str(src), str(out))
    entries = _ledger_entry_count(out)
    deg = None
    if entries is None:
        deg = "%s did not parse as a recognised ledger envelope -- it is CORRUPT, not merely empty" % label
    elif entries == 0 and prev_entries:
        deg = "%s parsed to ZERO entries but the previous run archived %d" % (label, prev_entries)
    return {"bytes": out.stat().st_size, "sha256": sha256_of(out), "entries": entries}, deg, None


def _phenology_signals(path):
    """-> (built_at|None, current_year|None, open_year_detections|None).

    Reads the envelope phenology.py:436-452 writes. Any field it cannot PROVE
    comes back None so the caller degrades on unknown -- never on a default that
    happens to read as healthy.
    """
    try:
        doc = json.loads(path.read_text())
    except ValueError:
        return None, None, None
    if not isinstance(doc, dict):
        return None, None, None
    built = doc.get("built_at")
    year = doc.get("current_year")
    if not isinstance(built, str):
        built = None
    if not isinstance(year, int):
        year = None
    total = None
    entries = doc.get("entries")
    if year is not None and isinstance(entries, list):
        total = 0
        for e in entries:
            if isinstance(e, dict) and e.get("year") == year:
                n = e.get("detections")
                total += n if isinstance(n, int) else 0
    return built, year, total


def check_phenology(src, phen_meta, state, now):
    """The one archived file that can FREEZE while staying perfectly valid.

    copy_optional catches absent-after-present and an unparseable envelope. It
    cannot catch a ledger phenology.py stopped rewriting: the entry COUNT is
    constant the moment the species axis saturates, so a frozen ledger and a
    healthy one are byte-indistinguishable by count. nightly.sh:66-69 does emit
    exit 5 -- but it is the LOWEST-priority branch (a non-zero rc_cat or rc_der
    returns first at lines 50-61) and NOTHING watches catalog.service: no unit in
    this repo carries OnFailure=. This nightly job is the only thing that looks at
    the file at all, so the freeze check belongs here.

    TWO independent keys, because each is blind to the other's failure:
      * built_at AGE -- phenology.py stopped writing. Covers exit 5 AND the
        silent exit-0 skip at phenology.py:507-511 (birds.db not where it looks),
        which produces a green unit and a frozen file.
      * CURRENT-YEAR PROGRESS -- phenology.py runs, built_at advances, but the
        open year is being recomputed from a stale or wrong source. Frozen CLOSED
        years are the freeze rule working as designed and are never a signal;
        only the open year is.

    Absent never reaches here (phen_meta is None), inheriting copy_optional's
    "nothing pinned yet on this station is not a fault" exemption -- a fresh
    station must not go red on day one and get the ntfy topic muted by day three.
    """
    if phen_meta is None:
        return []
    out = []
    built, year, open_det = _phenology_signals(src)
    phen_meta["built_at"] = built
    phen_meta["current_year"] = year
    phen_meta["open_detections"] = open_det

    ts = None
    if built is None:
        out.append("phenology.json carries no usable built_at -- its freshness CANNOT be proven")
    else:
        try:
            ts = datetime.datetime.fromisoformat(built)
        except ValueError:
            out.append("phenology.json built_at %r is not an ISO timestamp -- freshness CANNOT be proven" % built)
    if ts is not None:
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=datetime.timezone.utc)
        age_h = (now - ts).total_seconds() / 3600.0
        if age_h > PHENOLOGY_MAX_AGE_H:
            out.append(
                "phenology.json is FROZEN: built_at %s is %.0fh old (limit %.0fh). nightly.sh's "
                "phenology step is not rewriting it -- every night it stays frozen is a night of "
                "history no future run can recover" % (built, age_h, PHENOLOGY_MAX_AGE_H))

    prev_year = state.get("phenology_current_year")
    prev_open = state.get("phenology_open_detections")
    if year is None:
        out.append("phenology.json carries no current_year -- the ledger cannot say which year is still open")
        return out
    if prev_year is not None and year < prev_year:
        out.append("phenology.json current_year went BACKWARDS %d -> %d -- the open year is being "
                   "rebuilt from a stale or wrong birds.db" % (prev_year, year))
    elif year < now.year and (now - datetime.datetime(now.year, 1, 1, tzinfo=datetime.timezone.utc)).days > PHENOLOGY_YEAR_GRACE_D:
        out.append("phenology.json current_year is still %d, %d days into %d -- the open year never "
                   "advanced; the ledger is tracking data that stopped"
                   % (year, (now - datetime.datetime(now.year, 1, 1, tzinfo=datetime.timezone.utc)).days, now.year))
    elif (open_det is not None and prev_open is not None and prev_year == year
          and open_det < prev_open):
        out.append("phenology.json open-year (%d) detections DROPPED %d -> %d -- the open year is "
                   "being recomputed from fewer rows than the last known-good run"
                   % (year, prev_open, open_det))
    return out


def check_db(db_meta, state):
    """Emptiness is positive evidence of a fault, never a recorded null.

    A valid-but-empty birds.db (BirdNET-Pi's own restore.php re-initialising, a
    wrong CHRISTINA_BIRDS_DB, a corrupt-then-recreated file) would otherwise back
    up nightly, rotate the good copies out, and return 0 -- and the rehearsal
    would pass, because verify() skips a count assertion it cannot make.
    """
    out = []
    det = db_meta.get("detections")
    if det is None:
        out.append("birds.db detection count UNREADABLE (schema surprise) -- the archive cannot prove its own contents")
        return out
    if det == 0:
        out.append("birds.db holds ZERO detections -- this is an EMPTY database, not a backup")
        return out
    prev = state.get("detections")
    if prev and det < prev:
        out.append("birds.db detections DROPPED %d -> %d -- the table is append-only, a drop is evidence of damage" % (prev, det))
    return out


def remote_slugs(base, timeout):
    """GET /manifest, asserting its SHAPE. Raises on anything unexpected.

    `.get("slugs", [])` on a garbage/HTML/truncated body yields [] silently, and
    [] is indistinguishable here from "the volume is intact but empty" -- both
    must be loud, so neither is allowed to arrive as a default.
    """
    doc = json.loads(urllib.request.urlopen(base + "/manifest", timeout=timeout).read())
    if not isinstance(doc, dict):
        raise ValueError("/manifest is not a JSON object (got %s)" % type(doc).__name__)
    slugs = doc.get("slugs")
    if not isinstance(slugs, list) or not slugs:
        raise ValueError("/manifest carries no non-empty 'slugs' list")
    return slugs


def volume_slugs(base, bundled_path, timeout):
    """-> (volume-only slugs, bundled count).

    /manifest is BUNDLED | generated(volume) (services/birdgen/app.py:1613-1617)
    and BUNDLED is exactly this committed manifest (app.py:202-211). The
    difference is the set that exists ONLY on the Railway volume -- the 250
    bundled nearctic plates are already in git and re-downloading them nightly is
    bandwidth we do not need. birdgen refuses to enqueue (app.py:1683) or
    manually repaint (app.py:1770) a bundled slug, so the difference is exact.
    """
    bundled = set(json.loads(bundled_path.read_text()).get("slugs") or [])
    remote = remote_slugs(base, timeout)
    if len(remote) < len(bundled):
        raise ValueError("/manifest returned %d slugs, FEWER than the %d committed bundled slugs -- "
                         "the deployed image is not this repo's" % (len(remote), len(bundled)))
    return sorted(set(remote) - bundled), len(bundled)


def fetch_plate(base, name, out, timeout):
    """-> "ok" | "fallback" | "missing (<why>)".

    A pose-2 miss does NOT 404 -- app.py:1628-1643 serves the pose-1 bytes back
    with X-Av-Pose-Fallback: 1. Storing those as <slug>-2.png would restore a
    perched render into the flight tab permanently, with no error anywhere.
    The <why> is carried because a 500, a cold-start timeout and a genuine 404
    demand different reactions and must not collapse into one word.
    """
    try:
        resp = urllib.request.urlopen(base + "/asset/" + name, timeout=timeout)
        if resp.headers.get("X-Av-Pose-Fallback") == "1":
            return "fallback"
        data = resp.read()
    except urllib.error.HTTPError as e:
        return "missing (HTTP %s)" % e.code
    except Exception as e:
        return "missing (%s: %s)" % (type(e).__name__, e)
    if len(data) < MIN_PLATE_BYTES:
        return "missing (%d bytes, below cutout.php:179's %d-byte real-art floor)" % (len(data), MIN_PLATE_BYTES)
    out.write_bytes(data)
    return "ok"


def fetch_all_plates(base, slugs, out_dir, degraded):
    """-> (files meta, pose-1 successes). Bounded by BUDGET seconds.

    TimeoutStartSec=1800 in the unit is a SIGTERM: it kills the process before
    notify() can run, so a slow mount or a hostile manifest would produce a red
    unit and no phone push. This budget degrades loudly instead.
    """
    plates = {}
    got = 0
    deadline = time.monotonic() + BUDGET
    for i, slug in enumerate(slugs):
        if time.monotonic() > deadline:
            degraded.append("plate fetch BUDGET (%ds) exhausted after %d of %d slugs" % (BUDGET, i, len(slugs)))
            break
        p1 = out_dir / (slug + ".png")
        r = fetch_plate(base, slug + ".png", p1, TIMEOUT)
        if r == "ok":
            got += 1
            plates[p1.name] = {"bytes": p1.stat().st_size, "sha256": sha256_of(p1)}
        else:
            degraded.append("plate %s.png %s" % (slug, r))
        p2 = out_dir / (slug + "-2.png")
        # "fallback"/"missing" on pose-2 is NORMAL and is never degraded.
        if fetch_plate(base, slug + "-2.png", p2, TIMEOUT) == "ok":
            plates[p2.name] = {"bytes": p2.stat().st_size, "sha256": sha256_of(p2)}
    return plates, got


def collect_plates(out_dir, degraded, state):
    """-> (files meta, expected, fetched)."""
    if not BASE:
        degraded.append("AV_RAILWAY_BASE unset -- the Railway plates were NOT backed up")
        return {}, 0, 0
    try:
        slugs, n_bundled = volume_slugs(BASE, BUNDLED_MANIFEST, TIMEOUT)
    except Exception as e:
        degraded.append("Railway unusable at %s (%s: %s) -- plates NOT backed up" % (BASE, type(e).__name__, e))
        return {}, 0, 0
    expected = len(slugs)
    prev = state.get("expected") or 0
    if expected == 0:
        # THE case this whole item exists for. An empty Railway volume still
        # serves all 250 bundled slugs from /app and answers /manifest 200, so
        # the naive difference is the empty set and a naive job reports SUCCESS
        # on the exact catastrophe. Emptiness is evidence, not "nothing to do".
        degraded.append("the volume-only plate set is EMPTY (remote /manifest == the %d committed bundled slugs) -- "
                        "either the Railway VOLUME IS GONE or the deployed manifest.json has drifted" % n_bundled)
        return {}, 0, 0
    if prev and expected * 10 < prev * 9:
        degraded.append("volume-only plate count COLLAPSED %d -> %d (below 90%% of the previous run)" % (prev, expected))
    plates, got = fetch_all_plates(BASE, slugs, out_dir, degraded)
    if got < expected:
        degraded.append("fetched %d of %d expected pose-1 plates" % (got, expected))
    return plates, expected, got


def build_archive(stage, dest, stamp, degraded):
    """Write <dest>/christina-backup-<stamp>[-degraded].tar.gz atomically.

    Written as .part and os.replace'd: rotation sorts by filename and keeps the
    newest N, so a tar interrupted by a power cut or a full mount must never be
    counted as one of them. The -degraded suffix is what lets rotate() keep the
    newest COMPLETE archive no matter how many degraded nights follow it.
    """
    name = "christina-backup-%s%s.tar.gz" % (stamp, "-degraded" if degraded else "")
    final = dest / name
    part = dest / (name + ".part")
    try:
        with tarfile.open(str(part), "w:gz") as tf:
            tf.add(str(stage), arcname="christina-backup-" + stamp)
        os.replace(str(part), str(final))
    except Exception:
        if part.exists():
            part.unlink()
        raise
    (dest / (name + ".sha256")).write_text("%s  %s\n" % (sha256_of(final), name))
    return final


def rotate(dest, keep):
    """Keep the newest `keep` of EACH class. Never touch anything but our pattern.

    The two classes rotate independently on purpose. With one pool, 14 degraded
    nights (Railway down, a typo'd base URL, a half-broken mount) evict all 14
    archives that DID hold the plates and replace them with 14 that do not --
    the backup system as the deletion mechanism. Independent pools mean the
    newest COMPLETE archive survives an outage of any length.
    """
    if keep <= 0:
        return []
    removed = []
    for suffix in ("-degraded.tar.gz", ".tar.gz"):
        names = sorted(p.name for p in dest.glob("christina-backup-*" + suffix)
                       if suffix != ".tar.gz" or not p.name.endswith("-degraded.tar.gz"))
        # the stamp is ISO-basic UTC, so lexical order == chronological order
        for n in names[:-keep]:
            (dest / n).unlink()
            side = dest / (n + ".sha256")
            if side.exists():
                side.unlink()
            removed.append(n)
    return removed


def remember(state, db_meta, led_meta, phen_meta, expected, got):
    """Baselines for the NEXT run's regression checks.

    Only overwrite a baseline with a number this run actually observed: a Railway
    outage must not reset `expected` to 0 and thereby disarm the collapse
    detector permanently.
    """
    if db_meta.get("detections") is not None:
        state["detections"] = db_meta["detections"]
    if led_meta and led_meta.get("entries") is not None:
        state["ledger_entries"] = led_meta["entries"]
    if phen_meta and phen_meta.get("entries") is not None:
        state["phenology_entries"] = phen_meta["entries"]
    if phen_meta and phen_meta.get("current_year") is not None:
        state["phenology_current_year"] = phen_meta["current_year"]
    if phen_meta and phen_meta.get("open_detections") is not None:
        state["phenology_open_detections"] = phen_meta["open_detections"]
    if expected > 0 and got >= expected:
        state["expected"] = expected


def _capture_local(stage, degraded, notes, state, now):
    """-> (db_meta, led_meta, phen_meta). Raises CaptureError/OSError on exit-4 faults."""
    db_meta = snapshot_db(DB_PATH, stage / "birds.db")
    led_meta, led_deg, led_note = copy_optional(LEDGER, stage / "accessions.json",
                                                "accessions.json", state.get("ledger_entries"))
    phen_meta, phen_deg, phen_note = copy_optional(PHENOLOGY, stage / "phenology.json",
                                                   "phenology.json", state.get("phenology_entries"))
    degraded.extend([m for m in (led_deg, phen_deg) if m])
    notes.extend([m for m in (led_note, phen_note) if m])
    degraded.extend(check_phenology(stage / "phenology.json", phen_meta, state, now))
    degraded.extend(check_db(db_meta, state))
    return db_meta, led_meta, phen_meta


def _fault(state, msg, err):
    alert_once(state, "%s: %s" % (msg, err), TITLE_FAIL, "rotating_light")
    save_state(state)
    print("FAIL: %s" % err, file=sys.stderr)
    return 4


def _run(stamp, state):
    # The run's own clock, taken from the stamp so a test can pin it.
    now = datetime.datetime.strptime(stamp, "%Y%m%dT%H%M%SZ").replace(
        tzinfo=datetime.timezone.utc)
    try:
        dest = resolve_dest()
    except ConfigError as e:
        alert_once(state, "BACKUP NOT CONFIGURED: %s" % e, "Christina backup UNCONFIGURED", "warning")
        save_state(state)
        print(str(e), file=sys.stderr)
        return 2

    degraded, notes = [], []
    stage = dest / (".staging-%s" % stamp)
    try:
        (stage / "plates").mkdir(parents=True, exist_ok=True)
        try:
            db_meta, led_meta, phen_meta = _capture_local(stage, degraded, notes, state, now)
        except Exception as e:
            return _fault(state, "BACKUP FAILED -- birds.db/ledgers not captured this run", e)
        plates, expected, got = collect_plates(stage / "plates", degraded, state)
        manifest = {
            "version": 1, "stamp": stamp, "railway_base": BASE,
            "birds_db": db_meta, "accessions": led_meta, "phenology": phen_meta,
            "plates": {"expected": expected, "fetched": got, "files": plates},
            "degraded": degraded, "notes": notes,
        }
        (stage / "MANIFEST.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        try:
            archive = build_archive(stage, dest, stamp, bool(degraded))
        except Exception as e:
            return _fault(state, "BACKUP FAILED -- could not write the archive to %s" % dest, e)
    finally:
        # Staging lives INSIDE the destination, never /tmp and never the SD card:
        # an unattended nightly must not be able to fill the card it is
        # protecting. That costs one extra pass over the mount; do not "optimise"
        # it back onto the card. Leaking it would fill the mount in a fortnight.
        shutil.rmtree(str(stage), ignore_errors=True)

    removed = rotate(dest, KEEP)
    print("backup -> %s (%d plate files, %d rotated out)" % (archive, len(plates), len(removed)))
    if degraded:
        # Baselines are deliberately NOT advanced here. remember() runs only on a
        # clean run, below. Advancing a baseline on the very run that tripped it
        # lets all three regression detectors (detection-count drop, ledger
        # emptied/deleted, plate-count collapse) self-heal after exactly ONE
        # night: night 2 re-baselines against the damage, night 3 returns 0 and
        # pushes RECOVERED over permanently lost data. Compare always against the
        # last KNOWN-GOOD run, never against the last run.
        alert_once(state, "DEGRADED backup %s: %s" % (archive.name, "; ".join(degraded[:6])),
                   TITLE_DEGRADED, "warning")
        save_state(state)
        return 3
    remember(state, db_meta, led_meta, phen_meta, expected, got)
    if state.get("down"):
        notify("RECOVERED: complete backup %s (%d plate files) at %s." % (archive.name, len(plates), dest),
               "Christina backup OK", "white_check_mark")
    state["fails"] = 0
    state["down"] = False
    save_state(state)
    return 0


def main():
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())   # backup-accessions.sh:36
    state = load_state()
    try:
        return _run(stamp, state)
    except Exception as e:
        # Without this the unit's most likely crashes (a socket.timeout mid-read,
        # a truncated /manifest body, ENOSPC on the mount) exit with a traceback,
        # a red unit, and NO push -- the silent-red failure this job exists to kill.
        alert_once(state, "BACKUP CRASHED: %r" % (e,), TITLE_FAIL, "rotating_light")
        save_state(state)
        print("CRASH: %r" % (e,), file=sys.stderr)
        return 4


if __name__ == "__main__":
    sys.exit(main())
