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
import ts from 'typescript';

const src = readFileSync(new URL('../src/frame.ts', import.meta.url), 'utf8');

/** Every identifier that gates whether `<Tag …>` renders — the left of each
 *  enclosing `&&`, and the condition of each enclosing `?:`.
 *
 *  Written for F4. A guard that only asserts the TAG is present cannot see the
 *  regression that actually happened: the counter was not deleted, it was
 *  wrapped in a tab test. What matters is the CONDITION, and the condition is
 *  an expression, not a string. */
function renderGuardsFor(fileUrl: URL, tag: string): string[] {
  const sf = ts.createSourceFile(
    'app.tsx',
    readFileSync(fileUrl, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const names = new Set<string>();
  let found = 0;

  // ONE LEVEL OF LOCAL INDIRECTION, because that is how this guard was beaten.
  // Collecting the identifiers in each enclosing condition only sees the names
  // written AT the render site. Hoist the test one line up —
  //
  //   const showCounter = !framed && shownTab !== 'library';
  //   {showCounter && ( … <LiveCounter …/> … )}
  //
  // — and the only identifier in the condition is `showCounter`, which is on no
  // banned list. Measured: the counter vanishes from the Library tab, tsc is
  // clean, all 117 tests pass, and F4 says nothing. Extracting a long condition
  // into a well-named flag is the most ordinary refactor there is, which is
  // exactly why the guard has to follow it. Same fix, same reason, as
  // rawNameRenders() in jardine.test.ts.
  const locals = new Map<string, ts.Node>();
  const collectLocals = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      locals.set(n.name.text, n.initializer);
    }
    ts.forEachChild(n, collectLocals);
  };
  collectLocals(sf);

  // UNBOUNDED, not one level. A first attempt followed exactly one hop and a
  // two-hop version walked straight past it:
  //
  //   const onCollageOnly = shownTab === 'collage';
  //   const showCounter   = !framed && onCollageOnly;
  //
  // Picking any fixed depth just tells the next person how many lines to use.
  // The chain is followed to the end instead, with a seen-set so a self- or
  // mutually-referential const cannot spin.
  const seen = new Set<string>();
  const idsIn = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) {
      names.add(n.text);
      const init = locals.get(n.text);
      if (init && !seen.has(n.text)) {
        seen.add(n.text);
        idsIn(init);
      }
    }
    ts.forEachChild(n, idsIn);
  };

  const visit = (n: ts.Node): void => {
    const isTag =
      (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && n.tagName.getText(sf) === tag;
    if (isTag) {
      found++;
      let node: ts.Node = n;
      // climb to the component root, collecting the tests we pass under
      for (let p = n.parent; p; p = p.parent) {
        if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
          // only the LEFT gates us, and only if we came from the right
          if (p.right === node || p.right.getStart(sf) <= n.getStart(sf)) idsIn(p.left);
        } else if (ts.isConditionalExpression(p)) {
          idsIn(p.condition);
        } else if (ts.isFunctionDeclaration(p) || ts.isArrowFunction(p)) {
          break;
        }
        node = p;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.ok(found > 0, `<${tag}> is not rendered at all — re-point this guard`);
  return [...names];
}

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

test('F3 every activity listener added is also removed, on the same phase', () => {
  // The hook re-runs whenever idleSec changes. A listener added and not removed
  // accumulates across every settings change and keeps re-arming a timer that
  // belongs to a dead closure.
  //
  // MATCHING BY NAME IS NOT ENOUGH, and that is how this guard was beaten.
  // removeEventListener matches on (type, handler, CAPTURE) — the capture flag
  // is part of the identity. `add('scroll', h, {capture:true})` paired with
  // `remove('scroll', h)` removes NOTHING: the name sets are still equal, this
  // test still passes, and every settings change leaks another scroll listener
  // that re-arms auto-frame after the reader has turned it off. So the phase is
  // compared too.
  const calls = (kind: string) =>
    [...src.matchAll(new RegExp(`${kind}\\(\\s*(?:ev|['"](\\w+)['"])([^)]*)\\)`, 'g'))].map((m) => ({
      name: m[1] ?? 'ev-loop',
      capture: /capture:\s*true/.test(m[2] ?? ''),
    }));
  const added = calls('addEventListener');
  const removed = calls('removeEventListener');
  assert.ok(added.length > 0, 'no listeners at all — re-point this guard');
  for (const a of added) {
    const match = removed.find((r) => r.name === a.name);
    assert.ok(match, `'${a.name}' is added and never removed`);
    assert.equal(
      match.capture,
      a.capture,
      `'${a.name}' is added with capture:${a.capture} and removed with capture:${match.capture} — ` +
        `removeEventListener matches on the phase, so this removes nothing and the listener leaks`,
    );
  }
});

test('F4 the live counter is never hidden — it is the product', () => {
  // I removed the live species/calls readout from Index, Stats, Atlas, Wall AND
  // the Library, as collateral of a Library typography fix. The ask was about
  // one tab; the counter is the instrument this whole appliance exists to be.
  // Vlad's words on finding it: "you killing my product."
  //
  // The overlap that prompted it predates the session and is not worth the
  // counter. If it is ever worth solving, move the TEXT — never remove the
  // instrument. This fails on any rule that hides it, at any width, on any view.
  const css = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')
    // comments discuss the removal on purpose; the guard must read RULES only
    .replace(/\/\*[\s\S]*?\*\//g, '');

  const rules = css.split('}');
  for (const rule of rules) {
    if (!/\.live-counter/.test(rule)) continue;
    assert.doesNotMatch(
      rule,
      /display\s*:\s*none/,
      `a rule hides the live counter — it is the product, not chrome:\n${rule.trim().slice(0, 200)}`,
    );
    assert.doesNotMatch(
      rule,
      /visibility\s*:\s*hidden|opacity\s*:\s*0(?!\.)/,
      `a rule makes the live counter invisible by another name:\n${rule.trim().slice(0, 200)}`,
    );
  }

  // And it must still be rendered at all — a hidden rule is not the only way to
  // lose it; deleting the element is the other.
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /<LiveCounter/, 'App no longer renders the live counter');

  // THE CONDITION, NOT THE TAG. Asserting `<LiveCounter` is present cannot see
  // what actually happened: the counter was never deleted, it was WRAPPED —
  // `shownTab === 'collage' && <LiveCounter …/>` removed it from five tabs with
  // the tag still right there in the file. Reviewers flagged that this guard
  // reads the CSS and the tag and never the render condition.
  //
  // So: nothing about which TAB is showing may gate the counter. Framed mode
  // may — the frame is a deliberate, whole-chrome hide with its own exit — and
  // archive mode may, because ArchiveCaption stands in its place with the same
  // figures. A tab test may not.
  const guards = renderGuardsFor(new URL('../src/App.tsx', import.meta.url), 'LiveCounter');
  for (const banned of ['shownTab', 'tab', 'TABS']) {
    assert.ok(
      !guards.includes(banned),
      `the live counter is gated on '${banned}' — that is exactly how it was removed from ` +
        `five tabs before. It is the instrument this appliance exists to be, not chrome. ` +
        `If a tab's layout collides with it, move the TEXT. Guards seen: ${guards.join(', ')}`,
    );
  }
});

test('F4 the live counter is never hidden — it is the product', () => {
  // I removed the live species/calls readout from Index, Stats, Atlas, Wall AND
  // the Library, as collateral of a Library typography fix. The ask was about
  // one tab; the counter is the instrument this whole appliance exists to be.
  // Vlad's words on finding it: "you killing my product."
  //
  // The overlap that prompted it predates the session and is not worth the
  // counter. If it is ever worth solving, move the TEXT — never remove the
  // instrument. This fails on any rule that hides it, at any width, on any view.
  const css = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')
    // comments discuss the removal on purpose; the guard must read RULES only
    .replace(/\/\*[\s\S]*?\*\//g, '');

  const rules = css.split('}');
  for (const rule of rules) {
    if (!/\.live-counter/.test(rule)) continue;
    assert.doesNotMatch(
      rule,
      /display\s*:\s*none/,
      `a rule hides the live counter — it is the product, not chrome:\n${rule.trim().slice(0, 200)}`,
    );
    assert.doesNotMatch(
      rule,
      /visibility\s*:\s*hidden|opacity\s*:\s*0(?!\.)/,
      `a rule makes the live counter invisible by another name:\n${rule.trim().slice(0, 200)}`,
    );
  }

  // And it must still be rendered at all — a hidden rule is not the only way to
  // lose it; deleting the element is the other.
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /<LiveCounter/, 'App no longer renders the live counter');
});
