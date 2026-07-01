// STATS — detection rhythm as editorial data-art: a by-hour ridge under a
// permanent 24h axis (dawn/noon/dusk) + the by-period / top-species / life-list
// panels, with a life-list hero. Server data loads once on entry (real PHP API,
// or a synthesized mock); top-species stays live. N=0 → a composed gallery
// label, never a wall of dashes.
import { useEffect, useRef, useState } from 'react';
import type { RosterRow } from '../types';
import { loadStats, type StatsData } from '../views-data';
import './StatsView.css';

export function StatsView({ rows }: { rows: RosterRow[] }) {
  const [stats, setStats] = useState<StatsData | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    let alive = true;
    loadStats(rowsRef.current)
      .then((s) => {
        if (alive) setStats(s);
      })
      .catch(() => {
        /* leave stats null → render dashes */
      });
    return () => {
      alive = false;
    };
  }, []);

  const species = rows.length;
  const top = rows.slice(0, 6);
  const byHour = stats?.byHour ?? new Array<number>(24).fill(0);
  const maxHour = Math.max(1, ...byHour);
  const fmt = (n: number | undefined) => (n === undefined ? '—' : n);

  // Left-column framing for the ridge: a title + a peak/volume caption, so the
  // histogram anchors a considered column instead of floating in empty space.
  const dayTotal = byHour.reduce((a, v) => a + v, 0);
  const hasHours = byHour.some((v) => v > 0);
  const peakHour = hasHours ? byHour.indexOf(Math.max(...byHour)) : -1;
  // When the record is younger than a week, WEEK and ALL genuinely coincide —
  // annotate it so identical numbers don't read as a duplicated/broken row.
  const weekEqualsAll =
    stats != null && stats.all.detections > 0 && stats.week.detections === stats.all.detections;

  return (
    <div className="view stats-view">
      <div className="view-mast">
        <div className="eyebrow">your window</div>
        <div className="t">THE RECORD</div>
      </div>
      {species === 0 ? (
        // N=0 (nothing heard yet) — a composed gallery label, not a wall of
        // dashes. Same "listening" register as the collage's N=0 state.
        <div className="stats-empty">
          <div className="word">Listening.</div>
          <div className="rule" />
          <div className="cap">The first bird will appear here.</div>
        </div>
      ) : (
        <div className="stats-grid">
          <div className="stats-hours">
            <div className="sb ridge-head">
              <div className="sh">By Hour</div>
              <div className="ss">detections across the day, last 24h</div>
            </div>
            <div className="ridge">
              {byHour.map((v, h) => (
                <div
                  className="ridge-b"
                  key={h}
                  style={{ height: `${(v / maxHour) * 100}%` }}
                  title={`${h}:00 · ${v}`}
                />
              ))}
            </div>
            {/* permanent hour axis — frames the negative space even all-zero */}
            <div className="ridge-ax">
              <span>0h</span>
              <span>6h</span>
              <span>12h</span>
              <span>18h</span>
              <span>23h</span>
            </div>
            {/* dawn/noon/dusk phase ticks, aligned to hours 6 / 12 / 18 */}
            <div className="ridge-phase">
              <span className="dawn">dawn</span>
              <span className="noon">noon</span>
              <span className="dusk">dusk</span>
            </div>
            {/* quiet caption — balances the column and reads the chart's shape */}
            <div className="ridge-cap">
              {hasHours
                ? `Peak around ${String(peakHour).padStart(2, '0')}:00 · ${dayTotal} today`
                : 'Awaiting today’s first detection'}
            </div>
          </div>
          <div className="stats-panels">
            {/* life-list hero — a serif tally above the ledger */}
            <div className="life-hero">
              <div className="n">
                {species}
                <span className="u"> species</span>
              </div>
              <div className="cap">heard so far</div>
            </div>
            <div className="sb">
              <div className="sh">By Period</div>
              <div className="ss">detections, grouped by recency</div>
              <div className="r">
                <span className="k">NOW</span>
                <span className="v">last hour</span>
                <span className="num">{fmt(stats?.now.detections)}</span>
              </div>
              <div className="r">
                <span className="k">TODAY</span>
                <span className="v">today</span>
                <span className="num">{fmt(stats?.today.detections)}</span>
              </div>
              <div className="r">
                <span className="k">WEEK</span>
                <span className="v">last 7 days</span>
                <span className="num">{fmt(stats?.week.detections)}</span>
              </div>
              <div className="r">
                <span className="k">ALL</span>
                <span className="v">all time</span>
                <span className="num">{fmt(stats?.all.detections)}</span>
              </div>
              {weekEqualsAll && (
                <div className="period-note">
                  the record is younger than a week — 7-day and all-time still coincide
                </div>
              )}
            </div>
            <div className="sb">
              <div className="sh">Top Species</div>
              <div className="ss">most-heard, today</div>
              {top.map((r, i) => (
                <div className="r" key={r.sci}>
                  <span className="k">{String(i + 1).padStart(2, '0')}</span>
                  <span className="v">{r.com || r.sci}</span>
                  <span className="num">{r.n}</span>
                </div>
              ))}
            </div>
            <div className="sb">
              <div className="sh">The Life List</div>
              <div className="ss">newest firsts · lifers</div>
              {(stats?.firstSeen ?? []).map((f) => (
                <div className="r" key={f.sci}>
                  <span className="k">lifer</span>
                  <span className="v">{f.com || f.sci}</span>
                  <span className="num am">★</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
