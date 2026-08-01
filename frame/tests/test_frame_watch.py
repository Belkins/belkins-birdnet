#!/usr/bin/env python3
"""Tests for frame_watch -- they exercise the DECISION, not just "it ran".

Every case pins WHY the behaviour matters, because both directions of this
watchdog are expensive: a false alarm poisons the one ntfy topic that also
carries the mic and Railway alerts (so the next real outage is muted), and a
missed alarm is the frozen wall the item exists to catch.

No network, no Pi, no Pillow, no pytest: pure stdlib unittest against fixtures
in a tmp dir, with ``frame_watch.NOTIFY`` forced empty so notify()'s urllib leg
is unreachable by construction even before it is patched.

Run from ``frame/``:
    python3 -m unittest discover -s tests -v
(needs Python >= 3.11 for tomllib, or tomli installed -- same as display.py.)
"""

import json
import os
import re
import sys
import tempfile
import time
import unittest
from io import StringIO
from contextlib import redirect_stdout
from unittest import mock

# Import the watchdog regardless of CWD / discovery method.
_FRAME_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _FRAME_DIR not in sys.path:
    sys.path.insert(0, _FRAME_DIR)

import frame_watch  # noqa: E402

HOUR = 3600
ENABLED = ("enabled", "birdframe.timer enabled and active")

# frame/install.sh:116-130 verbatim -- the config the DEFAULT install writes.
INSTALL_LOCAL = """\
# birdframe-mode: local
# Belkins BirdNET frame, local mode: mirrors the BirdNET-Pi on your network.
# This Pi screenshots birdnet.local itself, so there is nothing else to set up.
base_url = "http://birdnet.local"
shoot = true
shoot_title = "Belkins BirdNET"
shoot_subtitle = "Heard Today"
rotate = 90          # flip to 270 if the frame hangs the other way up
saturation = 0.6
timeout = 45
"""

# frame/install.sh:134-142 verbatim -- --image-url mode.
INSTALL_IMAGE = """\
# birdframe-mode: image
# Belkins BirdNET frame, image mode: fetches a ready-made frame PNG.
base_url = "https://bird.example.com"
image_url = "https://bird.example.com/frame.png"
shoot = false
rotate = 90          # flip to 270 if the frame hangs the other way up
saturation = 0.6
"""


def _install_birdweather():
    """What install.sh's birdweather branch writes: the mode marker, then
    config.example.toml with `shoot = true` flipped to false — the same sed
    install.sh applies, because the verbatim copy made display.py take the
    shoot branch and discard the PNG the unit had just rendered. Read from the
    real file so a change to the shipped example reaches this test."""
    with open(os.path.join(_FRAME_DIR, "config.example.toml")) as f:
        return "# birdframe-mode: birdweather\n" + re.sub(
            r"(?m)^shoot = true$", "shoot = false", f.read())


def _redirect(text, cache, state):
    """Point an installer-verbatim config at the fixture dir instead of the
    developer's home, REPLACING cache/state where the file already sets them
    (config.example.toml does, and a duplicate key is a TOML parse error)."""
    for key, val in (("cache", cache), ("state", state)):
        line = '%s = "%s"' % (key, val)
        text, n = re.subn(r'(?m)^%s\s*=.*$' % key, line.replace("\\", "\\\\"), text, count=1)
        if not n:
            text += "\n" + line + "\n"
    return text


class _Clock:
    """Stand-in for frame_watch.datetime: only .now().hour is ever read."""

    def __init__(self, hour):
        self._hour = hour

    def now(self):
        return type("_N", (), {"hour": self._hour})()


class FrameWatchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.addCleanup(self.tmp.cleanup)
        # Module-level env constants are the mic_watch convention; repoint them
        # at the fixture and restore afterwards.
        saved = {k: getattr(frame_watch, k) for k in
                 ("CONF", "STATE", "THRESH", "STALE_SECS", "NOTIFY")}
        self.addCleanup(lambda: [setattr(frame_watch, k, v) for k, v in saved.items()])
        frame_watch.CONF = os.path.join(self.dir, "config.toml")
        frame_watch.STATE = os.path.join(self.dir, "frame-watch.state")
        frame_watch.THRESH = 2
        frame_watch.STALE_SECS = 108000       # 30h, the shipped floor
        frame_watch.NOTIFY = ""               # no test may ever reach the network
        self.state_json = os.path.join(self.dir, "state.json")

    # --- fixture helpers ---------------------------------------------------
    def write_config(self, marker="local", **kw):
        vals = {"state": self.state_json, "cache": self.dir, "shoot": True}
        vals.update(kw)
        lines = ["# birdframe-mode: %s" % marker] if marker else []
        for k, v in vals.items():
            if isinstance(v, bool):
                lines.append("%s = %s" % (k, "true" if v else "false"))
            elif isinstance(v, int):
                lines.append("%s = %d" % (k, v))
            else:
                lines.append('%s = "%s"' % (k, v))
        with open(frame_watch.CONF, "w") as f:
            f.write("\n".join(lines) + "\n")

    def write_raw_config(self, text, redirect=True):
        """An installer-verbatim config, plus (by default) a cache/state
        redirect so the test stats the tmp dir and not the developer's home."""
        if redirect:
            text = _redirect(text, self.dir, self.state_json)
        with open(frame_watch.CONF, "w") as f:
            f.write(text)

    def write_capture(self, name="shot.png", hours_ago=0.0):
        p = os.path.join(self.dir, name)
        with open(p, "wb") as f:
            f.write(b"")
        when = time.time() - hours_ago * HOUR
        os.utime(p, (when, when))
        return p

    def write_refresh(self, hours_ago=0.0):
        with open(self.state_json, "w") as f:
            json.dump({"signature": "abc", "last_refresh": time.time() - hours_ago * HOUR}, f)

    def seed_watch_state(self, fails, down):
        with open(frame_watch.STATE, "w") as f:
            json.dump({"fails": fails, "down": down}, f)

    def read_watch_state(self):
        with open(frame_watch.STATE) as f:
            return json.load(f)

    def run_main(self, timer=ENABLED, hour=12):
        """(rc, notify_mock, stdout). frame_timer is patched so the systemd
        answer is a fixture; the tests that exercise the real probe patch
        shutil/subprocess instead."""
        buf = StringIO()
        with mock.patch.object(frame_watch, "frame_timer", return_value=timer), \
                mock.patch.object(frame_watch, "datetime", _Clock(hour)), \
                mock.patch.object(frame_watch, "notify") as n, \
                redirect_stdout(buf):
            rc = frame_watch.main()
        return rc, n, buf.getvalue()

    # --- the wall stopped repainting ---------------------------------------
    def test_frozen_panel_alerts_once_after_two_ticks(self):
        """WHY: an outage that pushes every hour trains the operator to mute the
        ntfy topic -- and that same topic is the only warning channel for the
        mic and for Railway. One alert per outage, or the watchdog costs more
        than it saves."""
        self.write_config()
        self.write_capture(hours_ago=0.5)
        self.write_refresh(hours_ago=40)

        rc, n, _ = self.run_main()
        self.assertEqual(rc, 1)
        n.assert_not_called()                       # one tick is not evidence
        rc, n, _ = self.run_main()
        self.assertEqual(rc, 1)
        self.assertEqual(n.call_count, 1)
        msg, title, tag = n.call_args[0]
        self.assertIn("FRAME FROZEN", msg)
        self.assertEqual(title, "Christina frame DOWN")
        self.assertEqual(tag, "warning")
        rc, n, _ = self.run_main()
        self.assertEqual(rc, 1)
        n.assert_not_called()                       # never a second push

    def test_stale_capture_is_named_as_the_capture_leg(self):
        """WHY: both legs go stale together in the common case, and the fixes
        are unrelated -- debugging the screenshotter is not debugging the panel
        or the SPI bus. The alert has to say which one stopped."""
        self.write_config()
        self.write_capture(hours_ago=40)
        self.write_refresh(hours_ago=40)

        self.run_main()
        _, n, _ = self.run_main()
        msg = n.call_args[0][0]
        self.assertIn("FRAME CAPTURE DEAD", msg)
        self.assertIn("shot.png", msg)
        self.assertNotIn("FRAME FROZEN", msg)

    def test_never_pushed_is_positive_evidence(self):
        """WHY: this is the literal defect the item exists for -- a frame that
        was installed and never updated the wall. Absence of a push record while
        the timer is enabled is evidence, not ignorance."""
        self.write_config()
        self.write_capture(hours_ago=0.5)
        # no state.json at all
        self.run_main()
        rc, n, _ = self.run_main()
        self.assertEqual(rc, 1)
        self.assertIn("NEVER PAINTED", n.call_args[0][0])

    def test_recovery_notice_fires_once(self):
        """WHY: mirrors mic_watch/railway_liveness -- the operator must learn the
        wall came back without walking to it, and must not be told twice."""
        self.write_config()
        self.write_capture(hours_ago=0.5)
        self.write_refresh(hours_ago=1)
        self.seed_watch_state(fails=2, down=True)

        rc, n, _ = self.run_main()
        self.assertEqual(rc, 0)
        self.assertEqual(n.call_count, 1)
        self.assertEqual(n.call_args[0][1], "Christina frame OK")
        self.assertEqual(self.read_watch_state(), {"fails": 0, "down": False})
        rc, n, _ = self.run_main()
        self.assertEqual(rc, 0)
        n.assert_not_called()

    # --- the budget follows the frame's own cadence -------------------------
    def test_budget_follows_the_configured_heal_cadence(self):
        """WHY: the threshold must be derived from the frame's own cadence, not a
        magic constant, or changing heal_hours silently turns the watchdog into
        a false-alarm generator (or blinds it)."""
        self.write_config(heal_hours=48)
        self.write_capture(hours_ago=0.5)
        self.write_refresh(hours_ago=40)
        rc, n, _ = self.run_main()
        self.assertEqual(rc, 0)
        n.assert_not_called()

        self.write_config(heal_hours=24)            # same 40h, shipped cadence
        self.write_refresh(hours_ago=40)
        rc, _, _ = self.run_main()
        self.assertEqual(rc, 1)

    def test_quiet_window_length_is_folded_into_the_budget(self):
        """WHY: a heal repaint can legitimately be deferred by the whole quiet
        window; a fixed 30h threshold would cry wolf every night on a frame with
        quiet hours. The second half proves the test is not vacuous."""
        self.write_config(quiet_start=22, quiet_end=6)   # budget 24+8+1 = 33h
        self.write_capture(hours_ago=0.5)
        self.write_refresh(hours_ago=31)
        rc, n, _ = self.run_main(hour=12)                # outside the window
        self.assertEqual(rc, 0)
        n.assert_not_called()

        self.write_config(quiet_start=0, quiet_end=0)    # budget 30h
        self.write_refresh(hours_ago=31)
        rc, _, _ = self.run_main(hour=12)
        self.assertEqual(rc, 1)

    def test_quiet_hours_hold_the_alert_without_resetting_it(self):
        """WHY: display.py refuses to repaint during quiet hours, so an alert
        then is a 3am push for a condition the operator configured -- but
        zeroing the counter would forgive a genuine overnight death every
        morning."""
        self.write_config(quiet_start=22, quiet_end=6)
        self.write_capture(hours_ago=60)
        self.write_refresh(hours_ago=60)
        self.seed_watch_state(fails=1, down=False)

        rc, n, out = self.run_main(hour=3)
        self.assertEqual(rc, 0)
        n.assert_not_called()
        self.assertIn("quiet hours; skip", out)
        self.assertEqual(self.read_watch_state(), {"fails": 1, "down": False})

    # --- unknowable counts as healthy, but only where nothing is knowable ---
    def test_disabled_timer_is_operator_intent(self):
        """WHY: mic_watch's doctrine -- a deliberately disabled unit is intent,
        and alerting on it is exactly how an alert channel gets muted."""
        self.write_config()
        self.write_refresh(hours_ago=100)
        rc, n, _ = self.run_main(timer=("disabled", "birdframe.timer is disabled -- operator intent"))
        self.assertEqual(rc, 0)
        n.assert_not_called()

    def test_disabled_timer_outranks_the_missing_config(self):
        """WHY: a deleted config is a fault only on a frame that is still meant
        to be repainting. Timer off AND config gone is a decommissioned frame,
        and paging about it is how the shared ntfy topic gets muted."""
        # no config.toml at all
        rc, n, _ = self.run_main(timer=("disabled", "birdframe.timer is disabled -- operator intent"))
        self.assertEqual(rc, 0)
        n.assert_not_called()

    def test_no_systemctl_is_unknowable_not_dead(self):
        """WHY: the watchdog acts only on positive evidence; a developer running
        it on a laptop (or a builder running this suite) must never page
        anyone."""
        self.write_config()                          # config present, no state.json
        rc, n, _ = self.run_main(timer=("unknown", "no systemctl on this box (dev machine)"))
        self.assertEqual(rc, 0)
        n.assert_not_called()

    def test_remote_image_url_skips_the_capture_leg_but_not_the_panel_leg(self):
        """WHY: in image mode nothing is ever written to this box, so statting a
        capture path would be a permanent false alarm -- but the panel leg is
        exactly what still has to work."""
        self.write_raw_config(INSTALL_IMAGE)
        self.write_capture(hours_ago=99)             # a stray file must not matter
        self.write_refresh(hours_ago=1)
        rc, n, out = self.run_main()
        self.assertEqual(rc, 0)
        n.assert_not_called()
        self.assertIn("capture check skipped", out)

        self.write_refresh(hours_ago=40)
        self.run_main()
        rc, n, _ = self.run_main()
        self.assertEqual(rc, 1)
        self.assertIn("FRAME FROZEN", n.call_args[0][0])

    # --- silence on a box that IS the frame is not innocence ----------------
    def test_unanswerable_systemctl_with_a_config_alerts(self):
        """WHY: the fail-open this replaces. systemd degraded, dbus down, the
        unit removed by a bad deploy and a 10s timeout all used to collapse into
        'dev box, skip' -- a green watchdog over a dead surface, on exactly the
        box that has already proved it IS the frame."""
        self.write_config()
        self.write_capture(hours_ago=0.5)
        self.write_refresh(hours_ago=1)
        with mock.patch("frame_watch.shutil.which", return_value="/bin/systemctl"), \
                mock.patch("frame_watch.subprocess.run", side_effect=OSError("dbus is not running")), \
                mock.patch.object(frame_watch, "datetime", _Clock(12)), \
                mock.patch.object(frame_watch, "notify") as n, \
                redirect_stdout(StringIO()):
            self.assertEqual(frame_watch.main(), 1)
            n.assert_not_called()
            self.assertEqual(frame_watch.main(), 1)
            self.assertEqual(n.call_count, 1)
            self.assertIn("FRAME TIMER GONE", n.call_args[0][0])

    def test_unanswerable_systemctl_without_a_config_is_still_unknowable(self):
        """WHY: the other half of the same rule. With neither config.toml nor
        birdframe.timer, this is simply not the frame Pi, and a watchdog that
        pages from a random Linux box is a watchdog nobody keeps installed."""
        with mock.patch("frame_watch.shutil.which", return_value="/bin/systemctl"), \
                mock.patch("frame_watch.subprocess.run", side_effect=OSError("dbus is not running")), \
                mock.patch.object(frame_watch, "datetime", _Clock(12)), \
                mock.patch.object(frame_watch, "notify") as n, \
                redirect_stdout(StringIO()):
            self.assertEqual(frame_watch.main(), 0)
            self.assertEqual(frame_watch.main(), 0)
            n.assert_not_called()

    def test_deleted_config_on_a_frame_box_alerts(self):
        """WHY: ConditionPathExists on config.toml would make systemd skip this
        unit as a SUCCESS in exactly this case -- the wall frozen, birdframe
        failing on --config, and both units reporting green. The Python has to
        own the decision, so the unit carries no such condition."""
        # no config.toml written; birdframe.timer still installed and enabled
        self.run_main()
        rc, n, _ = self.run_main()
        self.assertEqual(rc, 1)
        self.assertIn("FRAME CONFIG GONE", n.call_args[0][0])

    def test_unparseable_config_on_a_frame_box_alerts(self):
        """WHY: falling back to defaults would silently change WHICH legs run and
        WHICH budget applies -- a quiet default over a box whose display.py
        cannot start either."""
        with open(frame_watch.CONF, "w") as f:
            f.write("this is not = = toml [[[\n")
        self.write_capture(hours_ago=0.5)
        self.write_refresh(hours_ago=1)
        self.run_main()
        rc, n, _ = self.run_main()
        self.assertEqual(rc, 1)
        self.assertIn("FRAME CONFIG BROKEN", n.call_args[0][0])

    def test_enabled_but_inactive_timer_alerts(self):
        """WHY: mic_watch treats 'enabled but not active' as recorder_stalled. A
        masked or start-failed timer never fires again, so the wall is frozen
        even though every timestamp is still inside its budget today."""
        self.write_config()
        self.write_capture(hours_ago=0.5)
        self.write_refresh(hours_ago=1)
        timer = ("inactive", "birdframe.timer is enabled but NOT active (masked, or it failed to start)")
        self.run_main(timer=timer)
        rc, n, _ = self.run_main(timer=timer)
        self.assertEqual(rc, 1)
        self.assertIn("FRAME TIMER STOPPED", n.call_args[0][0])


class CapturePathTest(unittest.TestCase):
    """capture_path against the THREE configs frame/install.sh actually writes.

    WHY: if this drifts from what the installed ExecStart rewrites, the
    watchdog watches a file nobody writes -- which fails silently in image mode
    and, before the fix, fired a permanent false alarm in BirdWeather mode
    (install.sh:144 ships config.example.toml, whose `shoot = true` points at a
    shot.png that mode never creates; the real output is frame.png, named only
    on install.sh:162's command line)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.addCleanup(self.tmp.cleanup)
        saved = frame_watch.CONF
        self.addCleanup(lambda: setattr(frame_watch, "CONF", saved))
        frame_watch.CONF = os.path.join(self.dir, "config.toml")

    def _load(self, text):
        with open(frame_watch.CONF, "w") as f:
            f.write(_redirect(text, self.dir, os.path.join(self.dir, "state.json")))
        cfg, status = frame_watch.read_conf()
        self.assertEqual(status, "ok")
        return cfg, frame_watch.frame_mode(frame_watch.CONF)

    def _touch(self, name):
        p = os.path.join(self.dir, name)
        open(p, "wb").close()
        return p

    def test_local_mode_watches_shot_png(self):
        cfg, mode = self._load(INSTALL_LOCAL)
        self.assertEqual(mode, "local")
        self.assertIsNone(frame_watch.capture_path(cfg, mode))   # nothing written yet: skip, never death
        want = self._touch("shot.png")
        self.assertEqual(frame_watch.capture_path(cfg, mode), want)

    def test_birdweather_mode_watches_frame_png(self):
        cfg, mode = self._load(_install_birdweather())
        self.assertEqual(mode, "birdweather")
        self.assertFalse(cfg["shoot"], "install.sh flips shoot = false for this mode -- verbatim "
                         "shoot = true made display.py discard the frame.png the unit had just "
                         "rendered and screenshot a birdnet.local a standalone box does not have")
        self.assertIsNone(frame_watch.capture_path(cfg, mode))
        want = self._touch("frame.png")
        self.assertEqual(frame_watch.capture_path(cfg, mode), want)

    def test_birdweather_pre_fix_verbatim_config_still_watched(self):
        """WHY: installs made before the shoot=false fix (2026-08) shipped
        config.example.toml verbatim, shoot = true and all. capture_path picks
        by which file EXISTS, never by the flag, so those boxes keep their
        capture leg when frame_watch alone is upgraded."""
        with open(os.path.join(_FRAME_DIR, "config.example.toml")) as f:
            verbatim = "# birdframe-mode: birdweather\n" + f.read()
        cfg, mode = self._load(verbatim)
        self.assertEqual(mode, "birdweather")
        self.assertTrue(cfg["shoot"], "the example itself must keep shoot = true (local mode needs it)")
        want = self._touch("frame.png")
        self.assertEqual(frame_watch.capture_path(cfg, mode), want)

    def test_image_mode_watches_nothing_local(self):
        cfg, mode = self._load(INSTALL_IMAGE)
        self.assertEqual(mode, "image")
        self._touch("shot.png")          # even a stray capture must not be watched
        self._touch("frame.png")
        self.assertIsNone(frame_watch.capture_path(cfg, mode))


class BirdWeatherFrameTest(unittest.TestCase):
    """A healthy BirdWeather frame must be silent. WHY: the pre-fix logic paged
    'FRAME CAPTURE DEAD' on every one of them within two hours, forever, on a
    wall that was repainting perfectly -- and that push goes to the same ntfy
    topic as the mic and Railway alerts."""

    def test_healthy_birdweather_frame_never_alerts(self):
        with tempfile.TemporaryDirectory() as d:
            saved = {k: getattr(frame_watch, k) for k in ("CONF", "STATE", "NOTIFY")}
            self.addCleanup(lambda: [setattr(frame_watch, k, v) for k, v in saved.items()])
            frame_watch.CONF = os.path.join(d, "config.toml")
            frame_watch.STATE = os.path.join(d, "frame-watch.state")
            frame_watch.NOTIFY = ""
            state_json = os.path.join(d, "state.json")
            with open(frame_watch.CONF, "w") as f:
                f.write(_redirect(_install_birdweather(), d, state_json))
            open(os.path.join(d, "frame.png"), "wb").close()      # the shooter's real output
            with open(state_json, "w") as f:
                json.dump({"signature": "abc", "last_refresh": time.time() - HOUR}, f)

            with mock.patch.object(frame_watch, "frame_timer", return_value=ENABLED), \
                    mock.patch.object(frame_watch, "datetime", _Clock(12)), \
                    mock.patch.object(frame_watch, "notify") as n, \
                    redirect_stdout(StringIO()) as buf:
                self.assertEqual(frame_watch.main(), 0)
                self.assertEqual(frame_watch.main(), 0)
            n.assert_not_called()
            self.assertIn("frame.png", buf.getvalue())


class ContractTest(unittest.TestCase):
    def test_state_write_is_crash_safe(self):
        """WHY: a power cut mid-write on an RTC-less Pi is routine; a truncated
        state file makes load_state fall back to down=False and re-fire the same
        DOWN alert forever."""
        with tempfile.TemporaryDirectory() as d:
            saved = frame_watch.STATE
            self.addCleanup(lambda: setattr(frame_watch, "STATE", saved))
            frame_watch.STATE = os.path.join(d, "sub", "frame-watch.state")
            frame_watch.save_state({"fails": 2, "down": True})
            self.assertEqual(frame_watch.load_state(), {"fails": 2, "down": True})
            self.assertFalse(os.path.exists(frame_watch.STATE + ".tmp"),
                             "a .tmp sibling left behind means the write was not atomic")

    def test_frame_defaults_mirror_display_py(self):
        """WHY: FRAME_DEFAULTS is a deliberate COPY of display.py's DEFAULTS
        (importing display.py would drag PIL into the watchdog). display.py is
        parsed as TEXT, never imported, so this check runs on a box with no
        Pillow -- and fails the moment a mirrored key stops existing upstream."""
        with open(os.path.join(_FRAME_DIR, "display.py")) as f:
            src = f.read()
        block = src.split("DEFAULTS = {", 1)[1].split("}", 1)[0]
        keys = set(re.findall(r'"([a-z_]+)":', block))
        missing = sorted(set(frame_watch.FRAME_DEFAULTS) - keys)
        self.assertEqual(missing, [], "display.py:41-67 no longer defines these mirrored keys")

    def test_age_of_never_reports_a_future_file(self):
        """WHY: an NTP step backwards on an RTC-less Pi would otherwise produce a
        negative age, and a negative age compares as fresh forever."""
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "x.png")
            open(p, "wb").close()
            self.assertEqual(frame_watch.age_of(p, time.time() - 10 * HOUR), 0.0)
            self.assertIsNone(frame_watch.age_of(os.path.join(d, "nope.png"), time.time()))


class AuthHintTest(unittest.TestCase):
    """WHY: an auth wall in front of the frame (the forwarded-deploy gate --
    on the LAN nothing the frame fetches is auth-gated, so STATION_OPEN is
    deliberately NOT named) freezes the wall identically to every other
    silent failure for ~30h, and the generic alert sends the operator to
    journalctl instead of the config. display.py stamps auth_error into ITS
    state.json on each HTTP 401/403 (and drops it on the next successful
    paint) precisely so the eventual alert can name the cause. The hint must
    appear ONLY on that positive evidence -- a missing/clean state file adds
    nothing, because a false auth hint would send the operator to fix
    credentials on a box where the panel cable fell out."""

    def test_alert_names_auth_only_when_auth_error_stamped(self):
        with tempfile.TemporaryDirectory() as d:
            state = os.path.join(d, "state.json")
            cfg = dict(frame_watch.FRAME_DEFAULTS)
            cfg["state"] = state
            for reason in ("panel_stale", "capture_stale", "never_pushed"):
                self.assertNotIn("401/403", frame_watch.alert_text(reason, "x", cfg),
                                 f"{reason}: hint appeared with no state file at all")
            with open(state, "w") as f:
                json.dump({"signature": "s", "last_refresh": 1}, f)
            self.assertNotIn("401/403", frame_watch.alert_text("panel_stale", "x", cfg),
                             "hint appeared for a clean state (no auth_error key)")
            with open(state, "w") as f:
                json.dump({"signature": "s", "last_refresh": 1, "auth_error": 2}, f)
            for reason in ("panel_stale", "capture_stale", "never_pushed"):
                out = frame_watch.alert_text(reason, "x", cfg)
                self.assertIn("401/403", out, f"{reason}: hint missing despite auth_error")
                self.assertIn("basic_user", out, f"{reason}: hint gives no next action")
                self.assertNotIn("STATION_OPEN", out,
                                 f"{reason}: the hint must not name STATION_OPEN -- on the LAN "
                                 "nothing the frame fetches is gated by it, so that wording "
                                 "sends the operator to revert the wrong flag")

    def test_unreadable_state_never_raises_into_the_alert_path(self):
        with tempfile.TemporaryDirectory() as d:
            state = os.path.join(d, "state.json")
            with open(state, "w") as f:
                f.write("{not json")
            cfg = dict(frame_watch.FRAME_DEFAULTS)
            cfg["state"] = state
            out = frame_watch.alert_text("panel_stale", "x", cfg)
            self.assertNotIn("re-gated", out)


if __name__ == "__main__":
    unittest.main()
