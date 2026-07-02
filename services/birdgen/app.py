#!/usr/bin/env python3
"""birdgen — Railway on-demand kachō-e bird generation service.

Phase A of the auto-gen watcher (see _plan/auto-gen-watcher/CONTRACT.md, the
LOCKED single source of truth). A Pi-side forwarder POSTs first-hearings of an
un-bundled species to /detected; this service generates BOTH poses per new
species — a perched pose-1 (<slug>.png) and, best-effort, an in-flight pose-2
(<slug>-2.png) — cream-keys each to a transparent PNG, runs a QA gate, and
serves them from a Railway volume at /asset/<slug>.png and /asset/<slug>-2.png.

Contract obligations honored here:
  - Bearer auth on /detected (Authorization: Bearer <WATCHER_WEBHOOK_SECRET>).
  - In-memory token-bucket rate-limit on /detected (429 over).
  - CONFIDENCE_THRESHOLD = 0.80 gate.
  - BOTH poses per species: pose-1 (perched) is required; pose-2 (flight) is
    best-effort — a pose-2 gen/QA failure never blocks or deads the species, and
    the species is "done" once pose-1 is published. This reverses the original
    pose-1-ONLY decision (was KILL 6) now that the collage popup exposes a
    per-bird flight toggle for auto-generated species.
  - SQLite lease on the volume is the authoritative terminal state
    (queued | generating | done | dead). Only a model *safety* refusal is
    terminal-dead; other fails cool down after MAX_ATTEMPTS and retry in bursts
    (stochastic gen eventually lands), so no species is a forever-silhouette.
  - Single-flight asyncio worker; MIN_SPACING = 6s between Gemini calls;
    exponential backoff on failure (gen_one does the per-call 429/5xx retry).
  - QA gate: chromakey opaque-fraction in [0.015, 0.75] PLUS a deterministic
    dirty-output gate (torn-paper alpha islands / leaked magenta / ragged edge /
    border-contact / mangled aspect) and an optional AV_VERIFY Gemini gate; a
    failed gate re-queues on a short backoff (then dead after MAX_ATTEMPTS), and
    never publishes.
  - POST /requeue (Bearer): reset dirty done/dead species to queued over HTTP so
    the volume state can be wiped after a redeploy without shell access.
  - GEMINI_API_KEY via x-goog-api-key header (in pregen.gen_one), NEVER logged.
  - /manifest = bundled(manifest.json) UNION generated(volume): single dedup SoT.

Storage assumes numReplicas=1 (single-flight worker + single-attach volume +
in-memory rate-limit + in-memory wakeup queue all assume one instance).
"""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import re
import sqlite3
import threading
import time
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from PIL import Image
from pydantic import BaseModel

# Ported generation pipeline (verbatim copies of the avian/scripts originals).
import pregen
from creamkey import chromakey
from verify import verify_one

# --------------------------------------------------------------------------- #
# Configuration (all via env; secrets never logged)
# --------------------------------------------------------------------------- #
HERE = Path(__file__).resolve().parent

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
WATCHER_WEBHOOK_SECRET = os.environ.get("WATCHER_WEBHOOK_SECRET", "")

# 0.70 matches what BirdNET-Pi itself records (and the forwarder's AV_CONF
# default): anything honest enough for the roster is honest enough to paint.
# A stricter gate here strands 0.70-0.79 birds as forever-silhouettes (the
# Black-headed Gull scar: heard at 0.73, rejected by the old 0.80 pair).
CONF_THRESHOLD = float(os.environ.get("CONF_THRESHOLD", "0.70"))
MIN_SPACING = float(os.environ.get("MIN_SPACING", "6"))          # s between Gemini calls
MAX_ATTEMPTS = int(os.environ.get("MAX_ATTEMPTS", "4"))          # fails -> cooldown burst (non-safety never permanent-dead)
POSE2_TRIES = int(os.environ.get("POSE2_TRIES", "3"))            # inline flight-pose re-rolls per gen (~50% roll)
BACKOFF_BASE = float(os.environ.get("BACKOFF_BASE", "900"))      # 15 min
BACKOFF_MAX = float(os.environ.get("BACKOFF_MAX", "21600"))      # 6 h cap
DEAD_COOLDOWN = float(os.environ.get("DEAD_COOLDOWN", "1800"))   # 30 min between bursts after MAX_ATTEMPTS (a first gen shouldn't wait 6h)
# QA rejects are cheap stochastic misses (usually clean on the next roll), so
# they re-queue on a SHORT backoff instead of the 15m+ network-transient one.
QA_BACKOFF_BASE = float(os.environ.get("QA_BACKOFF_BASE", "30"))  # s
QA_BACKOFF_MAX = float(os.environ.get("QA_BACKOFF_MAX", "120"))   # s cap
LEASE_TTL = int(os.environ.get("LEASE_TTL", "600"))             # generating-state crash guard
POLL_INTERVAL = float(os.environ.get("POLL_INTERVAL", "5"))     # worker idle re-poll (catches backoff)

QA_MIN = float(os.environ.get("QA_MIN_FRAC", "0.015"))
QA_MAX = float(os.environ.get("QA_MAX_FRAC", "0.75"))

# Deterministic dirty-output gate. The opaque-fraction band alone lets a
# torn-paper beige island (bird + a keyed-in ground fragment) through, so add
# pure-Pillow checks on the keyed RGBA. All thresholds env-tunable so prod can
# retune without a redeploy; zero extra Gemini spend.
QA_ALPHA_ON = int(os.environ.get("QA_ALPHA_ON", "10"))            # alpha > this = opaque
QA_DOWNSCALE = int(os.environ.get("QA_DOWNSCALE", "400"))         # px cap for pixel analysis
QA_MAGENTA_TOL = int(os.environ.get("QA_MAGENTA_TOL", "60"))      # matches chromakey tol
QA_MAGENTA_MAX = float(os.environ.get("QA_MAGENTA_MAX", "0.02"))  # >2% opaque magenta -> reject
QA_RAGGED_MAX = float(os.environ.get("QA_RAGGED_MAX", "0.6"))     # semi-opaque / opaque
# Disconnected alpha components (water ripples, reflections, torn-paper beige
# fragments) are SCRUBBED — erased, keeping the dominant blob — up to this
# fraction of the frame; past it the render is rejected (that much detached
# paint could be a second bird / severed wing, and erasing would mutilate).
# Replaces the old reject-only QA_ISLAND_MAX=0.015: water birds systematically
# paint ~5% of ripples and were stuck re-rolling forever (Black-headed Gull).
QA_ISLAND_SCRUB = float(os.environ.get("QA_ISLAND_SCRUB", "0.10"))
# Hollow-cutout floor: opaque pixels / alpha-bbox area of the FINAL cutout.
# Known-good plates measure 0.21-0.38 bbox-fill (n=158 bundled cutouts; the
# minimum is a long-tailed dove at 0.210). The white-gull mutilations — the
# key flooding through pale plumage, leaving a wing + a faint outline —
# measured 0.140 (perched) / 0.088 (flight). Below the floor the render is a
# fragment, never publishable; the gen loop retries on a darker ground.
QA_MIN_FILL = float(os.environ.get("QA_MIN_FILL", "0.17"))
QA_BORDER_FRAC = float(os.environ.get("QA_BORDER_FRAC", "0.05"))  # opaque along a side band
QA_BORDER_SIDES = int(os.environ.get("QA_BORDER_SIDES", "2"))     # >= sides touched -> reject
QA_ASPECT_MIN = float(os.environ.get("QA_ASPECT_MIN", "0.45"))
QA_ASPECT_MAX = float(os.environ.get("QA_ASPECT_MAX", "2.2"))

# Adversarial species/anatomy gate (verify.verify_one -> one extra Gemini-Vision
# call per generation). ON by default now that a bounded verify-reject budget
# (AV_VERIFY_MAX_REJECTS) publishes the least-bad render instead of looping
# forever; disable with AV_VERIFY=0. Preserves the relaxed _qa_verify thresholds
# (wing_count>2, matches_target only rejected at high confidence) — the
# greenfinch folded-wings scar.
AV_VERIFY = os.environ.get("AV_VERIFY", "1") not in ("", "0", "false", "False")

RATE_CAPACITY = float(os.environ.get("RATE_CAPACITY", "30"))     # token bucket size
RATE_REFILL = float(os.environ.get("RATE_REFILL", "1.0"))       # tokens / second

ASSETS_DIR = Path(os.environ.get("ASSETS_DIR", "/data/assets"))
DB_PATH = ASSETS_DIR / "state.db"
PROMPT_PATH = Path(os.environ.get("PROMPT_PATH", str(HERE / "prompt.template.md")))
NOTES_PATH = Path(os.environ.get("NOTES_PATH", str(HERE / "species-notes.json")))
MANIFEST_PATH = HERE / "manifest.json"

# References. Wikipedia anatomy refs are fetched + cached on the volume.
# Style refs are now BUNDLED: a curated set of the project's own house plates
# ships at services/birdgen/styles/ and is used by default (AV_STYLES_DIR
# overrides to a mounted volume of the real Edo prints, or empty to disable the
# style lock). Anti-refs are still NOT bundled; if an anti dir is mounted they
# are used, otherwise gen_one degrades gracefully (these args are optional).
FETCH_REFS = os.environ.get("FETCH_REFS", "1") not in ("0", "false", "False", "")
REFS_DIR = Path(os.environ.get("REFS_DIR", str(ASSETS_DIR / "_refs")))
ANTI_DIR = Path(os.environ.get("ANTI_DIR", str(REFS_DIR)))
_styles = os.environ.get("AV_STYLES_DIR", str(HERE / "styles"))
STYLES_DIR: Optional[Path] = Path(_styles) if _styles else None

# Rough per-pose Gemini image cost. Feeds the persistent spend ledger + the
# cost-estimate log line (an ESTIMATE: count × unit cost, never a billed figure).
COST_PER_GEN_USD = float(os.environ.get("COST_PER_GEN_USD", "0.04"))
COST_PER_VERIFY_USD = float(os.environ.get("COST_PER_VERIFY_USD", "0.002"))  # gemini-2.5-flash verify call (image-in, ~500 tok out) — much cheaper than image-out; ESTIMATE
MONTHLY_BUDGET_USD = float(os.environ.get("MONTHLY_BUDGET_USD", "20"))       # soft ceiling on ESTIMATED month spend; 0 = unlimited
AV_VERIFY_MAX_REJECTS = int(os.environ.get("AV_VERIFY_MAX_REJECTS", "3"))    # per-species verify-reject budget before accept-with-flag (keep < MAX_ATTEMPTS)
LEDGER_PATH = ASSETS_DIR / "gen-ledger.json"  # persistent spend ledger on the SAME volume as PNGs + state.db

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("birdgen")

# --------------------------------------------------------------------------- #
# Loaded-at-startup constants
# --------------------------------------------------------------------------- #
PROMPT = pregen.load_prompt(PROMPT_PATH)
NOTES = pregen.load_species_notes(NOTES_PATH)


def _load_bundled() -> set:
    try:
        data = json.loads(MANIFEST_PATH.read_text())
        return set(data.get("slugs", []))
    except Exception as e:  # pragma: no cover - manifest is shipped in the image
        log.error("manifest load failed: %s", e)
        return set()


BUNDLED = _load_bundled()


# Pose-2+ files are published as "<slug>-<N>.png". Bird scientific names never
# contain digits, so a trailing "-<digits>" segment unambiguously marks a pose
# variant (not a real species slug) — used to keep the manifest/dedup keyed on
# the pose-1 slug only and to resolve a pose-2 miss back to its pose-1 file.
_POSE_SUFFIX_RE = re.compile(r"-\d+$")


def generated_slugs() -> set:
    """Species slugs whose pose-1 PNG exists on the volume (top-level *.png,
    excluding pose-variant files like "<slug>-2.png"). This is the dedup unit —
    a species is present once its perched pose-1 is published; pose-2 is an
    optional companion file, not a species of its own."""
    try:
        return {f[:-4] for f in os.listdir(ASSETS_DIR)
                if f.endswith(".png") and not _POSE_SUFFIX_RE.search(f[:-4])}
    except FileNotFoundError:
        return set()


# --------------------------------------------------------------------------- #
# SQLite lease / state machine  (authoritative terminal state, on the volume)
# --------------------------------------------------------------------------- #
_db_lock = threading.Lock()
_conn: Optional[sqlite3.Connection] = None


def db() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        ASSETS_DIR.mkdir(parents=True, exist_ok=True)
        _conn = sqlite3.connect(str(DB_PATH), check_same_thread=False, timeout=30)
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute(
            """
            CREATE TABLE IF NOT EXISTS species_jobs (
                slug        TEXT PRIMARY KEY,
                sci         TEXT,
                com         TEXT,
                conf        REAL,
                state       TEXT,        -- queued | generating | done | dead
                attempts    INTEGER DEFAULT 0,
                next_retry  INTEGER DEFAULT 0,
                lease_until INTEGER DEFAULT 0,
                fail_reason TEXT,
                verify_rejects INTEGER DEFAULT 0,
                updated_ts  INTEGER
            )
            """
        )
        _conn.commit()
        # Guarded migration: existing volumes have the table but not the
        # verify_rejects column. A bare ADD COLUMN on redeploy would crash the
        # second boot, so swallow the "duplicate column" OperationalError.
        try:
            _conn.execute("ALTER TABLE species_jobs ADD COLUMN verify_rejects INTEGER DEFAULT 0")
            _conn.commit()
        except sqlite3.OperationalError:
            pass  # column already exists
    return _conn


def get_state(slug: str) -> Optional[str]:
    with _db_lock:
        row = db().execute(
            "SELECT state FROM species_jobs WHERE slug=?", (slug,)
        ).fetchone()
    return row[0] if row else None


def insert_queued(slug: str, sci: str, com: str, conf: float) -> None:
    now = int(time.time())
    with _db_lock:
        db().execute(
            """
            INSERT INTO species_jobs (slug, sci, com, conf, state, attempts,
                                      next_retry, lease_until, updated_ts)
            VALUES (?, ?, ?, ?, 'queued', 0, 0, 0, ?)
            ON CONFLICT(slug) DO UPDATE SET
                conf=max(species_jobs.conf, excluded.conf),
                updated_ts=excluded.updated_ts
            """,
            (slug, sci, com, conf, now),
        )
        db().commit()


def claim_one_due() -> Optional[dict]:
    """CAS-claim the next eligible job. Single-flight, so a lock suffices.
    Reclaims a 'generating' row whose lease has expired (crash recovery)."""
    now = int(time.time())
    with _db_lock:
        row = db().execute(
            """
            SELECT slug, sci, com, attempts FROM species_jobs
            WHERE (state='queued'     AND next_retry  <= ?)
               OR (state='generating' AND lease_until <  ?)
            ORDER BY next_retry ASC
            LIMIT 1
            """,
            (now, now),
        ).fetchone()
        if not row:
            return None
        slug, sci, com, attempts = row
        db().execute(
            """
            UPDATE species_jobs
               SET state='generating', lease_until=?, attempts=attempts+1, updated_ts=?
             WHERE slug=?
            """,
            (now + LEASE_TTL, now, slug),
        )
        db().commit()
        return {"slug": slug, "sci": sci, "com": com, "attempts": attempts + 1}


def mark_done(slug: str) -> None:
    now = int(time.time())
    with _db_lock:
        db().execute(
            "UPDATE species_jobs SET state='done', fail_reason=NULL, updated_ts=? WHERE slug=?",
            (now, slug),
        )
        db().commit()


def get_verify_rejects(slug: str) -> int:
    with _db_lock:
        row = db().execute(
            "SELECT verify_rejects FROM species_jobs WHERE slug=?", (slug,)
        ).fetchone()
    return int(row[0]) if row and row[0] is not None else 0


def bump_verify_rejects(slug: str) -> int:
    with _db_lock:
        db().execute(
            "UPDATE species_jobs SET verify_rejects=COALESCE(verify_rejects,0)+1 WHERE slug=?",
            (slug,),
        )
        db().commit()
        row = db().execute(
            "SELECT verify_rejects FROM species_jobs WHERE slug=?", (slug,)
        ).fetchone()
    return int(row[0]) if row and row[0] is not None else 0


def mark_fail(slug: str, fail_class: str, reason: str, attempts: int) -> str:
    """Apply the failure policy. Returns the resulting state."""
    now = int(time.time())
    # Only a safety refusal is terminal-dead. Every other failure re-queues:
    # short backoff within a burst, then a long cooldown + fresh burst at the cap
    # (stochastic gen eventually lands — no species stays a forever-silhouette).
    reset_attempts = False
    if fail_class == "safety":
        # a model safety refusal / genuinely un-generatable input is terminal.
        state, next_retry = "dead", 0
    elif attempts >= MAX_ATTEMPTS:
        # A burst of MAX_ATTEMPTS consecutive non-safety fails is spent — but gen
        # is stochastic, so a species that missed today often lands on a later
        # roll. Rather than a permanent 'dead' (which stranded greenfinch et al.
        # as forever-silhouettes with no auto-recovery), cool down for
        # DEAD_COOLDOWN then start a FRESH burst. Cost is bounded to MAX_ATTEMPTS
        # gens / cooldown; a first gen recovers in ~30 min, not 6 h.
        state = "queued"
        next_retry = now + int(DEAD_COOLDOWN)
        reset_attempts = True
    elif fail_class == "qa":
        # a dirty render is a cheap stochastic miss -> re-roll fast (30-120s),
        # not the 15m+ network-transient backoff.
        state = "queued"
        backoff = min(QA_BACKOFF_BASE * (2 ** (attempts - 1)), QA_BACKOFF_MAX)
        next_retry = now + int(backoff)
    else:
        state = "queued"
        backoff = min(BACKOFF_BASE * (2 ** (attempts - 1)), BACKOFF_MAX)
        next_retry = now + int(backoff)
    reason_str = ("%s:%s" % (fail_class, reason))[:300]
    with _db_lock:
        if reset_attempts:
            db().execute(
                """
                UPDATE species_jobs
                   SET state=?, next_retry=?, attempts=0, fail_reason=?, updated_ts=?
                 WHERE slug=?
                """,
                (state, next_retry, reason_str, now, slug),
            )
        else:
            db().execute(
                """
                UPDATE species_jobs
                   SET state=?, next_retry=?, fail_reason=?, updated_ts=?
                 WHERE slug=?
                """,
                (state, next_retry, reason_str, now, slug),
            )
        db().commit()
    return state


def counts() -> tuple:
    with _db_lock:
        q = db().execute(
            "SELECT COUNT(*) FROM species_jobs WHERE state='queued'"
        ).fetchone()[0]
        d = db().execute(
            "SELECT COUNT(*) FROM species_jobs WHERE state='done'"
        ).fetchone()[0]
    return q, d


# --------------------------------------------------------------------------- #
# Persistent spend ledger  (JSON on the SAME volume as PNGs + state.db)
# --------------------------------------------------------------------------- #
# Raw counts are stored, bucketed by UTC month; spend is DERIVED on read
# (gens*COST_PER_GEN_USD + verifies*COST_PER_VERIFY_USD) so it stays an honest
# ESTIMATE and the cost constants can be retuned without rewriting history. The
# UTC month bucket auto-resets spend at the boundary (budget "retried" next
# month). Ops-only — these numbers never reach the museum frontend.
# Writers run in the single worker thread (asyncio.to_thread); /health reads on
# the event loop — both are OS threads relative to each other, so a dedicated
# threading.Lock (NOT an asyncio lock) guards every read-modify-write and read.
_ledger_lock = threading.Lock()


def _month_key(ts=None) -> str:
    t = time.gmtime(ts if ts is not None else time.time())  # UTC, matches int(time.time()) elsewhere
    return "%04d-%02d" % (t.tm_year, t.tm_mon)


def _ledger_load() -> dict:
    try:
        return json.loads(LEDGER_PATH.read_text())
    except FileNotFoundError:
        return {}
    except Exception as e:  # corrupt ledger must not crash or falsely block gen
        log.warning("ledger load failed (%s) — treating as empty (fail-open)", e)
        return {}


def _ledger_save(data: dict) -> None:
    tmp = ASSETS_DIR / ".gen-ledger.json.tmp"
    tmp.write_text(json.dumps(data))
    os.replace(str(tmp), str(LEDGER_PATH))  # atomic, same fs


def _record(kind: str, n: int = 1) -> None:  # kind in {'gens','verifies'}
    mk = _month_key()
    with _ledger_lock:
        data = _ledger_load()
        months = data.setdefault("months", {})
        b = months.setdefault(mk, {"gens": 0, "verifies": 0})
        b[kind] = int(b.get(kind, 0)) + n
        _ledger_save(data)


def record_gen(n: int = 1) -> None:
    _record("gens", n)


def record_verify(n: int = 1) -> None:
    _record("verifies", n)


def month_spend_snapshot() -> tuple:
    """(spend_usd, gens, verifies) for the CURRENT UTC month. Spend is derived,
    never stored as dollars — an estimate, not a billed figure."""
    mk = _month_key()
    with _ledger_lock:
        data = _ledger_load()
    b = (data.get("months", {}) or {}).get(mk, {}) or {}
    gens = int(b.get("gens", 0))
    verifies = int(b.get("verifies", 0))
    spend = gens * COST_PER_GEN_USD + verifies * COST_PER_VERIFY_USD
    return spend, gens, verifies


def budget_exhausted() -> bool:
    if MONTHLY_BUDGET_USD <= 0:
        return False  # 0 = unlimited
    spend, _, _ = month_spend_snapshot()
    return spend >= MONTHLY_BUDGET_USD


# --------------------------------------------------------------------------- #
# Slug helpers + admin requeue support
# --------------------------------------------------------------------------- #
_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def _valid_slug(slug: str) -> bool:
    """Reject path-traversal / junk before it reaches the filesystem or DB.
    Mirrors the shape slugify() produces: lowercase alnum groups joined by '-'."""
    return bool(slug) and slug not in (".", "..") and bool(_SLUG_RE.match(slug))


def slug_to_sci(slug: str) -> str:
    """Best-effort reverse of slugify for a binomial/trinomial:
    'erithacus-rubecula' -> 'Erithacus rubecula'. gen_one needs only the
    scientific name (common name + anatomy ref resolve from it via Wikipedia)."""
    parts = [p for p in slug.split("-") if p]
    if not parts:
        return ""
    return " ".join([parts[0].capitalize()] + parts[1:])


def slugs_in_states(states: tuple) -> list:
    """Slugs whose terminal DB state is one of `states` (e.g. dead/done)."""
    placeholders = ",".join("?" for _ in states)
    with _db_lock:
        rows = db().execute(
            "SELECT slug FROM species_jobs WHERE state IN (%s)" % placeholders,
            states,
        ).fetchall()
    return [r[0] for r in rows]


def requeue_row(slug: str) -> None:
    """Reset an existing job to a fresh queued state (attempts/backoff/lease
    cleared so the worker claims it immediately), or insert a queued row for a
    slug we've never seen. sci is derived from the slug for a brand-new row."""
    now = int(time.time())
    with _db_lock:
        cur = db().execute(
            """
            UPDATE species_jobs
               SET state='queued', attempts=0, next_retry=0, lease_until=0,
                   fail_reason=NULL, verify_rejects=0, updated_ts=?
             WHERE slug=?
            """,
            (now, slug),
        )
        if cur.rowcount == 0:
            db().execute(
                """
                INSERT INTO species_jobs (slug, sci, com, conf, state, attempts,
                                          next_retry, lease_until, updated_ts)
                VALUES (?, ?, '', ?, 'queued', 0, 0, 0, ?)
                """,
                (slug, slug_to_sci(slug), CONF_THRESHOLD, now),
            )
        db().commit()


def _delete_published(slug: str) -> None:
    """Remove a species' published PNGs (pose-1 <slug>.png AND pose-2
    <slug>-2.png) from the volume so a dirty render of either pose can't be
    served while its regeneration is pending. Best-effort."""
    for name in ("%s.png" % slug, "%s-2.png" % slug):
        p = ASSETS_DIR / name
        try:
            if p.exists():
                p.unlink()
        except OSError:
            pass


def _delete_pose2(slug: str) -> None:
    """Remove ONLY the flight pose (<slug>-2.png), preserving a clean perched
    pose-1 — used by /requeue keep_pose1 to backfill a missing/duplicate flight
    without re-rolling an already-good perched render."""
    p = ASSETS_DIR / ("%s-2.png" % slug)
    try:
        if p.exists():
            p.unlink()
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# In-memory token bucket  (single instance => process-local is correct)
# --------------------------------------------------------------------------- #
class TokenBucket:
    def __init__(self, capacity: float, refill_per_sec: float):
        self.capacity = capacity
        self.refill = refill_per_sec
        self.tokens = capacity
        self.last = time.monotonic()
        self._lock = threading.Lock()

    def allow(self) -> bool:
        with self._lock:
            now = time.monotonic()
            self.tokens = min(self.capacity, self.tokens + (now - self.last) * self.refill)
            self.last = now
            if self.tokens >= 1.0:
                self.tokens -= 1.0
                return True
            return False


bucket = TokenBucket(RATE_CAPACITY, RATE_REFILL)

# --------------------------------------------------------------------------- #
# Generation pipeline (blocking; run in a worker thread via asyncio.to_thread)
# --------------------------------------------------------------------------- #
class QAReject(Exception):
    pass


def _resolve_species_refs(slug: str, sci: str, com: str):
    """Species-level refs shared across BOTH poses. Wikipedia anatomy ref is
    fetched + cached on the volume; the anti-ref (lookalike) only if a dir is
    mounted. All optional — gen_one degrades gracefully when any is None."""
    pos = None
    if FETCH_REFS:
        try:
            pos = pregen.ensure_reference(REFS_DIR, slug, sci, com)
        except Exception as e:
            log.warning("ref fetch failed slug=%s err=%s", slug, e)
            pos = None
    anti = None
    anti_key = pregen.select_anti_ref_key(sci)
    if anti_key:
        anti = pregen.load_anti_ref(ANTI_DIR, anti_key)
    anti_key_for_call = anti_key if anti else None
    return pos, anti, anti_key_for_call


def _resolve_style_ref(sci: str, pose: int) -> Optional[Path]:
    """Per-pose house-style ref (perched vs flight uses a different plate, via
    pregen.select_style_ref). Resolved from the bundled house-plate set
    (STYLES_DIR defaults to services/birdgen/styles/, override via
    AV_STYLES_DIR). Returns None only if the dir or the specific plate is
    missing, in which case gen_one degrades gracefully to a style-described
    prompt (the arg is optional in gen_one)."""
    if STYLES_DIR is not None:
        sp = STYLES_DIR / pregen.select_style_ref(sci, pose)
        return sp if sp.exists() else None
    return None


def _qa_islands(apx: list, w: int, h: int) -> Optional[bytearray]:
    """Connected-components on the opaque mask. A clean cutout is one dominant
    blob (the bird); extra components are painted debris — water ripples,
    reflections, torn-paper beige fragments. Up to QA_ISLAND_SCRUB of the frame
    they are SCRUBBED rather than rejected (water birds systematically paint
    ~5% of ripples and re-rolled forever under a reject-only gate); past the
    ceiling the render is rejected — that much detached paint could be a second
    bird or a severed wing, and silently erasing it would mutilate the plate.
    Returns None (already clean) or an erase mask (1 = clear this pixel)."""
    on = QA_ALPHA_ON
    n = w * h
    visited = bytearray(n)
    comps = []  # (size, seed index)
    for start in range(n):
        if apx[start] > on and not visited[start]:
            comp = 0
            dq = deque((start,))
            visited[start] = 1
            while dq:
                idx = dq.popleft()
                comp += 1
                x = idx % w
                if x > 0 and apx[idx - 1] > on and not visited[idx - 1]:
                    visited[idx - 1] = 1
                    dq.append(idx - 1)
                if x < w - 1 and apx[idx + 1] > on and not visited[idx + 1]:
                    visited[idx + 1] = 1
                    dq.append(idx + 1)
                if idx >= w and apx[idx - w] > on and not visited[idx - w]:
                    visited[idx - w] = 1
                    dq.append(idx - w)
                if idx < n - w and apx[idx + w] > on and not visited[idx + w]:
                    visited[idx + w] = 1
                    dq.append(idx + w)
            comps.append((comp, start))
    if not comps:
        raise QAReject("no opaque component")
    comps.sort(reverse=True)
    frame = float(n)
    others = sum(size for size, _ in comps[1:])
    if others == 0:
        return None
    if others / frame > QA_ISLAND_SCRUB:
        raise QAReject("alpha islands: non-largest=%.3f of frame" % (others / frame))
    # Re-flood the dominant blob, then mark every other opaque pixel for erase.
    keep = bytearray(n)
    dq = deque((comps[0][1],))
    keep[comps[0][1]] = 1
    while dq:
        idx = dq.popleft()
        x = idx % w
        if x > 0 and apx[idx - 1] > on and not keep[idx - 1]:
            keep[idx - 1] = 1
            dq.append(idx - 1)
        if x < w - 1 and apx[idx + 1] > on and not keep[idx + 1]:
            keep[idx + 1] = 1
            dq.append(idx + 1)
        if idx >= w and apx[idx - w] > on and not keep[idx - w]:
            keep[idx - w] = 1
            dq.append(idx - w)
        if idx < n - w and apx[idx + w] > on and not keep[idx + w]:
            keep[idx + w] = 1
            dq.append(idx + w)
    erase = bytearray(n)
    for i in range(n):
        if apx[i] > on and not keep[i]:
            erase[i] = 1
    return erase


def _qa_inspect(cut_path: str) -> Optional[str]:
    """Deterministic, Pillow-only dirty-output gate on the keyed RGBA. Raises
    QAReject on the signatures the opaque-fraction band alone misses: leaked
    magenta ground, ragged/fuzzy alpha, ground still touching the frame on
    multiple sides, or a mangled crop aspect. Small disconnected alpha islands
    are scrubbed IN PLACE (the file is rewritten) — returns a note describing
    the scrub, or None when the cutout was already clean."""
    im0 = Image.open(cut_path).convert("RGBA")
    w0, h0 = im0.size
    if w0 == 0 or h0 == 0:
        raise QAReject("empty cutout")

    # mangled / half-bird crop
    aspect = w0 / float(h0)
    if not (QA_ASPECT_MIN <= aspect <= QA_ASPECT_MAX):
        raise QAReject("aspect=%.2f out of [%.2f,%.2f]"
                       % (aspect, QA_ASPECT_MIN, QA_ASPECT_MAX))

    # Downscale (NEAREST keeps alpha discrete so the feather band isn't inflated)
    # to bound the pure-Python pixel scan on large renders.
    scale = QA_DOWNSCALE / float(max(w0, h0))
    if scale < 1.0:
        im = im0.resize((max(1, int(w0 * scale)), max(1, int(h0 * scale))), Image.NEAREST)
    else:
        im = im0
    w, h = im.size
    on = QA_ALPHA_ON
    lo, hi = QA_MAGENTA_TOL, 255 - QA_MAGENTA_TOL

    px = list(im.getdata())
    apx = [0] * (w * h)
    opaque = semi = magenta = 0
    for i, (r, g, b, a) in enumerate(px):
        apx[i] = a
        if a > on:
            opaque += 1
            if a < 255:
                semi += 1
            # residual magenta ground = high R, low G, high B (same test as the key)
            if r >= hi and g <= lo and b >= hi:
                magenta += 1
    if opaque == 0:
        raise QAReject("no opaque pixels after key")

    # leaked key colour among visible pixels (torn/unkeyed magenta)
    if magenta / float(opaque) > QA_MAGENTA_MAX:
        raise QAReject("residual magenta=%.3f of opaque" % (magenta / float(opaque)))

    # ragged alpha: a clean feather is a thin outline; a torn blob is mostly fuzz
    if semi / float(opaque) > QA_RAGGED_MAX:
        raise QAReject("ragged edge: semi/opaque=%.3f" % (semi / float(opaque)))

    # ground the key failed to remove still touches the frame on >= N sides
    band = min(3, w, h)
    top = max(sum(1 for x in range(w) if apx[y * w + x] > on) for y in range(band))
    bot = max(sum(1 for x in range(w) if apx[(h - 1 - y) * w + x] > on) for y in range(band))
    left = max(sum(1 for y in range(h) if apx[y * w + x] > on) for x in range(band))
    right = max(sum(1 for y in range(h) if apx[y * w + (w - 1 - x)] > on) for x in range(band))
    sides = ((top / float(w) > QA_BORDER_FRAC) + (bot / float(w) > QA_BORDER_FRAC)
             + (left / float(h) > QA_BORDER_FRAC) + (right / float(h) > QA_BORDER_FRAC))
    if sides >= QA_BORDER_SIDES:
        raise QAReject("border contact on %d sides" % sides)

    # HOLLOW-CUTOUT gate (the white-gull scar) — must run BEFORE the islands
    # scrub AND at FULL resolution: when the key floods through pale plumage,
    # the bird's remains are a wing plus a 1px-faint outline. The scrub would
    # erase that outline (collapsing the bbox around the healthy-looking
    # wing), and the NEAREST downscale drops thin outline pixels entirely —
    # both hide the mutilation. On the full-res pre-scrub mask a fragment's
    # opaque area is a sliver of its own bounding box (broken gulls measured
    # 0.140/0.088; the 158 bundled plates measure 0.21–0.38). Pure PIL ops —
    # no per-pixel Python. Reject outright; the caller retries darker ground.
    on0 = im0.getchannel("A").point(lambda v: 255 if v > QA_ALPHA_ON else 0)
    bb = on0.getbbox()
    if bb:
        fill = on0.histogram()[255] / float((bb[2] - bb[0]) * (bb[3] - bb[1]))
        if fill < QA_MIN_FILL:
            raise QAReject(
                "hollow cutout: bbox fill=%.3f < %.2f (pale plumage keyed away?)"
                % (fill, QA_MIN_FILL)
            )

    erase = _qa_islands(apx, w, h)
    if erase is None:
        return None
    # Scrub the islands from the FULL-RES cutout: lift the erase mask back to
    # the original size (NEAREST — same discrete grid the scan used) and zero
    # those alpha pixels. The feather band around an island sits at/below
    # QA_ALPHA_ON and is invisible, so clearing the opaque cells suffices.
    mask = Image.frombytes("L", (w, h), bytes(erase)).point(lambda v: 255 if v else 0)
    if (w, h) != (w0, h0):
        mask = mask.resize((w0, h0), Image.NEAREST)
    alpha = im0.getchannel("A")
    alpha.paste(0, mask=mask)
    im0.putalpha(alpha)

    # The floor holds on BOTH sides of the scrub: a pale-key render can squeak
    # past the pre-scrub check (body remains inflate the opaque count), then
    # lose those remains to the scrub and land below the floor — gull render #3
    # published at 0.155 exactly this way. Nothing below the floor ships.
    on1 = im0.getchannel("A").point(lambda v: 255 if v > QA_ALPHA_ON else 0)
    bb1 = on1.getbbox()
    if bb1:
        fill1 = on1.histogram()[255] / float((bb1[2] - bb1[0]) * (bb1[3] - bb1[1]))
        if fill1 < QA_MIN_FILL:
            raise QAReject(
                "hollow cutout after scrub: bbox fill=%.3f < %.2f (pale plumage keyed away?)"
                % (fill1, QA_MIN_FILL)
            )

    im0.save(cut_path)
    return "scrubbed islands=%.3f of frame" % (sum(erase) / float(w * h))


def _qa_verify(slug: str, sci: str, com: str, pose: int, cut_path: Path) -> None:
    """Adversarial ID/anatomy gate (AV_VERIFY on). One Gemini-Vision call via
    verify.verify_one; rejects an off-species or malformed render so it
    regenerates. Fails OPEN (never rejects) when the model errors or the response
    can't be parsed — a QA gate must not reject on partial/absent data.

    The pose-1 (required) reject loop is bounded by AV_VERIFY_MAX_REJECTS: after
    that many rejects the least-bad render is accepted-with-flag rather than
    stranding the species in an endless regen loop (a real bird in slightly-off
    plumage beats a permanent silhouette). Pose-2 (flight) rejects need no budget
    — they're already bounded by the POSE2_TRIES loop and fall back to perched."""
    try:
        v = verify_one(GEMINI_API_KEY, cut_path, sci, com)
    except Exception as e:  # network/API error -> not a QA verdict; keep the clean render
        log.warning("verify_one error slug=%s err=%s (skipping verify gate)", slug, e)
        return  # NOT billed as a verdict — don't count
    record_verify()  # the call returned -> count the paid verify
    if not v:
        return  # unparseable -> fail open
    # A perched bird's folded wings routinely read as a single visible wing, so
    # only an EXTRA wing (>2) is an unambiguous hallucination — 1–2 is fine. (Was
    # !=2, which false-rejected valid perched renders and stranded species like
    # the greenfinch in an endless regen loop: no image at all, the worse outcome
    # the gate was supposed to prevent.)
    reason = None
    if not v.get("whole_bird", True):
        # A fragment (lone wing, severed part, transparent body) is unambiguous
        # at any confidence — the second net under the deterministic fill floor.
        reason = "not a whole bird (fragment)"
    elif (not v["matches_target"]) and v["guess_confidence"] == "high":
        reason = "reads as %s (conf=high), not %s" % (v.get("guessed_species_com", "?"), com)
    elif v["wing_count"] > 2:
        reason = "wing_count=%s" % v["wing_count"]
    elif v["leg_count"] > 2:
        reason = "leg_count=%s" % v["leg_count"]
    elif v["has_stick_or_perch"]:
        reason = "has stick/perch"
    if reason is None:
        return  # passed
    if pose != 1:
        raise QAReject("verify: " + reason)  # pose-2: bounded by POSE2_TRIES, no budget needed
    if get_verify_rejects(slug) >= AV_VERIFY_MAX_REJECTS:
        log.warning("verify: publishing best-effort after %d verify rejects slug=%s (last: %s)",
                    AV_VERIFY_MAX_REJECTS, slug, reason)
        return  # accept-with-flag: a real bird in slightly-off plumage beats a permanent silhouette
    n = bump_verify_rejects(slug)
    raise QAReject("verify: %s (reject %d/%d)" % (reason, n, AV_VERIFY_MAX_REJECTS))


# Species the hollow-cutout gate has flagged: their pale plumage merges into
# the standard cream ground and the key floods through the body, so every
# same-ground re-roll fails identically. Once flagged, render on a distinctly
# darker ground from the first attempt. In-memory: a restart re-learns at the
# cost of one rejected roll.
_PALE_GROUND_SLUGS: set = set()

PALE_GROUND_NOTE = (
    "This species has very pale, white-dominant plumage. So the cutout keys "
    "cleanly, paint the flat ground a distinctly DEEPER warm tan (an aged "
    "tea-stain tone, clearly darker than the bird's palest feathers) — still "
    "one flat, solid, untextured fill — and keep the bird's white plumage "
    "bright so the silhouette separates crisply from the ground."
)


def _gen_pose(slug: str, sci: str, com: str, pose: int,
              pos, anti, anti_key) -> float:
    """One pose end-to-end: MIN_SPACING throttle -> gen_one(pose) -> creamkey
    cutout -> QA gate -> atomic publish. pose 1 -> <slug>.png (perched),
    pose N -> <slug>-N.png (flight). Returns the opaque fraction. Raises
    QAReject / RuntimeError / urllib errors — the caller decides whether the
    failure is fatal (pose-1) or swallowed (pose-2).

    A 'hollow cutout' reject (white bird merging into the cream ground) is
    retried ONCE immediately on a darker ground — the failure is deterministic
    for pale species, so backoff re-rolls on the same ground would never
    converge — and the slug is remembered so later gens start dark."""
    out_name = "%s.png" % slug if pose == 1 else "%s-%d.png" % (slug, pose)
    tmp_tag = slug if pose == 1 else "%s-%d" % (slug, pose)
    style = _resolve_style_ref(sci, pose)

    def attempt(dark_ground: bool) -> float:
        note = NOTES.get(sci)
        if dark_ground:
            note = ((note + "\n\n") if note else "") + PALE_GROUND_NOTE
        _throttle_spacing()  # MIN_SPACING before every Gemini image call
        png = pregen.gen_one(
            GEMINI_API_KEY, PROMPT, sci, com, pose,
            positive_ref=pos, anti_ref=anti, anti_ref_key=anti_key,
            species_note=note, style_ref=style,
        )
        record_gen()  # count the billable image now — QA-rejected ones still cost
        tmp_raw = ASSETS_DIR / (".%s.raw.png" % tmp_tag)
        tmp_cut = ASSETS_DIR / (".%s.cut.png" % tmp_tag)
        try:
            tmp_raw.write_bytes(png)
            frac = chromakey(str(tmp_raw), str(tmp_cut))
            if not (QA_MIN <= frac <= QA_MAX):
                raise QAReject("opaque_frac=%.4f out of [%.3f,%.3f]" % (frac, QA_MIN, QA_MAX))
            # deterministic dirty-output gate (leaked magenta / ragged alpha /
            # border-contact / mangled aspect / hollow cutout -> QAReject;
            # small alpha islands are scrubbed in place instead of rejected).
            scrub_note = _qa_inspect(str(tmp_cut))
            if scrub_note:
                log.info("qa-scrub slug=%s pose=%s %s", slug, pose, scrub_note)
            # adversarial species/anatomy gate (one Gemini-Vision call).
            if AV_VERIFY:
                _qa_verify(slug, sci, com, pose, tmp_cut)
            # atomic publish (same filesystem -> os.replace is atomic)
            os.replace(str(tmp_cut), str(ASSETS_DIR / out_name))
            return frac
        finally:
            for p in (tmp_raw, tmp_cut):
                try:
                    if p.exists():
                        p.unlink()
                except OSError:
                    pass

    try:
        return attempt(slug in _PALE_GROUND_SLUGS)
    except QAReject as e:
        if "hollow cutout" in str(e) and slug not in _PALE_GROUND_SLUGS:
            _PALE_GROUND_SLUGS.add(slug)
            log.info("qa-hollow slug=%s pose=%d — immediate retry on darker ground", slug, pose)
            return attempt(True)
        raise


def _generate_sync(slug: str, sci: str, com: str) -> float:
    """Generate BOTH poses for a species so the collage's flight toggle works.

    Pose-1 (perched, <slug>.png) is REQUIRED: its failure propagates so the
    species stays un-done and retries per the backoff policy; its opaque
    fraction is returned. Pose-2 (flight, <slug>-2.png) is BEST-EFFORT: it runs
    the identical creamkey + QA pipeline, but ANY failure (gen/QA) is logged and
    swallowed — the species is still marked done on pose-1 alone, and the /asset
    endpoint falls a flight request back to pose-1 when <slug>-2.png is absent.
    Species-level refs are resolved once and shared across both poses;
    MIN_SPACING is honored before each Gemini call inside _gen_pose."""
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    pos, anti, anti_key = _resolve_species_refs(slug, sci, com)
    # POSE-1 (perched) — required. Skip the gen when a clean pose-1 already
    # exists (a keep_pose1 flight-backfill requeue): never re-roll an already-good
    # perched render — just (re)make the flight below.
    if (ASSETS_DIR / ("%s.png" % slug)).exists():
        frac = -1.0  # sentinel: pose-1 preserved, not regenerated this run
        log.info("gen-pose1-kept slug=%s", slug)
    else:
        frac = _gen_pose(slug, sci, com, 1, pos, anti, anti_key)
    # POSE-2 (flight) — best-effort but RETRIED: pose-2 gen/QA is a ~50%
    # stochastic roll, so try up to POSE2_TRIES times before giving up (was one
    # shot, which left ~half of species with a flight toggle that fell back to
    # perched). A final miss is logged + swallowed — the species stays done on
    # pose-1 and /asset serves the perched fallback, never blocking the species.
    for attempt in range(1, POSE2_TRIES + 1):
        try:
            f2 = _gen_pose(slug, sci, com, 2, pos, anti, anti_key)
            log.info("gen-pose2-done slug=%s opaque=%.1f%% try=%d", slug, f2 * 100, attempt)
            break
        except Exception as e:  # noqa: BLE001 — pose-2 is optional, never fatal
            log.warning("gen-pose2-miss slug=%s try=%d/%d err=%s",
                        slug, attempt, POSE2_TRIES, e)
    return frac


def _classify(exc: Exception) -> str:
    if isinstance(exc, QAReject):
        return "qa"
    msg = str(exc)
    if "block=SAFETY" in msg or "blockReason" in msg.upper():
        return "safety"
    return "transient"


# --------------------------------------------------------------------------- #
# Single-flight worker
# --------------------------------------------------------------------------- #
# Built inside lifespan, NOT at import: an asyncio.Queue must bind to the running
# event loop. Constructing it at import time (no loop yet) binds it to the wrong
# loop under uvicorn/uvloop and the worker's get() never wakes.
_wakeup: Optional["asyncio.Queue"] = None
_last_call = 0.0  # monotonic ts of the last Gemini call (MIN_SPACING throttle)
_stopping = False


def _throttle_spacing() -> None:
    """Block until MIN_SPACING has elapsed since the last Gemini call, then
    stamp the clock. Called before EVERY Gemini image call (once per pose), so
    the two-pose generation makes two spaced calls per species. The worker is
    single-flight, so a plain module global needs no lock; this runs inside the
    generation worker thread (asyncio.to_thread) and never touches the loop."""
    global _last_call
    wait = MIN_SPACING - (time.monotonic() - _last_call)
    if wait > 0:
        time.sleep(wait)
    _last_call = time.monotonic()


async def worker() -> None:
    log.info("worker started (MIN_SPACING=%ss, max_attempts=%s)", MIN_SPACING, MAX_ATTEMPTS)
    budget_paused = False
    while not _stopping:
        # Soft monthly-budget gate: never START a species we can't afford —
        # species stay 'queued' (nothing dead, nothing crashes), /detected keeps
        # enqueueing, and gen auto-resumes at the UTC month rollover or on a
        # MONTHLY_BUDGET_USD raise. Overshoot is bounded to one in-flight species
        # per crossing (the check is per-claim, not per-pose) — fine for a soft
        # ceiling. Fail-open: a corrupt ledger reads empty, so gen keeps running.
        if MONTHLY_BUDGET_USD > 0 and await asyncio.to_thread(budget_exhausted):
            if not budget_paused:
                spend, gens, _ = month_spend_snapshot()
                log.warning(
                    "budget-exhausted month_spend~=$%.2f >= budget=$%.2f gens=%d — pausing gen; "
                    "species stay queued, resume next month or on MONTHLY_BUDGET_USD raise",
                    spend, MONTHLY_BUDGET_USD, gens,
                )
                budget_paused = True
            # drain _wakeup while paused so /detected still returns queued
            try:
                await asyncio.wait_for(_wakeup.get(), timeout=POLL_INTERVAL)
            except asyncio.TimeoutError:
                pass
            except Exception as e:
                log.warning("wakeup wait error: %s", e)
                await asyncio.sleep(POLL_INTERVAL)
            continue
        if budget_paused:
            log.info("budget-resumed — gen worker active again")
            budget_paused = False

        job = await asyncio.to_thread(claim_one_due)
        if job is None:
            # idle: wake on a new detection or re-poll to catch backoff-ready jobs
            try:
                await asyncio.wait_for(_wakeup.get(), timeout=POLL_INTERVAL)
            except asyncio.TimeoutError:
                pass
            except Exception as e:  # never let the wakeup wait kill the worker
                log.warning("wakeup wait error: %s", e)
                await asyncio.sleep(POLL_INTERVAL)
            continue

        slug = job["slug"]
        # MIN_SPACING throttling now lives in _gen_pose (_throttle_spacing),
        # applied before EACH pose's Gemini call — two-pose generation makes two
        # spaced calls per species.
        log.info("gen-start slug=%s attempt=%s", slug, job["attempts"])
        t0 = time.monotonic()
        try:
            frac = await asyncio.to_thread(_generate_sync, slug, job["sci"], job["com"])
            await asyncio.to_thread(mark_done, slug)
            month_spend = await asyncio.to_thread(month_spend_snapshot)
            log.info(
                "gen-done slug=%s pose1=%s dur=%.1fs cost-estimate>=$%.3f month~=$%.2f",
                slug, ("kept" if frac < 0 else "%.1f%%" % (frac * 100)),
                time.monotonic() - t0, COST_PER_GEN_USD, month_spend[0],
            )
        except Exception as e:  # noqa: BLE001 - classify + persist, never crash the worker
            fail_class = _classify(e)
            state = await asyncio.to_thread(
                mark_fail, slug, fail_class, str(e), job["attempts"]
            )
            log.warning(
                "gen-failed slug=%s class=%s state=%s dur=%.1fs err=%s",
                slug, fail_class, state, time.monotonic() - t0, e,
            )


# --------------------------------------------------------------------------- #
# App + lifespan
# --------------------------------------------------------------------------- #
@asynccontextmanager
async def lifespan(app: FastAPI):
    global _wakeup, _stopping
    _stopping = False
    _wakeup = asyncio.Queue()  # bind to the running loop
    db()  # init schema on the volume
    if not GEMINI_API_KEY:
        log.warning("GEMINI_API_KEY not set — generation will fail until configured")
    if not WATCHER_WEBHOOK_SECRET:
        log.warning("WATCHER_WEBHOOK_SECRET not set — /detected will reject all calls (503)")
    log.info("birdgen up: bundled=%d assets_dir=%s", len(BUNDLED), ASSETS_DIR)
    # Loud style-lock assertion: a future regression (empty/disabled styles dir)
    # would otherwise silently paint every auto-gen with NO house-style ref.
    if STYLES_DIR is not None and STYLES_DIR.exists():
        _n_styles = len(list(STYLES_DIR.glob("*.png")))
        if _n_styles:
            log.info("style-lock: %d house plates at %s", _n_styles, STYLES_DIR)
        else:
            log.warning("style-lock OFF: %s has no *.png — gens run WITHOUT the house style ref", STYLES_DIR)
    else:
        log.warning("style-lock OFF: AV_STYLES_DIR disabled/absent — gens run WITHOUT the house style ref")
    task = asyncio.create_task(worker())
    try:
        yield
    finally:
        _stopping = True
        if _wakeup is not None:
            _wakeup.put_nowait("__stop__")
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass


app = FastAPI(title="birdgen", lifespan=lifespan)

# Assets are public art; allow cross-origin GET so the collage can draw them to
# canvas without tainting (renderer.ts may read pixels back). See ARCHITECTURE
# open question on canvas taint.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


class Detection(BaseModel):
    sci: str
    com: str
    slug: str
    conf: float
    # extra fields (v, type, cursor) are accepted + ignored


@app.get("/health")
async def health():
    # ops-only spend telemetry (ESTIMATE = count × unit cost). MUST NOT be
    # rendered on the museum frontend — honesty firewall.
    q, d = counts()
    spend, gens, verifies = month_spend_snapshot()
    return {
        "ok": True,
        "queue_depth": q,
        "done_count": d,
        "month_spend_usd": round(spend, 4),
        "budget_usd": MONTHLY_BUDGET_USD,
        "gens_this_month": gens,
        "verifies_this_month": verifies,
        "budget_exhausted": (MONTHLY_BUDGET_USD > 0 and spend >= MONTHLY_BUDGET_USD),
    }


@app.get("/manifest")
async def manifest():
    # single dedup source of truth: bundled UNION generated(volume)
    slugs = sorted(BUNDLED | generated_slugs())
    return {"slugs": slugs}


@app.get("/asset/{name}")
async def asset(name: str):
    if not name.endswith(".png"):
        return JSONResponse({"error": "not found"}, status_code=404)
    key = name[:-4]  # "<slug>" (pose-1) or "<slug>-2" (pose-2 / flight)
    if "/" in key or key in ("", ".", ".."):
        return JSONResponse({"error": "not found"}, status_code=404)
    path = ASSETS_DIR / ("%s.png" % key)
    if path.exists():
        return FileResponse(str(path), media_type="image/png")
    # Pose-2 miss -> fall back to the perched pose-1 file so the collage's
    # flight toggle always renders something (never a broken image) even when
    # pose-2 gen/QA failed (best-effort) or isn't generated yet. A pose variant
    # is "<base>-<digits>"; its pose-1 companion is "<base>.png".
    m = _POSE_SUFFIX_RE.search(key)
    if m:
        base = key[: m.start()]
        p1 = ASSETS_DIR / ("%s.png" % base)
        if base and "/" not in base and p1.exists():
            return FileResponse(str(p1), media_type="image/png")
    return JSONResponse({"error": "not found"}, status_code=404)


@app.post("/detected")
async def detected(payload: Detection, authorization: Optional[str] = Header(None)):
    # 0. misconfiguration -> fail loud
    if not WATCHER_WEBHOOK_SECRET:
        return JSONResponse({"error": "auth not configured"}, status_code=503)

    # 1. Bearer auth (constant-time compare)
    expected = "Bearer " + WATCHER_WEBHOOK_SECRET
    if not authorization or not hmac.compare_digest(authorization, expected):
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    # 2. token-bucket rate-limit
    if not bucket.allow():
        return JSONResponse({"error": "rate limited"}, status_code=429)

    slug = payload.slug.strip()
    if not slug:
        return JSONResponse({"error": "empty slug"}, status_code=422)

    log.info("detection-received slug=%s conf=%.3f", slug, payload.conf)

    # 3. confidence gate
    if payload.conf < CONF_THRESHOLD:
        return {"status": "low_confidence"}

    # 4. dedup (Railway terminal state is authoritative)
    state = get_state(slug)
    if state == "done" or (ASSETS_DIR / ("%s.png" % slug)).exists():
        log.info("dedup-hit slug=%s status=cached", slug)
        return {"status": "cached"}
    if state in ("queued", "generating"):
        log.info("dedup-hit slug=%s status=in_progress", slug)
        return {"status": "in_progress"}
    if state == "dead":
        log.info("dedup-hit slug=%s status=dead", slug)
        return {"status": "dead"}
    if slug in BUNDLED:
        log.info("dedup-hit slug=%s status=bundled", slug)
        return {"status": "bundled"}

    # 5. new species -> enqueue
    insert_queued(slug, payload.sci, payload.com, payload.conf)
    if _wakeup is not None:
        try:
            _wakeup.put_nowait(slug)
        except asyncio.QueueFull:
            pass  # worker re-polls every POLL_INTERVAL regardless
    log.info("enqueued slug=%s status=queued", slug)
    return {"status": "queued"}


@app.post("/requeue")
async def requeue(request: Request, authorization: Optional[str] = Header(None)):
    """Admin reset over HTTP: delete published PNGs and reset the named slugs
    (or, when none are given, every dead/done row) to a fresh queued state, then
    wake the worker. Lets us wipe stale/dirty volume state after a redeploy
    without shell access. Body {"slugs": [...]} is optional (empty => all
    dead+done). Returns {"requeued": [...]}.  Same Bearer auth as /detected."""
    # 0. misconfiguration -> fail loud
    if not WATCHER_WEBHOOK_SECRET:
        return JSONResponse({"error": "auth not configured"}, status_code=503)

    # 1. Bearer auth (constant-time compare)
    expected = "Bearer " + WATCHER_WEBHOOK_SECRET
    if not authorization or not hmac.compare_digest(authorization, expected):
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    # 2. resolve targets: explicit list (sanitized), or all dead+done rows.
    try:
        body = await request.json()
    except Exception:
        body = {}
    raw = body.get("slugs", []) if isinstance(body, dict) else []
    requested = [s.strip() for s in raw if isinstance(s, str) and s.strip()]
    if requested:
        targets = [s for s in requested if _valid_slug(s)]
    else:
        targets = [s for s in slugs_in_states(("dead", "done")) if _valid_slug(s)]
    # keep_pose1=true => backfill ONLY the flight pose, preserving a clean
    # perched pose-1 (used to fill in missing/duplicate flights without re-rolling
    # good perched renders). Combined with _generate_sync's pose-1-kept skip, the
    # requeued run regenerates just <slug>-2.png.
    keep_pose1 = bool(body.get("keep_pose1")) if isinstance(body, dict) else False

    # 3. delete PNG + reset row + wake worker for each target.
    requeued = []
    for slug in targets:
        if keep_pose1:
            _delete_pose2(slug)
        else:
            _delete_published(slug)
        requeue_row(slug)
        if _wakeup is not None:
            try:
                _wakeup.put_nowait(slug)
            except asyncio.QueueFull:
                pass
        requeued.append(slug)
    log.info("requeue: reset %d slug(s) -> queued", len(requeued))
    return {"requeued": requeued}
