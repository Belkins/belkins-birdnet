/**
 * Christina — dead-man's switch for the encrypted R2 backup.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every alarm this project has runs ON the Pi. christina-alert@.service pushes to
 * ntfy when a unit FAILS — but it cannot report a unit that never ran, a timer
 * that was disabled, or a Pi that is simply dead, because in all three cases
 * nothing on the box is alive to notice. avian/backup/README.md §6 says this
 * plainly: "OnFailure= cannot fire for a unit that is not installed... Only a
 * human reading `systemctl list-timers` catches that one."
 *
 * That is the exact failure that created avian/backup/: an off-box backup was
 * written, tested, committed, and never switched on, and a month of irreplaceable
 * detections sat on one SD card while a green tree implied otherwise.
 *
 * THE IDEA
 * --------
 * The nightly backup already writes to R2. So the FRESHNESS OF THE BUCKET IS THE
 * HEARTBEAT — no new daemon, no new secret, and nothing new on the Pi that could
 * itself fail silently. This Worker runs on Cloudflare's cron, lists the bucket,
 * finds the newest object, and shouts to the same ntfy topic the Pi already uses
 * if nothing has been written recently.
 *
 * It survives what the Pi cannot report: the SD card dying, the timer being
 * disabled, the box being unplugged, the wifi being down, someone running
 * `systemctl stop`. If the station goes quiet, this notices.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It never writes to or deletes from the bucket. It is a read-only observer.
 * The operator's standing rule is that nothing is ever deleted, and an alerting
 * mechanism with write access to the thing it watches is a bad trade.
 */

const STALE_HOURS = 30;   // nightly runs at 04:45; 30h tolerates one missed night
                          // plus clock drift without crying wolf. Two consecutive
                          // misses is a real signal; one late run is not.

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(check(env));
  },

  // GET / also runs the check, so the switch itself can be tested by hand
  // rather than being trusted because it was deployed. An alarm nobody has
  // ever seen fire is not an alarm.
  async fetch(request, env) {
    const r = await check(env, true);
    return new Response(JSON.stringify(r, null, 2), {
      headers: { 'content-type': 'application/json' },
    });
  },
};

async function check(env, dryRun = false) {
  let newest = null;
  let count = 0;

  // Paginate: the bucket holds ~8,800 objects and list() caps at 1000.
  let cursor = undefined;
  do {
    const page = await env.ARCHIVE.list({ limit: 1000, cursor });
    for (const o of page.objects) {
      count++;
      const t = o.uploaded instanceof Date ? o.uploaded : new Date(o.uploaded);
      if (!newest || t > newest) newest = t;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const now = new Date();
  const ageHours = newest ? (now - newest) / 3600000 : Infinity;
  const stale = ageHours > STALE_HOURS;

  const result = {
    checkedAt: now.toISOString(),
    newestObject: newest ? newest.toISOString() : null,
    ageHours: Number.isFinite(ageHours) ? Number(ageHours.toFixed(2)) : null,
    objectCount: count,
    staleThresholdHours: STALE_HOURS,
    stale,
  };

  // An EMPTY bucket is not "fresh", it is the worst possible state — treat a
  // missing newest timestamp as stale, never as OK. This is the fail-closed
  // half; a check that reports healthy when it found nothing is the exact bug
  // class this repo keeps hitting.
  if (stale && !dryRun && env.NOTIFY_URL) {
    const msg = newest
      ? `CHRISTINA BACKUP HAS STOPPED. Newest object in R2 is ${result.ageHours}h old ` +
        `(threshold ${STALE_HOURS}h). The Pi is not backing up: it may be dead, offline, ` +
        `or cloud-backup.timer may be disabled. Nothing on the box can tell you this — ` +
        `that is why this check runs off it. Diagnose: ssh the Pi, then ` +
        `systemctl list-timers cloud-backup.timer ; journalctl -u cloud-backup.service -n 50`
      : `CHRISTINA BACKUP BUCKET IS EMPTY (${count} objects). Either the archive was ` +
        `never seeded or something removed it. This is the loudest state this check has.`;

    await fetch(env.NOTIFY_URL, {
      method: 'POST',
      body: msg,
      headers: {
        Title: 'Christina: OFF-SITE BACKUP HAS STOPPED',
        Priority: 'urgent',
        Tags: 'rotating_light',
      },
    });
    result.notified = true;
  }

  return result;
}
