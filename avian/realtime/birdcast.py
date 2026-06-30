#!/usr/bin/env python3
"""birdcast -- the standalone realtime SSE spine for the bird collage.

A single-process asyncio service that:
  * receives detections via ``POST /emit`` from the guarded hook in
    ``scripts/utils/realtime.py`` (loopback only -- Caddy never proxies /emit),
  * fans them out as Server-Sent Events to every ``GET /events`` subscriber,
  * survives reconnects/restarts via the SQLite implicit ``rowid`` cursor:
    a client sends ``Last-Event-ID`` and we replay from an in-memory ring
    buffer, falling back to a READ-ONLY ``SELECT rowid,* FROM detections
    WHERE rowid > :since`` against birds.db.

Design constraints (Phase-0 refusals):
  * stdlib only -- no pip install. asyncio + a tiny hand-rolled HTTP/1.1
    parser. (PHP-FPM is wrong for never-closing SSE connections; one event
    loop holds hundreds of idle streams at near-zero cost.)
  * birds.db is opened READ-ONLY (``mode=ro``) with a busy_timeout. The schema
    and the detection writer are never touched.
  * Python 3.9+ compatible: no match statements, no ``X | Y`` runtime unions.
  * ``--mock`` runs with NO database on a dev Mac, synthesizing real species
    slugs derived from the illustration PNGs.

Endpoints:
  GET  /events   text/event-stream. Sends a one-shot ``hello`` frame with the
                 high-water cursor, optionally replays ``Last-Event-ID`` gaps,
                 then streams live ``bird.detected`` frames + ``:`` keepalives.
  POST /emit     ingest one detection (JSON). Assigns a cursor if absent,
                 stores in the ring buffer, broadcasts to all subscribers.
  GET  /health   tiny JSON liveness probe (subscribers, cursor, mode).

Run locally (no Pi):  python3 birdcast.py --mock --port 8099
"""

import argparse
import asyncio
import collections
import datetime
import json
import logging
import os
import re
import sqlite3

log = logging.getLogger("birdcast")

# ---- configuration ---------------------------------------------------------

RING_SIZE = 500              # in-memory replay buffer (last N events)
CLIENT_QUEUE_MAX = 100       # per-subscriber backpressure bound
KEEPALIVE_SECONDS = 15       # SSE comment heartbeat interval
MOCK_INTERVAL_SECONDS = 4.0  # cadence of synthetic detections in --mock

# Illustration assets used to derive plausible real slugs in --mock mode.
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
ILLUSTRATIONS_DIR = os.path.join(_THIS_DIR, "..", "assets", "illustrations")

# birds.db search order: explicit env var, then the two known locations.
_DB_CANDIDATES = [
    os.environ.get("AV_BIRDS_DB", ""),
    os.path.join(_THIS_DIR, "..", "..", "scripts", "birds.db"),
    os.path.expanduser("~/BirdNET-Pi/scripts/birds.db"),
]

# Detection table column order (scripts/createdb.sh). Used for the read-only
# rowid tail fallback. ``rowid`` is prepended by the SELECT.
_DET_COLUMNS = [
    "Date", "Time", "Sci_Name", "Com_Name", "Confidence",
    "Lat", "Lon", "Cutoff", "Week", "Sens", "Overlap", "File_Name",
]


def slugify(sci):
    """Identical to the Python/PHP/JS slug contract."""
    return re.sub(r"[^a-z0-9]+", "-", (sci or "").lower()).strip("-")


def resolve_db_path():
    """First existing birds.db from the candidate list, else None."""
    for p in _DB_CANDIDATES:
        if p and os.path.isfile(p):
            return os.path.abspath(p)
    return None


def open_db_ro(db_path):
    """Open birds.db READ-ONLY with a busy_timeout. Returns a connection or None."""
    if not db_path:
        return None
    try:
        con = sqlite3.connect(
            "file:%s?mode=ro" % db_path, uri=True, timeout=2.0,
            check_same_thread=False,
        )
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA busy_timeout=2000")
        return con
    except Exception as e:
        log.warning("could not open birds.db read-only (%s): %s", db_path, e)
        return None


def _iso_from_date_time(date_s, time_s):
    """Best-effort ISO8601 (with local offset) from DB Date/Time text."""
    try:
        dt = datetime.datetime.strptime("%s %s" % (date_s, time_s), "%Y-%m-%d %H:%M:%S")
        return dt.astimezone().isoformat()
    except Exception:
        return "%sT%s" % (date_s, time_s)


def _iso_week(date_s):
    try:
        dt = datetime.datetime.strptime(date_s, "%Y-%m-%d")
        return dt.isocalendar()[1]
    except Exception:
        return None


# ---- the service -----------------------------------------------------------

class Birdcast:
    def __init__(self, db_path=None, mock=False):
        self.db_path = db_path
        self.mock = mock
        self.ring = collections.deque(maxlen=RING_SIZE)   # list of event dicts
        self.subscribers = set()                          # set of asyncio.Queue
        self.high_water = 0                               # last assigned cursor
        self._mock_slugs = []
        self._mock_idx = 0
        if mock:
            self._mock_slugs = self._load_mock_slugs()
            self.high_water = 1000  # arbitrary base; mock has no real rowids
        else:
            self.high_water = self._seed_high_water()

    # -- seeding -----------------------------------------------------------

    def _seed_high_water(self):
        """High-water cursor = MAX(rowid) at startup (0 if no/empty DB)."""
        con = open_db_ro(self.db_path)
        if con is None:
            return 0
        try:
            row = con.execute("SELECT MAX(rowid) AS m FROM detections").fetchone()
            return int(row["m"]) if row and row["m"] is not None else 0
        except Exception as e:
            log.warning("seed high_water failed: %s", e)
            return 0
        finally:
            con.close()

    def _load_mock_slugs(self):
        """Derive real species slugs from the illustration PNG filenames."""
        slugs = []
        try:
            for fn in sorted(os.listdir(ILLUSTRATIONS_DIR)):
                if not fn.endswith(".png"):
                    continue
                base = fn[:-4]            # strip .png
                base = re.sub(r"-2$", "", base)  # strip the -2 alt pose
                if base and base not in slugs:
                    slugs.append(base)
        except Exception as e:
            log.warning("could not read illustrations dir: %s", e)
        if not slugs:
            # Safety net so --mock always produces something.
            slugs = ["cyanocitta-cristata", "turdus-migratorius", "cardinalis-cardinalis"]
        log.info("mock mode: %d species slugs loaded", len(slugs))
        return slugs

    # -- event construction ------------------------------------------------

    def normalize(self, raw, cursor):
        """Coerce an ingested payload into the full LOCKED bird.detected shape."""
        sci = raw.get("sci") or ""
        conf = raw.get("conf")
        conf_pct = raw.get("conf_pct")
        if conf_pct is None and conf is not None:
            try:
                conf_pct = round(float(conf) * 100)
            except Exception:
                conf_pct = None
        return {
            "v": 1,
            "type": "bird.detected",
            "cursor": cursor,
            "sci": sci,
            "com": raw.get("com") or "",
            "slug": raw.get("slug") or slugify(sci),
            "conf": conf,
            "conf_pct": conf_pct,
            "iso8601": raw.get("iso8601"),
            "date": raw.get("date"),
            "time": raw.get("time"),
            "week": raw.get("week"),
            "file": raw.get("file") or "",
        }

    def event_from_db_row(self, row):
        """Build a bird.detected event from a read-only detections row."""
        sci = row["Sci_Name"]
        try:
            conf = round(float(row["Confidence"]), 4)
        except Exception:
            conf = row["Confidence"]
        try:
            conf_pct = round(float(row["Confidence"]) * 100)
        except Exception:
            conf_pct = None
        try:
            week = int(row["Week"])
        except Exception:
            week = _iso_week(row["Date"])
        return {
            "v": 1,
            "type": "bird.detected",
            "cursor": int(row["rowid"]),
            "sci": sci,
            "com": row["Com_Name"],
            "slug": slugify(sci),
            "conf": conf,
            "conf_pct": conf_pct,
            "iso8601": _iso_from_date_time(row["Date"], row["Time"]),
            "date": row["Date"],
            "time": row["Time"],
            "week": week,
            "file": row["File_Name"],
        }

    # -- ingest + broadcast ------------------------------------------------

    def ingest(self, raw):
        """Assign a cursor, store in the ring, broadcast. Returns the event."""
        cursor = raw.get("cursor")
        if cursor is None:
            self.high_water += 1
            cursor = self.high_water
        else:
            try:
                cursor = int(cursor)
                self.high_water = max(self.high_water, cursor)
            except Exception:
                self.high_water += 1
                cursor = self.high_water
        event = self.normalize(raw, cursor)
        self.ring.append(event)
        self._broadcast(event)
        return event

    def _broadcast(self, event):
        for q in list(self.subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                # Slow/stalled client: drop this frame for them. They recover
                # via Last-Event-ID replay on reconnect. Never block the loop.
                log.debug("dropping frame for a full subscriber queue")

    # -- replay ------------------------------------------------------------

    def collect_replay(self, since):
        """Events with cursor > since: ring buffer first, DB tail for the gap."""
        if self.ring and self.ring[0]["cursor"] <= since + 1:
            # Ring fully covers the requested range -- no DB hit.
            return [e for e in self.ring if e["cursor"] > since]

        out = []
        last = since
        # Gap below the ring: fill from the read-only DB tail.
        for ev in self._db_tail(since):
            out.append(ev)
            last = ev["cursor"]
        # Append anything newer the ring already holds (avoids duplicates).
        for e in self.ring:
            if e["cursor"] > last:
                out.append(e)
        return out

    def _db_tail(self, since):
        """READ-ONLY SELECT rowid,* FROM detections WHERE rowid > :since."""
        if self.mock or not self.db_path:
            return []
        con = open_db_ro(self.db_path)
        if con is None:
            return []
        events = []
        try:
            sql = (
                "SELECT rowid AS rowid, " + ", ".join(_DET_COLUMNS) +
                " FROM detections WHERE rowid > :since ORDER BY rowid ASC LIMIT 2000"
            )
            for row in con.execute(sql, {"since": since}):
                events.append(self.event_from_db_row(row))
        except Exception as e:
            log.warning("db tail failed: %s", e)
        finally:
            con.close()
        return events

    # -- subscriber lifecycle ---------------------------------------------

    def add_subscriber(self):
        q = asyncio.Queue(maxsize=CLIENT_QUEUE_MAX)
        self.subscribers.add(q)
        return q

    def remove_subscriber(self, q):
        self.subscribers.discard(q)


# ---- SSE / HTTP framing ----------------------------------------------------

def sse_frame(event_name, data_obj, event_id=None):
    lines = ["event: " + event_name]
    if event_id is not None:
        lines.append("id: " + str(event_id))
    lines.append("data: " + json.dumps(data_obj, ensure_ascii=False, separators=(",", ":")))
    return ("\n".join(lines) + "\n\n").encode("utf-8")


def http_response(status, headers, body=b""):
    reason = {200: "OK", 400: "Bad Request", 404: "Not Found",
              405: "Method Not Allowed", 500: "Internal Server Error"}.get(status, "OK")
    head = "HTTP/1.1 %d %s\r\n" % (status, reason)
    for k, v in headers.items():
        head += "%s: %s\r\n" % (k, v)
    head += "\r\n"
    return head.encode("utf-8") + body


async def _read_request(reader):
    """Parse the request line + headers. Returns (method, path, headers) or None."""
    try:
        raw = await reader.readuntil(b"\r\n\r\n")
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionResetError):
        return None
    try:
        text = raw.decode("iso-8859-1")
    except Exception:
        return None
    lines = text.split("\r\n")
    parts = lines[0].split(" ")
    if len(parts) < 2:
        return None
    method, target = parts[0], parts[1]
    headers = {}
    for line in lines[1:]:
        if not line or ":" not in line:
            continue
        k, v = line.split(":", 1)
        headers[k.strip().lower()] = v.strip()
    return method, target, headers


def _split_path(target):
    path = target.split("?", 1)[0]
    return path


class Handler:
    def __init__(self, service):
        self.service = service

    async def __call__(self, reader, writer):
        peer = writer.get_extra_info("peername")
        try:
            req = await _read_request(reader)
            if req is None:
                writer.close()
                return
            method, target, headers = req
            path = _split_path(target)

            if method == "GET" and path == "/events":
                await self._handle_events(reader, writer, headers)
            elif method == "POST" and path == "/emit":
                await self._handle_emit(reader, writer, headers)
            elif method == "GET" and path in ("/health", "/healthz"):
                await self._handle_health(writer)
            else:
                writer.write(http_response(
                    404, {"Content-Type": "application/json", "Connection": "close"},
                    b'{"error":"not found"}'))
                await writer.drain()
                writer.close()
        except (ConnectionResetError, BrokenPipeError):
            pass
        except Exception as e:
            log.debug("handler error from %s: %s", peer, e)
            try:
                writer.close()
            except Exception:
                pass

    async def _handle_health(self, writer):
        body = json.dumps({
            "ok": True,
            "mode": "mock" if self.service.mock else "live",
            "subscribers": len(self.service.subscribers),
            "cursor": self.service.high_water,
            "ring": len(self.service.ring),
        }).encode("utf-8")
        writer.write(http_response(200, {
            "Content-Type": "application/json",
            "Content-Length": str(len(body)),
            "Connection": "close",
            "Access-Control-Allow-Origin": "*",
        }, body))
        await writer.drain()
        writer.close()

    async def _handle_emit(self, reader, writer, headers):
        length = 0
        try:
            length = int(headers.get("content-length", "0"))
        except ValueError:
            length = 0
        body = b""
        if length > 0:
            try:
                body = await reader.readexactly(length)
            except asyncio.IncompleteReadError as e:
                body = e.partial
        try:
            raw = json.loads(body.decode("utf-8")) if body else {}
        except Exception:
            writer.write(http_response(
                400, {"Content-Type": "application/json", "Connection": "close"},
                b'{"error":"invalid json"}'))
            await writer.drain()
            writer.close()
            return

        event = self.service.ingest(raw)
        resp = json.dumps({"ok": True, "cursor": event["cursor"]}).encode("utf-8")
        writer.write(http_response(200, {
            "Content-Type": "application/json",
            "Content-Length": str(len(resp)),
            "Connection": "close",
        }, resp))
        await writer.drain()
        writer.close()

    async def _handle_events(self, reader, writer, headers):
        # SSE response headers. ``X-Accel-Buffering: no`` + Caddy's
        # flush_interval -1 keep frames un-buffered end to end.
        writer.write(http_response(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            # LAN-dev convenience: lets a Vite dev server on another host (your Mac)
            # subscribe during Phase-0 testing. RESTRICT/REMOVE before any public exposure.
            "Access-Control-Allow-Origin": "*",
        }))
        await writer.drain()

        # 1) one-shot hello with the current high-water cursor.
        writer.write(sse_frame("hello", {
            "v": 1, "type": "hello", "cursor": self.service.high_water,
        }))
        await writer.drain()

        # 2) optional reconnect replay.
        last_id = headers.get("last-event-id")
        if last_id is not None:
            try:
                since = int(last_id)
            except (TypeError, ValueError):
                since = None
            if since is not None:
                for ev in self.service.collect_replay(since):
                    writer.write(sse_frame("bird.detected", ev, event_id=ev["cursor"]))
                await writer.drain()

        # 3) live stream from this subscriber's queue + keepalives.
        q = self.service.add_subscriber()
        try:
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=KEEPALIVE_SECONDS)
                except asyncio.TimeoutError:
                    # Keepalive comment doubles as dead-connection detection:
                    # drain() raises once the client has gone away.
                    writer.write(b": ping\n\n")
                    await writer.drain()
                    continue
                writer.write(sse_frame("bird.detected", ev, event_id=ev["cursor"]))
                await writer.drain()
        except (ConnectionResetError, BrokenPipeError, asyncio.CancelledError):
            pass
        finally:
            self.service.remove_subscriber(q)
            try:
                writer.close()
            except Exception:
                pass


# ---- mock generator --------------------------------------------------------

async def mock_producer(service):
    """Synthesize a plausible bird.detected every MOCK_INTERVAL_SECONDS."""
    import random
    while True:
        await asyncio.sleep(MOCK_INTERVAL_SECONDS)
        if not service._mock_slugs:
            continue
        slug = service._mock_slugs[service._mock_idx % len(service._mock_slugs)]
        service._mock_idx += 1
        sci = slug.replace("-", " ")
        sci = sci[:1].upper() + sci[1:]
        com = " ".join(w.capitalize() for w in slug.split("-"))
        now = datetime.datetime.now().astimezone()
        conf = round(random.uniform(0.70, 0.99), 4)
        com_safe = com.replace("'", "").replace(" ", "_")
        conf_pct = round(conf * 100)
        time_s = now.strftime("%H:%M:%S")
        date_s = now.strftime("%Y-%m-%d")
        raw = {
            "sci": sci,
            "com": com,
            "slug": slug,
            "conf": conf,
            "conf_pct": conf_pct,
            "iso8601": now.isoformat(),
            "date": date_s,
            "time": time_s,
            "week": now.isocalendar()[1],
            "file": "%s-%d-%s-birdnet-%s.mp3" % (com_safe, conf_pct, date_s, time_s),
        }
        ev = service.ingest(raw)
        log.info("mock emit cursor=%s %s (%s)", ev["cursor"], ev["com"], ev["slug"])


# ---- entrypoint ------------------------------------------------------------

async def run(host, port, mock):
    db_path = None if mock else resolve_db_path()
    if not mock and db_path is None:
        log.warning("birds.db not found; live reconnect DB-tail fallback disabled "
                    "(events still flow from POST /emit + ring buffer)")
    service = Birdcast(db_path=db_path, mock=mock)
    log.info("birdcast starting on %s:%d (mode=%s, db=%s, high_water=%d)",
             host, port, "mock" if mock else "live", db_path, service.high_water)

    handler = Handler(service)
    server = await asyncio.start_server(handler, host, port)

    tasks = []
    if mock:
        tasks.append(asyncio.ensure_future(mock_producer(service)))

    async with server:
        await server.serve_forever()
    for t in tasks:
        t.cancel()


def main():
    ap = argparse.ArgumentParser(description="birdcast realtime SSE service")
    ap.add_argument("--host", default="127.0.0.1", help="bind host (default 127.0.0.1)")
    ap.add_argument("--port", type=int, default=8090, help="bind port (default 8090)")
    ap.add_argument("--mock", action="store_true",
                    help="synthesize detections from illustration slugs (no DB)")
    ap.add_argument("--verbose", action="store_true", help="debug logging")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="[%(name)s][%(levelname)s] %(message)s",
    )
    try:
        asyncio.run(run(args.host, args.port, args.mock))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
