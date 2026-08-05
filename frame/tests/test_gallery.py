"""The gallery Easter egg's load-bearing properties.

  1. The id charset pin IS the traversal guard — "../", absolute paths,
     dotfiles and current.png itself must die in validation, never at open().
  2. ensure_gallery_view appends the [views.gallery] table exactly once, at
     EOF (the one safe place for text-surgery tables), and is idempotent.
  3. show writes the gallery view token (the paint channel) and points the
     current symlink; remove cleans the photo, its thumb, AND a current
     symlink that referenced it.

Stdlib only; the PIL-dependent upload path is exercised only where PIL exists
(the Pi venv) and skipped on CI.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import panel_apply  # noqa: E402
import views  # noqa: E402

TOK = {"token": "t1"}


# --- 1. validation / traversal -------------------------------------------------

def test_traversal_ids_die_in_validation():
    for bad in ("../etc/passwd", "/abs/path", "a/b.png", ".hidden", "",
                "current.png", "a" * 70, "nul\x00byte"):
        req, reason = panel_apply.validate_gallery_request(
            {"action": "show", "id": bad, **TOK})
        assert req is None, bad


def test_unknown_action_and_keys_rejected():
    assert panel_apply.validate_gallery_request(
        {"action": "paint", "id": "g1.png", **TOK})[0] is None
    assert panel_apply.validate_gallery_request(
        {"action": "show", "id": "g1.png", "extra": 1, **TOK})[0] is None
    assert panel_apply.validate_gallery_request(
        {"action": "show", "id": "g1.png"})[0] is None  # no token


def test_good_request_passes():
    req, _ = panel_apply.validate_gallery_request(
        {"action": "remove", "id": "g123.png", **TOK})
    assert req == {"action": "remove", "id": "g123.png", "token": "t1"}


# --- 2. config table insertion --------------------------------------------------

def test_gallery_view_appends_once_at_eof():
    base = 'shoot_spa = true\n\n[views.all]\nshoot_budget_frac = 0.7\n'
    once = panel_apply.ensure_gallery_view(base)
    assert once.count("[views.gallery]") == 1
    assert once.index("[views.gallery]") > once.index("[views.all]")
    assert panel_apply.ensure_gallery_view(once) == once, "must be idempotent"


# --- 3. show / remove flows -----------------------------------------------------

def _setup(tmp_path):
    cfg = tmp_path / "config.toml"
    cfg.write_text('shoot_spa = true\nshoot_zoom = 1.4\n')
    gal = tmp_path / "gallery"
    gal.mkdir()
    (gal / "g1.png").write_bytes(b"fakepng")
    return cfg, gal


def _greq(tmp_path, doc):
    p = tmp_path / "gallery-request.json"
    p.write_text(json.dumps(doc))
    return str(p)


def test_show_arms_the_view_and_symlink(tmp_path, monkeypatch):
    cfg, gal = _setup(tmp_path)
    monkeypatch.setattr(panel_apply, "GALLERY_CURRENT", str(gal / "current.png"))
    vf = tmp_path / "view.json"
    out = panel_apply.consume_gallery(
        str(cfg), str(vf), 4,
        upload_path=str(tmp_path / "nope.img"),
        req_path=_greq(tmp_path, {"action": "show", "id": "g1.png", **TOK}),
        gallery_dir=str(gal), thumbs_dir=str(tmp_path / "thumbs"))
    assert out.startswith("gallery: showing g1.png")
    assert "[views.gallery]" in cfg.read_text()
    assert os.readlink(str(gal / "current.png")) == str(gal / "g1.png")
    doc = views.read_view(str(vf))
    assert doc and doc["view"] == "gallery", "the paint channel must be armed"


def test_remove_cleans_photo_thumb_and_current(tmp_path, monkeypatch):
    cfg, gal = _setup(tmp_path)
    monkeypatch.setattr(panel_apply, "GALLERY_CURRENT", str(gal / "current.png"))
    thumbs = tmp_path / "thumbs"
    thumbs.mkdir()
    (thumbs / "g1.png").write_bytes(b"thumb")
    os.symlink(str(gal / "g1.png"), str(gal / "current.png"))
    out = panel_apply.consume_gallery(
        str(cfg), str(tmp_path / "view.json"), 4,
        upload_path=str(tmp_path / "nope.img"),
        req_path=_greq(tmp_path, {"action": "remove", "id": "g1.png", **TOK}),
        gallery_dir=str(gal), thumbs_dir=str(thumbs))
    assert out == "gallery: removed g1.png"
    assert not (gal / "g1.png").exists()
    assert not (thumbs / "g1.png").exists()
    assert not os.path.lexists(str(gal / "current.png")), "dangling current must go"


def test_show_missing_photo_is_soft(tmp_path):
    cfg, gal = _setup(tmp_path)
    out = panel_apply.consume_gallery(
        str(cfg), str(tmp_path / "view.json"), 4,
        upload_path=str(tmp_path / "nope.img"),
        req_path=_greq(tmp_path, {"action": "show", "id": "gX.png", **TOK}),
        gallery_dir=str(gal), thumbs_dir=str(tmp_path / "thumbs"))
    assert out == "gallery: no such photo gX.png"
    assert "[views.gallery]" not in cfg.read_text(), "no config surgery for a miss"


def test_corrupt_request_dropped(tmp_path):
    cfg, gal = _setup(tmp_path)
    p = tmp_path / "gallery-request.json"
    p.write_text("{not json")
    out = panel_apply.consume_gallery(
        str(cfg), str(tmp_path / "view.json"), 4,
        upload_path=str(tmp_path / "nope.img"),
        req_path=str(p), gallery_dir=str(gal), thumbs_dir=str(tmp_path / "t"))
    assert out == "gallery: corrupt request dropped"
    assert not p.exists()


def test_list_gallery_sorts_and_filters(tmp_path):
    gal = tmp_path / "g"
    gal.mkdir()
    for i, name in enumerate(("g1.png", "g2.png", "current.png", "..weird")):
        f = gal / name
        f.write_bytes(b"x")
        os.utime(f, (1000 + i, 1000 + i))
    got = panel_apply.list_gallery(str(gal))
    assert got == ["g2.png", "g1.png"]
