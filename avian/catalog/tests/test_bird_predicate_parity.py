#!/usr/bin/env python3
"""The bird-classification predicate is copy-pasted; this proves the copies agree.

WHY THIS EXISTS (arsenal future-lens finding, 2026-07-27, survived adversarial refute).

`NON_BIRD` and `is_bird()` are hand-duplicated verbatim across every module in
avian/catalog/ that has to decide "is this row a real species?" — currently
rebuild_catalog.py, derive.py and phenology.py. Each carries a comment saying the
contract is LOCKED and must be changed in all copies together. Nothing enforced it.

That coupling became load-bearing on 2026-07-26, when scripts/verify.sh gained a
content cross-check asserting `len(species.json) == derived.json.species_heard`.
Those two numbers are produced by two DIFFERENT modules' copies of this predicate.
So a one-sided edit to NON_BIRD no longer just skews a stat — it makes the
freshness tripwire scream "stale / fixture" about a perfectly current build. The
alert built to end the 24-day silent-staleness incident would start crying wolf,
and the fastest way to kill a young alert is to have it be wrong first.

DESIGN NOTE — the module list is DISCOVERED, never hardcoded. A hand-written list
is the failure this repo keeps reproducing: repo-guards guard 8 once enumerated 5
of 11 gated paths, and the play.php injection guard once named only the two
variables that had just been patched, passing while three siblings stayed open.
A 4th copy of NON_BIRD added tomorrow is caught automatically; a hardcoded list
would silently ignore it.

Run from ``avian/catalog/``:
    python3 -m pytest tests/ -v
"""
import ast
import importlib.util
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CATALOG_DIR = os.path.dirname(HERE)


def _modules_defining(symbol):
    """Every .py in avian/catalog/ that assigns `symbol` at module level.

    Parsed with ast rather than imported first, so discovery cannot be skewed by
    an import side effect (and a syntactically broken sibling fails loudly here
    rather than silently dropping out of the comparison set).
    """
    found = []
    for fn in sorted(os.listdir(CATALOG_DIR)):
        if not fn.endswith(".py") or fn.startswith("_"):
            continue
        path = os.path.join(CATALOG_DIR, fn)
        try:
            tree = ast.parse(open(path, encoding="utf-8").read())
        except SyntaxError as exc:                       # pragma: no cover
            raise AssertionError("%s does not parse: %s" % (fn, exc))
        for node in tree.body:
            if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == symbol for t in node.targets
            ):
                found.append((fn[:-3], path))
                break
    return found


def _load(name, path):
    spec = importlib.util.spec_from_file_location("parity_" + name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


# Inputs chosen to exercise every branch of is_bird AND the NON_BIRD override:
# a normal binomial, the sci==com non-bird shape, single-word classes, an entry
# that is only excluded BY the override (a cricket binomial), whitespace/case
# variants of that override, and empty/None edges.
PROBES = [
    ("Erithacus rubecula", "European Robin"),
    ("Turdus merula", "Eurasian Blackbird"),
    ("Dog", "Dog"),
    ("Engine", "Engine"),
    ("Siren", "Siren"),
    ("Gryllus assimilis", "Jamaican Field Cricket"),
    ("  Gryllus assimilis  ", "Cricket"),
    ("GRYLLUS ASSIMILIS", "Cricket"),
    ("Homo sapiens", "Human"),
    ("", ""),
    ("", None),
    ("NoSpace", None),
    ("Passer domesticus", None),
    ("Passer domesticus", "Passer domesticus"),
]


class BirdPredicateParityTest(unittest.TestCase):
    def setUp(self):
        self.non_bird_mods = _modules_defining("NON_BIRD")
        self.loaded = [(n, _load(n, p)) for n, p in self.non_bird_mods]

    def test_discovery_found_the_copies(self):
        """Guard the guard: if discovery silently found nothing, every assertion
        below would pass vacuously — the exact fail-open shape this repo keeps
        producing."""
        names = [n for n, _ in self.non_bird_mods]
        self.assertGreaterEqual(
            len(names), 1,
            "no module in avian/catalog/ defines NON_BIRD — discovery is broken, "
            "so this whole suite would pass while proving nothing")
        # Informational: surfaces a NEW copy appearing without failing the build.
        print("\n  NON_BIRD copies discovered: %s" % ", ".join(sorted(names)))

    def test_non_bird_sets_are_identical(self):
        base_name, base_mod = self.loaded[0]
        base = set(base_mod.NON_BIRD)
        for name, mod in self.loaded[1:]:
            other = set(mod.NON_BIRD)
            self.assertEqual(
                other, base,
                "NON_BIRD drifted between %s and %s.\n"
                "  only in %s: %s\n  only in %s: %s\n"
                "These are hand-copied and the contract is LOCKED: verify.sh's content "
                "cross-check compares counts produced by different copies, so a one-sided "
                "edit makes the freshness tripwire report a FALSE 'stale/fixture' alarm."
                % (base_name, name, name, sorted(other - base), base_name, sorted(base - other)))

    def test_is_bird_agrees_across_every_copy(self):
        """Set equality is not enough — the predicate around the set is duplicated
        too, so compare behaviour, not just data."""
        impls = [(n, m) for n, m in self.loaded if hasattr(m, "is_bird")]
        self.assertGreaterEqual(len(impls), 1, "no is_bird() found alongside NON_BIRD")
        base_name, base_mod = impls[0]
        for sci, com in PROBES:
            expected = base_mod.is_bird(sci, com)
            for name, mod in impls[1:]:
                self.assertEqual(
                    mod.is_bird(sci, com), expected,
                    "is_bird(%r, %r) disagrees: %s=%r but %s=%r"
                    % (sci, com, base_name, expected, name, mod.is_bird(sci, com)))

    def test_the_override_actually_bites(self):
        """Anchor the probe list to real behaviour. If NON_BIRD stopped being
        consulted at all, the parity tests above would still pass (all copies
        equally broken) — this is the one that notices."""
        _, mod = self.loaded[0]
        self.assertEqual(mod.is_bird("Erithacus rubecula", "European Robin"), 1)
        sample = sorted(mod.NON_BIRD)[0]
        if " " in sample:      # only a binomial override proves the set is consulted
            self.assertEqual(
                mod.is_bird(sample, "Something Else"), 0,
                "NON_BIRD contains %r but is_bird() accepted it — the override is "
                "no longer consulted, and every copy would be equally wrong" % sample)


if __name__ == "__main__":
    unittest.main()
