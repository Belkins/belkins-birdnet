// THE IDLE FRAME TIMER — the one piece of this app that can take the page away
// from a reader while they are using it.
//
// useFrameMode auto-enters frame mode after N seconds of "no activity", and it
// decided what activity was by listening to `pointermove` and `keydown`. On the
// collage that is the whole interaction and the choice was invisible. On the
// Library — a page you sit and READ, whose reading desk carries a 2,700-character
// passage — a reader who scrolled with a wheel or a trackpad and then read was
// thrown into frame mode mid-sentence, because the detector was blind to the one
// thing they were doing. Two headless capture runs saw the view "unmount on its
// own, minutes after load"; that was this, working exactly as written.
//
// There is no DOM in this runner, so this reads the source. That is weaker than
// a behavioural test and it is not nothing: the failure mode is a MISSING
// listener, which no type-check, lint or render test would ever catch, and which
// produces no error when it regresses — the page just quietly walks away.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/frame.ts', import.meta.url), 'utf8');

test('F1 the idle detector counts scrolling as activity', () => {
  // A page whose primary interaction is scrolling must not treat scrolling as
  // idleness. wheel and touchstart cover the gestures that produce no
  // pointermove at all.
  for (const ev of ['wheel', 'touchstart', 'scroll', 'pointermove', 'keydown']) {
    assert.ok(
      new RegExp(`['"]${ev}['"]`).test(src),
      `'${ev}' is not an activity signal — a reader doing exactly that reads as idle`,
    );
  }
});

test('F2 the scroll listener is capture-phase, or it never fires', () => {
  // This app does not scroll the document: an inner .overlay does, and a scroll
  // event on an element does not bubble to window. A non-capturing window
  // listener for 'scroll' is a listener that can never run — the most expensive
  // kind of bug, because it looks exactly like a fix.
  const line = src.split('\n').find((l) => l.includes("'scroll'") && l.includes('addEventListener'));
  assert.ok(line, 'no window scroll listener at all');
  assert.match(
    line,
    /capture:\s*true/,
    'the scroll listener is not capture-phase, so the inner scroller will never reach it',
  );
});

test('F3 every activity listener added is also removed', () => {
  // The hook re-runs whenever idleSec changes. A listener added and not removed
  // accumulates across every settings change and keeps re-arming a timer that
  // belongs to a dead closure.
  const added = [...src.matchAll(/addEventListener\(\s*(?:ev|['"](\w+)['"])/g)];
  const removed = [...src.matchAll(/removeEventListener\(\s*(?:ev|['"](\w+)['"])/g)];
  assert.ok(added.length > 0, 'no listeners at all — re-point this guard');
  const names = (ms: RegExpMatchArray[]) => new Set(ms.map((m) => m[1] ?? 'ev-loop'));
  for (const n of names(added)) {
    assert.ok(names(removed).has(n), `'${n}' is added and never removed`);
  }
});
