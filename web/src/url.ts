// Deep-link URL state — hand-rolled, no router (spec: utility-features.md #1).
// Grammar:  ?tab=index|stats|atlas|wall|library   (absent = collage)
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
  /** THE AIM — the sci_name the Library's Reading Desk should open on, written
   *  by "in the library →" in the dossier. Underscored like ?bird=. Null = the
   *  desk chooses for itself. */
  read: string | null;
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
    read: readAim(q.get('read')),
  };
}

/** '?read=Turdus_merula' → 'Turdus merula'. Untrusted input: anything that is
 *  not a plausible binomial resolves to null and the desk simply chooses for
 *  itself, which is the pre-existing behaviour. Never throws. */
function readAim(raw: string | null): string | null {
  if (!raw) return null;
  const sci = raw.replace(/_/g, ' ').trim();
  return /^[A-Za-z][A-Za-z-]+ [A-Za-z][A-Za-z-]+$/.test(sci) ? sci : null;
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

/** Aim the Library's Reading Desk at a species (push — arriving from a dossier
 *  IS a navigation, and Back should return the reader to the bird). */
export function writeRead(sci: string): void {
  const q = new URLSearchParams(location.search);
  const aim = sci.replace(/ /g, '_');
  if (q.get('read') === aim) return; // compare-before-write: popstate-safe
  write((qq) => qq.set('read', aim), true);
}

/** Drop the aim: the reader turned the page, so the desk is its own again. */
export function clearRead(): void {
  if (new URLSearchParams(location.search).get('read') === null) return;
  write((q) => q.delete('read'), false);
}
