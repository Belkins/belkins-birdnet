// RHYTHMS - the station's pulse as three honest charts: a day x hour heatmap
// (when the garden speaks), daily detection and species bars, and the
// hour-of-day profile. This absorbs the old console's Daily Charts / Streamlit
// habit for the everyday question "what has the week sounded like".
//
// Chart discipline (dataviz): the heatmap is a SEQUENTIAL job - one blue hue
// off --lab-accent, monotonic lightness, zero stays the panel surface so a
// quiet hour reads as quiet. One axis per chart - detections and species get
// two stacked charts, never a dual axis. Every mark carries a native <title>
// so each value is readable on hover, and every caption states the real
// window from the RESPONSE, not a hardcoded claim.
import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { fetchDayActivity, type DayActivity } from '../days';
import {
  buildActivityGrid,
  fetchActivity,
  heatColor,
  HEAT_RAMP,
  StationUnavailable,
  type Activity,
  type ActivityGrid,
} from './labApi';

const HEAT_DAYS = 28;
const BAR_DAYS = 90;

export function Rhythms(): JSX.Element {
  const [act, setAct] = useState<Activity | null>(null);
  const [actErr, setActErr] = useState('');
  const [daily, setDaily] = useState<DayActivity[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetchActivity(HEAT_DAYS)
      .then((a) => {
        if (alive) setAct(a);
      })
      .catch((e: unknown) => {
        if (alive)
          setActErr(
            e instanceof StationUnavailable ? e.message : `activity fetch failed (${String(e)})`,
          );
      });
    // days.ts already zero-fills and validates; [] is its honest failure state.
    void fetchDayActivity(BAR_DAYS).then((rows) => {
      if (alive) setDaily(rows.slice(-BAR_DAYS));
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <section className="lab-panel lab-wide">
        <h2>WAKING GRID</h2>
        <p className="lab-note">
          detections per hour of day - each row one day, newest at the top. Colour steps are
          quarters of this window&rsquo;s peak hour.
        </p>
        {act === null && actErr === '' && <p className="lab-empty">loading&hellip;</p>}
        {actErr !== '' && <p className="lab-empty lab-err">{actErr}</p>}
        {act !== null && <Heatmap act={act} />}
      </section>

      <section className="lab-panel lab-wide">
        <h2>DAY LEDGER</h2>
        <p className="lab-note">
          detections and distinct species per day. Two scales, two charts - never one axis
          pretending to be both.
        </p>
        {daily === null ? (
          <p className="lab-empty">loading&hellip;</p>
        ) : daily.length === 0 ? (
          <p className="lab-empty">no daily data - station unreachable or empty db.</p>
        ) : (
          <>
            <Bars
              rows={daily}
              pick={(d) => d.detections}
              color="#8fb7ff"
              unit="detections"
            />
            <Bars rows={daily} pick={(d) => d.species} color="#5a82b8" unit="species" />
            <p className="lab-caption lab-dim">
              last {daily.length} recorded day{daily.length === 1 ? '' : 's'} · birds.db live
            </p>
          </>
        )}
      </section>
    </>
  );
}

function Heatmap({ act }: { act: Activity }): JSX.Element {
  const grid: ActivityGrid = buildActivityGrid(act);
  if (grid.total === 0) {
    return <p className="lab-empty">no detections in the last {act.days} days.</p>;
  }
  // Newest day on top - a console ledger reads downward into the past.
  const rows = [...grid.dates].reverse();
  const CW = 34; // hour column width
  const RH = 14; // row height
  const LEFT = 78; // date gutter
  const TOP = 16; // hour ruler
  const w = LEFT + 24 * CW;
  const h = TOP + rows.length * RH + 18;
  return (
    <>
      <svg
        className="lab-chart"
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={`detections per hour over the last ${act.days} days`}
      >
        {[0, 6, 12, 18, 23].map((hr) => (
          <text key={hr} x={LEFT + hr * CW + CW / 2} y={11} className="lab-tick" textAnchor="middle">
            {String(hr).padStart(2, '0')}
          </text>
        ))}
        {rows.map((date, ri) => {
          const di = grid.dates.indexOf(date);
          return (
            <g key={date}>
              {(ri % 7 === 0 || ri === rows.length - 1) && (
                <text x={LEFT - 8} y={TOP + ri * RH + RH - 4} className="lab-tick" textAnchor="end">
                  {date.slice(5)}
                </text>
              )}
              {grid.counts[di].map((n, hr) => {
                const fill = heatColor(n, grid.max);
                if (fill === null) return null;
                return (
                  <rect
                    key={hr}
                    x={LEFT + hr * CW + 1}
                    y={TOP + ri * RH + 1}
                    width={CW - 2}
                    height={RH - 2}
                    rx={2}
                    fill={fill}
                  >
                    <title>{`${date} ${String(hr).padStart(2, '0')}:00 - ${n} detection${n === 1 ? '' : 's'}`}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}
      </svg>
      <p className="lab-caption lab-dim">
        <span className="lab-legend">
          0<i style={{ background: 'transparent' }} />
          {HEAT_RAMP.map((c) => (
            <i key={c} style={{ background: c }} />
          ))}
          {grid.max}
        </span>
        {' '}· last {act.days} days · anchored {act.today} (station clock) ·{' '}
        {grid.total.toLocaleString()} detections
      </p>
    </>
  );
}

function Bars({
  rows,
  pick,
  color,
  unit,
}: {
  rows: DayActivity[];
  pick: (d: DayActivity) => number;
  color: string;
  unit: string;
}): JSX.Element {
  const max = Math.max(...rows.map(pick), 1);
  const BW = 8;
  const H = 72;
  const w = rows.length * BW;
  return (
    <div className="lab-barrow">
      <span className="lab-tickside lab-mono">{max}</span>
      <svg
        className="lab-chart lab-bars"
        viewBox={`0 0 ${w} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${unit} per day, last ${rows.length} days`}
      >
        {rows.map((d, i) => {
          const v = pick(d);
          const bh = v > 0 ? Math.max(1, Math.round((v / max) * (H - 4))) : 0;
          return v > 0 ? (
            <rect key={d.date} x={i * BW + 1} y={H - bh} width={BW - 2} height={bh} fill={color}>
              <title>{`${d.date} - ${v} ${unit}`}</title>
            </rect>
          ) : null;
        })}
      </svg>
      <span className="lab-tickside lab-dim">{unit}</span>
    </div>
  );
}
