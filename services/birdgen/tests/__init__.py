"""birdgen test package.

The first test suite for services/birdgen. Exercises the /requeue v2 regen
contract (DECISIONS-REGEN.md §1-6): never-worse keep_current swap, atomic
publish + _prev archive, legacy delete-first, poses/source validation, the
manual/auto ledger split + manual budget ceiling, GET /job/<slug>, the
WHERE-generating mark_done/mark_fail race guard, and auto-before-manual claim
priority.

Gemini is fully stubbed (pregen.gen_one + creamkey.chromakey), so the suite
never touches the network or a real volume — ASSETS_DIR points at a per-run
tmp dir (see conftest.py). Run from ``services/birdgen/``:

    python3 -m pytest tests/ -v
"""
