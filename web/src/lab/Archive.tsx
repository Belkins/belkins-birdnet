// ARCHIVE - the raw detection ledger, paged and filtered, with the recording
// and its spectrogram inline. This absorbs what the old station console's
// Recordings/Today's Detections views did daily: find a detection, hear it,
// see it. Read-only - the sharp per-file actions (delete, re-identify, purge
// locks) deliberately stay in the old console; a browser surface this open
// should not carry them.
//
// Honesty: the count line and the filter readout come from the RESPONSE
// echoes, not the request state - the page describes the slice the server
// actually applied. A missing recording renders as "not on disk (purged?)",
// never as a broken player pretending.
import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import type { CatalogSpecies } from '../catalog';
import {
  fetchArchive,
  recordingUrl,
  spectrogramUrl,
  StationUnavailable,
  type ArchivePage,
} from './labApi';

const PAGE = 100;
const CONF_OPTS = [
  { label: 'any confidence', value: 0 },
  { label: '≥ 50%', value: 0.5 },
  { label: '≥ 70%', value: 0.7 },
  { label: '≥ 90%', value: 0.9 },
];

export function Archive({ cat, active }: { cat: CatalogSpecies[]; active: boolean }): JSX.Element {
  const [sci, setSci] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [minConf, setMinConf] = useState(0);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<ArchivePage | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [audioGone, setAudioGone] = useState<Set<string>>(new Set());

  const species = useMemo(
    () => [...cat].sort((a, b) => (a.com_name || '').localeCompare(b.com_name || '')),
    [cat],
  );

  const badRange = from !== '' && to !== '' && from > to;

  // Tab-hide is display:none, which does NOT pause a media element - only
  // unmounting does. Without this, a playing recording keeps sounding,
  // invisibly, after switching to RHYTHMS or SERVICES, with its controls
  // hidden and no way to stop it short of coming back.
  useEffect(() => {
    if (!active) setOpen(null);
  }, [active]);

  useEffect(() => {
    if (badRange) return;
    let alive = true;
    setState('loading');
    setOpen(null);
    fetchArchive({
      from: from || undefined,
      to: to || undefined,
      sci: sci || undefined,
      minConf: minConf || undefined,
      limit: PAGE,
      offset,
    })
      .then((p) => {
        if (!alive) return;
        setPage(p);
        setState('ready');
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setReason(e instanceof StationUnavailable ? e.message : `archive fetch failed (${String(e)})`);
        setState('error');
      });
    return () => {
      alive = false;
    };
  }, [sci, from, to, minConf, offset, badRange]);

  // Any filter change restarts paging from the top.
  const pick = (fn: () => void): void => {
    fn();
    setOffset(0);
  };

  const lastPage = page ? Math.max(0, Math.ceil(page.total / page.limit) - 1) : 0;
  const pageNo = page ? Math.floor(page.offset / page.limit) : 0;

  return (
    <div className="lab-panel lab-archive">
      <h2>ARCHIVE</h2>
      <p className="lab-note">
        every detection row in birds.db, newest first - the recording and its spectrogram open in
        place. Filters are applied by the station and echoed back.
      </p>

      <div className="lab-controls">
        <select
          className="lab-select"
          value={sci}
          onChange={(e) => pick(() => setSci(e.target.value))}
          aria-label="species filter"
        >
          <option value="">all species</option>
          {species.map((s) => (
            <option key={s.slug} value={s.sci_name}>
              {s.com_name || s.sci_name}
            </option>
          ))}
        </select>
        <input
          className="lab-input"
          type="date"
          value={from}
          onChange={(e) => pick(() => setFrom(e.target.value))}
          aria-label="from date"
        />
        <span className="lab-dim">to</span>
        <input
          className="lab-input"
          type="date"
          value={to}
          onChange={(e) => pick(() => setTo(e.target.value))}
          aria-label="to date"
        />
        <select
          className="lab-select"
          value={String(minConf)}
          onChange={(e) => pick(() => setMinConf(Number(e.target.value)))}
          aria-label="minimum confidence"
        >
          {CONF_OPTS.map((o) => (
            <option key={o.value} value={String(o.value)}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {badRange && <p className="lab-empty lab-err">from is after to - nothing fetched.</p>}

      {!badRange && state === 'loading' && <p className="lab-empty">reading the ledger&hellip;</p>}
      {!badRange && state === 'error' && <p className="lab-empty lab-err">{reason}</p>}

      {!badRange && state === 'ready' && page && (
        <>
          <p className="lab-count">
            {page.total.toLocaleString()} detection{page.total === 1 ? '' : 's'} match
            {page.sci ? ` · ${page.sci}` : ''}
            {page.from ? ` · from ${page.from}` : ''}
            {page.to ? ` · to ${page.to}` : ''}
            {page.min_conf > 0 ? ` · conf ≥ ${Math.round(page.min_conf * 100)}%` : ''}
          </p>
          {page.rows.length === 0 ? (
            <p className="lab-empty">nothing in this slice.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>date</th>
                  <th>time</th>
                  <th>species</th>
                  <th className="lab-r">conf</th>
                  <th aria-label="expand" />
                </tr>
              </thead>
              <tbody>
                {page.rows.map((r) => {
                  const key = `${r.file}-${r.d}-${r.t}`;
                  const isOpen = open === key;
                  return [
                    <tr
                      key={key}
                      className={isOpen ? 'lab-row lab-row--open' : 'lab-row'}
                      onClick={() => {
                        if (!isOpen) {
                          // Reopening retries: an <audio> error can be a purge
                          // OR a transient network failure - a permanent latch
                          // would turn a wifi blip into "purged" forever.
                          setAudioGone((s) => {
                            if (!s.has(r.file)) return s;
                            const next = new Set(s);
                            next.delete(r.file);
                            return next;
                          });
                        }
                        setOpen(isOpen ? null : key);
                      }}
                    >
                      <td className="lab-mono">{r.d}</td>
                      <td className="lab-mono">{r.t}</td>
                      <td>
                        {r.com} <span className="lab-dim lab-i">{r.sci}</span>
                      </td>
                      <td className="lab-mono lab-r">{Math.round((r.conf || 0) * 100)}%</td>
                      <td className="lab-dim lab-r">{isOpen ? '▾' : '▸'}</td>
                    </tr>,
                    isOpen ? (
                      <tr key={`${key}-x`} className="lab-expand">
                        <td colSpan={5}>
                          {audioGone.has(r.file) ? (
                            <p className="lab-empty">
                              recording unreachable - purged from disk, or the fetch failed.
                              Reopen the row to retry.
                            </p>
                          ) : (
                            <audio
                              controls
                              preload="none"
                              src={recordingUrl(r.file)}
                              onError={() =>
                                setAudioGone((s) => new Set(s).add(r.file))
                              }
                            />
                          )}
                          <img
                            className="lab-spec"
                            src={spectrogramUrl(r.file)}
                            alt={`spectrogram of ${r.com} at ${r.d} ${r.t}`}
                            loading="lazy"
                            onError={(e) => {
                              (e.target as HTMLImageElement).style.display = 'none';
                            }}
                          />
                          <p className="lab-dim lab-file">{r.file}</p>
                        </td>
                      </tr>
                    ) : null,
                  ];
                })}
              </tbody>
            </table>
          )}
          <div className="lab-pager">
            <button
              className="lab-btn"
              disabled={pageNo <= 0}
              onClick={() => setOffset(Math.max(0, offset - page.limit))}
            >
              &larr; newer
            </button>
            <span className="lab-dim lab-mono">
              page {pageNo + 1} / {lastPage + 1}
            </span>
            <button
              className="lab-btn"
              disabled={pageNo >= lastPage}
              onClick={() => setOffset(offset + page.limit)}
            >
              older &rarr;
            </button>
          </div>
        </>
      )}
    </div>
  );
}
