<?php
// Belkins BirdNET - Wikipedia summary proxy.
//
// The detail modal calls /avian/api/wiki.php?sci=<name> for the species
// description. We hit Wikipedia's REST summary endpoint and return the
// extract + thumbnail. Cached at the browser + Caddy edge for 24 h
// because species descriptions don't really change.
//
// Pinned to wikimedia.org / wikipedia.org for the photo URL to block
// SSRF if Wikipedia ever returns a poisoned redirect target.

declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: public, max-age=86400');

$sci = trim((string)($_GET['sci'] ?? ''));
if ($sci === '') {
    http_response_code(400);
    echo json_encode(['error' => 'sci required']);
    exit;
}
if (!preg_match('/^[A-Za-z]{2,40}(?:[ ][a-z]{2,40}){1,3}$/', $sci)) {
    http_response_code(400);
    echo json_encode(['error' => 'invalid sci']);
    exit;
}

$ua = getenv('AV_USER_AGENT') ?: 'Belkins-BirdNET/1.0 (+https://github.com/Belkins/belkins-birdnet)';
$ctx = stream_context_create([
    'http' => ['header' => "User-Agent: $ua\r\n", 'timeout' => 8],
]);
$url = 'https://en.wikipedia.org/api/rest_v1/page/summary/' . rawurlencode($sci);
$raw = @file_get_contents($url, false, $ctx);
if ($raw === false) {
    echo json_encode(['extract' => null, 'thumbnail' => null]);
    exit;
}
$j = json_decode($raw, true);
if (!is_array($j)) {
    echo json_encode(['extract' => null, 'thumbnail' => null]);
    exit;
}

$thumb = $j['thumbnail']['source'] ?? null;
if ($thumb) {
    $host = parse_url((string)$thumb, PHP_URL_HOST) ?: '';
    if (!preg_match('/(?:^|\.)(?:wikimedia\.org|wikipedia\.org)$/i', $host)) {
        $thumb = null;
    }
}

echo json_encode([
    'extract'   => $j['extract'] ?? null,
    'thumbnail' => $thumb ? ['source' => $thumb] : null,
    'title'     => $j['title'] ?? null,
]);
