// The prominent live counter (bottom-left of the stage) — a museum tombstone,
// not a KPI: distinct SPECIES over total CALLS over a quiet LIVE state line.
// Replaces the tiny `.live` dot. Numbers come straight from props (honest):
// ambient/placeholder birds are painted but never counted.
import { useEffect, useState } from 'react';
import type { LiveState } from '../types';
import './LiveCounter.css';

// SSE connection state → the word beside the breathing dot. Reconnecting and
// offline both read OFFLINE — quiet, in register, never a red alarm (§3).
const LIVE_LABEL: Record<LiveState, string> = {
  connecting: 'CONNECTING',
  live: 'LIVE',
  idle: 'LISTENING',
  reconnecting: 'OFFLINE',
  offline: 'OFFLINE',
};

export function LiveCounter({
  species,
  calls,
  windowLabel,
  live,
  latest,
  compact,
}: {
  species: number;
  calls: number;
  windowLabel: string;
  live: LiveState;
  latest?: string;
  compact?: boolean;
}) {
  // Ephemeral "just heard" ticker: surface the latest common name for ~3.5s,
  // then dissolve. The text lingers through the fade so it never pops to empty.
  const [tick, setTick] = useState('');
  const [tickOn, setTickOn] = useState(false);
  useEffect(() => {
    if (!latest) return;
    setTick(latest);
    setTickOn(true);
    const id = window.setTimeout(() => setTickOn(false), 3500);
    return () => window.clearTimeout(id);
  }, [latest]);

  // Frame / e-ink: collapse to a single static footer line (no dot, no ticker).
  if (compact) {
    return (
      <div className="live-counter compact">
        {species} species · {windowLabel}
      </div>
    );
  }

  return (
    <div className="live-counter">
      <div className="lc-fig">
        <span className="lc-n">{species}</span>
        <span className="lc-lab">SPECIES</span>
      </div>
      <div className="lc-fig lc-fig-2">
        <span className="lc-n">{calls}</span>
        <span className="lc-lab">CALLS · {windowLabel}</span>
      </div>
      <div className="lc-live">
        <span className="lc-dot" data-live={live} />
        <span className="lc-state">{LIVE_LABEL[live]}</span>
        {tick && (
          <span className="lc-tick" data-on={tickOn}>
            ↳ {tick}
          </span>
        )}
      </div>
    </div>
  );
}
