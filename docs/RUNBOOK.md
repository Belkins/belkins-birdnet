# RUNBOOK — rebuild the station from a dead SD card

*Stubbed 2026-08-01 (Sprint 1 of the 90-day plan). The full walk gets verified — and corrected —
by the October restore rehearsal on a spare card. Until then: every step below is assembled from
measured docs, not yet exercised end-to-end.*

1. Flash Raspberry Pi OS, run `newinstaller.sh` (the BirdNET-Pi fork install).
2. **Restore the station's identity from the encrypted backup.** Everything config lives in R2
   under `config/`: `birdnet.conf` (incl. `STATION_OPEN="1"` — the owner's deliberate LAN-open
   posture — and `CADDY_PWD`), the three `~/.christina/*.env` files, `Caddyfile.live`,
   `rclone.conf`. Install the **official rclone ≥ v1.74.4** (apt's 1.60.1 fails every R2 upload
   with 501), recreate the crypt remote with the escrowed passphrase (password-manager entry
   *Christina R2 + station*; the Mac copy is `~/.christina-keys/r2-crypt-key.txt`), then
   `rclone cat` each `config/` object into place.
3. `bash deploy-christina.sh`, then `bash deploy-realtime.sh` — **both**; the first installs no
   watchdogs. Then `bash avian/backup/install-cloud-backup.sh` — **the deploy scripts install NO
   backup timers**; skipping this leaves the rebuilt station with no nightly R2 backup and no
   weekly continuity refresh, silently, under a green install. (`install-backup.sh` too, if an
   off-box mount exists.) Negative-test the alarm per the installer's step 3.
4. Restore data: `rclone copy` back `db/`, the ledgers, `By_Date/` (~1.6 GB).
5. Caddy: copy `avian/ops/Caddyfile.live` → `/etc/caddy/Caddyfile`, **edit the `@badhost`
   host-pin IP** to the current lease (`hostname -I`), reload caddy. Never run the generator —
   it provably cannot reproduce this file.
6. Museum art: bundled plates are in git; volume-only plates are at `plates-oneshot/`,
   refreshed weekly by `continuity-r2.timer` (Sat 05:30) along with the `config/` identity set —
   **check the object timestamps (`rclone lsjson`) before trusting either prefix in a restore**;
   a stale prefix means the timer stopped and the alert net missed it.
7. Verify, never assume: `bash scripts/verify.sh`, the `art_status` histogram over
   `species.json`, `repo-guards.sh dist-served`, and a real bird rendering on the wall.

*Dead-man's switch: deployed + fire-tested 2026-08-02 via `deadman-worker/arm.sh`
(threshold lowered → alarm fired to the phone → restored to 30h → healthy verdict:
9,313 objects, newest 7.9h). Re-arm after any Cloudflare account change: `arm.sh`.*
