#!/usr/bin/env python3
"""Tests for mic_watch -- they exercise the DECISION, not just "it ran".

Every case pins WHY the behaviour matters, because both directions of this
watchdog are expensive. A false alarm poisons the one ntfy topic that also
carries the frame and Railway alerts (so the next real outage is muted); a
missed alarm is a microphone that is present, enumerated, and recording pure
silence while every dashboard stays green.

That second failure is not hypothetical. Commit 7851134 ("the flatline scan had
never once executed") found the third check STRUCTURALLY UNREACHABLE: birdnet_
analysis deletes each chunk the moment it has analysed it, so StreamData holds
exactly ONE wav -- the one being written -- and newest_chunks()'s "settled"
selector, which demanded a chunk older than one whole segment, returned None on
every single run for seven days. The module then had zero tests, so nothing said
a word. Half of this file exists to make that specific silence impossible again:
``NewestChunksTest`` pins the selector, and ``MainTest`` re-runs the regression
end to end through main().

No network, no Pi, no ALSA, no systemd, no pytest-only APIs: pure stdlib
unittest against fixtures in a tmp dir, with ``mic_watch.NOTIFY`` forced empty so
notify()'s urllib leg is unreachable by construction even before it is patched,
and with ``subprocess.run`` faked for everything except read_conf's own shell
source. The fake is not optional: CI runs this suite on ubuntu-latest, where an
un-faked self-heal would be a real ``systemctl restart`` on the runner.

Run from ``avian/realtime/``:
    python3 -m pytest tests/ -v
    (or: python3 -m unittest discover -s tests -v -- this dir is a package)
"""

import array
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
import wave
from collections import namedtuple
from contextlib import redirect_stdout
from io import StringIO
from unittest import mock

# Import the watchdog regardless of CWD / discovery method.
_REALTIME_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REALTIME_DIR not in sys.path:
    sys.path.insert(0, _REALTIME_DIR)

import mic_watch  # noqa: E402

# Captured BEFORE any patch: FakeRun hands read_conf's `bash -c source` back to
# the real implementation, because parsing birdnet.conf is part of what is under
# test and stubbing it would test the stub.
_REAL_RUN = subprocess.run

RATE = 8000          # a fixture rate, not the Pi's 48k: 1s of audio is 1s of audio
UNIT = "birdnet_recording.service"
RUNNING = (UNIT, True, True)                    # detected, enabled, active
CARD_OK = ("present", "card Device present")

# /proc/asound/cards on the station Pi, verbatim shape (index, [id], driver).
CARDS = (
    " 0 [Headphones     ]: bcm2835_headpho - bcm2835 Headphones\n"
    "                      bcm2835 Headphones\n"
    " 1 [Device         ]: USB-Audio - USB PnP Sound Device\n"
    "                      USB PnP Sound Device at usb-0000:01:00.0-1.3, full speed\n"
)
ARECORD_ONE = ("**** List of CAPTURE Hardware Devices ****\n"
               "card 1: Device [USB PnP Sound Device], device 0: USB Audio [USB Audio]\n")
ARECORD_NONE = "**** List of CAPTURE Hardware Devices ****\n"


# --- signal + fixture helpers ---------------------------------------------
def dc(n, level=0):
    """n samples of CONSTANT DC -- peak-to-peak exactly 0. A dead ADC latches at
    some level, not necessarily zero, which is why `level` is a parameter."""
    return [level] * n


def swing(n, p2p, base=0):
    """n samples whose peak-to-peak is EXACTLY p2p -- so a threshold test can sit
    on the boundary instead of near it."""
    return [base + (p2p if i % 2 else 0) for i in range(n)]


def write_wav(path, samples, rate=RATE, width=2):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(width)
        w.setframerate(rate)
        if width == 2:
            w.writeframes(array.array("h", samples).tobytes())
        else:
            w.writeframes(bytes((s + 128) % 256 for s in samples))
    return path


class FakeRun:
    """Stand-in for ``subprocess.run`` inside mic_watch.

    read_conf's ``bash -c source`` runs FOR REAL; everything else -- systemctl,
    arecord, apprise -- is recorded and answered from a table. `stdout_for` and
    `raise_for` match on a substring of the joined argv."""

    def __init__(self, stdout_for=None, raise_for=()):
        self.calls = []
        self.stdout_for = stdout_for or {}
        self.raise_for = tuple(raise_for)

    def __call__(self, argv, **kw):
        argv = list(argv)
        self.calls.append(argv)
        if argv[:1] == ["bash"]:
            return _REAL_RUN(argv, **kw)
        key = " ".join(argv)
        for pat in self.raise_for:
            if pat in key:
                raise OSError("faked failure: " + key)
        out = next((v for p, v in self.stdout_for.items() if p in key), "")
        return subprocess.CompletedProcess(argv, 0, out, "")

    def matching(self, *tokens):
        return [c for c in self.calls if all(t in " ".join(c) for t in tokens)]


Tick = namedtuple("Tick", "rc notify out runner card")


class FlatlineTest(unittest.TestCase):
    """flatline() decides, alone, whether a present microphone is electrically
    dead. It has three answers and all three are load-bearing: True pages the
    operator, False is the only evidence anywhere that the mic is alive, and
    None must be returned for anything unknowable rather than guessed."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.addCleanup(self.tmp.cleanup)
        saved = mic_watch.FLATLINE_P2P
        self.addCleanup(lambda: setattr(mic_watch, "FLATLINE_P2P", saved))

    def wav(self, samples, name="chunk.wav", rate=RATE, width=2):
        return write_wav(os.path.join(self.dir, name), samples, rate, width)

    def test_all_zero_chunk_is_a_flat_line(self):
        """WHY: the literal dead-USB-mic signature -- the card still enumerates,
        arecord still writes files, and every byte in them is zero."""
        self.assertIs(mic_watch.flatline(self.wav(dc(2 * RATE, 0))), True)

    def test_constant_nonzero_dc_is_a_flat_line(self):
        """WHY: an ADC that has stopped converting latches at whatever level it
        held, not at zero. A check written as `all(s == 0)` would pass a dead
        mic; the peak-to-peak form is what makes this catchable."""
        self.assertIs(mic_watch.flatline(self.wav(dc(2 * RATE, 900))), True)

    def test_quiet_night_noise_floor_is_alive(self):
        """WHY: the expensive direction. A silent 3am garden still has a noise
        floor of tens of LSB; calling that dead pages the operator every night
        until they mute the topic that also carries the frame and Railway."""
        self.assertIs(mic_watch.flatline(self.wav(swing(2 * RATE, 40))), False)

    def test_threshold_is_inclusive_and_one_lsb_wide(self):
        """WHY: pins the shipped decision boundary in BOTH directions with
        hardcoded amplitudes, so widening or narrowing FLATLINE_P2P (or flipping
        <= to <) cannot stay green. 16 LSB is the shipped default."""
        self.assertEqual(mic_watch.FLATLINE_P2P, 16, "the shipped default moved -- update the "
                                                     "amplitudes below deliberately, not this line")
        self.assertIs(mic_watch.flatline(self.wav(swing(2 * RATE, 16), "at.wav")), True)
        self.assertIs(mic_watch.flatline(self.wav(swing(2 * RATE, 17), "over.wav")), False)

    def test_threshold_is_read_at_call_time_not_frozen_at_import(self):
        """WHY: FLATLINE_P2P is an EnvironmentFile knob (a noisier site may need
        it raised). If flatline() had baked the value in at import, the operator
        could set it, see it in `systemctl show`, and change nothing."""
        mic_watch.FLATLINE_P2P = 500
        self.assertIs(mic_watch.flatline(self.wav(swing(2 * RATE, 400))), True)

    def test_less_than_one_second_refuses_to_judge(self):
        """WHY: this is what makes reading the IN-FLIGHT chunk (7851134) safe. A
        file caught microseconds after arecord created it holds a few ms of
        near-silence; without this refusal the fix for a missed alarm would have
        shipped a permanent false alarm instead."""
        self.assertIsNone(mic_watch.flatline(self.wav(dc(RATE // 2, 0))))

    def test_exactly_one_second_does_judge(self):
        """WHY: the other side of the same boundary -- proves the refusal above is
        a guard and not a blanket skip that would silence the check again."""
        self.assertIs(mic_watch.flatline(self.wav(dc(RATE, 0))), True)

    def test_non_16_bit_chunk_is_unknowable(self):
        """WHY: birdnet_recording.sh writes pcm_s16le. Anything else is a box
        this watchdog does not understand, and array('h') over 8-bit frames would
        invent samples -- a fabricated verdict is worse than no verdict."""
        self.assertIsNone(mic_watch.flatline(self.wav(dc(2 * RATE, 0), width=1)))

    def test_truncated_riff_is_unknowable_and_says_so(self):
        """WHY: a chunk caught mid-flush, or a full disk, must degrade to silence
        with a journal line naming the file -- never to a crash (the timer would
        go red for a healthy mic) and never to a verdict."""
        p = self.wav(dc(2 * RATE, 0), "trunc.wav")
        with open(p, "r+b") as f:
            f.truncate(20)
        buf = StringIO()
        with redirect_stdout(buf):
            self.assertIsNone(mic_watch.flatline(p))
        self.assertIn("flatline scan skipped", buf.getvalue())
        self.assertIn("trunc.wav", buf.getvalue())

    def test_non_riff_bytes_are_unknowable(self):
        """WHY: same class, different cause -- a half-written file or a stray
        non-wav dropped in StreamData must not take the watchdog down."""
        p = os.path.join(self.dir, "garbage.wav")
        with open(p, "wb") as f:
            f.write(b"this is not a RIFF header at all")
        with redirect_stdout(StringIO()):
            self.assertIsNone(mic_watch.flatline(p))

    def test_vanished_chunk_is_unknowable(self):
        """WHY: birdnet_analysis consumes and DELETES chunks continuously, so the
        file selected a moment ago is routinely gone by the time it is opened."""
        with redirect_stdout(StringIO()):
            self.assertIsNone(mic_watch.flatline(os.path.join(self.dir, "gone.wav")))

    def test_zero_frame_wav_is_unknowable(self):
        """WHY: arecord creates the file and its RIFF header BEFORE any audio
        exists. An empty-but-valid chunk is the start of a healthy recording."""
        self.assertIsNone(mic_watch.flatline(self.wav([], "empty.wav")))


class NewestChunksTest(unittest.TestCase):
    """The selector that commit 7851134 fixed. Its output feeds the only check
    that can catch a present-but-silent mic, so a None here is not a degraded
    check -- it is no check at all, forever, with nothing in the journal."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.recs = self.tmp.name
        self.addCleanup(self.tmp.cleanup)
        self.stream = os.path.join(self.recs, "StreamData")
        os.makedirs(self.stream)

    def chunk(self, name, age):
        p = write_wav(os.path.join(self.stream, name), dc(RATE, 0))
        os.utime(p, (time.time() - age, time.time() - age))
        return p

    def test_in_flight_only_directory_is_still_scanned(self):
        """WHY: THE REGRESSION (7851134). This is the real station's steady state
        -- birdnet_analysis deletes each chunk as it finishes, so StreamData
        holds exactly one wav and it is always younger than one segment. The old
        selector demanded age > rec_len+5, returned None here every run for
        seven days, and the flatline check never executed once."""
        want = self.chunk("in-flight.wav", age=0)
        self.assertEqual(len(os.listdir(self.stream)), 1, "fixture must reproduce the Pi: ONE wav")
        age, settled = mic_watch.newest_chunks(self.recs, 15)
        self.assertLess(age, 15 + 5, "fixture chunk must be YOUNGER than a segment or it proves nothing")
        self.assertEqual(settled, want, "the in-flight chunk must be scanned -- returning None here "
                                        "is the silent failure 7851134 fixed")

    def test_settled_chunk_is_preferred_when_one_exists(self):
        """WHY: the fallback is a fallback. A completed chunk can never be
        contended for, so on a box that keeps its chunks (custom_recording, a
        stopped analyser, a debug session) the safe file must still win."""
        old = self.chunk("settled.wav", age=60)
        self.chunk("in-flight.wav", age=1)
        age, settled = mic_watch.newest_chunks(self.recs, 15)
        self.assertEqual(settled, old)
        self.assertLess(age, 5, "freshness must still report the NEWEST chunk, not the settled one")

    def test_newest_age_tracks_the_newest_file_not_the_scanned_one(self):
        """WHY: the two return values answer different questions -- 'is the
        recorder still writing' and 'what can be scanned'. Collapsing them would
        make a box with one old settled chunk look permanently stalled."""
        self.chunk("a.wav", age=300)
        self.chunk("b.wav", age=120)
        age, settled = mic_watch.newest_chunks(self.recs, 15)
        self.assertAlmostEqual(age, 120, delta=5)
        self.assertTrue(settled.endswith("b.wav"), "newest settled chunk, not oldest")

    def test_empty_and_missing_directories_report_nothing_rather_than_zero(self):
        """WHY: main() distinguishes 'no chunks' (recorder_stalled) from 'fresh
        chunks'. A 0 here would read as 'a chunk written this instant' and hide
        a recorder that has never produced a byte."""
        self.assertEqual(mic_watch.newest_chunks(self.recs, 15), (None, None))
        self.assertEqual(mic_watch.newest_chunks(os.path.join(self.recs, "nope"), 15), (None, None))
        self.assertEqual(mic_watch.newest_chunks("", 15), (None, None))

    def test_chunk_consumed_mid_scan_does_not_lose_the_survivors(self):
        """WHY: the analyser deletes chunks between the glob and the stat. That
        race must cost one file, not the whole scan -- an exception here would
        take the timer red on a perfectly healthy mic."""
        doomed = self.chunk("doomed.wav", age=1)
        keep = self.chunk("keep.wav", age=90)
        real = os.path.getmtime

        def flaky(p):
            if p == doomed:
                raise OSError("consumed by birdnet_analysis mid-scan")
            return real(p)

        with mock.patch("os.path.getmtime", side_effect=flaky):
            age, settled = mic_watch.newest_chunks(self.recs, 15)
        self.assertEqual(settled, keep)
        self.assertAlmostEqual(age, 90, delta=5)

    def test_recording_length_drives_the_settled_cutoff(self):
        """WHY: the cutoff is derived from RECORDING_LENGTH, not a constant. A
        site recording 60s segments must not treat a 30s-old chunk -- still being
        written -- as settled just because 15s boxes would have finished it."""
        self.chunk("a.wav", age=30)
        self.assertTrue(mic_watch.newest_chunks(self.recs, 15)[1].endswith("a.wav"))
        # rec_len 60 -> cutoff 65 -> nothing settled -> fallback returns it anyway,
        # which is the point: the scan runs either way, only the reason changes.
        self.assertTrue(mic_watch.newest_chunks(self.recs, 60)[1].endswith("a.wav"))

    def test_non_wav_files_are_ignored(self):
        """WHY: StreamData also collects .mp3/.txt debris on some installs;
        handing one to wave.open would burn the scan on an unreadable file."""
        with open(os.path.join(self.stream, "notes.txt"), "w") as f:
            f.write("x")
        self.assertEqual(mic_watch.newest_chunks(self.recs, 15), (None, None))


class CardStatusTest(unittest.TestCase):
    """card_status has THREE answers and 'unknown' must never page. The whole
    doctrine of this watchdog is that it acts on positive evidence of death, so
    every unknowable branch here is a deliberate silence, not an oversight."""

    def test_name_pinned_card_present(self):
        """WHY: the recommended, re-enumeration-proof form. It must resolve to
        'present' from /proc/asound alone -- opening the device would fight
        birdnet_recording.sh for the mic."""
        with mock.patch("builtins.open", mock.mock_open(read_data=CARDS)):
            status, detail = mic_watch.card_status("plughw:CARD=Device")
        self.assertEqual(status, "present")
        self.assertIn("Device", detail)

    def test_name_pinned_card_absent_names_what_is_actually_there(self):
        """WHY: this alert's whole value is telling the operator which name to
        pin instead. 'card absent' without the surviving ids sends them to
        `arecord -L` on a box they may not be able to reach."""
        with mock.patch("builtins.open", mock.mock_open(read_data=CARDS)):
            status, detail = mic_watch.card_status("plughw:CARD=Snowball")
        self.assertEqual(status, "absent")
        self.assertIn("Snowball", detail)
        self.assertIn("Device", detail, "the detail must list the cards that ARE present")

    def test_no_proc_asound_is_unknown_not_absent(self):
        """WHY: a developer laptop, a container, or this very test suite has no
        /proc/asound. Reading that as 'absent' would page from every box that
        ever ran the script once."""
        with mock.patch("builtins.open", side_effect=OSError("no such file")):
            status, _ = mic_watch.card_status("plughw:CARD=Device")
        self.assertEqual(status, "unknown")

    def test_index_pinned_card_present(self):
        """WHY: index pinning is what the installer's default writes, so it is
        the form most boxes actually run."""
        with mock.patch("os.path.isdir", side_effect=lambda p: p in ("/proc/asound", "/proc/asound/card1")):
            status, detail = mic_watch.card_status("plughw:1")
        self.assertEqual(status, "present")
        self.assertIn("index-pinned", detail)

    def test_index_pinned_card_gone_is_the_reenumeration_failure(self):
        """WHY: THE bug this module exists for -- a USB brown-out re-enumerates
        the mic as card 2, birdnet keeps recording silence from card 1 forever,
        and nothing crashes. Both `hw:` and `plughw:` spellings must catch it."""
        with mock.patch("os.path.isdir", side_effect=lambda p: p == "/proc/asound"):
            self.assertEqual(mic_watch.card_status("plughw:1")[0], "absent")
            self.assertEqual(mic_watch.card_status("hw:1")[0], "absent")

    def test_index_pinned_without_proc_asound_is_unknown(self):
        """WHY: same doctrine as the name-pinned branch -- no /proc means no
        evidence, and no evidence is never death."""
        with mock.patch("os.path.isdir", return_value=False):
            self.assertEqual(mic_watch.card_status("plughw:1")[0], "unknown")

    def test_default_card_uses_arecord_listing(self):
        """WHY: REC_CARD=default (PulseAudio) names no card, so the only
        answerable question is whether ANY capture device survives. `arecord -l`
        reads /proc only -- it never opens a device."""
        runner = FakeRun(stdout_for={"arecord -l": ARECORD_ONE})
        with mock.patch("mic_watch.shutil.which", return_value="/usr/bin/arecord"), \
                mock.patch("mic_watch.subprocess.run", runner):
            self.assertEqual(mic_watch.card_status("default")[0], "present")
            self.assertEqual(mic_watch.card_status("")[0], "present", "empty REC_CARD takes the same path")

    def test_default_card_with_no_capture_device_is_absent(self):
        """WHY: proves the branch above is not vacuous -- with the same code path
        and a stripped listing it must reach 'absent', or REC_CARD=default boxes
        silently have no card check at all."""
        runner = FakeRun(stdout_for={"arecord -l": ARECORD_NONE})
        with mock.patch("mic_watch.shutil.which", return_value="/usr/bin/arecord"), \
                mock.patch("mic_watch.subprocess.run", runner):
            self.assertEqual(mic_watch.card_status("default")[0], "absent")

    def test_missing_or_failing_arecord_is_unknown(self):
        """WHY: no arecord means a dev box; an arecord that hangs or dies means a
        broken box. Neither is evidence that the microphone died."""
        with mock.patch("mic_watch.shutil.which", return_value=None):
            self.assertEqual(mic_watch.card_status("default")[0], "unknown")
        with mock.patch("mic_watch.shutil.which", return_value="/usr/bin/arecord"), \
                mock.patch("mic_watch.subprocess.run", FakeRun(raise_for=("arecord",))):
            self.assertEqual(mic_watch.card_status("default")[0], "unknown")


class RecorderUnitTest(unittest.TestCase):
    """The recorder is DETECTED, not hardcoded: BirdNET-Pi ships two mutually
    exclusive recording units and the freshness check is only valid for one of
    them (custom_recording duty-cycles into EXTRACTED/Raw, not StreamData)."""

    def units(self, listed, enabled="enabled", active="active", raise_for=()):
        runner = FakeRun(stdout_for={"list-unit-files": listed,
                                     "is-enabled": enabled,
                                     "is-active": active}, raise_for=raise_for)
        with mock.patch("mic_watch.shutil.which", return_value="/bin/systemctl"), \
                mock.patch("mic_watch.subprocess.run", runner):
            return mic_watch.recorder_unit(), runner

    def test_no_systemctl_skips_all_service_logic(self):
        """WHY: on a dev box every service answer is a guess, and a guess that
        says 'enabled' would make the freshness check page about a recorder that
        was never installed."""
        with mock.patch("mic_watch.shutil.which", return_value=None):
            self.assertEqual(mic_watch.recorder_unit(), (None, False, False))

    def test_birdnet_recording_detected_enabled_and_active(self):
        (unit, enabled, active), runner = self.units(UNIT + " enabled enabled\n")
        self.assertEqual((unit, enabled, active), RUNNING)
        self.assertTrue(runner.matching("is-enabled", UNIT))
        self.assertTrue(runner.matching("is-active", UNIT))

    def test_birdnet_recording_wins_when_both_units_exist(self):
        """WHY: an upgraded box can carry both unit files. Picking
        custom_recording there would disable the freshness leg on a station that
        genuinely writes StreamData."""
        (unit, _, _), _ = self.units(UNIT + " enabled\ncustom_recording.service disabled\n")
        self.assertEqual(unit, UNIT)

    def test_custom_recording_detected_when_it_is_the_only_unit(self):
        """WHY: main() keys the freshness leg on the unit NAME, so mis-detecting
        this one turns a duty-cycled recorder into a permanent false alarm."""
        (unit, _, _), _ = self.units("custom_recording.service enabled\n")
        self.assertEqual(unit, "custom_recording.service")

    def test_neither_unit_installed_reports_nothing(self):
        (unit, enabled, active), _ = self.units("")
        self.assertEqual((unit, enabled, active), (None, False, False))

    def test_disabled_or_inactive_is_reported_not_swallowed(self):
        """WHY: 'enabled but not active' is main()'s crash-loop signal and
        'disabled' is operator intent. Collapsing them loses both."""
        self.assertEqual(self.units(UNIT + "\n", enabled="disabled")[0], (UNIT, False, True))
        self.assertEqual(self.units(UNIT + "\n", active="inactive")[0], (UNIT, True, False))

    def test_unanswerable_systemctl_reports_no_unit(self):
        """WHY (pins a KNOWN FAIL-OPEN, deliberately): if systemd is degraded or
        dbus is down, sysctl() swallows the exception, `listed` is empty, and the
        recorder simply looks absent -- which silences main()'s freshness leg on
        a real station. frame_watch closed exactly this hole for the frame
        (test_unanswerable_systemctl_with_a_config_alerts); mic_watch has NOT.
        Pinned so the hole is visible and closing it must change a test."""
        (unit, enabled, active), _ = self.units("", raise_for=("list-unit-files",))
        self.assertEqual((unit, enabled, active), (None, False, False))


class MainTest(unittest.TestCase):
    """main() end to end: three checks, a debounce, a bounded self-heal and a
    one-alert-per-outage state machine, over real config and real wav fixtures."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.addCleanup(self.tmp.cleanup)
        saved = {k: getattr(mic_watch, k) for k in
                 ("CONF", "STATE", "NOTIFY", "THRESH", "HEAL_LIMIT", "STALE_SECS", "FLATLINE_P2P")}
        self.addCleanup(lambda: [setattr(mic_watch, k, v) for k, v in saved.items()])
        mic_watch.CONF = os.path.join(self.dir, "birdnet.conf")
        mic_watch.STATE = os.path.join(self.dir, "state", "mic-watch.state")
        mic_watch.NOTIFY = ""             # no test may ever reach the network
        mic_watch.THRESH = 2
        mic_watch.HEAL_LIMIT = 3
        mic_watch.STALE_SECS = 600
        self.recs = os.path.join(self.dir, "BirdSongs")
        self.stream = os.path.join(self.recs, "StreamData")
        os.makedirs(self.stream)

    # --- fixture helpers ---------------------------------------------------
    def write_conf(self, rec_card="plughw:CARD=Device", rtsp="", rec_len=15, user=""):
        with open(mic_watch.CONF, "w") as f:
            f.write('RECS_DIR="%s"\nREC_CARD="%s"\nRTSP_STREAM="%s"\n'
                    'RECORDING_LENGTH="%d"\nBIRDNET_USER="%s"\n'
                    % (self.recs, rec_card, rtsp, rec_len, user))

    def seed_chunk(self, samples, name="in-flight.wav", age=0.0):
        p = write_wav(os.path.join(self.stream, name), samples)
        os.utime(p, (time.time() - age, time.time() - age))
        return p

    def seed_state(self, **kw):
        os.makedirs(os.path.dirname(mic_watch.STATE), exist_ok=True)
        with open(mic_watch.STATE, "w") as f:
            json.dump(kw, f)

    def read_state(self):
        with open(mic_watch.STATE) as f:
            return json.load(f)

    def tick(self, unit=RUNNING, card=CARD_OK):
        """One timer firing. recorder_unit/card_status are fixtures (their own
        classes above exercise the real probes); subprocess is faked so a
        self-heal cannot restart anything on the CI runner."""
        buf = StringIO()
        runner = FakeRun()
        with mock.patch.object(mic_watch, "recorder_unit", return_value=unit), \
                mock.patch.object(mic_watch, "card_status", return_value=card) as cs, \
                mock.patch.object(mic_watch, "notify") as n, \
                mock.patch("mic_watch.shutil.which", return_value="/bin/systemctl"), \
                mock.patch("mic_watch.subprocess.run", runner), \
                redirect_stdout(buf):
            rc = mic_watch.main()
        return Tick(rc, n, buf.getvalue(), runner, cs)

    # --- the mic is present and recording silence --------------------------
    def test_flatlined_in_flight_chunk_alerts_exactly_once(self):
        """WHY: the end-to-end form of 7851134. The ONLY file on the box is the
        chunk currently being written, the card is present and the recorder is
        active -- so every other check passes and this is the one guard standing
        between a dead mic and seven silent days. It must fire, it must wait for
        the debounce, and it must never fire twice for one outage (the shared
        ntfy topic also carries the frame and Railway alerts)."""
        self.write_conf()
        self.seed_chunk(dc(2 * RATE, 0), age=0)
        self.assertEqual(len(os.listdir(self.stream)), 1, "fixture must reproduce the Pi: ONE wav")

        t = self.tick()
        self.assertEqual(t.rc, 1)
        t.notify.assert_not_called()                       # one tick is not evidence
        self.assertIn("FAIL 1/2", t.out)

        t = self.tick()
        self.assertEqual(t.rc, 1)
        self.assertEqual(t.notify.call_count, 1)
        msg, title, tag = t.notify.call_args[0][:3]
        self.assertIn("MIC FLATLINE", msg)
        self.assertIn("in-flight.wav", msg)
        self.assertEqual(title, "Christina mic DOWN")
        self.assertEqual(tag, "warning")

        t = self.tick()
        self.assertEqual(t.rc, 1)
        t.notify.assert_not_called()                       # never a second push
        self.assertEqual(self.read_state()["down"], True)

    def test_live_noise_floor_never_alerts_and_proves_the_scan_ran(self):
        """WHY: the false-positive direction, and the journal line that would
        have exposed 7851134 in a day. 'audio has a live noise floor' is the ONLY
        evidence anywhere that the flatline scan executed at all -- its absence
        for seven days was the proof the scan was unreachable."""
        self.write_conf()
        self.seed_chunk(swing(2 * RATE, 400), age=0)
        for _ in range(3):
            t = self.tick()
            self.assertEqual(t.rc, 0)
            t.notify.assert_not_called()
            self.assertIn("audio has a live noise floor", t.out)

    def test_stale_chunk_cannot_speak_for_the_microphone_now(self):
        """WHY: only a FRESH chunk is evidence about the mic's current state.
        Judging an hours-old flatlined file would page about a mic that has since
        been fixed -- or forever, on a box whose recorder is off by intent."""
        self.write_conf()
        self.seed_chunk(dc(2 * RATE, 0), name="ancient.wav", age=5000)
        t = self.tick(unit=(None, False, False))
        self.assertEqual(t.rc, 0)
        t.notify.assert_not_called()
        self.assertNotIn("FLATLINE", t.out)

    def test_flatline_leg_survives_a_box_with_no_systemd_answer(self):
        """WHY: the freshness leg needs systemd, the flatline leg does not. A
        station whose systemctl cannot answer must still report a dead mic
        instead of degrading to a fully silent watchdog."""
        self.write_conf()
        self.seed_chunk(dc(2 * RATE, 0), age=0)
        self.tick(unit=(None, False, False))
        t = self.tick(unit=(None, False, False))
        self.assertEqual(t.rc, 1)
        self.assertIn("MIC FLATLINE", t.notify.call_args[0][0])
        self.assertIn("self-heal skipped", t.out)

    # --- the recorder itself stopped ---------------------------------------
    def test_enabled_but_inactive_recorder_is_stalled(self):
        """WHY: a crash-looping or start-failed unit writes nothing, but every
        timestamp still on disk is inside its budget for the first few minutes.
        Only the unit state exposes it early."""
        self.write_conf()
        self.seed_chunk(swing(2 * RATE, 400), age=0)
        self.tick(unit=(UNIT, True, False))
        t = self.tick(unit=(UNIT, True, False))
        self.assertEqual(t.rc, 1)
        self.assertIn("RECORDING STALLED", t.notify.call_args[0][0])
        self.assertIn("enabled but not active", t.notify.call_args[0][0])

    def test_no_chunks_at_all_is_positive_evidence_when_enabled(self):
        """WHY: an empty StreamData under an ENABLED recorder is the 'installed
        and never recorded' case -- absence is evidence here, not ignorance."""
        self.write_conf()
        self.tick()
        t = self.tick()
        self.assertEqual(t.rc, 1)
        self.assertIn("RECORDING STALLED", t.notify.call_args[0][0])
        self.assertIn("no audio chunks", t.notify.call_args[0][0])

    def test_disabled_recorder_is_operator_intent(self):
        """WHY: the same empty directory under a DISABLED unit is a deliberate
        choice. Paging about it is precisely how an alert channel gets muted --
        and the second half proves this silence is scoped, not blanket."""
        self.write_conf()
        t = self.tick(unit=(UNIT, False, False))
        self.assertEqual(t.rc, 0)
        t.notify.assert_not_called()
        self.assertEqual(self.tick(unit=(UNIT, True, True)).rc, 1)

    def test_budget_is_derived_from_recording_length_not_a_constant(self):
        """WHY: a site recording long segments legitimately goes minutes between
        files. A fixed threshold would either cry wolf there or blind the check
        on a 15s box; the budget must be max(STALE_SECS, 4*RECORDING_LENGTH)."""
        self.write_conf(rec_len=15)
        self.seed_chunk(swing(2 * RATE, 400), name="old.wav", age=90)
        mic_watch.STALE_SECS = 30                      # budget = max(30, 60) = 60
        t = self.tick()
        self.assertEqual(t.rc, 1)
        self.assertIn("recorder_stalled", t.out)

        mic_watch.STALE_SECS = 600                     # budget = 600, same fixture
        t = self.tick()
        self.assertEqual(t.rc, 0)
        t.notify.assert_not_called()

    # --- the card vanished --------------------------------------------------
    def test_card_absent_alert_prescribes_name_pinning(self):
        """WHY: the operator is being paged about a $17 mic that re-enumerated.
        Without the `REC_CARD=plughw:CARD=<name>` prescription in the message
        they will replug it and be paged again next brown-out. The watchdog
        never edits birdnet.conf itself -- so the alert has to carry the fix."""
        self.write_conf()
        self.seed_chunk(swing(2 * RATE, 400), age=0)
        absent = ("absent", "card Snowball not in /proc/asound/cards (have: ['Headphones'])")
        self.tick(card=absent)
        t = self.tick(card=absent)
        self.assertEqual(t.rc, 1)
        msg = t.notify.call_args[0][0]
        self.assertIn("MIC GONE", msg)
        self.assertIn("REC_CARD=plughw:CARD=", msg)

    def test_card_absent_outranks_the_later_checks(self):
        """WHY: a missing card makes every downstream verdict noise. The alert
        must name the root cause, not the symptom the operator cannot act on."""
        self.write_conf()
        self.seed_chunk(dc(2 * RATE, 0), age=0)        # ALSO flatlined
        self.tick(card=("absent", "gone"))
        t = self.tick(card=("absent", "gone"))
        self.assertIn("MIC GONE", t.notify.call_args[0][0])
        self.assertNotIn("MIC FLATLINE", t.notify.call_args[0][0])

    def test_rtsp_install_skips_the_card_check_entirely(self):
        """WHY: an RTSP source has no local capture card to lose, so running the
        check would be a permanent false alarm on every network-audio station."""
        self.write_conf(rtsp="rtsp://cam.local/audio")
        self.seed_chunk(swing(2 * RATE, 400), age=0)
        t = self.tick()
        self.assertEqual(t.rc, 0)
        self.assertIn("RTSP source, card check skipped", t.out)
        t.card.assert_not_called()

    # --- recovery, self-heal, and the box that is not a station -------------
    def test_recovery_notice_fires_once_and_resets_the_counters(self):
        """WHY: the operator must learn the mic came back without walking to the
        Pi -- and must not be told twice. Leaving `heals` set would also silently
        spend the next outage's restart budget."""
        self.write_conf()
        self.seed_chunk(swing(2 * RATE, 400), age=0)
        self.seed_state(fails=2, down=True, heals=3)

        t = self.tick()
        self.assertEqual(t.rc, 0)
        self.assertEqual(t.notify.call_count, 1)
        self.assertIn("RECOVERED", t.notify.call_args[0][0])
        self.assertEqual(t.notify.call_args[0][1], "Christina mic OK")
        self.assertEqual(self.read_state(), {"fails": 0, "down": False, "heals": 0})

        t = self.tick()
        self.assertEqual(t.rc, 0)
        t.notify.assert_not_called()

    def test_self_heal_is_bounded_at_heal_limit(self):
        """WHY: restarting the recorder is the fix for a re-enumerated mic, but
        an unbounded retry against an unplugged one is a restart storm that
        shreds the SD card and fills the journal for as long as nobody looks."""
        self.write_conf()
        self.seed_chunk(dc(2 * RATE, 0), age=0)
        restarts = []
        for _ in range(5):
            restarts += self.tick().runner.matching("systemctl", "restart")
        self.assertEqual(len(restarts), mic_watch.HEAL_LIMIT)
        self.assertTrue(all(c[-1] == UNIT for c in restarts), "must restart the DETECTED unit")

    def test_self_heal_never_runs_for_a_disabled_recorder(self):
        """WHY: starting a unit the operator deliberately disabled is the
        watchdog overruling its owner."""
        self.write_conf()
        self.seed_chunk(dc(2 * RATE, 0), age=0)
        t = self.tick(unit=(UNIT, False, False), card=("absent", "gone"))
        self.assertEqual(t.runner.matching("systemctl", "restart"), [])

    def test_a_failing_self_heal_still_reaches_the_alert(self):
        """WHY: the restart is best-effort; the alert is the point. If a raising
        systemctl propagated, the operator would get no page AND no restart --
        the worst of both, on the box least able to recover on its own."""
        self.write_conf()
        self.seed_chunk(dc(2 * RATE, 0), age=0)
        buf = StringIO()
        runner = FakeRun(raise_for=("systemctl restart",))
        for i in range(2):
            with mock.patch.object(mic_watch, "recorder_unit", return_value=RUNNING), \
                    mock.patch.object(mic_watch, "card_status", return_value=CARD_OK), \
                    mock.patch.object(mic_watch, "notify") as n, \
                    mock.patch("mic_watch.shutil.which", return_value="/bin/systemctl"), \
                    mock.patch("mic_watch.subprocess.run", runner), \
                    redirect_stdout(buf):
                self.assertEqual(mic_watch.main(), 1)
                if i == 1:
                    self.assertIn("MIC FLATLINE", n.call_args[0][0])
        self.assertIn("self-heal failed", buf.getvalue())
        self.assertEqual(self.read_state()["heals"], 0, "a failed restart must not spend the budget")

    def test_missing_config_is_not_a_birdnet_box(self):
        """WHY: the timer ships in a repo people clone. Exit 2 with no alert on a
        box that has no birdnet.conf -- a watchdog that pages from a random Linux
        machine is a watchdog nobody keeps installed."""
        mic_watch.CONF = os.path.join(self.dir, "nope.conf")
        t = self.tick()
        self.assertEqual(t.rc, 2)
        t.notify.assert_not_called()

    def test_healthy_box_with_nothing_checkable_says_so(self):
        """WHY: 'OK' with an empty trail would read identically to 'OK, three
        checks passed'. The honest line is what makes an all-unknown box (the
        state 7851134 had effectively created) visible in the journal."""
        self.write_conf(rtsp="rtsp://cam.local/audio")
        t = self.tick(unit=(None, False, False))
        self.assertEqual(t.rc, 0)
        self.assertIn("RTSP source, card check skipped", t.out)


class NotifyTest(unittest.TestCase):
    """notify() fans one message out to stdout (the journal), ntfy, and apprise.
    Every leg past the print is optional and every one of them must be unable to
    take the others down -- notify() is called BEFORE save_state(), so an
    exception escaping it leaves `down` unwritten and re-fires the same DOWN
    alert on every tick, forever."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = self.tmp.name
        self.addCleanup(self.tmp.cleanup)
        saved = mic_watch.NOTIFY
        self.addCleanup(lambda: setattr(mic_watch, "NOTIFY", saved))
        mic_watch.NOTIFY = ""
        self.pi_dir = os.path.join(self.home, "BirdNET-Pi")
        self.cfg = os.path.join(self.pi_dir, "apprise.txt")
        self.binp = os.path.join(self.pi_dir, "birdnet", "bin", "apprise")
        os.makedirs(os.path.join(self.pi_dir, "birdnet", "bin"))

    def write_cfg(self, body="mailto://x\n"):
        with open(self.cfg, "w") as f:
            f.write(body)

    def write_bin(self):
        with open(self.binp, "w") as f:
            f.write("#!/bin/sh\n")

    def fire(self, runner=None):
        runner = runner or FakeRun()
        buf = StringIO()
        with mock.patch("os.path.expanduser", return_value=self.home), \
                mock.patch("mic_watch.subprocess.run", runner), \
                redirect_stdout(buf):
            mic_watch.notify("MIC FLATLINE: detail", "Christina mic DOWN", "warning", "birdnet")
        return runner, buf.getvalue()

    def test_message_always_reaches_the_journal(self):
        """WHY: with no ntfy topic and no apprise config the print IS the alert.
        journalctl is the only record the operator can reach on a dead box."""
        _, out = self.fire()
        self.assertIn("MIC FLATLINE: detail", out)

    def test_apprise_not_invoked_when_the_binary_is_absent(self):
        """WHY (mic_watch.py:217-226): the venv is missing on any box that did
        not install BirdNET-Pi's apprise extra, and on the DR/restore path before
        the venv is rebuilt. Running it would raise inside the alert path."""
        self.write_cfg()                                 # config present, binary is NOT
        runner, out = self.fire()
        self.assertEqual(runner.calls, [])
        self.assertNotIn("apprise notify failed", out, "an absent binary is not an error to report")

    def test_apprise_not_invoked_without_a_config(self):
        """WHY: apprise with no config file is a no-op subprocess on every tick
        of every timer -- and it would still be spawned 96 times a day."""
        self.write_bin()                                 # binary present, config is NOT
        self.assertEqual(self.fire()[0].calls, [])

    def test_apprise_not_invoked_for_an_empty_config(self):
        """WHY: BirdNET-Pi's installer creates apprise.txt empty. Existence is
        not configuration -- the size gate is what distinguishes them."""
        self.write_cfg("")
        self.write_bin()
        self.assertEqual(self.fire()[0].calls, [])

    def test_apprise_is_invoked_when_both_halves_are_present(self):
        """WHY: proves the three negatives above are gates and not a leg that
        never runs at all -- the exact vacuity that would make this alert channel
        silently dead on the boxes that DO configure it."""
        self.write_cfg()
        self.write_bin()
        runner, _ = self.fire()
        self.assertEqual(len(runner.calls), 1)
        self.assertEqual(runner.calls[0],
                         [self.binp, "-t", "Christina mic DOWN", "-b", "MIC FLATLINE: detail",
                          "--config", self.cfg])

    def test_a_raising_apprise_is_reported_not_propagated(self):
        """WHY: an exception here escapes main() before save_state(), so `down`
        is never persisted and the same outage re-alerts on every single tick."""
        self.write_cfg()
        self.write_bin()
        _, out = self.fire(FakeRun(raise_for=("apprise",)))
        self.assertIn("apprise notify failed", out)

    def test_a_dead_ntfy_topic_is_reported_not_propagated(self):
        """WHY: the same rule for the primary channel. ntfy being unreachable is
        exactly the moment the operator most needs the state machine to keep
        working -- and the apprise fallback to still be attempted."""
        mic_watch.NOTIFY = "https://ntfy.example.invalid/christina"
        self.write_cfg()
        self.write_bin()
        runner = FakeRun()
        buf = StringIO()
        with mock.patch("os.path.expanduser", return_value=self.home), \
                mock.patch("mic_watch.subprocess.run", runner), \
                mock.patch("mic_watch.urllib.request.urlopen", side_effect=OSError("connection refused")), \
                redirect_stdout(buf):
            mic_watch.notify("m", "t", "warning", "birdnet")
        self.assertIn("notify failed", buf.getvalue())
        self.assertEqual(len(runner.calls), 1, "the apprise fallback must still be attempted")

    def test_empty_notify_url_never_touches_urllib(self):
        """WHY: the suite's own safety property -- with NOTIFY forced empty no
        test can reach the network even if a patch is forgotten."""
        with mock.patch("mic_watch.urllib.request.urlopen") as u:
            self.fire()
        u.assert_not_called()


class StateContractTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.addCleanup(self.tmp.cleanup)
        saved = mic_watch.STATE
        self.addCleanup(lambda: setattr(mic_watch, "STATE", saved))

    def test_state_write_is_atomic_and_creates_its_directory(self):
        """WHY: a power cut mid-write on an RTC-less Pi is routine, and a
        truncated state file makes load_state fall back to down=False -- which
        re-fires the same DOWN alert for the same outage, forever."""
        mic_watch.STATE = os.path.join(self.dir, "sub", "mic-watch.state")
        mic_watch.save_state({"fails": 2, "down": True, "heals": 1})
        self.assertEqual(mic_watch.load_state(), {"fails": 2, "down": True, "heals": 1})
        self.assertFalse(os.path.exists(mic_watch.STATE + ".tmp"),
                         "a .tmp sibling left behind means the write was not atomic")

    def test_missing_or_corrupt_state_falls_back_to_healthy_zero(self):
        """WHY: the fallback must be a clean slate, not a crash -- the first run
        on a new box has no state file at all. It is also the reason the write
        above must be atomic: this recovery silently forgives `down`."""
        mic_watch.STATE = os.path.join(self.dir, "mic-watch.state")
        self.assertEqual(mic_watch.load_state(), {"fails": 0, "down": False, "heals": 0})
        with open(mic_watch.STATE, "w") as f:
            f.write('{"fails": 2, "dow')
        self.assertEqual(mic_watch.load_state(), {"fails": 0, "down": False, "heals": 0})


class ConfigTest(unittest.TestCase):
    """read_conf shell-sources birdnet.conf, the repo-canonical pattern -- the
    same file scripts/*.sh source, so the watchdog can never disagree with the
    recorder about which card or directory is configured."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.addCleanup(self.tmp.cleanup)
        saved = mic_watch.CONF
        self.addCleanup(lambda: setattr(mic_watch, "CONF", saved))
        mic_watch.CONF = os.path.join(self.dir, "birdnet.conf")

    def write(self, text):
        with open(mic_watch.CONF, "w") as f:
            f.write(text)

    def test_shell_quoting_and_expansion_are_honoured(self):
        """WHY: birdnet.conf is SHELL, not ini. A regex parser would mangle the
        `RECS_DIR=${HOME}/BirdSongs` form the installer writes, and the watchdog
        would then watch a directory nobody records into."""
        self.write('BIRDNET_USER="birdnet"\nRECS_DIR="/home/${BIRDNET_USER}/BirdSongs"\n'
                   'REC_CARD="plughw:CARD=Device"\nRECORDING_LENGTH="15"\n')
        conf = mic_watch.read_conf()
        self.assertEqual(conf["recs_dir"], "/home/birdnet/BirdSongs")
        self.assertEqual(conf["rec_card"], "plughw:CARD=Device")
        self.assertEqual(conf["rec_len"], 15)

    def test_bad_recording_length_falls_back_to_the_recorder_default(self):
        """WHY: rec_len drives BOTH the freshness budget and the settled-chunk
        cutoff. A 0 or a typo would make the budget 600s-or-nothing and the
        cutoff meaningless; 15 is birdnet_recording.sh's own default."""
        for bad in ('RECORDING_LENGTH="abc"', 'RECORDING_LENGTH="0"', ""):
            self.write('RECS_DIR="/x"\n' + bad + "\n")
            self.assertEqual(mic_watch.read_conf()["rec_len"], 15, bad)

    def test_unsourceable_config_degrades_to_empty_SILENTLY(self):
        """WHY (pins a KNOWN SILENT DEGRADATION, deliberately): a syntax error in
        birdnet.conf must not crash the timer, and it does not -- but it also
        says NOTHING. Measured: bash reports `unexpected EOF` on stderr and then,
        with no `set -e`, runs the printf anyway and exits 0. read_conf uses
        capture_output=True without check=True, so the exception handler never
        fires, stderr is captured and dropped on the floor, and every value comes
        back empty with a clean journal.

        The read_conf docstring's `could not source` line only ever prints if
        subprocess itself fails (bash missing, timeout) -- never for a bad
        config. Pinned as-is so the hole is visible; closing it (read
        r.stderr / r.returncode and print) must change this test."""
        self.write("RECS_DIR=(this is not valid shell\n")
        buf = StringIO()
        with redirect_stdout(buf):
            conf = mic_watch.read_conf()
        self.assertEqual(conf["recs_dir"], "")
        self.assertEqual(conf["rec_card"], "")
        self.assertEqual(buf.getvalue(), "",
                         "if this now prints, the silent leg was fixed -- good; assert the new "
                         "message instead of this emptiness")

    def test_a_broken_config_misdiagnoses_the_outage(self):
        """WHY: the operational cost of the silence above. With recs_dir empty,
        the freshness leg looks in `/StreamData`, finds nothing, and pages
        RECORDING STALLED -- sending the operator to journalctl for the recorder
        when the actual fault is one unbalanced paren in birdnet.conf. The `/`
        prefix in the message is the only clue, and it is not one anybody reads.
        A watchdog that alerts for the wrong reason still beats silence, so this
        is a defect to fix upward, not a reason to weaken the alert."""
        self.write("RECS_DIR=(this is not valid shell\n")
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        saved = {k: getattr(mic_watch, k) for k in ("STATE", "NOTIFY", "THRESH")}
        self.addCleanup(lambda: [setattr(mic_watch, k, v) for k, v in saved.items()])
        mic_watch.STATE = os.path.join(tmp.name, "mic-watch.state")
        mic_watch.NOTIFY = ""
        mic_watch.THRESH = 1
        with mock.patch.object(mic_watch, "recorder_unit", return_value=RUNNING), \
                mock.patch.object(mic_watch, "card_status", return_value=CARD_OK), \
                mock.patch.object(mic_watch, "notify") as n, \
                mock.patch("mic_watch.shutil.which", return_value=None), \
                redirect_stdout(StringIO()):
            self.assertEqual(mic_watch.main(), 1)
        msg = n.call_args[0][0]
        self.assertIn("RECORDING STALLED", msg)
        self.assertIn("/StreamData", msg)
        self.assertNotIn("birdnet.conf", msg, "today the alert cannot name the real cause")


if __name__ == "__main__":
    unittest.main()
