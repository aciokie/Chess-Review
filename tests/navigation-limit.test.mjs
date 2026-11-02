import test from 'node:test';
import assert from 'node:assert/strict';
import { app, loadGame, settle } from './helpers/app.mjs';

// Workers publish positions out of order, so the contiguous prefix lags the furthest result. Upstream
// lets the review cross those pending gaps up to the furthest completed evaluation, and keeps
// following the recorded game on the mainline while its evaluation is still pending (d79a1e58 /
// 14592873). Before that, navigation was stuck at the contiguous prefix.
function board(t) {
  const a = app(t);
  loadGame(a, '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O');
  const S = a.state;
  S.analyzing = true;
  S.progress = 2;                                        // only the first two plies are contiguous
  S.evals = S.positions.map((_, i) => (i <= 2 || i === 6 ? { cp: 10 * i } : null));
  S.bests = S.positions.map(() => ({ bestmove: 'a1a1', score: { cp: 0 }, lines: [] }));
  a.call('computeDerived');
  a.call('buildUI');
  a.call('renderAll');
  return { a, S };
}

test('the review crosses pending gaps up to the furthest completed evaluation', t => {
  const { a, S } = board(t);
  a.call('go', 6);
  assert.equal(S.idx, 6, 'a gap (plies 3-5) can be crossed when a later ply has a result');
  a.call('go', 9);
  assert.equal(S.idx, 6, 'and cannot go past the furthest evaluation while analysis runs');
  assert.equal(a.call('mainlineNavigationLimit'), 6);
});

test('once the analysis is finished the whole game is navigable again', t => {
  const { a, S } = board(t);
  S.analyzing = false;
  a.call('go', S.total);
  assert.equal(S.idx, S.total);
  assert.equal(a.call('mainlineNavigationLimit'), S.total);
});

test('following the recorded game stays on the mainline even without its evaluation', async t => {
  const { a, S } = board(t);
  a.call('go', 2);
  const next = S.positions[3];                           // the recorded move from ply 2 to 3
  assert.equal(S.idx, 2);
  a.call('applyUserMove', next.from, next.to, false);
  await settle();
  assert.equal(S.analysisMode, false, 'playing the recorded move is not a variation');
  assert.equal(S.idx, 3, 'the board follows the game to the next move');
  assert.ok(!S.variation);
});

test('a different move still opens a variation', async t => {
  const { a, S } = board(t);
  a.call('go', 2);                                       // after 1.e4 e5, White to move again
  a.call('applyUserMove', 'b1', 'c3', false);             // not the recorded 2.Nf3
  await settle();
  assert.equal(S.analysisMode, true, 'a deviating move is a variation');
  assert.ok(S.variation);
});

// Progress deep-links to the move that decided a game, so the board starts at a ply no evaluation has
// reached yet. A fresh batch publishes nothing at the start, so the limit was 0 and the first Next or
// End snapped the board back to the opening position.
const DEEP_PGN = '1. e4 e5 2. Nf3 Nc6 3. Bb5';

test('a deep-linked position survives the first navigation click of a fresh batch', async t => {
  const a = app(t, { url: 'https://extension.test/analysis.html#deep-link' });
  loadGame(a, DEEP_PGN);
  a.call('computeDerived'); a.call('buildUI'); a.call('renderAll');
  a.replace('startAnalysis', () => {});                  // the batch's results are not under test here
  await a.call('applyGame', { pgn: DEEP_PGN, meta: { gameId: 'deep', startPly: 3 }, analysis: null });
  const S = a.state;
  assert.equal(S.idx, 3, 'the link landed on its ply');
  S.analyzing = true;                                     // nothing published yet: a fresh batch
  S.progress = 0;
  S.evals = S.positions.map(() => null);
  S.bests = S.positions.map(() => null);

  a.call('go', S.idx + 1);                                // Next
  assert.equal(S.idx, 3, 'Next must not rewind the board to ply 0');
  assert.ok(a.call('mainlineNavigationLimit') >= 3, 'the limit cannot sit behind the board');
  a.call('go', S.total);                                  // End
  assert.equal(S.idx, 3, 'nor End');

  // Forward navigation resumes as soon as the batch reaches the linked ply.
  S.progress = 4;
  S.evals = S.positions.map((_, i) => (i <= 4 ? { cp: 0 } : null));
  a.call('go', 4);
  assert.equal(S.idx, 4);
});
