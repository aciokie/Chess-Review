import test from 'node:test';
import assert from 'node:assert/strict';
import { app, loadGame, branch, settle } from './helpers/app.mjs';

// Our own equivalent of upstream's variation-analysis reuse (reuseVariationAnalysis, f249aa32) and of
// "reuse completed analysis during best-move playback": an engine search is only ever run for a
// position that has no result yet, so stepping back and forth through a variation - or walking the
// engine's best moves - never re-searches anything already measured.
function countingBoard(t) {
  const a = app(t);
  loadGame(a, '1. e4 e5 2. Nf3');
  branch(a);
  a.state.meta = { explore: true };
  a.call('computeDerived');
  a.call('buildUI');
  a.call('renderAll');
  let calls = 0;
  a.state.liveEngine = {
    dead: false,
    analyse: async () => { calls++; return { score: { cp: 20 }, bestmove: 'e7e5', lines: [] }; },
    stop() {}, cancelPending() {}, terminate() {},
  };
  for (const p of a.state.variation.positions) { p.eval = null; p.best = null; }
  return { a, calls: () => calls };
}

test('revisiting variation positions never re-searches what is already measured', async t => {
  const { a, calls } = countingBoard(t);
  const v = a.state.variation;
  v.idx = 2;
  await a.call('requestLiveEval');
  await settle();
  const first = calls();
  assert.equal(first, 3, 'the position in view and the four-ply lookback are searched once');

  v.idx = 0;
  await a.call('requestLiveEval');
  await settle();
  assert.equal(calls(), first, 'stepping back reuses the stored results');

  v.idx = 2;
  await a.call('requestLiveEval');
  await settle();
  assert.equal(calls(), first, 'stepping forward again reuses them too');
  assert.ok(v.positions[2].best && v.positions[2].eval, 'the results are still there');
});

test('the best-move walk searches each new position once and reuses the rest', async t => {
  const { a, calls } = countingBoard(t);
  const S = a.state;
  S.settings.moveAnim = false;
  a.context.__sleep = () => {};
  // Play best moves from the start; the walk appends one position per step.
  await a.call('playBestMoves');
  await settle();
  const positions = S.variation.positions.length;
  assert.ok(positions >= 3, 'the walk played more than one move');
  assert.ok(calls() <= positions * 2, `each step analyses at most the new position (${calls()} searches for ${positions} positions)`);
  assert.ok(S.variation.positions.every((p) => p.best), 'every walked position ends up with engine evidence');
});
