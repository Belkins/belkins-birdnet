# The Decision Register

*Adopted 2026-08-01. The founder-decision queue, formerly scattered across five gitignored
Mac-local planning docs, lives here — POPUP-BUDGET style — so a fresh clone can enumerate every
standing decision and nothing dead resurfaces in the next ideation pass. A row changes only by a
new dated ruling.*

| ID | Decision | Status | Date | Rationale · revisit trigger |
|---|---|---|---|---|
| D1 | Station is LAN-open (`STATION_OPEN="1"`), host-pinned | **DECIDED-YES** | 2026-07-30 | Owner-typed choice. Restore = `STATION_OPEN="0"` + `Caddyfile.bak-preopen-20260730`. Not a defect; work only ensures it survives a rebuild |
| D2 | 30-day surface gate criterion | **DECIDED** | 2026-08-01 | *Incident-free* 30 days: planned sprint work does NOT reset the clock; any unplanned intervention to keep the wall correct DOES. Clock from 2026-07-30 → earliest pass 2026-08-29; measured via verify.sh + ntfy history |
| D3 | BatNET "The Watch" night observatory | **DECIDED-GO** | 2026-08-01 | Phased: Phase 0 AudioMoth flash + 256 kHz probe (Aug, log-only); Phase 1 tab only after D2 passes; Phase 2 capture only after RUNNING-state checks exist, `disable-batnet.sh` ships first; October log-only fallback authorized to bank the season before torpor |
| D4 | Camera diptych (photograph + plate) | **OPEN** | 2026-08-01 | No pilot by default; the wall is painted, not photographed. Revisit trigger: a camera rig is actually calendared |
| D5 | The frame is silent | **DECIDED-YES (invariant)** | 2026-08-01 | The garden is the soundtrack; no speaker hardware, ever |
| D6 | Public exposure (yard page, OG cards) | **DECIDED-NO** | 2026-08-01 | Private by choice; sharing is served by save-plate exports + the weekly recap. Revisit trigger: that ever feels insufficient |
| D7 | Weekly digest prose | **DECIDED-YES deterministic** | 2026-08-01 | Ratifies what shipped; no LLM in `weekly_digest.py` |
| D8 | Repaint sub-budget shape | **DECIDED** | 2026-08-01 | Monthly $6 cliff (simplest accounting), not a daily allowance |
| D9 | Coarse `&e=` catalog epoch | **DECIDED-NO** | 2026-08-01 | Believed mooted by the 2026-07-30 immutable-`?v=` caching rework — **unverified**. Reopen trigger: warm-screen staleness observed on the wall |
| D10 | Cheap-tier companions (Scriptable widget, new-tab page) | **DECIDED-NO** | 2026-08-01 | Surface-sprawl kill-switch; a solo maintainer cannot feed them |
| D11 | Regional-completeness estimate | **DECIDED-NO** | 2026-08-01 | No consumer for the number |
| D12 | Commercialization | **DEFERRED** | 2026-08-01 | Past 2026-10-31. CC-BY-NC-SA ceiling = station-generated art only. First step when revisited: print ONE exported plate for the house and judge it |
| D13 | Dist-pin tagging | **DECIDED** | 2026-08-01 | Annotated tag `pi-YYYY-MM-DD[.n]` on every `chore(dist): pin` commit; "what is the wall serving" = `git describe`, not SSH archaeology |
| D14 | Golden-plate smoke-test spend | **DECIDED** | 2026-08-01 | Its Gemini judge calls are PAID and get their own budget row when the canary is built; the "$0" framing covers only the deterministic Pillow checks |
| D15 | `weekly_digest` as the weekly-ritual push trigger | **OPEN** | 2026-08-01 | Timer armed 2026-07-30, first fire Sun 2026-08-02 18:00. Decide after 2–3 sends whether its Sunday push anchors the maintenance ritual |
| D16 | Tuck allowlist | **CLOSED (mechanism)** | 2026-07-30 | `TUCK_SLUGS` env registry shipped, default empty; membership is a live ops knob, not a plan item |
