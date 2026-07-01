// LIVE VIEW — the "full live dashboard" that replaces the collage in the
// rolling-1H window (12H/24H/7D/ALL keep the collage untouched). Three honest
// live surfaces over the Obsidian-night / cream-day system:
//
//   (a) THIS-HOUR counters — distinct SPECIES over total CALLS, seeded from the
//       hour's backlog (App's roster, already re-seeded by engine.setWindow(1))
//       and ticking up as SSE detections arrive.
//   (b) NOW HEARING — the most-recent detection: common name + a small kachō-e
//       thumb (shared BirdThumb) + a live "just now" ping.
//   (c) RECENT DETECTIONS — a streaming feed, newest on top, each new row
//       animating in.
//
// It reuses the ONE existing SSE stream: App feeds it `feed` rows derived from
// the engine's roster deltas — LiveView never opens a socket of its own.
import type { LiveState } from '../types';
import { BirdThumb } from '../components/BirdThumb';
import './LiveView.css';

/** One streamed detection row. `confPct` is optional: it is populated only when
 *  App has per-detection confidence available (see the note in the PR/report);
 *  the row renders cleanly with or without it. */
export interface FeedRow {
  key: string;
  com: string;
  sci: string;
  slug: string;
  isNew: boolean;
  /** HH:MM:SS local-time stamp captured when the detection landed. */
  time: string;
  /** epoch ms — retained for age-out / ordering, not shown directly. */
  at: number;
  /** per-detection confidence percent (0..100), when available. */
  confPct?: number;
}

// SSE connection state → the word beside the breathing dot. Reconnecting and
// offline both read OFFLINE — quiet, in register, never a red alarm (matches
// the LiveCounter chrome).
const LIVE_WORD: Record<LiveState, string> = {
  connecting: 'CONNECTING',
  live: 'LIVE',
  idle: 'LISTENING',
  reconnecting: 'OFFLINE',
  offline: 'OFFLINE',
};

export function LiveView({
  species,
  calls,
  feed,
  live,
}: {
  species: number;
  calls: number;
  feed: FeedRow[];
  live: LiveState;
}) {
  const now = feed[0] ?? null;

  return (
    <section className="live-view" aria-label="Live — this hour">
      <div className="lv-inner">
        <header className="lv-head">
          <div className="lv-eyebrow">this hour · live</div>
          <div className="lv-figs">
            <div className="lv-fig">
              <span className="lv-n">{species}</span>
              <span className="lv-lab">SPECIES</span>
            </div>
            <span className="lv-sep" aria-hidden="true" />
            <div className="lv-fig lv-fig-calls">
              <span className="lv-n">{calls}</span>
              <span className="lv-lab">CALLS</span>
            </div>
            <span className="lv-live" data-live={live}>
              <span className="lv-dot" />
              <span className="lv-live-word">{LIVE_WORD[live]}</span>
            </span>
          </div>
        </header>

        <div className="lv-body">
          {/* (c) NOW HEARING — most-recent detection, or a listening state. */}
          <div className="lv-now">
            <div className="lv-now-h">NOW HEARING</div>
            {now ? (
              <div className="lv-now-card">
                {/* Keyed by slug so a repeat of the same species does not reload
                    the plate; only a species change re-mounts the thumb. */}
                <div className="lv-thumb">
                  <BirdThumb key={now.slug} slug={now.slug} sci={now.sci} com={now.com} />
                </div>
                <div className="lv-now-meta">
                  <div className="lv-now-name">{now.com}</div>
                  <div className="lv-now-sci">{now.sci}</div>
                  <div className="lv-now-when">
                    {/* Keyed by the row key so the ping restarts on every new
                        detection — a fresh "just now" pulse each time. */}
                    <span className="lv-pulse" key={now.key} aria-hidden="true" />
                    <span>
                      just now · {now.time}
                      {now.confPct != null ? ` · ${now.confPct}%` : ''}
                    </span>
                    {now.isNew && <span className="lv-tag">NEW</span>}
                  </div>
                </div>
              </div>
            ) : (
              <div className="lv-now-empty">
                <div className="lv-listen-ring" aria-hidden="true">
                  <span />
                  <span />
                  <i />
                </div>
                <div className="lv-listening-word">Listening</div>
                <div className="lv-listening-cap">
                  {species > 0
                    ? `${species} species heard this hour · waiting for the next call`
                    : 'the wire is open — the first call of the hour is still ahead'}
                </div>
              </div>
            )}
          </div>

          {/* (b) RECENT DETECTIONS — the streaming feed, newest on top. */}
          <div className="lv-feed">
            <div className="lv-feed-h">
              <span>RECENT DETECTIONS</span>
              <span className="lv-feed-count">{feed.length ? `${feed.length} live` : '—'}</span>
            </div>
            {feed.length ? (
              <ul className="lv-list">
                {feed.map((r) => (
                  <li className="lv-row" key={r.key}>
                    <span className="lv-row-t">{r.time}</span>
                    <span className="lv-row-nm">{r.com}</span>
                    <span className="lv-row-r">
                      {r.confPct != null ? (
                        <span className="lv-conf">{r.confPct}%</span>
                      ) : r.isNew ? (
                        <span className="lv-tag">NEW</span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="lv-feed-empty">
                <span className="lv-dot" data-live={live} />
                <span>new calls appear here the moment they are heard</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
