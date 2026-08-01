#!/usr/bin/env python3
"""Frame-freshness watchdog: alert when the wall stops repainting.

display.py keeps the last panel image and exits 0 on EVERY recoverable failure
-- a failed signature fetch (display.py:336), a failed capture (display.py:354),
a failed panel push (display.py:367) -- because a blank wall is worse than a
stale one. That is deliberate, and it means `systemctl is-failed birdframe` can
NEVER see a frozen frame: the unit succeeds while the picture rots. Only the
timestamps can see it, so this unit reads the two the frame actually writes:

  1. capture -- the local PNG the INSTALLED ExecStart rewrites each refresh
                (<cache>/shot.png in local mode, <cache>/frame.png in
                BirdWeather mode, where install.sh:162 passes the path on the
                command line and it never appears in config.toml at all). This
                leg NEVER declares death on its own: it names the ROOT CAUSE of
                a death last_refresh has already declared, so the operator
                knows whether to debug the shooter or the panel push. A capture
                file that does not exist is UNKNOWABLE -- an image-mode frame
                writes none at all -- never evidence.
  2. panel   -- `last_refresh` in state.json, written ONLY after push_panel
                succeeds (display.py:369). That is the one timestamp meaning
                "the wall got new pixels", and the only one allowed to declare
                the frame dead.

The captured PNG is NEVER hashed. A byte-identical capture is what a quiet
garden and the 24h heal repaint both legitimately produce; alerting on
unchanged bytes would fire on a healthy frame and poison the SAME ntfy topic
that carries the mic and Railway alerts (mic_watch.py:20 -- a quiet night must
never be called dead). Dead-mic detection is mic_watch's job, not this one's.

Unknowable counts as HEALTHY, but ONLY where nothing can be known: no
systemctl (a dev box), a disabled birdframe.timer (operator intent), no capture
file on disk. On a box that IS the frame, silence is not innocence -- a deleted
config.toml, a config.toml that will not parse, and a birdframe.timer systemd
cannot answer for are all POSITIVE evidence and alert. frame-watch.service
therefore carries NO ConditionPathExists on config.toml: systemd treats an
unmet condition as a successful no-op (job result `done`, unit inactive), which
would have made the deleted-config case invisible in the one unit written to
see it.

Honest limit, stated rather than implied: shot.png's mtime says the shooter
RAN, not that it SUCCEEDED -- shoot.py screenshots in place, so a blank or
half-painted capture refreshes the mtime and reads healthy on both legs. This
watchdog sees a FROZEN wall, never a WRONG one.

RTC-less Pi note: a cold boot before NTP can make every file look ancient.
birdframe.timer fires at OnBootSec=2min and its heal branch rewrites both
timestamps long before frame-watch.timer's OnBootSec=20min, and
FAIL_THRESHOLD=2 adds another hour on top. Do not "fix" that by widening the
budget.

Runs on whichever box hosts the panel, beside display.py — a dedicated frame
Pi, or the station Pi itself (the live install since 2026-08). Only this box
can see ~/.birdframe/state.json, so the freshness check lives here. Exit 0 =
healthy or unknowable, 1 = a fault (exactly one ntfy push once FAIL_THRESHOLD
consecutive ticks agree, and one recovery notice when it comes back).

Config via env (EnvironmentFile):
  BIRDFRAME_CONF     (optional) frame config (default ~/.birdframe/config.toml)
  FRAME_WATCH_STATE  (optional) state file (default ~/.birdframe/frame-watch.state)
  NOTIFY_URL         (optional) ntfy topic POSTed on state change -- the SAME
                                var mic_watch, railway_liveness and
                                weekly_digest read. Never a second channel.
  FAIL_THRESHOLD     (optional) consecutive stale ticks before the single alert
                                (default 2)
  STALE_SECS         (optional) staleness floor in seconds (default 108000 =
                                30h); effective budget is
                                max(STALE_SECS, heal_hours*3600 + quiet window + 1h)
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from datetime import datetime

try:
    import tomllib
except ModuleNotFoundError:  # Python < 3.11 (Pi OS Bullseye): tomli from the frame venv
    import tomli as tomllib

CONF = os.path.expanduser(os.environ.get("BIRDFRAME_CONF", "~/.birdframe/config.toml"))
NOTIFY = os.environ.get("NOTIFY_URL", "").strip()
STATE = os.path.expanduser(os.environ.get("FRAME_WATCH_STATE", "~/.birdframe/frame-watch.state"))
THRESH = int(os.environ.get("FAIL_THRESHOLD", "2"))
STALE_SECS = int(os.environ.get("STALE_SECS", "108000"))
SLACK = 3600  # 15min timer granularity + min_refresh_minutes + a couple of retried runs

# These contracts are LOCKED -- they MIRROR frame/display.py:41-67 and if they
# change there they must change here too (tests/test_frame_watch.py parses
# display.py as TEXT and fails if a key stops existing). Copied rather than
# imported on purpose: display.py imports PIL at module top, and a watchdog that
# cannot start when the panel library is broken is not a watchdog. Drift can
# only make the budget MORE conservative, never a false alarm.
FRAME_DEFAULTS = {"state": "~/.birdframe/state.json", "cache": "~/.birdframe", "image": "",
                  "image_url": "", "shoot": False, "heal_hours": 24, "quiet_start": 0, "quiet_end": 0}


def read_conf():
    """(cfg, 'ok'|'missing'|'unreadable'). Loads the frame's OWN config.toml --
    the same file display.py runs from -- so the budget follows the operator's
    actual cadence. The status is returned, never swallowed: on a frame Pi a
    config that is gone or will not parse is a fault, not a quiet default."""
    cfg = dict(FRAME_DEFAULTS)
    if not os.path.isfile(CONF):
        return cfg, "missing"
    try:
        with open(CONF, "rb") as f:
            cfg.update(tomllib.load(f))
    except Exception as e:
        print(f"could not read {CONF}: {e}", flush=True)
        return cfg, "unreadable"
    return cfg, "ok"


def frame_mode(path):
    """'local' | 'image' | 'birdweather' | '' -- the marker install.sh writes at
    the top of config.toml and parses back itself (install.sh:108). It is the
    only record of WHICH ExecStart is installed, and in BirdWeather mode the
    capture path exists nowhere else: install.sh:162 passes
    `--out $HOME/.birdframe/frame.png` on the command line."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                m = re.match(r"^#\s*birdframe-mode:\s*(\S+)", line)
                if m:
                    return m.group(1)
    except OSError:
        pass
    return ""


def capture_path(cfg, mode=""):
    """The local file the installed ExecStart rewrites each refresh, or None
    when there is nothing local to stat.

    Derived from what install.sh ACTUALLY produces, not from config.toml alone:
    BirdWeather installs before 2026-08 shipped config.example.toml verbatim
    (shoot = true — the trap that made the mode screenshot a nonexistent
    birdnet.local; fixed installs write shoot = false) while writing
    ~/.birdframe/frame.png, so trusting `shoot` would stat a shot.png nothing
    ever creates on those boxes. Whichever candidate EXISTS wins — that covers
    both config generations; when none exists the leg is skipped, because a
    missing capture file is unknowable (image mode has none by design) and
    only state.json may declare the frame dead."""
    src = cfg.get("image_url") or cfg.get("image")
    if src and re.match(r"^https?://", src):
        return None  # image mode: this box fetches, it never writes a capture
    names = ["frame.png", "shot.png"] if mode == "birdweather" else ["shot.png", "frame.png"]
    cache = os.path.expanduser(cfg.get("cache") or FRAME_DEFAULTS["cache"])
    cands = ([os.path.expanduser(src)] if src else []) + [os.path.join(cache, n) for n in names]
    for p in cands:
        if os.path.exists(p):
            return p
    return None


def _sysctl(*args):
    """(text, ok). ok is False when systemctl itself could not answer -- it
    raised, timed out, or exited non-zero. Collapsing that into an empty string
    is what made every systemd failure read as 'dev box, nothing to see'."""
    try:
        p = subprocess.run(["systemctl", *args], capture_output=True, text=True, timeout=10)
    except Exception as e:
        return f"{e}", False
    return p.stdout, p.returncode == 0


def frame_timer():
    """(status, detail) for birdframe.timer, where status is:
      'unknown'  -- no systemctl at all (a dev box / a Mac). The ONLY unknowable.
      'missing'  -- systemd cannot show the unit: uninstalled, renamed, or the
                    query errored/timed out. On a box with a config.toml that is
                    POSITIVE evidence, not ignorance.
      'disabled' -- operator intent (mic_watch's doctrine), freshness skipped.
      'inactive' -- enabled but not active: masked or failed to start. mic_watch
                    treats exactly this as recorder_stalled; so do we.
      'enabled'  -- enabled and active; run the freshness legs."""
    if shutil.which("systemctl") is None:
        return "unknown", "no systemctl on this box (dev machine); freshness checks skipped"
    out, ok = _sysctl("list-unit-files", "birdframe.timer")
    if not ok:
        return "missing", f"systemctl could not answer for birdframe.timer ({out.strip()[:120]})"
    if "birdframe.timer" not in out:
        return "missing", "birdframe.timer is not installed on this box"
    if _sysctl("is-enabled", "birdframe.timer")[0].strip() != "enabled":
        return "disabled", "birdframe.timer is disabled -- operator intent, freshness checks skipped"
    if _sysctl("is-active", "birdframe.timer")[0].strip() != "active":
        return "inactive", "birdframe.timer is enabled but NOT active (masked, or it failed to start)"
    return "enabled", "birdframe.timer enabled and active"


def _hours(cfg, key):
    """A config hour as an int, falling back to the mirrored default. Mirrors
    display.py's keys; coerced because a hand-edited config.toml with a string
    here must not crash the one unit that reports the frame is dead."""
    try:
        return int(cfg.get(key, FRAME_DEFAULTS[key]))
    except (TypeError, ValueError):
        return int(FRAME_DEFAULTS[key])


def in_quiet_hours(cfg, hour):
    """display.py:300-304, mirrored (see FRAME_DEFAULTS for why it is copied)."""
    s, e = _hours(cfg, "quiet_start"), _hours(cfg, "quiet_end")
    if s == e:
        return False
    return s <= hour < e if s < e else hour >= s or hour < e


def quiet_span_secs(cfg):
    s, e = _hours(cfg, "quiet_start"), _hours(cfg, "quiet_end")
    return 0 if s == e else ((e - s) % 24) * 3600


def budget_secs(cfg):
    """The heal repaint (display.py:337) is the only GUARANTEED refresh, and a
    quiet window defers it by at most its own length. Derived from the frame's
    own cadence, never from birdframe.timer's 15min tick -- display.py skips
    most of those ticks by design."""
    return max(STALE_SECS, _hours(cfg, "heal_hours") * 3600 + quiet_span_secs(cfg) + SLACK)


def age_of(path, now):
    """Seconds since mtime, clamped at 0 (a clock step must not manufacture a
    future file), or None when the path is missing/unreadable."""
    try:
        return max(0.0, now - os.path.getmtime(path))
    except OSError:
        return None


def last_refresh(state_path):
    """The ONLY timestamp that means 'the wall got new pixels': display.py
    writes it after push_panel succeeds (display.py:369). None = never."""
    try:
        with open(os.path.expanduser(state_path)) as f:  # with-block per display.py:281-286
            v = float(json.load(f).get("last_refresh") or 0)
    except Exception:
        return None
    return v or None


def notify(msg, title, tag):
    # railway_liveness.py:28-38 verbatim. No apprise leg, deliberately: on a
    # standalone frame Pi apprise does not exist, and on the station Pi that
    # leg already belongs to mic_watch — one module, one push idiom.
    print(msg, flush=True)
    if not NOTIFY:
        return
    try:
        req = urllib.request.Request(
            NOTIFY, data=msg.encode("utf-8"),
            headers={"Title": title, "Priority": "high", "Tags": tag})
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        print(f"notify failed: {e}", flush=True)


def load_state():
    try:
        with open(STATE) as f:  # with-block per display.py:281-286 (the frame's own idiom)
            return json.load(f)
    except Exception:
        return {"fails": 0, "down": False}


def save_state(s):
    # Atomic tmp+rename (mic_watch.py:212): a crash mid-write must never
    # truncate the file -- load_state would swallow the corrupt JSON, reset
    # `down`, and re-fire a duplicate DOWN alert for the same outage. The frame
    # Pi is the box most likely to lose power mid-write.
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f)
    os.replace(tmp, STATE)


def freshness(cfg, now, checked):
    """(dead|None, checked). Capture leg first so the trail names it, but only
    last_refresh can declare death -- the capture age then says WHICH step
    stopped, which is what decides whether to debug the shooter or the panel."""
    budget = budget_secs(cfg)
    cap = capture_path(cfg, frame_mode(CONF))
    cap_age = age_of(cap, now) if cap else None
    if cap is None:
        checked.append("no capture file on this box (image mode, or none written yet); capture check skipped")
    elif cap_age is None:
        checked.append(f"{cap} vanished mid-check; capture check skipped")
    else:
        checked.append(f"capture {int(cap_age // 3600)}h old ({cap})")
    lr = last_refresh(cfg["state"])
    if lr is None:
        return ("never_pushed",
                f"{os.path.expanduser(cfg['state'])} has no last_refresh -- the panel has never been repainted"), checked
    age = max(0.0, now - lr)
    if age <= budget:
        checked.append(f"panel repainted {int(age // 3600)}h ago")
        return None, checked
    frozen = f"the wall has not repainted for {int(age // 3600)}h (budget {int(budget // 3600)}h)"
    if cap_age is not None and cap_age > budget:
        return ("capture_stale",
                f"{frozen}, and {cap} was last written {int(cap_age // 3600)}h ago -- the CAPTURE step is what stopped"), checked
    return ("panel_stale", frozen), checked


def assess(cfg, conf_state, tstate, tdetail, now):
    """(dead|None, checked). dead = (reason, detail) and is set on POSITIVE
    evidence only. Order is deliberate: am-I-the-right-box first, then the
    preconditions display.py needs, then the two timestamps."""
    checked = []
    if tstate == "unknown":
        checked.append(tdetail)  # no systemd: nothing here is knowable
        return None, checked
    if tstate == "disabled":
        # Operator intent (mic_watch's doctrine), and it outranks the config
        # checks below: someone who turned the timer off and removed the config
        # has decommissioned this frame, not broken it.
        checked.append(tdetail)
        return None, checked
    if tstate == "missing" and conf_state == "missing":
        checked.append(f"neither {CONF} nor birdframe.timer is present; not a frame Pi")
        return None, checked
    if conf_state == "missing":
        return ("config_missing",
                f"{CONF} is gone while birdframe.timer is installed -- display.py cannot start without it"), checked
    if conf_state == "unreadable":
        return ("config_unreadable",
                f"{CONF} exists but will not parse, so the frame's real cadence is unknown"), checked
    if tstate in ("missing", "inactive"):
        return ("timer_" + tstate, tdetail), checked
    checked.append(tdetail)
    return freshness(cfg, now, checked)


def alert_text(reason, detail, cfg):
    """What broke, what it means for the wall, and the exact next command
    (railway_liveness.py:78-80's shape)."""
    if reason == "capture_stale":
        return (f"FRAME CAPTURE DEAD: {detail}. The shooter is no longer producing an image, so the wall is "
                "frozen on the last collage. display.py keeps the last panel image and exits 0 on purpose, so "
                "nothing else can see this. Check: journalctl -u birdframe -n 50")
    if reason == "never_pushed":
        return (f"FRAME NEVER PAINTED: {detail}, while birdframe.timer is enabled. The frame has never "
                "successfully pushed to the panel. Check: systemctl status birdframe.service")
    if reason == "config_missing":
        return (f"FRAME CONFIG GONE: {detail}. birdframe.service runs display.py --config against that path, so "
                "every run now fails and the wall is frozen. Restore it or re-run frame/install.sh. "
                "Check: systemctl status birdframe.service")
    if reason == "config_unreadable":
        return (f"FRAME CONFIG BROKEN: {detail}. display.py loads the same file, so it cannot start either. "
                f"Check: python3 -c 'import tomllib,sys; tomllib.load(open(\"{CONF}\",\"rb\"))'")
    if reason == "timer_missing":
        return (f"FRAME TIMER GONE: {detail}, but this box still has {CONF}. Nothing is scheduled to repaint the "
                "wall any more (a bad deploy, a rename, or systemd itself is unwell). "
                "Check: systemctl list-timers birdframe.timer")
    if reason == "timer_inactive":
        return (f"FRAME TIMER STOPPED: {detail}. It will never fire again until it is started, so the wall is "
                "frozen. Check: systemctl status birdframe.timer")
    return (f"FRAME FROZEN: {detail}. display.py forces a heal repaint every {_hours(cfg, 'heal_hours')}h, so the "
            "wall is showing a stale collage -- the panel push is failing. Check: journalctl -u birdframe -n 50")


def main():
    cfg, conf_state = read_conf()
    # display.py deliberately does NOT repaint during quiet hours
    # (display.py:340). Return BEFORE touching state so the fail counter is
    # neither reset nor bumped: a real outage alerts at the first tick after the
    # window closes, not at 3am, and an overnight death is not forgiven at dawn.
    if in_quiet_hours(cfg, datetime.now().hour):
        print("quiet hours; skip")
        return 0
    tstate, tdetail = frame_timer()
    dead, checked = assess(cfg, conf_state, tstate, tdetail, time.time())
    s = load_state()
    if dead is None:
        if s.get("down"):
            notify(f"RECOVERED: the frame is repainting again ({'; '.join(checked)}).",
                   "Christina frame OK", "white_check_mark")
        save_state({"fails": 0, "down": False})
        # Name the legs that actually RAN: this line is the only place a
        # permanently-skipped leg (a renamed unit, a capture nobody writes) is
        # visible before it becomes a silent watchdog.
        print(f"OK: {'; '.join(checked) or 'nothing checkable on this box'}")
        return 0
    reason, detail = dead
    s["fails"] = s.get("fails", 0) + 1
    print(f"FAIL {s['fails']}/{THRESH}: {reason}: {detail}")
    if s["fails"] >= THRESH and not s.get("down"):
        s["down"] = True
        notify(alert_text(reason, detail, cfg), "Christina frame DOWN", "warning")
    save_state(s)
    return 1


if __name__ == "__main__":
    sys.exit(main())
