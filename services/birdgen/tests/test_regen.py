#!/usr/bin/env python3
"""Tests for the /requeue v2 repaint contract (DECISIONS-REGEN.md §1-6).

These EXERCISE the regen state machine, not just "it imported": every test
drives the real worker helpers (claim -> _generate_sync -> mark_done/mark_fail)
or the real FastAPI endpoints, then asserts a SPECIFIC observable — file bytes
before/after, a DB column value, a ledger counter, an HTTP status — so a test
can't stay green if the business rule changes.

Gemini + creamkey are stubbed in conftest.py; ASSETS_DIR is a throwaway tmp
volume. Nothing here touches the network or a real Railway volume.

Run from ``services/birdgen/``:
    python3 -m pytest tests/ -v
"""
import json
import os
import time
from pathlib import Path

import pytest

import app  # sys.path + env are prepared by conftest.py (loaded first)


# --------------------------------------------------------------------------- #
# Helpers — drive the worker + DB the same way the real single-flight loop does
# --------------------------------------------------------------------------- #
def _worker_once():
    """One iteration of the worker body: CAS-claim the next due job, generate,
    then mark_done / mark_fail exactly as worker() does — but synchronous, so
    tests stay deterministic (no asyncio, no background task)."""
    job = app.claim_one_due()
    if job is None:
        return None
    slug = job["slug"]
    try:
        frac = app._generate_sync(
            slug, job["sci"], job["com"],
            job.get("regen_poses"), job.get("source") == "manual",
        )
        app.mark_done(slug)
        return {"job": job, "ok": True, "frac": frac}
    except Exception as e:  # noqa: BLE001 — mirror worker()'s classify+persist
        state = app.mark_fail(slug, app._classify(e), str(e), job["attempts"])
        return {"job": job, "ok": False, "state": state, "err": str(e)}


def _publish(slug, sci, com, conf=0.9):
    """Enqueue a brand-new species and run the worker once so both poses land
    on the volume (state -> done). Returns the worker result."""
    app.insert_queued(slug, sci, com, conf)
    r = _worker_once()
    assert r and r["ok"], "initial publish should succeed: %r" % (r,)
    return r


def _make_due(slug):
    """Simulate 'enough time has passed' so a backed-off queued row is
    immediately re-claimable (clears next_retry/lease without touching
    state/attempts)."""
    with app._db_lock:
        app.db().execute(
            "UPDATE species_jobs SET next_retry=0, lease_until=0 WHERE slug=?",
            (slug,),
        )
        app.db().commit()


def _row(slug):
    with app._db_lock:
        return app.db().execute(
            "SELECT state, attempts, next_retry, regen_poses, source, verify_rejects "
            "FROM species_jobs WHERE slug=?",
            (slug,),
        ).fetchone()


def _p1(slug):
    return app.ASSETS_DIR / ("%s.png" % slug)


def _p2(slug):
    return app.ASSETS_DIR / ("%s-2.png" % slug)


def _prev(slug):
    return app.ASSETS_DIR / "_prev" / ("%s.png" % slug)


def _reject(*a, **k):
    raise app.QAReject("forced test reject")


def _verdict_off_species():
    """A verify_one verdict that trips the off-species-at-high-confidence gate:
    every count healthy, but the model is confident it's the wrong bird."""
    return {
        "guessed_species_sci": "Passer domesticus", "guessed_species_com": "House Sparrow",
        "guess_confidence": "high", "matches_target": False,
        "wing_count": 2, "leg_count": 2, "head_count": 1, "tail_count": 1,
        "has_stick_or_perch": False, "whole_bird": True,
        "diagnostic_features_present": "", "diagnostic_features_missing": "",
        "anatomy_issues": "", "style_assessment": "true kachō-e",
    }


# --------------------------------------------------------------------------- #
# 1. T6 NEVER-WORSE — a failed keep_current regen leaves the plate untouched
# --------------------------------------------------------------------------- #
def test_never_worse_keep_current_failed_regen_is_byte_identical(client, auth, monkeypatch):
    slug, sci, com = "turdus-merula", "Turdus merula", "Eurasian Blackbird"
    _publish(slug, sci, com)
    before = _p1(slug).read_bytes()
    assert _p1(slug).exists() and _p2(slug).exists()

    # keep_current requeue must NOT pre-delete the serving plate...
    r = client.post("/requeue",
                    json={"slugs": [slug], "poses": [1], "keep_current": True, "source": "auto"},
                    headers=auth)
    assert r.status_code == 200, r.text
    assert r.json()["requeued"] == [slug]
    assert _p1(slug).read_bytes() == before, "keep_current pre-delete leaked"

    # ...and the FAILED regen (forced QA reject) must not touch it either.
    monkeypatch.setattr(app, "_qa_inspect", _reject)
    res = _worker_once()
    assert res and res["ok"] is False and res["state"] == "queued"
    assert _p1(slug).read_bytes() == before, "published plate mutated by a failed regen"


def test_never_worse_park_path_file_untouched_through_exhaustion(monkeypatch):
    """The parked path: keep_current regen that keeps failing QA exhausts its
    attempts into a DEAD_COOLDOWN park — and the published plate is byte-
    identical after EVERY failed attempt, never a broken/absent frame."""
    slug, sci, com = "sitta-europaea", "Sitta europaea", "Eurasian Nuthatch"
    _publish(slug, sci, com)
    before = _p1(slug).read_bytes()

    # keep_current == requeue_row (no delete), pose-1 directed, viewer repaint.
    app.requeue_row(slug, regen_poses="1", source="manual")
    monkeypatch.setattr(app, "_qa_inspect", _reject)

    for i in range(1, app.MAX_ATTEMPTS + 1):
        _make_due(slug)
        res = _worker_once()
        assert res and res["ok"] is False, "attempt %d should fail QA" % i
        assert _p1(slug).read_bytes() == before, "plate mutated on failed attempt %d" % i

    # After MAX_ATTEMPTS non-safety fails: parked (queued + future cooldown),
    # attempts reset, and STILL the original bytes on disk.
    state, attempts, next_retry, _, _, _ = _row(slug)
    assert state == "queued"
    assert next_retry > int(time.time()), "not parked into a future cooldown"
    assert attempts == 0, "attempts should reset at the cooldown boundary"
    assert _p1(slug).read_bytes() == before


def test_accept_with_flag_never_publishes_over_an_existing_plate(monkeypatch, tmp_path):
    """MUST (never-worse): after AV_VERIFY_MAX_REJECTS, accept-with-flag lets a
    NEW species publish a flagged render (a bird beats a silhouette) — but it
    must NEVER overwrite an EXISTING good plate with a verify-failed render.
    protect_existing gates the two cases."""
    slug, sci, com = "chloris-chloris", "Chloris chloris", "European Greenfinch"
    monkeypatch.setattr(app, "AV_VERIFY", True)
    monkeypatch.setattr(app, "verify_one", lambda *a, **k: _verdict_off_species())
    # A row must exist for the verify_rejects counter to persist. Exhaust the
    # per-species reject budget so the NEXT call hits accept-with-flag.
    app.insert_queued(slug, sci, com, 0.9)
    for _ in range(app.AV_VERIFY_MAX_REJECTS):
        app.bump_verify_rejects(slug)
    assert app.get_verify_rejects(slug) >= app.AV_VERIFY_MAX_REJECTS

    out = tmp_path / "cut.png"
    out.write_bytes(b"x")
    # protect_existing=False (new species, no plate) -> accept-with-flag RETURNS.
    app._qa_verify(slug, sci, com, 1, out, protect_existing=False)  # must not raise
    # protect_existing=True (a good plate already hangs) -> it RAISES, keeping it.
    with pytest.raises(app.QAReject):
        app._qa_verify(slug, sci, com, 1, out, protect_existing=True)


# --------------------------------------------------------------------------- #
# 2. Atomic swap on success — file replaced, old bytes archived under _prev/
# --------------------------------------------------------------------------- #
def test_atomic_swap_replaces_file_and_archives_old_bytes_to_prev():
    slug, sci, com = "turdus-merula", "Turdus merula", "Eurasian Blackbird"
    _publish(slug, sci, com)
    before = _p1(slug).read_bytes()
    assert not _prev(slug).exists(), "no _prev archive before the first regen"

    # keep_current pose-1 regen that PASSES QA (real _qa_inspect, stub cutout).
    app.requeue_row(slug, regen_poses="1", source="auto")
    res = _worker_once()
    assert res and res["ok"] is True

    after = _p1(slug).read_bytes()
    assert after != before, "successful regen did not replace the plate"
    assert _prev(slug).exists(), "old plate was not archived to _prev/"
    assert _prev(slug).read_bytes() == before, "_prev does not hold the exact outgoing bytes"


# --------------------------------------------------------------------------- #
# 3. Legacy delete-first unchanged — {slugs:[..]} still wipes assets first
# --------------------------------------------------------------------------- #
def test_legacy_requeue_deletes_assets_first(client, auth):
    slug, sci, com = "turdus-merula", "Turdus merula", "Eurasian Blackbird"
    _publish(slug, sci, com)
    assert _p1(slug).exists() and _p2(slug).exists()

    r = client.post("/requeue", json={"slugs": [slug]}, headers=auth)
    assert r.status_code == 200, r.text
    # Response shape is byte-identical to the old contract: just {"requeued":[..]}.
    assert r.json() == {"requeued": [slug]}
    # delete-first: both poses removed so a dirty plate stops serving immediately.
    assert not _p1(slug).exists()
    assert not _p2(slug).exists()


# --------------------------------------------------------------------------- #
# 4. Input validation — empty slugs / bad poses / bad source all 422
# --------------------------------------------------------------------------- #
def test_empty_slugs_422(client, auth):
    # explicit empty list, missing key, and all-invalid-slug list each collapse
    # to an empty target set -> 422 (the wall-wipe footgun is gone).
    for body in ({"slugs": []}, {}, {"slugs": ["../etc", "Bad Slug!"]}):
        r = client.post("/requeue", json=body, headers=auth)
        assert r.status_code == 422, "%r -> %s" % (body, r.status_code)


def test_invalid_poses_422(client, auth):
    for bad in ([3], [0], [1, 3], [], "1", [1, "2"], [True]):
        r = client.post("/requeue",
                        json={"slugs": ["turdus-merula"], "poses": bad},
                        headers=auth)
        assert r.status_code == 422, "poses=%r -> %s" % (bad, r.status_code)


def test_invalid_source_422(client, auth):
    r = client.post("/requeue",
                    json={"slugs": ["turdus-merula"], "source": "bogus"},
                    headers=auth)
    assert r.status_code == 422, r.text


# --------------------------------------------------------------------------- #
# 5. keep_pose1 alias ≡ poses:[2] + keep_current:true
# --------------------------------------------------------------------------- #
def test_keep_pose1_alias_equivalence(client, auth):
    a, b = "turdus-merula", "cyanistes-caeruleus"
    _publish(a, "Turdus merula", "Eurasian Blackbird")
    _publish(b, "Cyanistes caeruleus", "Eurasian Blue Tit")

    # legacy alias
    r1 = client.post("/requeue", json={"slugs": [a], "keep_pose1": True}, headers=auth)
    assert r1.status_code == 200, r1.text
    # explicit equivalent
    r2 = client.post("/requeue",
                    json={"slugs": [b], "poses": [2], "keep_current": True},
                    headers=auth)
    assert r2.status_code == 200, r2.text

    # both encode the SAME directive: regen only pose-2...
    assert _row(a)[3] == "2", "keep_pose1 did not map to regen_poses='2'"
    assert _row(b)[3] == "2", "explicit poses[2] did not store regen_poses='2'"
    # ...and keep_current => NO pose-1 delete (the good perched plate survives).
    assert _p1(a).exists(), "keep_pose1 deleted pose-1"
    assert _p1(b).exists(), "explicit keep_current deleted pose-1"


# --------------------------------------------------------------------------- #
# 6. source=manual — bundled slugs refused, others still requeued (partial 200)
# --------------------------------------------------------------------------- #
def test_manual_bundled_refused_partial_acceptance(client, auth):
    bundled = sorted(app.BUNDLED)[0]  # e.g. 'acanthis-flammea'
    other = "testus-fakeus"           # a valid, non-bundled slug shape
    assert bundled in app.BUNDLED and other not in app.BUNDLED

    r = client.post("/requeue",
                    json={"slugs": [bundled, other], "source": "manual"},
                    headers=auth)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["refused"] == {bundled: "bundled"}
    assert body["requeued"] == [other]           # non-bundled slug accepted
    assert _row(other) is not None               # ...and actually queued
    assert _row(bundled) is None                 # bundled slug never touched


# --------------------------------------------------------------------------- #
# 7. Manual budget ceiling — manual refused, auto still accepted
# --------------------------------------------------------------------------- #
def test_manual_budget_ceiling_refuses_manual_not_auto(client, auth):
    slug = "testus-fakeus"
    # Pre-load the ledger so manual spend crosses MANUAL_BUDGET_USD ($6):
    # 200 manual gens * $0.04 = $8.00 >= $6.00.
    app._record("manual_gens", 200)
    assert app.manual_budget_exhausted() is True

    r_manual = client.post("/requeue",
                          json={"slugs": [slug], "source": "manual"}, headers=auth)
    assert r_manual.status_code == 200, r_manual.text
    assert r_manual.json()["refused"] == {slug: "manual_budget"}
    assert r_manual.json()["requeued"] == []

    # auto-gen is unaffected by the manual sub-ceiling.
    r_auto = client.post("/requeue",
                        json={"slugs": [slug], "source": "auto"}, headers=auth)
    assert r_auto.status_code == 200, r_auto.text
    assert r_auto.json()["requeued"] == [slug]
    assert "refused" not in r_auto.json()


# --------------------------------------------------------------------------- #
# 8. GET /job/<slug> — Bearer required, C2 shape, unknown state, live mtimes
# --------------------------------------------------------------------------- #
_C2_KEYS = {
    "slug", "state", "attempts", "next_retry", "fail_reason",
    "asset_mtime", "asset2_mtime", "budget_exhausted", "manual_paused",
    "queue_depth",
}


def test_job_requires_bearer(client):
    assert client.get("/job/turdus-merula").status_code == 401


def test_job_unknown_slug_shape(client, auth):
    r = client.get("/job/never-seen-species", headers=auth)
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body.keys()) == _C2_KEYS
    assert body["state"] == "unknown"
    assert body["attempts"] == 0
    assert body["asset_mtime"] is None
    assert body["asset2_mtime"] is None


def test_job_reflects_published_mtimes(client, auth):
    slug = "turdus-merula"
    _publish(slug, "Turdus merula", "Eurasian Blackbird")
    r = client.get("/job/%s" % slug, headers=auth)
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body.keys()) == _C2_KEYS
    assert body["state"] == "done"
    # mtimes reflect files actually on disk.
    assert body["asset_mtime"] == pytest.approx(_p1(slug).stat().st_mtime, abs=1e-3)
    assert body["asset2_mtime"] == pytest.approx(_p2(slug).stat().st_mtime, abs=1e-3)


# --------------------------------------------------------------------------- #
# 9. Ledger split — manual gen bumps manual_gens; legacy bucket reads as 0
# --------------------------------------------------------------------------- #
def test_manual_gen_bumps_manual_counter_only():
    before = app.month_snapshot()
    app.requeue_row("testus-fakeus", regen_poses="1", source="manual")
    res = _worker_once()
    assert res and res["ok"] is True
    after = app.month_snapshot()
    assert after["manual_gens"] >= before["manual_gens"] + 1, "manual gen not tallied"
    assert after["gens"] == before["gens"], "manual gen leaked into the auto counter"


def test_legacy_bucket_missing_manual_keys_reads_zero():
    mk = app._month_key()
    # A pre-split bucket has only gens/verifies.
    app.LEDGER_PATH.write_text(json.dumps({"months": {mk: {"gens": 5, "verifies": 2}}}))
    snap = app.month_snapshot()  # must not KeyError
    assert snap["gens"] == 5
    assert snap["verifies"] == 2
    assert snap["manual_gens"] == 0
    assert snap["manual_verifies"] == 0
    assert snap["manual_spend_usd"] == 0.0


# --------------------------------------------------------------------------- #
# 10. WHERE state='generating' guard — mark_done on a queued row no-ops
# --------------------------------------------------------------------------- #
def test_mark_done_where_generating_guard():
    slug = "testus-fakeus"
    app.requeue_row(slug, source="auto")  # state='queued'
    # The swallowed-press race: a /requeue re-queued the row mid-gen. mark_done
    # must NOT clobber that repaint intent.
    app.mark_done(slug)
    assert app.get_state(slug) == "queued", "mark_done clobbered a queued (requeued) row"

    # But once genuinely 'generating', mark_done works — proving the guard is a
    # real condition, not an unconditional no-op.
    job = app.claim_one_due()
    assert job and job["slug"] == slug
    assert app.get_state(slug) == "generating"
    app.mark_done(slug)
    assert app.get_state(slug) == "done"


# --------------------------------------------------------------------------- #
# 11. Claim priority — auto/new-species rows claim before manual repaints
# --------------------------------------------------------------------------- #
def test_auto_claims_before_manual():
    # Insert the manual row FIRST so ordering can't be an insertion-order fluke.
    app.requeue_row("manual-species", regen_poses="1", source="manual")
    app.requeue_row("auto-species", regen_poses=None, source="auto")

    job = app.claim_one_due()
    assert job is not None
    assert job["slug"] == "auto-species", "manual repaint jumped the auto queue"
    assert job["source"] == "auto"


# --------------------------------------------------------------------------- #
# Bonus: /health advertises regen_api:2 + the split manual telemetry
# --------------------------------------------------------------------------- #
def test_health_advertises_regen_api_and_manual_split(client):
    r = client.get("/health")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["regen_api"] == 2  # capability advert for Pi feature detection
    for k in ("manual_gens_this_month", "manual_verifies_this_month",
              "manual_spend_usd", "manual_frac"):
        assert k in body, "missing manual telemetry key: %s" % k


# --------------------------------------------------------------------------- #
# clean_alpha detached-satellite drop — the "floating feet" fix
#
# A bird cutout is ONE connected silhouette. A second solid component that is
# both small relative to the body AND separated from it by a real gap is a
# render defect (talons Gemini paints floating below a flight bird's belly, a
# doubled ghost leg) and must be removed WITHOUT touching the bird. A genuinely
# attached extremity (a leg a hairline gap from the body) must survive.
# --------------------------------------------------------------------------- #
from PIL import Image, ImageDraw  # noqa: E402


def _plate(w, h, boxes):
    """An RGBA plate with solid dark ink filling each (x0,y0,x1,y1) box."""
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for b in boxes:
        d.rectangle(list(b), fill=(20, 20, 20, 255))
    return im


def test_clean_alpha_drops_detached_satellite_keeps_body(tmp_path):
    """The regression: a small solid blob far below the body (the floating
    talons) is removed; the body stays fully opaque."""
    w, h = 600, 400
    body = (40, 40, 360, 300)        # ~83k px — the bird
    feet = (470, 330, 505, 365)      # ~1.5% of body, ~110px away — floating talons
    p = tmp_path / "cut.png"
    _plate(w, h, [body, feet]).save(p)

    note = app.clean_alpha(str(p))
    A = Image.open(p).convert("RGBA").getchannel("A").load()
    assert A[200, 170] >= 200, "the body must survive untouched"
    assert A[487, 347] == 0, "the detached satellite (floating feet) must be removed"
    assert note and "detached" in note, "note should report a detached-pixel removal"


def test_clean_alpha_keeps_a_hairline_detached_extremity(tmp_path):
    """A leg-like blob a few px from the body (a chromakey nick, not a defect)
    is within reach and must be preserved — the drop is for FAR satellites."""
    w, h = 600, 400
    body = (40, 40, 360, 300)
    leg = (150, 308, 190, 348)       # 8px below the body — within the keep-reach
    p = tmp_path / "cut.png"
    _plate(w, h, [body, leg]).save(p)

    app.clean_alpha(str(p))
    A = Image.open(p).convert("RGBA").getchannel("A").load()
    assert A[170, 328] >= 200, "a near (attached) extremity must NOT be dropped"


def test_clean_alpha_tuck_drops_even_a_near_attached_foot(tmp_path):
    """tuck=True keeps ONLY the body — a near (within-reach) foot component that
    the default keeps is dropped, leaving a clean rounded belly. This is the
    'tucked feet' fix for a bird Gemini won't stop drawing an awkward leg on."""
    w, h = 600, 400
    body = (40, 40, 360, 300)
    foot = (150, 306, 190, 340)      # a small foot 6px below the body (within reach)
    p = tmp_path / "cut.png"
    _plate(w, h, [body, foot]).save(p)

    # default: the near foot survives (it's an attached extremity)
    _plate(w, h, [body, foot]).save(p)
    app.clean_alpha(str(p), tuck=False)
    A = Image.open(p).convert("RGBA").getchannel("A").load()
    assert A[170, 322] >= 200, "default clean_alpha must keep a near extremity"

    # tuck: the foot is dropped, the body stays
    _plate(w, h, [body, foot]).save(p)
    note = app.clean_alpha(str(p), tuck=True)
    A = Image.open(p).convert("RGBA").getchannel("A").load()
    assert A[200, 170] >= 200, "tuck must keep the body"
    assert A[170, 322] == 0, "tuck must drop the near foot (tucked belly)"
    assert note and "tucked" in note


def test_clean_alpha_preserves_a_clean_single_component_plate(tmp_path):
    """No second component -> the satellite logic is a no-op: the body is kept
    and nothing is invented outside it."""
    w, h = 600, 400
    p = tmp_path / "cut.png"
    _plate(w, h, [(40, 40, 360, 300)]).save(p)

    app.clean_alpha(str(p))
    A = Image.open(p).convert("RGBA").getchannel("A").load()
    assert A[200, 170] >= 200, "clean body must remain opaque"
    assert A[500, 350] == 0, "empty space stays empty"


# --------------------------------------------------------------------------- #
# TUCK_SLUGS registry — a tuck fix must survive regens/recleans, not live only
# in the operator's memory of a one-off /reclean {tuck:true} call.
# --------------------------------------------------------------------------- #
def test_tuck_slugs_applies_tuck_on_regen_publish_perched_only(monkeypatch):
    """A TUCK_SLUGS species gets clean_alpha(tuck=True) on its PERCHED plate on
    EVERY publish — and tuck=False on flight (pose-2 keeps the satellite-drop
    path). Without the registry the next repaint resurrects the dangling leg."""
    calls = []
    real_clean = app.clean_alpha

    def spy(path, tuck=False):
        calls.append(tuck)
        return real_clean(path, tuck=tuck)

    monkeypatch.setattr(app, "clean_alpha", spy)
    monkeypatch.setattr(app, "TUCK_SLUGS", {"turdus-merula"})
    _publish("turdus-merula", "Turdus merula", "Common Blackbird")
    assert calls, "publish must run the edge cleanup"
    assert calls[0] is True, "pose-1 of a TUCK_SLUGS species must publish tucked"
    assert all(t is False for t in calls[1:]), "flight poses must NOT tuck"


def test_reclean_honors_tuck_slugs_without_the_flag(client, auth, monkeypatch):
    """A casual /reclean (no tuck flag) of a TUCK_SLUGS species must keep the
    tuck on pose-1 — otherwise routine maintenance silently undoes the fix."""
    _publish("turdus-merula", "Turdus merula", "Common Blackbird")
    seen = {}

    def spy(path, tuck=False):
        seen[Path(path).name] = tuck
        return "cleaned edge (removed 0.001 detached, halo=2px)"

    monkeypatch.setattr(app, "clean_alpha", spy)
    monkeypatch.setattr(app, "TUCK_SLUGS", {"turdus-merula"})
    r = client.post("/reclean", json={"slugs": ["turdus-merula"]}, headers=auth)
    assert r.status_code == 200
    assert seen[".turdus-merula.png.clean.png"] is True, "pose-1 must tuck via the registry"
    assert seen[".turdus-merula-2.png.clean.png"] is False, "pose-2 must not tuck"
    # the caller can SEE what each cleanup did (drop frac included in the note)
    assert "notes" in r.json() and "turdus-merula#1" in r.json()["notes"]


def test_reclean_oneoff_tuck_warns_when_not_in_registry(client, auth, monkeypatch):
    """A one-off /reclean {tuck:true} of a slug NOT in TUCK_SLUGS must say so in
    the response note — that unregistered tuck is exactly the fix that dies on
    the next repaint (the d05d46f robin lesson), and the warning must land in
    the operator's face, not only a log."""
    _publish("turdus-merula", "Turdus merula", "Common Blackbird")

    def spy(path, tuck=False):
        return "cleaned edge (removed 0.120 tucked (kept body only), halo=8px)"

    monkeypatch.setattr(app, "clean_alpha", spy)
    monkeypatch.setattr(app, "TUCK_SLUGS", set())
    r = client.post("/reclean", json={"slugs": ["turdus-merula"], "tuck": True,
                                      "poses": [1]}, headers=auth)
    assert r.status_code == 200
    assert "NOT PERSISTED" in r.json()["notes"]["turdus-merula#1"]

    # …and a REGISTERED tuck stays clean of the warning.
    monkeypatch.setattr(app, "TUCK_SLUGS", {"turdus-merula"})
    r = client.post("/reclean", json={"slugs": ["turdus-merula"], "tuck": True,
                                      "poses": [1]}, headers=auth)
    assert "NOT PERSISTED" not in r.json()["notes"]["turdus-merula#1"]


def test_clean_drop_frac_parses_both_note_formats():
    """_warn_big_clean_drop's tripwire rides this parse — if the note format
    drifts, this test (not a silent None) catches it."""
    assert app._clean_drop_frac("cleaned edge (removed 0.034 detached, halo=8px)") == 0.034
    assert app._clean_drop_frac("cleaned edge (removed 0.120 tucked (kept body only), halo=8px)") == 0.120
    assert app._clean_drop_frac(None) is None
    assert app._clean_drop_frac("no removal mentioned") is None


# --------------------------------------------------------------------------- #
# /jobs roster — the wall-mode feed for scripts/verify.sh (P0: "what is the
# wall showing right now" in one command).
# --------------------------------------------------------------------------- #
def test_jobs_roster_requires_bearer(client):
    assert client.get("/jobs").status_code == 401


def test_jobs_roster_lists_state_and_bytes(client, auth):
    _publish("turdus-merula", "Turdus merula", "Common Blackbird")
    r = client.get("/jobs", headers=auth)
    assert r.status_code == 200
    jobs = {j["slug"]: j for j in r.json()["jobs"]}
    row = jobs["turdus-merula"]
    assert row["state"] == "done"
    assert row["pose1_bytes"] > 0, "a done job must show real pose-1 bytes"
    assert row["verify_rejects"] == 0
    assert "fail_reason" in row
