#!/usr/bin/env python3
"""Mic-loss watchdog for the Christina recording pipeline (dead-USB-mic catcher).

A USB brown-out can re-enumerate the $17 mic as a new ALSA card index; BirdNET
then records silence forever with no crash and no alert. This watchdog runs
three PASSIVE checks (it never opens the audio device, so it can never fight
birdnet_recording.sh for the mic):

  1. card     -- the configured REC_CARD is still present (/proc/asound only;
                 skipped on RTSP installs, which have no local mic to lose).
  2. fresh    -- newest StreamData chunk is recent while birdnet_recording is
                 systemd-enabled (a deliberately DISABLED recorder is operator
                 intent, never a fault). NOTE: custom_recording.service
                 duty-cycles and writes to EXTRACTED/Raw, not StreamData, so
                 the freshness/flatline checks are skipped for it -- coverage
                 there degrades to card-presence + self-heal only.
  3. flatline -- peak-to-peak scan of the newest SETTLED (completed) chunk via
                 the wave module. A live mic always has a noise floor; a dead
                 one is all-zeros or constant DC. The threshold is biased tiny
                 on purpose: a quiet night must NEVER be called dead.

Anything unknowable (no /proc/asound on a dev box, unreadable wav, missing
arecord) counts as HEALTHY -- the watchdog acts only on positive evidence of
death. On death it self-heals (bounded `systemctl restart birdnet_recording`,
which also re-kicks pulseaudio via birdnet_recording.sh) and alerts exactly
once per outage, with one recovery notice when audio returns. It never
rewrites birdnet.conf -- the card_absent alert recommends name-pinning
(REC_CARD=plughw:CARD=<name>); the config change stays human.

Run periodically (systemd timer, every 15min). Config via env (EnvironmentFile):
  BIRDNET_CONF     (optional)  config path (default /etc/birdnet/birdnet.conf)
  MIC_WATCH_STATE  (optional)  state file (default ~/.christina/mic-watch.state)
  NOTIFY_URL       (optional)  ntfy topic POSTed on state change -- the same
                               var the railway-liveness check reads from
                               ~/.christina/forwarder.env.
  FAIL_THRESHOLD   (optional)  consecutive dead ticks before the single alert
                               (default 2)
  HEAL_LIMIT       (optional)  max restart attempts per outage (default 3 --
                               no restart storms)
  STALE_SECS       (optional)  freshness budget seconds (default 600);
                               effective budget = max(STALE_SECS, 4*RECORDING_LENGTH)
  FLATLINE_P2P     (optional)  16-bit LSB peak-to-peak at/below which a chunk
                               counts as a flat line (default 16)
"""
import os
import re
import sys
import json
import glob
import time
import wave
import array
import shutil
import subprocess
import urllib.request

CONF = os.environ.get("BIRDNET_CONF", "/etc/birdnet/birdnet.conf")
NOTIFY = os.environ.get("NOTIFY_URL", "").strip()
STATE = os.path.expanduser(os.environ.get("MIC_WATCH_STATE", "~/.christina/mic-watch.state"))
THRESH = int(os.environ.get("FAIL_THRESHOLD", "2"))
HEAL_LIMIT = int(os.environ.get("HEAL_LIMIT", "3"))
STALE_SECS = int(os.environ.get("STALE_SECS", "600"))
FLATLINE_P2P = int(os.environ.get("FLATLINE_P2P", "16"))


def read_conf():
    """Shell-source birdnet.conf -- the repo-canonical consumption pattern
    (every scripts/*.sh does `source /etc/birdnet/birdnet.conf`)."""
    script = ('source "$1"; printf "%s\\n" "$RECS_DIR" "$REC_CARD" "$RTSP_STREAM" '
              '"$RECORDING_LENGTH" "$BIRDNET_USER"')
    try:
        out = subprocess.run(["bash", "-c", script, "bash", CONF],
                             capture_output=True, text=True, timeout=10).stdout
    except Exception as e:
        print(f"could not source {CONF}: {e}", flush=True)
        out = ""
    recs_dir, rec_card, rtsp, rec_len, user = [v.strip() for v in (out.split("\n") + [""] * 5)[:5]]
    try:
        rec_len = int(rec_len)
    except ValueError:
        rec_len = 15  # birdnet_recording.sh default
    return {"recs_dir": recs_dir, "rec_card": rec_card, "rtsp": rtsp,
            "rec_len": rec_len if rec_len > 0 else 15, "user": user}


def card_status(rec_card):
    """('present'|'absent'|'unknown', detail). UNKNOWN ALWAYS COUNTS AS HEALTHY
    -- the watchdog only acts on positive evidence of death."""
    m = re.search(r"CARD=([A-Za-z0-9_-]+)", rec_card or "")
    if m:  # name-pinned (the recommended, re-enumeration-proof form)
        try:
            cards = open("/proc/asound/cards").read()
        except OSError:
            return "unknown", "no /proc/asound (not a Linux box)"
        ids = re.findall(r"^\s*\d+\s+\[(\S+)", cards, re.M)
        if m.group(1) in ids:
            return "present", f"card {m.group(1)} present"
        return "absent", f"card {m.group(1)} not in /proc/asound/cards (have: {ids})"
    m = re.match(r"(?:plug)?hw:(\d+)", rec_card or "")
    if m:  # index-pinned -- exactly what USB re-enumeration breaks
        if not os.path.isdir("/proc/asound"):
            return "unknown", "no /proc/asound (not a Linux box)"
        if os.path.isdir(f"/proc/asound/card{m.group(1)}"):
            return "present", f"card index {m.group(1)} present (index-pinned)"
        return "absent", f"/proc/asound/card{m.group(1)} missing (index-pinned)"
    # REC_CARD=default (PulseAudio) or empty: any capture card counts.
    # arecord -l only reads /proc -- it never opens a device.
    if shutil.which("arecord") is None:
        return "unknown", "arecord not installed (dev box)"
    try:
        out = subprocess.run(["arecord", "-l"], capture_output=True, text=True,
                             timeout=10).stdout
    except Exception as e:
        return "unknown", f"arecord -l failed: {e}"
    if "card " in out:
        return "present", "a capture card is present (REC_CARD=default)"
    return "absent", "arecord -l lists no capture card"


def recorder_unit():
    """(unit_name|None, enabled, active) -- detect the recorder, don't hardcode."""
    if shutil.which("systemctl") is None:
        return None, False, False  # dev box: all service logic skipped

    def sysctl(*args):
        try:
            return subprocess.run(["systemctl", *args], capture_output=True,
                                  text=True, timeout=10).stdout
        except Exception:
            return ""

    listed = sysctl("list-unit-files", "birdnet_recording.service", "custom_recording.service")
    unit = None
    if "birdnet_recording.service" in listed:
        unit = "birdnet_recording.service"
    elif "custom_recording.service" in listed:
        unit = "custom_recording.service"
    if unit is None:
        return None, False, False
    return (unit,
            sysctl("is-enabled", unit).strip() == "enabled",
            sysctl("is-active", unit).strip() == "active")


def newest_chunks(recs_dir, rec_len):
    """(newest_age_secs|None, settled_path|None). Settled = newest COMPLETED
    segment (mtime older than one segment: arecord/ffmpeg is no longer writing
    it, so reading it can never contend for anything)."""
    wavs = glob.glob(os.path.join(recs_dir, "StreamData", "*.wav")) if recs_dir else []
    now = time.time()
    ages = []
    for p in wavs:
        try:
            ages.append((now - os.path.getmtime(p), p))
        except OSError:
            pass  # chunk moved out by birdnet_analysis mid-scan
    if not ages:
        return None, None
    ages.sort()
    settled = next((p for age, p in ages if age > rec_len + 5), None)
    return ages[0][0], settled


def flatline(path):
    """True = flat line, False = live noise floor, None = unreadable (skip the
    check and say why -- silence, not fabrication)."""
    try:
        with wave.open(path, "rb") as w:
            if w.getsampwidth() != 2:
                return None  # chunks are pcm_s16le (birdnet_recording.sh)
            frames = w.readframes(min(w.getnframes(), 5 * w.getframerate()))
        samples = array.array("h", frames[:(len(frames) // 2) * 2])
        if not samples:
            return None
        # Constant-DC dead ADC -> max == min -> caught; a quiet night's noise
        # floor is tens-to-hundreds of LSB peak-to-peak -> passes.
        return (max(samples) - min(samples)) <= FLATLINE_P2P
    except Exception as e:
        print(f"flatline scan skipped ({os.path.basename(path)}): {e}", flush=True)
        return None


def notify(msg, title, tag, user=""):
    print(msg, flush=True)
    if NOTIFY:
        try:
            req = urllib.request.Request(
                NOTIFY, data=msg.encode("utf-8"),
                headers={"Title": title, "Priority": "high", "Tags": tag})
            urllib.request.urlopen(req, timeout=10)
        except Exception as e:
            print(f"notify failed: {e}", flush=True)
    # Optional apprise leg (mirrors scripts/species_notifier.sh): reaches the
    # operator's existing channels even with no ntfy topic configured.
    try:
        home = os.path.expanduser(f"~{user}" if user else "~")
        cfg = os.path.join(home, "BirdNET-Pi", "apprise.txt")
        binp = os.path.join(home, "BirdNET-Pi", "birdnet", "bin", "apprise")
        if os.path.isfile(cfg) and os.path.getsize(cfg) > 0 and os.path.exists(binp):
            subprocess.run([binp, "-t", title, "-b", msg, "--config", cfg], timeout=30)
    except Exception as e:
        print(f"apprise notify failed: {e}", flush=True)


def load_state():
    try:
        return json.load(open(STATE))
    except Exception:
        return {"fails": 0, "down": False, "heals": 0}


def save_state(s):
    # Atomic tmp+rename (display.py's save_state pattern): a crash mid-write
    # must never truncate the file — load_state would swallow the corrupt JSON
    # and reset `down`, re-firing a duplicate DOWN alert for the same outage.
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f)
    os.replace(tmp, STATE)


def main():
    if not os.path.isfile(CONF):
        print(f"{CONF} not found -- not a BirdNET box?", file=sys.stderr)
        return 2
    conf = read_conf()
    unit, enabled, active = recorder_unit()
    budget = max(STALE_SECS, 4 * conf["rec_len"])
    dead = None      # (reason, detail)
    checked = []     # honest healthy-detail trail

    # 1. card presence (skipped for RTSP installs -- no local mic to lose)
    if conf["rtsp"]:
        checked.append("RTSP source, card check skipped")
    else:
        status, detail = card_status(conf["rec_card"])
        if status == "absent":
            dead = ("card_absent", detail)
        else:
            checked.append(detail)

    # 2. chunk freshness -- only meaningful for the continuous StreamData
    #    writer; custom_recording duty-cycles into EXTRACTED/Raw instead.
    newest_age, settled = newest_chunks(conf["recs_dir"], conf["rec_len"])
    if dead is None and unit == "birdnet_recording.service" and enabled:
        if not active:
            dead = ("recorder_stalled", f"{unit} is enabled but not active (crash-looping?)")
        elif newest_age is None:
            dead = ("recorder_stalled",
                    f"no audio chunks in {conf['recs_dir']}/StreamData while {unit} is enabled")
        elif newest_age > budget:
            dead = ("recorder_stalled",
                    f"no new audio chunks in {int(newest_age)}s (budget {budget}s) while {unit} is enabled")
        else:
            checked.append(f"newest chunk {int(newest_age)}s old")

    # 3. flatline scan -- only a fresh SETTLED chunk can speak for the mic's
    #    current state; no such chunk -> skip (silence, not fabrication).
    if dead is None and settled is not None:
        try:
            settled_age = time.time() - os.path.getmtime(settled)
        except OSError:
            settled_age = None  # chunk moved out by birdnet_analysis mid-scan
        if settled_age is not None and settled_age <= budget:
            flat = flatline(settled)
            if flat is True:
                dead = ("flatline", f"{os.path.basename(settled)} peak-to-peak <= {FLATLINE_P2P} LSB")
            elif flat is False:
                checked.append("audio has a live noise floor")

    s = load_state()
    if dead is None:
        if s.get("down"):
            notify(f"RECOVERED: mic/recording pipeline healthy again ({'; '.join(checked)}).",
                   "Christina mic OK", "white_check_mark", conf["user"])
        save_state({"fails": 0, "down": False, "heals": 0})
        print(f"OK: {'; '.join(checked) or 'nothing checkable on this box'}")
        return 0

    reason, detail = dead
    s["fails"] = s.get("fails", 0) + 1
    print(f"FAIL {s['fails']}/{THRESH}: {reason}: {detail}")

    # Bounded self-heal: restarting the recorder re-runs birdnet_recording.sh,
    # which re-kicks pulseaudio; with REC_CARD name-pinned this fully recovers
    # a re-enumerated mic. Never more than HEAL_LIMIT restarts per outage.
    healed = ""
    if unit and enabled and shutil.which("systemctl") and s.get("heals", 0) < HEAL_LIMIT:
        try:
            subprocess.run(["systemctl", "restart", unit], timeout=60)
            s["heals"] = s.get("heals", 0) + 1
            healed = f" Restarted {unit} (attempt {s['heals']}/{HEAL_LIMIT})."
            print(f"self-heal: restarted {unit} ({s['heals']}/{HEAL_LIMIT})")
        except Exception as e:
            print(f"self-heal failed: {e}", flush=True)
    else:
        print("self-heal skipped (no enabled recorder unit / heal limit reached / no systemctl)")

    if s["fails"] >= THRESH and not s.get("down"):
        s["down"] = True
        if reason == "card_absent":
            msg = (f"MIC GONE: configured capture device (REC_CARD={conf['rec_card']}) is not "
                   f"present on the system ({detail}).{healed} If the mic re-enumerated to a new "
                   "card index, pin it by NAME in /etc/birdnet/birdnet.conf: "
                   "REC_CARD=plughw:CARD=<name> (see arecord -L) -- index pinning is exactly "
                   "what re-enumeration breaks.")
        elif reason == "recorder_stalled":
            msg = f"RECORDING STALLED: {detail}.{healed}"
        else:
            msg = (f"MIC FLATLINE: newest completed recording is a flat line ({detail}) -- the "
                   "mic is electrically dead or unplugged, not just a quiet night (a live mic "
                   f"always has a noise floor).{healed}")
        notify(msg, "Christina mic DOWN", "warning", conf["user"])
    save_state(s)
    return 1


if __name__ == "__main__":
    sys.exit(main())
