#!/usr/bin/env python3
"""Railway liveness check for the Christina auto-gen watcher (red-team KILL 9).

If the Railway gen service dies (deploy crash / out of credits), the collage keeps
running so nobody notices, and Google's budget alert never fires (no Gemini spend =
no alert). This is the catch-all: it pings the service and screams (journal +
optional phone push) when it has been unreachable.

Run periodically (systemd timer, ~every 6h). Config via env (EnvironmentFile):
  AV_RAILWAY_BASE  (required)  e.g. https://birdgen-production.up.railway.app
  NOTIFY_URL       (optional)  POSTed on state change. ntfy.sh is easiest:
                              NOTIFY_URL=https://ntfy.sh/<topic>  (install the ntfy
                              app, subscribe <topic> -> you get phone pushes, no acct).
  LIVENESS_STATE   (optional)  state file (default ~/.christina/liveness.state)
  FAIL_THRESHOLD   (optional)  consecutive fails before alerting (default 2)
"""
import os
import sys
import json
import urllib.request

BASE = os.environ.get("AV_RAILWAY_BASE", "").rstrip("/")
NOTIFY = os.environ.get("NOTIFY_URL", "").strip()
STATE = os.path.expanduser(os.environ.get("LIVENESS_STATE", "~/.christina/liveness.state"))
THRESH = int(os.environ.get("FAIL_THRESHOLD", "2"))


def notify(msg, title, tag):
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


def check():
    try:
        d = json.loads(urllib.request.urlopen(BASE + "/health", timeout=12).read())
        return bool(d.get("ok")), d
    except Exception as e:
        return False, {"error": str(e)}


def load_state():
    try:
        return json.load(open(STATE))
    except Exception:
        return {"fails": 0, "down": False}


def save_state(s):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    json.dump(s, open(STATE, "w"))


def main():
    if not BASE:
        print("AV_RAILWAY_BASE not set", file=sys.stderr)
        return 2
    ok, info = check()
    s = load_state()
    if ok:
        if s.get("down"):
            notify(f"RECOVERED: {BASE} is back (done_count={info.get('done_count')}).",
                   "Christina watcher OK", "white_check_mark")
        save_state({"fails": 0, "down": False})
        print(f"OK: {BASE} healthy {info}")
        return 0
    s["fails"] = s.get("fails", 0) + 1
    print(f"FAIL {s['fails']}/{THRESH}: {BASE} unhealthy: {info}")
    if s["fails"] >= THRESH and not s.get("down"):
        s["down"] = True
        notify(f"DOWN: Railway gen service {BASE} unreachable ({info.get('error', 'not ok')}). "
               "New species will stop painting. Check Railway credits/deploy.",
               "Christina watcher DOWN", "warning")
    save_state(s)
    return 1


if __name__ == "__main__":
    sys.exit(main())
