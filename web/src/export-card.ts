// The ONE plate-export engine.
//
// Five earlier proposals each wanted their own image renderer (share card,
// keepsake, OG image, the weekly recap sheet, a certificate). This is that one
// engine: it paints a museum specimen CARD for a single species onto a canvas
// using the SAME seat-ink + contain-fit specimen draw as the live wall
// (plate.ts), so an exported card can never drift from the frame. The recap
// sheet (recap route) composes several of these; a "Save plate" button turns one
// into a PNG the visitor can keep or share.
//
// Honesty firewall: this renders ONLY fields the caller passes as real, computed
// values (accession, detection count, first-heard date, a rarity LABEL derived
// from real local frequency). It never invents a number. A field left null is
// simply not drawn — silence, never a guess.

import { paintSpecimen, paintVignette } from './plate';
import { birdImageUrl } from './img';

/** A single species' card content — every stat is a real, caller-supplied value
 *  (or null → not drawn). No field here is ever synthesized inside the engine. */
export interface PlateCardSpec {
  slug: string;
  sci: string;
  com: string;
  pose?: 1 | 2;
  /** museum accession integer (pinned, permanent) or null. */
  accession?: number | null;
  /** all-time real detection count or null. */
  detectionCount?: number | null;
  /** ISO date of the first confident detection, or null. */
  firstConfident?: string | null;
  /** an honest rarity LABEL computed upstream from real local frequency. */
  rarityLabel?: string | null;
  /** Conservator's Mark for the plate ('attested' | 'caveat') or null/absent.
   *  The unexamined state and bundled plates stamp NOTHING — the card never
   *  invents a seal (same honesty rule as the popup). */
  attest?: 'attested' | 'caveat' | null;
  /** 'day' = a cream print (default, for sharing); 'night' = obsidian. */
  theme?: 'day' | 'night';
}

/** Portrait card at a social-friendly 4:5 (1080×1350). */
const CARD_W = 1080;
const CARD_H = 1350;

interface Palette {
  ground: string;
  ink: string;
  faint: string;
  rule: string;
}

const PALETTES: Record<'day' | 'night', Palette> = {
  day: { ground: '#f3ecdb', ink: '#2a2016', faint: 'rgba(42,32,22,0.55)', rule: 'rgba(42,32,22,0.22)' },
  night: { ground: '#0b0a0e', ink: '#efe6cf', faint: 'rgba(239,230,207,0.52)', rule: 'rgba(239,230,207,0.14)' },
};

/** Draw an uppercase, letter-spaced mono label (the museum's caption register).
 *  Resets letterSpacing after so it never bleeds into subsequent draws. */
function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, px: number, color: string, align: CanvasTextAlign = 'left'): void {
  ctx.font = `500 ${px}px "Space Mono", ui-monospace, monospace`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  const anyCtx = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  const prev = anyCtx.letterSpacing;
  anyCtx.letterSpacing = `${Math.round(px * 0.18)}px`;
  ctx.fillText(text.toUpperCase(), x, y);
  anyCtx.letterSpacing = prev ?? '0px';
}

/** Decode one image; resolves null on error so a missing cutout degrades to the
 *  wordmark-only card (never throws, never a broken card). cutout.php is
 *  same-origin, so the canvas stays untainted and toBlob() works. */
function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Wait for the editorial webfonts if the browser exposes the Font Loading API,
 *  so a card never rasterizes in a fallback face. Best-effort — resolves anyway. */
async function fontsReady(): Promise<void> {
  try {
    const f = (document as unknown as { fonts?: { ready?: Promise<unknown> } }).fonts;
    if (f?.ready) await f.ready;
  } catch {
    /* Font Loading API unavailable — proceed with whatever is loaded. */
  }
}

/** Render the card onto a fresh detached <canvas> (main thread → document fonts)
 *  and return it. Exported so the recap route can tile several onto a sheet. */
export async function renderPlateCard(spec: PlateCardSpec): Promise<HTMLCanvasElement> {
  await fontsReady();
  const theme = spec.theme ?? 'day';
  const pal = PALETTES[theme];
  const night = theme === 'night';

  const canvas = document.createElement('canvas');
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas2D not supported');

  // Ground + a hairline museum frame inset from the edge.
  ctx.fillStyle = pal.ground;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  const inset = 46;
  ctx.strokeStyle = pal.rule;
  ctx.lineWidth = 2;
  ctx.strokeRect(inset, inset, CARD_W - inset * 2, CARD_H - inset * 2);

  // Specimen stage: the upper region. A seating vignette pool, then the cutout
  // contain-fit + unified seat ink — identical treatment to the wall.
  const stage = { x: inset + 40, y: inset + 70, w: CARD_W - (inset + 40) * 2, h: 760 };
  const cx = stage.x + stage.w / 2;
  const cy = stage.y + stage.h / 2;
  paintVignette(ctx, CARD_W, CARD_H, cx, cy, stage.w * 0.5, night, 0, false);

  const url = birdImageUrl(spec.slug, spec.sci, spec.pose ?? 1);
  const img = url ? await loadImage(url) : null;
  if (img && img.naturalWidth > 0) {
    // Fit the specimen box to the image aspect within the stage, then let
    // paintSpecimen contain-fit + seat it (the same call the wall makes).
    const ar = img.naturalWidth / img.naturalHeight;
    let bw = stage.w;
    let bh = bw / ar;
    if (bh > stage.h) {
      bh = stage.h;
      bw = bh * ar;
    }
    const bx = cx - bw / 2;
    const by = cy - bh / 2;
    paintSpecimen(ctx, img, img.naturalWidth, img.naturalHeight, bx, by, bw, bh, night, 0, false);
  }

  // Accession tag, museum-style, top-right inside the frame.
  if (spec.accession != null) {
    ctx.fillStyle = pal.faint;
    ctx.font = '500 26px "Space Mono", ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(`No. ${String(spec.accession).padStart(3, '0')}`, CARD_W - inset - 26, inset + 22);
  }

  // Caption block, lower third.
  const capX = inset + 44;
  let capY = stage.y + stage.h + 66;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = pal.ink;
  ctx.font = '700 62px "Archivo", "Space Grotesk", system-ui, sans-serif';
  ctx.fillText(spec.com, capX, capY);
  capY += 46;

  ctx.fillStyle = pal.faint;
  ctx.font = 'italic 500 36px "Cormorant Garamond", Georgia, serif';
  ctx.fillText(spec.sci, capX, capY);
  capY += 40;

  // Thin rule under the name.
  ctx.strokeStyle = pal.rule;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(capX, capY);
  ctx.lineTo(CARD_W - inset - 44, capY);
  ctx.stroke();
  capY += 46;

  // Honest stat line — only the real fields that were supplied.
  const stats: string[] = [];
  if (spec.detectionCount != null) {
    stats.push(`Heard ${spec.detectionCount.toLocaleString()} ${spec.detectionCount === 1 ? 'time' : 'times'}`);
  }
  if (spec.firstConfident) stats.push(`first heard ${spec.firstConfident}`);
  if (spec.rarityLabel) stats.push(spec.rarityLabel);
  if (stats.length) {
    ctx.fillStyle = pal.faint;
    ctx.font = '500 27px "Space Grotesk", system-ui, sans-serif';
    ctx.fillText(stats.join('   ·   '), capX, capY);
  }

  // Conservator's Mark: a small vermilion hanko + verdict on its own line.
  // Only the two POSITIVE verdicts stamp; unexamined/bundled stamp nothing.
  if (spec.attest === 'attested' || spec.attest === 'caveat') {
    capY += 44;
    const seal = 13;
    ctx.save();
    ctx.translate(capX + seal / 2, capY - seal / 2 - 4);
    ctx.rotate(Math.PI / 4);
    if (spec.attest === 'attested') {
      ctx.fillStyle = '#c73e2e';
      ctx.fillRect(-seal / 2, -seal / 2, seal, seal);
    } else {
      ctx.strokeStyle = '#c73e2e';
      ctx.lineWidth = 2;
      ctx.strokeRect(-seal / 2, -seal / 2, seal, seal);
    }
    ctx.restore();
    ctx.fillStyle = pal.faint;
    ctx.font = '500 24px "Space Mono", ui-monospace, monospace';
    ctx.fillText(
      spec.attest === 'attested' ? 'CONSERVATOR-ATTESTED' : 'ATTESTED · WITH CAVEAT',
      capX + seal + 14, capY,
    );
  }

  // Colophon, bottom rail.
  ctx.fillStyle = pal.faint;
  ctx.font = '600 22px "Space Mono", ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillText('BELKINS BIRDNET', capX, CARD_H - inset - 30);
  ctx.textAlign = 'right';
  ctx.fillText('LIVING GALLERY', CARD_W - inset - 44, CARD_H - inset - 30);

  return canvas;
}

// ── the weekly RECAP sheet — the flagship artifact ────────────────────────────
//
// One washi "acquisitions" sheet composed from the week's real visitors, on the
// same paint engine as the wall. This is the pull artifact (no push, no streak)
// that the swarm named the single huge unlock; the /recap route renders it and
// the weekly digest links to it.

export interface SheetSpec extends PlateCardSpec {
  /** first heard within the recap window → gets a NEW tag (real, from the data). */
  isNew?: boolean;
}

export interface SheetMeta {
  title: string;
  dateline: string;
  /** an honest one-line "warden's log" caption (facts only, never invented). */
  log?: string;
}

const SHEET_W = 1200;
const SHEET_PAD = 56;

/** Compose the week's specimens onto a single tall cream sheet and return the
 *  canvas. Cells contain-fit each cutout under the unified seat ink (identical to
 *  the wall) with an honest caption. A missing cutout falls back to a name-only
 *  cell. Nothing here is fabricated — every stat comes from the caller. */
export async function composeWeeklySheet(
  specs: SheetSpec[],
  meta: SheetMeta,
  theme: 'day' | 'night' = 'day',
): Promise<HTMLCanvasElement> {
  await fontsReady();
  const pal = PALETTES[theme];
  const night = theme === 'night';

  const cols = specs.length <= 1 ? 1 : specs.length <= 4 ? 2 : 3;
  const cellW = (SHEET_W - SHEET_PAD * 2) / cols;
  const cellH = 330;
  const rows = Math.max(1, Math.ceil(specs.length / cols));
  const headerH = 220;
  const footerH = 90;
  const height = headerH + rows * cellH + footerH;

  const canvas = document.createElement('canvas');
  canvas.width = SHEET_W;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas2D not supported');

  ctx.fillStyle = pal.ground;
  ctx.fillRect(0, 0, SHEET_W, height);
  const inset = 34;
  ctx.strokeStyle = pal.rule;
  ctx.lineWidth = 2;
  ctx.strokeRect(inset, inset, SHEET_W - inset * 2, height - inset * 2);

  // Header band.
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = pal.faint;
  ctx.font = '600 22px "Space Mono", ui-monospace, monospace';
  ctx.fillText(meta.dateline.toUpperCase(), SHEET_PAD, 108);
  ctx.fillStyle = pal.ink;
  ctx.font = '800 66px "Archivo", "Space Grotesk", system-ui, sans-serif';
  ctx.fillText(meta.title, SHEET_PAD, 168);
  if (meta.log) {
    ctx.fillStyle = pal.faint;
    ctx.font = 'italic 500 28px "Cormorant Garamond", Georgia, serif';
    ctx.fillText(meta.log, SHEET_PAD, 200);
  }

  // Cells.
  const urls = specs.map((s) => birdImageUrl(s.slug, s.sci, s.pose ?? 1));
  const imgs = await Promise.all(urls.map((u) => (u ? loadImage(u) : Promise.resolve(null))));

  specs.forEach((s, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x0 = SHEET_PAD + col * cellW;
    const y0 = headerH + row * cellH;
    const stageH = cellH - 96;
    const cx = x0 + cellW / 2;
    const cy = y0 + stageH / 2;

    paintVignette(ctx, SHEET_W, height, cx, cy, Math.min(cellW, stageH) * 0.5, night, 0, false);
    const img = imgs[i];
    if (img && img.naturalWidth > 0) {
      const ar = img.naturalWidth / img.naturalHeight;
      let bw = cellW - 60;
      let bh = bw / ar;
      if (bh > stageH - 20) {
        bh = stageH - 20;
        bw = bh * ar;
      }
      paintSpecimen(ctx, img, img.naturalWidth, img.naturalHeight, cx - bw / 2, cy - bh / 2, bw, bh, night, 0, false);
    }

    // NEW tag (real: first heard this window).
    if (s.isNew) {
      ctx.fillStyle = pal.ink;
      ctx.font = '700 15px "Space Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText('◆ NEW', x0 + 8, y0 + 22);
    }

    // Caption block under the specimen.
    const capY = y0 + stageH + 26;
    ctx.textAlign = 'center';
    ctx.fillStyle = pal.ink;
    ctx.font = '700 26px "Archivo", "Space Grotesk", system-ui, sans-serif';
    ctx.fillText(fit(ctx, s.com, cellW - 40), cx, capY);
    ctx.fillStyle = pal.faint;
    ctx.font = 'italic 500 20px "Cormorant Garamond", Georgia, serif';
    ctx.fillText(fit(ctx, s.sci, cellW - 40), cx, capY + 28);
    const bits: string[] = [];
    if (s.accession != null) bits.push(`No. ${String(s.accession).padStart(3, '0')}`);
    if (s.detectionCount != null) bits.push(`${s.detectionCount.toLocaleString()}×`);
    if (bits.length) {
      ctx.font = '500 18px "Space Mono", monospace';
      ctx.fillText(bits.join('  ·  '), cx, capY + 54);
    }
  });

  // Colophon.
  ctx.textAlign = 'left';
  ctx.fillStyle = pal.faint;
  ctx.font = '600 20px "Space Mono", monospace';
  ctx.fillText('BELKINS BIRDNET', SHEET_PAD, height - 54);
  ctx.textAlign = 'right';
  ctx.fillText('LIVING GALLERY', SHEET_W - SHEET_PAD, height - 54);

  return canvas;
}

// ── the YEAR-IN-REVIEW sheet (/wrapped) ───────────────────────────────────────

export interface YearStat {
  label: string;
  value: string;
}

/** Compose a "year in review" poster: a big stat column over a row of highlight
 *  plates, on the same paint engine. Every stat is a real caller-supplied value.
 *  Returns the canvas (the /wrapped route shows it + a Save button). */
export async function composeYearSheet(
  year: number,
  stats: YearStat[],
  highlights: SheetSpec[],
  theme: 'day' | 'night' = 'night',
): Promise<HTMLCanvasElement> {
  await fontsReady();
  const pal = PALETTES[theme];
  const night = theme === 'night';
  const cx0 = SHEET_W / 2;

  const hasPlates = highlights.length > 0;
  const headerH = 260;
  const plateRowH = hasPlates ? 320 : 40;
  const ledgerH = 220;
  const footerH = 90;
  const height = headerH + plateRowH + ledgerH + footerH;

  const canvas = document.createElement('canvas');
  canvas.width = SHEET_W;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas2D not supported');

  ctx.fillStyle = pal.ground;
  ctx.fillRect(0, 0, SHEET_W, height);
  // A subtle warm pool lifts the composition off the obsidian (the frame's seat).
  paintVignette(ctx, SHEET_W, height, cx0, height * 0.34, SHEET_W * 0.5, night, 0, night);
  const inset = 30;
  ctx.strokeStyle = pal.rule;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(inset, inset, SHEET_W - inset * 2, height - inset * 2);

  // Masthead — centred, mono eyebrow over a Cormorant title.
  ctx.textBaseline = 'alphabetic';
  label(ctx, `The Yard · ${year}`, cx0, 128, 22, pal.faint, 'center');
  ctx.fillStyle = pal.ink;
  ctx.font = '500 82px "Cormorant Garamond", Georgia, serif';
  ctx.textAlign = 'center';
  ctx.fillText('Year in Review', cx0, 208);

  // Specimen row — luminous acquisitions (or the most-heard) on the dark.
  const rowMidY = headerH + (hasPlates ? 150 : 20);
  if (hasPlates) {
    const n = Math.min(highlights.length, 5);
    const cellW = (SHEET_W - SHEET_PAD * 2) / n;
    const urls = highlights.slice(0, n).map((s) => birdImageUrl(s.slug, s.sci, s.pose ?? 1));
    const imgs = await Promise.all(urls.map((u) => (u ? loadImage(u) : Promise.resolve(null))));
    highlights.slice(0, n).forEach((s, i) => {
      const cx = SHEET_PAD + i * cellW + cellW / 2;
      const img = imgs[i];
      if (img && img.naturalWidth > 0) {
        const ar = img.naturalWidth / img.naturalHeight;
        let bw = cellW - 46;
        let bh = bw / ar;
        if (bh > 200) {
          bh = 200;
          bw = bh * ar;
        }
        paintSpecimen(ctx, img, img.naturalWidth, img.naturalHeight, cx - bw / 2, rowMidY - bh / 2, bw, bh, night, 0, false);
      }
      ctx.fillStyle = pal.faint;
      ctx.font = 'italic 500 22px "Cormorant Garamond", Georgia, serif';
      ctx.textAlign = 'center';
      ctx.fillText(fit(ctx, s.com, cellW - 20), cx, rowMidY + 138);
    });
  }

  // Editorial ledger — three big Cormorant figures with mono labels.
  const ledgerY = headerH + plateRowH + 96;
  const cols = Math.max(1, stats.length);
  stats.forEach((s, i) => {
    const cx = SHEET_PAD + ((i + 0.5) * (SHEET_W - SHEET_PAD * 2)) / cols;
    ctx.fillStyle = pal.ink;
    ctx.font = '500 84px "Cormorant Garamond", Georgia, serif';
    ctx.textAlign = 'center';
    ctx.fillText(s.value, cx, ledgerY);
    label(ctx, s.label, cx, ledgerY + 42, 15, pal.faint, 'center');
  });

  // Colophon.
  label(ctx, 'Belkins BirdNET', SHEET_PAD, height - 52, 18, pal.faint, 'left');
  label(ctx, 'Living Gallery', SHEET_W - SHEET_PAD, height - 52, 18, pal.faint, 'right');

  return canvas;
}

/** Truncate a label to fit `maxW` at the current font, adding an ellipsis. */
function fit(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

/** Render a card and return it as a PNG Blob (null if the browser can't encode). */
export async function exportPlateCardBlob(spec: PlateCardSpec): Promise<Blob | null> {
  const canvas = await renderPlateCard(spec);
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/png');
  });
}

/** Convenience: trigger a browser download of a species' card. */
export async function downloadPlateCard(spec: PlateCardSpec): Promise<void> {
  const blob = await exportPlateCardBlob(spec);
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${spec.slug}-plate.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
