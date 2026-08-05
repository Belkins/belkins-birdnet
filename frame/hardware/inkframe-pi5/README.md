# Inkframe — printed wall frame for the 13.3" Spectra (Mk I: Pi 5 · Mk II: Zero 2 W)

A two-part, fully 3D-printed museum frame for the Pimoroni Inky Impression 13.3"
(Spectra 6). Hangs flush on the wall, landscape or portrait. Every dimension comes
from Pimoroni's official dimensional drawing (`pimoroni-official-drawing.png`) —
board 296.7 × 210.0, active area 270.4 × 202.8, side buttons at ±25.35/±76.05 mm,
Pi holes 58 × 49 at 107.6 from the right edge / 100.1 from the bottom.

Two variants from one generator (`--variant pi5` | `--variant zero`):

| | Mk I (`inkframe_*`) | Mk II slim (`inkframe_zero_*`) |
|---|---|---|
| Computer | Pi 5 on the stock booster header | Pi Zero 2 W straight into the panel socket |
| Outer size | 312 × 242.4 × **44.6** mm | 312 × 242.4 × **25.6** mm |
| Interior depth | 34 mm | 15 mm |
| Architecture | one-box: the frame Pi IS the station | two-box: station renders, the Zero fetches + paints |
| Cables in tunnel | USB-C power + mic lead | micro-USB power only (mic stays with the station) |

Mk II also adds two fixes Mk I's prints don't have: a 1.6 mm FFC relief along the
top pocket wall (the display flex wraps the panel's top edge — unmodeled in Mk I)
and pocket clearance widened 0.35 → 0.45 per side for print-shrinkage headroom.
The panel locates on the bottom wall; gravity seats it there in both hang modes.
Zero notes: flash the microSD before assembly (slot faces the left edge, reachable
with the cover off); optionally add 2 × M2.5 8–9 mm standoffs on the socket-row
holes; power is micro-USB, not USB-C.

**The opening sits 0.8 mm outside the active area**, so the panel's own black
border vanishes behind the lip — the image reads edge-to-edge, like a matted
print. Print it in matte black.

## Files

| File | What |
|------|------|
| `inkframe_front_full.stl/.step` | Front frame, one piece (needs ≥320 mm bed) |
| `inkframe_front_TL/TR/BL/BR.stl/.step` | Front frame in 4 half-lap quadrants, each ≤172×138 mm — fits a 220×220 bed |
| `inkframe_back_full.stl/.step` | Back cover, one piece |
| `inkframe_back_left/right.stl/.step` | Back cover in 2 dovetailed halves, each ≤162×237 mm — needs a ≥250×240 bed area (Bambu 256² fits; ping me to re-split smaller) |
| `inkframe_assembly.step` | Everything positioned, with panel + Pi mockups — open in Fusion to sanity-check |
| `generate_inkframe.py` | Parametric source (build123d). Change a number, rerun, get new files |

## How it holds the panel — no screws into the display

The panel drops into a 297.4 × 210.7 pocket behind the front lip. The back cover
carries **six ø8 posts** that press it against the lip through **3 mm EVA foam
pads** — tolerant of the panel's exact thickness (set at 4.5 mm in the script;
caliper yours and regenerate if it's off by more than ±1.5). The Pi 5 stays on
Pimoroni's own booster header + standoffs; the frame never touches it.

- **Button channel** along the left wall (viewed from front) — the four A/B/C/D
  side switches get 4 mm of clearance and stay reachable with the cover off.
- **Cable tunnel** out the back-bottom edge, under the Pi's USB-C. Invisible from the
  front. It's a lay-in channel: with the cover off, both leads (USB-C power + the USB
  mic lead) drop into the open channel — no threading connectors through holes — and
  the cover's matching notch closes over them.
- **Zip-tie saddles ×3** on the cover interior route the power lead (Pi USB-C → tunnel)
  and the mic lead (USB-A on the Pi's right edge → tunnel) so nothing rests on the
  panel back or rattles. **The mic capsule itself stays OUTSIDE the frame** — a closed
  box would muffle the station's listening; keep the lav on its window mount
  (`../BirdMic` / `../micMount`) and only its cable enters the frame.
- **Chimney vents** through the top and bottom walls + a slot grid over the Pi.
- **Keyholes ×4** in the cover: pair at (±85, 55) for landscape, pair at (−55, ±85)
  for portrait. Recessed pads — the frame sits flush on the wall.

## BOM

- 9 × M3×10 button-head screws (self-tap into 2.8 mm pilots — no inserts needed)
- 6 × ~15×15 mm squares of 3 mm EVA foam tape (posts) + optional felt strip for the lip
- 2 × wall screws, head ≤ ø8, + anchors
- 3 × small zip ties (2.5 mm) for the cable saddles
- Glue for the quadrant laps (CA or epoxy; the cover screws also clamp them)

## Print

- PETG (or PLA indoors), 0.2 mm layers, 4 perimeters, 15 % gyroid
- **Front quadrants: face DOWN** on a textured plate — the plate texture becomes
  the museum finish. No supports; vents and tunnel are bridges, the side bosses
  have built-in 45° cones.
- **Back halves: exterior DOWN.** No supports (keyhole lips bridge 9.5 mm).
- ~720 g total.

## Assembly

1. Glue the four quadrants at the half-laps (TL+TR+BL+BR — tongues interlock front/back).
2. Stick foam pads on the six cover posts; felt on the lip if you want zero glass-on-plastic.
3. Panel face-down into the pocket, buttons into the left channel.
4. Pi 5 onto the booster header + standoffs (stock Pimoroni hardware). Plug in USB-C
   power and the mic lead, zip-tie both to the cover saddles, lay them into the bottom
   channel. The mic capsule stays outside on its window mount.
5. Dovetail the two cover halves together, drop the cover into the rabbet, 9 × M3.
6. Two wall screws 170 mm apart, level; hang by the keyholes (top pair = landscape).

## Regenerating

```bash
python3 -m venv cadenv && ./cadenv/bin/pip install build123d
./cadenv/bin/python generate_inkframe.py                 # Mk I (Pi 5)  → out/inkframe_*
./cadenv/bin/python generate_inkframe.py --variant zero  # Mk II slim   → out/inkframe_zero_*
```

Key parameters at the top of the script: `PANEL_T` (panel edge thickness),
`INTERIOR` (34 mm — depth behind the panel; measure your booster+Pi stack and
add ~4), `FACE_W_TB` / `REVEAL` (frame face width / how much bezel shows),
`PILOT_D`, keyhole and vent positions.
