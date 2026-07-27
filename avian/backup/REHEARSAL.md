# Off-box backup — and the rehearsal that proves it

An archive nobody has ever opened is a belief, not a backup. This directory holds
both halves: the nightly job that gets the irreplaceable state off the box, and
the five-minute quarterly rehearsal that proves the archive is real. Run the
rehearsal or you do not have a backup — you have a habit.

## What is irreplaceable

Four things. Nothing else on this box is.

| Asset | Why it cannot be regenerated |
|---|---|
| `scripts/birds.db` | Every detection ever heard in the garden. BirdNET-Pi will happily start a new one; it will not recover the old one. |
| `scripts/accessions.json` | The append-only ledger that assigns each species its permanent plate number ("first writer wins, a pin is NEVER overwritten"). Lose it and the whole collection renumbers — for a museum whose entire conceit is permanent accession, that is the unrecoverable loss. |
| `scripts/phenology.json` | Freezes each closed year's phenology **before** `disk_check.sh` purges the rows behind it. Once those rows are gone the frozen years cannot be recomputed from anything. |
| The Railway volume plates | The ~40 London species painted on demand. They exist only on the Railway volume; the 250 bundled nearctic plates are in git and are deliberately **not** re-downloaded. |

Everything else regenerates: `christina.db`, `species.json` and `derived.json`
rebuild from `birds.db` every night at 03:30.

## Why this exists

`avian/catalog/backup-accessions.sh` — the ledger's only previous backup — writes
to `$REPO/scripts/accessions-backups`, i.e. **the same SD card**, inside the same
blast radius `.gitignore:76-78` already admits (`git clean -fdx` still removes
ignored files). It is a convenience copy for "I broke it five minutes ago", not a
backup. It still runs as `catalog.service`'s `ExecStartPre` and still prints
`snapshot -> …` to the journal; that line is not protection.

The Railway plates had no backup at all, and the failure mode that motivated the
loudest code in `offbox_backup.py` is this: **an empty Railway volume still serves
all 250 bundled slugs from `/app` and answers `/manifest` with a valid 200.** A
naive "which slugs are on the volume?" difference is therefore the empty set on
exactly the day the volume is wiped — and a naive job would report a green,
plate-free backup and then rotate the last good archives away. So here,
`expected == 0` is a **fault** (exit 3 + a push), not "nothing to do".

## Configuration

All of it comes from `~/.christina/backup.env` and `~/.christina/forwarder.env`
via the unit's `EnvironmentFile=` lines.

| Variable | Default | What happens when it is wrong |
|---|---|---|
| `CHRISTINA_BACKUP_DEST` | *(none — REQUIRED)* | Unset, missing, unwritable, or on the repo's own filesystem → **exit 2, nothing written**, one ntfy push. |
| `CHRISTINA_BACKUP_ALLOW_SAME_DEVICE` | *(unset)* | `1` disables the same-filesystem refusal. The offline-rehearsal escape hatch **only** — never set it on the Pi. |
| `CHRISTINA_BACKUP_KEEP` | `14` | Archives kept **per class** (complete and degraded rotate independently). `0` disables rotation. |
| `AV_RAILWAY_BASE` | *(from forwarder.env)* | Unset or unreachable → exit 3, DEGRADED; the db and both ledgers are still archived. |
| `NOTIFY_URL` | *(from forwarder.env)* | Unset → journal only. The alarm goes nowhere and nobody finds out. |
| `BACKUP_STATE` | `~/.christina/backup.state` | Holds `fails`/`down` plus the previous run's detection count, ledger sizes and plate count. **Delete it and every regression check loses its baseline** for one night. |
| `CHRISTINA_BACKUP_KEEP`/`_TIMEOUT`/`_BUDGET`/`_REALERT` | `14` / `20s` / `1200s` / `7` | `_BUDGET` bounds the plate loop so it degrades loudly before `TimeoutStartSec=1800` SIGTERMs the process ahead of its own push. `_REALERT` re-pushes a stuck alert every Nth night. |

`CHRISTINA_BACKUP_DEST` must be a **mount, and a network one first**: NFS / CIFS /
sshfs to a NAS or another machine. A USB stick plugged into the Pi passes the
same-filesystem check but does not survive theft, fire, or a hand knocking the
desk. They are not equivalent, and the code cannot tell them apart — you can.

A destination on the same filesystem as the repo is refused on purpose (exit 2).
That is the SD card this whole job exists to survive.

## The rehearsal — quarterly, five minutes, no Pi required

1. Copy the newest `christina-backup-*.tar.gz` **and its `.sha256`** off the mount
   to any machine with Python 3.
2. Copy `restore_offbox.py` next to it (it is deliberately standalone — it
   imports nothing from this repo).
3. Run it:

   ```
   python3 restore_offbox.py christina-backup-<stamp>.tar.gz
   ```

Expect **exit 0** and a printed table. **Exit 3 means the archive verified its
own integrity but is DEGRADED** — restorable, but incomplete (most often: zero
plates, because Railway was unreachable the night it ran). That is a failed
rehearsal, not a pass; go read the `degraded` findings it printed.

Read three numbers:

* **detections** — within a night's drift of what the wall shows.
* **accessions / phenology entries** — never fewer than last quarter.
* **plates fetched of expected** — equal, and expected roughly the museum's
  species count minus whatever is bundled.

Any non-zero exit means the archive is not a backup, and finding out why is the
next hour's work. The rehearsal writes nothing and touches nothing, so it is safe
to run on the live Pi.

## The real restore

```
python3 avian/backup/restore_offbox.py <archive> --apply --repo ~/BirdNET-Pi
sudo systemctl start catalog.service
bash scripts/verify.sh wall
```

`--apply` moves any existing `birds.db` / `accessions.json` / `phenology.json`
aside as `<name>.pre-restore-<stamp>` before writing (it never deletes), and drops
the plates into `avian/assets/illustrations/`. That directory is `cutout.php`
tier 1 (`avian/api/cutout.php:178`), which serves **before** the Railway proxy —
so the wall works with Railway completely dead. That is what makes this restore
real rather than advisory.

Those restored plates are untracked, and they inherit `scripts/accessions.json`'s
trap: **`git clean -fdx` will delete them.** The script prints this; do not read
it as a suggestion.

## What this does NOT cover

* **Pushing plates back to the Railway volume.** birdgen exposes no upload
  endpoint and adding one is out of scope. Restore reinstates them into
  cutout.php tier 1 instead, which is the real recovery path. Re-pointing Railway
  at a fresh volume is a separate, manual, later job.
* **The Railway lease/job SQLite** on the volume. No endpoint exposes it. After a
  volume loss birdgen re-derives `done` from the PNGs present, so a
  restored-to-the-Pi collection still renders; only per-slug attempt/backoff
  history is lost, and that regenerates.
* **BirdSongs recordings** (tens of GB). The accession clips are pinned against
  `disk_check.sh` separately; that is a different mechanism, not a backup.
* **A stalled NFS/CIFS mount.** Every filesystem call blocks rather than errors,
  so `resolve_dest()` hangs and `TimeoutStartSec=1800` kills the process before
  `notify()` is ever reached. That outage is **journal-only, with no phone push** —
  the one failure mode most likely on a network mount. If the nightly line stops
  appearing in `journalctl -u offbox-backup`, check the mount by hand.
* **A blank-but-valid archive.** Guarded, not eliminated: a zero-row `birds.db`,
  an unreadable schema, a vanished ledger and an empty volume-only plate set all
  degrade loudly now, and `restore_offbox.py` refuses an archive whose manifest
  records a null detection count. What no code can catch is an archive that is
  perfectly intact and simply old, which is what the quarterly date check is for.

## Where the alarm goes

The same `NOTIFY_URL` ntfy topic as `mic-watch` and `railway-liveness`. That
sharing is why every non-zero path here is gated: one push on the transition into
failure, then a re-push every 7th consecutive night, then a `RECOVERED` push. A
job that pushed nightly would get the topic muted — and a muted topic silences the
dead-mic and dead-Railway alerts too.

| Exit | Meaning | What to do |
|---|---|---|
| `0` | COMPLETE — db + both ledgers + every expected plate. | Nothing. |
| `2` | REFUSED — destination unset/missing/unwritable/same-filesystem. **Nothing was written.** | Fix `~/.christina/backup.env`, then `sudo systemctl start offbox-backup`. |
| `3` | DEGRADED — the archive exists and holds the db + ledgers, but something is missing or suspect. | Read the `DEGRADED:` lines the rehearsal prints. An `EMPTY … VOLUME IS GONE` line is an emergency: the plates are unbacked-up *right now*. |
| `4` | FAULT — nothing usable was published (unreadable db, unwritable archive, or a crash). | `journalctl -u offbox-backup -n 50`. |

First live run: `sudo systemctl start offbox-backup` followed by
`journalctl -u offbox-backup -n 50` — do not wait for 04:30 to find out whether
the unit parses. The units in this directory could not be validated offline
(`systemd-analyze verify` is not available on the machine they were written on);
they were reviewed against `railway-liveness.service` and `catalog.timer` by eye.
