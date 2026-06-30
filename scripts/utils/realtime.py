"""Fire-and-forget realtime emit for bird.detected events.

This module is the ONLY new thing the detection pipeline calls. Its single
public function, ``emit_detected(detection)``, is invoked from the reporting
worker in ``birdnet_analysis.py`` immediately after ``write_to_db``.

Hard guarantees (Phase-0 refusals):
  * NEVER blocks or slows the detection loop. ``emit_detected`` does one
    ``queue.put_nowait`` and returns. A lazily-started daemon thread does the
    actual HTTP POST to the local ``birdcast`` SSE service.
  * NEVER raises into the caller. Everything is wrapped in try/except; a down,
    slow, or missing ``birdcast`` service costs the pipeline nothing -- the
    event is dropped locally and recovered later via the read-only DB tail
    (``birdcast`` falls back to ``SELECT rowid,* FROM detections WHERE rowid > :since``).
  * NO new dependencies -- stdlib only (``queue``, ``threading``, ``urllib``).

The cursor (``rowid``) is intentionally NOT set here: the analysis process has
no cheap, race-free way to know the implicit SQLite rowid of the row it just
wrote. ``birdcast`` assigns the cursor on ingest (high-water counter seeded
from ``MAX(rowid)``), keeping this hook dumb and the schema untouched.
"""

import json
import logging
import os
import queue
import re
import threading
import urllib.request

log = logging.getLogger(__name__)

# Endpoint of the standalone birdcast SSE service (loopback only).
BIRDCAST_URL = os.environ.get("AV_BIRDCAST_URL", "http://127.0.0.1:8090/emit")
# Per-POST timeout. Small on purpose: a hung service must not stall the worker
# thread for long, and the daemon thread is decoupled from the detection loop.
POST_TIMEOUT = float(os.environ.get("AV_BIRDCAST_TIMEOUT", "0.25"))
# Bounded queue: if birdcast is down and events pile up, we drop the oldest
# rather than grow memory without limit. The DB tail is the source of truth.
_MAX_QUEUE = 1000

_q = queue.Queue(maxsize=_MAX_QUEUE)
_worker_started = False
_worker_lock = threading.Lock()


def slugify(sci):
    """Scientific-name -> slug. IDENTICAL to the Python/PHP/JS contract:
    ``re.sub(r"[^a-z0-9]+","-", sci.lower()).strip("-")``."""
    return re.sub(r"[^a-z0-9]+", "-", (sci or "").lower()).strip("-")


def _build_payload(detection):
    """Build the bird.detected payload from a Detection object's attributes.

    Field names come from ``scripts/utils/classes.py`` (Detection). ``file`` is
    the basename of the extracted clip, mirroring what ``write_to_db`` stores.
    """
    sci = getattr(detection, "scientific_name", "") or ""
    file_extr = getattr(detection, "file_name_extr", None)
    file_name = os.path.basename(file_extr) if file_extr else ""
    return {
        "v": 1,
        "type": "bird.detected",
        # cursor deliberately omitted -- birdcast assigns the rowid.
        "sci": sci,
        "com": getattr(detection, "common_name", "") or "",
        "slug": slugify(sci),
        "conf": getattr(detection, "confidence", None),
        "conf_pct": getattr(detection, "confidence_pct", None),
        "iso8601": getattr(detection, "iso8601", None),
        "date": getattr(detection, "date", None),
        "time": getattr(detection, "time", None),
        "week": getattr(detection, "week", None),
        "file": file_name,
    }


def _drain():
    """Daemon-thread body: drain the queue, POST each payload to birdcast.

    Every iteration is fully guarded so a transient network/service failure
    never kills the thread (and thus never silently disables future emits)."""
    while True:
        try:
            payload = _q.get()
        except Exception:  # pragma: no cover - queue.get on a live queue won't raise
            continue
        try:
            data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                BIRDCAST_URL,
                data=data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=POST_TIMEOUT).close()
        except Exception as e:
            # Down/slow service: drop and move on. The DB tail recovers it.
            log.debug("birdcast emit dropped: %s", e)
        finally:
            try:
                _q.task_done()
            except Exception:
                pass


def _ensure_worker():
    """Start the single daemon worker on first use (idempotent)."""
    global _worker_started
    if _worker_started:
        return
    with _worker_lock:
        if _worker_started:
            return
        t = threading.Thread(target=_drain, name="birdcast-emit", daemon=True)
        t.start()
        _worker_started = True


def emit_detected(detection):
    """Public hook: enqueue a bird.detected event for the local SSE service.

    Non-blocking and exception-proof by contract. If anything at all goes
    wrong (queue full, bad attribute, etc.) we swallow it -- the detection
    pipeline must never be affected by realtime emission."""
    try:
        _ensure_worker()
        payload = _build_payload(detection)
        try:
            _q.put_nowait(payload)
        except queue.Full:
            # Drop the oldest to make room; never block the caller.
            try:
                _q.get_nowait()
                _q.task_done()
            except Exception:
                pass
            try:
                _q.put_nowait(payload)
            except Exception:
                pass
    except Exception as e:  # absolute backstop -- pipeline safety over delivery
        log.debug("emit_detected suppressed error: %s", e)
