"""The carousel-panel hide in shoot.py must be BY EXCLUSION, never a list.

The enumerated form (#v1, #v2) went stale the day apt.js grew #v3: the extra
visible panel kept the site's shrink-proof `flex: 0 0 100%` and crushed the
shooter's shrinkable #v0 to width 0 — renderCollage() retried `!W` forever,
and no shot WITH birds could complete (the empty card never reaches the size
check, which is why the pipeline's maiden shot passed). These pins close the
channel: a future #v4 must fall into the :not() selector, not re-run that
hunt.

Text-level on purpose: shoot.py imports playwright at module top and this
suite runs stdlib-only on CI. The live layout is verified on the box; this
tripwire only keeps the closed channel closed.
"""
import os
import re

SHOOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "shoot.py")


def _src():
    with open(SHOOT) as f:
        return f.read()


def test_panels_hidden_by_exclusion():
    assert ".views > .view:not(#v0)" in _src()


def test_no_enumerated_panel_hide_returns():
    """#v1/#v2/#v3... must not reappear in a display:none rule — that is the
    exact stale-list channel the exclusion selector replaced. CSS comments are
    stripped first (the guard-6/7/10 lesson: a bare grep matches the prose
    forbidding the thing), and #v0 inside :not() is the fix itself, not a list."""
    src = re.sub(r"/\*.*?\*/", "", _src(), flags=re.S)
    for rule in re.findall(r"([^{}]+)\{[^}]*display:\s*none", src):
        assert not re.search(r"#v[1-9]", rule), f"enumerated panel hide is back: {rule.strip()!r}"


def test_v0_width_is_pinned():
    """Defence in depth: even alone in the row, #v0 must carry an explicit
    width — its own content is absolutely positioned and min-width:auto
    resolves to 0 for it."""
    assert re.search(r"\.view#v0\s*\{[^}]*width: 100% !important", _src())
