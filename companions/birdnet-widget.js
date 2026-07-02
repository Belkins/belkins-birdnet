// ─────────────────────────────────────────────────────────────────────────
// Belkins BirdNET — iOS home-screen widget (Scriptable)
//
// A tiny glanceable companion to the museum frame. It reads the SAME public
// endpoints the collage does — no backend, no build, no App Store. It shows:
//   • the newest lifer (the most recently accessioned species on your wall)
//   • how many species have been heard in the last 24 hours
//   • when it last checked in
// If the deploy can't be reached it says so — it never invents a number.
//
// ── INSTALL ───────────────────────────────────────────────────────────────
//   1. Install "Scriptable" from the App Store (free).
//   2. Open Scriptable → tap ＋ → paste this whole file in → name it
//      "Belkins BirdNET".
//   3. Set BASE below to YOUR deployment origin (see next line).
//   4. Long-press your home screen → ＋ → Scriptable → pick a Small or Medium
//      widget → long-press it → "Edit Widget" → Script: "Belkins BirdNET".
//
// ── CONFIG ────────────────────────────────────────────────────────────────
// BASE is the origin your BirdNET is served from — the part before /collage.
// Local Pi example:   "http://birdnet.local"
// Remote deploy:      "https://birdnet.yourdomain.com"
// (No trailing slash.)
const BASE = "https://birdnet.example.com"; // ← CHANGE ME

// Endpoints derived from BASE (grounded on web/src/config.ts + img.ts):
//   catalog  →  <BASE>/collage/species.json      (all-time life-list)
//   snapshot →  <BASE>/avian/api/birdnet-api.php?action=recent&hours=24
//   cutout   →  <BASE>/avian/api/cutout.php?sci=<sci>&pose=1
const CATALOG_URL = `${BASE}/collage/species.json`;
const SNAPSHOT_URL = `${BASE}/avian/api/birdnet-api.php?action=recent&hours=24`;
const cutoutUrl = (sci) =>
  `${BASE}/avian/api/cutout.php?sci=${encodeURIComponent(sci)}&pose=1`;

// ── Palette (echoes the cream museum frame) ───────────────────────────────
const CREAM = new Color("#f5efe1");
const CREAM_2 = new Color("#efe7d5");
const INK = new Color("#2a2016");
const MUT = new Color("#8a7d68");
const LIVE = new Color("#3f9d4a");
const OFFLINE = new Color("#c44a3b");

// ── Fetch helpers (robust: every network call degrades to null) ───────────
async function getJSON(url) {
  try {
    const req = new Request(url);
    req.timeoutInterval = 12;
    return await req.loadJSON();
  } catch (e) {
    return null;
  }
}

// Newest lifer = the highest accession number (accession order == the order
// species were first confidently added to the wall). Fallback: the latest
// first_confident date. Rows with a null accession are "heard but not yet a
// confirmed lifer" — they can't be the newest lifer, so we skip them.
function pickNewestLifer(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const accessioned = rows.filter((r) => typeof r.accession === "number");
  if (accessioned.length) {
    return accessioned.reduce((a, b) => (b.accession > a.accession ? b : a));
  }
  const dated = rows.filter((r) => r.first_confident);
  if (!dated.length) return null;
  return dated.reduce((a, b) => (b.first_confident > a.first_confident ? b : a));
}

async function loadCatalog() {
  const rows = await getJSON(CATALOG_URL);
  if (!Array.isArray(rows)) return null;
  return { newest: pickNewestLifer(rows), total: rows.length };
}

async function loadSnapshot() {
  const json = await getJSON(SNAPSHOT_URL);
  if (!json) return null;
  const species = Array.isArray(json.species) ? json.species : [];
  return { count: species.length, asOf: json.as_of || null };
}

async function loadCutout(sci) {
  try {
    return await new Request(cutoutUrl(sci)).loadImage();
  } catch (e) {
    return null; // silhouette-less: the widget simply omits the image
  }
}

function shortTime(date) {
  const df = new DateFormatter();
  df.useNoDateStyle();
  df.useShortTimeStyle();
  return df.string(date);
}

// ── Widget builders ───────────────────────────────────────────────────────
function header(w) {
  const row = w.addStack();
  row.centerAlignContent();
  const mark = row.addText("BELKINS BIRDNET");
  mark.font = new Font("Archivo-Bold", 9);
  mark.textColor = MUT;
  mark.lineLimit = 1;
  return row;
}

function statusLine(w, online, stampText) {
  const row = w.addStack();
  row.centerAlignContent();
  const dot = row.addText("●");
  dot.font = Font.systemFont(7);
  dot.textColor = online ? LIVE : OFFLINE;
  row.addSpacer(5);
  const label = row.addText(online ? stampText : "— offline —");
  label.font = new Font("Menlo", 9);
  label.textColor = MUT;
  label.lineLimit = 1;
}

function bigStat(container, value, caption) {
  const stack = container.addStack();
  stack.layoutVertically();
  const v = stack.addText(value);
  v.font = new Font("Georgia", 30); // editorial serif, echoing Cormorant
  v.textColor = INK;
  v.lineLimit = 1;
  const c = stack.addText(caption);
  c.font = new Font("Menlo", 9);
  c.textColor = MUT;
  c.lineLimit = 1;
}

async function buildWidget() {
  const family = config.widgetFamily || "small";
  const medium = family === "medium" || family === "large";

  const [catalog, snap] = await Promise.all([loadCatalog(), loadSnapshot()]);

  const w = new ListWidget();
  const bg = new LinearGradient();
  bg.colors = [CREAM, CREAM_2];
  bg.locations = [0, 1];
  w.backgroundGradient = bg;
  w.setPadding(14, 16, 14, 16);
  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000); // ~15 min hint

  header(w);
  w.addSpacer(medium ? 8 : 6);

  // Two columns on medium: text left, newest-lifer cutout right.
  const body = w.addStack();
  body.topAlignContent();
  const left = body.addStack();
  left.layoutVertically();

  // Newest lifer — HONEST: shows "—" when the catalog can't be read.
  const lifer = catalog && catalog.newest ? catalog.newest : null;
  const liferLabel = left.addText("NEWEST LIFER");
  liferLabel.font = new Font("Menlo", 8);
  liferLabel.textColor = MUT;
  left.addSpacer(2);
  const liferName = left.addText(lifer ? lifer.com_name : "—");
  liferName.font = new Font("Georgia", medium ? 19 : 16);
  liferName.textColor = INK;
  liferName.lineLimit = 2;
  liferName.minimumScaleFactor = 0.7;
  if (lifer && typeof lifer.accession === "number") {
    const acc = left.addText(`№ ${lifer.accession} on the wall`);
    acc.font = new Font("Menlo", 9);
    acc.textColor = MUT;
  }

  left.addSpacer(medium ? 12 : 8);

  // Window species count — HONEST: "—" when the snapshot can't be read.
  bigStat(
    left,
    snap ? String(snap.count) : "—",
    snap ? "species · last 24h" : "count unavailable",
  );

  // Optional cutout of the newest lifer on the right (medium+).
  if (medium && lifer && lifer.sci_name) {
    body.addSpacer();
    const img = await loadCutout(lifer.sci_name);
    if (img) {
      const holder = body.addStack();
      holder.size = new Size(74, 74);
      const iv = holder.addImage(img);
      iv.imageSize = new Size(74, 74);
      iv.containerRelativeShape = false;
    }
  }

  w.addSpacer();

  // Footer status: online + last-checked stamp, or an honest offline line.
  const online = Boolean(catalog || snap);
  const stamp = snap && snap.asOf ? `as of ${snap.asOf}` : `checked ${shortTime(new Date())}`;
  statusLine(w, online, stamp);

  return w;
}

// ── Run ───────────────────────────────────────────────────────────────────
const widget = await buildWidget();
if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  // Tapped inside Scriptable: preview at the size you'll use on the home screen.
  await widget.presentMedium();
}
Script.complete();
