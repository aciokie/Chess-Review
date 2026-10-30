import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../lib/chess.js';
import { app, loadGame } from './helpers/app.mjs';
import { moveGrade } from '../lib/move-grades.js';

// "Forced" = the position before the move had EXACTLY ONE legal move. It is a board fact, not an
// eval judgement, and it is the only condition under which the forced badge may appear. The badge
// replaces reading those moves as "Best"; it never touches Brilliant/Great/Best themselves.
const forcedFen = 'k5rr/8/8/8/8/3B4/8/7K w - - 0 1';   // white's only legal move is Bh7
// Same board shape, but White has a free choice (Qd1 has many moves), so nothing is forced here.
const freeFen = '7k/8/4p3/8/8/8/8/K2Q4 w - - 0 1';
const pgn = (fen, moves) => `[SetUp "1"]\n[FEN "${fen}"]\n\n${moves}`;
// A non-forced game whose played move IS the engine's first choice, so it classifies as Best.
function bestGame(a) {
  const S = loadGame(a, pgn(freeFen, '1. Qd5'), [{ cp: 1000 }, { cp: 1000 }]);
  S.bests[0].bestmove = 'd1d5';
  a.call('computeDerived');
  return S;
}

test('_forcedAt is true only for a position with exactly one legal move', (t) => {
  const a = app(t);
  assert.deepEqual(new Chess(forcedFen).moves(), ['Bh7']);
  loadGame(a, pgn(forcedFen, '1. Bh7'), [{ cp: 0 }, { cp: 0 }]);
  assert.equal(a.call('_forcedAt', 1), true);

  // The ordinary start position has twenty legal moves, so nothing there is forced.
  const b = app(t);
  assert.equal(new Chess().moves().length, 20);
  loadGame(b, '1. e4 e5', [{ cp: 0 }, { cp: 0 }, { cp: 0 }]);
  assert.equal(b.call('_forcedAt', 1), false);
  assert.equal(b.call('_forcedAt', 2), false);
});

test('a forced move is classified Forced, and an ordinary top move is still Best', (t) => {
  const a = app(t);
  const S = loadGame(a, pgn(forcedFen, '1. Bh7'), [{ cp: 0 }, { cp: 0 }]);
  a.call('computeDerived');
  assert.equal(S.classif[1], 'forced');
  // ...and a top move in a position with plenty of legal moves keeps Best, untouched.
  const b = app(t);
  assert.equal(bestGame(b).classif[1], 'best');
});

test('the forced badge is wired up and priced exactly like Best', (t) => {
  const a = app(t);
  assert.equal(a.run('QUALITY.forced.name'), 'Forced');
  assert.equal(a.run('QUALITY.forced.icon'), 'forced');
  assert.equal(a.run('QUALITY.forced.color'), 'var(--q-forced)');
  assert.equal(a.call('categoryName', 'forced'), 'Forced');
  assert.ok(a.call('qIcon', 'forced').endsWith('icons/forced.svg'));
  // Same accuracy contribution and same 0-10 grade as Best, so scores and ratings do not move.
  assert.equal(a.call('catAcc', 'forced'), a.call('catAcc', 'best'));
  assert.equal(moveGrade('forced', 0), moveGrade('best', 0));
  assert.equal(moveGrade('forced', 0), 9);
});

test('the board shows the forced badge for a forced move and Best for a normal one', (t) => {
  const a = app(t);
  loadGame(a, pgn(forcedFen, '1. Bh7'), [{ cp: 0 }, { cp: 0 }]);
  a.call('computeDerived');
  a.state.idx = 1;
  a.call('buildUI');
  a.call('buildBoard');
  const doc = a.dom.window.document;
  const badge = doc.querySelector('.sq-badge');
  assert.ok(badge, 'a badge should be on the destination square');
  assert.ok(badge.getAttribute('src').endsWith('icons/forced.svg'), badge.getAttribute('src'));
  assert.equal(badge.getAttribute('alt'), 'Forced');

  const b = app(t);
  bestGame(b);
  b.state.idx = 1;
  b.call('buildUI');
  b.call('buildBoard');
  const best = b.dom.window.document.querySelector('.sq-badge');
  assert.ok(best, 'a badge should be on the destination square');
  assert.ok(best.getAttribute('src').endsWith('icons/best.svg'), best.getAttribute('src'));
  assert.equal(best.getAttribute('alt'), 'Best');
});

test('Forced stays out of the accuracy breakdown so nothing is double counted', (t) => {
  const a = app(t);
  const full = a.run('QBREAK_FULL'), summary = a.run('QBREAK_SUMMARY'), order = a.run('QUALITY_ORDER');
  assert.equal(full.includes('forced'), false);
  assert.equal(summary.includes('forced'), false);
  // ...but it is a known category everywhere the vocabulary is enumerated.
  assert.equal(order.includes('forced'), true);
  assert.equal(a.run('NOTEWORTHY.has("forced")'), false);   // no extra move-list noise
});
