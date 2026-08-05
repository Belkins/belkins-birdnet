<?php
// Belkins BirdNET - The Wall panel intake. Thin spool layer between the
// panel UI and the resident frame daemon (frame/buttons.py, user belkins).
//
//   UI --POST--> here --writes--> /run/birdframe/panel-request.json   --> daemon
//   daemon --publishes--> /run/birdframe/panel-state.json --> GET here --> UI
//
// Endpoints (by verb):
//   GET  - the daemon's published state, emitted verbatim; if none has
//          been published (or it doesn't parse), a 200
//          {"error":"no state published yet"} the UI renders as its
//          waiting state - NEVER a 4xx/5xx for "not yet".
//   POST - validate a knob request (key whitelist, types, ranges, pair
//          rule) and spool it atomically for the daemon to consume on
//          its next tick (<=30s).
//
// All knob keys are OPTIONAL - absent means "keep current" - so this
// layer spools only the keys it was sent, plus the required client token.
// The daemon re-validates everything; this layer is politeness, not
// security. The station is LAN-open by the owner's typed choice - no
// auth here, no sessions, do not add any.

declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$SPOOL = '/run/birdframe/panel-request.json';        // written here, consumed by the daemon
$STATE = '/run/birdframe/panel-state.json';  // published by the daemon, served here

$method = $_SERVER['REQUEST_METHOD'] ?? '';

if ($method === 'GET') {
    // ?shot=1 — the wall's OWN last screenshot, mirrored by the daemon into
    // the spool dir. The preview's dice and the wall's dice roll separately;
    // this image is the only ground truth for "what is on the ink".
    if (($_GET['shot'] ?? '') === '1') {
        $shot = '/run/birdframe/last-shot.png';
        $bytes = @file_get_contents($shot);
        if ($bytes === false) {
            http_response_code(404);
            echo json_encode(['error' => 'no shot mirrored yet — has the wall painted since the daemon restarted?']);
            exit;
        }
        header('Content-Type: image/png');
        echo $bytes;
        exit;
    }
    $raw = @file_get_contents($STATE);
    if ($raw !== false) {
        json_decode($raw);
        if (json_last_error() === JSON_ERROR_NONE) {
            // Verbatim - the daemon's exact bytes, never a re-encoding
            // (re-encoding could reorder keys or reformat floats and the
            // published_at value must survive untouched).
            echo $raw;
            exit;
        }
    }
    // Missing (daemon not yet run) or mid-write/corrupt both land here.
    echo json_encode(['error' => 'no state published yet']);
    exit;
}

if ($method !== 'POST') {
    header('Allow: GET, POST');
    http_response_code(405);
    echo json_encode(['error' => 'method not allowed']);
    exit;
}

function bad(string $msg): void
{
    http_response_code(400);
    echo json_encode(['error' => $msg]);
    exit;
}

$ctype = $_SERVER['CONTENT_TYPE'] ?? ($_SERVER['HTTP_CONTENT_TYPE'] ?? '');
if (stripos($ctype, 'application/json') !== 0) {
    bad('Content-Type must be application/json');
}

$raw = file_get_contents('php://input');
if ($raw === false || $raw === '') bad('empty body');
if (strlen($raw) > 2048) bad('body exceeds 2048 bytes');

$req = json_decode($raw, true);
if (json_last_error() !== JSON_ERROR_NONE || !is_array($req)) {
    bad('body must be a JSON object');
}

// Key whitelist: anything outside the contract is a 400, not a shrug -
// a typo'd knob name must never read back as "applied". (JSON keys that
// look numeric decode to int array keys, hence the (string) cast.)
$KNOWN = ['zoom', 'budget', 'mintile', 'herocap', 'overlap', 'theme', 'view', 'token'];
foreach (array_keys($req) as $k) {
    if (!in_array($k, $KNOWN, true)) bad('unknown key: ' . (string)$k);
}

// Float knobs: is_numeric FIRST (a bool/array/null must 400, never be
// cast - (float)true is 1.0, the same inversion trap min_conf= documents
// in birdnet-api.php), then the contract range. lo_open marks an
// exclusive lower bound.
$FLOATS = [
    'zoom'    => ['lo' => 1.0, 'hi' => 2.2,  'lo_open' => false, 'range' => '[1.0, 2.2]'],
    'budget'  => ['lo' => 0.0, 'hi' => 1.0,  'lo_open' => true,  'range' => '(0, 1.0]'],
    'mintile' => ['lo' => 0.0, 'hi' => 0.03, 'lo_open' => true,  'range' => '(0, 0.03]'],
    'herocap' => ['lo' => 0.0, 'hi' => 0.4,  'lo_open' => true,  'range' => '(0, 0.4]'],
    'overlap' => ['lo' => 0.0, 'hi' => 0.5,  'lo_open' => false, 'range' => '[0, 0.5]'],
];

$out = [];
foreach ($FLOATS as $key => $r) {
    if (!array_key_exists($key, $req)) continue;   // absent = keep current
    $v = $req[$key];
    if (!is_numeric($v)) bad($key . ' must be a number in ' . $r['range']);
    $f = (float)$v;
    $loOk = $r['lo_open'] ? ($f > $r['lo']) : ($f >= $r['lo']);
    if (!$loOk || $f > $r['hi']) bad($key . ' out of range ' . $r['range']);
    $out[$key] = $f;
}

if (array_key_exists('theme', $req)) {
    if (!in_array($req['theme'], ['day', 'night'], true)) {
        bad('theme must be "day" or "night"');
    }
    $out['theme'] = $req['theme'];
}

if (array_key_exists('view', $req)) {
    if (!in_array($req['view'], ['realtime', 'today', 'week', 'all'], true)) {
        bad('view must be one of realtime|today|week|all');
    }
    $out['view'] = $req['view'];
}

if (!array_key_exists('token', $req) || !is_string($req['token']) || $req['token'] === '') {
    bad('token (non-empty string) required');
}
$out['token'] = $req['token'];

// Pair rule, as far as this layer can see it: when the request itself
// carries BOTH knobs, mintile < herocap must already hold - no "current"
// value can rescue it, so it 400s here. The present-or-current half (one
// knob in the request, the other from live state) belongs to the daemon:
// it owns "current" and deletes invalid requests without applying them.
if (isset($out['mintile'], $out['herocap']) && !($out['mintile'] < $out['herocap'])) {
    bad('mintile must be < herocap');
}

// Atomic spool: tmp file + rename IN THE SAME DIRECTORY — /run/birdframe is
// tmpfs, so a /tmp-born temp file could not rename across filesystems. The
// directory is created by tmpfiles.d (0775 belkins:caddy): fpm's user (caddy,
// group write) may create files here, and the daemon (belkins, dir owner) may
// unlink them — the exact pair a sticky /tmp forbids. tempnam creates 0600
// and PHP-FPM does not run as belkins, so the chmod to 0644 is load-bearing.
$tmp = tempnam(dirname($SPOOL), 'panel-req.');
if ($tmp === false) {
    http_response_code(500);
    echo json_encode(['error' => 'spool dir unavailable — is /run/birdframe installed? (tmpfiles.d, frame/install.sh)']);
    exit;
}
$json = json_encode($out);
if (file_put_contents($tmp, $json) !== strlen($json)
    || !chmod($tmp, 0644)
    || !rename($tmp, $SPOOL)) {
    @unlink($tmp);
    http_response_code(500);
    echo json_encode(['error' => 'spool write failed']);
    exit;
}

echo json_encode(['ok' => true, 'spooled_at' => microtime(true)]);
