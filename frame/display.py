#!/usr/bin/env python3
"""Frame client: turn a collage screenshot into Inky panel pixels.

Runs on the box the panel is attached to (a dedicated frame Pi, or the
station Pi itself) on a systemd timer. Each run it decides whether a
refresh is worth it (the species set or call-count brackets changed, and it
is not quiet hours), then crops the title and collage from the screenshot,
centres and mats them, and pushes the result to the Inky Impression 13.3".
``--preview out.png`` writes an approximate 6-ink dither instead, so the
look can be checked on any machine without the panel.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import inspect
import io
import json
import os
import re
import statistics
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

from PIL import Image, ImageChops, ImageDraw

try:
    import tomllib
except ModuleNotFoundError:  # Python < 3.11
    import tomli as tomllib

PANEL_W, PANEL_H = 1200, 1600  # portrait; the panel itself is 1600x1200

# Approximate Spectra-6 inks, used only for --preview. On hardware the Inky
# library maps to the panel's real palette.
SPECTRA6 = [(236, 234, 223), (26, 26, 28), (165, 60, 56),
            (198, 176, 74), (49, 71, 130), (58, 110, 72)]

DEFAULTS = {
    "base_url": "http://birdnet.local",
    # Page the shooter screenshots, relative to base_url. NOT "/" — the site root
    # now 302s to /collage/ (the React museum), and shoot.py drives the LEGACY
    # apt.js page: it waits for .gtile and rewrites that page's own tunables, so
    # against the SPA it would just time out. base_url itself must stay the bare
    # host because fetch_recent() appends /avian/api/... to it.
    "shoot_path": "/index.html",
    # The React museum instead of the legacy page: shoot_spa=true drives
    # shoot_spa() at shoot_spa_path (+&win=<hours>). The SPA styles itself from
    # ?surface=eink (spectra6, portrait, chrome dissolved) and publishes its own
    # readiness, so none of the legacy tunables (budget/cluster/title) apply —
    # the composition is the SPA's own. Titles come from the SPA too.
    "shoot_spa": False,
    # theme=day: a fresh headless profile has no localStorage and the SPA's
    # stored default is night (Obsidian) — the wall wants the day print.
    # surface=eink is the SPA's dedicated print; surface=kiosk shoots the
    # SCREEN composition (bigger ring, ambient) and needs settle_ms > 3000
    # so the exit pill has auto-hidden by capture.
    "shoot_spa_path": "/collage/?surface=eink&theme=day",
    "shoot_spa_settle_ms": 250,
    "hours": 24,
    "image": "",            # local PNG written by the shooter
    "image_url": "",        # or a published screenshot URL
    "shoot": False,         # or capture inline (needs a browser; the Zero 2 W handles it)
    "shoot_title": None, "shoot_subtitle": None,
    "shoot_headline_px": 42, "shoot_eyebrow_px": 18, "shoot_lowercase": False,
    "shoot_mat": 0.04, "shoot_small_floor": 0.04, "shoot_count_exp": 0.65,
    # Collage geometry, config-reachable since the 13.3" wall read as "small":
    # the band's share of the page and the packer's spread/padding.
    "shoot_collage_vh": 52, "shoot_cluster_xbias": 1.0, "shoot_cluster_ybias": 1.2,
    "shoot_cluster_pad": 1,
    # The one knob that actually grows the PICTURE: render the page at
    # viewport/zoom with device-scale 2*zoom, so title and birds all land
    # proportionally larger on the same panel pixels. 1.25 keeps the maths
    # integer (480x640 @ 2.5 = exactly 1200x1600). The packer sizes its
    # cluster from the viewport, which is why collage_vh alone cannot do this.
    "shoot_zoom": 1.0,
    # ...and zoom saturates anyway: the page's tuning() caps the cluster at
    # packingBudgetFrac of the viewport AREA (0.28-0.46 by count), and the
    # viewport maps 1:1 onto the panel. These two override that law outright
    # (None = the page's own stepped values). Budget is the fraction of the
    # panel the flock may claim; min_tile the floor under the rarest bird.
    "shoot_budget_frac": None,
    "shoot_min_tile_frac": None,
    "mat": 0.0,             # extra global shrink of the content inside the A5 opening
    "rotate": 90,           # 90 or 270 if the frame hangs the other way up
    "saturation": 0.6,
    "panel": "",            # "el133uf1" forces the 13.3" driver if auto() fails
    "quiet_start": 0, "quiet_end": 0,    # 0/0 = no quiet hours
    "heal_hours": 24,
    "min_refresh_minutes": 20,  # floor between physical pushes; 0 disables
    "state": "~/.birdframe/state.json",
    "cache": "~/.birdframe",
    "timeout": 45,
    "basic_user": None, "basic_pass": None,
    # Button views (buttons.py + views.py): where the override file lives, how
    # long a pressed view holds before reverting to this config, and operator
    # [views.<name>] tables laid over the built-ins.
    "view_file": "~/.birdframe/view.json",
    "view_ttl_hours": 4,
    "views": {},
}


def _auth(cfg):
    if not cfg.get("basic_user"):
        return None
    raw = f"{cfg['basic_user']}:{cfg.get('basic_pass') or ''}".encode()
    return "Basic " + base64.b64encode(raw).decode()


# --- change detection -------------------------------------------------------
def slugify(sci):
    return re.sub(r"[^a-z0-9]+", "-", sci.lower()).strip("-")


def _bucket(n):
    for i, edge in enumerate((1, 2, 5, 15, 40, 100, 300, 1000)):
        if n <= edge:
            return i
    return 8


def fetch_recent(base, hours, timeout, auth=None):
    url = f"{base.rstrip('/')}/avian/api/birdnet-api.php?action=recent&hours={hours}"
    req = urllib.request.Request(url, headers={"User-Agent": "Belkins-BirdNET-frame/1.0"})
    if auth:
        req.add_header("Authorization", auth)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read(2_000_000)).get("species", [])


def signature(species):
    items = sorted((slugify(s["sci"]), _bucket(int(s.get("n") or 1))) for s in species)
    return hashlib.sha256(json.dumps(items).encode()).hexdigest()[:16]


# --- image ------------------------------------------------------------------
def get_image(src, timeout, auth=None):
    if re.match(r"^https?://", src):
        req = urllib.request.Request(src, headers={"User-Agent": "Belkins-BirdNET-frame/1.0"})
        if auth:
            req.add_header("Authorization", auth)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return Image.open(io.BytesIO(r.read(20_000_000))).convert("RGB")
    return Image.open(os.path.expanduser(src)).convert("RGB")


def fit_panel(img):
    if img.size != (PANEL_W, PANEL_H):
        img = img.resize((PANEL_W, PANEL_H), Image.LANCZOS)
    return img


def _paper(img):
    """Median of the four corners, robust to a stray inked corner."""
    w, h = img.size
    px = (img.getpixel(p) for p in ((4, 4), (w - 5, 4), (4, h - 5), (w - 5, h - 5)))
    return tuple(int(statistics.median(c)) for c in zip(*px))


# The mat opening is an A5 rectangle (1 : sqrt(2)) centred in the panel; the
# content floats inside it with `mat` of inner whitespace.
A5_H = PANEL_H * 0.7071           # A5 is 1/sqrt(2) of the panel height
A5_W = A5_H / 1.41421             # A5 aspect 1 : sqrt(2)


def _place(content, paper, mat):
    s = min(A5_W * (1 - mat) / content.width, A5_H * (1 - mat) / content.height)
    nw, nh = max(1, round(content.width * s)), max(1, round(content.height * s))
    content = content.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGB", (PANEL_W, PANEL_H), paper)
    canvas.paste(content, ((PANEL_W - nw) // 2, (PANEL_H - nh) // 2))
    return canvas


def _region_bbox(img, paper, y0, y1):
    region = img.crop((0, y0, img.width, y1))
    diff = ImageChops.difference(region, Image.new("RGB", region.size, paper))
    bb = diff.convert("L").point(lambda p: 255 if p > 34 else 0).getbbox()
    return None if not bb else (bb[0], y0 + bb[1], bb[2], y0 + bb[3])


def _scale_w(img, target_w):
    s = target_w / img.width
    return img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))), Image.LANCZOS)


def _scale_h(img, target_h):
    s = target_h / img.height
    return img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))), Image.LANCZOS)


def _centroid_x(img, paper):
    """Horizontal centre of ink weight (what the eye reads as centred)."""
    m = ImageChops.difference(img, Image.new("RGB", img.size, paper)).convert("L")
    cols = list(m.resize((img.width, 1), Image.BOX).tobytes())
    total = sum(cols) or 1
    return sum(x * v for x, v in enumerate(cols)) / total


# Content layout inside the A5 opening: the title and collage are sized
# independently (as fractions of the opening width), so tuning one leaves the
# other untouched. gap is a fraction of the opening height.
TITLE_H_FRAC, COLLAGE_FRAC, GAP_FRAC = 0.065, 0.66, 0.1


def mat_and_center(img, mat, empty=False):
    """Crop the title and collage, size each to a fraction of the A5 opening,
    stack with a gap, and centre on the panel."""
    img = img.convert("RGB")
    paper = _paper(img)
    mask = ImageChops.difference(img, Image.new("RGB", img.size, paper))
    mask = mask.convert("L").point(lambda p: 255 if p > 34 else 0)
    full = mask.getbbox()
    if not full:
        return img
    levels = list(mask.resize((1, img.height), Image.BOX).tobytes())  # per-row content
    top, bot = full[1], full[3]
    split, run = None, 0
    for y in range(top, bot):
        if levels[y] <= 2:
            run += 1
            if run >= 60:  # split below the headline; a 60px band clears the ~30px eyebrow/headline gap so the title stays whole
                cy = y
                while cy < bot and levels[cy] <= 2:
                    cy += 1
                split = (y - run + 1, cy)
                break
        else:
            run = 0
    tb = _region_bbox(img, paper, top, split[0]) if split else None
    cb = _region_bbox(img, paper, split[1], bot + 1) if split else None
    box_w, box_h = A5_W * (1 - mat), A5_H * (1 - mat)
    # No birds: the content under the title is just the one-line empty-state
    # note. Render a calm title card (a modest title with the small note
    # below) rather than blowing the lone title up to fill the opening.
    if empty and tb and cb:
        title = _scale_h(img.crop(tb), box_h * TITLE_H_FRAC)
        note = _scale_w(img.crop(cb), box_w * 0.30)
        gap = round(box_h * 0.05)
        cw = max(title.width, note.width)
        comp = Image.new("RGB", (cw, title.height + gap + note.height), paper)
        comp.paste(title, ((cw - title.width) // 2, 0))
        comp.paste(note, ((cw - note.width) // 2, title.height + gap))
        canvas = Image.new("RGB", (PANEL_W, PANEL_H), paper)
        canvas.paste(comp, ((PANEL_W - comp.width) // 2, (PANEL_H - comp.height) // 2))
        return canvas
    if not (tb and cb):
        return _place(img.crop(full), paper, mat)
    title = _scale_h(img.crop(tb), box_h * TITLE_H_FRAC)
    gap = round(box_h * GAP_FRAC)
    # Size the collage to fill the room left under the fixed-size title,
    # binding on whichever of width or remaining height runs out first, so the
    # title stays a consistent size whether the collage is tall or compact
    # instead of ballooning when the collage happens to be short.
    coll = img.crop(cb)
    cs = min(box_w * COLLAGE_FRAC / coll.width, (box_h - title.height - gap) / coll.height)
    collage = coll.resize((max(1, round(coll.width * cs)), max(1, round(coll.height * cs))), Image.LANCZOS)
    ccx = _centroid_x(collage, paper)  # centre the collage by ink weight, not bbox
    half = max(ccx, collage.width - ccx)
    # A wildly off-centre collage can push the centroid-mirrored width (2*half)
    # past the A5 opening; shrink only the collage, never the fixed-size title,
    # so nothing spills under the physical mat.
    if 2 * half > box_w:
        s = box_w / (2 * half)
        collage = collage.resize((max(1, round(collage.width * s)), max(1, round(collage.height * s))), Image.LANCZOS)
        ccx = round(ccx * s)
        half = max(ccx, collage.width - ccx)
    cw = round(max(title.width, 2 * half))
    comp = Image.new("RGB", (cw, title.height + gap + collage.height), paper)
    comp.paste(title, ((cw - title.width) // 2, 0))
    comp.paste(collage, (round(cw / 2 - ccx), title.height + gap))
    canvas = Image.new("RGB", (PANEL_W, PANEL_H), paper)
    canvas.paste(comp, ((PANEL_W - comp.width) // 2, (PANEL_H - comp.height) // 2))
    return canvas


def quantize_spectra6(img):
    pal = Image.new("P", (1, 1))
    flat = [c for ink in SPECTRA6 for c in ink]
    flat += list(SPECTRA6[0]) * ((768 - len(flat)) // 3)  # pad the 256-entry palette with paper
    pal.putpalette(flat[:768])
    return img.convert("RGB").quantize(palette=pal, dither=Image.Dither.FLOYDSTEINBERG).convert("RGB")


def _draw_mat_box(img):
    """Dev aid: outline the A5 mat opening so the matte and centring show."""
    x0, y0 = round((PANEL_W - A5_W) / 2), round((PANEL_H - A5_H) / 2)
    ImageDraw.Draw(img).rectangle((x0, y0, PANEL_W - x0 - 1, PANEL_H - y0 - 1),
                                  outline=(170, 60, 56), width=2)


# --- hardware ---------------------------------------------------------------
def push_panel(img, rotate, saturation, panel=""):
    """Rotate to the panel's landscape buffer and push. Lazy import so this
    module still loads on a machine without the Inky library."""
    if rotate not in (90, 270):
        print(f"rotate must be 90 or 270, not {rotate}; using 90", file=sys.stderr)
        rotate = 90
    if panel == "el133uf1":
        from inky.inky_el133uf1 import Inky
        dev = Inky(resolution=(1600, 1200))
    else:
        from inky.auto import auto
        dev = auto()
    buf = img.rotate(rotate, expand=True)
    if buf.size != (dev.width, dev.height):
        buf = buf.resize((dev.width, dev.height), Image.LANCZOS)
    kw = {"saturation": saturation} if "saturation" in inspect.signature(dev.set_image).parameters else {}
    dev.set_image(buf, **kw)
    dev.show()


# --- state ------------------------------------------------------------------
def load_state(path):
    try:
        with open(os.path.expanduser(path)) as f:
            return json.load(f)
    except Exception:
        return {"signature": None, "last_refresh": 0}


def save_state(path, sig, when, view_token=None):
    path = os.path.expanduser(path)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    doc = {"signature": sig, "last_refresh": when}
    if view_token is not None:
        # The last button token this frame has PAINTED. buttons.py compares it
        # against view.json to re-deliver presses absorbed during a paint.
        doc["view_token"] = view_token
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(doc, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)  # atomic: a power cut can't leave a half-written file


def note_auth_error(path, when):
    """Stamp an HTTP 401/403 from the station into state.json. save_state
    writes a fresh dict on the next successful paint, so the key's PRESENCE
    means 'auth has failed since the last success' — frame_watch reads it to
    name re-gating as the cause when the freshness budget finally trips,
    instead of a generic 'wall frozen'. Without this, a reverted STATION_OPEN
    looks identical to every other silent freeze for ~30h."""
    s = load_state(path)
    s["auth_error"] = when
    path = os.path.expanduser(path)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def in_quiet_hours(cfg, hour):
    s, e = cfg["quiet_start"], cfg["quiet_end"]
    if s == e:
        return False
    return s <= hour < e if s < e else hour >= s or hour < e


# --- run --------------------------------------------------------------------
def obtain_image(cfg):
    if cfg["shoot"]:
        out = os.path.join(os.path.expanduser(cfg["cache"]), "shot.png")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        if cfg["shoot_spa"]:
            from shoot import shoot_spa
            spa = cfg["shoot_spa_path"].lstrip("/")
            sep = "&" if "?" in spa else "?"
            url = f"{cfg['base_url'].rstrip('/')}/{spa}{sep}win={int(cfg['hours'])}"
            zoom = float(cfg["shoot_zoom"]) or 1.0
            shoot_spa(url, out, timeout_ms=cfg["timeout"] * 1000,
                      vw=round(600 / zoom), vh=round(800 / zoom), dsf=2 * zoom,
                      settle_ms=int(cfg["shoot_spa_settle_ms"]))
            return Image.open(out).convert("RGB")
        from shoot import shoot
        shoot_url = cfg["base_url"].rstrip("/") + "/" + cfg.get("shoot_path", "/index.html").lstrip("/")
        zoom = float(cfg["shoot_zoom"]) or 1.0
        shoot(shoot_url, out, title=cfg["shoot_title"], subtitle=cfg["shoot_subtitle"],
              vw=round(600 / zoom), vh=round(800 / zoom), dsf=2 * zoom,
              headline_px=cfg["shoot_headline_px"], eyebrow_px=cfg["shoot_eyebrow_px"],
              lowercase=cfg["shoot_lowercase"], mat=cfg["shoot_mat"],
              small_floor=cfg["shoot_small_floor"], count_exp=cfg["shoot_count_exp"], timeout_ms=cfg["timeout"] * 1000,
              collage_vh=cfg["shoot_collage_vh"], cluster_xbias=cfg["shoot_cluster_xbias"],
              cluster_ybias=cfg["shoot_cluster_ybias"], cluster_pad=cfg["shoot_cluster_pad"],
              budget_frac=cfg["shoot_budget_frac"], min_tile_frac=cfg["shoot_min_tile_frac"],
              user=cfg["basic_user"], password=cfg["basic_pass"],
              # Re-window the page's own API call to the config/view window, so
              # the collage shows the same hours the signature poll watches —
              # the legacy page reads its window from localStorage, which a
              # fresh headless profile never has.
              window_hours=int(cfg["hours"]))
        return Image.open(out).convert("RGB")
    src = cfg["image_url"] or cfg["image"]
    if not src:
        raise ValueError("set image, image_url, or shoot in config")
    return get_image(src, cfg["timeout"], _auth(cfg))


def run(cfg, preview=None, force=False, use_signature=True, mat_box=False, view_token=None):
    now = time.time()
    state = load_state(cfg["state"])
    if view_token is not None and view_token != state.get("view_token"):
        # A token this frame has never painted = an operator's finger on the
        # hardware. Paint now, with the same bypasses as --force: quiet hours,
        # the change check and the min-refresh floor all yield to a button.
        print("button press: paint now")
        force = True
    sig = None
    species = None
    if use_signature:
        try:
            species = fetch_recent(cfg["base_url"], cfg["hours"], cfg["timeout"], _auth(cfg))
            sig = signature(species)
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                print(f"AUTH REQUIRED (HTTP {e.code}): the station is gated; set basic_user/basic_pass "
                      "in the frame config", file=sys.stderr)
                note_auth_error(cfg["state"], now)
            else:
                print(f"signature fetch failed: {e}", file=sys.stderr)  # treat as no change
        except Exception as e:
            print(f"signature fetch failed: {e}", file=sys.stderr)  # treat as no change
    heal_due = now - state.get("last_refresh", 0) >= cfg["heal_hours"] * 3600
    changed = (not use_signature) or (sig is not None and sig != state.get("signature"))
    if not force and not preview:
        if in_quiet_hours(cfg, datetime.now().hour):
            print("quiet hours; skip")
            return
        if not changed and not heal_due:
            print("no change; skip")
            return
        if now - state.get("last_refresh", 0) < cfg["min_refresh_minutes"] * 60:
            print(f"refreshed under {cfg['min_refresh_minutes']}m ago; skip")
            return
        print("refresh:", "changed" if changed else "heal")

    try:
        img = fit_panel(obtain_image(cfg))
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            print(f"AUTH REQUIRED (HTTP {e.code}): could not fetch the image — the station is gated; "
                  "set basic_user/basic_pass in the frame config", file=sys.stderr)
            note_auth_error(cfg["state"], now)
        else:
            print(f"could not get image: {e}", file=sys.stderr)  # keep last panel image
        return
    except Exception as e:
        print(f"could not get image: {e}", file=sys.stderr)  # keep last panel image
        return
    img = mat_and_center(img, cfg["mat"], empty=(species == []))
    if preview:
        out = quantize_spectra6(img)
        if mat_box:
            _draw_mat_box(out)
        out.save(preview)
        print(f"wrote preview {preview}")
        return
    try:
        push_panel(img, cfg["rotate"], cfg["saturation"], cfg.get("panel", ""))
    except Exception as e:
        print(f"panel push failed: {e}", file=sys.stderr)
        return
    save_state(cfg["state"], sig if sig is not None else state.get("signature"), now,
               view_token=view_token)
    print("panel updated")


def load_config(path):
    cfg = dict(DEFAULTS)
    if path:
        with open(os.path.expanduser(path), "rb") as f:
            cfg.update(tomllib.load(f))
    return cfg


def main():
    ap = argparse.ArgumentParser(description="Push the collage screenshot to the Inky panel.")
    ap.add_argument("--config")
    ap.add_argument("--base-url")
    ap.add_argument("--image")
    ap.add_argument("--image-url")
    ap.add_argument("--preview", help="write a 6-ink preview PNG instead of pushing")
    ap.add_argument("--rotate", type=int)
    ap.add_argument("--force", action="store_true", help="refresh even if unchanged")
    ap.add_argument("--no-signature", action="store_true", help="skip change detection")
    ap.add_argument("--mat-box", action="store_true", help="dev: outline the mat window on the preview")
    args = ap.parse_args()

    cfg = load_config(args.config)
    for key in ("base_url", "image", "image_url"):
        val = getattr(args, key)
        if val:
            cfg[key] = val
    if args.rotate is not None:
        cfg["rotate"] = args.rotate
    # Button views last: they overlay whatever config+flags produced, so a
    # pressed view wins for its lifetime and expiry falls back to exactly the
    # cfg built above.
    import views
    cfg, view_token = views.resolve(cfg)
    run(cfg, preview=args.preview, force=args.force, use_signature=not args.no_signature,
        mat_box=args.mat_box, view_token=view_token)


if __name__ == "__main__":
    main()
