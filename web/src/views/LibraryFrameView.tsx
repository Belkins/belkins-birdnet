// THE READING PAGE — an ADDITIONAL frame surface, never an alteration of the one
// that already hangs on the wall. The collage rosette, its markup, its CSS and
// its capture path are untouched by this file; App decides when this renders and
// a bare ?frame=1 still shows the rosette exactly as it does today (owner
// decision 1, 2026-07-27).
//
// WHY IT EXISTS: an 1838 sentence is the only content in this entire museum that
// renders PERFECTLY on a 1-bit e-ink panel — pure text, no cutout, no glow, no
// dither, no anti-aliased gradient to band. So this surface is exactly four
// things and nothing else: one passage, its citation, the species' common name,
// and the date it was last heard in the garden. No spectrogram (an image built
// from a gradient is the one thing 1-bit cannot hold), no play control (a
// photograph of a page has no controls), no animation, no transition, no hover.
//
// It rotates DAILY, deterministically by day-of-year over the same committed
// JSON — one thing all day, something new tomorrow. No cron, no storage, no
// model, no fetch beyond the two the museum already makes. Deliberately NOT
// live-driven: a panel whose page could change at any detection would burn a
// ~35s full refresh on a whim, and "one thing all day" is the design.
//
// THE E-INK CONTRACT is profile.ts's, honoured verbatim and not re-invented:
// `?surface=eink` (which already implies spectra6 / motion off / portrait), and
// `markFrameReady()` — the same readiness signal the collage capture waits on.
// The frame is pointed here with `?surface=eink&tab=library`; the ?tab= param is
// narrowed by App's asTab(), which stays the only gate that reads it.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogSpecies } from '../catalog';
import { fetchCatalog } from '../catalog';
import type { Jardine, JardinePassage, JardineSpecies } from '../jardine';
import { dayOfYear, fetchJardine, heardHere, sicSpans, volumeRoman } from '../jardine';
import type { RosterRow } from '../types';
import { parseCatalogDate } from '../almanac';
import { markFrameReady, PROFILE } from '../profile';
import './LibraryFrameView.css';

/** Longest we ever wait on webfonts before photographing the page. The frame Pi
 *  may have no route to the Google Fonts CDN; a page set in the Georgia fallback
 *  is a worse photograph than a late one, but a capture that never returns is
 *  worse than both. */
const FONT_WAIT_MS = 4000;

/** Day-of-year in the panel's own local calendar, differenced in UTC so a DST
 *  boundary can never skip or repeat a page. */

/** "24 July 2026" from a catalog stamp, via the tree's ONE date parser
 *  (almanac.ts) — never a second one, and never `new Date(iso)`, which cannot
 *  portably read the prod 'YYYY-MM-DD HH:MM:SS' form. en-GB because the garden
 *  is in London and the page is a British book. */
function heardOnLabel(iso: string | null): string | null {
  const p = parseCatalogDate(iso);
  if (!p) return null;
  const d = new Date(p.y, p.m - 1, p.d);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}


/** Split a verbatim passage around its recorded OCR artefacts so each one can
 *  carry a visible [sic]. Owner decision 3: the artefacts are the proof nothing
 *  was cleaned up by a model, so they are preserved and MARKED — never silently
 *  corrected, and never quietly passed off as Jardine's own spelling. */

interface Page {
  passage: JardinePassage;
  /** Jardine's own heading ("The Robin, or Redbreast"); null on the epigraph. */
  title: string | null;
  /** The garden's name for the bird — null when this station has never heard it. */
  com: string | null;
  /** "24 July 2026", or null when nothing carries a usable stamp. */
  heardOn: string | null;
}

function hasText(p: JardinePassage | null): p is JardinePassage {
  return p !== null && typeof p.text === 'string' && p.text.trim() !== '';
}

/** THE ROTATION. Deterministic by day-of-year over a NAME-SORTED pool, so the
 *  page depends only on the date — not on JSON order, not on catalog order, not
 *  on which fetch resolved first, and not on anything that could change between
 *  two panel refreshes on the same day. Two pools, in order of honesty:
 *    1. voice-carrying species this garden has actually heard, with a date;
 *    2. (only when the catalog is unreachable or empty) voice-carrying species
 *       with no garden line at all — silence rather than a fabricated date.
 *  Falling through both, the page prints Jardine's own surrender instead, which
 *  is the correct sentence for an empty library rather than an empty state. */
function choosePage(
  doc: Jardine,
  catalog: CatalogSpecies[],
  rows: RosterRow[],
  doy: number,
): Page | null {
  const byName = new Map<string, CatalogSpecies>();
  for (const c of catalog) if (c.sci_name) byName.set(c.sci_name, c);
  // The live roster is a NAME fallback only, for the case where species.json is
  // unreachable but the engine's snapshot is not. It can never pick the page —
  // that would make the surface change mid-day.
  const liveName = new Map<string, string>();
  for (const r of rows) if (r.sci && r.com) liveName.set(r.sci, r.com);

  const voiced: JardineSpecies[] = doc.species
    .filter((s) => hasText(s.voice))
    .sort((a, b) => a.sci_name.localeCompare(b.sci_name));

  const heard: Page[] = [];
  const unheard: Page[] = [];
  for (const s of voiced) {
    if (!hasText(s.voice)) continue; // narrowing; the filter above already proved it
    const c = byName.get(s.sci_name);
    const on = heardOnLabel(c ? c.last_detected : null);
    const com = c ? c.com_name || c.sci_name : (liveName.get(s.sci_name) ?? null);
    const page: Page = { passage: s.voice, title: s.jardine_title || null, com, heardOn: on };
    // THE SHARED AUTHORITY, not a local last_detected test. The frame used to
    // ask only whether a timestamp parsed, so a species with a real tally and a
    // missing stamp printed "not yet heard in this garden" about a bird the Pi
    // HAS recorded — a fabricated absence, on the one surface hanging on a wall.
    if (c && heardHere(c)) heard.push(page);
    else unheard.push(page);
  }

  const pool = heard.length > 0 ? heard : unheard;
  if (pool.length > 0) return pool[((doy % pool.length) + pool.length) % pool.length];

  if (hasText(doc.epigraph)) {
    return { passage: doc.epigraph, title: null, com: null, heardOn: null };
  }
  return null;
}

export function LibraryFrameView(props: {
  /** The live roster for the current period window. Used ONLY as a common-name
   *  fallback when species.json is unreachable — never to select the page. */
  rows?: RosterRow[];
  /** Accepted because App hands it to every LIBRARY surface, and deliberately
   *  NOT read here: on the Reading Desk that filter picks the recency band, but
   *  this is a wall panel that must show one thing all day. */
  windowHours?: number;
}) {
  const rows = props.rows;

  // null = still gathering; the derived Page|null then distinguishes "a page"
  // from "nothing true to print". Never a spinner, never an error state.
  const [data, setData] = useState<{ doc: Jardine; catalog: CatalogSpecies[] } | null>(null);
  const [doy, setDoy] = useState<number>(() => dayOfYear(new Date()));
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);

  useEffect(() => {
    let alive = true;
    void Promise.all([fetchJardine(), fetchCatalog()]).then(([doc, catalog]) => {
      if (alive) setData({ doc, catalog });
    });
    return () => {
      alive = false;
    };
  }, []);

  // A panel left running for weeks must still turn its page at midnight. This is
  // the only timer on the surface and it moves nothing: it re-reads the calendar
  // once a minute and re-renders ONLY on the day the number changes.
  useEffect(() => {
    const id = window.setInterval(() => {
      const d = dayOfYear(new Date());
      setDoy((prev) => (prev === d ? prev : d));
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);

  // undefined = still gathering, null = nothing true to print, Page = the page.
  const page = useMemo(
    () => (data ? choosePage(data.doc, data.catalog, rows ?? [], doy) : undefined),
    [data, rows, doy],
  );

  // READINESS, PART 1 — while this page is the surface being photographed, it
  // owns the signal. App wires markFrameReady() to the collage engine, which
  // settles on its own schedule behind this surface; without this guard the
  // capture could photograph a blank page the moment the rosette finished
  // painting. Re-clearing inside the observer is self-terminating (the second
  // mutation finds nothing left to remove).
  useEffect(() => {
    if (ready) return;
    const html = document.documentElement;
    const clear = () => {
      if (readyRef.current) return;
      window.__frameReady = false;
      if (html.hasAttribute('data-frame-ready')) html.removeAttribute('data-frame-ready');
    };
    clear();
    const mo = new MutationObserver(clear);
    mo.observe(html, { attributes: true, attributeFilter: ['data-frame-ready'] });
    return () => mo.disconnect();
  }, [ready]);

  // READINESS, PART 2 — settled means: the data resolved (a page, or an honest
  // silence), the webfonts decoded, and two frames have been painted. Then the
  // exact signal profile.ts documents, and no other. It fires even when there is
  // nothing to print: a capture that hangs forever is the one failure mode a
  // wall panel cannot recover from on its own.
  useEffect(() => {
    if (page === undefined || readyRef.current) return;
    let cancelled = false;

    const settle = async () => {
      const fonts: FontFaceSet | undefined = document.fonts;
      try {
        await Promise.race<unknown>([
          fonts ? fonts.ready : Promise.resolve(),
          new Promise((res) => window.setTimeout(res, FONT_WAIT_MS)),
        ]);
      } catch {
        /* a rejected FontFaceSet is still a page worth photographing */
      }
      if (cancelled) return;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (cancelled || readyRef.current) return;
          readyRef.current = true;
          markFrameReady();
          setReady(true);
        });
      });
    };
    void settle();

    return () => {
      cancelled = true;
    };
  }, [page]);

  const vol = page ? volumeRoman(page.passage.volume) : '';
  const cite = page
    ? [vol ? `Vol. ${vol}` : '', page.passage.volume_title].filter((s) => s !== '').join(' · ')
    : '';

  return (
    <div className="lfr" data-surface={PROFILE.surface} data-palette={PROFILE.palette}>
      <header className="lfr-head">the naturalist&rsquo;s library · edinburgh 1833–1843</header>

      {page === undefined ? (
        // Gathering. Deliberately blank — a photograph of a page has no spinner,
        // and the readiness signal is being withheld until there is something.
        <div className="lfr-page-gap" aria-hidden="true" />
      ) : page === null ? (
        <div className="lfr-silent">the library is silent</div>
      ) : (
        <article className="lfr-page">
          {page.title && <div className="lfr-title">{page.title}</div>}
          <p className="lfr-passage prose-nums">
            {sicSpans(page.passage.text, page.passage.sic).map((s, i) =>
              s.sic ? (
                <span key={i} title={s.sic.note || 'as printed'}>
                  {s.text}
                  <span className="lfr-sic">[sic]</span>
                </span>
              ) : (
                <span key={i}>{s.text}</span>
              ),
            )}
          </p>
          <div className="lfr-rule" />
          {page.passage.speaker !== '' && <div className="lfr-by">{page.passage.speaker}</div>}
          {cite !== '' && <div className="lfr-cite">{cite}</div>}
        </article>
      )}

      <footer className="lfr-garden">
        {page && page.com && (
          <>
            <span className="lfr-com">{page.com}</span>
            <span className="lfr-sep" aria-hidden="true">
              ·
            </span>
            {page.heardOn ? (
              <span className="lfr-heard">last heard {page.heardOn}</span>
            ) : (
              <span className="lfr-unheard">not yet heard in this garden</span>
            )}
          </>
        )}
      </footer>
    </div>
  );
}
