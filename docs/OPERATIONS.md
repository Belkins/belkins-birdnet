# Operations — one writer, one recipe, thirty minutes a week

*Adopted 2026-08-02. This is the operating protocol that used to live only in one
machine's session memory — promoted here so any fresh session, on any machine,
works the station the same way. Companion registers: [DECISIONS.md](DECISIONS.md)
(standing rulings) and [RUNBOOK.md](RUNBOOK.md) (rebuild from a dead SD card).*

## 1. The session protocol (shared checkout, possibly-concurrent sessions)

The 2026-07/08 branch tangle — 17 stale branches, two divergent same-day histories,
a disaster-recovery arc marooned off `main` — came from sessions writing one history
without knowing about each other. The rules that ended it:

1. **First action of any writing session:** `git fetch` · `git reflog -5 --date=iso`
   (timestamps you don't recognize = another writer) · `git worktree list` ·
   `pgrep -fl claude`. If another session is live and productive, **partition lanes
   through the owner** — never freeze, never race.
2. **One writer to `origin/main` at a time.** Feature work happens in its own
   worktree on its own branch; never `git checkout` in a shared tree; branch before
   the first commit.
3. Commit by explicit path only. Re-read `git log -1` between commit and push; read
   the push output's range SHAs — **a push publishes whatever the tip holds**,
   including another session's commits.
4. Compare branches by `git cherry` / patch-id, never by subject line (cherry-picked
   twins share subjects, not SHAs).
5. **Never create a `sync*` branch.** If `main` won't move, a worktree is pinning
   it — remove the worktree.
6. Process probes must not self-match: bracket the pattern (`[d]eploy-…`) AND keep
   the payload string out of the probing command line (three self-matching pgrep
   probes in one evening, 2026-08-01).

## 2. The deploy recipe (canonical form)

Everything deployable is **committed and pushed to `origin/main` first** — the Pi
consumes git; loose rsyncs and scp'd files are wiped by the next checkout.

1. Mac: build `web/` with `--base=/collage/`; run `scripts/predeploy-gate.sh` — it
   validates the bundle and **prints** the exact rsync + symlink commands (copied,
   never remembered).
2. Pi: `git fetch && git merge origin/main --no-edit` (merge, never pull --ff-only —
   the Pi keeps local pin commits). Check conflicts with
   `git diff --name-only --diff-filter=U`, never a piped exit code. A conflicted
   `web/dist` is resolved **wholesale** — `git checkout <tip> -- web/dist` — never
   file-by-file `--theirs` (add/add pairs error and leave marker-corrupted files:
   happened 2026-08-01, committed conflict markers into three shell scripts).
   After any conflicted merge: `git grep -l '^<<<<<<< '` before committing.
3. Pi: `bash deploy-christina.sh`, and `bash deploy-realtime.sh` when units changed,
   and `bash avian/backup/install-cloud-backup.sh` when backup units changed.
4. **Tag every deploy**: annotated `pi-YYYY-MM-DD[.n]` (DECISIONS D13) —
   "what is the wall serving" must be `git describe`, not SSH archaeology.
5. Verify by **content marker, never status code** (this box answers 200 with an
   805-byte fallback for dead URLs): the served `index-*.js` hash must match the
   committed dist, and the old hash must be absent.

## 3. The maintenance floor (~30 min/week)

**Weekly (Monday):** on the Pi — `bash scripts/verify.sh` · the art_status
histogram over `species.json` (a jump in `none` is a failed manifest fetch, not a
discovery about the birds) · glance the ntfy history (dead-man silence = healthy,
once it is deployed) · eyeball the wall itself. On the Mac — `bash
scripts/repo-guards.sh` (exit code, not output).

**The timers watch themselves** — every avian unit carries
`OnFailure=christina-alert@%n`, so a red night pushes to the phone. The weekly
`continuity-r2.timer` (Sat 05:30) refreshes the station's R2 identity set and the
volume-plate archive; a DEGRADED run uploads first, then alerts.

**Monthly:** one restore spot-drill (`rclone cat` a ledger through the crypt
layer, rotating which) · R2 object-count trend · `git ls-remote --heads origin
'sync*'` (non-empty = protocol breach) · a pass over DECISIONS.md for stale rows.

## 4. Where truth lives

| What | Where |
|---|---|
| Standing rulings (posture, gates, kills) | `docs/DECISIONS.md` |
| Rebuild-from-dead-SD walk | `docs/RUNBOOK.md` |
| Sprint state + what's next | `docs/ROADMAP.md` |
| Popup restraint constitution | `docs/POPUP-BUDGET.md` |
| Deliberately-uninstalled units | `avian/NOT-INSTALLED` |
| Architectural invariants, enforced | `scripts/repo-guards.sh` (the guards ARE the architecture doc) |
