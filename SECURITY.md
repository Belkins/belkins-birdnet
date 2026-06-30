# Security model — Belkins BirdNET (Project Christina)

This is a hobby / craft deployment. It is designed to run as an **outbound
sensor + LAN display**: the Raspberry Pi detects birds locally and forwards
events to a Railway backend; it is **not intended to be publicly exposed** as-is.

## Web-layer privileges (the important one)

The `caddy` user runs `php-fpm`, and therefore the admin-overlay PHP
(`avian/api/*.php`). It is granted **passwordless sudo for a fixed allowlist
only** — the exact `systemctl restart <unit>` and `journalctl -u <unit>`
commands the overlay shells out — via `/etc/sudoers.d/020_avian-admin`.

It is **NOT** granted `NOPASSWD: ALL`. A compromise of the web layer therefore
cannot become root or run arbitrary commands. Earlier installs shipped a
`010_caddy-nopasswd` rule with `NOPASSWD: ALL`; `install_services.sh` now
**removes it on every run**, so re-running the installer hardens an existing Pi.

The allowlist **must stay in sync** with `ALLOWED_UNITS` in
`avian/api/birdnet-status.php` (the `restart` and `logs` actions). If you add a
unit there, add its `restart` + `journalctl` lines to `020_avian-admin`.

### Consequence (by design)
Stock BirdNET-Pi admin actions that need broad root — reboot/shutdown, package
updates, restarting arbitrary services — are **not available to the web UI**.
Perform those over SSH. This is the intended trade for not running a
remote-root web box.

## Before exposing this beyond your LAN
1. Confirm the legacy rule is gone: `ls /etc/sudoers.d/` shows no `010_caddy-nopasswd`.
2. Set `AV_REQUIRE_AUTH=1` and put Caddy `basic_auth` in front of `/avian/api/`
   (the PHP already returns 401 when that env is set).
3. Review what the stock BirdNET-Pi UI at `/` exposes; gate or disable it.
4. Keep the Gemini API key server-side (Railway only) — never on the Pi or in
   the repo. The Pi-side forwarder holds only the webhook secret.

## Reporting
This is a personal project. Open a private issue or contact the maintainer
directly rather than filing a public issue with exploit detail.
