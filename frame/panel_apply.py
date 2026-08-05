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
