import test from 'node:test';
import assert from 'node:assert/strict';
import { app, loadGame, settle } from './helpers/app.mjs';

// Extra candidate lines are display-only evidence. Upstream keeps a bounded cache of exact contexts
// and shares a request that is already running (fdeda4b8 + 0c0328f8) instead of searching the same
// position again every time the user comes back to it.
function board(t) {
  const a = app(t);
  loadGame(a, '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');
  const S = a.state;
  S.settings.engineLines = 2;
  S.settings.engineDepth = 4;
  // The batch stored one line per position; the panel wants two.
  S.bests = S.positions.map(() => ({ bestmove: 'e2e4', score: { cp: 0 }, lines: [{ pv: 'e2e4', score: { cp: 0 } }] }));
  let calls = 0;
  S.liveEngine = {
    dead: false,
    analyse: async () => { calls++; return { score: { cp: 0 }, bestmove: 'e2e4',
      lines: [{ pv: 'e2e4 e7e5', score: { cp: 0 } }, { pv: 'd2d4 d7d5', score: { cp: -12 } }] }; },
    stop() {}, cancelPending() {}, terminate() {},
  };
  a.call('computeDerived');
  a.call('buildUI');
  a.call('renderAll');
  return { a, S, calls: () => calls };
}

test('returning to a position reuses its candidate lines instead of searching again', async t => {
  const { a, S, calls } = board(t);
  a.call('renderEngineCurrent');
  await settle();
  assert.equal(calls(), 1, 'the panel search runs once');
  assert.equal(S._panelCache.lines.length, 2);
  assert.match(a.dom.window.document.querySelector('#engineMount').textContent, /d4/);

  // The on-screen cache is cleared (as navigating away does) - the stored context still answers.
  S._panelCache = null;
  a.call('renderEngineCurrent');
  await settle();
  assert.equal(calls(), 1, 'the same position and settings never search twice');
  assert.equal(S._panelCache.lines.length, 2, 'the cached lines are shown');
});

test('a request that is already running is shared, not duplicated', async t => {
  const { a, calls } = board(t);
  const first = a.call('requestPanelLines');
  const second = a.call('requestPanelLines');
  await Promise.all([first, second]);
  await settle();
  assert.equal(calls(), 1, 'the second request waited for the first');
});

test('a different position still searches for itself', async t => {
  const { a, calls } = board(t);
  a.call('renderEngineCurrent');
  await settle();
  assert.equal(calls(), 1);
  a.state._panelCache = null;
  a.call('go', 4);
  a.call('renderEngineCurrent');
  await settle();
  assert.equal(calls(), 2, 'another position has its own context');
});
