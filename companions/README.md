# Companions

Small, glanceable surfaces that live **off** the museum frame.

The collage itself is a calm museum — you set it on a wall and let it breathe.
But a museum isn't something you pull out of your pocket at a red light. These
**companions** are the pocket-sized, tab-sized, glance-sized views for the
person who keeps coming back to check *"what's out there right now?"* — without
turning the frame into a dashboard.

Two zones, on purpose:

| Zone | Where | Feel |
|------|-------|------|
| **The frame** | the wall (`/collage/`) | museum — sacred, slow, uncluttered |
| **The companions** | phone widget, browser tab | glanceable — quick, honest, disposable |

Everything here is **additive and self-contained**: no build step, no new
backend, no database. Each companion reads the **existing** public endpoints the
collage already serves:

- **Catalog** (all-time life-list) — `<BASE>/collage/species.json`
- **Snapshot** (last-24h roster) — `<BASE>/avian/api/birdnet-api.php?action=recent&hours=24`
- **Live stream** (SSE) — `<BASE>/events`
- **Cutout art** — `<BASE>/avian/api/cutout.php?sci=<sci>&pose=1`

---

## The honesty rule

A companion you glance at all day is only worth having if you can trust it. So:

- **Every number is real.** Counts come straight from the snapshot roster and the
  live stream. Nothing is padded, estimated, or invented.
- **Stale is shown as stale.** If the deploy can't be reached, you see
  `— offline —` (widget) or a red **offline** dot (new tab) — never a frozen old
  number dressed up as fresh.
- **Quiet is shown as quiet.** No birds in the window? You get a calm
  *"listening…"* / *"the window is quiet"*, not a fake detection.

If a value can't be verified, the companion says so instead of guessing.

---

## 1. `birdnet-widget.js` — iOS home-screen widget (Scriptable)

The no-App-Store path. [Scriptable](https://scriptable.app) runs JavaScript as a
real iOS home-screen widget.

**Shows:** the newest lifer (the most recently accessioned species on your wall),
how many species were heard in the last 24 hours, and when it last checked in.
On a Medium widget it also draws the newest lifer's cutout.

**Config — one constant:**
```js
const BASE = "https://birdnet.example.com"; // your deploy origin, no trailing slash
```
Local Pi → `"http://birdnet.local"`. Remote deploy → your `https://…` origin.

**Install:**
1. Install **Scriptable** from the App Store (free).
2. Open it → **＋** → paste `birdnet-widget.js` → name it *Belkins BirdNET*.
3. Edit the `BASE` constant at the top to your deployment.
4. Home screen → long-press → **＋** → **Scriptable** → add a **Small** or
   **Medium** widget → long-press it → **Edit Widget** → Script → *Belkins BirdNET*.

The widget refreshes on iOS's own schedule (it hints ~15 min). If the deploy is
unreachable it shows `— offline —` and dashes for the numbers.

## 2. `newtab.html` — browser new-tab / bookmark

A single self-contained HTML page (inline CSS + vanilla JS, no framework, no
build) in the museum's cream aesthetic. Set it as your browser's new-tab page or
just bookmark it.

**Shows:** a live **now hearing** line off the SSE stream, the last-24h species
count, and the few most-recently-heard species with their cutouts — plus a live
connection dot (green **live** / red **offline**).

**Config — one constant:**
```js
var BASE = ""; // same-origin by default
```
- **Hosted under your deploy** (e.g. copied to `web/public/newtab.html` so it
  serves at `<origin>/collage/newtab.html`, or opened as that origin's new-tab):
  leave `BASE = ""` — the relative endpoints resolve against the origin and it
  just works.
- **Opened from a remote machine / different origin:** set
  `BASE = "https://birdnet.example.com"`. Note the deploy's CORS must allow that
  origin for the `fetch`/`EventSource` calls to succeed.

Open it, and it connects to `/events`, seeds the count from the 24h snapshot, and
paints in each new detection as it's heard.

---

*These are companion surfaces. The frame stays a museum.*
