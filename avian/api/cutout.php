<?php
// Belkins BirdNET - bird image resolver.
//
// Lookup chain for /avian/api/cutout.php?sci=Calypte+anna:
//   1. ../assets/illustrations/<slug>.png   (450+ bundled kachō-e renders)
//   2. ../assets/cutouts/<slug>.png         (background-removed photo)
//   3. cached rembg of a Wikipedia photo at $HOME/BirdSongs/Extracted/cutouts/
//   4. fresh Wikipedia -> rembg -> cache (skipped gracefully if rembg unset)
//
// The frontend's <img src> points here for every species - bundled
// hits return instantly; cold misses fall through to the dynamic path.
//
// Default LAN deploy ships without auth. To expose publicly, gate
// /avian/api/* with basic_auth in your Caddyfile - see avian/forwarding/.

declare(strict_types=1);

$sci = trim((string)($_GET['sci'] ?? ''));
if ($sci === '') {
    http_response_code(400);
    echo 'sci required';
    exit;
}
// Binomial / trinomial pattern. Rejects path-traversal payloads and
// junk before any filesystem or upstream lookup.
if (!preg_match('/^[A-Za-z]{2,40}(?:[ ][a-z]{2,40}){1,3}$/', $sci)) {
    http_response_code(400);
    echo 'invalid sci';
    exit;
}

// Slugify scientific name for filename + cache key.
$slug = preg_replace('/[^a-z0-9]+/', '-', strtolower($sci));
$slug = trim((string)$slug, '-');

// pose=1 (default) is perched. pose=2 is flight. Clamp to a two-digit
// positive integer so a malformed ?pose= can't break the path.
$pose = (int)($_GET['pose'] ?? 1);
if ($pose < 1 || $pose > 99) $pose = 1;
$poseSuffix = $pose === 1 ? '' : "-$pose";

function serve_png(string $path, int $maxAge = 86400): void {
    header('Content-Type: image/png');
    header('Cache-Control: public, max-age=' . $maxAge);
    header('Content-Length: ' . (string)filesize($path));
    readfile($path);
    exit;
}

// Terminal fallback - ALWAYS a 200 image/png, never a 4xx/5xx (spec §8
// tiers 5/6). A long-tail miss, an upstream failure, or the collage's
// isDefault aspect-1.4 bbox must still resolve to an intentional ink
// silhouette so the browser logs no failed-resource error and the e-ink
// capture never shows a broken glyph. Resolution order:
//   a. a drop-in ../assets/silhouette.png override (designer-supplied);
//   b. the cached generic silhouette a previous request generated;
//   c. a freshly GD-rendered generic bird silhouette (soft ink #2b2620),
//      cached for reuse; or
//   d. a 1x1 transparent PNG if GD isn't compiled in / generation failed.
// max-age is short so a later-arriving real illustration supersedes it.
function serve_silhouette(): void {
    $maxAge = 300;

    // a. Designer drop-in override.
    $bundled = dirname(__DIR__) . '/assets/silhouette.png';
    if (is_file($bundled) && filesize($bundled) > 0) {
        serve_png($bundled, $maxAge);
    }

    // b/c. Cached, or freshly generated, generic silhouette. Kept in its
    //      own dir so it never pollutes the real-cutout cache (tier 3).
    $silDir  = dirname(__DIR__, 3) . '/BirdSongs/Extracted/silhouettes';
    $silPath = "$silDir/_generic.png";
    if (is_file($silPath) && filesize($silPath) > 0) {
        serve_png($silPath, $maxAge);
    }
    if (function_exists('imagecreatetruecolor') && make_silhouette($silDir, $silPath)) {
        serve_png($silPath, $maxAge);
    }

    // d. Last-ditch: a 1x1 transparent PNG (GD absent, or the render failed).
    //    Still a clean 200 image/png, so no console error is logged.
    $px = base64_decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII='
    );
    header('Content-Type: image/png');
    header('Cache-Control: public, max-age=' . $maxAge);
    header('Content-Length: ' . (string)strlen($px));
    echo $px;
    exit;
}

// Render a generic kachō-e bird silhouette with GD (body + head + beak +
// tail in soft ink ~#2b2620 @ 50%) on a transparent 420x300 canvas (~1.4
// aspect, matching the collage's isDefault bbox) and cache it to $path.
// Alpha-blending is disabled so overlapping primitives keep one flat 50%
// ink instead of compounding into a dark patch. Drawing runs inside an
// output buffer so an incidental GD deprecation notice can never corrupt
// the PNG stream - the encoded bytes go to $path, not stdout. Returns true
// only when a non-empty file lands.
function make_silhouette(string $dir, string $path): bool {
    if (!is_dir($dir)) @mkdir($dir, 0755, true);
    $w = 420; $h = 300;
    $im = @imagecreatetruecolor($w, $h);
    if ($im === false) return false;
    ob_start();
    imagealphablending($im, false);
    imagesavealpha($im, true);
    $clear = imagecolorallocatealpha($im, 0, 0, 0, 127);
    imagefilledrectangle($im, 0, 0, $w - 1, $h - 1, $clear);
    // Soft ink at ~50% (GD alpha 63 of 127).
    $ink = imagecolorallocatealpha($im, 0x2b, 0x26, 0x20, 63);
    imagefilledellipse($im, 178, 180, 230, 130, $ink);                   // body
    imagefilledellipse($im, 288, 122,  96,  96, $ink);                   // head
    @imagefilledpolygon($im, [332, 112, 394, 130, 332, 142], 3, $ink);   // beak
    @imagefilledpolygon($im, [80, 170, 20, 250, 116, 206], 3, $ink);     // tail
    $ok = imagepng($im, $path, 6);
    imagedestroy($im);
    ob_end_clean();
    return $ok && is_file($path) && filesize($path) > 0;
}

// First-touch detector for the Railway generator. Returns true the first
// time a slug is seen inside a short window (recording a marker so the 302
// fires once to kick off generation), and false on repeat hits within that
// window - the caller then serves the 200 silhouette instead of redirecting
// again to a still-pending, and thus 404-ing, Railway asset. Once the marker
// lapses the asset is almost certainly on Railway's volume and the next
// request 302s straight to the finished illustration. If the marker can't be
// persisted we treat every miss as pending (preserves the original
// always-redirect behavior).
function railway_pending(string $slug): bool {
    // Must stay < the frontend's 30s RETRY_INTERVAL so a retry sweep landing
    // inside a still-pending window re-fires the 302 to Railway, instead of
    // hitting a "fresh" marker and being served the 200 silhouette forever
    // (which would permanently defeat live-paint of a new species).
    $ttl = 20;
    $marker = sys_get_temp_dir() . '/avbn-railway-' . $slug . '.pending';
    $mtime = @filemtime($marker);
    if ($mtime !== false && (time() - $mtime) < $ttl) {
        return false; // generation already kicked off; still pending
    }
    @touch($marker);
    return true;      // first touch (or unpersisted marker): redirect to generate
}

// 1. Bundled illustration with pose suffix (the kachō-e PNG the repo
//    ships with). 450+ species cover both perched + flight.
$bundled = dirname(__DIR__) . "/assets/illustrations/{$slug}{$poseSuffix}.png";
if (is_file($bundled) && filesize($bundled) > 1024) {
    serve_png($bundled);
}
// Pose-2 missing? Fall back to pose-1 so the flight tab still shows
// the perched render instead of breaking to the photo fallback.
if ($pose !== 1) {
    $fallback = dirname(__DIR__) . "/assets/illustrations/$slug.png";
    if (is_file($fallback) && filesize($fallback) > 1024) {
        serve_png($fallback);
    }
}
// 2. Bundled cutout (background-removed photo, fallback for species
//    without an illustration).
$cutout = dirname(__DIR__) . "/assets/cutouts/$slug.png";
if (is_file($cutout) && filesize($cutout) > 1024) {
    serve_png($cutout);
}

// 3. Dynamic cache from a previous Wikipedia + rembg run.
$cacheDir = dirname(__DIR__, 3) . '/BirdSongs/Extracted/cutouts';
$cachePath = "$cacheDir/$slug.png";
if (is_file($cachePath) && filesize($cachePath) > 1024) {
    serve_png($cachePath);
}

// 4. Auto-gen watcher (Railway). When AV_RAILWAY_ASSET_BASE is set, redirect
//    long-tail misses to the Railway service, which generates the kachō-e
//    illustration on demand and serves it from its volume. This MUST be the
//    FIRST miss-handler (after all bundled/cached lookups, before the
//    rembg/Wikipedia branch) so the long tail prefers the generated kachō-e
//    over a background-removed photo. Pose-1 only (the live collage hardcodes
//    pose=1; generating pose-2 is wasted spend). $slug is already slug-sanitized
//    above, so no path-traversal reaches the redirect target.
//    Unset env -> fall through to the existing behavior (graceful degrade,
//    fully backward-compatible).
//    The 302 fires ONLY while generation is genuinely pending (the first
//    miss for a slug, per railway_pending()); repeat hits inside that window
//    fall through to the 200 silhouette default so a still-generating asset's
//    404 can't storm the browser console.
$railwayBase = getenv('AV_RAILWAY_ASSET_BASE');
if ($railwayBase && railway_pending($slug)) {
    header('Location: ' . rtrim($railwayBase, '/') . '/asset/' . $slug . '.png', true, 302);
    exit;
}
// When Railway is configured it is the SOLE long-tail handler. On a repeat miss
// inside the pending window, serve the 200 silhouette rather than falling through
// to the rembg/Wikipedia branch below - a cached photo cutout there would
// permanently shadow the Railway kachō-e once it finishes generating.
// serve_silhouette() always exits.
if ($railwayBase) {
    serve_silhouette();
}

// 5. Fresh Wikipedia fetch + rembg. Skipped if rembg-cli isn't on
//    PATH - the resolver serves the silhouette (200) in that case rather
//    than burning a Wikipedia request we can't use.
$rembg = '/usr/local/bin/rembg-cli';
if (!is_executable($rembg)) {
    // No dynamic fallback available (rembg-cli not installed). Serve the
    // silhouette at 200 rather than a 404 the browser would log; install
    // rembg-cli to enable the Wikipedia fallback for long-tail species.
    serve_silhouette();
}

if (!is_dir($cacheDir)) @mkdir($cacheDir, 0755, true);

// Wikipedia's REST API asks for a contact-able identifier. Override
// via the AV_USER_AGENT env var (set in /etc/php/*/fpm/pool.d/www.conf
// or your shell) if your install hammers their endpoint at scale.
$ua = getenv('AV_USER_AGENT') ?: 'Belkins-BirdNET/1.0 (+https://github.com/Belkins/belkins-birdnet)';
$ctx = stream_context_create([
    'http' => ['header' => "User-Agent: $ua\r\n", 'timeout' => 12],
]);
$wpUrl = 'https://en.wikipedia.org/api/rest_v1/page/summary/' . rawurlencode($sci);
$wpJson = @file_get_contents($wpUrl, false, $ctx);
$srcUrl = null;
if ($wpJson !== false) {
    $j = json_decode($wpJson, true);
    $srcUrl = $j['originalimage']['source'] ?? $j['thumbnail']['source'] ?? null;
}
// Defensive: only follow URLs on Wikimedia / Wikipedia hosts so a
// poisoned summary endpoint can't redirect us to arbitrary servers.
if ($srcUrl !== null) {
    $host = parse_url((string)$srcUrl, PHP_URL_HOST) ?: '';
    if (!preg_match('/(?:^|\.)(?:wikimedia\.org|wikipedia\.org)$/i', $host)) {
        $srcUrl = null;
    }
}
if (!$srcUrl) {
    // No usable Wikipedia image for this species - silhouette (200), not 404.
    serve_silhouette();
}

$imgBytes = @file_get_contents($srcUrl, false, $ctx);
if (!$imgBytes || strlen($imgBytes) < 1024) {
    // Upstream fetch failed - silhouette (200), not a 503.
    serve_silhouette();
}

// rembg via the wrapper. u2netp = lightweight model (~50MB peak RAM -
// matters on the Pi 3B+). Temp files because rembg's CLI prefers
// real paths.
$tmpInBase  = tempnam(sys_get_temp_dir(), 'rembg-in-');
$tmpOutBase = tempnam(sys_get_temp_dir(), 'rembg-out-');
@unlink($tmpInBase); @unlink($tmpOutBase);
$tmpIn  = $tmpInBase  . '.jpg';
$tmpOut = $tmpOutBase . '.png';
file_put_contents($tmpIn, $imgBytes);

$cmd = sprintf(
    '%s i -m u2netp -ppm %s %s 2>&1',
    escapeshellarg($rembg),
    escapeshellarg($tmpIn),
    escapeshellarg($tmpOut)
);
$out = shell_exec($cmd);
@unlink($tmpIn);

if (!is_file($tmpOut) || filesize($tmpOut) < 1024) {
    @unlink($tmpOut);
    error_log("rembg failed for $sci: " . ($out ?? '(no output)'));
    // Generation failed - still answer 200 with the silhouette so the
    // browser logs no failed resource (details are in the Pi's logs above).
    serve_silhouette();
}

// Tight-crop to the bird's bounding box + downscale to 800px max edge
// so cache stays small.
$im = @imagecreatefrompng($tmpOut);
if ($im !== false) {
    $cropped = @imagecropauto($im, IMG_CROP_TRANSPARENT);
    if ($cropped !== false) {
        imagedestroy($im);
        $im = $cropped;
    }
    $w = imagesx($im); $h = imagesy($im);
    $max = 800;
    if ($w > $max || $h > $max) {
        $scale = $max / max($w, $h);
        $nw = (int)($w * $scale); $nh = (int)($h * $scale);
        $resized = imagecreatetruecolor($nw, $nh);
        imagealphablending($resized, false);
        imagesavealpha($resized, true);
        imagecopyresampled($resized, $im, 0, 0, 0, 0, $nw, $nh, $w, $h);
        imagedestroy($im);
        $im = $resized;
    }
    imagealphablending($im, false);
    imagesavealpha($im, true);
    imagepng($im, $tmpOut, 6);
    imagedestroy($im);
}

// Atomic install: rename is atomic on the same filesystem, so any
// concurrent reader either sees the old cached file or the new one,
// never a half-written PNG.
@rename($tmpOut, $cachePath);
serve_png($cachePath);
