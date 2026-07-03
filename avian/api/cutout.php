<?php
// Belkins BirdNET - bird image resolver.
//
// Lookup chain for /avian/api/cutout.php?sci=Calypte+anna:
//   1. ../assets/illustrations/<slug>.png   (450+ bundled kachō-e renders)
//   2. ../assets/cutouts/<slug>.png         (background-removed photo)
//   3. cached rembg / Railway-proxy result at $HOME/BirdSongs/Extracted/cutouts/
//   4. Railway auto-gen (proxied + cached server-side), else Wikipedia -> rembg
//
// The frontend's <img src> points here for every species - bundled and
// once-cached hits return instantly; cold misses fall through to the dynamic
// path. Every response is a 200 image/png; a genuine asset carries
// X-Av-Real:1, an intentional placeholder carries X-Av-Real:0 (the modal's
// pose toggle reads this so it never lights up a pose that isn't really there).
// A SUBSTITUTE - real pose-1 art standing in for a missing pose - carries
// X-Av-Real:0 plus X-Av-Sub:1, so the frontend can tell "nothing is coming,
// settle for this" from "still generating" and never spins a loader over it.
// Placeholder/silhouette responses never carry X-Av-Sub.
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

// Explicit silhouette request. The collage's onerror fallback (?fb=1) and any
// caller that wants the intentional placeholder hits ?sil=1 to get the ink
// silhouette directly and deterministically - bypassing the whole miss chain
// and never touching Railway. The function defs below are hoisted, so calling
// serve_silhouette() here (before its textual definition) is valid.
if (!empty($_GET['sil']) || !empty($_GET['fb'])) {
    serve_silhouette();
}

// Serve a PNG file. $real marks whether these are genuine species bytes
// (X-Av-Real:1) or an intentional placeholder/substitute (X-Av-Real:0). The
// modal's pose probe reads X-Av-Real to decide which pose toggles are real.
// $sub additionally marks a SUBSTITUTE (real art of another pose standing in,
// X-Av-Sub:1) as distinct from a placeholder - the frontend resolves a
// substitute immediately instead of treating it as "still generating".
//
// Cache contract: an mtime/size ETag + REVALIDATION. Real art used to ship
// max-age=86400 (stale for a DAY after a repaint — the mutilated gull outlived
// its own fix), then max-age=600 (stale for up to 10 MIN — why every feet-fix
// this session looked like "still the same": the browser reused its cached
// plate for 10 min and a normal reload never asked the Pi). Real art now ships
// `no-cache`: the browser revalidates on EVERY load and gets a tiny header-only
// 304 while the file is unchanged, so a REGENERATED plate shows on the very
// next reload — no hard-refresh, no 10-min wait — at near-zero Pi cost.
// Placeholders/substitutes keep a short max-age (they self-clear fast and a
// brief stale silhouette is harmless).
function serve_png(string $path, int $maxAge = 600, bool $real = true, bool $sub = false): void {
    $cc = $real ? 'no-cache' : ('public, max-age=' . $maxAge);
    $st = @stat($path);
    if ($st !== false) {
        $etag = sprintf('"%x-%x"', $st['mtime'], $st['size']);
        header('ETag: ' . $etag);
        $inm = trim((string)($_SERVER['HTTP_IF_NONE_MATCH'] ?? ''));
        // Tolerant compare: handles W/-weak forms and multi-ETag lists.
        if ($inm !== '' && strpos($inm, $etag) !== false) {
            header('X-Av-Real: ' . ($real ? '1' : '0'));
            if ($sub) header('X-Av-Sub: 1');
            header('Cache-Control: ' . $cc);
            http_response_code(304);
            exit;
        }
    }
    header('X-Av-Real: ' . ($real ? '1' : '0'));
    if ($sub) header('X-Av-Sub: 1');
    header('Content-Type: image/png');
    header('Cache-Control: ' . $cc);
    header('Content-Length: ' . (string)filesize($path));
    readfile($path);
    exit;
}

// Terminal fallback - ALWAYS a 200 image/png X-Av-Real:0, never a 4xx/5xx
// (spec §8 tiers 5/6). A long-tail miss, an upstream failure, or the collage's
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
        serve_png($bundled, $maxAge, false);
    }

    // b/c. Cached, or freshly generated, generic silhouette. Kept in its
    //      own dir so it never pollutes the real-cutout cache (tier 3).
    $silDir  = dirname(__DIR__, 3) . '/BirdSongs/Extracted/silhouettes';
    $silPath = "$silDir/_generic.png";
    if (is_file($silPath) && filesize($silPath) > 0) {
        serve_png($silPath, $maxAge, false);
    }
    if (function_exists('imagecreatetruecolor') && make_silhouette($silDir, $silPath)) {
        serve_png($silPath, $maxAge, false);
    }

    // d. Last-ditch: a 1x1 transparent PNG (GD absent, or the render failed).
    //    Still a clean 200 image/png X-Av-Real:0, so no console error is logged
    //    and the pose probe treats it as unavailable. Install php-gd so this
    //    degrades to a real ink silhouette (b/c) rather than an invisible pixel.
    $px = base64_decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII='
    );
    header('X-Av-Real: 0');
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

// 1. Bundled illustration with pose suffix (the kachō-e PNG the repo
//    ships with). 450+ species cover both perched + flight.
$bundled = dirname(__DIR__) . "/assets/illustrations/{$slug}{$poseSuffix}.png";
if (is_file($bundled) && filesize($bundled) > 1024) {
    serve_png($bundled);
}
// Pose-2 missing? Fall back to pose-1 so the flight tab still shows the
// perched render - but mark it X-Av-Real:0 + X-Av-Sub:1 (a substitute, not
// a real flight asset) so the modal's flight toggle correctly stays hidden
// and no loader ever spins over art that isn't being generated.
if ($pose !== 1) {
    $fallback = dirname(__DIR__) . "/assets/illustrations/$slug.png";
    if (is_file($fallback) && filesize($fallback) > 1024) {
        serve_png($fallback, 600, false, true);
    }
}
// 2. Bundled cutout (background-removed photo, fallback for species
//    without an illustration).
$cutout = dirname(__DIR__) . "/assets/cutouts/$slug.png";
if (is_file($cutout) && filesize($cutout) > 1024) {
    serve_png($cutout);
}

// 3. Dynamic cache from a previous Railway-proxy or Wikipedia+rembg run. Keyed
//    POSE-AWARE ($slug{-pose}.png): Railway generates BOTH poses, so a cached
//    flight plate is genuine flight art (X-Av-Real:1). A pose>1 request with no
//    flight art of its own falls back to the pose-1 cache as a SUBSTITUTE
//    (X-Av-Sub:1) — real perched bytes standing in, never a silhouette. This is
//    the hot path once an asset is warmed: every re-render / pose flip / modal
//    open short-circuits here instantly.
$cacheDir  = dirname(__DIR__, 3) . '/BirdSongs/Extracted/cutouts';
$posePath  = "$cacheDir/{$slug}{$poseSuffix}.png";  // the requested pose (real when present)
$base1Path = "$cacheDir/$slug.png";                 // pose-1 (substitute for a poseless flight)
if (is_file($posePath) && filesize($posePath) > 1024) {
    serve_png($posePath, 600, true, false);
}

// 4. Auto-gen watcher (Railway). When AV_RAILWAY_ASSET_BASE is set, PROXY the
//    POSE-SPECIFIC asset server-side (GET, ignore_errors) so PHP sees the true
//    HTTP status: on a genuine 200 we cache the bytes at $posePath and stream
//    them REAL (X-Av-Real:1) - so from the SECOND hit onward every request
//    short-circuits at tier 3. The GET still kicks off Railway's on-demand
//    generation. A miss for pose>1 (no flight art) falls back to the pose-1
//    substitute before the silhouette; a miss for pose-1 records a short
//    negative-cache marker and serves the 200 silhouette, so a poll/modal storm
//    can't hammer Railway or the php-fpm pool. Unset env -> rembg/Wikipedia.
$railwayBase = getenv('AV_RAILWAY_ASSET_BASE');
if ($railwayBase) {
    $railUrl = rtrim($railwayBase, '/') . '/asset/' . $slug . $poseSuffix . '.png';

    // Negative cache: if we confirmed this pose isn't generated yet within the
    // last ~28s (< the frontend's 30s poll, so each poll re-checks exactly
    // once), skip re-proxying Railway on every re-render / modal HEAD probe.
    // Pose-suffixed so a warm perched plate never suppresses a flight probe.
    $missMarker = sys_get_temp_dir() . '/avbn-railmiss-' . $slug . $poseSuffix;
    $mt = @filemtime($missMarker);
    if (!($mt !== false && (time() - $mt) < 28)) {
        $rctx = stream_context_create(['http' => [
            'method'        => 'GET',
            'timeout'       => 6,
            'ignore_errors' => true,   // read the body even on a 404 status line
        ]]);
        $bytes = @file_get_contents($railUrl, false, $rctx);
        $code  = 0;
        if (isset($http_response_header[0]) &&
            preg_match('{\s(\d{3})\b}', $http_response_header[0], $m)) {
            $code = (int)$m[1];
        }
        if ($bytes !== false && $code === 200 && strlen($bytes) > 1024) {
            @unlink($missMarker);                       // resolved - clear negative cache
            if (!is_dir($cacheDir)) @mkdir($cacheDir, 0755, true);
            $tmp = $posePath . '.tmp' . getmypid();
            if (@file_put_contents($tmp, $bytes) !== false && @rename($tmp, $posePath)) {
                serve_png($posePath, 600, true, false);  // cached real art; instant hereafter
            }
            @unlink($tmp);
            // Cache write failed (read-only FS) - still stream the real bytes.
            header('X-Av-Real: 1');
            header('Content-Type: image/png');
            header('Cache-Control: public, max-age=600');
            header('Content-Length: ' . (string)strlen($bytes));
            echo $bytes;
            exit;
        }
        // Not generated yet, or the fetch failed: record the miss so a poll
        // storm can't hammer Railway. The GET above already kicked off gen.
        @touch($missMarker);
    }
    // This pose has no real art (a fresh miss, or negative-cached). For a
    // flight request, stand in the real PERCHED plate as a substitute
    // (X-Av-Sub:1) — real bytes, honestly marked — before any silhouette.
    if ($pose !== 1 && is_file($base1Path) && filesize($base1Path) > 1024) {
        serve_png($base1Path, 600, false, true);
    }
    // Pose-1 miss (or no perched cache to borrow): the calm 200 silhouette.
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
@rename($tmpOut, $posePath);
serve_png($posePath);
