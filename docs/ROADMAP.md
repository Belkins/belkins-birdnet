# Roadmap — the 90-day plan (Aug–Oct 2026)

*Snapshot maintained in-repo so a fresh clone can see where the project is going;
the full planning corpus (analysis lenses, specialist plans, red-team) lives
off-repo with the operator. Standing rulings: [DECISIONS.md](DECISIONS.md).*

**North star:** the wall keeps working, beautifully, unattended — and every claim
it makes (art, captions, status, backups) stays true. Effectiveness = fewer
silent-failure channels and less operator-memory dependence, not more ceremony.

## Sprint 1 (Aug 2–15) — stop the permanent losses · **largely DONE 2026-08-01**

- ✅ Continuity copies: station identity (`config/`) + volume plates
  (`plates-oneshot/`) in R2 through the crypt remote, round-trip verified; weekly
  `continuity-r2.timer` armed.
- ✅ Branch reconciliation: the marooned DR arc merged; `main` = the deployed tip;
  first annotated tags (`pi-2026-08-01`, `.1`); wall live-verified by content marker.
- ✅ `docs/DECISIONS.md` (17 rulings) · `docs/RUNBOOK.md` · `scripts/predeploy-gate.sh`.
- ✅ Timeout-retry in the plate fetcher (the weekly alert must not cry wolf).
- ✅ Dead-man's switch deployed + alarm watched firing (2026-08-02, `arm.sh`).
- ✅ Escrow entry in the owner's password manager (2026-08-02) — the October
  restore rehearsal is the end-to-end proof that closes the loop.
- ✅ The Accession Moment — shipped, review-hardened (the robin test), live.
- ⏳ **AudioMoth flash** (BatNET's season ends ~November) · Inky Impression
  13.3" hardware day (software fully landed; `frame/README.md` one-box section).

## Sprint 2–3 (Aug 16 – Sep 12) — make the guards true

- `verify.sh units` + run-proof: every repo-authored timer provably RUNNING on the
  box (ends the shipped-but-never-running class; makes the 30-day gate measurable).
- dist-fresh coverage of the unhashed public/ payloads (the 3.4 MB blind spot).
- `notify()` extraction to one module · realtime + derive.py first executable tests
  (mic_watch suite ✅ landed early, 2026-08-01).
- LibraryView decomposition (mechanical moves only) + companion CSS tokens.
- Purge-inertness hardware check · weekly ritual begins (`docs/OPERATIONS.md` §3).
- BatNET Phase 0 probe (256 kHz capture + offline ID) once the AudioMoth is flashed.

## September — behavior tests + the tab

- `/restore` endpoint + the bearer-auth dependency (undo for every removal power).
- Golden-plate weekly smoke (good must pass AND seeded-bad must fail; spend ledgered).
- PHP micro-harness — exec sinks first, then auth.
- Frame-Pi joins the alert net · Caddyfile drift alarm + DHCP pin fix.
- **BatNET Phase 1 — The Watch tab** only if the 30-day gate passed Aug 29
  (criterion: DECISIONS D2); else auto-defer, Phase 2 log-only in October.
- Voucher Export slice (DECISIONS D17).

## October — prove it once

- **Full restore rehearsal**: spare SD, rebuilt from RUNBOOK + escrow alone —
  no operator machine, no memory. The one test of the whole continuity story.
- BatNET Phase 2 (capture → night.db; `disable-batnet.sh` ships first).
- Gate review + Q4 decision pass (commercialization revisit, BatNET Phases 3–4).

## Not in these 90 days, deliberately

CI→Pi auto-deploy · second box/HA · refactors of collage.ts, App.tsx, upstream
`scripts/`, repo-guards structure · web render tests · new companion surfaces
beyond The Watch · any change to the LAN-open posture (DECISIONS D1).
