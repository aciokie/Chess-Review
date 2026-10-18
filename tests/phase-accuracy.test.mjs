import test from 'node:test';
import assert from 'node:assert/strict';
import { app, loadGame } from './helpers/app.mjs';

test('pieceCountNonPawn counts knights, bishops, rooks and queens of both sides', t => {
  const a = app(t);
  assert.equal(a.call('pieceCountNonPawn', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'), 14);
  assert.equal(a.call('pieceCountNonPawn', '8/5k2/8/8/8/8/4K3/8 w - - 0 1'), 0);
  assert.equal(a.call('pieceCountNonPawn', '4k3/8/8/8/8/8/8/R3K2R w - - 0 1'), 2);
});

test('phases only move forward and a game starts in the opening', t => {
  const a = app(t);
  const S = loadGame(a, '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');
  const phases = Array.from(a.call('phaseByPly'));
  assert.equal(phases[0], null);
  assert.deepEqual(phases.slice(1), ['opening', 'opening', 'opening', 'opening', 'opening', 'opening']);
  assert.equal(S.total, 6);
});

test('opening lasts ten full moves, then middlegame; sparse material is endgame', t => {
  const a = app(t);
  // 12 full moves of knight shuffles (no captures) keep every piece on the board.
  const pgn = '1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8 5. Nf3 Nf6 6. Ng1 Ng8 7. Nf3 Nf6 8. Ng1 Ng8 9. Nf3 Nf6 10. Ng1 Ng8 11. Nf3 Nf6 12. Ng1 Ng8';
  loadGame(a, pgn);
  const phases = Array.from(a.call('phaseByPly'));
  assert.equal(phases[20], 'opening');
  assert.equal(phases[21], 'middlegame');
  assert.equal(phases[24], 'middlegame');

  // Hand-built positions: heavy material, then ≤ 6 pieces left → endgame (and it never reverts).
  const heavy = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const sparse = '4k3/8/8/8/8/8/8/R3K2R w - - 0 1';
  const S = a.state;
  S.total = 4;
  S.positions = [heavy, heavy, sparse, heavy, sparse].map(fen => ({ fen }));
  assert.deepEqual(Array.from(a.call('phaseByPly')).slice(1), ['opening', 'opening', 'endgame', 'endgame']);
});

test('phaseAccuracy uses the same tuned aggregation as the whole-game accuracy', t => {
  const a = app(t);
  const S = loadGame(a, '1. e4 e5 2. Nf3 Nc6');
  a.run('CALIB = { winK: 0.003, display: "winpct" };');
  S.classif = [null, 'best', 'blunder', 'good', 'excellent'];
  S.accMove = [null, 100, 20, 80, 90];
  const acc = a.call('phaseAccuracy');
  const game = a.call('sideAccuracies');
  // A game played entirely in the opening must give the same number as the whole-game accuracy.
  assert.equal(acc.w.opening, game.w);
  assert.equal(acc.b.opening, game.b);
  assert.equal(acc.w.middlegame, null);
  assert.equal(acc.b.endgame, null);
});

test('computeDerived stores phase accuracy', t => {
  const a = app(t);
  const S = loadGame(a, '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');
  a.call('computeDerived');
  assert.ok(S.phaseAcc.w.opening != null);
  assert.ok(S.phaseAcc.b.opening != null);
  assert.equal(S.phaseAcc.w.endgame, null);
});

test('phaseElo runs each phase accuracy through the whole-game estimate', t => {
  const a = app(t);
  const S = loadGame(a, '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7');
  const n = S.total, classif = new Array(n + 1).fill(null), accMove = new Array(n + 1).fill(null);
  for (let i = 1; i <= n; i++) { classif[i] = 'good'; accMove[i] = 60 + (i % 5) * 8; }
  S.classif = classif; S.accMove = accMove;
  S.players = { w: { name: 'White', rating: 1500 }, b: { name: 'Black' } };
  const acc = a.call('phaseAccuracy');
  const elo = a.call('phaseElo');
  const expect = (v, r) => (v == null ? null : a.call('estimateElo', a.call('calAccBias', v, r), r));
  assert.equal(elo.w.opening, expect(acc.w.opening, 1500));
  assert.equal(elo.b.opening, expect(acc.b.opening, undefined));
  assert.equal(elo.w.middlegame, null);
});

test('phaseElo hides an estimate when a phase has too few moves', t => {
  const a = app(t);
  const S = loadGame(a, '1. e4 e5 2. Nf3 Nc6');
  S.classif = [null, 'good', 'good', 'good', 'good'];
  S.accMove = [null, 80, 80, 80, 80];
  const elo = a.call('phaseElo');
  // Only two scored moves per side in the opening (below MIN_PHASE_MOVES) → no estimate,
  // but the accuracy itself is still reported.
  assert.ok(a.call('phaseAccuracy').w.opening != null);
  assert.equal(elo.w.opening, null);
  assert.equal(elo.b.opening, null);
});

test('computeDerived stores phase Elo', t => {
  const a = app(t);
  const S = loadGame(a, '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7');
  a.call('computeDerived');
  assert.ok(S.phaseElo.w.opening != null);
  assert.ok(S.phaseElo.b.opening != null);
  assert.equal(S.phaseElo.w.endgame, null);
});
