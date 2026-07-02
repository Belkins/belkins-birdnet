#!/usr/bin/env python3
"""forwarder -- outbound-only Pi->Railway detection bridge for the auto-gen watcher.

A standalone, stdlib-only daemon that subscribes to the local ``birdcast``
``GET /events`` SSE stream (exactly like a browser does) and forwards qualifying
``bird.detected`` frames to the Railway auto-gen service via
``POST {AV_RAILWAY_BASE}/detected``. Railway then generates the missing
kachō-e illustration on demand.

Why a separate daemon (per CONTRACT.md / ARCHITECTURE.md):
  * It is just another harmless SSE *subscriber*. It never touches the detection
    hot path, never modifies ``birdcast``'s broadcast loop, and if Railway/Gemini
    is down the collage behaves exactly as it does today (graceful degrade).
  * It gets the locked ``bird.detected`` schema and the assigned ``cursor`` for
    free, plus ``Last-Event-ID`` reconnect replay (no missed detections across
    restarts).

Design constraints (mirrors birdcast.py):
  * stdlib only -- no pip install (urllib + a tiny SSE line parser).
  * Python 3.9+ compatible: no match statements, no ``X | Y`` runtime unions.
  * FULLY GUARDED: a malformed frame, a down Railway, or a missing illustrations
    dir logs-and-continues. The daemon never crashes on per-event errors.

Security (CONTRACT.md "Auth (lite)"):
  * Holds ONLY ``WATCHER_WEBHOOK_SECRET`` (low-value, rotatable). NEVER the
    Gemini key -- that lives only on Railway.

Dedup / state (CONTRACT.md "Dedup / state"):
  * Cheap, STATELESS Pi pre-filter: drop ``conf < AV_CONF`` (0.70 -- matches
    what BirdNET-Pi itself records, so anything that earns a roster place earns
    art); drop if ``<slug>.png`` is already bundled locally. There is NO
    persisted Pi sent-set (the sent-set x threshold deadlock is the headline
    red-team kill). Re-POSTing a still-pending species is fine -- Railway
    dedups idempotently on ``slug``.

Reconcile sweep (the missed-bird healer):
  * The live SSE stream is a point-in-time gate: a species whose best call
    fired below AV_CONF, or fired while the forwarder/Railway was down, was
    missed FOREVER (the Black-headed Gull scar: heard at 0.73 under the old
    0.80 gate -> permanent silhouette). A background sweep re-reads birds.db
    (READ-ONLY -- honesty firewall) on start and every AV_RECONCILE_HOURS,
    and re-POSTs every species whose best-ever confidence clears AV_CONF.
    Railway's /detected dedups (done/queued/bundled all no-op), so the sweep
    is idempotent and cheap; POSTs are spaced to respect its rate bucket.

Config (env):
  BIRDCAST_EVENTS          SSE source (default http://127.0.0.1:8090/events)
  AV_RAILWAY_BASE          Railway base URL (e.g. https://x.up.railway.app)
  WATCHER_WEBHOOK_SECRET   Bearer token for POST /detected
  AV_ILLUSTRATIONS         bundled illustrations dir (default:
                           <repo>/avian/assets/illustrations, derived from
                           this file's location)
  AV_CONF                  confidence threshold (default 0.70)
  AV_BIRDS_DB              birds.db path for the reconcile sweep (default:
                           <repo>/scripts/birds.db; opened read-only)
  AV_RECONCILE_HOURS       hours between reconcile sweeps (default 6; 0 off)
"""

import json
import logging
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.request

log = logging.getLogger("forwarder")

# ---- configuration (env) ---------------------------------------------------

BIRDCAST_EVENTS = os.environ.get("BIRDCAST_EVENTS", "http://127.0.0.1:8090/events")
AV_RAILWAY_BASE = os.environ.get("AV_RAILWAY_BASE", "").rstrip("/")
WATCHER_WEBHOOK_SECRET = os.environ.get("WATCHER_WEBHOOK_SECRET", "")
AV_ILLUSTRATIONS = os.environ.get(
    "AV_ILLUSTRATIONS",
    os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        "avian", "assets", "illustrations",
    ),
)
AV_BIRDS_DB = os.environ.get(
    "AV_BIRDS_DB",
    os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        "scripts", "birds.db",
    ),
)
try:
    AV_CONF = float(os.environ.get("AV_CONF", "0.70"))
except (TypeError, ValueError):
    AV_CONF = 0.70
try:
    AV_RECONCILE_HOURS = float(os.environ.get("AV_RECONCILE_HOURS", "6"))
except (TypeError, ValueError):
    AV_RECONCILE_HOURS = 6.0

# ---- tunables --------------------------------------------------------------

POST_TIMEOUT = 5.0              # POST /detected timeout (s) -- CONTRACT: 5s
READ_TIMEOUT = 60.0            # SSE socket read timeout (> birdcast 15s keepalive)
BUNDLED_REFRESH_SECONDS = 300  # ~5 min re-scan of the illustrations dir
BACKOFF_START = 1.0           # reconnect backoff floor (s)
BACKOFF_MAX = 30.0            # reconnect backoff ceiling (s)
RECONCILE_FIRST_DELAY = 90.0   # let the box settle after boot before sweeping
RECONCILE_POST_GAP = 1.5       # s between sweep POSTs (respect Railway's bucket)


def slugify(sci):
    """Identical to the Python/PHP/JS slug contract (birdcast.slugify)."""
    return re.sub(r"[^a-z0-9]+", "-", (sci or "").lower()).strip("-")


# ---- bundled-illustration cache -------------------------------------------

class BundledSet:
    """Cached set of ``<slug>.png`` filenames in the illustrations dir.

    Built at startup and refreshed lazily every ~5 min. On a read failure the
    previous set is kept (never crash, never wipe the filter)."""

    def __init__(self, path, ttl=BUNDLED_REFRESH_SECONDS):
        self.path = path
        self.ttl = ttl
        self._names = set()
        self._loaded_at = 0.0
        self.refresh(force=True)

    def refresh(self, force=False):
        now = time.monotonic()
        if not force and (now - self._loaded_at) < self.ttl:
            return
        try:
            names = os.listdir(self.path)
            self._names = set(n for n in names if n.endswith(".png"))
            self._loaded_at = now
            log.info("bundled set refreshed: %d PNGs from %s",
                     len(self._names), self.path)
        except Exception as e:
            # Keep the previous set; back off the retry so a missing dir does
            # not get hammered every event.
            self._loaded_at = now
            log.warning("could not list illustrations dir %s: %s", self.path, e)

    def contains(self, slug):
        self.refresh()
        return ("%s.png" % slug) in self._names


# ---- pre-filter + forward --------------------------------------------------

def should_forward(event, bundled):
    """Cheap stateless gate (CONTRACT): conf >= AV_CONF AND not already bundled."""
    conf = event.get("conf")
    try:
        conf_f = float(conf)
    except (TypeError, ValueError):
        log.debug("drop %s: unparseable conf %r", event.get("slug"), conf)
        return False
    if conf_f < AV_CONF:
        log.debug("drop %s: conf %.4f < %.2f", event.get("slug"), conf_f, AV_CONF)
        return False
    slug = event.get("slug") or ""
    if not slug:
        log.debug("drop: empty slug")
        return False
    if bundled.contains(slug):
        log.debug("drop %s: already bundled", slug)
        return False
    return True


def post_detected(event):
    """POST one detection to Railway. FULLY GUARDED -- never raises."""
    if not AV_RAILWAY_BASE:
        log.debug("AV_RAILWAY_BASE unset; not forwarding %s", event.get("slug"))
        return
    url = AV_RAILWAY_BASE + "/detected"
    payload = {
        "sci": event.get("sci") or "",
        "com": event.get("com") or "",
        "slug": event.get("slug") or "",
        "conf": event.get("conf"),
        "cursor": event.get("cursor"),
    }
    try:
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                # CONTRACT "Auth (lite)": Bearer <WATCHER_WEBHOOK_SECRET>.
                "Authorization": "Bearer " + WATCHER_WEBHOOK_SECRET,
            },
        )
        resp = urllib.request.urlopen(req, timeout=POST_TIMEOUT)
        try:
            code = resp.getcode()
        finally:
            resp.close()
        log.info("forwarded %s (cursor=%s, conf=%s) -> %s",
                 payload["slug"], payload["cursor"], payload["conf"], code)
    except urllib.error.HTTPError as e:
        # 401/429 (unauth/over-rate) or any 4xx/5xx: log and move on.
        log.warning("POST /detected %s rejected: HTTP %s", payload["slug"], e.code)
    except Exception as e:
        # Down/slow Railway, DNS, timeout, etc. The collage degrades gracefully.
        log.warning("POST /detected %s failed: %s", payload["slug"], e)


# ---- reconcile sweep (missed-bird healer) ----------------------------------

def reconcile_once(bundled):
    """One catch-up sweep over birds.db: every species whose best-ever
    confidence clears AV_CONF and isn't bundled gets re-POSTed. FULLY GUARDED
    and idempotent -- Railway dedups done/queued/bundled species server-side,
    so the only real work is whatever the live stream missed."""
    if not AV_RAILWAY_BASE:
        return
    try:
        con = sqlite3.connect("file:%s?mode=ro" % AV_BIRDS_DB, uri=True, timeout=5)
    except Exception as e:
        log.warning("reconcile: cannot open %s read-only: %s", AV_BIRDS_DB, e)
        return
    try:
        rows = con.execute(
            "SELECT Sci_Name, Com_Name, MAX(Confidence) FROM detections "
            "GROUP BY Sci_Name"
        ).fetchall()
    except Exception as e:
        log.warning("reconcile: query failed: %s", e)
        return
    finally:
        con.close()

    posted = 0
    for sci, com, conf in rows:
        try:
            conf_f = float(conf)
        except (TypeError, ValueError):
            continue
        if conf_f < AV_CONF:
            continue
        slug = slugify(sci)
        if not slug or bundled.contains(slug):
            continue
        post_detected({
            "sci": sci or "",
            "com": com or "",
            "slug": slug,
            "conf": conf_f,
            "cursor": None,
        })
        posted += 1
        time.sleep(RECONCILE_POST_GAP)
    log.info("reconcile sweep done: %d/%d species posted", posted, len(rows))


def reconcile_loop(bundled):
    """Daemon-thread loop: first sweep shortly after start (heals anything
    missed while we were down), then every AV_RECONCILE_HOURS."""
    time.sleep(RECONCILE_FIRST_DELAY)
    while True:
        try:
            reconcile_once(bundled)
        except Exception as e:
            log.warning("reconcile sweep failed: %s", e)
        time.sleep(max(AV_RECONCILE_HOURS * 3600.0, 3600.0))


# ---- SSE parsing -----------------------------------------------------------

def iter_sse(resp):
    """Yield ``(event_name, data_str, event_id)`` for each SSE frame on ``resp``.

    Minimal SSE line parser (see W3C EventSource): blank line dispatches; ``:``
    lines are comments/keepalives; ``event``/``data``/``id`` fields recognised;
    multiple ``data`` lines are joined with newlines. ``event_id`` is per-frame
    (None when the frame carries no ``id:`` line -- birdcast omits ``id:`` on the
    ``hello`` frame)."""
    event_name = "message"
    data_lines = []
    event_id = None
    for raw in resp:
        try:
            line = raw.decode("utf-8")
        except Exception:
            continue
        line = line.rstrip("\n").rstrip("\r")
        if line == "":
            if data_lines:
                yield (event_name, "\n".join(data_lines), event_id)
            event_name = "message"
            data_lines = []
            event_id = None
            continue
        if line.startswith(":"):
            continue  # comment / keepalive (": ping")
        field, sep, value = line.partition(":")
        if sep and value.startswith(" "):
            value = value[1:]
        if field == "event":
            event_name = value
        elif field == "data":
            data_lines.append(value)
        elif field == "id":
            event_id = value
        # "retry" and unknown fields are ignored.


# ---- main loop -------------------------------------------------------------

def run():
    log.info(
        "forwarder starting: events=%s railway=%s conf>=%.2f illustrations=%s "
        "secret=%s",
        BIRDCAST_EVENTS,
        AV_RAILWAY_BASE or "(unset -- not forwarding)",
        AV_CONF,
        AV_ILLUSTRATIONS,
        "set" if WATCHER_WEBHOOK_SECRET else "UNSET",
    )
    if not AV_RAILWAY_BASE:
        log.warning("AV_RAILWAY_BASE is unset; consuming events but NOT forwarding")
    if not WATCHER_WEBHOOK_SECRET:
        log.warning("WATCHER_WEBHOOK_SECRET is unset; Railway will reject POSTs (401)")

    bundled = BundledSet(AV_ILLUSTRATIONS)

    if AV_RECONCILE_HOURS > 0:
        threading.Thread(
            target=reconcile_loop, args=(bundled,), name="reconcile", daemon=True
        ).start()
        log.info("reconcile sweep armed: first in %ds, then every %.1fh",
                 int(RECONCILE_FIRST_DELAY), AV_RECONCILE_HOURS)

    last_id = None
    backoff = BACKOFF_START

    while True:
        try:
            headers = {"Accept": "text/event-stream", "Cache-Control": "no-cache"}
            if last_id is not None:
                headers["Last-Event-ID"] = str(last_id)
            req = urllib.request.Request(BIRDCAST_EVENTS, headers=headers, method="GET")
            log.info("connecting to %s (Last-Event-ID=%s)", BIRDCAST_EVENTS, last_id)
            resp = urllib.request.urlopen(req, timeout=READ_TIMEOUT)
            connected_ok = False
            try:
                for name, data, eid in iter_sse(resp):
                    if not connected_ok:
                        # First frame proves a healthy connection -> reset backoff.
                        connected_ok = True
                        backoff = BACKOFF_START
                    if eid is not None:
                        last_id = eid
                    if name != "bird.detected":
                        continue
                    try:
                        event = json.loads(data)
                    except Exception as e:
                        log.warning("bad bird.detected JSON: %s", e)
                        continue
                    # Per-event guard: one bad event never breaks the stream.
                    try:
                        if should_forward(event, bundled):
                            post_detected(event)
                    except Exception as e:
                        log.warning("forward handling error: %s", e)
            finally:
                try:
                    resp.close()
                except Exception:
                    pass
            log.warning("SSE stream ended; reconnecting")
        except KeyboardInterrupt:
            raise
        except Exception as e:
            log.warning("SSE connection error: %s", e)

        time.sleep(backoff)
        backoff = min(BACKOFF_MAX, backoff * 2)


def main():
    logging.basicConfig(
        level=logging.DEBUG if os.environ.get("AV_VERBOSE") else logging.INFO,
        format="[%(name)s][%(levelname)s] %(message)s",
    )
    try:
        run()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
