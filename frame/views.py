"""View registry + the button-override file for the e-ink frame.

The four Inky buttons (buttons.py) write ~/.birdframe/view.json —
{"view", "token", "until"} — and display.py reads it on every tick,
overlays the named view onto the config, and treats an unseen token as an
operator's finger on the hardware: paint NOW, with the same bypasses as
--force. The file carries its own expiry so a whim view reverts to the
wall's configured default without anyone remembering to press A.

Stdlib only, deliberately: frame/tests runs on CI where neither gpiod nor
PIL exists, and buttons.py must stay importable on any box.
"""
from __future__ import annotations

import json
import os
import sys
import time

# The wall's vocabulary: each view is a config OVERLAY. `hours` drives BOTH
# the signature poll and the shot's window (legacy: shoot(window_hours=...);
# SPA: &win= on the URL), so the caption can never name a window the collage
# does not show — the same one-source rule as web/src/window.ts. 1_000_000 is
# the SPA's own ALL sentinel; the API already receives it from every ALL chip.
# Four views, one per button (Vlad's mapping, 2026-08-05): hours is EXPLICIT
# even for today so a button always means the same window regardless of what
# the config's resting `hours` is set to.
VIEWS = {
    "realtime": {"hours": 1, "shoot_subtitle": "This Hour"},
    "today": {"hours": 24, "shoot_subtitle": "Heard Today"},
    "week": {"hours": 168, "shoot_subtitle": "Heard This Week"},
    "all": {"hours": 1_000_000, "shoot_subtitle": "All Time"},
}

VIEW_FILE_DEFAULT = "~/.birdframe/view.json"


def merged_views(cfg):
    """Built-ins, with any operator [views.<name>] tables laid over them —
    per key, so `[views.week] hours = 72` changes the window and keeps the
    built-in subtitle. New names define new views."""
    out = {k: dict(v) for k, v in VIEWS.items()}
    for name, table in (cfg.get("views") or {}).items():
        if isinstance(table, dict):
            out.setdefault(name, {}).update(table)
    return out


def write_view(path, view, ttl_hours, now=None, token=None):
    """Atomically write the override. The token is the force channel: display
    compares it against state.json's last-consumed token, so every write is
    one guaranteed paint even when the view name does not change (button D)."""
    now = time.time() if now is None else now
    path = os.path.expanduser(path)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    doc = {
        "view": view,
        "token": token if token is not None else f"{now:.6f}",
        "until": now + ttl_hours * 3600,
    }
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(doc, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)  # same atomic recipe as display.save_state
    return doc


def read_view(path, now=None):
    """The active override, or None. Absent, corrupt, incomplete and expired
    all mean None: the wall FALLS BACK to its configured default. A bad file
    must never strand the panel on a stale view — failing here fails to
    Today, not to darkness."""
    now = time.time() if now is None else now
    try:
        with open(os.path.expanduser(path)) as f:
            doc = json.load(f)
        if not isinstance(doc, dict):
            return None
        view, token, until = doc.get("view"), doc.get("token"), doc.get("until")
        if not isinstance(view, str) or not view or token in (None, ""):
            return None
        if not isinstance(until, (int, float)) or now >= until:
            return None
        return {"view": view, "token": str(token)}
    except Exception:
        return None


def resolve(cfg, now=None):
    """Overlay the active button view onto cfg. Returns (cfg, token) — token
    is None when no override applies. An unknown view name is ignored, not
    fatal: an old file naming a deleted view must not take the wall down."""
    doc = read_view(cfg.get("view_file", VIEW_FILE_DEFAULT), now)
    if not doc:
        return cfg, None
    table = merged_views(cfg).get(doc["view"])
    if table is None:
        print(f"view.json names unknown view {doc['view']!r}; ignoring", file=sys.stderr)
        return cfg, None
    out = dict(cfg)
    out.update(table)
    print(f"button view active: {doc['view']}")
    return out, doc["token"]
