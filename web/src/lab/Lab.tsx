// THE LAB — the data-dense COMPANION console that the calm museum frame refuses
// to be. This is where "more dashboards" lives: raw live feed, the full life
// list, and the honest DERIVED intelligence (local rarity, co-occurrence, waking
// line, first-of-year) from the derive.py single-writer. It is deliberately NOT
// the museum — monospace, tabular, terminal-cool — and it reuses the EXACT same
// endpoints (SSE + species.json + derived.json), adding no backend.
//
// Honesty firewall holds here too: every number is a real read; co-occurrence is
// labelled "heard in the same window", never "these birds associate"; local
// rarity is LOCAL encounter frequency, never conservation status; a missing
// derived.json degrades each panel to a calm "not built yet" note.
import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { fetchCatalog, type CatalogSpecies } from '../catalog';
import { SseStream, MockStream } from '../events';
import { BASE, DERIVED_URL, EVENTS_URL, MOCK } from '../config';
import type { BirdEvent, EventStream, LiveState } from '../types';
import { fetchJardine, sealLine, type Jardine } from '../jardine';

// ── derived.json shape (the derive.py single-writer output). Read defensively:
// the file is absent until derive.py runs, and field access is tolerant so a
// small schema drift degrades a cell, never the page. ──────────────────────────
interface RarityRow {
  slug: string;
  com_name?: string | null;
  sci_name?: string;
  days_heard: number;
  encounter_frac: number;
  encounter_label: string;
}
interface CoocRow {
  a_com?: string | null;
  b_com?: string | null;
  a_slug?: string;
  b_slug?: string;
  jaccard: number;
  lift: number;
  pair_bins: number;
}
interface WakingRow {
  date: string;
  first_time: string;
}
interface FoyRow {
  slug: string;
  com_name?: string | null;
  sci_name?: string;
  first_confident: string;
}
interface Derived {
  built_at?: string;
  station_days?: number;
  source_rows?: number;
  local_rarity?: RarityRow[];
  co_occurrence?: CoocRow[];
  waking_line?: WakingRow[];
  first_of_year?: FoyRow[];
}

interface FeedRow {
  key: string;
  sci: string;
  com: string;
  conf: number;
  time: string;
}

const DOT: Record<LiveState, string> = {
  connecting: 'connecting',
  live: 'live',
  idle: 'idle',
  reconnecting: 'reconnecting',
  offline: 'offline',
};

/** Percent from a 0..1 fraction, one decimal — a plain honest read. */
function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export function Lab(): JSX.Element {
  const [cat, setCat] = useState<CatalogSpecies[]>([]);
  const [derived, setDerived] = useState<Derived | null>(null);
  const [derivedMissing, setDerivedMissing] = useState(false);
  const [feed, setFeed] = useState<FeedRow[]>([]);
  const [live, setLive] = useState<LiveState>('connecting');

  // Life list + derived bundle, once at mount. Both degrade to a calm empty
  // state — fetchCatalog never throws; a missing derived.json flips the note.
  useEffect(() => {
    let alive = true;
    void fetchCatalog().then((rows) => {
      if (alive) setCat(rows);
    });
    void fetch(DERIVED_URL)
      .then((r) => (r.ok ? (r.json() as Promise<Derived>) : Promise.reject(new Error('no derived'))))
      .then((d) => {
        if (alive) setDerived(d);
      })
      .catch(() => {
        if (alive) setDerivedMissing(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Raw live SSE feed — the unfiltered detection stream (mock in dev). Capped so
  // the console never grows unbounded. Same client the wall uses.
  useEffect(() => {
    const stream: EventStream = MOCK ? new MockStream() : new SseStream(EVENTS_URL);
    stream.start({
      onBird: (ev: BirdEvent) => {
        setFeed((f) =>
          [
            {
              key: `${ev.slug}-${ev.cursor}-${ev.time}`,
              sci: ev.sci,
              com: ev.com,
              conf: ev.conf,
              time: ev.time || ev.iso8601?.slice(11, 19) || '',
            },
            ...f,
          ].slice(0, 60),
        );
      },
      onState: (s) => setLive(s),
    });
    return () => stream.stop();
  }, []);

  const byCount = useMemo(
    () => [...cat].sort((a, b) => b.detection_count - a.detection_count),
    [cat],
  );

  // Age of the derived bundle, in whole hours; null when it is fresh, absent,
  // or unparseable-but-recent. `null` means "say nothing".
  //
  // The honesty contract used to be "every reader degrades to silence" — but
  // that only ever covered an ABSENT derived.json. A STALE one is present and
  // schema-valid, so nothing degraded, and this console rendered a 3-day
  // window from 2026-07-02 as current fact for 24 days. built_at was already
  // printed at the top of this file; it was simply never compared to now.
  // Reading a timestamp without comparing it is not provenance, it is decoration.
  const staleHours = useMemo(() => {
    if (!derived?.built_at) return null;
    const built = Date.parse(derived.built_at);
    if (Number.isNaN(built)) return null;
    const hours = Math.floor((Date.now() - built) / 3_600_000);
    // 72h: the bundle rebuilds nightly, so three missed runs is unambiguous.
    return hours > 72 ? hours : null;
  }, [derived]);

  // THE CORPUS CHIP. The Lab is the museum's honesty console — it already flags
  // a stale derived bundle rather than printing a timestamp as decoration. The
  // corpus deserves the same treatment: its sha, when it was extracted, and
  // whether a human has ever signed for the text. sealLine() reads the committed
  // file and nothing else, so this chip cannot claim a proofing that has not
  // happened.
  const [jard, setJard] = useState<Jardine | null>(null);
  useEffect(() => {
    let live = true;
    fetchJardine()
      .then((d) => {
        if (live) setJard(d);
      })
      .catch(() => {
        /* the chip simply never appears */
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="lab">
      <header className="lab-head">
        <div>
          <h1>THE LAB</h1>
          <p className="lab-sub">
            live ops · honest derived intelligence · a companion surface, not the frame
          </p>
        </div>
        <div className={`lab-live lab-live--${live}`}>
          <i /> {DOT[live]}
        </div>
      </header>

      {staleHours != null && (
        <div className="lab-stale" role="status">
          <strong>STALE — {staleHours >= 48
            ? `${Math.floor(staleHours / 24)} days`
            : `${staleHours}h`} old.</strong>{' '}
          Every derived figure below (rarity, co-occurrence, first-of-year, the
          waking line) was computed from a snapshot taken{' '}
          {derived?.built_at?.slice(0, 10)} and has not been recomputed since.
          Treat them as history, not as current. The live feed and the species
          count above are unaffected.
        </div>
      )}

      <div className="lab-meta">
        <span>{cat.length} species catalogued</span>
        {derived?.station_days != null && <span>{derived.station_days} station days</span>}
        {derived?.source_rows != null && <span>{derived.source_rows.toLocaleString()} detections</span>}
        {derived?.built_at && (
          <span className={staleHours != null ? 'lab-stale-chip' : undefined}>
            derived · {derived.built_at.slice(0, 16).replace('T', ' ')}
            {staleHours != null && ` · ${staleHours}h STALE`}
          </span>
        )}
        {jard?.colophon && (
          <span className={sealLine(jard.colophon).includes('unsigned') ? 'lab-stale-chip' : undefined}>
            corpus · {jard.colophon.corpus_sha256.slice(0, 8)} · {jard.colophon.extracted_at} ·{' '}
            {sealLine(jard.colophon)}
          </span>
        )}
        <a className="lab-nav" href={`${BASE}recap.html`}>weekly recap →</a>
        <a className="lab-nav" href={BASE}>museum →</a>
      </div>

      <div className="lab-grid">
        {/* Live raw feed */}
        <section className="lab-panel lab-feed">
          <h2>LIVE FEED</h2>
          {feed.length === 0 ? (
            <p className="lab-empty">listening… no detections yet this session.</p>
          ) : (
            <table>
              <tbody>
                {feed.map((r) => (
                  <tr key={r.key}>
                    <td className="lab-mono">{r.time}</td>
                    <td>{r.com}</td>
                    <td className="lab-dim lab-i">{r.sci}</td>
                    <td className="lab-mono lab-r">{Math.round((r.conf || 0) * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* Local rarity */}
        <section className="lab-panel">
          <h2>LOCAL RARITY</h2>
          <p className="lab-note">
            local ENCOUNTER frequency at this station — days heard ÷ station days. Not conservation
            status.
          </p>
          <DerivedBody missing={derivedMissing} rows={derived?.local_rarity}>
            {(rows: RarityRow[]) => (
              <table>
                <thead>
                  <tr>
                    <th>species</th>
                    <th className="lab-r">days</th>
                    <th className="lab-r">of days</th>
                    <th>band</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 40).map((r) => (
                    <tr key={r.slug}>
                      <td>{r.com_name || r.sci_name || r.slug}</td>
                      <td className="lab-mono lab-r">{r.days_heard}</td>
                      <td className="lab-mono lab-r">{pct(r.encounter_frac)}</td>
                      <td className="lab-dim">{r.encounter_label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </DerivedBody>
        </section>

        {/* Co-occurrence */}
        <section className="lab-panel">
          <h2>CO-OCCURRENCE</h2>
          <p className="lab-note">
            heard in the same 10-min window (min support, ranked by lift). This is co-timing — NOT
            evidence these birds associate.
          </p>
          <DerivedBody missing={derivedMissing} rows={derived?.co_occurrence}>
            {(rows: CoocRow[]) => (
              <table>
                <thead>
                  <tr>
                    <th>pair</th>
                    <th className="lab-r">lift</th>
                    <th className="lab-r">jaccard</th>
                    <th className="lab-r">n</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 40).map((r, i) => (
                    <tr key={`${r.a_slug ?? r.a_com}-${r.b_slug ?? r.b_com}-${i}`}>
                      <td>
                        {(r.a_com || r.a_slug || '?') + ' + ' + (r.b_com || r.b_slug || '?')}
                      </td>
                      <td className="lab-mono lab-r">{r.lift.toFixed(2)}</td>
                      <td className="lab-mono lab-r">{r.jaccard.toFixed(2)}</td>
                      <td className="lab-mono lab-r lab-dim">{r.pair_bins}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </DerivedBody>
        </section>

        {/* Waking line */}
        <section className="lab-panel">
          <h2>WAKING LINE</h2>
          <p className="lab-note">earliest detection per day — the dawn chorus onset, real timestamps.</p>
          <DerivedBody missing={derivedMissing} rows={derived?.waking_line}>
            {(rows: WakingRow[]) => (
              <table>
                <tbody>
                  {rows.slice(0, 30).map((r) => (
                    <tr key={r.date}>
                      <td className="lab-mono">{r.date}</td>
                      <td className="lab-mono lab-r">{r.first_time}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </DerivedBody>
        </section>

        {/* First of year */}
        <section className="lab-panel">
          <h2>FIRST OF YEAR</h2>
          <p className="lab-note">species first confidently heard this calendar year.</p>
          <DerivedBody missing={derivedMissing} rows={derived?.first_of_year}>
            {(rows: FoyRow[]) => (
              <table>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.slug}>
                      <td>{r.com_name || r.sci_name || r.slug}</td>
                      <td className="lab-mono lab-r lab-dim">{r.first_confident}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </DerivedBody>
        </section>

        {/* Life list */}
        <section className="lab-panel lab-list">
          <h2>LIFE LIST</h2>
          <table>
            <thead>
              <tr>
                <th className="lab-r">No.</th>
                <th>species</th>
                <th className="lab-r">count</th>
                <th>first</th>
                <th>last</th>
                <th>art</th>
              </tr>
            </thead>
            <tbody>
              {byCount.map((s) => (
                <tr key={s.slug}>
                  <td className="lab-mono lab-r lab-dim">
                    {s.accession != null ? String(s.accession).padStart(3, '0') : '—'}
                  </td>
                  <td>
                    {s.com_name} <span className="lab-dim lab-i">{s.sci_name}</span>
                  </td>
                  <td className="lab-mono lab-r">{s.detection_count.toLocaleString()}</td>
                  <td className="lab-mono lab-dim">{s.first_confident ?? '—'}</td>
                  <td className="lab-mono lab-dim">{s.last_detected ?? '—'}</td>
                  <td className="lab-dim">{s.art_status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

/** Render a derived-data table body, else a calm reason: the file isn't built
 *  yet, or it built but this section is empty. Never a fabricated placeholder. */
function DerivedBody<T>({
  missing,
  rows,
  children,
}: {
  missing: boolean;
  rows: T[] | undefined;
  children: (rows: T[]) => JSX.Element;
}): JSX.Element {
  if (missing) {
    return <p className="lab-empty">derived.json not built yet — run <code>derive.py</code>.</p>;
  }
  if (!rows) return <p className="lab-empty">loading…</p>;
  if (rows.length === 0) return <p className="lab-empty">nothing to show yet.</p>;
  return children(rows);
}
