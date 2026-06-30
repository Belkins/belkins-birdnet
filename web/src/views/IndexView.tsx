// INDEX — the Broadsheet ledger: a ranked species index with the big number.
import type { RosterRow } from '../types';

export function IndexView({ rows }: { rows: RosterRow[] }) {
  const total = rows.reduce((a, r) => a + r.n, 0);
  const top = rows.slice(0, 12);
  const max = top.length ? top[0].n : 1;

  return (
    <div className="view idx">
      <div className="idx-head">
        <div className="eyebrow">your window</div>
        <div className="idx-big">
          Heard
          <br />
          Today
        </div>
        <div className="idx-sub">most-heard · last 24 hours</div>
        <div className="idx-total">{total}</div>
        <div className="idx-totl">calls · {rows.length} species</div>
      </div>
      <ol className="idx-list">
        {top.map((r, i) => (
          <li className={i === 0 ? 'idx-row top' : 'idx-row'} key={r.sci}>
            <span className="idx-no">{String(i + 1).padStart(2, '0')}</span>
            <span className="idx-nm">{r.com || r.sci}</span>
            <span className="idx-bar" style={{ width: `${20 + (r.n / max) * 60}%` }} />
            <span className="idx-ct">{r.n}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
