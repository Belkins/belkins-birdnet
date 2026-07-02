#!/usr/bin/env python3
"""Shared fixtures + Gemini/creamkey stubs for the birdgen regen suite.

CRITICAL import discipline: the app module reads ASSETS_DIR / budgets / secret
from the environment AT IMPORT TIME (module-level constants). So this conftest
sets every env var BEFORE ``import app``, pointing the volume at a throwaway
tmp dir. Nothing here ever reaches Gemini or a real Railway volume:

  * pregen.gen_one    -> synthetic PNG bytes (never a network call)
  * app.chromakey     -> writes a QA-passing 800x800 solid-blob RGBA cutout and
                         returns an in-band opaque fraction; the fill color
                         varies per call so a successful re-publish differs in
                         bytes (needed by the atomic-swap test).
  * AV_VERIFY=0       -> the adversarial Gemini-Vision gate (_qa_verify) is off,
                         so verify is never invoked (tests that want a QA reject
                         monkeypatch app._qa_inspect to raise QAReject instead).

Every test gets a clean volume (fresh state.db + empty assets dir + empty
ledger) and the stubs re-applied, via the autouse ``_fresh`` fixture.
"""
import io
import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest
from PIL import Image

# --------------------------------------------------------------------------- #
# 1. env MUST be set before importing app (module-level constants read it)
# --------------------------------------------------------------------------- #
_BIRDGEN_DIR = Path(__file__).resolve().parent.parent  # services/birdgen
if str(_BIRDGEN_DIR) not in sys.path:
    sys.path.insert(0, str(_BIRDGEN_DIR))

# A single per-session tmp volume in the OS temp area (NOT under the repo tree,
# so a stray run never leaves artifacts to commit); the _fresh fixture
# wipes+recreates it between tests so each test starts from a pristine
# state.db/assets/ledger.
_ASSETS_DIR = Path(tempfile.mkdtemp(prefix="birdgen-test-assets-"))

os.environ.update({
    "ASSETS_DIR": str(_ASSETS_DIR),
    "WATCHER_WEBHOOK_SECRET": "test-secret",
    "GEMINI_API_KEY": "test-key",           # non-empty so lifespan doesn't warn; gen is stubbed
    "MONTHLY_BUDGET_USD": "20",
    "MANUAL_BUDGET_USD": "6",
    "AV_VERIFY": "0",                        # adversarial Gemini gate OFF
    "FETCH_REFS": "0",                       # no Wikipedia anatomy-ref fetches
    "AV_STYLES_DIR": "",                     # STYLES_DIR=None -> no house-style ref lookups
    "MIN_SPACING": "0",                      # no throttle sleeps between (stubbed) gen calls
})

import app  # noqa: E402  (import intentionally AFTER the env is set)

SECRET = "test-secret"
AUTH = {"Authorization": "Bearer %s" % SECRET}


# --------------------------------------------------------------------------- #
# 2. Gemini / creamkey stubs
# --------------------------------------------------------------------------- #
def _make_fake_png() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (16, 16), (12, 12, 12)).save(buf, format="PNG")
    return buf.getvalue()


_FAKE_PNG = _make_fake_png()
# Monotonic counter so each stubbed cutout differs in bytes: an atomic
# re-publish must produce a file distinct from the one it replaced.
_blob_counter = {"n": 0}


def fake_gen_one(*args, **kwargs) -> bytes:
    """Stand-in for pregen.gen_one — returns bytes, never calls Gemini. The
    bytes are irrelevant (fake_chromakey ignores its src and paints its own
    cutout), but they must be a real PNG so tmp_raw.write_bytes + any Pillow
    open in the pipeline stays happy."""
    return _FAKE_PNG


def fake_chromakey(src, dst, tol: int = 42) -> float:
    """Stand-in for creamkey.chromakey — writes a QA-passing RGBA cutout to
    ``dst`` and returns an in-band opaque fraction.

    An 800x800 frame with a solid 400x450 dark blob, centered so it never
    touches the border band. That geometry clears every gate in the real
    _qa_inspect: opaque frac 0.28 in [0.015, 0.75], bbox-fill ~1.0 >> 0.17
    (hollow floor), one connected component (no islands), aspect 1.0, no
    residual magenta, no ragged edge. The fill color steps per call so two
    successful publishes never collide byte-for-byte."""
    _blob_counter["n"] += 1
    n = _blob_counter["n"]
    img = Image.new("RGBA", (800, 800), (0, 0, 0, 0))
    blob = Image.new("RGBA", (400, 450), (40 + (n % 20), 30, 20, 255))  # dark, non-magenta
    img.paste(blob, (200, 175))
    img.save(dst)
    return 0.28


# --------------------------------------------------------------------------- #
# 3. Fixtures
# --------------------------------------------------------------------------- #
def _reset_db_singleton():
    """Drop the cached sqlite connection so the next db() call rebuilds the
    schema on a fresh file."""
    if app._conn is not None:
        try:
            app._conn.close()
        except Exception:
            pass
        app._conn = None


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    """Pristine volume + stubs re-applied before EVERY test."""
    _reset_db_singleton()
    shutil.rmtree(_ASSETS_DIR, ignore_errors=True)
    _ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    # in-memory per-species learning sets must not leak across tests
    app._PALE_GROUND_SLUGS.clear()
    app._LEGS_HINT_SLUGS.clear()
    _blob_counter["n"] = 0
    # network stubs — app.py calls pregen.gen_one and the module-local chromakey
    monkeypatch.setattr(app.pregen, "gen_one", fake_gen_one)
    monkeypatch.setattr(app, "chromakey", fake_chromakey)
    yield
    _reset_db_singleton()


@pytest.fixture
def birdgen():
    """The imported app module under test."""
    return app


@pytest.fixture
def client():
    """FastAPI TestClient WITHOUT the lifespan context manager: we do NOT want
    the background worker running (it would race our direct claim/generate
    calls and could fire stubbed gens unpredictably). Endpoints create the DB
    connection lazily and treat _wakeup=None gracefully, so this is sufficient
    for every HTTP-layer assertion."""
    from fastapi.testclient import TestClient
    return TestClient(app.app)


@pytest.fixture
def auth():
    return dict(AUTH)
