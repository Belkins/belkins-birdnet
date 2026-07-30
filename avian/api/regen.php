<?php
// Belkins BirdNET - repaint proxy (the Pi side of the repaint button).
//
// The popup's `repaint` gesture lands here. This script is the sole
// custodian of the Railway Bearer secret on the request path: it lives in
// the php-fpm pool env (same mechanism as cutout.php's
// AV_RAILWAY_ASSET_BASE) and is attached server-side to the outbound
// calls - it never reaches a browser, a response body, or a log line.
//
//   POST  sci=Turdus+merula&pose=1|2
//         -> guards (per-species + global cooldowns, LAN-only check,
//            queue depth, budget pause), then proxy
//            POST <railway>/requeue {"slugs":[slug],"poses":[pose],
//                                    "keep_current":true,"source":"manual"}
//         -> 202 {"state":"queued"}
//   GET   ?status=1&sci=Turdus+merula&pose=1|2
//         -> proxies GET <railway>/job/<slug> and maps it to the popup's
//            calm vocabulary. "done" is reported exactly ONCE per press -
//            only when the requested pose's asset mtime has advanced past
//            the press-time snapshot - and carries the tier-3 cache flush
//            side effect (the same php-fpm user wrote those files, so it
//            may delete them). Without a marker the probe is a cheap
//            no-op ("idle") that never touches Railway.
//
// Every response is application/json with a "state" field:
//   queued | generating | done | parked | paused | busy | cooldown |
//   idle | unavailable | forbidden | bad_request
// Upstream error bodies are never echoed - no error theater at the wall.
//
// DARK UNTIL ARMED: without BOTH pool env vars below, every request
// answers 503 {"state":"unavailable"} and the frontend never renders the
// button. Arm in /etc/php/*/fpm/pool.d/www.conf, then reload php-fpm:
//   env[AV_RAILWAY_API_BASE] = https://<birdgen>.up.railway.app
//   env[AV_REGEN_SECRET]     = <WATCHER_WEBHOOK_SECRET>
//   env[AV_REGEN_COOLDOWN]   = 900         ; optional, per-species seconds

declare(strict_types=1);

header('Content-Type: application/json');

function json_exit(int $code, array $body): void {
    http_response_code($code);
    echo json_encode($body);
    exit;
}

// LAN-object contract: the button is a physical-presence gesture. Only
// RFC1918 / loopback callers qualify; anything else (including a
// cloudflared tunnel, whose requests arrive as loopback but carry CF
// headers) is refused. String-prefix checks, not ip2long - safe on
// 32-bit PHP builds.
function is_lan_addr(string $ip): bool {
    if ($ip === '::1') return true;                               // v6 loopback
    if (stripos($ip, '::ffff:') === 0) $ip = substr($ip, 7);      // v4-mapped v6
    if (preg_match('/^(?:127|10)\./', $ip)) return true;          // loopback, 10/8
    if (preg_match('/^192\.168\./', $ip)) return true;            // 192.168/16
    if (preg_match('/^172\.(?:1[6-9]|2\d|3[01])\./', $ip)) return true; // 172.16/12

    // ── IPv6 ────────────────────────────────────────────────────────────────
    // Everything above is IPv4-only, so before this the button was DEAD for any
    // visitor arriving over IPv6 -- which is the default on macOS and iOS on a
    // dual-stack LAN. The operator's one interactive control simply never
    // rendered, with no error and no log line.
    //
    // The private-range trick does not rescue it here: this LAN's addresses are
    // globally-routable (2a01:...), handed out by the router's prefix
    // delegation, so there is no fc00::/7 to match. ULA and link-local are
    // accepted below because other deployments do use them, but the test that
    // actually works on THIS network is prefix identity: a caller sharing the
    // server's own /64 is on the same link, which is the same physical-presence
    // claim RFC1918 makes for v4.
    //
    // Still fail-closed: anything unparseable, any address family mismatch, and
    // any case where the server's own address is unknown returns false.
    if (preg_match('/^f[cd][0-9a-f]{2}:/i', $ip)) return true;    // fc00::/7  ULA
    if (preg_match('/^fe[89ab][0-9a-f]:/i', $ip)) return true;    // fe80::/10 link-local

    $client = @inet_pton($ip);
    $server = @inet_pton($_SERVER['SERVER_ADDR'] ?? '');
    if ($client === false || $server === false) return false;     // unparseable
    if (strlen($client) !== 16 || strlen($server) !== 16) return false; // not both v6
    return substr($client, 0, 8) === substr($server, 0, 8);       // same /64
}

// One Railway round-trip. Returns [statusCode, decodedJson|null];
// code 0 means the transport itself failed. ignore_errors so PHP reads
// the true status line instead of warning on 4xx (cutout.php idiom).
// The response body is only ever json_decode'd, never echoed.
function railway_call(string $url, string $secret, ?string $postJson = null, int $timeout = 6): array {
    $hdr = "Authorization: Bearer $secret\r\n";
    $http = [
        'method'        => $postJson === null ? 'GET' : 'POST',
        'timeout'       => $timeout,
        'ignore_errors' => true,
    ];
    if ($postJson !== null) {
        $hdr .= "Content-Type: application/json\r\n";
        $http['content'] = $postJson;
    }
    $http['header'] = $hdr;
    $ctx  = stream_context_create(['http' => $http]);
    $body = @file_get_contents($url, false, $ctx);
    $code = 0;
    if (isset($http_response_header[0]) &&
        preg_match('{\s(\d{3})\b}', $http_response_header[0], $m)) {
        $code = (int)$m[1];
    }
    if ($body === false) return [0, null];
    $j = json_decode($body, true);
    return [$code, is_array($j) ? $j : null];
}

// Marker = {ts, pose, mtime0, done?}: cooldown stamp, cross-device in-flight
// state, the press-time asset-mtime snapshot that "done" is measured against,
// and a `done` latch. The marker is NOT deleted when the repaint completes —
// it survives (with done:true) for its full cooldown + rate-window life so the
// per-species cooldown and the global caps can't be defeated by a completed
// press erasing its own tally. It lives beside the tier-3 cache
// (php-fpm-writable, survives reboots unlike /tmp); the 24h sweep retires it.
// A corrupt marker degrades to its file mtime so the cooldown math still holds.
function read_marker(string $path): ?array {
    $raw = @file_get_contents($path);
    if ($raw === false) return null;
    $j = json_decode($raw, true);
    if (!is_array($j)) {
        return ['ts' => (int)(@filemtime($path) ?: 0), 'pose' => null, 'mtime0' => 0];
    }
    return $j;
}

// Re-stamp a marker as done WITHOUT resetting ts (so it keeps counting toward
// the cooldown + rate windows for its natural life). Best-effort.
function mark_marker_done(string $path, array $mk): void {
    $mk['done'] = true;
    @file_put_contents($path, json_encode($mk));
}

// ── Arming gate: dark until both pool vars exist (the real launch flag).
$base   = getenv('AV_RAILWAY_API_BASE');
$secret = getenv('AV_REGEN_SECRET');
if (!$base || !$secret) json_exit(503, ['state' => 'unavailable']);
$base = rtrim((string)$base, '/');

// ── Place guard, before anything is parsed: REMOTE_ADDR must be
// RFC1918/loopback AND no Cloudflare tunnel signature may be present.
$remote = (string)($_SERVER['REMOTE_ADDR'] ?? '');
if (!is_lan_addr($remote) ||
    isset($_SERVER['HTTP_CF_CONNECTING_IP']) || isset($_SERVER['HTTP_CF_RAY'])) {
    json_exit(403, ['state' => 'forbidden']);
}

// ── Input. sci/pose arrive as query or form fields; a JSON POST body is
// accepted as a fallback so the frontend is free to pick either encoding.
$sci     = trim((string)($_REQUEST['sci'] ?? ''));
$poseRaw = $_REQUEST['pose'] ?? null;
if ($sci === '' && ($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    $jbody = json_decode((string)@file_get_contents('php://input'), true);
    if (is_array($jbody)) {
        $sci     = trim((string)($jbody['sci'] ?? ''));
        $poseRaw = $jbody['pose'] ?? $poseRaw;
    }
}
// Binomial / trinomial pattern - cutout.php's regex, verbatim, so the
// slug forwarded to Railway is byte-identical to the one cutout.php will
// later look up. Rejects traversal payloads before any filesystem access.
if (!preg_match('/^[A-Za-z]{2,40}(?:[ ][a-z]{2,40}){1,3}$/', $sci)) {
    json_exit(400, ['state' => 'bad_request']);
}
// Slugify - cutout.php, verbatim.
$slug = preg_replace('/[^a-z0-9]+/', '-', strtolower($sci));
$slug = trim((string)$slug, '-');
// pose: 2 is flight, anything else is perched.
$pose = ((int)($poseRaw ?? 1)) === 2 ? 2 : 1;

$cacheDir = dirname(__DIR__, 3) . '/BirdSongs/Extracted/cutouts';
$marker   = "$cacheDir/.regen-$slug.json";
$now      = time();

// ─────────────────────────────────────────────────────────────────────
// GET ?status=1 - poll target for the popup's painting state.
// ─────────────────────────────────────────────────────────────────────
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET' && ($_GET['status'] ?? '') !== '') {
    $mk = read_marker($marker);
    if ($mk === null) json_exit(200, ['state' => 'idle']);   // no press in flight

    $ts = (int)($mk['ts'] ?? 0);
    if ($ts <= 0) $ts = (int)(@filemtime($marker) ?: 0);
    if ($now - $ts >= 86400) {                 // orphaned press: ignore + clean
        @unlink($marker);
        json_exit(200, ['state' => 'idle']);
    }
    // Already resolved (swap reported once, or a terminal no-change): nothing is
    // in flight, so the popup rests. The marker itself LINGERS (done:true) to
    // keep enforcing the cooldown + rate windows — we just don't call Railway.
    if (!empty($mk['done'])) json_exit(200, ['state' => 'idle']);

    [$code, $job] = railway_call("$base/job/" . rawurlencode($slug), $secret);
    if ($code !== 200 || $job === null) json_exit(503, ['state' => 'unavailable']);

    $jstate = (string)($job['state'] ?? 'unknown');
    $mkPose = (int)($mk['pose'] ?? $pose);
    if ($mkPose !== 2) $mkPose = 1;
    $mtime0 = (float)($mk['mtime0'] ?? 0);
    $mtNow  = (float)(($mkPose === 2 ? ($job['asset2_mtime'] ?? 0) : ($job['asset_mtime'] ?? 0)) ?? 0);

    if ($jstate === 'done') {
        if ($mtNow > $mtime0) {
            // The new plate landed on Railway. Flush the Pi's stale copies so
            // the next cutout.php hit re-proxies fresh art, clear the negative-
            // cache markers, and latch the press marker done — which makes
            // "done" observable exactly once while the marker lingers to hold
            // the cooldown.
            @unlink("$cacheDir/$slug.png");
            @unlink("$cacheDir/$slug-2.png");
            foreach ((glob(sys_get_temp_dir() . '/avbn-railmiss-' . $slug . '*') ?: []) as $f) {
                @unlink($f);
            }
            mark_marker_done($marker, $mk);
            json_exit(200, ['state' => 'done']);
        }
        // Terminal 'done' but this pose's asset never advanced: the regen
        // finished and this plate DID NOT change — a best-effort flight roll
        // that missed, or a kept pose. Nothing is generating, so report the
        // calm parked line ONCE (never a spinner over a finished job) and
        // latch the marker so a reopen rests instead of re-arming the loader.
        mark_marker_done($marker, $mk);
        json_exit(200, ['state' => 'parked']);
    }
    if ($jstate === 'generating') json_exit(200, ['state' => 'generating']);
    if ($jstate === 'queued') {
        if (!empty($job['manual_paused']) || !empty($job['budget_exhausted'])) {
            json_exit(200, ['state' => 'paused']);
        }
        $nextRetry = (float)($job['next_retry'] ?? 0);
        if ($nextRetry > $now) {
            // Hint-parked on Railway: the painter will return on its own.
            json_exit(200, ['state' => 'parked', 'retry_after_s' => (int)ceil($nextRetry - $now)]);
        }
        json_exit(200, ['state' => 'queued']);
    }
    // dead | unknown | anything unexpected -> the calm terminal line.
    json_exit(200, ['state' => 'parked']);
}

// ─────────────────────────────────────────────────────────────────────
// POST - a press. Every guard runs before the requeue reaches Railway.
// ─────────────────────────────────────────────────────────────────────
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    json_exit(405, ['state' => 'bad_request']);
}

$cooldown = (int)(getenv('AV_REGEN_COOLDOWN') ?: 900);

// GUARD 1 - per-species cooldown. A marker younger than the cooldown means
// this plate was just requested (in flight OR done): dueling browsers converge
// to watching the one regen instead of stacking rolls. Once the cooldown has
// lifted, the lingering marker is cleared so GUARD 5 can claim a fresh press.
$mk = read_marker($marker);
if ($mk !== null) {
    $ts = (int)($mk['ts'] ?? 0);
    if ($ts <= 0) $ts = (int)(@filemtime($marker) ?: 0);
    $age = $now - $ts;
    if ($age < $cooldown) {
        json_exit(429, ['state' => 'cooldown', 'retry_after_s' => max(1, $cooldown - $age)]);
    }
    @unlink($marker);   // cooldown lifted (or stale): make way for a fresh claim
}

// GUARD 2 - global caps via marker mtimes: at most 3 presses per rolling
// 10 minutes and 8 per rolling day, across ALL species. Bounds a
// mash-every-plate spree to pocket change; markers past 24h are swept
// here so the counting window is self-cleaning.
$in600 = 0; $in86400 = 0; $old600 = null; $old86400 = null;
foreach ((glob("$cacheDir/.regen-*.json") ?: []) as $f) {
    $mt = @filemtime($f);
    if ($mt === false) continue;
    $age = $now - $mt;
    if ($age >= 86400) { @unlink($f); continue; }
    $in86400++;
    if ($old86400 === null || $mt < $old86400) $old86400 = $mt;
    if ($age < 600) {
        $in600++;
        if ($old600 === null || $mt < $old600) $old600 = $mt;
    }
}
if ($in600 >= 3) {
    json_exit(429, ['state' => 'cooldown', 'retry_after_s' => max(1, $old600 + 600 - $now)]);
}
if ($in86400 >= 8) {
    json_exit(429, ['state' => 'cooldown', 'retry_after_s' => max(1, $old86400 + 86400 - $now)]);
}

// GUARD 5 - atomic same-species claim, BEFORE the Railway round-trip closes a
// TOCTOU window: two devices past GUARD 1 (no marker yet) would otherwise both
// proxy a requeue during the ~6-8s call. Exclusive-create ('x') lets exactly
// one win; the loser reads it as an in-flight cooldown. The provisional marker
// is finalized (real mtime0) on success and unlinked on any failure below, so
// a refused/failed press never leaves a phantom cooldown.
if (!is_dir($cacheDir)) @mkdir($cacheDir, 0755, true);
$fh = @fopen($marker, 'x');
if ($fh === false) {
    json_exit(429, ['state' => 'cooldown', 'retry_after_s' => 1]);  // just claimed by another press
}
fwrite($fh, json_encode(['ts' => $now, 'pose' => $pose, 'mtime0' => 0]));
fclose($fh);

// GUARDS 3+4 - one /job probe covers the queue-depth gate, the pause
// flags, and the press-time mtime snapshot that "done" is later measured
// against. Railway unreachable => nothing is queued, nothing is deleted.
[$code, $job] = railway_call("$base/job/" . rawurlencode($slug), $secret);
if ($code !== 200 || $job === null) { @unlink($marker); json_exit(503, ['state' => 'unavailable']); }
if ((int)($job['queue_depth'] ?? 0) >= 3) { @unlink($marker); json_exit(503, ['state' => 'busy']); }
if (!empty($job['manual_paused']) || !empty($job['budget_exhausted'])) {
    @unlink($marker);
    json_exit(200, ['state' => 'paused']);
}
$mtime0 = (float)(($pose === 2 ? ($job['asset2_mtime'] ?? 0) : ($job['asset_mtime'] ?? 0)) ?? 0);

// The requeue itself: keep_current so the old plate survives until its
// replacement passes QA (the wall never gets worse), source=manual so
// the spend lands in the manual ledger bucket.
$payload = json_encode([
    'slugs'        => [$slug],
    'poses'        => [$pose],
    'keep_current' => true,
    'source'       => 'manual',
]);
[$code, $resp] = railway_call("$base/requeue", $secret, (string)$payload, 8);
if ($code < 200 || $code > 299 || $resp === null) {
    @unlink($marker);
    error_log("regen.php: requeue failed code=$code slug=$slug");
    json_exit(503, ['state' => 'unavailable']);
}
$requeued = $resp['requeued'] ?? [];
if (!is_array($requeued) || !in_array($slug, $requeued, true)) {
    // Partial-acceptance contract: Railway may refuse per slug. A spent
    // manual budget reads as paused; anything else (e.g. a bundled
    // species) degrades to silence. Either way the provisional marker goes.
    @unlink($marker);
    $reason = (string)($resp['refused'][$slug] ?? '');
    if ($reason === 'manual_budget') json_exit(200, ['state' => 'paused']);
    json_exit(503, ['state' => 'unavailable']);
}

// Accepted: finalize the marker with the real press-time snapshot. Its file
// mtime doubles as this press's entry in the global counting windows above.
@file_put_contents($marker, json_encode(['ts' => $now, 'pose' => $pose, 'mtime0' => $mtime0]));
json_exit(202, ['state' => 'queued']);
