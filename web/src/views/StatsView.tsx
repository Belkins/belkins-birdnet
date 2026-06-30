// STATS — detection rhythm as editorial data-art: a by-hour ridge + the
// by-period / top-species / first-detections panels. Server data loads once
// on entry (real PHP API, or a synthesized mock); top-species stays live.
import { useEffect, useRef, useState } from 'react';
import type { RosterRow } from '../types';
import { loadStats, type StatsData } from '../views-data';

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

  const top = rows.slice(0, 6);
  const byHour = stats?.byHour ?? new Array<number>(24).fill(0);
  const maxHour = Math.max(1, ...byHour);
  const fmt = (n: number | undefined) => (n === undefined ? '—' : n);

  return (
    <div className="view">
      <div className="view-mast">
        <div className="eyebrow">your window</div>
        <div className="t">THE RECORD</div>
      </div>
      <div className="stats-grid">
        <div>
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
          <div className="ridge-ax">
            <span>0h</span>
            <span>6h</span>
            <span>12h</span>
            <span>18h</span>
            <span>23h</span>
          </div>
        </div>
        <div className="stats-panels">
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
            <div className="sh">First Detections</div>
            <div className="ss">newest additions to the life list</div>
            {(stats?.firstSeen ?? []).map((f) => (
              <div className="r" key={f.sci}>
                <span className="k">new</span>
                <span className="v">{f.com || f.sci}</span>
                <span className="num am">★</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
