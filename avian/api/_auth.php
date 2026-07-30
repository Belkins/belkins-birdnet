<?php
// Fail-CLOSED auth for the avian JSON API.
//
// WHAT THIS REPLACES, and why it is not a style change:
//
//     if (getenv('AV_REQUIRE_AUTH') === '1' && empty($_SERVER['HTTP_AUTHORIZATION']))
//
// That guard is off unless an env var is set, and on this station it was never
// set. Measured on the live Pi 2026-07-30, unauthenticated over the LAN:
//
//   GET  /avian/api/config.php         -> 200, handed out LATITUDE 51.5081,
//                                         LONGITUDE -0.1278, thresholds, site name
//   POST /avian/api/config.php         -> rewrote birdnet.conf (LATITUDE, CONFIDENCE,
//                                         FULL_DISK=purge, PURGE_THRESHOLD ...) and
//                                         restarted the analyser
//   POST /avian/api/birdnet-status.php?action=restart&unit=livestream
//                                      -> sudo systemctl restart, no password
//
// The July 2026 hardening gated /By_Date and /Charts precisely to stop occupancy
// inference, then missed the endpoint that publishes the coordinates outright.
// A guard whose default is "allow" is the same fail-open shape this project has
// now hit repeatedly; the cure is that the default must be "deny".
//
// Same credential and the same rule as scripts/common.php's is_authenticated():
// the password is CADDY_PWD from birdnet.conf, and an install with no password
// configured is LOCKED, never open. Deliberately NOT an include of common.php —
// that file lives in a different tree, opens sessions and emits HTML error
// bodies, none of which belong in a JSON API.
//
// Scope note: regen.php is intentionally LAN-open (the repaint button, bounded
// by its own spend budget) and is NOT gated here. cutout.php is the art
// pipeline's cache proxy and is likewise left alone. This file gates the two
// endpoints that read or write STATION CONFIGURATION AND SERVICE STATE.
declare(strict_types=1);

/**
 * Read CADDY_PWD out of birdnet.conf without sourcing it.
 *
 * Returns '' when the file is unreadable, absent, or the key is missing — every
 * one of which must land the caller in the locked branch, never the open one.
 */
function av_station_password(): string
{
    // .../BirdNET-Pi/avian/api/_auth.php -> .../BirdNET-Pi/birdnet.conf
    $conf = dirname(__DIR__, 2) . '/birdnet.conf';
    if (!is_readable($conf)) {
        return '';
    }
    $lines = @file($conf, FILE_IGNORE_NEW_LINES);
    if ($lines === false) {
        return '';
    }
    foreach ($lines as $line) {
        if ($line === '' || $line[0] === '#') {
            continue;
        }
        if (preg_match('/^\s*CADDY_PWD\s*=\s*(.*)$/', $line, $m)) {
            $val = trim($m[1]);
            // Strip one layer of surrounding quotes, matching how the shell
            // sources this file and how config.php's own read_conf() parses it.
            if (strlen($val) >= 2 && $val[0] === '"' && substr($val, -1) === '"') {
                $val = substr($val, 1, -1);
            }
            return $val;
        }
    }
    return '';
}

/**
 * Demand HTTP Basic credentials matching the station password, or exit 401.
 *
 * Only the password is compared, matching scripts/common.php — Caddy owns the
 * username. hash_equals keeps the comparison timing-safe, and the empty-password
 * case is rejected BEFORE the comparison so that a station with no CADDY_PWD
 * cannot be opened by sending an empty password.
 */
function av_require_auth(): void
{
    $expected = av_station_password();
    $given = (string)($_SERVER['PHP_AUTH_PW'] ?? '');

    if ($expected === '' || !hash_equals($expected, $given)) {
        header('WWW-Authenticate: Basic realm="Belkins BirdNET station"');
        http_response_code(401);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['error' => 'unauthorized']);
        exit;
    }
}
