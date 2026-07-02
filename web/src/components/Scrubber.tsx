// Time-travel scrubber — a wooden-ruler day strip, not a datepicker. One tick
// per real day; tick height maps sqrt(detections) so the ridge shape is itself
// honest data. Zero days render dimmed and unclickable (an honest gap, never
// skipped — time stays linear). Rightmost is NOW; while a past day is pinned,
// NOW is the one-tap return. Hidden entirely by App when the API can't serve
// days (old Pi) or the strip is empty — degrade to silence.
import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { DayActivity } from '../days';
import { formatDay } from '../days';
import './Scrubber.css';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export function Scrubber({
  days,
  selected,
  onSelect,
}: {
  days: DayActivity[]; // zero-filled, ascending; last entry = today
  selected: string | null; // pinned day, or null = live NOW
  onSelect: (day: string | null) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  // A deep archive outgrows the band (a year is ~1.5k px of ticks); the ruler
  // SCROLLS rather than compressing time, parked at the recent end on mount.
  useEffect(() => {
    const el = trackRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [days.length]);

  const max = Math.max(1, ...days.map((d) => d.detections));
  return (
    <div className="scrub" role="group" aria-label="Travel to a past day">
      <div className="scrub-track" ref={trackRef}>
        {days.map((d, i) => {
          const isToday = i === days.length - 1; // today belongs to NOW, not the archive
          const monthStart = i === 0 || d.date.endsWith('-01');
          return (
            <div className="scrub-day" key={d.date}>
              <button
                className={d.date === selected ? 'scrub-tick on' : 'scrub-tick'}
                disabled={d.detections === 0 || isToday}
                style={{ '--h': `${Math.round(100 * Math.sqrt(d.detections / max))}%` } as CSSProperties}
                aria-label={`${formatDay(d.date)} — ${d.species} species`}
                title={`${formatDay(d.date)} · ${d.species} species`}
                onClick={() => onSelect(d.date)}
              />
              {monthStart && <span className="scrub-mo">{MONTHS[Number(d.date.slice(5, 7)) - 1]}</span>}
            </div>
          );
        })}
      </div>
      <button className={selected ? 'scrub-now armed' : 'scrub-now'} onClick={() => onSelect(null)}>
        NOW
      </button>
    </div>
  );
}
