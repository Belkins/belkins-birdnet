<?php
// Belkins BirdNET - drawer menu items.
//
// Returns the list of links shown in the side drawer when a user clicks
// the menu button. The live JS expects {items: [{label, href, native}]}.
//
// AUTH: always required. Every item below is an ADMIN overlay, and all four
// sections behind them (settings, system, logs, tools) are now gated, so an
// anonymous caller has no use for this list.
//
// Low severity on its own — four static strings, no secrets, no writes — but it
// carried the same opt-in AV_REQUIRE_AUTH shape as config.php and
// birdnet-status.php, and it is the instance the first pass of that fix MISSED.
// It surfaced only because the repo guard written for the other two was
// negative-tested and turned out to be failing on this file for a real reason.
// Left ungated it would have been the surviving example that justifies weakening
// the guard later. See avian/api/_auth.php.

declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

require_once __DIR__ . '/_auth.php';
av_require_auth();

// All four items are in-app overlays. `native: true` tells the FE to
// route via `#admin=<section>` rather than opening a new window. We
// deliberately don't link out to BirdNET-Pi's stock pages - those stay
// reachable at /index.php, and the github link lives in the drawer
// footer credit next to the GitHub link.
echo json_encode([
    'items' => [
        ['label' => 'settings', 'href' => '/#admin=settings', 'native' => true],
        ['label' => 'system',   'href' => '/#admin=system',   'native' => true],
        ['label' => 'logs',     'href' => '/#admin=logs',     'native' => true],
        ['label' => 'tools',    'href' => '/#admin=tools',    'native' => true],
    ],
]);
