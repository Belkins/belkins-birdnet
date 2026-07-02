// INDEX — the Broadsheet ledger: a ranked species index with the big number.
import type { RosterRow } from '../types';
import { formatDay } from '../days';

export function IndexView({
  rows,
  archiveDay = null,
}: {
  rows: RosterRow[];
  /** Pinned past day the roster reflects, or null = live window — the ledger
   *  must never headline archive counts as "Heard Today". */
  archiveDay?: string | null;
}) {
  const total = rows.reduce((a, r) => a + r.n, 0);
  const top = rows.slice(0, 12);
  const max = top.length ? top[0].n : 1;
  const lone = rows.length === 1;

  return (
    <div className="view idx">
      <div className="idx-head">
        <div className="eyebrow">{archiveDay ? `${formatDay(archiveDay)} · archive` : 'your window'}</div>
        <div className="idx-big">
          Heard
          <br />
          {archiveDay ? 'That Day' : 'Today'}
        </div>
        <div className="idx-sub">
          {archiveDay ? `most-heard · ${formatDay(archiveDay)}` : 'most-heard · last 24 hours'}
        </div>
        <div className="idx-total">{total}</div>
        <div className="idx-totl">calls · {rows.length} species</div>
      </div>
      {rows.length === 0 ? (
        // N=0: a composed gallery label, never a barren column or a crash.
        <div className="idx-empty">
          <div className="idx-empty-lead">Listening.</div>
          <div className="idx-empty-note">the first row is still unwritten</div>
        </div>
      ) : (
        <div className="idx-listwrap">
          <ol className="idx-list">
            {top.map((r, i) => (
              <li className={i === 0 ? 'idx-row top' : 'idx-row'} key={r.sci}>
                <span className="idx-no">{String(i + 1).padStart(2, '0')}</span>
                <span className="idx-nm">{r.com || r.sci}</span>
                {/* Length is count-proportional against the top species (=100%);
                    a 6% floor keeps the tail visible without flattening the gap. */}
                <span className="idx-track">
                  <span
                    className="idx-bar"
                    style={{ width: `${Math.max(6, Math.round((r.n / max) * 100))}%` }}
                  />
                </span>
                <span className="idx-ct">{r.n}</span>
              </li>
            ))}
          </ol>
          {/* The ledger shows a headline, never a silent cap; the complete list
              lives one tab over (the Atlas renders every species, unsliced). */}
          {rows.length > top.length && (
            <div className="idx-more">
              …and {rows.length - top.length} more species — every plate is in the Atlas
            </div>
          )}
          {/* N=1: one pinned row closes on a beginning, never an error. */}
          {lone && <div className="idx-begin">1 species — a beginning</div>}
        </div>
      )}
    </div>
  );
}
