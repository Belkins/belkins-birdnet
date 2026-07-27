# Package marker so the test suite is discoverable as ``tests.test_offbox_backup``
# and so ``python3 -m unittest discover -s tests`` (and a bare ``python3 -m unittest``
# from avian/backup/) actually finds and runs the tests instead of silently
# reporting "Ran 0 tests ... OK" -- the false-green gate this fixes.
