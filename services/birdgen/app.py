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
  - CONF_THRESHOLD confidence gate (env; see its definition below for the
    default and the reason — restating the number here is how the 0.80-vs-0.70
    drift regression of 987d9da happened).
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
  - POST /requeue (Bearer) v2: explicit slugs only (empty => 422 — the old
    requeue-everything fallback was a wall-wipe footgun), per-pose directives
    (poses), keep_current generate-then-swap (the old plate keeps serving and
    is only replaced by a QA-passing successor; the outgoing file is archived
    to _prev/, ring-of-1), manual-source refusals (bundled / manual budget).
  - GET /job/<slug> (Bearer): repaint poll target — job state, asset mtimes,
    budget flags, queue depth.
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
import shutil
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
from PIL import Image, ImageChops, ImageDraw, ImageFilter
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
# Species whose cached Wikipedia anatomy ref anchors a legless plump crouch that
# Gemini copies over EVERY text instruction (the European Robin — 6+ escalating
# prompt/note attempts all footless): skip the positive ref for these so the leggy
# house-style plate + the species-note DIAGNOSTICS drive a standing, legged pose
# instead of an anatomically-matched plump crouch. Per-species opt-in only.
NO_POSITIVE_REF_SLUGS = set(
    s.strip() for s in os.environ.get("NO_POSITIVE_REF_SLUGS", "erithacus-rubecula").split(",") if s.strip())
# Species whose PERCHED plate needs the tuck cleanup (keep-body-only: drops an
# awkward dangling leg for a clean rounded belly) on EVERY publish — not just a
# one-off /reclean {tuck:true}. Without this registry a tuck fix has the
# lifetime of the current PNG: the next repaint/regen runs clean_alpha without
# tuck and the dangling leg comes straight back. Perched (pose-1) only — flight
# plates get the satellite-drop instead. Per-species opt-in, default empty.
TUCK_SLUGS = set(
    s.strip() for s in os.environ.get("TUCK_SLUGS", "").split(",") if s.strip())
# Species whose plumage sits INSIDE the default chromakey tolerance of the cream
# ground, so the key eats a painted body region (the robin's cream belly:
# max-channel distance 24-29 from the ground vs the default tol 42 — the whole
# belly went alpha-0 while the paint survived in the RGB). The hollow-cutout
# gate never fires for these: the rest of the bird keeps the bbox fill above the
# floor, so the plate publishes with a void where the belly is. Keying THESE
# species at a tighter per-species tol keeps the pale body attached on every
# future publish — without this registry a /reclean rekey fix dies on the next
# repaint, exactly like an unregistered tuck. Format: "slug:tol,slug:tol".
# robin: belly measured 24-29 from ground. parakeet: the pale blue-green
# breast wash measured 38-50 (its palest reaches under 42, which is how the
# default tol ate the neck on 07-03) — 20 spares the wash, ground texture is <=8.
KEY_TOL_SLUGS: dict = {}
for _part in os.environ.get(
        "KEY_TOL_SLUGS", "erithacus-rubecula:15,psittacula-krameri:20").split(","):
    _slug, _, _tol = _part.strip().partition(":")
    if _slug and _tol.isdigit() and 5 <= int(_tol) <= 41:
        KEY_TOL_SLUGS[_slug] = int(_tol)
REFS_DIR = Path(os.environ.get("REFS_DIR", str(ASSETS_DIR / "_refs")))
ANTI_DIR = Path(os.environ.get("ANTI_DIR", str(REFS_DIR)))
_styles = os.environ.get("AV_STYLES_DIR", str(HERE / "styles"))
STYLES_DIR: Optional[Path] = Path(_styles) if _styles else None

# Rough per-pose Gemini image cost. Feeds the persistent spend ledger + the
# cost-estimate log line (an ESTIMATE: count × unit cost, never a billed figure).
COST_PER_GEN_USD = float(os.environ.get("COST_PER_GEN_USD", "0.04"))
# gemini-2.5-flash verify call (image-in, ~500 tok out) — much cheaper than
# image-out. ESTIMATE, not billing.
COST_PER_VERIFY_USD = float(os.environ.get("COST_PER_VERIFY_USD", "0.002"))
MONTHLY_BUDGET_USD = float(os.environ.get("MONTHLY_BUDGET_USD", "20"))       # soft ceiling on ESTIMATED month spend; 0 = unlimited
# Sub-ceiling on ESTIMATED manual (viewer-repaint) spend. Past it, /requeue
# refuses source=manual per-slug and auto-gen keeps the remaining monthly
# budget exclusively. 0 = no manual ceiling.
MANUAL_BUDGET_USD = float(os.environ.get("MANUAL_BUDGET_USD", "6"))
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
                regen_poses TEXT,            -- '1' | '2' | '1,2' directive; NULL = legacy (generate what's missing)
                source      TEXT DEFAULT 'auto',  -- 'auto' (forwarder/admin) | 'manual' (viewer repaint)
                updated_ts  INTEGER
            )
            """
        )
        _conn.commit()
        # Guarded migrations: existing volumes have the table but not the
        # later columns. A bare ADD COLUMN on redeploy would crash the second
        # boot, so swallow the "duplicate column" OperationalError per column.
        for ddl in (
            "ALTER TABLE species_jobs ADD COLUMN verify_rejects INTEGER DEFAULT 0",
            "ALTER TABLE species_jobs ADD COLUMN regen_poses TEXT",
            "ALTER TABLE species_jobs ADD COLUMN source TEXT DEFAULT 'auto'",
            # Conservator's Mark: the judge's verdict on the HANGING pose-1
            # plate ('attested' | 'caveat' | NULL = not-yet-examined).
            "ALTER TABLE species_jobs ADD COLUMN attest TEXT",
            "ALTER TABLE species_jobs ADD COLUMN attest_ts INTEGER",
        ):
            try:
                _conn.execute(ddl)
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
    Reclaims a 'generating' row whose lease has expired (crash recovery).
    Auto/new-species rows claim BEFORE manual repaints (new-species-first
    ruling: a first-hearing silhouette is a worse museum state than a
    mediocre existing plate)."""
    now = int(time.time())
    with _db_lock:
        row = db().execute(
            """
            SELECT slug, sci, com, attempts, regen_poses, source FROM species_jobs
            WHERE (state='queued'     AND next_retry  <= ?)
               OR (state='generating' AND lease_until <  ?)
            ORDER BY CASE WHEN source='manual' THEN 1 ELSE 0 END ASC,
                     next_retry ASC
            LIMIT 1
            """,
            (now, now),
        ).fetchone()
        if not row:
            return None
        slug, sci, com, attempts, regen_poses, source = row
        db().execute(
            """
            UPDATE species_jobs
               SET state='generating', lease_until=?, attempts=attempts+1, updated_ts=?
             WHERE slug=?
            """,
            (now + LEASE_TTL, now, slug),
        )
        db().commit()
        return {"slug": slug, "sci": sci, "com": com, "attempts": attempts + 1,
                "regen_poses": regen_poses, "source": source or "auto"}


def mark_done(slug: str) -> None:
    """Terminal 'done' transition, guarded on WHERE state='generating': if a
    /requeue landed mid-gen (the swallowed-press race) the row is 'queued'
    again and this UPDATE must NOT clobber that repaint intent — it logs and
    no-ops instead. The in-flight publish already landed (it passed QA) and
    the queued row is re-claimed on the worker's next loop. Clears
    regen_poses: the directive this run carried is fulfilled."""
    now = int(time.time())
    with _db_lock:
        cur = db().execute(
            """
            UPDATE species_jobs
               SET state='done', fail_reason=NULL, regen_poses=NULL, updated_ts=?
             WHERE slug=? AND state='generating'
            """,
            (now, slug),
        )
        db().commit()
    if cur.rowcount == 0:
        log.warning("mark_done raced slug=%s: row no longer 'generating' "
                    "(requeued mid-gen?) — no-op, repaint intent preserved", slug)


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


def set_attest(slug: str, state: Optional[str]) -> None:
    """Persist the Conservator's Mark for the pose-1 plate that just PUBLISHED.
    state: 'attested' (judge passed) | 'caveat' (accept-with-flag) | None
    (unexamined: verify off or the gate failed open). Called only after the
    atomic os.replace, so the mark can never describe a plate that never hung."""
    with _db_lock:
        db().execute(
            "UPDATE species_jobs SET attest=?, attest_ts=? WHERE slug=?",
            (state, int(time.time()), slug),
        )
        db().commit()


def attest_state(attest: Optional[str], verify_rejects) -> str:
    """Wire-state for a stored attest value. The locked honesty rule: fail-open
    and accept-with-flag must NEVER render as a clean checkmark. Legacy rows
    (verdicts computed then discarded, pre-Mark) derive 'caveat' from the one
    thing that WAS persisted: an exhausted reject budget means the hanging
    plate is an accept-with-flag survivor."""
    if attest in ("attested", "caveat"):
        return attest
    if (verify_rejects or 0) >= AV_VERIFY_MAX_REJECTS:
        return "caveat"
    return "unexamined"


def get_attest(slug: str) -> Optional[dict]:
    with _db_lock:
        row = db().execute(
            "SELECT attest, attest_ts, verify_rejects FROM species_jobs WHERE slug=?",
            (slug,),
        ).fetchone()
    if not row:
        return None
    return {"state": attest_state(row[0], row[2]), "ts": row[1]}


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
    # Guarded on WHERE state='generating' (same swallowed-press race as
    # mark_done): a /requeue that landed mid-gen already reset the row to a
    # fresh 'queued' — stamping a backoff/fail over it would delay or clobber
    # the deliberate repaint. 0 rows matched -> log + no-op.
    with _db_lock:
        if reset_attempts:
            cur = db().execute(
                """
                UPDATE species_jobs
                   SET state=?, next_retry=?, attempts=0, fail_reason=?, updated_ts=?
                 WHERE slug=? AND state='generating'
                """,
                (state, next_retry, reason_str, now, slug),
            )
        else:
            cur = db().execute(
                """
                UPDATE species_jobs
                   SET state=?, next_retry=?, fail_reason=?, updated_ts=?
                 WHERE slug=? AND state='generating'
                """,
                (state, next_retry, reason_str, now, slug),
            )
        db().commit()
        if cur.rowcount == 0:
            row = db().execute(
                "SELECT state FROM species_jobs WHERE slug=?", (slug,)
            ).fetchone()
            actual = row[0] if row else "unknown"
        else:
            actual = None
    if actual is not None:
        log.warning("mark_fail raced slug=%s: row no longer 'generating' "
                    "(requeued mid-gen?) — no-op, row stays '%s'", slug, actual)
        return actual
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


def _record(kind: str, n: int = 1) -> None:  # kind in {'gens','verifies','manual_gens','manual_verifies'}
    mk = _month_key()
    with _ledger_lock:
        data = _ledger_load()
        months = data.setdefault("months", {})
        b = months.setdefault(mk, {"gens": 0, "verifies": 0,
                                   "manual_gens": 0, "manual_verifies": 0})
        b[kind] = int(b.get(kind, 0)) + n
        _ledger_save(data)


def record_gen(n: int = 1, manual: bool = False) -> None:
    _record("manual_gens" if manual else "gens", n)


def record_verify(n: int = 1, manual: bool = False) -> None:
    _record("manual_verifies" if manual else "verifies", n)


def month_snapshot() -> dict:
    """Counts + derived spend for the CURRENT UTC month. Spend stays derived,
    never stored as dollars — an estimate, not a billed figure. gens/verifies
    are the AUTO counters; manual (viewer-repaint) work is tallied separately
    so the manual sub-budget is enforceable. Buckets written before the split
    simply read the manual keys as 0. spend_usd is the TOTAL (auto + manual)
    — the monthly ceiling covers everything."""
    mk = _month_key()
    with _ledger_lock:
        data = _ledger_load()
    b = (data.get("months", {}) or {}).get(mk, {}) or {}
    gens = int(b.get("gens", 0))
    verifies = int(b.get("verifies", 0))
    manual_gens = int(b.get("manual_gens", 0))
    manual_verifies = int(b.get("manual_verifies", 0))
    manual_spend = manual_gens * COST_PER_GEN_USD + manual_verifies * COST_PER_VERIFY_USD
    spend = gens * COST_PER_GEN_USD + verifies * COST_PER_VERIFY_USD + manual_spend
    return {
        "gens": gens,
        "verifies": verifies,
        "manual_gens": manual_gens,
        "manual_verifies": manual_verifies,
        "manual_spend_usd": manual_spend,
        "spend_usd": spend,
    }


def budget_exhausted() -> bool:
    if MONTHLY_BUDGET_USD <= 0:
        return False  # 0 = unlimited
    return month_snapshot()["spend_usd"] >= MONTHLY_BUDGET_USD


def manual_budget_exhausted() -> bool:
    """Manual-repaint sub-ceiling: once ESTIMATED manual spend crosses
    MANUAL_BUDGET_USD, /requeue refuses source=manual per-slug ("manual_budget")
    while auto-gen keeps the rest of the monthly budget exclusively. Same
    UTC-month bucket as the main ledger, so it auto-resets at the rollover."""
    if MANUAL_BUDGET_USD <= 0:
        return False
    return month_snapshot()["manual_spend_usd"] >= MANUAL_BUDGET_USD


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


def requeue_row(slug: str, regen_poses: Optional[str] = None,
                source: str = "auto") -> None:
    """Reset an existing job to a fresh queued state (attempts/backoff/lease
    cleared so the worker claims it immediately), or insert a queued row for a
    slug we've never seen. sci is derived from the slug for a brand-new row.
    regen_poses ('1' | '2' | '1,2' | None=legacy) directs the worker which
    poses to force past the existence-skip; source tags the spend ledger and
    the claim priority (auto rows claim before manual ones)."""
    now = int(time.time())
    with _db_lock:
        cur = db().execute(
            """
            UPDATE species_jobs
               SET state='queued', attempts=0, next_retry=0, lease_until=0,
                   fail_reason=NULL, verify_rejects=0, regen_poses=?, source=?,
                   updated_ts=?
             WHERE slug=?
            """,
            (regen_poses, source, now, slug),
        )
        if cur.rowcount == 0:
            db().execute(
                """
                INSERT INTO species_jobs (slug, sci, com, conf, state, attempts,
                                          next_retry, lease_until, regen_poses,
                                          source, updated_ts)
                VALUES (?, ?, '', ?, 'queued', 0, 0, 0, ?, ?, ?)
                """,
                (slug, slug_to_sci(slug), CONF_THRESHOLD, regen_poses, source, now),
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


def _delete_pose1(slug: str) -> None:
    """Remove ONLY the perched pose (<slug>.png), preserving a clean flight
    pose-2 — used by /requeue's delete-first path when only pose 1 is directed
    (poses:[1] with keep_current:false), so a perched re-roll never takes a
    good flight render with it. Best-effort."""
    p = ASSETS_DIR / ("%s.png" % slug)
    try:
        if p.exists():
            p.unlink()
    except OSError:
        pass


def _delete_pose2(slug: str) -> None:
    """Remove ONLY the flight pose (<slug>-2.png), preserving a clean perched
    pose-1 — used by /requeue's delete-first path when only pose 2 is directed
    (poses:[2] with keep_current:false), so a flight wipe never takes a good
    perched render with it."""
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
    if FETCH_REFS and slug not in NO_POSITIVE_REF_SLUGS:
        try:
            pos = pregen.ensure_reference(REFS_DIR, slug, sci, com)
        except Exception as e:
            log.warning("ref fetch failed slug=%s err=%s", slug, e)
            pos = None
    elif slug in NO_POSITIVE_REF_SLUGS:
        log.info("skip positive ref slug=%s (legless-crouch anchor)", slug)
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


def _qa_islands(apx: list, w: int, h: int) -> Optional[bytearray]:  # noqa: C901  (complexity 20; pre-existing debt, see .flake8)
    """Connected-components on the opaque mask. A clean cutout is one dominant
    blob (the bird); extra components are painted debris — water ripples,
    reflections, torn-paper beige fragments. Up to QA_ISLAND_SCRUB of the frame
    they are SCRUBBED rather than rejected (water birds systematically paint
    ~5% of ripples and re-rolled forever under a reject-only gate); past the
    ceiling the render is rejected — that much detached paint could be a second
    bird or a severed wing, and silently erasing it would mutilate the plate.

    Connectivity runs on a ONE-CELL-DILATED mask: legs and toes join the body
    through joints so thin that the NEAREST downscale disconnects them, and a
    literal-adjacency scrub then erased the robin's and plover's legs as
    "debris". Dilation bridges those artifact gaps (anything within ~2 scan
    cells of the body is the bird); genuinely detached debris sits farther
    away and still scrubs. Component sizes are measured on the ORIGINAL
    opaque pixels so the dilation never inflates the ratios.

    Returns None (already clean) or an erase mask (1 = clear this pixel)."""
    on = QA_ALPHA_ON
    n = w * h
    dil = list(
        Image.frombytes("L", (w, h), bytes(255 if a > on else 0 for a in apx))
        .filter(ImageFilter.MaxFilter(3))
        .getdata()
    )
    visited = bytearray(n)
    comps = []  # (original-opaque size, seed index)
    for start in range(n):
        if dil[start] and not visited[start]:
            comp = 0
            dq = deque((start,))
            visited[start] = 1
            while dq:
                idx = dq.popleft()
                if apx[idx] > on:
                    comp += 1  # size = real opaque pixels, not dilated halo
                x = idx % w
                if x > 0 and dil[idx - 1] and not visited[idx - 1]:
                    visited[idx - 1] = 1
                    dq.append(idx - 1)
                if x < w - 1 and dil[idx + 1] and not visited[idx + 1]:
                    visited[idx + 1] = 1
                    dq.append(idx + 1)
                if idx >= w and dil[idx - w] and not visited[idx - w]:
                    visited[idx - w] = 1
                    dq.append(idx - w)
                if idx < n - w and dil[idx + w] and not visited[idx + w]:
                    visited[idx + w] = 1
                    dq.append(idx + w)
            if comp > 0:
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
    # Re-flood the dominant blob over the dilated mask, then mark every
    # opaque pixel outside it for erase.
    keep = bytearray(n)
    dq = deque((comps[0][1],))
    keep[comps[0][1]] = 1
    while dq:
        idx = dq.popleft()
        x = idx % w
        if x > 0 and dil[idx - 1] and not keep[idx - 1]:
            keep[idx - 1] = 1
            dq.append(idx - 1)
        if x < w - 1 and dil[idx + 1] and not keep[idx + 1]:
            keep[idx + 1] = 1
            dq.append(idx + 1)
        if idx >= w and dil[idx - w] and not keep[idx - w]:
            keep[idx - w] = 1
            dq.append(idx - w)
        if idx < n - w and dil[idx + w] and not keep[idx + w]:
            keep[idx + w] = 1
            dq.append(idx + w)
    erase = bytearray(n)
    for i in range(n):
        if apx[i] > on and not keep[i]:
            erase[i] = 1
    return erase


def _qa_inspect(cut_path: str) -> Optional[str]:  # noqa: C901  (complexity 18; pre-existing debt, see .flake8)
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


# Edge cleanup: the chromakey feather leaves a thin semi-transparent fringe
# around the whole silhouette. On a broad body it's invisible, but on THIN
# extremities (tail tips, toes, legs) that same-width fuzzy band is a large
# fraction of the feature, so it reads as frayed / torn / "ripped". Faint
# semi-transparent ghost fragments (a keyed-away second leg, a reflection
# remnant) also survive under the island scrub's connectivity. This pass
# hardens the edge and drops detached faint bits — WITHOUT re-rolling the art.
CLEAN_SOLID_T = int(os.environ.get("CLEAN_SOLID_T", "140"))       # alpha >= this = confident body/leg/tail ink
CLEAN_HALO_FRAC = float(os.environ.get("CLEAN_HALO_FRAC", "0.010"))  # keep-halo radius as a fraction of the long edge
CLEAN_MIN_CORE_FRAC = float(os.environ.get("CLEAN_MIN_CORE_FRAC", "0.002"))  # min solid component to keep (drops specks)
# A DETACHED solid component smaller than this fraction of the body is a defect
# (dangling feet / ghost leg) -> dropped.
CLEAN_SATELLITE_MAX_FRAC = float(os.environ.get("CLEAN_SATELLITE_MAX_FRAC", "0.10"))
# Log-only tripwire (instrument first, gate never until log-only proves it):
# clean_alpha runs AFTER the vision gate, so nothing inspects what it removed.
# When a cleanup drops at least this fraction of the plate's opaque pixels
# (a possible tail/bill amputation, not fringe dust), WARN loudly — never block.
CLEAN_DROP_WARN_FRAC = float(os.environ.get("CLEAN_DROP_WARN_FRAC", "0.12"))
# A NON-tuck cleanup that removes MORE opaque than this is treated as a
# mutilation (a clipped/half-eaten bird) and REVERTED — never published. This is
# the deterministic, zero-spend gate on clean_alpha's OUTPUT (the Gemini judge
# runs BEFORE clean_alpha, so nothing else re-inspects the post-cleanup plate).
# tuck legitimately drops a whole foot cluster and is founder-directed, so it is
# exempt. Legit satellite-drop is ~3%, the warn tripwire 12%, so 30% is a wide
# margin above any real cleanup and only trips on a gross over-removal.
CLEAN_MAX_DROP_FRAC = float(os.environ.get("CLEAN_MAX_DROP_FRAC", "0.30"))

_CLEAN_DROP_RE = re.compile(r"removed ([0-9.]+)")


def _clean_drop_frac(note: Optional[str]) -> Optional[float]:
    """Parse the dropped-opaque fraction out of a clean_alpha note (its
    'removed %.3f' field — the two format strings below are the only source)."""
    if not note:
        return None
    m = _CLEAN_DROP_RE.search(note)
    try:
        return float(m.group(1)) if m else None
    except ValueError:
        return None


def _warn_big_clean_drop(slug: str, pose: int, note: Optional[str]) -> None:
    frac = _clean_drop_frac(note)
    if frac is not None and frac >= CLEAN_DROP_WARN_FRAC:
        log.warning(
            "qa-clean-drop slug=%s pose=%d removed %.1f%% of opaque pixels "
            "(>= %.0f%% tripwire) — eyeball the published plate (log-only, never blocks)",
            slug, pose, frac * 100.0, CLEAN_DROP_WARN_FRAC * 100.0)


def _clean_over_removed(note: Optional[str], tuck: bool) -> bool:
    """True when a NON-tuck cleanup removed >= CLEAN_MAX_DROP_FRAC of the opaque
    pixels — a gross over-removal (a clipped/mutilated bird) the caller must
    REVERT rather than publish. tuck drops a foot cluster on purpose and is
    founder-directed, so it is never treated as over-removal."""
    if tuck:
        return False
    frac = _clean_drop_frac(note)
    return frac is not None and frac >= CLEAN_MAX_DROP_FRAC


def clean_alpha(cut_path: str, tuck: bool = False) -> Optional[str]:
    """Harden thin-feature edges + drop detached faint ghosts on a published
    RGBA cutout, preserving the art. Deterministic, Pillow-only. Returns a note
    or None. Safe to re-run (idempotent-ish: a clean plate barely changes).

    tuck=True keeps ONLY the largest solid component (drops EVERY other one,
    even a near-attached extremity): the "tucked feet" cleanup for a bird whose
    only defect is an awkward thin dangling leg/foot Gemini won't stop drawing —
    it leaves a clean rounded belly (the classic compact resting pose). Opt-in
    per call (never the default), so a real connected foot is only removed when
    a caller explicitly asks for a slug."""
    im = Image.open(cut_path).convert("RGBA")
    w, h = im.size
    n = w * h
    A = im.getchannel("A")
    apx = list(A.getdata())
    on = CLEAN_SOLID_T
    core = [1 if v >= on else 0 for v in apx]
    # Connected components of the SOLID core (legs/toes at full ink ARE solid).
    seen = bytearray(n)
    min_sz = max(1, int(CLEAN_MIN_CORE_FRAC * n))
    comps = []  # (size, indices) for every solid component >= min_sz
    for start in range(n):
        if core[start] and not seen[start]:
            comp = []
            dq = deque((start,))
            seen[start] = 1
            while dq:
                i = dq.popleft()
                comp.append(i)
                x = i % w
                if x > 0 and core[i - 1] and not seen[i - 1]:
                    seen[i - 1] = 1
                    dq.append(i - 1)
                if x < w - 1 and core[i + 1] and not seen[i + 1]:
                    seen[i + 1] = 1
                    dq.append(i + 1)
                if i >= w and core[i - w] and not seen[i - w]:
                    seen[i - w] = 1
                    dq.append(i - w)
                if i < n - w and core[i + w] and not seen[i + w]:
                    seen[i + w] = 1
                    dq.append(i + w)
            if len(comp) >= min_sz:
                comps.append((len(comp), comp))
    if not comps:
        return None  # nothing confident to keep — leave the plate untouched
    # The bird is ONE connected silhouette = the largest solid component. Keep it,
    # plus its attached extremities. A SECOND solid component that both (a) sits
    # beyond a hairline reach of the body AND (b) is small relative to it is a
    # render defect — dangling detached feet, a doubled ghost leg, a floating
    # fragment — NOT an extremity. Drop it. (A large second region, or one hugging
    # the body through a chromakey nick the halo would rejoin, is kept.) This is
    # what removes the talons Gemini paints floating below a flight bird's belly.
    comps.sort(key=lambda c: c[0], reverse=True)
    body_sz, body_idx = comps[0]
    keepcore = bytearray(n)
    for i in body_idx:
        keepcore[i] = 1
    r = max(2, int(CLEAN_HALO_FRAC * max(w, h)))
    if len(comps) > 1 and not tuck:
        bodymask = Image.frombytes("L", (w, h),
                                   bytes(255 if b else 0 for b in keepcore))
        reachpx = bodymask.filter(ImageFilter.MaxFilter(4 * r + 1)).load()  # ~2r each side
        for sz, idx in comps[1:]:
            if sz >= CLEAN_SATELLITE_MAX_FRAC * body_sz or \
                    any(reachpx[i % w, i // w] for i in idx):
                for i in idx:
                    keepcore[i] = 1
            # else: detached satellite -> left out of keepcore (dropped)
    coreim = Image.frombytes("L", (w, h), bytes(255 if b else 0 for b in keepcore))
    # A tight halo around the kept core: preserves the bird's OWN anti-aliased
    # edge and its connected legs/tail, but excludes DETACHED faint ghosts
    # sitting beyond the halo.
    halo = coreim.filter(ImageFilter.MaxFilter(2 * r + 1))
    # Final alpha: original inside the halo, zero outside (C op, no pixel loop).
    black = Image.new("L", (w, h), 0)
    masked = Image.composite(A, black, halo)
    # The meaningful cleanup number: opaque pixels the halo removed (detached
    # ghosts / fuzz beyond the core) — measured BEFORE the feather re-adds soft
    # edge pixels, so it honestly reflects what was cut, not the net count.
    before = sum(1 for v in apx if v > QA_ALPHA_ON)
    after_mask = sum(1 for v in masked.getdata() if v > QA_ALPHA_ON)
    dropped = (before - after_mask) / float(before) if before else 0.0
    # Smooth ragged notches (a morphological close) then a clean 0.6px feather.
    out = masked.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3))
    out = out.filter(ImageFilter.GaussianBlur(0.6))
    im.putalpha(out)
    im.save(cut_path)
    kind = "tucked (kept body only)" if tuck else "detached"
    return "cleaned edge (removed %.3f %s, halo=%dpx)" % (dropped, kind, r)


# Interior-pocket heal: when a pale body region sits within the chromakey
# tolerance of the ground, the key flood eats it through any thin cream path
# and the plate ships with an alpha-0 void INSIDE the bird — invisible on the
# light card (cream void over cream card), a jagged black hole on the dark
# dossier. The paint is still present in the RGB channels (the key only zeroes
# alpha), so restoring alpha over such a pocket reveals the ORIGINAL art —
# deterministic, zero Gemini spend, never invents a pixel. A keyed body region
# is enclosed by solid bird once the silhouette is morphologically closed;
# genuine negative space (a between-the-legs gap) opens wide to the ground and
# never seals, so the closing separates the two.
CLEAN_HEAL_CLOSE_FRAC = float(os.environ.get("CLEAN_HEAL_CLOSE_FRAC", "0.014"))  # closing radius / long edge
CLEAN_HEAL_MIN_FRAC = float(os.environ.get("CLEAN_HEAL_MIN_FRAC", "0.01"))       # min pocket area / body area


def heal_pockets(cut_path: str) -> Optional[str]:
    """Restore alpha over large transparent pockets trapped inside the bird's
    CLOSED silhouette (keyed-away pale body regions whose paint survives in the
    RGB). Opt-in per /reclean call, never a default publish step: a rare
    legitimate enclosed background pocket is only filled when an operator has
    eyeballed the plate. Returns a note, or None when no qualifying pocket."""
    im = Image.open(cut_path).convert("RGBA")
    w, h = im.size
    A = im.getchannel("A")
    S = A.point(lambda v: 255 if v >= 128 else 0)
    body = S.histogram()[255]
    if not body:
        return None
    r = max(4, int(CLEAN_HEAL_CLOSE_FRAC * max(w, h)))
    k = 2 * r + 1
    closed = S.filter(ImageFilter.MaxFilter(k)).filter(ImageFilter.MinFilter(k))
    # Ground = the region outside the closed silhouette, found by flooding its
    # complement from the frame border. Transparent pixels the flood cannot
    # reach are interior pockets.
    scratch = ImageChops.invert(closed)
    for seed in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1),
                 (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2)):
        if scratch.getpixel(seed) == 255:
            ImageDraw.floodfill(scratch, seed, 128)
    outside = scratch.point(lambda v: 255 if v == 128 else 0)
    pocket = ImageChops.multiply(ImageChops.invert(outside), ImageChops.invert(S))
    # Keep only pockets big enough to be a keyed body region — toe-gap and
    # feather-notch specks stay as the art's own negative space.
    ppx = list(pocket.getdata())
    n = w * h
    min_sz = max(1, int(CLEAN_HEAL_MIN_FRAC * body))
    seen = bytearray(n)
    keep = bytearray(n)
    healed_px = 0
    pockets = 0
    for start in range(n):
        if ppx[start] and not seen[start]:
            comp = []
            dq = deque((start,))
            seen[start] = 1
            while dq:
                i = dq.popleft()
                comp.append(i)
                x = i % w
                if x > 0 and ppx[i - 1] and not seen[i - 1]:
                    seen[i - 1] = 1
                    dq.append(i - 1)
                if x < w - 1 and ppx[i + 1] and not seen[i + 1]:
                    seen[i + 1] = 1
                    dq.append(i + 1)
                if i >= w and ppx[i - w] and not seen[i - w]:
                    seen[i - w] = 1
                    dq.append(i - w)
                if i < n - w and ppx[i + w] and not seen[i + w]:
                    seen[i + w] = 1
                    dq.append(i + w)
            if len(comp) >= min_sz:
                pockets += 1
                healed_px += len(comp)
                for i in comp:
                    keep[i] = 1
    if not pockets:
        return None
    keepim = Image.frombytes("L", (w, h), bytes(255 if b else 0 for b in keep))
    healed = ImageChops.lighter(A, keepim.filter(ImageFilter.GaussianBlur(0.6)))
    im.putalpha(healed)
    im.save(cut_path)
    return "healed %d interior pocket(s), %d px (%.1f%% of body)" % (
        pockets, healed_px, 100.0 * healed_px / body)


# Times the verify gate went BLIND this process (API error or unparseable
# response -> fail open, by design). Exposed on /health so a Gemini-Vision
# drift that silently disarms the never-worse gate is visible from one curl
# instead of only as scattered log lines. In-memory: resets on redeploy.
_VERIFY_FAIL_OPEN = 0


def _qa_verify(slug: str, sci: str, com: str, pose: int, cut_path: Path,
               manual: bool = False, protect_existing: bool = False) -> Optional[str]:
    """Adversarial ID/anatomy gate (AV_VERIFY on). One Gemini-Vision call via
    verify.verify_one; rejects an off-species or malformed render so it
    regenerates. Fails OPEN (never rejects) when the model errors or the response
    can't be parsed — a QA gate must not reject on partial/absent data.

    The pose-1 (required) reject loop is bounded by AV_VERIFY_MAX_REJECTS: after
    that many rejects the least-bad render is accepted-with-flag rather than
    stranding the species in an endless regen loop (a real bird in slightly-off
    plumage beats a permanent silhouette). Pose-2 (flight) rejects need no budget
    — they're already bounded by the POSE2_TRIES loop and fall back to perched.

    Returns the Conservator's Mark outcome for the render under inspection:
    'attested' (verdict pass), 'caveat' (accept-with-flag publish), or None
    (fail-open — the gate was blind, the plate publishes unexamined). Raising
    QAReject means no publish, so no mark. The caller persists it only AFTER
    the atomic publish (set_attest)."""
    global _VERIFY_FAIL_OPEN
    try:
        v = verify_one(GEMINI_API_KEY, cut_path, sci, com)
    except Exception as e:  # network/API error -> not a QA verdict; keep the clean render
        _VERIFY_FAIL_OPEN += 1
        log.warning("verify_one error slug=%s err=%s (skipping verify gate)", slug, e)
        return None  # NOT billed as a verdict — don't count; publishes unexamined
    record_verify(manual=manual)  # the call returned -> count the paid verify
    if not v:
        _VERIFY_FAIL_OPEN += 1  # unparseable = the gate is blind, not a pass verdict
        return None  # unparseable -> fail open; publishes unexamined
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
    elif pose == 1 and v["leg_count"] == 0:
        # A PERCHED bird with no visible legs at all: needle-legged waders
        # (the plover scar) lose their legs to the key/scan — geometry can't
        # see them, but the vision gate can count them. leg_count defaults to
        # 2 on partial data, so only an explicit zero lands here. Flight
        # renders legitimately tuck legs away — pose-2 is exempt.
        reason = "no visible legs (perched)"
    elif (not v["matches_target"]) and v["guess_confidence"] == "high":
        reason = "reads as %s (conf=high), not %s" % (v.get("guessed_species_com", "?"), com)
    elif v["wing_count"] > 2:
        reason = "wing_count=%s" % v["wing_count"]
    elif v["leg_count"] > 2:
        reason = "leg_count=%s" % v["leg_count"]
    elif v["has_stick_or_perch"]:
        reason = "has stick/perch"
    if reason is None:
        return "attested"  # passed
    if pose != 1:
        raise QAReject("verify: " + reason)  # pose-2: bounded by POSE2_TRIES, no budget needed
    if get_verify_rejects(slug) >= AV_VERIFY_MAX_REJECTS:
        if protect_existing:
            # NEVER-WORSE (refusal 4): a good plate already hangs. accept-with-flag
            # exists so a NEW species beats a permanent silhouette — but here a
            # verify-failed render would overwrite a correct plate, making the
            # wall worse. Keep the old plate; the press parks honestly.
            raise QAReject("verify: %s (protected — keeping the existing plate)" % reason)
        log.warning("verify: publishing best-effort after %d verify rejects slug=%s (last: %s)",
                    AV_VERIFY_MAX_REJECTS, slug, reason)
        return "caveat"  # accept-with-flag: a real bird in slightly-off plumage beats a permanent silhouette
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

# Species whose needle-thin pale legs vanish in keying/scanning (waders — the
# plover scar): once the verify gate sees a legless perched render, later gens
# ask for visibly weighted legs. Same in-memory lifecycle as the pale set.
_LEGS_HINT_SLUGS: set = set()

LEGS_NOTE = (
    "Render the bird's legs and feet CLEARLY VISIBLE, fully attached, and in "
    "confident DARK ink strokes (deep umber or black-brown — NEVER pale pink, "
    "NEVER faint washes: pale thin legs are the exact failure being corrected). "
    "Both legs and the toes must read as deliberate dark brush strokes, and "
    "the bird must STAND on them — not crouch or sit."
)


def _gen_pose(slug: str, sci: str, com: str, pose: int,  # noqa: C901  (complexity 19; pre-existing debt, see .flake8)
              pos, anti, anti_key, manual: bool = False) -> float:
    """One pose end-to-end: MIN_SPACING throttle -> gen_one(pose) -> creamkey
    cutout -> QA gate -> atomic publish. pose 1 -> <slug>.png (perched),
    pose N -> <slug>-N.png (flight). Returns the opaque fraction. Raises
    QAReject / RuntimeError / urllib errors — the caller decides whether the
    failure is fatal (pose-1) or swallowed (pose-2). manual tags the spend
    ledger (viewer repaint vs auto/first-hearing).

    A 'hollow cutout' reject (white bird merging into the cream ground) is
    retried ONCE immediately on a darker ground — the failure is deterministic
    for pale species, so backoff re-rolls on the same ground would never
    converge — and the slug is remembered so later gens start dark."""
    out_name = "%s.png" % slug if pose == 1 else "%s-%d.png" % (slug, pose)
    tmp_tag = slug if pose == 1 else "%s-%d" % (slug, pose)
    style = _resolve_style_ref(sci, pose)
    # A good plate already hangs iff its file exists at gen start — true exactly
    # for a keep_current regen. Under this flag the verify accept-with-flag
    # fallback must NOT publish a flagged render over the good plate (never-worse,
    # refusal 4): it raises instead, and the press parks honestly. Delete-first
    # regens and first-hearings have no file here, so accept-with-flag keeps its
    # original "a real bird beats a permanent silhouette" behavior.
    protect_existing = (ASSETS_DIR / out_name).exists()

    def attempt() -> float:
        note = NOTES.get(sci)
        for hinted, hint in ((slug in _PALE_GROUND_SLUGS, PALE_GROUND_NOTE),
                             (slug in _LEGS_HINT_SLUGS, LEGS_NOTE)):
            if hinted:
                note = ((note + "\n\n") if note else "") + hint
        _throttle_spacing()  # MIN_SPACING before every Gemini image call
        png = pregen.gen_one(
            GEMINI_API_KEY, PROMPT, sci, com, pose,
            positive_ref=pos, anti_ref=anti, anti_ref_key=anti_key,
            species_note=note, style_ref=style,
        )
        record_gen(manual=manual)  # count the billable image now — QA-rejected ones still cost
        tmp_raw = ASSETS_DIR / (".%s.raw.png" % tmp_tag)
        tmp_cut = ASSETS_DIR / (".%s.cut.png" % tmp_tag)
        try:
            tmp_raw.write_bytes(png)
            frac = chromakey(str(tmp_raw), str(tmp_cut),
                             tol=KEY_TOL_SLUGS.get(slug, 42))
            if not (QA_MIN <= frac <= QA_MAX):
                raise QAReject("opaque_frac=%.4f out of [%.3f,%.3f]" % (frac, QA_MIN, QA_MAX))
            # deterministic dirty-output gate (leaked magenta / ragged alpha /
            # border-contact / mangled aspect / hollow cutout -> QAReject;
            # small alpha islands are scrubbed in place instead of rejected).
            scrub_note = _qa_inspect(str(tmp_cut))
            if scrub_note:
                log.info("qa-scrub slug=%s pose=%s %s", slug, pose, scrub_note)
            # adversarial species/anatomy gate (one Gemini-Vision call).
            # attest_out: 'attested' | 'caveat' | None (unexamined — verify off
            # or fail-open). A QAReject raise skips publish, so no mark change.
            attest_out = None
            if AV_VERIFY:
                attest_out = _qa_verify(slug, sci, com, pose, tmp_cut, manual=manual,
                                        protect_existing=protect_existing)
            # Edge cleanup: harden thin-feature edges + drop faint ghosts so the
            # published plate is clean and whole (no frayed/ripped tails or toes).
            # TUCK_SLUGS species keep the tuck fix across regens (perched only —
            # a one-off /reclean {tuck:true} otherwise dies on the next repaint).
            _clean_tuck = (pose == 1 and slug in TUCK_SLUGS)
            _preclean = tmp_cut.read_bytes()  # for never-worse revert below
            clean_note = clean_alpha(str(tmp_cut), tuck=_clean_tuck)
            if clean_note:
                if _clean_over_removed(clean_note, _clean_tuck):
                    # never-worse: this cleanup ate a mutilating fraction of the
                    # bird. Nothing re-inspects post-clean bytes, so revert here
                    # and publish the QA-passed PRE-clean plate — never a clipped
                    # bird (deterministic, zero-spend gate on clean_alpha output).
                    tmp_cut.write_bytes(_preclean)
                    log.warning("qa-clean-revert slug=%s pose=%s %s (>= %.0f%% "
                                "removed — reverted, publishing pre-clean plate)",
                                slug, pose, clean_note, CLEAN_MAX_DROP_FRAC * 100.0)
                    clean_note = None
                else:
                    log.info("qa-clean slug=%s pose=%s %s", slug, pose, clean_note)
                    _warn_big_clean_drop(slug, pose, clean_note)
            # Never-worse insurance: archive the outgoing plate to the _prev/
            # SUBDIRECTORY (ring-of-1 — each publish overwrites the previous
            # archive) before replacing it. A sibling "<slug>.prev.png" would
            # surface a phantom slug via generated_slugs()/manifest; the
            # subdirectory is invisible to that listing. Best-effort: a failed
            # archive never blocks a QA-passed publish.
            out_path = ASSETS_DIR / out_name
            if out_path.exists():
                try:
                    prev_dir = ASSETS_DIR / "_prev"
                    prev_dir.mkdir(parents=True, exist_ok=True)
                    tmp_prev = prev_dir / (".%s.tmp" % out_name)
                    shutil.copy2(str(out_path), str(tmp_prev))
                    os.replace(str(tmp_prev), str(prev_dir / out_name))
                except OSError as e:
                    log.warning("prev-archive failed slug=%s pose=%d err=%s (publishing anyway)",
                                slug, pose, e)
            # atomic publish (same filesystem -> os.replace is atomic)
            os.replace(str(tmp_cut), str(out_path))
            if pose == 1:
                # Conservator's Mark: persist the verdict for the plate that
                # actually HUNG (after the swap, never before). Fail-open and
                # verify-off overwrite any older mark with NULL — a stale
                # attestation on a new unexamined plate would be a false seal.
                set_attest(slug, attest_out)
            return frac
        finally:
            for p in (tmp_raw, tmp_cut):
                try:
                    if p.exists():
                        p.unlink()
                except OSError:
                    pass

    try:
        return attempt()
    except QAReject as e:
        # Deterministic per-species failures get ONE immediate mechanism-change
        # retry (same-recipe backoff re-rolls can never converge on these):
        # hollow cutout -> darker ground; legless perched -> weighted legs.
        msg = str(e)
        hinted = False
        if "hollow cutout" in msg and slug not in _PALE_GROUND_SLUGS:
            _PALE_GROUND_SLUGS.add(slug)
            log.info("qa-hollow slug=%s pose=%d — immediate retry on darker ground", slug, pose)
            hinted = True
        if "no visible legs" in msg and slug not in _LEGS_HINT_SLUGS:
            _LEGS_HINT_SLUGS.add(slug)
            # Legless is usually a CONTRAST failure at the key (pale legs merge
            # into the cream ground), so darken the ground too — both sides of
            # the boundary move apart.
            _PALE_GROUND_SLUGS.add(slug)
            log.info("qa-legless slug=%s pose=%d — immediate retry with dark legs + darker ground", slug, pose)
            hinted = True
        if hinted:
            return attempt()
        raise


def _generate_sync(slug: str, sci: str, com: str,
                   regen_poses: Optional[str] = None,
                   manual: bool = False) -> float:
    """Generate the species' poses so the collage's flight toggle works.

    regen_poses is the job row's directive ('1' | '2' | '1,2'; None = legacy):
    a DIRECTED pose is force-regenerated even when its file exists (keep-current
    repaint — intent can't be inferred from the filesystem, because under
    generate-then-swap the old plate stays on disk the whole time). An
    UNDIRECTED pose is generated only when its file is missing, so a pose-1
    repaint never churns (and possibly regresses) a good existing flight.

    Pose-1 (perched, <slug>.png) is REQUIRED: its failure propagates so the
    species stays un-done and retries per the backoff policy; its opaque
    fraction is returned. Pose-2 (flight, <slug>-2.png) is BEST-EFFORT: it runs
    the identical creamkey + QA pipeline, but ANY failure (gen/QA) is logged and
    swallowed — the species is still marked done on pose-1 alone, and the /asset
    endpoint falls a flight request back to pose-1 when <slug>-2.png is absent.
    Species-level refs are resolved once and shared across both poses;
    MIN_SPACING is honored before each Gemini call inside _gen_pose."""
    directed = {p for p in (regen_poses or "").split(",") if p}
    force1, force2 = "1" in directed, "2" in directed
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    pos, anti, anti_key = _resolve_species_refs(slug, sci, com)
    # POSE-1 (perched) — required. Skip the gen when a clean pose-1 already
    # exists and the job doesn't direct pose-1 (a flight-backfill requeue):
    # never re-roll an already-good perched render the viewer didn't ask about.
    if not force1 and (ASSETS_DIR / ("%s.png" % slug)).exists():
        frac = -1.0  # sentinel: pose-1 preserved, not regenerated this run
        log.info("gen-pose1-kept slug=%s", slug)
    else:
        frac = _gen_pose(slug, sci, com, 1, pos, anti, anti_key, manual=manual)
    # POSE-2 (flight) — best-effort but RETRIED: pose-2 gen/QA is a ~50%
    # stochastic roll, so try up to POSE2_TRIES times before giving up (was one
    # shot, which left ~half of species with a flight toggle that fell back to
    # perched). A final miss is logged + swallowed — the species stays done on
    # pose-1 and /asset serves the perched fallback, never blocking the species.
    # Runs only when DIRECTED or the file is absent: the old unconditional roll
    # would double-spend and possibly regress a good flight on every repaint.
    if force2 or not (ASSETS_DIR / ("%s-2.png" % slug)).exists():
        for attempt in range(1, POSE2_TRIES + 1):
            try:
                f2 = _gen_pose(slug, sci, com, 2, pos, anti, anti_key, manual=manual)
                log.info("gen-pose2-done slug=%s opaque=%.1f%% try=%d", slug, f2 * 100, attempt)
                break
            except Exception as e:  # noqa: BLE001 — pose-2 is optional, never fatal
                log.warning("gen-pose2-miss slug=%s try=%d/%d err=%s",
                            slug, attempt, POSE2_TRIES, e)
    else:
        log.info("gen-pose2-kept slug=%s", slug)
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
                snap = month_snapshot()
                log.warning(
                    "budget-exhausted month_spend~=$%.2f >= budget=$%.2f gens=%d — pausing gen; "
                    "species stay queued, resume next month or on MONTHLY_BUDGET_USD raise",
                    snap["spend_usd"], MONTHLY_BUDGET_USD,
                    snap["gens"] + snap["manual_gens"],
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
            frac = await asyncio.to_thread(
                _generate_sync, slug, job["sci"], job["com"],
                job.get("regen_poses"), job.get("source") == "manual",
            )
            await asyncio.to_thread(mark_done, slug)
            snap = await asyncio.to_thread(month_snapshot)
            log.info(
                "gen-done slug=%s pose1=%s dur=%.1fs cost-estimate>=$%.3f month~=$%.2f",
                slug, ("kept" if frac < 0 else "%.1f%%" % (frac * 100)),
                time.monotonic() - t0, COST_PER_GEN_USD, snap["spend_usd"],
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
    snap = month_snapshot()
    spend, manual_spend = snap["spend_usd"], snap["manual_spend_usd"]
    return {
        "ok": True,
        "regen_api": 2,  # capability advert: /requeue v2 (poses/keep_current/source) + GET /job
        "queue_depth": q,
        "done_count": d,
        "month_spend_usd": round(spend, 4),
        "budget_usd": MONTHLY_BUDGET_USD,
        "gens_this_month": snap["gens"],
        "verifies_this_month": snap["verifies"],
        "budget_exhausted": (MONTHLY_BUDGET_USD > 0 and spend >= MONTHLY_BUDGET_USD),
        "manual_gens_this_month": snap["manual_gens"],
        "manual_verifies_this_month": snap["manual_verifies"],
        "manual_spend_usd": round(manual_spend, 4),
        "manual_frac": (manual_spend / spend if spend > 0 else 0.0),
        # verify-gate blindness since boot (fail-open on API error/unparseable).
        # A climbing number while gens keep landing = the never-worse gate is
        # disarmed and repaints are unguarded — check verify.py's model/schema.
        "verify_fail_open_since_boot": _VERIFY_FAIL_OPEN,
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
            # Marker header: these are SUBSTITUTE pose-1 bytes, not real pose-2
            # art. Without it a freshness probe (scripts/verify.sh) comparing
            # Pi-vs-Railway pose-2 bytes reads the fallback as a STALE mismatch.
            return FileResponse(str(p1), media_type="image/png",
                                headers={"X-Av-Pose-Fallback": "1"})
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
async def requeue(request: Request, authorization: Optional[str] = Header(None)):  # noqa: C901  (complexity 21; pre-existing debt, see .flake8)
    """Admin/manual regen over HTTP (v2, contract C1). Body:
        {"slugs": ["erithacus-rubecula"],  # REQUIRED, non-empty (422 otherwise)
         "poses": [1] | [2] | [1,2],       # which poses to (re)generate; default [1,2]
         "keep_current": false,            # true => NO pre-delete: the old plate keeps
                                           #   serving and is only overwritten by a
                                           #   QA-passing successor (never-worse)
         "source": "auto" | "manual",      # "manual" = viewer repaint: bundled slugs
                                           #   and over-manual-budget requests refused
         "keep_pose1": false}              # legacy alias == poses:[2] + keep_current:true
    Response 200: {"requeued": [...]} plus, when any slug was refused,
    {"refused": {slug: "bundled" | "manual_budget"}} — partial acceptance.
    Absent new fields => today's delete-first behavior, byte-identical response
    (the SSH harness is untouched). The old empty-list fallback ("requeue every
    dead+done row") is GONE: a LAN button reaching this endpoint made that a
    wall-wipe footgun, so empty slugs now 422. Same Bearer auth as /detected."""
    # 0. misconfiguration -> fail loud
    if not WATCHER_WEBHOOK_SECRET:
        return JSONResponse({"error": "auth not configured"}, status_code=503)

    # 1. Bearer auth (constant-time compare)
    expected = "Bearer " + WATCHER_WEBHOOK_SECRET
    if not authorization or not hmac.compare_digest(authorization, expected):
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    # 2. resolve targets: an explicit, sanitized, NON-EMPTY slug list.
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    raw = body.get("slugs", [])
    requested = ([s.strip() for s in raw if isinstance(s, str) and s.strip()]
                 if isinstance(raw, list) else [])
    targets = [s for s in requested if _valid_slug(s)]
    if not targets:
        return JSONResponse({"error": "empty slugs"}, status_code=422)

    source = body.get("source", "auto")
    if source not in ("auto", "manual"):
        return JSONResponse({"error": "invalid source"}, status_code=422)

    keep_current = bool(body.get("keep_current", False))
    # keep_pose1=true is the legacy flight-backfill alias == poses:[2] +
    # keep_current:true — the directed pose-2 forces the flight re-roll, pose-1
    # is neither deleted nor re-rolled, and (new) the old flight keeps serving
    # until its QA-passed successor atomically replaces it.
    if bool(body.get("keep_pose1", False)):
        poses = [2]
        keep_current = True
    else:
        raw_poses = body.get("poses")
        if raw_poses is None:
            poses = [1, 2]
        else:
            if (not isinstance(raw_poses, list) or not raw_poses
                    or any(type(p) is not int or p not in (1, 2) for p in raw_poses)):
                return JSONResponse({"error": "invalid poses"}, status_code=422)
            poses = sorted(set(raw_poses))
    regen_poses = ",".join(str(p) for p in poses)

    manual = source == "manual"
    manual_spent = manual and manual_budget_exhausted()

    # 3. per-slug: manual refusals -> (delete-first unless keep_current) ->
    #    reset row with the pose directive -> wake worker. Partial acceptance:
    #    refused slugs are reported, accepted ones still requeue, always 200.
    requeued: list = []
    refused: dict = {}
    for slug in targets:
        if manual and slug in BUNDLED:
            # bundled plates are served from the Pi's own tiers before the
            # Railway proxy — regen art here would never be seen on the wall.
            refused[slug] = "bundled"
            continue
        if manual_spent:
            refused[slug] = "manual_budget"
            continue
        if not keep_current:
            # legacy delete-first: a dirty plate must stop serving NOW, but only
            # the DIRECTED poses — a single-pose re-roll never wipes a good
            # render of the pose it wasn't asked to touch.
            if poses == [1]:
                _delete_pose1(slug)
            elif poses == [2]:
                _delete_pose2(slug)
            else:
                _delete_published(slug)
        requeue_row(slug, regen_poses=regen_poses, source=source)
        if _wakeup is not None:
            try:
                _wakeup.put_nowait(slug)
            except asyncio.QueueFull:
                pass
        requeued.append(slug)
    log.info("requeue: reset %d slug(s) -> queued (poses=%s keep_current=%s source=%s refused=%d)",
             len(requeued), regen_poses, keep_current, source, len(refused))
    resp: dict = {"requeued": requeued}
    if refused:
        resp["refused"] = refused
    return resp


@app.post("/reclean")
async def reclean(request: Request, authorization: Optional[str] = Header(None)):  # noqa: C901  (complexity 22; pre-existing debt, see .flake8)
    """Re-run the edge cleanup over ALREADY-PUBLISHED plates — no Gemini call,
    no ledger cost, the SAME art. Fixes frayed/ripped thin features and faint
    ghosts that predate the cleanup step, without a stochastic re-roll. Body:
    {"slugs": [...], "poses": [1]|[2]|[1,2] (default [1,2]),
     "heal": true — restore large keyed-away pockets INSIDE the silhouette
     (heal_pockets), "rekey_tol": 5..41 — re-run the chromakey from the plate's
     own embedded RGB at a tighter tolerance (recovers a pale belly the default
     tol keyed out, reconnecting anything it severed)}. Bearer auth.
    Atomic + never-worse: each plate is archived to _prev/ and only overwritten
    when the cleaned version writes successfully; a rekey whose opaque fraction
    leaves the QA band is discarded, keeping the current plate."""
    if not WATCHER_WEBHOOK_SECRET:
        return JSONResponse({"error": "auth not configured"}, status_code=503)
    expected = "Bearer " + WATCHER_WEBHOOK_SECRET
    if not authorization or not hmac.compare_digest(authorization, expected):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    raw = body.get("slugs", [])
    targets = ([s.strip() for s in raw if isinstance(s, str) and _valid_slug(s.strip())]
               if isinstance(raw, list) else [])
    if not targets:
        return JSONResponse({"error": "empty slugs"}, status_code=422)
    raw_poses = body.get("poses")
    if raw_poses is None:
        poses = [1, 2]
    elif (isinstance(raw_poses, list) and raw_poses
          and all(type(p) is int and p in (1, 2) for p in raw_poses)):
        poses = sorted(set(raw_poses))
    else:
        return JSONResponse({"error": "invalid poses"}, status_code=422)
    # tuck=True keeps ONLY the body (drops even a near-attached foot) — the
    # "tucked feet / clean rounded belly" cleanup for the passed slugs only.
    # TUCK_SLUGS species get tuck on their PERCHED plate even without the flag,
    # so the registry-persisted fix survives casual recleans too.
    tuck = body.get("tuck") is True
    heal = body.get("heal") is True
    rekey_tol = body.get("rekey_tol")
    if rekey_tol is not None and not (type(rekey_tol) is int and 5 <= rekey_tol <= 41):
        return JSONResponse({"error": "invalid rekey_tol (int 5..41)"}, status_code=422)

    recleaned: list = []
    skipped: dict = {}
    notes: dict = {}
    for slug in targets:
        for pose in poses:
            name = "%s.png" % slug if pose == 1 else "%s-%d.png" % (slug, pose)
            out_path = ASSETS_DIR / name
            key = "%s#%d" % (slug, pose)
            if not out_path.exists():
                skipped[key] = "absent"
                continue
            tmp = ASSETS_DIR / (".%s.clean.png" % name)
            try:
                shutil.copy2(str(out_path), str(tmp))
                steps: list = []
                if rekey_tol is not None:
                    # Re-key from the plate's OWN embedded RGB (the key only
                    # zeroes alpha; the full paint — ground included — survives
                    # underneath), rebuilding alpha from scratch at the tighter
                    # tolerance. Discarded unless the result stays in-band.
                    frac = chromakey(str(tmp), str(tmp), tol=rekey_tol)
                    if not (QA_MIN <= frac <= QA_MAX):
                        skipped[key] = "rekey-out-of-band (opaque=%.3f)" % frac
                        os.unlink(str(tmp))
                        continue
                    steps.append("rekeyed tol=%d opaque=%.3f" % (rekey_tol, frac))
                if heal:
                    heal_note = heal_pockets(str(tmp))
                    if heal_note:
                        steps.append(heal_note)
                _reclean_tuck = tuck or (pose == 1 and slug in TUCK_SLUGS)
                note = clean_alpha(str(tmp), tuck=_reclean_tuck)
                if note is None and not steps:
                    skipped[key] = "nothing-to-clean"
                    os.unlink(str(tmp))
                    continue
                if note and steps:
                    note = " | ".join(steps + [note])
                elif steps:
                    note = " | ".join(steps)
                if _clean_over_removed(note, _reclean_tuck):
                    # never-worse: a non-tuck reclean that would remove a
                    # mutilating fraction is NOT applied — keep the current plate
                    # untouched. (/reclean has no other quality gate.)
                    skipped[key] = "over-clean-reverted"
                    log.warning("reclean-revert slug=%s pose=%d %s (>= %.0f%% "
                                "removed — kept current plate)",
                                slug, pose, note, CLEAN_MAX_DROP_FRAC * 100.0)
                    os.unlink(str(tmp))
                    continue
                # never-worse: archive the current plate, then atomic swap.
                prev_dir = ASSETS_DIR / "_prev"
                prev_dir.mkdir(parents=True, exist_ok=True)
                tprev = prev_dir / (".%s.tmp" % name)
                shutil.copy2(str(out_path), str(tprev))
                os.replace(str(tprev), str(prev_dir / name))
                os.replace(str(tmp), str(out_path))
                log.info("reclean slug=%s pose=%d %s", slug, pose, note)
                _warn_big_clean_drop(slug, pose, note)
                recleaned.append(key)
                notes[key] = note  # caller sees WHAT was cut (incl. the drop frac)
                if tuck and pose == 1 and slug not in TUCK_SLUGS:
                    # The moment the drift is born: a one-off tuck outside the
                    # registry dies on the next repaint/regen. Say so in the
                    # RESPONSE the operator is reading right now — a log line
                    # nobody re-reads is how the last tuck fix was lost.
                    notes[key] += (" | NOT PERSISTED: slug is not in TUCK_SLUGS"
                                   " — the next repaint/regen undoes this tuck")
                    log.warning("reclean tuck slug=%s NOT in TUCK_SLUGS — "
                                "fix dies on the next regen", slug)
            except OSError as e:
                skipped[key] = "error"
                log.warning("reclean failed slug=%s pose=%d: %s", slug, pose, e)
                try:
                    if tmp.exists():
                        os.unlink(str(tmp))
                except OSError:
                    pass
    resp: dict = {"recleaned": recleaned}
    if notes:
        resp["notes"] = notes
    if skipped:
        resp["skipped"] = skipped
    return resp


@app.get("/jobs")
async def jobs_roster(authorization: Optional[str] = Header(None)):
    """Roster of EVERY tracked job — the wall-mode feed for scripts/verify.sh
    (P0 of the pipeline-hardening plan: answer "what is the wall showing right
    now" in one command). Bearer-gated like /job; read-only, no gen, no spend."""
    if not WATCHER_WEBHOOK_SECRET:
        return JSONResponse({"error": "auth not configured"}, status_code=503)
    expected = "Bearer " + WATCHER_WEBHOOK_SECRET
    if not authorization or not hmac.compare_digest(authorization, expected):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    with _db_lock:
        rows = db().execute(
            "SELECT slug, state, attempts, verify_rejects, fail_reason, attest "
            "FROM species_jobs ORDER BY slug"
        ).fetchall()

    def _size(p: Path) -> int:
        try:  # single stat, no exists()-then-stat() TOCTOU vs a delete-first requeue
            return p.stat().st_size
        except OSError:
            return 0

    out = []
    for slug, state, attempts, verify_rejects, fail_reason, attest in rows:
        out.append({
            "slug": slug,
            "state": state,
            "attempts": attempts,
            "verify_rejects": verify_rejects or 0,
            "fail_reason": fail_reason,
            "pose1_bytes": _size(ASSETS_DIR / ("%s.png" % slug)),
            "pose2_bytes": _size(ASSETS_DIR / ("%s-2.png" % slug)),
            "attest": attest_state(attest, verify_rejects),
        })
    return {"jobs": out}


# Conservator's Mark, public read. Quality METADATA only (no art, no queue
# control, no spend surface) — deliberately unauthenticated + CORS-open so the
# museum popup on the Pi's wall can fetch it straight from the browser without
# proxying a secret through PHP for data this harmless.
_ATTEST_CORS = {"Access-Control-Allow-Origin": "*"}


@app.get("/attest/{slug}")
async def attest_read(slug: str):
    if not _valid_slug(slug):
        return JSONResponse({"error": "bad slug"}, status_code=422, headers=_ATTEST_CORS)
    a = get_attest(slug)
    if a is None:
        return JSONResponse({"error": "unknown"}, status_code=404, headers=_ATTEST_CORS)
    return JSONResponse({"slug": slug, **a}, headers=_ATTEST_CORS)


@app.get("/job/{slug}")
async def job_status(slug: str, authorization: Optional[str] = Header(None)):
    """Repaint poll target (contract C2). Bearer-gated like /detected — the
    Pi's regen.php proxies it, so queue state never faces the open internet.
    state 'unknown' = no row for that slug; asset mtimes are the swap signal
    (a done job whose mtime advanced past the press-time stamp has landed)."""
    if not WATCHER_WEBHOOK_SECRET:
        return JSONResponse({"error": "auth not configured"}, status_code=503)
    expected = "Bearer " + WATCHER_WEBHOOK_SECRET
    if not authorization or not hmac.compare_digest(authorization, expected):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    if not _valid_slug(slug):
        return JSONResponse({"error": "not found"}, status_code=404)

    with _db_lock:
        row = db().execute(
            "SELECT state, attempts, next_retry, fail_reason FROM species_jobs WHERE slug=?",
            (slug,),
        ).fetchone()
        q = db().execute(
            "SELECT COUNT(*) FROM species_jobs WHERE state='queued'"
        ).fetchone()[0]
    if row:
        state, attempts, next_retry, fail_reason = row
        if state not in ("queued", "generating", "done", "dead"):
            state = "unknown"
    else:
        state, attempts, next_retry, fail_reason = "unknown", 0, 0, None

    def _mtime(name: str) -> Optional[float]:
        try:
            return (ASSETS_DIR / name).stat().st_mtime
        except OSError:
            return None

    snap = month_snapshot()
    return {
        "slug": slug,
        "state": state,
        "attempts": int(attempts or 0),
        "next_retry": float(next_retry or 0),
        "fail_reason": fail_reason,
        "asset_mtime": _mtime("%s.png" % slug),
        "asset2_mtime": _mtime("%s-2.png" % slug),
        "budget_exhausted": (MONTHLY_BUDGET_USD > 0
                             and snap["spend_usd"] >= MONTHLY_BUDGET_USD),
        "manual_paused": (MANUAL_BUDGET_USD > 0
                          and snap["manual_spend_usd"] >= MANUAL_BUDGET_USD),
        "queue_depth": q,
    }
