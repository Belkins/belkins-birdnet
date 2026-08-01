# Dead-man's switch — does anything notice when the backup STOPS?

Every alarm in this repo runs on the Pi, so none of them can report the Pi being
dead, the timer being disabled, or a unit that never ran at all. `README.md` §6
already admits this. It is also the exact failure that created this directory.

The nightly backup writes to R2, so **the freshness of the bucket is the
heartbeat**. This Worker reads it from Cloudflare's side and shouts to the ntfy
topic the Pi already uses. Nothing new runs on the Pi, so there is no new thing
that can itself fail silently.

## Deploy (about two minutes)

```sh
cd avian/backup/deadman-worker
npx wrangler login                 # opens a browser once
npx wrangler secret put NOTIFY_URL # paste the ntfy URL from ~/.christina/forwarder.env
npx wrangler deploy
```

## Then PROVE IT FIRES — do not skip this

An alarm nobody has watched fire is not an alarm, it is a hope.

```sh
# 1. the check runs on GET, so you can read its verdict by hand:
curl https://christina-deadman.<your-subdomain>.workers.dev

#    expect: "stale": false and an ageHours under ~24
#
# 2. to see it actually ALERT, temporarily lower the threshold:
#    edit STALE_HOURS in worker.js to 0.001, `npx wrangler deploy`, wait for the
#    cron or hit the URL, confirm your phone buzzes, then PUT IT BACK to 30.
```

## What it costs

Cloudflare Workers free tier: 100,000 requests/day. This uses one per day.
It never writes to the bucket and never deletes anything.

## What it does NOT cover

* It cannot tell you the backup uploaded the *wrong* bytes — `cloud-backup.sh`'s
  sha256 round-trip and sampled read-back do that, on the Pi.
* It cannot tell you the Pi is detecting birds. It only watches the archive.
* If Cloudflare itself is down, it is silent — but so is everything else.
