#!/usr/bin/env python3
"""The four Inky buttons -> the wall changes its window.

    A (top)  Real time      the last hour, what is singing NOW
    B        Today          24 hours
    C        This Week      7 days
    D        All Time       the whole collection

Pressing the button of the view already showing repaints it fresh — every
press writes a new token, and an unseen token always paints. Each press
writes ~/.birdframe/view.json and starts birdframe.service; the fresh token
makes display.py paint immediately (the --force bypasses). A pressed view
expires after view_ttl_hours (default 4) back to the config's resting view.
A Spectra 6 refresh is ~30s of colour theatre — a press is a ceremony, not
a click; presses during a paint are absorbed and reconciled after it.

gpiod/gpiodevice are imported inside main() so this module imports cleanly
on CI and on boxes with no GPIO; the pin map and choose_view() are pure and
tested in tests/test_buttons_views.py.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import views  # noqa: E402

# 13.3" Impression, top to bottom. C is GPIO25 ON THE 13.3" — it is 16 on the
# smaller Impressions, and Pimoroni's own examples/spectra6/buttons.py carries
# the warning. Every button names a view — "repaint now" is any button's
# second press (a fresh token always paints).
PIN_A, PIN_B, PIN_C, PIN_D = 5, 6, 25, 24
VIEW_BY_PIN = {PIN_A: "realtime", PIN_B: "today", PIN_C: "week", PIN_D: "all"}
LABEL = {PIN_A: "A", PIN_B: "B", PIN_C: "C", PIN_D: "D"}

DEBOUNCE_S = 0.35     # tactile switch chatter, not human intent
RECONCILE_S = 30      # idle sweep: deliver tokens absorbed during a paint
MAX_RETRIGGERS = 2    # per token; after that the 15-min timer owns it


def choose_view(pin, current):
    """The view a press lands on. Every mapped pin names its view outright;
    an unmapped pin (a future board revision, a stray offset) falls back to
    whatever is showing — or Today — rather than crashing the daemon."""
    name = VIEW_BY_PIN.get(pin)
    if name is None:
        return current or "today"
    return name


def load_frame_cfg(path="~/.birdframe/config.toml"):
    """Only the keys this daemon needs; missing/broken config means the same
    defaults display.py would use, never a crash."""
    import tomllib
    try:
        with open(os.path.expanduser(path), "rb") as f:
            c = tomllib.load(f)
    except Exception:
        c = {}
    return {
        "view_file": c.get("view_file", views.VIEW_FILE_DEFAULT),
        "ttl": c.get("view_ttl_hours", 4),
        "state": c.get("state", "~/.birdframe/state.json"),
    }


def trigger_paint(frame_dir):
    """Start the paint through systemd so the co-tenant caps apply; where
    passwordless sudo does not exist (a standalone frame Pi), fall back to a
    direct run with the same venv python — the token in view.json is the
    force channel either way."""
    r = subprocess.run(
        ["sudo", "-n", "systemctl", "start", "--no-block", "birdframe.service"],
        capture_output=True,
    )
    if r.returncode == 0:
        return "systemd"
    subprocess.Popen(
        [sys.executable, os.path.join(frame_dir, "display.py"),
         "--config", os.path.expanduser("~/.birdframe/config.toml")],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    return "direct"


def paint_in_flight():
    r = subprocess.run(["systemctl", "is-active", "--quiet", "birdframe.service"])
    return r.returncode == 0


def unconsumed_token(cfg):
    """The token display.py has not painted yet, or None. Reads state.json
    directly rather than importing display: this daemon must not drag PIL in."""
    doc = views.read_view(cfg["view_file"])
    if not doc:
        return None
    try:
        with open(os.path.expanduser(cfg["state"])) as f:
            st = json.load(f)
    except Exception:
        st = {}
    return doc["token"] if doc["token"] != st.get("view_token") else None


def main():
    import gpiod
    import gpiodevice
    from gpiod.line import Bias, Direction, Edge

    frame_dir = os.path.dirname(os.path.abspath(__file__))
    cfg = load_frame_cfg()

    chip = gpiodevice.find_chip_by_platform()
    offsets = {chip.line_offset_from_id(pin): pin for pin in VIEW_BY_PIN}
    settings = gpiod.LineSettings(direction=Direction.INPUT, bias=Bias.PULL_UP,
                                  edge_detection=Edge.FALLING)
    request = chip.request_lines(consumer="birdframe-buttons",
                                 config=dict.fromkeys(offsets, settings))
    print(f"listening: A={PIN_A} B={PIN_B} C={PIN_C} D={PIN_D} "
          f"(view file {cfg['view_file']}, ttl {cfg['ttl']}h)")

    last_press = dict.fromkeys(VIEW_BY_PIN, 0.0)
    retriggers = {}  # token -> attempts, so a failing paint cannot be hammered

    while True:
        if request.wait_edge_events(RECONCILE_S):
            for event in request.read_edge_events():
                pin = offsets.get(event.line_offset)
                if pin is None:
                    continue
                now = time.monotonic()
                if now - last_press[pin] < DEBOUNCE_S:
                    continue
                last_press[pin] = now
                current = (views.read_view(cfg["view_file"]) or {}).get("view")
                name = choose_view(pin, current)
                doc = views.write_view(cfg["view_file"], name, cfg["ttl"])
                mode = trigger_paint(frame_dir)
                print(f"button {LABEL[pin]}: view '{name}' "
                      f"token {doc['token']} -> paint via {mode}")
        else:
            # Idle sweep: a press that landed mid-paint left its token
            # unconsumed. Deliver it now that the panel is free — a couple of
            # times; beyond that the 15-minute timer owns the retry so a
            # broken shooter is not relaunched every 30 seconds.
            token = unconsumed_token(cfg)
            if token and not paint_in_flight():
                n = retriggers.get(token, 0)
                if n < MAX_RETRIGGERS:
                    retriggers = {token: n + 1}  # forget older tokens
                    mode = trigger_paint(frame_dir)
                    print(f"reconcile: token {token} attempt {n + 1} via {mode}")


if __name__ == "__main__":
    main()
