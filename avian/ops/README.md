# ops — configuration that lives on the box and nowhere else

## `Caddyfile.live`

A tracked copy of `/etc/caddy/Caddyfile` as actually served. It is here because
**it cannot be regenerated.**

`scripts/update_caddyfile.sh` is the generator, and it refuses to run
(`STATION_OPEN=1`, exit 2) precisely because it cannot reproduce this file. Strip
the comments from that script and it emits **zero** matches for `encode` or
`immutable`. What it would silently discard:

| directive | what is lost |
|---|---|
| `@nostream` + `encode @nostream zstd gzip` | first-load text goes 182,160 B → 690,437 B. The `/events` exclusion is load-bearing: SSE is `text/event-stream`, which matches encode's default `text/*` list, so a bare `encode` buffers the realtime spine dead while every asset check still passes. |
| `@immutable path /collage/assets/*` | immutable caching on content-hashed assets. Deliberately scoped so `species.json` and `derived.json` (nightly-rebuilt symlinks) never get it. |
| `reverse_proxy /events` + `flush_interval -1` | the realtime spine the museum's live wall depends on |
| `@badhost` / `abort` | DNS-rebinding defence (Host pinning) |

None of that fails loudly if reverted. The wall just quietly serves 3.8× more
bytes and stops updating live, and nobody connects it to a config rewrite weeks
earlier.

**This copy is documentation, not a deployment source.** Nothing applies it
automatically — restoring it is a deliberate human act. Diff before you copy:

```sh
ssh belkins@birdnet.local 'sudo cat /etc/caddy/Caddyfile' | diff - avian/ops/Caddyfile.live
```

It carries no credentials. The station is deliberately LAN-open
(`STATION_OPEN=1` in `birdnet.conf`, set 2026-07-30), so the `basic_auth` blocks
that used to gate 11 paths are gone. **If that choice is ever reverted, this file
will contain bcrypt hashes and must NOT be committed** — re-run the gate first:

```sh
grep -vE '^\s*#' Caddyfile.live | grep -cEi 'basic_?auth|\$2[aby]\$'   # must be 0
```
