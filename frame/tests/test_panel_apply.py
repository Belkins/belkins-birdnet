"""panel_apply.py: the Wall panel's request -> config-surgery -> paint pipe.

The load-bearing properties, each negative-tested:
  1. validate() holds every range boundary exactly — inclusive highs, the
     open-at-zero lows, zoom's closed [1.0, 2.2] — and rejects non-numbers
     (including True, which IS 1 to Python and would sail through zoom).
  2. The pair rule binds the MERGED values: a lone in-range mintile request
     still dies against the herocap the wall is already running.
  3. Absent keys keep current — the panel sends only what moved.
  4. rewrite_config is TOP-LEVEL-ONLY text surgery: it replaces the two
     lines in place, INSERTS missing keys BEFORE the first [table] header
     (a key appended after one silently joins that table — the TOML trap
     that has fired on this box), and never touches a [views.*] table's own
     shoot_spa_path. win= never appears in the rebuilt path.
  5. consume() never raises, deletes every spool file exactly once (invalid
     included — never applied, never retried), preserves the config's mode,
     and arms the paint with a FRESH token through views.write_view — the
     same one-guaranteed-paint promise a physical button press makes.

Stdlib only: this suite runs on CI with no gpiod, no PIL, no panel.
"""
import json
import os
import stat
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import panel_apply  # noqa: E402
import views  # noqa: E402

CFG = """\
# Belkins BirdNET e-ink frame
base_url = "http://birdnet.local"
shoot_spa = true
shoot_spa_path = "/collage/?surface=kiosk&theme=day&motion=off&budget=0.92&mintile=0.012&herocap=0.24&overlap=0.25&air=0.8"
shoot_zoom = 1.4
hours = 24
view_ttl_hours = 4

[views.week]
hours = 72
shoot_subtitle = "Heard This Week"
"""

CURRENT = {"zoom": 1.4, "budget": 0.92, "mintile": 0.012, "herocap": 0.24,
           "overlap": 0.25, "air": 0.8, "seed": 0, "theme": "day"}


def _valid(extra=None, current=CURRENT):
    req = {"token": "t-1"}
    req.update(extra or {})
    return panel_apply.validate(req, current)


# --- current_knobs: the merge base is always complete -------------------------

def test_current_knobs_reads_the_config():
    assert panel_apply.current_knobs(CFG) == CURRENT


def test_current_knobs_defaults_on_empty_text():
    assert panel_apply.current_knobs("") == {
        "zoom": 1.7, "budget": 0.95, "mintile": 0.009, "herocap": 0.32,
        "overlap": 0.3, "air": 1.0, "seed": 0, "theme": "day"}


def test_current_knobs_garbled_param_falls_alone():
    """One unparseable param resets that one key, not its neighbours — and
    the seed's separate int() path must survive a garbled value too (a
    hand-edited seed=3.5 raising out of current_knobs would kill consume on
    every apply)."""
    text = CFG.replace("budget=0.92", "budget=oops").replace("theme=day",
                                                             "theme=dusk")
    text = text.replace("&air=0.8", "&air=0.8&seed=3.5")
    got = panel_apply.current_knobs(text)
    assert got["budget"] == 0.95 and got["theme"] == "day"
    assert got["seed"] == 0, "garbled seed falls to 0 (free roll), alone"
    assert got["mintile"] == 0.012 and got["zoom"] == 1.4
    assert got["air"] == 0.8


def test_current_knobs_ignores_a_views_table_path():
    """A shoot_spa_path living only inside [views.all] is that view's
    override, not the wall's resting state — the top-level line is absent,
    so every knob is the default."""
    text = ('hours = 24\n\n[views.all]\n'
            'shoot_spa_path = "/collage/?surface=kiosk&budget=0.5&mintile=0.02&herocap=0.1&overlap=0.4"\n'
            'shoot_zoom = 2.0\n')
    assert panel_apply.current_knobs(text) == panel_apply.DEFAULTS


def test_current_knobs_ignores_commented_lines():
    text = '# shoot_spa_path = "/collage/?budget=0.1&mintile=0.001&herocap=0.01"\n# shoot_zoom = 2.2\n'
    assert panel_apply.current_knobs(text) == panel_apply.DEFAULTS


# --- 1. every range boundary --------------------------------------------------

def test_zoom_boundaries_are_closed():
    assert _valid({"zoom": 1.0})[0] is not None
    assert _valid({"zoom": 2.2})[0] is not None
    assert _valid({"zoom": 0.999})[0] is None
    assert _valid({"zoom": 2.201})[0] is None


def test_budget_open_at_zero_closed_at_one():
    assert _valid({"budget": 0.0})[0] is None
    assert _valid({"budget": 0.001})[0] is not None
    assert _valid({"budget": 1.0})[0] is not None
    assert _valid({"budget": 1.001})[0] is None


def test_mintile_open_at_zero_closed_at_005():
    assert _valid({"mintile": 0.0})[0] is None
    assert _valid({"mintile": 0.05})[0] is not None   # 0.05 < herocap 0.24
    assert _valid({"mintile": 0.0501})[0] is None
    assert _valid({"mintile": -0.01})[0] is None


def test_herocap_open_at_zero_closed_at_06():
    assert _valid({"herocap": 0.0})[0] is None
    assert _valid({"herocap": 0.6})[0] is not None
    assert _valid({"herocap": 0.601})[0] is None


def test_air_open_at_zero_closed_at_one():
    assert _valid({"air": 0.0})[0] is None, "air 0 is a mistake, not a composition"
    assert _valid({"air": 0.001})[0] is not None
    assert _valid({"air": 1.0})[0] is not None
    assert _valid({"air": 1.001})[0] is None
    assert _valid({"air": -0.5})[0] is None


def test_seed_integer_int31_zero_means_free():
    assert _valid({"seed": 0})[0]["seed"] == 0, "0 = free roll, valid"
    assert _valid({"seed": 1})[0]["seed"] == 1
    assert _valid({"seed": 2147483647})[0]["seed"] == 2147483647
    assert _valid({"seed": 2147483648})[0] is None
    assert _valid({"seed": -1})[0] is None
    merged, reason = _valid({"seed": 1.5})
    assert merged is None and "integer" in reason
    # a float that IS integral passes and comes back an int (JSON floats)
    merged, _ = _valid({"seed": 42.0})
    assert merged["seed"] == 42 and isinstance(merged["seed"], int)


def test_overlap_closed_both_ends():
    assert _valid({"overlap": 0.0})[0] is not None
    assert _valid({"overlap": 0.5})[0] is not None
    assert _valid({"overlap": -0.001})[0] is None
    assert _valid({"overlap": 0.501})[0] is None


def test_non_numbers_are_rejected():
    assert _valid({"zoom": "1.5"})[0] is None, "a string is not a number"
    assert _valid({"zoom": None})[0] is None
    merged, reason = _valid({"zoom": True})
    assert merged is None, "True is 1 to Python and must not pass [1.0,2.2]"


def test_token_is_required():
    assert panel_apply.validate({"zoom": 1.5}, CURRENT)[0] is None
    assert panel_apply.validate({"zoom": 1.5, "token": ""}, CURRENT)[0] is None
    assert panel_apply.validate({"zoom": 1.5, "token": 7}, CURRENT)[0] is None
    assert panel_apply.validate("not a dict", CURRENT)[0] is None


def test_theme_day_or_night_only():
    assert _valid({"theme": "night"})[0]["theme"] == "night"
    assert _valid({"theme": "dusk"})[0] is None


# --- 2. the pair rule binds MERGED values -------------------------------------

def test_request_mintile_vs_current_herocap():
    """An in-range mintile must still clear the herocap the wall is already
    running — the request never mentioned herocap, the rule still binds."""
    low_hero = dict(CURRENT, herocap=0.015)
    merged, reason = panel_apply.validate({"token": "t", "mintile": 0.02},
                                          low_hero)
    assert merged is None and "pair" in reason
    ok, _ = panel_apply.validate({"token": "t", "mintile": 0.01}, low_hero)
    assert ok is not None


def test_request_herocap_vs_current_mintile():
    merged, reason = panel_apply.validate({"token": "t", "herocap": 0.01},
                                          CURRENT)  # current mintile 0.012
    assert merged is None and "pair" in reason


def test_pair_equality_is_invalid():
    merged, _ = panel_apply.validate({"token": "t", "mintile": 0.02},
                                     dict(CURRENT, herocap=0.02))
    assert merged is None, "mintile == herocap must fail: the rule is strict <"


def test_pair_rule_on_both_in_one_request():
    assert _valid({"mintile": 0.02, "herocap": 0.015})[0] is None
    merged, _ = _valid({"mintile": 0.02, "herocap": 0.03})
    assert merged is not None, "a self-consistent pair beats a clashing current"


# --- 3. absent = keep current -------------------------------------------------

def test_absent_keys_keep_current():
    current = dict(CURRENT)
    merged, reason = panel_apply.validate({"token": "t", "zoom": 2.0}, current)
    assert reason == ""
    assert merged["zoom"] == 2.0
    for key in ("budget", "mintile", "herocap", "overlap", "theme"):
        assert merged[key] == CURRENT[key], key
    assert current == CURRENT, "validate must not mutate its input"


def test_view_absent_is_none_unknown_is_rejected():
    assert _valid({})[0]["view"] is None
    for name in ("realtime", "today", "week", "all"):
        assert _valid({"view": name})[0]["view"] == name
    assert _valid({"view": "sepia-dreams"})[0] is None
    assert _valid({"view": None})[0] is None, "null is not one of the four"


# --- 4. rewrite_config: top-level-only text surgery ---------------------------

def _merged(**over):
    merged, reason = _valid(over)
    assert merged is not None, reason
    return merged


def test_rewrite_replaces_both_lines_in_place():
    out = panel_apply.rewrite_config(CFG, _merged(zoom=1.9, budget=0.8,
                                                  theme="night"))
    assert ('shoot_spa_path = "/collage/?surface=kiosk&theme=night&motion=off'
            '&budget=0.8&mintile=0.012&herocap=0.24&overlap=0.25&air=0.8"') in out
    assert "shoot_zoom = 1.9" in out
    # every OTHER line is byte-identical, in order
    keep = [l for l in CFG.splitlines()
            if not l.startswith(("shoot_spa_path", "shoot_zoom"))]
    assert [l for l in out.splitlines()
            if not l.startswith(("shoot_spa_path", "shoot_zoom"))] == keep


def test_rewrite_never_touches_a_views_table_path():
    """The [views.week] table's own shoot_spa_path is an operator decision
    (it replaces the top-level string wholesale) — surgery stops at the
    first table header."""
    table_line = 'shoot_spa_path = "/collage/?surface=kiosk&budget=0.5"'
    text = CFG + table_line + "\n"
    out = panel_apply.rewrite_config(text, _merged(budget=0.7))
    assert table_line in out, "the view's own path must survive byte-identical"
    assert out.count("budget=0.7") == 1


def test_rewrite_inserts_missing_keys_before_the_first_table():
    """THE TOML TRAP: with no top-level lines and a [views.all] table, a
    naive append would land both keys inside [views.all] — knobs that then
    apply to one button's view instead of the wall. Insert must land BEFORE
    the header."""
    text = "hours = 24\n\n[views.all]\nhours = 1000000\n"
    out = panel_apply.rewrite_config(text, _merged())
    lines = out.splitlines()
    header = lines.index("[views.all]")
    spa = next(i for i, l in enumerate(lines) if l.startswith("shoot_spa_path"))
    zoom = next(i for i, l in enumerate(lines) if l.startswith("shoot_zoom"))
    assert spa < header and zoom < header, out
    assert out.endswith("[views.all]\nhours = 1000000\n"), "tail untouched"
    try:  # prove it with a real TOML parser where one exists (3.11+)
        import tomllib
    except ImportError:
        pass
    else:
        doc = tomllib.loads(out)
        assert "shoot_zoom" in doc and "shoot_spa_path" in doc
        assert "shoot_zoom" not in doc["views"]["all"]
        assert "shoot_spa_path" not in doc["views"]["all"]


def test_rewrite_appends_when_no_table_exists():
    out = panel_apply.rewrite_config("hours = 24", _merged())
    assert out.startswith("hours = 24\n")
    assert "shoot_spa_path = " in out and "shoot_zoom = " in out


def test_rewrite_on_empty_text_creates_both_lines():
    out = panel_apply.rewrite_config("", _merged())
    assert out.startswith("shoot_spa_path = ")
    assert "\nshoot_zoom = " in out


def test_rewrite_seed_zero_stays_out_of_the_path():
    """seed 0 = 'not baked': the page must keep rolling its own dice, so the
    param never appears — an explicit seed=0 in the URL would still read as
    null in profile.ts, but the contract is cleaner with it absent."""
    out = panel_apply.rewrite_config(CFG, _merged())
    assert "seed=" not in out


def test_rewrite_bakes_a_positive_seed_as_a_bare_integer():
    out = panel_apply.rewrite_config(CFG, _merged(seed=123456789))
    assert "&seed=123456789" in out
    assert "seed=123456789.0" not in out, "an integer, never a float repr"
    # and it round-trips through the parser
    assert panel_apply.current_knobs(out)["seed"] == 123456789


def test_rewrite_bakes_default_air_when_config_never_had_it():
    """A pre-air config (no air= in its path): the merge base fills 1.0 and
    the rebuilt path carries it explicitly — the SPA and the panel then agree
    on what the wall is running instead of each assuming their own default."""
    pre_air = CFG.replace("&air=0.8", "")
    current = panel_apply.current_knobs(pre_air)
    assert current["air"] == 1.0
    merged, reason = panel_apply.validate({"token": "t", "zoom": 2.0}, current)
    assert merged is not None, reason
    out = panel_apply.rewrite_config(pre_air, merged)
    assert "&air=1.0" in out


def test_rewrite_is_pure_and_win_free():
    """win= is display.py's to append at shot time; the page reads the FIRST
    occurrence, so a baked win= would freeze every button to one window.
    Rewriting a config that HAS the defect must also remove it."""
    poisoned = CFG.replace("&overlap=0.25", "&overlap=0.25&win=6")
    assert "win=" in poisoned
    out = panel_apply.rewrite_config(poisoned, _merged())
    assert "win=" not in out
    assert "win=" not in panel_apply.rewrite_config(CFG, _merged())


def test_numbers_carry_no_trailing_zeros():
    out = panel_apply.rewrite_config(CFG, _merged(zoom=2.0, budget=1.0))
    assert "shoot_zoom = 2.0" in out and "budget=1.0&" in out
    assert "2.00" not in out


# --- 5. consume: the daemon-side orchestration --------------------------------

def _paths(tmp_path):
    return {
        "cfg_path": str(tmp_path / "config.toml"),
        "frame_state_path": str(tmp_path / "state.json"),
        "view_file": str(tmp_path / "view.json"),
        "ttl_hours": 4,
        "req_path": str(tmp_path / "panel.json"),
        "state_path": str(tmp_path / "panel-state.json"),
    }


def test_consume_no_request_is_none(tmp_path):
    p = _paths(tmp_path)
    assert panel_apply.consume(**p) is None
    assert not os.path.exists(p["state_path"]), "a quiet tick publishes nothing"
    assert not os.path.exists(p["view_file"])


def test_consume_survives_corrupt_json_and_unlinks(tmp_path):
    p = _paths(tmp_path)
    (tmp_path / "config.toml").write_text(CFG)
    (tmp_path / "panel.json").write_text("{not json")
    out = panel_apply.consume(**p)
    assert out.startswith("invalid:")
    assert not os.path.exists(p["req_path"]), "consumed exactly once"
    assert (tmp_path / "config.toml").read_text() == CFG, "config untouched"
    assert not os.path.exists(p["view_file"]), "no paint armed"


def test_consume_drops_invalid_never_applies(tmp_path):
    p = _paths(tmp_path)
    (tmp_path / "config.toml").write_text(CFG)
    (tmp_path / "panel.json").write_text(
        json.dumps({"token": "t", "budget": 7.0}))
    out = panel_apply.consume(**p)
    assert out.startswith("invalid:") and "budget" in out
    assert not os.path.exists(p["req_path"])
    assert (tmp_path / "config.toml").read_text() == CFG
    assert not os.path.exists(p["state_path"])


def test_consume_applies_and_arms_a_fresh_token(tmp_path):
    p = _paths(tmp_path)
    (tmp_path / "config.toml").write_text(CFG)
    (tmp_path / "state.json").write_text(json.dumps({"last_refresh": 123.5}))
    (tmp_path / "panel.json").write_text(
        json.dumps({"token": "phone-1", "zoom": 2.0, "view": "week"}))
    out = panel_apply.consume(**p)
    assert out == "applied token=phone-1"
    assert not os.path.exists(p["req_path"])

    cfg = (tmp_path / "config.toml").read_text()
    assert "shoot_zoom = 2.0" in cfg
    assert "mintile=0.012&herocap=0.24" in cfg, "absent knobs kept current"

    doc1 = views.read_view(p["view_file"])
    assert doc1 and doc1["view"] == "week", "the paint channel is armed"

    st = json.loads((tmp_path / "panel-state.json").read_text())
    assert st["knobs"]["zoom"] == 2.0 and st["knobs"]["budget"] == 0.92
    assert st["knobs"]["air"] == 0.8, "air kept current and published"
    assert st["theme"] == "day" and st["view"] == "week"
    assert st["last_refresh"] == 123.5
    assert isinstance(st["published_at"], float)

    # a second apply is a SECOND paint: the token must be fresh even though
    # the view name repeats — the same promise a button's second press makes
    (tmp_path / "panel.json").write_text(
        json.dumps({"token": "phone-2", "view": "week"}))
    assert panel_apply.consume(**p) == "applied token=phone-2"
    doc2 = views.read_view(p["view_file"])
    assert doc2["token"] != doc1["token"], "a stale token paints nothing"


def test_consume_bakes_and_publishes_a_positive_seed(tmp_path):
    """The WYSIWYG loop end to end on the daemon side: a spooled seed lands
    in the config URL AND in the published state — the state is what the
    panel's boot reads to adopt the wall's baked seed, so dropping seed from
    publish_state would silently unbake the wall on the next apply."""
    p = _paths(tmp_path)
    (tmp_path / "config.toml").write_text(CFG)
    (tmp_path / "panel.json").write_text(
        json.dumps({"token": "t-seed", "seed": 424242}))
    assert panel_apply.consume(**p) == "applied token=t-seed"
    cfg = (tmp_path / "config.toml").read_text()
    assert "&seed=424242" in cfg
    st = json.loads((tmp_path / "panel-state.json").read_text())
    assert st["knobs"]["seed"] == 424242


def test_consume_keeps_the_showing_view_when_request_names_none(tmp_path):
    p = _paths(tmp_path)
    (tmp_path / "config.toml").write_text(CFG)
    views.write_view(p["view_file"], "all", ttl_hours=4)
    (tmp_path / "panel.json").write_text(json.dumps({"token": "t", "zoom": 1.8}))
    assert panel_apply.consume(**p).startswith("applied")
    assert views.read_view(p["view_file"])["view"] == "all"
    assert json.loads((tmp_path / "panel-state.json").read_text())["view"] == "all"


def test_consume_falls_to_today_with_no_active_view(tmp_path):
    p = _paths(tmp_path)
    (tmp_path / "config.toml").write_text(CFG)
    (tmp_path / "panel.json").write_text(json.dumps({"token": "t"}))
    assert panel_apply.consume(**p).startswith("applied")
    assert views.read_view(p["view_file"])["view"] == "today"


def test_consume_creates_the_config_when_absent(tmp_path):
    """A fresh box: no config.toml yet. The merge base is the contract
    defaults and the surgery creates both lines from nothing."""
    p = _paths(tmp_path)
    (tmp_path / "panel.json").write_text(json.dumps({"token": "t", "zoom": 1.2}))
    assert panel_apply.consume(**p) == "applied token=t"
    cfg = (tmp_path / "config.toml").read_text()
    assert "shoot_zoom = 1.2" in cfg and "budget=0.95" in cfg
    st = json.loads((tmp_path / "panel-state.json").read_text())
    assert st["last_refresh"] is None, "no frame state yet reads as null"


def test_consume_preserves_the_config_mode(tmp_path):
    p = _paths(tmp_path)
    (tmp_path / "config.toml").write_text(CFG)
    os.chmod(p["cfg_path"], 0o600)
    (tmp_path / "panel.json").write_text(json.dumps({"token": "t", "zoom": 1.5}))
    assert panel_apply.consume(**p).startswith("applied")
    assert stat.S_IMODE(os.stat(p["cfg_path"]).st_mode) == 0o600


def test_consume_never_raises(tmp_path):
    """The daemon loop must survive anything — here, a config directory that
    does not exist, so the atomic tmp write itself fails."""
    p = _paths(tmp_path)
    p["cfg_path"] = str(tmp_path / "no-such-dir" / "config.toml")
    (tmp_path / "panel.json").write_text(json.dumps({"token": "t", "zoom": 1.5}))
    out = panel_apply.consume(**p)
    assert isinstance(out, str) and out.startswith("error:")
