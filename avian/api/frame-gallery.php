<?php
// THE GALLERY EASTER EGG'S INTAKE — sibling of frame-config.php, same
// doctrine: this layer only SPOOLS intent into /run/birdframe; the buttons
// daemon (user belkins, the only writer of anything durable) validates
// again, re-encodes uploads through PIL, and acts. The station is LAN-open
// by the owner's typed choice — no auth here, do not add any.
//
//   GET  ?thumb=<id>  -> stream the daemon-made thumbnail from tmpfs
//   POST multipart    -> field "photo": spool the raw bytes for admission
//   POST JSON         -> {action: show|remove, id, token}: spool the request
//
// ids are daemon-assigned ([A-Za-z0-9._-], never leading dot) — the charset
// check here is politeness; the daemon's is the guard.

declare(strict_types=1);
header('Cache-Control: no-store');

$UPLOAD = '/run/birdframe/gallery-upload.img';
$REQ    = '/run/birdframe/gallery-request.json';
$THUMBS = '/run/birdframe/thumbs';
$MAX_UPLOAD = 12 * 1024 * 1024; // phone photos; PIL re-encodes anyway

$method = $_SERVER['REQUEST_METHOD'] ?? '';

if ($method === 'GET') {
    $id = $_GET['thumb'] ?? '';
    if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/', $id)) {
        http_response_code(400);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'bad id']);
        exit;
    }
    $bytes = @file_get_contents($THUMBS . '/' . $id);
    if ($bytes === false) {
        http_response_code(404);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'no thumb (daemon may still be admitting it)']);
        exit;
    }
    header('Content-Type: image/png');
    echo $bytes;
    exit;
}

if ($method !== 'POST') {
    http_response_code(405);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'GET or POST only']);
    exit;
}

header('Content-Type: application/json');

// --- multipart photo upload -------------------------------------------------
if (isset($_FILES['photo'])) {
    $f = $_FILES['photo'];
    if (($f['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
        http_response_code(400);
        echo json_encode(['error' => 'upload failed (code ' . ($f['error'] ?? -1) . ')']);
        exit;
    }
    if (($f['size'] ?? 0) <= 0 || $f['size'] > $MAX_UPLOAD) {
        http_response_code(400);
        echo json_encode(['error' => 'photo must be under 12MB']);
        exit;
    }
    // Same-dir temp + rename: /run/birdframe is tmpfs, atomic for the daemon.
    $tmp = tempnam(dirname($UPLOAD), 'gal-up.');
    if ($tmp === false || !move_uploaded_file($f['tmp_name'], $tmp)
        || !chmod($tmp, 0644) || !rename($tmp, $UPLOAD)) {
        if ($tmp !== false) { @unlink($tmp); }
        http_response_code(500);
        echo json_encode(['error' => 'spool unavailable — is /run/birdframe installed?']);
        exit;
    }
    echo json_encode(['ok' => true, 'note' => 'admitting — it appears on the shelf within a few seconds']);
    exit;
}

// --- JSON show/remove request ------------------------------------------------
$raw = file_get_contents('php://input');
if ($raw === false || strlen($raw) > 2048) {
    http_response_code(400);
    echo json_encode(['error' => 'body missing or too large']);
    exit;
}
$req = json_decode($raw, true);
if (!is_array($req)
    || !in_array($req['action'] ?? '', ['show', 'remove'], true)
    || !preg_match('/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/', $req['id'] ?? '')
    || ($req['id'] ?? '') === 'current.png'
    || !is_string($req['token'] ?? null) || ($req['token'] ?? '') === '') {
    http_response_code(400);
    echo json_encode(['error' => 'need {action: show|remove, id, token}']);
    exit;
}
$out = ['action' => $req['action'], 'id' => $req['id'], 'token' => $req['token']];
$tmp = tempnam(dirname($REQ), 'gal-req.');
$json = json_encode($out);
if ($tmp === false || file_put_contents($tmp, $json) !== strlen($json)
    || !chmod($tmp, 0644) || !rename($tmp, $REQ)) {
    if ($tmp !== false) { @unlink($tmp); }
    http_response_code(500);
    echo json_encode(['error' => 'spool unavailable — is /run/birdframe installed?']);
    exit;
}
echo json_encode(['ok' => true, 'spooled_at' => microtime(true)]);
