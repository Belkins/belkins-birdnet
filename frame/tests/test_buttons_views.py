"""views.py + buttons.py (the pure parts): the button-override contract.

The load-bearing properties, each negative-tested:
  1. read_view fails TO DEFAULT — absent, corrupt, incomplete and expired
     files all mean None, never an exception and never a stale view.
  2. resolve() overlays exactly the named view's keys and returns the token;
     an unknown name is ignored (old file, deleted view: the wall stays up).
  3. Every write carries a fresh token even when the view name repeats —
     button D's "repaint now" IS that property.
  4. choose_view: A/B/C name views; D repaints the active one, Today when
     nothing is active.

Stdlib only: this suite runs on CI with no gpiod, no PIL, no panel.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import buttons  # noqa: E402
import views  # noqa: E402

NOW = 1_754_000_000.0


def _cfg(tmp_path, **extra):
    cfg = {
        "hours": 24,
        "shoot_subtitle": "Heard Today",
        "view_file": str(tmp_path / "view.json"),
        "view_ttl_hours": 4,
        "views": {},
    }
    cfg.update(extra)
    return cfg


# --- 1. read_view fails to default -------------------------------------------

def test_absent_file_is_none(tmp_path):
    assert views.read_view(str(tmp_path / "nope.json"), now=NOW) is None


def test_corrupt_json_is_none(tmp_path):
    p = tmp_path / "view.json"
    p.write_text("{not json")
    assert views.read_view(str(p), now=NOW) is None


def test_non_dict_json_is_none(tmp_path):
    p = tmp_path / "view.json"
    p.write_text('["week"]')
    assert views.read_view(str(p), now=NOW) is None


def test_missing_fields_are_none(tmp_path):
    p = tmp_path / "view.json"
    for doc in ({"view": "week"},                       # no token, no until
                {"token": "t", "until": NOW + 60},      # no view
                {"view": "", "token": "t", "until": NOW + 60},   # empty view
                {"view": "week", "token": "", "until": NOW + 60},  # empty token
                {"view": "week", "token": "t", "until": "soon"}):  # non-numeric
        p.write_text(json.dumps(doc))
        assert views.read_view(str(p), now=NOW) is None, doc


def test_expired_is_none_and_boundary_is_exclusive(tmp_path):
    p = str(tmp_path / "view.json")
    views.write_view(p, "week", ttl_hours=1, now=NOW)
    assert views.read_view(p, now=NOW + 3599) is not None
    assert views.read_view(p, now=NOW + 3600) is None  # now >= until: expired
    assert views.read_view(p, now=NOW + 7200) is None


# --- 2. resolve() overlays ----------------------------------------------------

def test_resolve_without_file_is_identity(tmp_path):
    cfg = _cfg(tmp_path)
    out, token = views.resolve(cfg, now=NOW)
    assert out == cfg and token is None


def test_resolve_week_overlays_hours_and_subtitle(tmp_path):
    cfg = _cfg(tmp_path)
    doc = views.write_view(cfg["view_file"], "week", 4, now=NOW)
    out, token = views.resolve(cfg, now=NOW + 1)
    assert token == doc["token"]
    assert out["hours"] == 168
    assert out["shoot_subtitle"] == "Heard This Week"
    assert cfg["hours"] == 24, "resolve must not mutate its input"


def test_resolve_all_uses_the_spa_sentinel(tmp_path):
    cfg = _cfg(tmp_path)
    views.write_view(cfg["view_file"], "all", 4, now=NOW)
    out, token = views.resolve(cfg, now=NOW + 1)
    assert out["hours"] == 1_000_000 and token is not None


def test_resolve_today_is_identity_but_tokened(tmp_path):
    """Pressing A must force a paint (token) while changing nothing (overlay)."""
    cfg = _cfg(tmp_path)
    views.write_view(cfg["view_file"], "today", 4, now=NOW)
    out, token = views.resolve(cfg, now=NOW + 1)
    assert token is not None
    assert out["hours"] == cfg["hours"] and out["shoot_subtitle"] == cfg["shoot_subtitle"]


def test_resolve_unknown_view_is_ignored(tmp_path):
    cfg = _cfg(tmp_path)
    views.write_view(cfg["view_file"], "sepia-dreams", 4, now=NOW)
    out, token = views.resolve(cfg, now=NOW + 1)
    assert out == cfg and token is None


def test_resolve_expired_reverts_to_base(tmp_path):
    cfg = _cfg(tmp_path)
    views.write_view(cfg["view_file"], "week", 1, now=NOW)
    out, token = views.resolve(cfg, now=NOW + 3601)
    assert out == cfg and token is None


def test_operator_views_extend_and_override_per_key(tmp_path):
    cfg = _cfg(tmp_path, views={"week": {"hours": 72},
                                "night": {"hours": 12, "shoot_subtitle": "Overnight"}})
    merged = views.merged_views(cfg)
    assert merged["week"]["hours"] == 72, "operator hours wins"
    assert merged["week"]["shoot_subtitle"] == "Heard This Week", "built-in subtitle kept"
    assert merged["night"]["hours"] == 12, "new operator view exists"
    views.write_view(cfg["view_file"], "night", 4, now=NOW)
    out, token = views.resolve(cfg, now=NOW + 1)
    assert out["shoot_subtitle"] == "Overnight" and token is not None


# --- 3. every write is a fresh token ------------------------------------------

def test_rewrite_same_view_changes_token(tmp_path):
    p = str(tmp_path / "view.json")
    d1 = views.write_view(p, "week", 4, now=NOW)
    d2 = views.write_view(p, "week", 4, now=NOW + 0.001)
    assert d1["token"] != d2["token"], "button D would be a no-op"


def test_write_read_roundtrip(tmp_path):
    p = str(tmp_path / "view.json")
    views.write_view(p, "all", 2, now=NOW)
    doc = views.read_view(p, now=NOW + 1)
    assert doc == {"view": "all", "token": f"{NOW:.6f}"}


# --- 4. choose_view ------------------------------------------------------------

def test_named_buttons_name_their_views():
    assert buttons.choose_view(buttons.PIN_A, current="week") == "today"
    assert buttons.choose_view(buttons.PIN_B, current=None) == "week"
    assert buttons.choose_view(buttons.PIN_C, current="today") == "all"


def test_d_repaints_current_or_today():
    assert buttons.choose_view(buttons.PIN_D, current="all") == "all"
    assert buttons.choose_view(buttons.PIN_D, current=None) == "today"


def test_the_133_c_pin_is_25():
    """Pimoroni moved C from GPIO16 to GPIO25 on the 13.3" — the smaller
    boards' value would listen on a silent line forever, which is exactly
    the 'I press buttons and nothing happens' this daemon exists to end."""
    assert buttons.PIN_C == 25
    assert set(buttons.VIEW_BY_PIN) == {5, 6, 25, 24}
