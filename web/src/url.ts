// Deep-link URL state — hand-rolled, no router (spec: utility-features.md #1).
// Grammar:  ?tab=index|stats|atlas|wall   (absent = collage)
//           ?bird=Genus_species           (underscored sci; matched by slug)
//           ?pose=flight                  (absent = perched)
//           ?on=YYYY-MM-DD                (time-travel scrubber; absent = NOW)
// Every write round-trips ALL other params verbatim (surface/frame/chrome/
// motion/win/n/ghost — the frozen Display Profile — plus anything future),
// so kiosk/e-ink boot URLs survive. Works under any base path (/, /collage/).
import { slugify } from './data';

/** ?on= must be a plausible calendar-day token; garbage reads as absent. */
const ON_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface UrlState {
  tab: string | null;
  birdSlug: string | null;
  pose: 1 | 2;
  /** Pinned archive day ('YYYY-MM-DD'), or null = live NOW. */
  on: string | null;
}

export function readUrl(): UrlState {
  const q = new URLSearchParams(location.search);
  const raw = q.get('bird');
  const slug = raw ? slugify(raw) : '';
  const on = q.get('on');
  return {
    tab: q.get('tab'),
    birdSlug: slug || null,
    pose: q.get('pose') === 'flight' ? 2 : 1,
    on: on && ON_RE.test(on) ? on : null,
  };
}

/** Apply `mutate` to the current query and commit; push=false → replaceState.
 *  history unavailable (odd embedded webview) degrades to a no-op — never throws. */
function write(mutate: (q: URLSearchParams) => void, push: boolean): void {
  const q = new URLSearchParams(location.search);
  mutate(q);
  const qs = q.toString();
  const url = `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`;
  try {
    (push ? history.pushState : history.replaceState).call(history, null, '', url);
  } catch {
    /* degrade */
  }
}

/** Mirror the active tab (replace — no history spam). collage = clean URL. */
export function writeTab(tab: string): void {
  const cur = new URLSearchParams(location.search).get('tab');
  const want = tab === 'collage' ? null : tab;
  if (cur === want) return; // compare-before-write: popstate-safe
  write((q) => {
    if (want) q.set('tab', want);
    else q.delete('tab');
  }, false);
}

/** Reflect an open dossier. Pushes when the URL had no bird (Back closes it). */
export function writeBird(sci: string, pose: 1 | 2): void {
  const q = new URLSearchParams(location.search);
  const bird = sci.replace(/ /g, '_');
  const wantPose = pose === 2 ? 'flight' : null;
  if (q.get('bird') === bird && q.get('pose') === wantPose) return;
  const push = q.get('bird') === null;
  write((qq) => {
    qq.set('bird', bird);
    if (wantPose) qq.set('pose', wantPose);
    else qq.delete('pose');
  }, push);
}

/** Dossier closed (or ?bird= garbage): drop bird+pose, replace, silently. */
export function clearBird(): void {
  const q = new URLSearchParams(location.search);
  if (q.get('bird') === null && q.get('pose') === null) return;
  write((qq) => {
    qq.delete('bird');
    qq.delete('pose');
  }, false);
}

/** Pin/unpin the time-travel day (replace — scrubbing never spams history). */
export function writeOn(day: string | null): void {
  const cur = new URLSearchParams(location.search).get('on');
  if (cur === day) return; // compare-before-write: popstate-safe
  write((q) => {
    if (day) q.set('on', day);
    else q.delete('on');
  }, false);
}

/** Pose toggled inside an open dossier (replace; only meaningful with a bird). */
export function writePose(pose: 1 | 2): void {
  const q = new URLSearchParams(location.search);
  if (q.get('bird') === null) return;
  const want = pose === 2 ? 'flight' : null;
  if (q.get('pose') === want) return;
  write((qq) => {
    if (want) qq.set('pose', want);
    else qq.delete('pose');
  }, false);
}
