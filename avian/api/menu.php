<?php
// Belkins BirdNET - drawer menu items.
//
// Returns the list of links shown in the side drawer when a user clicks
// the menu button. The live JS expects {items: [{label, href, native}]}.
//
// Default LAN deploy: returns items immediately, no auth.
// Forwarded deploy:  set AV_REQUIRE_AUTH=1 in /etc/avian/env (or in your
// php-fpm pool's env block) AND configure Caddy basic_auth on /avian/api/
// to force the lock screen.

declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

// If forwarded mode is on AND no Basic-auth header arrived, 401 so the
// frontend shows the lock screen. The actual credential check is done
// by Caddy (basic_auth directive in forwarding/caddy-auth.caddy); this
// PHP only checks that *some* Authorization header reached us.
if (getenv('AV_REQUIRE_AUTH') === '1' && empty($_SERVER['HTTP_AUTHORIZATION'])) {
    http_response_code(401);
    echo json_encode(['error' => 'unauthorized']);
    exit;
}

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
