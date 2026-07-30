# Off-box backup — what you must decide, and what to run

> **Status, measured on the live Pi on 2026-07-30:**
> `offbox-backup.timer` and `offbox-backup.service` are **not installed**.
> `~/.christina/backup.env` does not exist. `CHRISTINA_BACKUP_DEST` is unset.
> **The backup has never run. Not once.**
>
> The code was written, tested and committed on 2026-07-27. Nothing was wrong
> with it. It simply was never switched on, and nothing anywhere said so — which
> is the same disease as the `OnFailure=` gap this directory now also fixes.

The one thing standing between you and a working backup is a decision only you
can make: **where does the archive go?** This file is that decision, laid out
honestly, plus the four commands that follow it.

---

## 1. The situation, in measurements

Read off the box on 2026-07-30 (`df -PT`, `lsblk`, `lsusb`, `/etc/fstab`, `ls /media /mnt`):

| Fact | Value |
|---|---|
| Block devices | `mmcblk0` (29.5 GB SD card) and `zram0` (swap). Nothing else. |
| Filesystems | `/dev/mmcblk0p2` → `/` (29.9 GB, 46% used, 14.8 GB free), `/dev/mmcblk0p1` → `/boot/firmware`. Everything else is tmpfs. |
| `/media`, `/mnt` | Both empty. |
| USB devices | One: `3302:00da TTGK Technology USB Audio` — the microphone. **No storage.** |
| `/etc/fstab` | `proc`, `/boot/firmware`, `/`. No other mounts. |
| Irreplaceable local files | `scripts/birds.db` 1.2 MB · `scripts/accessions.json` 8 KB · `scripts/phenology.json` 24 KB |

So: **there is no off-box storage attached to this Pi.** Not unmounted — not
present. Everything the station has ever heard sits on one SD card.

Note the sizes. A 14-deep rotation of a 1.2 MB database is not a capacity
problem. **Capacity is not what you are choosing between. You are choosing
which failure you want to survive.**

---

## 2. The honest options

Each row is what it actually protects against. `offbox_backup.py` writes a dated
`.tar.gz` to a **filesystem path**; options 1–3 give it one, option 4 does not.

### Option 1 — USB SSD or flash drive plugged into the Pi
Mount it at e.g. `/mnt/christina-backup`, then point `CHRISTINA_BACKUP_DEST` there.

* **Survives:** SD-card death or corruption (the likeliest failure by far — this
  card has been continuously written since 2026-06-30), a bad `git clean -fdx`,
  a botched reinstall of BirdNET-Pi.
* **Does NOT survive:** theft, fire, flood, or the whole frame walking off. Both
  copies live in the same room, on the same power strip.
* **Cost:** one drive, ~zero setup, no network, no account, no credentials.
* **Watch out:** put `nofail` in the `fstab` line, or an absent drive blocks
  boot. But `nofail` means that when the drive *is* absent, `/mnt/christina-backup`
  is just an empty directory **on the SD card**, and a naive backup would happily
  write there and look green. That is exactly the case `install-backup.sh` gate 3
  and `offbox_backup.py:176-181` refuse, by comparing `st_dev` rather than
  trusting the path. Prefer an SSD over a flash stick: flash endurance under a
  nightly write is poor, and a backup medium that dies quietly is not a backup.
* **fstab shape** (get the UUID from `lsblk -o NAME,UUID,FSTYPE`):
  ```
  UUID=<uuid>  /mnt/christina-backup  ext4  defaults,nofail,noatime  0  2
  ```

### Option 2 — A share on another machine on the LAN (NAS, or the operator's Mac)
Mount NFS/SMB at e.g. `/mnt/christina-backup`.

* **Survives:** everything option 1 survives, **plus** the Pi itself being
  stolen or destroyed — as long as the other machine is somewhere else.
* **Does NOT survive:** the house. Still one building.
* **Watch out:** the other machine has to be awake and the share mounted at
  **04:30**. A laptop that sleeps will simply miss nights, silently, and a
  laptop that sleeps *mid-write* leaves a stale mount — which is why
  `offbox-backup.service` carries `TimeoutStartSec=1800` and why that unit now
  carries `OnFailure=`. `Persistent=true` catches up a missed timer on the
  **Pi's** next boot, not on the laptop's.
* A NAS or an always-on mini-PC makes this the best of the local options. A
  laptop makes it unreliable in a way you will not notice for months.

### Option 3 — Pull instead of push: another machine `rsync`s *from* the Pi
No `CHRISTINA_BACKUP_DEST`, no timer on the Pi, none of this directory's units.

* **Survives:** the same as option 2, and additionally a compromised Pi cannot
  reach into your backups, because the Pi holds no credentials and no mount.
* **Does NOT survive:** being forgotten. **This repo has no unit for it**, so
  "was it ever switched on, and is it still running?" moves to the other machine
  — the exact question that produced this file. If you pick this, put it behind
  something that shouts when it stops.
* The full copy taken by hand to the operator's Mac on 2026-07-30 is this option,
  performed once, manually. It means the data is not at single-point risk *today*.
  It is not a backup system; it is one good afternoon.

### Option 4 — Off-site object storage (S3 / B2 / rclone)
* **Survives:** the building. This is the only row that does.
* **Cost:** a new runtime dependency (`rclone` or an SDK) and a credential on the
  Pi. `offbox_backup.py` is deliberately stdlib-only and filesystem-only, so
  **this option needs code that does not exist yet.** Do not pretend otherwise.
* A workable middle path: pick option 1 or 2 now, and let something else
  replicate that destination off-site.

### Option 5 — Do nothing
* **Survives:** nothing. One card holds 4,170 detections, 47 species, the
  permanent accession numbers, and a phenology ledger that cannot be
  reconstructed once the source rows age out.
* It is listed so it stays a *decision* rather than a *default*. It has been the
  default since 2026-06-30.

---

## 3. What to run, once you have decided

All of this runs **on the Pi**, from the repo checkout. Nothing here starts a
generation, and nothing touches `birds.db`.

```bash
# 0. Sanity-check the unit files systemd will actually load (read-only).
systemd-analyze verify avian/realtime/christina-alert@.service \
                       avian/backup/offbox-backup.service \
                       avian/backup/offbox-backup.timer

# 1. Attach and mount the destination you chose above. Then prove it is real:
findmnt /mnt/christina-backup     # must print a source that is NOT /dev/mmcblk0p2

# 2. Validate without installing anything. This is safe to run repeatedly.
CHRISTINA_BACKUP_DEST=/mnt/christina-backup \
  bash avian/backup/install-backup.sh --dry-run

# 3. Install for real (uses sudo; idempotent; never clobbers an existing backup.env).
CHRISTINA_BACKUP_DEST=/mnt/christina-backup \
  bash avian/backup/install-backup.sh

# 4. Do not wait until 04:30 to find out. Force the first run and read it.
sudo systemctl start offbox-backup.service
journalctl -u offbox-backup.service -n 60 --no-pager
ls -lh /mnt/christina-backup

# 5. Prove the ALARM works, not just the backup. This deliberately fires the
#    handler; your phone should buzz within seconds.
sudo systemctl start christina-alert@offbox-backup.service
journalctl -u 'christina-alert@offbox-backup.service' -n 20 --no-pager

# 6. Prove you can RESTORE. An unrestorable archive is a rumour. See REHEARSAL.md.
python3 avian/backup/restore_offbox.py --help
```

Step 5 is not optional. This project has five recorded incidents of a guard that
could not fire; the only way to know this one can is to make it.

---

## 4. `install-backup.sh` refuses rather than pretends

It validates **before** it touches systemd, and every failure exits non-zero with
a named reason and installs nothing.

| Exit | Refusal |
|---:|---|
| 0 | installed (or `--dry-run` validated clean) |
| 1 | no `python3`, or a repo/home path containing `\|` or `&` that cannot be rendered into a unit safely |
| 2 | `CHRISTINA_BACKUP_DEST` unset, empty, or still `REPLACE_ME_…` |
| 3 | the destination does not exist, or is not a directory |
| 4 | **the destination is on the same filesystem as the repo** (the SD card), or lives inside the repo tree |
| 5 | the destination is not writable — proven by writing a probe file, reading it back, and comparing, because `test -w` passes for root on a read-only mount |
| 6 | the `OnFailure` handler is missing, has grown an `OnFailure=` of its own (an infinite alert loop), or its inline payload contains a raw `%` |
| 7 | no `systemd` on this host — validation still ran, but nothing can be installed here |

Exit 4 is the one that matters. A copy of `birds.db` sitting next to `birds.db`
on the same card is **worse than no backup**: it survives nothing the original
does not survive, while looking exactly like safety and stopping anyone from
arranging the real thing. The check is `os.stat().st_dev`, the same test
`offbox_backup.py` applies at 04:30, so the installer can never arm something the
runtime will refuse.

`CHRISTINA_BACKUP_ALLOW_SAME_DEVICE=1` is honoured by `offbox_backup.py` for
**offline rehearsal** and is deliberately **not** honoured by the installer. To
rehearse:

```bash
CHRISTINA_BACKUP_ALLOW_SAME_DEVICE=1 CHRISTINA_BACKUP_DEST=/tmp/rehearsal \
  python3 avian/backup/offbox_backup.py
```

A rehearsal is not a thing to arm on a timer and forget.

---

## 5. The other half: failures are now loud

Before this change, **no unit in this repo carried `OnFailure=`**. A red unit was
visible only to somebody who happened to type `systemctl --failed`. At 03:30 and
04:30, nobody does.

`avian/realtime/christina-alert@.service` is now the handler for every unit this
repo installs — `offbox-backup`, `catalog`, `birdcast`, `forwarder`, `mic-watch`,
`railway-liveness`, `weekly_digest` — via `OnFailure=christina-alert@%n.service`.
It writes the failed unit's status and last 60 journal lines into the journal
first (that record must not depend on the network), then pushes to the **same**
`NOTIFY_URL` ntfy topic `railway_liveness.py`, `mic_watch.py`, `weekly_digest.py`
and `offbox_backup.py` already use. No second channel was invented.

Three properties, each deliberate:

* **It cannot loop.** The handler carries no `OnFailure=` of its own, and refuses
  at run time if it is ever asked to alert about an instance of itself.
  `install-backup.sh` gate 6 fails the install if either property is lost.
* **It cannot fail silently.** No `NOTIFY_URL`, or a push that does not go
  through, exits non-zero — so `systemctl --failed` shows
  `christina-alert@<unit>`, which still names the unit that died. The journal
  line is written before the push is attempted, so a dead channel still leaves a
  record.
* **The first two `ExecStart=` lines are `-` prefixed, the push is not.**
  `systemctl status` of a failed unit exits 3, and an un-prefixed non-zero
  `ExecStart` means the rest are not executed — the trap that let a loud exit-3
  silently skip `derive.py` for 24 days (see `avian/catalog/catalog.service:34-39`).

`birdcast.service` and `forwarder.service` additionally got
`StartLimitIntervalSec=600` / `StartLimitBurst=20`. With the systemd default
(5 starts / 10 s, measured on the box) and `RestartSec=10`, birdcast could
crash-loop **forever** without ever reaching `failed`, so its `OnFailure=` would
never once have fired. The trade-off is explicit: after 20 crashes in 10 minutes
the unit stays down until `systemctl reset-failed`. A frame that is visibly dead
beats a frame that is invisibly dying.

**Caveat, and it is a real one:** the units *declare* `OnFailure=`, but the
handler only exists on the box once `christina-alert@.service` has been
installed. `install-backup.sh` installs it. `deploy-realtime.sh` and
`deploy-christina.sh` do not yet — so **re-run `install-backup.sh` after any
deploy**, or the declaration is inert. A unit whose `OnFailure=` target is
missing still fails normally; systemd just logs that it could not enqueue the
handler. Nothing breaks — but nothing shouts either.

---

## 6. What this still does not cover

* **`weekly_digest.timer` is not installed on the Pi either** (measured
  2026-07-30 via `systemctl list-timers`). The Sunday recap has never been sent.
  Same disease, different unit; installing it lives in `deploy-realtime.sh`.
* **`OnFailure=` cannot fire for a unit that is not installed.** It reports units
  that run and fail. It says nothing about units that were never switched on —
  which is the failure that produced this whole directory. Only a human reading
  `systemctl list-timers` catches that one.
* **A timer that is disabled is not a failure.** Neither is a `ConditionPathExists=`
  that skips `mic-watch`. Both are `inactive`, not `failed`.
* Restore is rehearsed, not automated. See `REHEARSAL.md`.
