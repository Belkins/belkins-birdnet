// SERVICES - the station's health and its units, read from birdnet-status.php
// (the _auth-gated admin surface; STATION_OPEN currently stands the gate down
// on the LAN). Status, journal tails, and restart - the three things the old
// Services page was actually opened for day to day.
//
// Deliberately NOT here: stop / enable / disable and the microphone switch.
// Those stay in the old console (one restart cannot silence the station; a
// stop can), and the footer says exactly where they live - the door to the
// old page stays on a walkable path, per the station-door doctrine.
//
// Honesty: the dot colours are systemd's own words (active/failed/...), the
// refresh stamp is the response's as_of, and a 401 renders as "gate is up",
// never as an empty table pretending the station has no services.
import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import {
  fetchLogs,
  fetchServices,
  fetchSystem,
  fmtAgo,
  fmtBytes,
  postRestart,
  SELF_KILLING_UNITS,
  StationUnavailable,
  type ServicesResponse,
  type SystemResponse,
} from './labApi';

type Gate = 'open' | 'locked' | 'mock' | 'error';

export function Services(): JSX.Element {
  const [svc, setSvc] = useState<ServicesResponse | null>(null);
  const [sys, setSys] = useState<SystemResponse | null>(null);
  const [gate, setGate] = useState<Gate>('open');
  const [reason, setReason] = useState('');
  const [logsFor, setLogsFor] = useState<string | null>(null);
  const [logText, setLogText] = useState('');
  const [arming, setArming] = useState<string | null>(null);
  const [verdicts, setVerdicts] = useState<Record<string, string>>({});

  const load = useCallback((): void => {
    setSvc(null);
    setSys(null);
    Promise.all([fetchServices(), fetchSystem()])
      .then(([s, y]) => {
        setSvc(s);
        setSys(y);
        setGate('open');
      })
      .catch((e: unknown) => {
        if (e instanceof StationUnavailable) {
          setGate(e.kind === 'mock' ? 'mock' : 'locked');
        } else {
          setGate('error');
          setReason(`status fetch failed (${String(e)})`);
        }
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const showLogs = (unit: string): void => {
    if (logsFor === unit) {
      setLogsFor(null);
      return;
    }
    setLogsFor(unit);
    setLogText('fetching journal…');
    fetchLogs(unit, 120)
      .then((l) => setLogText(l.text || '(journal empty)'))
      .catch((e: unknown) => setLogText(`journal fetch failed (${String(e)})`));
  };

  const restart = (unit: string): void => {
    if (arming !== unit) {
      setArming(unit);
      return;
    }
    setArming(null);
    setVerdicts((v) => ({ ...v, [unit]: 'restarting…' }));
    postRestart(unit)
      .then((r) => {
        const verdict =
          r.ok === true
            ? 'restarted'
            : r.ok === false && r.rc !== undefined
              ? `failed (rc ${r.rc}) ${r.out ?? ''}`.trim()
              : `refused${r.error ? ` - ${r.error}` : ''}`;
        setVerdicts((v) => ({ ...v, [unit]: verdict }));
        window.setTimeout(load, 1500);
      })
      .catch((e: unknown) => {
        if (SELF_KILLING_UNITS.test(unit)) {
          // caddy/php-fpm serve this very page - the restart aborts the
          // in-flight response, so a dead fetch here is what SUCCESS looks
          // like. Say that, then go look instead of claiming either way.
          setVerdicts((v) => ({
            ...v,
            [unit]: 'restart sent - it serves this page, so the reply died with it; re-checking…',
          }));
          window.setTimeout(load, 4000);
        } else {
          setVerdicts((v) => ({ ...v, [unit]: `restart failed (${String(e)})` }));
        }
      });
  };

  if (gate === 'mock') {
    return (
      <div className="lab-panel lab-wide">
        <h2>SERVICES</h2>
        <p className="lab-empty">mock build - no station behind this page.</p>
      </div>
    );
  }
  if (gate === 'locked') {
    return (
      <div className="lab-panel lab-wide">
        <h2>SERVICES</h2>
        <p className="lab-empty lab-err">
          the station gate is up - birdnet-status answers 401 without the station password. The
          data tabs stay live; for services use{' '}
          <a className="lab-nav" href="/views.php?view=Services">
            the old console ↗
          </a>{' '}
          which will ask for it.
        </p>
      </div>
    );
  }

  return (
    <div className="lab-panel lab-wide">
      <h2>SERVICES</h2>
      <p className="lab-note">
        systemd&rsquo;s own words for every station unit, with the journal a click away. Restart
        asks twice; the sharper switches stay in the old console.
      </p>

      {gate === 'error' && <p className="lab-empty lab-err">{reason}</p>}
      {gate === 'open' && (svc === null || sys === null) && (
        <p className="lab-empty">asking the station&hellip;</p>
      )}

      {gate === 'open' && sys !== null && (
        <p className="lab-chips">
          {sys.hostname && <span className="lab-chip">{sys.hostname}</span>}
          {sys.uptime?.pretty && <span className="lab-chip">up {sys.uptime.pretty}</span>}
          {Array.isArray(sys.uptime?.load) && sys.uptime.load.length > 0 && (
            <span className="lab-chip">load {sys.uptime.load[0].toFixed(2)}</span>
          )}
          {sys.mem?.used_pct !== undefined && (
            <span className={chip(sys.mem.used_pct > 90)}>mem {sys.mem.used_pct}%</span>
          )}
          {sys.disk_root?.used_pct !== undefined && (
            <span className={chip(sys.disk_root.used_pct > 90)}>
              disk / {sys.disk_root.used_pct}%
            </span>
          )}
          {sys.disk_birds?.used_pct !== undefined && (
            <span className={chip(sys.disk_birds.used_pct > 90)}>
              songs {sys.disk_birds.used_pct}%
            </span>
          )}
          {typeof sys.temp_c === 'number' && (
            <span className={chip(sys.temp_c > 80)}>{sys.temp_c}°C</span>
          )}
          {sys.birds_db?.exists === true &&
            sys.birds_db.modified_s !== undefined &&
            sys.birds_db.size_bytes !== undefined && (
              <span className="lab-chip">
                birds.db {fmtBytes(sys.birds_db.size_bytes)} · wrote {fmtAgo(sys.birds_db.modified_s)}{' '}
                ago
              </span>
            )}
          {sys.stream_data?.exists === true && sys.stream_data.newest_age_s != null && (
            <span className="lab-chip">
              mic chunk {fmtAgo(sys.stream_data.newest_age_s)} ago
            </span>
          )}
        </p>
      )}

      {gate === 'open' && svc !== null && (
        <>
          <table>
            <thead>
              <tr>
                <th>unit</th>
                <th>state</th>
                <th>enabled</th>
                <th>since</th>
                <th className="lab-r" aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {Object.entries(svc.services).map(([unit, s]) => [
                <tr key={unit} className="lab-row">
                  <td className="lab-mono">{unit}</td>
                  <td>
                    <span className={`lab-svc lab-svc--${s.active === 'active' ? 'up' : s.active === 'failed' ? 'bad' : 'off'}`}>
                      <i /> {s.active}
                    </span>
                  </td>
                  <td className="lab-dim">{s.enabled}</td>
                  <td className="lab-mono lab-dim">{s.since ? s.since.replace(/^\w+ /, '').slice(0, 16) : '—'}</td>
                  <td className="lab-r lab-actions">
                    {verdicts[unit] !== undefined && (
                      <span className="lab-dim lab-verdict">{verdicts[unit]}</span>
                    )}
                    <button className="lab-btn" onClick={() => showLogs(unit)}>
                      {logsFor === unit ? 'close' : 'journal'}
                    </button>
                    <button
                      className={arming === unit ? 'lab-btn lab-btn--arm' : 'lab-btn'}
                      onClick={() => restart(unit)}
                      onBlur={() => arming === unit && setArming(null)}
                    >
                      {arming === unit ? 'confirm restart?' : 'restart'}
                    </button>
                  </td>
                </tr>,
                logsFor === unit ? (
                  <tr key={`${unit}-logs`} className="lab-expand">
                    <td colSpan={5}>
                      <pre className="lab-logs">{logText}</pre>
                    </td>
                  </tr>
                ) : null,
              ])}
            </tbody>
          </table>
          {/* The whole clock+offset, verbatim: PHP's date('c') follows its own
              date.timezone (often UTC on this box), so naming a zone here
              would be a claim the data doesn't guarantee - the offset IS the
              claim, carried by the value itself. */}
          <p className="lab-caption lab-dim">as of {svc.as_of.slice(11)}</p>
        </>
      )}

      <p className="lab-hatch lab-dim">
        stop, enable, disable and the microphone switch live in the old console:{' '}
        <a className="lab-nav" href="/views.php?view=Services">
          Service Controls ↗
        </a>{' '}
        - the mic is the birdnet_recording row there.
      </p>
    </div>
  );
}

function chip(warn: boolean): string {
  return warn ? 'lab-chip lab-chip--warn' : 'lab-chip';
}
