"""The Wall panel's apply engine: a phone's request -> config surgery -> paint.

panel.html POSTs knob changes; PHP spools them at /run/birdframe/panel-request.json;
this module — driven by the buttons daemon's <=30s tick — validates the
request, performs TEXT surgery on ~/.birdframe/config.toml, arms a paint
through views.write_view (the same force channel the physical buttons use:
an unseen token always paints), and publishes what-the-wall-believes to
/run/birdframe/panel-state.json for the UI to read back. One-way pairs, no
privilege crossing: PHP only ever writes the request and reads the state;
only this daemon (user belkins) touches the config.

Deliberately NO tomllib on the write path: the config carries operator
comments and hand-laid structure that a parse/dump round-trip would destroy.
We rewrite exactly two top-level lines by regex and leave every other byte
alone. And stdlib only, like the rest of frame/: this must import on CI and
on any python >= 3.9.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import views  # noqa: E402

REQ_PATH = "/run/birdframe/panel-request.json"
STATE_PATH = "/run/birdframe/panel-state.json"

# The contract's resting values: what the panel shows when the config line is
# absent or a knob cannot be parsed out of it. Per KEY — one garbled param
# must not reset the five others.
DEFAULTS = {"zoom": 1.7, "budget": 0.95, "mintile": 0.009, "herocap": 0.32,
            "overlap": 0.3, "theme": "day"}

KNOB_KEYS = ("zoom", "budget", "mintile", "herocap", "overlap")
VIEW_NAMES = ("realtime", "today", "week", "all")

# key -> (lo, hi, lo_inclusive). The high end is inclusive across the board;
# only the low end differs: budget/mintile/herocap are open at zero because
# zero means "no flock at all" — a request for nothing is a mistake, not a
# composition.
RANGES = {
    "zoom": (1.0, 2.2, True),
    "budget": (0.0, 1.0, False),
    "mintile": (0.0, 0.03, False),
    "herocap": (0.0, 0.4, False),
    "overlap": (0.0, 0.5, True),
}

# Top-level lines only — anchored at line start so commented-out examples
# (# shoot_spa_path = ...) never match.
_SPA_LINE = re.compile(r'^shoot_spa_path\s*=\s*"([^"\n]*)"', re.MULTILINE)
_ZOOM_LINE = re.compile(r"^shoot_zoom\s*=\s*([^\s#]+)", re.MULTILINE)


def _split_at_first_table(text):
    """(head, tail): everything before the first ^[ table header, and the
    rest. The contract's lines are TOP-LEVEL — a [views.<name>] table may
    legally carry its own shoot_spa_path (it replaces the top-level string
    wholesale, config.example.toml warns), and that operator decision is not
    ours to read or rewrite."""
    m = re.search(r"^\[", text, re.MULTILINE)
    if not m:
        return text, ""
    return text[:m.start()], text[m.start():]


def _fmt(v):
    """repr of the float — '1.7' not '1.700000', '2.0' not '2'. Both the SPA
    (parseFloat) and display.py (float()) read these, and repr is the
    shortest string that round-trips."""
    return repr(float(v))


def current_knobs(cfg_text):
    """What the wall is resting on NOW, read from the config TEXT. Regex, not
    tomllib, so this stays symmetric with rewrite_config: the pair see the
    same lines. Anything absent or unparseable falls to the contract default
    for that one key — the merge base must always be complete, because
    validate() fills absent request keys from it."""
    out = dict(DEFAULTS)
    head, _ = _split_at_first_table(cfg_text or "")
    m = _SPA_LINE.search(head)
    if m:
        url = m.group(1)
        for key in ("budget", "mintile", "herocap", "overlap"):
            pm = re.search(r"[?&]%s=([^&]*)" % key, url)
            if pm:
                try:
                    out[key] = float(pm.group(1))
                except ValueError:
                    pass  # a garbled param: the default stands, alone
        tm = re.search(r"[?&]theme=([^&]*)", url)
        if tm and tm.group(1) in ("day", "night"):
            out["theme"] = tm.group(1)
    zm = _ZOOM_LINE.search(head)
    if zm:
        try:
            out["zoom"] = float(zm.group(1))
        except ValueError:
            pass
    return out


def validate(req, current):
    """Range-check a spooled request and merge it over `current`. Returns
    (merged, "") or (None, reason) — and None means the request is DELETED,
    never applied, never retried; the phone resubmits or it didn't matter.

    Absent knob keys keep their current value — the panel sends only what
    moved. The pair rule binds the MERGED values: a lone mintile request must
    still clear the herocap the wall is already running, or the packer would
    be told the rarest bird's floor sits above the hero's ceiling."""
    if not isinstance(req, dict):
        return None, "request is not an object"
    token = req.get("token")
    if not isinstance(token, str) or not token:
        return None, "token required"
    merged = dict(current)
    for key in KNOB_KEYS:
        if key not in req:
            continue
        v = req[key]
        # bool is an int in Python — true would sail through zoom's [1.0,2.2]
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return None, "%s is not a number" % key
        v = float(v)
        lo, hi, lo_incl = RANGES[key]
        if not ((v >= lo if lo_incl else v > lo) and v <= hi):
            return None, "%s=%s out of range" % (key, _fmt(v))
        merged[key] = v
    if "theme" in req:
        if req["theme"] not in ("day", "night"):
            return None, "theme %r not day|night" % (req["theme"],)
        merged["theme"] = req["theme"]
    merged["view"] = None
    if "view" in req:
        if req["view"] not in VIEW_NAMES:
            return None, "view %r unknown" % (req["view"],)
        merged["view"] = req["view"]
    if not merged["mintile"] < merged["herocap"]:
        return None, ("pair rule: mintile %s must be < herocap %s"
                      % (_fmt(merged["mintile"]), _fmt(merged["herocap"])))
    merged["token"] = token
    return merged, ""


def rewrite_config(cfg_text, merged):
    """TEXT SURGERY: replace (or insert) exactly two top-level lines and
    return the new text. Pure — text in, text out — so tests need no
    filesystem. Two traps live here, both pinned by tests:

      * SCOPE — only the head, before the first [table] header, is touched.
        A [views.<name>] table's own shoot_spa_path stays byte-identical.
      * INSERTION — a missing key goes BEFORE the first ^\\[ line. A TOML
        key appended after a table header silently joins that table (this
        trap has fired on this box), and the knob would then only apply to
        one button's view instead of the wall.

    win= must never appear in this path: display.py appends the window
    itself at shot time and the page reads the FIRST occurrence, so a baked
    win= would freeze every button to one window."""
    path = ("/collage/?surface=kiosk&theme=%s&motion=off&budget=%s"
            "&mintile=%s&herocap=%s&overlap=%s") % (
        merged["theme"], _fmt(merged["budget"]), _fmt(merged["mintile"]),
        _fmt(merged["herocap"]), _fmt(merged["overlap"]))
    wanted = (
        ("shoot_spa_path", 'shoot_spa_path = "%s"' % path),
        ("shoot_zoom", "shoot_zoom = %s" % _fmt(merged["zoom"])),
    )
    head, tail = _split_at_first_table(cfg_text)
    missing = []
    for key, line in wanted:
        pat = re.compile(r"^%s\s*=.*$" % key, re.MULTILINE)
        if pat.search(head):
            # replacement as a function: the URL's own characters must never
            # be reinterpreted as regex group escapes
            head = pat.sub(lambda m, line=line: line, head, count=1)
        else:
            missing.append(line)
    if missing:
        if head and not head.endswith("\n"):
            head += "\n"
        head += "".join(line + "\n" for line in missing)
    return head + tail


SHOT_SRC = "~/.birdframe/delivered.png"  # the composed post-everything image display.py saves after each successful push — NEVER shot.png, a shoot-path intermediate
SHOT_DEST = "/run/birdframe/last-shot.png"


def sync_last_shot(src=SHOT_SRC, dest=SHOT_DEST):
    """Mirror the wall's OWN last screenshot into the spool dir so the panel
    can show what the ink actually took — the preview's dice and the wall's
    dice roll independently, and only this image settles arguments. Copies
    only when the source mtime moved (a stat per tick, a copy per paint);
    /run is tmpfs so the ~300KB costs RAM, never the SD card."""
    try:
        src = os.path.expanduser(src)
        st = os.stat(src)
        try:
            if os.stat(dest).st_mtime >= st.st_mtime:
                return False
        except OSError:
            pass  # no mirror yet
        tmp = dest + ".tmp"
        with open(src, "rb") as fin, open(tmp, "wb") as fout:
            fout.write(fin.read())
        os.replace(tmp, dest)
        os.utime(dest, (st.st_mtime, st.st_mtime))
        return True
    except Exception:
        return False  # a missing shot must never disturb the tick


def publish_state(cfg_path, state_json_path, view_name, state_path=STATE_PATH):
    """Compose and atomically publish what the wall currently believes.
    Re-read fresh from the config FILE, not from the request that just
    landed — the UI must see the wall's truth, never an echo of its own
    optimism. last_refresh comes from display.py's state.json and is null
    until the frame has painted at least once (or on a fresh install where
    the file does not exist yet — absence must not crash the publisher)."""
    try:
        with open(os.path.expanduser(cfg_path)) as f:
            cfg_text = f.read()
    except OSError:
        cfg_text = ""
    knobs = current_knobs(cfg_text)
    last_refresh = None
    try:
        with open(os.path.expanduser(state_json_path)) as f:
            st = json.load(f)
        lr = st.get("last_refresh") if isinstance(st, dict) else None
        if isinstance(lr, (int, float)) and not isinstance(lr, bool):
            last_refresh = float(lr)
    except Exception:
        pass
    doc = {
        "knobs": {k: knobs[k] for k in KNOB_KEYS},
        "theme": knobs["theme"],
        "view": view_name,
        "last_refresh": last_refresh,
        "published_at": time.time(),
        # The Easter egg's shelf: ids only; thumbs stream via ?thumb=<id>.
        "gallery": list_gallery(),
    }
    tmp = state_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(doc, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, state_path)  # same atomic recipe as views.write_view
    return doc


def _drop(req_path):
    """Delete the spool file, tolerating a race. A request is consumed at
    most once; a file already gone just means someone got there first."""
    try:
        os.unlink(req_path)
    except OSError:
        pass


def consume(cfg_path, frame_state_path, view_file, ttl_hours,
            req_path=REQ_PATH, state_path=STATE_PATH):
    """One tick of the panel pipeline. No spool file -> None (the quiet,
    overwhelmingly common case). An invalid or unreadable request is logged
    and DELETED — never applied, never retried — and reported as
    "invalid: <reason>". A valid one rewrites the config atomically
    (tmp+rename, mode preserved), arms a paint via views.write_view (a fresh
    token is one guaranteed refresh — the same promise a button press
    makes), deletes the spool, publishes state, and returns
    "applied token=<client stamp>".

    NEVER raises: this runs inside the buttons daemon's loop, and an
    exception here would take the physical buttons down with it. Anything
    unexpected becomes an "error: ..." string for the journal."""
    try:
        if not os.path.exists(req_path):
            return None
        try:
            with open(req_path) as f:
                req = json.load(f)
        except Exception as e:
            _drop(req_path)
            reason = "request unreadable: %s" % e
            print("panel: dropped request (%s)" % reason, file=sys.stderr)
            return "invalid: %s" % reason
        cfg_path = os.path.expanduser(cfg_path)
        try:
            with open(cfg_path) as f:
                cfg_text = f.read()
        except OSError:
            # No config yet: surgery on empty text simply creates the lines.
            cfg_text = ""
        merged, reason = validate(req, current_knobs(cfg_text))
        if merged is None:
            _drop(req_path)
            print("panel: dropped request (%s)" % reason, file=sys.stderr)
            return "invalid: %s" % reason
        new_text = rewrite_config(cfg_text, merged)
        tmp = cfg_path + ".tmp"
        with open(tmp, "w") as f:
            f.write(new_text)
            f.flush()
            os.fsync(f.fileno())
        try:
            # stat the ORIGINAL before it is replaced; a first-ever config
            # has no mode to inherit and the umask default stands
            os.chmod(tmp, os.stat(cfg_path).st_mode & 0o7777)
        except OSError:
            pass
        os.replace(tmp, cfg_path)
        # Arm the paint through the buttons' own channel. Keep whichever
        # view is already showing unless the request names a new one; with
        # neither, Today — the wall's resting default.
        name = (merged["view"]
                or (views.read_view(view_file) or {}).get("view")
                or "today")
        views.write_view(view_file, name, ttl_hours)
        _drop(req_path)
        publish_state(cfg_path, frame_state_path, name, state_path)
        print("panel: applied token %s (view %s)" % (merged["token"], name))
        return "applied token=%s" % merged["token"]
    except Exception as e:
        # Drop the spool on the error path too: a request that provokes a
        # persistent failure must not re-fire every 30s forever (the seam
        # adversary's finding). A new browser POST overwrites the single
        # spool file anyway, so nothing is lost by discarding this one.
        _drop(req_path)
        return "error: %s" % e


# --- the gallery Easter egg ---------------------------------------------------
# A guest exhibit in the museum's frame: the panel uploads a photo, the daemon
# re-encodes it into ~/.birdframe/gallery/, and "showing" one is nothing more
# than the existing view system pointing the frame's IMAGE MODE at a symlink —
# display.py needs zero new code, and the 4h view TTL means a party photo
# quietly becomes birds again by morning. Same two-spool discipline as the
# knobs: PHP writes intent into /run/birdframe, this (the daemon, the config's
# only writer) validates and acts.

GALLERY_DIR = "~/.birdframe/gallery"
GALLERY_CURRENT = "~/.birdframe/gallery/current.png"
THUMBS_DIR = "/run/birdframe/thumbs"
GALLERY_UPLOAD = "/run/birdframe/gallery-upload.img"
GALLERY_REQ = "/run/birdframe/gallery-request.json"

# ids are daemon-assigned basenames; the charset pin is the traversal guard —
# an id like "../.ssh/x" or ".hidden" must die at validation, never at open().
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

GALLERY_VIEW_SECTION = (
    "\n# The gallery Easter egg's view: image mode, painted full-glass. Written\n"
    "# by panel_apply.ensure_gallery_view; the symlink names the chosen photo.\n"
    "[views.gallery]\n"
    "shoot = false\n"
    'image = "~/.birdframe/gallery/current.png"\n'
)


def ensure_gallery_view(cfg_text):
    """Idempotently append the [views.gallery] table. Appending at EOF is the
    ONE safe place for a table in text surgery — anywhere earlier and every
    key after the header would join the table (the trap that bit shoot_spa)."""
    if re.search(r"^\[views\.gallery\]", cfg_text, re.M):
        return cfg_text
    return cfg_text.rstrip("\n") + "\n" + GALLERY_VIEW_SECTION


def validate_gallery_request(req):
    """(action, id) or (None, reason). Strict: two actions, pinned charset."""
    if not isinstance(req, dict):
        return None, "not an object"
    unknown = set(req) - {"action", "id", "token"}
    if unknown:
        return None, "unknown keys: %s" % ",".join(sorted(unknown))
    action = req.get("action")
    if action not in ("show", "remove"):
        return None, "unknown action"
    gid = req.get("id")
    if not isinstance(gid, str) or not _ID_RE.match(gid) or gid == "current.png":
        return None, "bad id"
    if not isinstance(req.get("token"), str) or not req["token"]:
        return None, "token required"
    return {"action": action, "id": gid, "token": req["token"]}, ""


def list_gallery(gallery_dir=GALLERY_DIR):
    """Photo ids newest-first, excluding the current-symlink itself."""
    d = os.path.expanduser(gallery_dir)
    try:
        names = [n for n in os.listdir(d)
                 if n != "current.png" and _ID_RE.match(n)]
    except OSError:
        return []
    names.sort(key=lambda n: os.path.getmtime(os.path.join(d, n)), reverse=True)
    return names


def _thumb(src, gid, thumbs_dir=THUMBS_DIR):
    """A ~240px thumb into tmpfs for the panel to stream. PIL is imported
    lazily: it exists in the frame venv (display.py needs it) but not on CI,
    and a failed thumb must never fail the upload."""
    try:
        from PIL import Image
        os.makedirs(thumbs_dir, exist_ok=True)
        im = Image.open(src)
        im.thumbnail((240, 320))
        tmp = os.path.join(thumbs_dir, gid + ".tmp")
        im.convert("RGB").save(tmp, "PNG")
        os.replace(tmp, os.path.join(thumbs_dir, gid))
        return True
    except Exception:
        return False


def consume_gallery(cfg_path, view_file, ttl_hours,
                    upload_path=GALLERY_UPLOAD, req_path=GALLERY_REQ,
                    gallery_dir=GALLERY_DIR, thumbs_dir=THUMBS_DIR):
    """One tick of the gallery pipeline; returns an outcome string or None.
    Never raises — same survival contract as consume()."""
    import views  # sibling module; deferred so tests can import panel_apply alone
    try:
        # 1. An uploaded image waiting in the spool: verify it IS an image by
        # re-encoding through PIL (which also strips EXIF), then admit it.
        if os.path.exists(upload_path):
            gid = "g%d.png" % int(time.time())
            d = os.path.expanduser(gallery_dir)
            os.makedirs(d, exist_ok=True)
            dest = os.path.join(d, gid)
            try:
                from PIL import Image
                im = Image.open(upload_path)
                im = im.convert("RGB")
                tmp = dest + ".tmp"
                im.save(tmp, "PNG")
                os.replace(tmp, dest)
                _thumb(dest, gid, thumbs_dir)
                _drop(upload_path)
                return "gallery: admitted %s" % gid
            except Exception as e:
                _drop(upload_path)
                return "gallery: rejected upload (%s)" % e
        # 2. A show/remove request.
        if not os.path.exists(req_path):
            return None
        try:
            with open(req_path) as f:
                raw = json.load(f)
        except Exception:
            _drop(req_path)
            return "gallery: corrupt request dropped"
        req, reason = validate_gallery_request(raw)
        _drop(req_path)
        if req is None:
            return "gallery: invalid (%s)" % reason
        d = os.path.expanduser(gallery_dir)
        target = os.path.join(d, req["id"])
        cur = os.path.expanduser(GALLERY_CURRENT)
        if req["action"] == "remove":
            try:
                os.unlink(target)
            except OSError:
                pass
            try:
                os.unlink(os.path.join(thumbs_dir, req["id"]))
            except OSError:
                pass
            # If the wall was showing this photo, drop the symlink too — the
            # next paint of the gallery view fails soft (keeps last panel) and
            # the TTL brings the birds back.
            if os.path.islink(cur) and os.readlink(cur) == target:
                os.unlink(cur)
            return "gallery: removed %s" % req["id"]
        # show
        if not os.path.exists(target):
            return "gallery: no such photo %s" % req["id"]
        p = os.path.expanduser(cfg_path)
        with open(p) as f:
            cfg_text = f.read()
        new_text = ensure_gallery_view(cfg_text)
        if new_text != cfg_text:
            tmp = p + ".tmp"
            with open(tmp, "w") as f:
                f.write(new_text)
            os.replace(tmp, p)
        tmp_link = cur + ".tmp"
        try:
            os.unlink(tmp_link)
        except OSError:
            pass
        os.symlink(target, tmp_link)
        os.replace(tmp_link, cur)
        views.write_view(view_file, "gallery", ttl_hours)
        return "gallery: showing %s (token written)" % req["id"]
    except Exception as e:
        _drop(req_path)
        return "gallery: error %s" % e
