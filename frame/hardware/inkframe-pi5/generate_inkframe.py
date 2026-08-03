"""
Inkframe Mk I — wall frame for Pimoroni Inky Impression 13.3" Spectra + Raspberry Pi 5
Generates STL + STEP. All dimensions mm, from the official Pimoroni dimensional
drawing (inky-impression-13-drawing.png) — front-view coordinates, origin at
panel centre, +x right, +y up, +z rearward (z=0 is the frame's front face).

Panel facts (measured off the official drawing):
  board 296.70 x 210.00 | glass 284.70 x 208.80 | active 270.40 x 202.80
  corner holes M2 at 3.0/3.0 from edges | side buttons (left edge, front view)
  at y = +/-25.35, +/-76.05 | Pi holes 58x49, right column 107.60 from right
  board edge, bottom row 100.10 from bottom edge.
"""

from build123d import *
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)

# ----------------------------- parameters ----------------------------------
PANEL_W, PANEL_H = 296.7, 210.0
ACTIVE_W, ACTIVE_H = 270.4, 202.8
PANEL_T = 4.5          # panel edge stack thickness — verify with calipers; foam absorbs +/-1.5
PANEL_CLR = 0.35       # pocket clearance per side

FACE_T = 3.2           # front face plate thickness
REVEAL = 0.8           # opening margin outside active area, per side
FACE_W_TB = 19.0       # face border width top/bottom
INTERIOR = 34.0        # clear depth behind panel back (booster + Pi 5 + ports ~30)
COVER_T = 2.4          # back cover plate
RABBET_D = 2.6         # back cover recess depth
WALL_MIN = 2.5         # wall left beside rabbet

OPEN_W = ACTIVE_W + 2 * REVEAL          # 272.0
OPEN_H = ACTIVE_H + 2 * REVEAL          # 204.4
OUTER_H = OPEN_H + 2 * FACE_W_TB        # 242.4
OUTER_W = 312.0                          # sides get 20.0 face (extra meat for button channel)
POCK_W = PANEL_W + 2 * PANEL_CLR        # 297.4
POCK_H = PANEL_H + 2 * PANEL_CLR        # 210.7
DEPTH = FACE_T + PANEL_T + INTERIOR + RABBET_D + 0.3   # 44.6 total frame depth
RAB_Z = DEPTH - RABBET_D                # rabbet floor = interior ceiling
RAB_W, RAB_H = OUTER_W - 2 * WALL_MIN, OUTER_H - 2 * WALL_MIN  # 307 x 237.4

BTN_CLR = 4.0          # extra clearance beyond pocket wall for side buttons
BTN_SPAN = 84.0        # half-span of button channel in y (buttons out to +/-76.05)

PILOT_D = 2.8          # M3 self-tap pilot
PILOT_DEPTH = 12.0
POST_D = 8.0
FOAM_GAP = 1.5         # 3mm EVA foam compressed to ~1.5
POST_TIP_Z = FACE_T + PANEL_T + FOAM_GAP          # post tip presses foam onto panel back

Z_SPLIT = 22.0         # half-lap split plane for quadrant joints
LAP = 16.0             # lap tongue length
LAP_CLR = 0.15

# screws into solid top/bottom walls + 2 side bosses.
# bottom row avoids the cable tunnel (x -22..8) and the vent slots (x +/-20..40, +/-50..70)
SCREWS_TB = [(-85, 111.5), (0, 111.5), (85, 111.5),
             (-85, -111.5), (-45, -111.5), (45, -111.5), (85, -111.5)]
SCREWS_SIDE = [(-149.4, 0), (149.4, 0)]

POSTS = [(-141, 97), (141, 97), (-141, -97), (141, -97), (-138, 0), (141, 0)]

KEY_L = [(-85, 55, 0), (85, 55, 0)]      # landscape pair, slot toward +y (angle 0)
KEY_P = [(-55, 85, -90), (-55, -85, -90)]  # portrait pair, slot toward -x

CABLE_X = (-22, 8)     # cable tunnel span in x (under Pi USB-C)
SEAM_X = 8.0           # back cover split line

def box(w, h, d, x=0, y=0, z=0):
    return Pos(x, y, z) * Box(w, h, d, align=(Align.CENTER, Align.CENTER, Align.MIN))

# ----------------------------- front frame ---------------------------------
ring = box(OUTER_W, OUTER_H, DEPTH)

# soften outer vertical corners before cutting
ring = fillet(ring.edges().filter_by(Axis.Z).sort_by(lambda e: e.length)[-4:], 3.0)

ring -= box(OPEN_W, OPEN_H, DEPTH + 2, z=-1)                 # opening (through)
ring -= box(POCK_W, POCK_H, DEPTH, z=FACE_T)                 # panel pocket + cavity
ring -= box(RAB_W, RAB_H, RABBET_D + 1, z=RAB_Z)             # back cover rabbet

# button channel along left pocket wall
ring -= box(BTN_CLR + 1, 2 * BTN_SPAN, DEPTH, x=-(POCK_W / 2 + (BTN_CLR + 1) / 2 - 0.5), z=FACE_T)

# cable tunnel through bottom wall (rear 11mm, exits at back-bottom edge)
cx = (CABLE_X[0] + CABLE_X[1]) / 2
ring -= box(CABLE_X[1] - CABLE_X[0], 30, 12, x=cx, y=-(OUTER_H / 2 - 8), z=DEPTH - 11)

# vent slots through top and bottom walls (20 x 5, chimney airflow)
for vx in (-55, -25, 25, 55):
    ring -= box(20, 30, 5, x=vx, y=OUTER_H / 2 - 8, z=DEPTH - 10)
for vx in (-60, -30, 30, 60):
    ring -= box(20, 30, 5, x=vx, y=-(OUTER_H / 2 - 8), z=DEPTH - 10)

# side screw bosses (hang from rabbet, above panel level, merged into side walls)
# cone under each boss -> printable at 45 deg when the frame prints face-down
for sx, sy in SCREWS_SIDE:
    ring += Pos(sx, sy, 12) * Cylinder(POST_D / 2, RAB_Z - 12, align=(Align.CENTER, Align.CENTER, Align.MIN))
    ring += Pos(sx, sy, 8.5) * Cone(1.0, POST_D / 2, 3.5, align=(Align.CENTER, Align.CENTER, Align.MIN))

# pilot holes (drilled from rabbet floor forward)
for sx, sy in SCREWS_TB + SCREWS_SIDE:
    ring -= Pos(sx, sy, RAB_Z - PILOT_DEPTH) * Cylinder(PILOT_D / 2, PILOT_DEPTH + 1, align=(Align.CENTER, Align.CENTER, Align.MIN))

# gentle chamfer on front rims (outer + opening)
try:
    front_edges = ring.edges().group_by(Axis.Z)[0]
    ring = chamfer(front_edges, 1.0)
except Exception as e:
    print("chamfer skipped:", e)

front_full = ring

# ------------------------- quadrant split (half-laps) ----------------------
BIG = 400
def halfspace(xsign=None, ysign=None):
    x0, x1 = (-BIG, 0) if xsign == -1 else (0, BIG) if xsign == 1 else (-BIG, BIG)
    y0, y1 = (-BIG, 0) if ysign == -1 else (0, BIG) if ysign == 1 else (-BIG, BIG)
    return box(x1 - x0, y1 - y0, BIG, x=(x0 + x1) / 2, y=(y0 + y1) / 2, z=-BIG / 4)

# joint tongue boxes: front-half (z < Z_SPLIT) material crossing the cut line.
# owner piece ADDS (ring ∩ box); neighbour SUBTRACTS box grown by LAP_CLR.
J = {
    "top":    box(LAP, OUTER_H, Z_SPLIT + 1, x=LAP / 2, y=OUTER_H / 2 - 20, z=-1),      # at x=0+, owner TL
    "bottom": box(LAP, OUTER_H, Z_SPLIT + 1, x=-LAP / 2, y=-(OUTER_H / 2 - 20), z=-1),  # at x=0-, owner BR
    "left":   box(OUTER_W, LAP, Z_SPLIT + 1, x=-(OUTER_W / 2 - 20), y=LAP / 2, z=-1),   # at y=0+, owner BL, protrudes into TL
    "right":  box(OUTER_W, LAP, Z_SPLIT + 1, x=OUTER_W / 2 - 20, y=-LAP / 2, z=-1),     # at y=0-, owner TR, protrudes into BR
}
def grown(b):
    bb = b.bounding_box()
    return box(bb.size.X + 2 * LAP_CLR, bb.size.Y + 2 * LAP_CLR, bb.size.Z + 2 * LAP_CLR,
               x=bb.center().X, y=bb.center().Y, z=bb.min.Z - LAP_CLR)

# wall zones only (tongue boxes above deliberately overshoot into open cavity; intersection with ring trims them)
q_TL = (front_full & halfspace(-1, 1)) + (front_full & J["top"]) - grown(J["left"])
q_TR = (front_full & halfspace(1, 1)) - grown(J["top"]) + (front_full & J["right"])
q_BR = (front_full & halfspace(1, -1)) - grown(J["right"]) + (front_full & J["bottom"])
q_BL = (front_full & halfspace(-1, -1)) - grown(J["bottom"]) + (front_full & J["left"])

# ----------------------------- back cover ----------------------------------
COV_W, COV_H = RAB_W - 0.6, RAB_H - 0.6      # 306.4 x 236.8
COV_Z = RAB_Z + 0.1                           # 0.2 recess below frame rear face
plate = box(COV_W, COV_H, COVER_T, z=COV_Z)

# clamp posts with foam-pad tips
for px, py in POSTS:
    plate += Pos(px, py, POST_TIP_Z) * Cylinder(POST_D / 2, COV_Z - POST_TIP_Z + 0.01, align=(Align.CENTER, Align.CENTER, Align.MIN))

# countersunk M3 clearance holes
for sx, sy in SCREWS_TB + SCREWS_SIDE:
    plate -= Pos(sx, sy, COV_Z - 1) * Cylinder(3.4 / 2, COVER_T + 2, align=(Align.CENTER, Align.CENTER, Align.MIN))
    plate -= Pos(sx, sy, COV_Z + COVER_T - 1.4) * Cone(3.4 / 2, 6.4 / 2, 1.5, align=(Align.CENTER, Align.CENTER, Align.MIN))

# keyhole pads + keyholes (entry ø9.5, slot ø5 x 14, head pocket leaves 2.2 lip)
def keyhole(part, x, y, ang):
    pad = Pos(x, y, COV_Z - 3.6) * Rot(0, 0, ang) * Box(26, 40, 3.61, align=(Align.CENTER, Align.CENTER, Align.MIN))
    part += pad
    loc = Pos(x, y, 0) * Rot(0, 0, ang)
    z0 = COV_Z - 3.6
    entry = loc * Pos(0, 0, z0 - 1) * Cylinder(9.5 / 2, 20, align=(Align.CENTER, Align.CENTER, Align.MIN))
    slot_n = loc * Pos(0, 7, z0 - 1) * Box(5, 14.5, 20, align=(Align.CENTER, Align.CENTER, Align.MIN))
    pocket = loc * Pos(0, 7, z0 - 1) * Box(9.5, 14.5, (COV_Z + COVER_T - 2.2) - z0 + 1, align=(Align.CENTER, Align.CENTER, Align.MIN))
    return part - entry - slot_n - pocket

for x, y, a in KEY_L + KEY_P:
    plate = keyhole(plate, x, y, a)

# vent grid over the Pi zone (two fields, clear of the x=8 seam)
for fx0, fx1, rows in ((-24, 2, (16, 26, 36, 46)), (14, 58, (-8, 2, 12, 22, 32, 42))):
    fw = fx1 - fx0
    for ry in rows:
        plate -= box(fw, 4, COVER_T + 2, x=(fx0 + fx1) / 2, y=ry, z=COV_Z - 1)

# cable notch at bottom edge
plate -= box(CABLE_X[1] - CABLE_X[0], 22, COVER_T + 2, x=cx, y=-(COV_H / 2), z=COV_Z - 1)

# zip-tie saddles on the interior face: power lead path (Pi USB-C -> tunnel) + mic lead path
# (USB-A, right edge -> tunnel). Clear of posts, keyhole pads, vents, seam, and the Pi envelope.
SADDLES = [(-10, -70), (35, -70), (75, -20)]
for sx, sy in SADDLES:
    plate += box(10, 4, 6, x=sx, y=sy, z=COV_Z - 6)
    plate -= box(4, 6, 3, x=sx, y=sy, z=COV_Z - 4.5)

back_full = plate

# dovetail seam at x = SEAM_X: 3 trapezoid tabs owned by the RIGHT half
def dovetails():
    tabs = Part()
    for ty in (-95, 0, 95):
        with BuildPart() as tb:
            with BuildSketch(Plane.XY.offset(COV_Z)):
                with Locations((SEAM_X, ty)):
                    Trapezoid(26, 12, 60, align=(Align.CENTER, Align.CENTER), rotation=-90)
            extrude(amount=COVER_T)
        tabs += tb.part
    return tabs

tabs = dovetails()
def grow_tabs(t, d):
    return offset(t, amount=d, kind=Kind.INTERSECTION)

right_zone = box(BIG, BIG, BIG, x=SEAM_X + BIG / 2, z=COV_Z - BIG / 4)
back_right = (back_full & right_zone) + (back_full & tabs)
back_left = back_full - right_zone - grow_tabs(tabs, LAP_CLR)

# ----------------------------- mocks for assembly STEP ----------------------
panel_mock = box(PANEL_W, PANEL_H, PANEL_T, z=FACE_T)
# Pi board: holes at x {-17.25, 40.75}, y {-4.9, 44.1}; board 85x56, holes 3.5 in from corners
pi_mock = box(85, 56, 28, x=-17.25 - 3.5 + 42.5, y=-4.9 - 3.5 + 28, z=FACE_T + PANEL_T + 2)

# ----------------------------- checks + export ------------------------------
def report(name, p):
    bb = p.bounding_box()
    print(f"{name:22s} vol={p.volume/1000:8.1f} cm3  bbox=({bb.size.X:6.1f},{bb.size.Y:6.1f},{bb.size.Z:5.1f})  valid={p.is_valid}")

parts = {
    "front_full": front_full, "front_TL": q_TL, "front_TR": q_TR,
    "front_BL": q_BL, "front_BR": q_BR,
    "back_full": back_full, "back_left": back_left, "back_right": back_right,
}
for n, p in parts.items():
    report(n, p)

for n, p in parts.items():
    export_stl(p, os.path.join(OUT, f"inkframe_{n}.stl"))
    export_step(p, os.path.join(OUT, f"inkframe_{n}.step"))

asm = Compound(children=[
    Compound(children=[front_full], label="front_frame"),
    Compound(children=[back_full], label="back_cover"),
    Compound(children=[panel_mock], label="inky_panel_mock"),
    Compound(children=[pi_mock], label="pi5_mock"),
])
export_step(asm, os.path.join(OUT, "inkframe_assembly.step"))
print("exported to", OUT)

# section SVGs for visual verification (thin slab intersect -> planar faces)
def export_section(part, zval, name):
    slab = part & box(500, 500, 0.05, z=zval)
    faces = [f for f in slab.faces() if abs(f.normal_at(f.center()).Z) > 0.99]
    faces = [f for f in faces if abs(f.center().Z - zval) < 0.04]
    exp = ExportSVG(margin=5)
    for f in faces:
        exp.add_shape(f)
    exp.write(os.path.join(OUT, f"sec_{name}.svg"))

for zname, zval, part in (("face", 1.0, front_full), ("mid", 20.0, front_full),
                          ("rear", DEPTH - 1.5, front_full), ("cover", RAB_Z + 1.2, back_full),
                          ("quads", 10.0, q_TL + q_TR + q_BL + q_BR)):
    try:
        export_section(part, zval, zname)
    except Exception as e:
        print(f"section {zname} failed: {e}")

# isometric line renders for eyeball QA
for name, part in (("iso_front", front_full), ("iso_back", back_full)):
    try:
        vis, hid = part.project_to_viewport((500, -400, -600))
        exp = ExportSVG(margin=5)
        for e in vis:
            exp.add_shape(e)
        exp.write(os.path.join(OUT, f"{name}.svg"))
    except Exception as e:
        print(f"{name} render failed: {e}")
print("done")
