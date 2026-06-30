#!/usr/bin/env python3
"""birdgen — Railway on-demand kachō-e bird generation service.

Phase A of the auto-gen watcher (see _plan/auto-gen-watcher/CONTRACT.md, the
LOCKED single source of truth). A Pi-side forwarder POSTs first-hearings of an
un-bundled species to /detected; this service generates exactly ONE perched
(pose-1) illustration per new species, cream-keys it to a transparent PNG, runs
a QA gate, and serves it from a Railway volume at /asset/<slug>.png.

Contract obligations honored here:
  - Bearer auth on /detected (Authorization: Bearer <WATCHER_WEBHOOK_SECRET>).
  - In-memory token-bucket rate-limit on /detected (429 over).
  - CONFIDENCE_THRESHOLD = 0.80 gate.
  - pose-1 ONLY (generating pose-2 is 100% wasted spend per KILL 6).
  - SQLite lease on the volume is the authoritative terminal state
    (queued | generating | done | dead). dead after 4 consecutive fails.
  - Single-flight asyncio worker; MIN_SPACING = 6s between Gemini calls;
    exponential backoff on failure (gen_one does the per-call 429/5xx retry).
  - QA gate: creamkey opaque-fraction in [0.015, 0.75]; fail -> dead, no publish.
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
import sqlite3
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

# Ported generation pipeline (verbatim copies of the avian/scripts originals).
import pregen
from creamkey import creamkey

# --------------------------------------------------------------------------- #
# Configuration (all via env; secrets never logged)
# --------------------------------------------------------------------------- #
HERE = Path(__file__).resolve().parent

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
WATCHER_WEBHOOK_SECRET = os.environ.get("WATCHER_WEBHOOK_SECRET", "")

CONF_THRESHOLD = float(os.environ.get("CONF_THRESHOLD", "0.80"))
MIN_SPACING = float(os.environ.get("MIN_SPACING", "6"))          # s between Gemini calls
MAX_ATTEMPTS = int(os.environ.get("MAX_ATTEMPTS", "4"))          # consecutive fails -> dead
BACKOFF_BASE = float(os.environ.get("BACKOFF_BASE", "900"))      # 15 min
BACKOFF_MAX = float(os.environ.get("BACKOFF_MAX", "21600"))      # 6 h cap
LEASE_TTL = int(os.environ.get("LEASE_TTL", "600"))             # generating-state crash guard
POLL_INTERVAL = float(os.environ.get("POLL_INTERVAL", "5"))     # worker idle re-poll (catches backoff)

QA_MIN = float(os.environ.get("QA_MIN_FRAC", "0.015"))
QA_MAX = float(os.environ.get("QA_MAX_FRAC", "0.75"))

RATE_CAPACITY = float(os.environ.get("RATE_CAPACITY", "30"))     # token bucket size
RATE_REFILL = float(os.environ.get("RATE_REFILL", "1.0"))       # tokens / second

ASSETS_DIR = Path(os.environ.get("ASSETS_DIR", "/data/assets"))
DB_PATH = ASSETS_DIR / "state.db"
PROMPT_PATH = Path(os.environ.get("PROMPT_PATH", str(HERE / "prompt.template.md")))
NOTES_PATH = Path(os.environ.get("NOTES_PATH", str(HERE / "species-notes.json")))
MANIFEST_PATH = HERE / "manifest.json"

# References. Wikipedia anatomy refs are fetched + cached on the volume.
# Style refs (Edo kachō-e prints) and anti-refs are NOT bundled in this service
# (per the contract's copy list); if a styles/anti dir is mounted, they are used,
# otherwise gen_one degrades gracefully (these args are optional).
FETCH_REFS = os.environ.get("FETCH_REFS", "1") not in ("0", "false", "False", "")
REFS_DIR = Path(os.environ.get("REFS_DIR", str(ASSETS_DIR / "_refs")))
ANTI_DIR = Path(os.environ.get("ANTI_DIR", str(REFS_DIR)))
_styles = os.environ.get("AV_STYLES_DIR", "")
STYLES_DIR: Optional[Path] = Path(_styles) if _styles else None

# Rough per-pose Gemini image cost, for the cost-estimate log line only.
COST_PER_GEN_USD = float(os.environ.get("COST_PER_GEN_USD", "0.04"))

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


def generated_slugs() -> set:
    """Slugs whose PNG already exists on the volume (top-level *.png only)."""
    try:
        return {f[:-4] for f in os.listdir(ASSETS_DIR) if f.endswith(".png")}
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
                updated_ts  INTEGER
            )
            """
        )
        _conn.commit()
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


def mark_fail(slug: str, fail_class: str, reason: str, attempts: int) -> str:
    """Apply the failure policy. Returns the resulting state."""
    now = int(time.time())
    # safety refusals / un-generatable inputs are terminal immediately;
    # otherwise dead after MAX_ATTEMPTS consecutive failures.
    if fail_class == "safety" or attempts >= MAX_ATTEMPTS:
        state, next_retry = "dead", 0
    else:
        state = "queued"
        backoff = min(BACKOFF_BASE * (2 ** (attempts - 1)), BACKOFF_MAX)
        next_retry = now + int(backoff)
    with _db_lock:
        db().execute(
            """
            UPDATE species_jobs
               SET state=?, next_retry=?, fail_reason=?, updated_ts=?
             WHERE slug=?
            """,
            (state, next_retry, ("%s:%s" % (fail_class, reason))[:300], now, slug),
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


def _resolve_refs(slug: str, sci: str, com: str):
    """Best-effort reference resolution. Wikipedia anatomy ref is fetched +
    cached on the volume; style/anti refs only if a dir is mounted. All optional
    — gen_one degrades gracefully when any is None."""
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
    style = None
    if STYLES_DIR is not None:
        sp = STYLES_DIR / pregen.select_style_ref(sci, 1)
        style = sp if sp.exists() else None
    return pos, anti, anti_key_for_call, style


def _generate_sync(slug: str, sci: str, com: str) -> float:
    """gen_one(pose=1) -> creamkey cutout -> QA gate -> atomic publish.
    Returns the opaque fraction. Raises QAReject / RuntimeError / urllib errors."""
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    pos, anti, anti_key, style = _resolve_refs(slug, sci, com)
    # POSE-1 ONLY per CONTRACT (generating pose-2 is wasted spend, KILL 6).
    png = pregen.gen_one(
        GEMINI_API_KEY, PROMPT, sci, com, 1,
        positive_ref=pos, anti_ref=anti, anti_ref_key=anti_key,
        species_note=NOTES.get(sci), style_ref=style,
    )
    tmp_raw = ASSETS_DIR / (".%s.raw.png" % slug)
    tmp_cut = ASSETS_DIR / (".%s.cut.png" % slug)
    try:
        tmp_raw.write_bytes(png)
        frac = creamkey(str(tmp_raw), str(tmp_cut))
        if not (QA_MIN <= frac <= QA_MAX):
            raise QAReject("opaque_frac=%.4f out of [%.3f,%.3f]" % (frac, QA_MIN, QA_MAX))
        # atomic publish (same filesystem -> os.replace is atomic)
        os.replace(str(tmp_cut), str(ASSETS_DIR / ("%s.png" % slug)))
        return frac
    finally:
        for p in (tmp_raw, tmp_cut):
            try:
                if p.exists():
                    p.unlink()
            except OSError:
                pass


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


async def worker() -> None:
    global _last_call
    log.info("worker started (MIN_SPACING=%ss, max_attempts=%s)", MIN_SPACING, MAX_ATTEMPTS)
    while not _stopping:
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
        # MIN_SPACING throttle between Gemini calls
        wait = MIN_SPACING - (time.monotonic() - _last_call)
        if wait > 0:
            await asyncio.sleep(wait)
        _last_call = time.monotonic()

        log.info("gen-start slug=%s attempt=%s", slug, job["attempts"])
        t0 = time.monotonic()
        try:
            frac = await asyncio.to_thread(_generate_sync, slug, job["sci"], job["com"])
            await asyncio.to_thread(mark_done, slug)
            log.info(
                "gen-done slug=%s opaque=%.1f%% dur=%.1fs cost-estimate=$%.3f",
                slug, frac * 100, time.monotonic() - t0, COST_PER_GEN_USD,
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
    q, d = counts()
    return {"ok": True, "queue_depth": q, "done_count": d}


@app.get("/manifest")
async def manifest():
    # single dedup source of truth: bundled UNION generated(volume)
    slugs = sorted(BUNDLED | generated_slugs())
    return {"slugs": slugs}


@app.get("/asset/{name}")
async def asset(name: str):
    if not name.endswith(".png"):
        return JSONResponse({"error": "not found"}, status_code=404)
    slug = name[:-4]
    path = ASSETS_DIR / ("%s.png" % slug)
    if not path.exists() or "/" in slug or slug in ("", ".", ".."):
        return JSONResponse({"error": "not found"}, status_code=404)
    return FileResponse(str(path), media_type="image/png")


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
