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

test('phaseAccuracy averages the per-move score by side and phase', t => {
  const a = app(t);
  const S = loadGame(a, '1. e4 e5 2. Nf3 Nc6');
  S.classif = [null, 'best', 'blunder', 'good', 'excellent'];
  const acc = a.call('phaseAccuracy');
  assert.equal(acc.w.opening, (100 + S.settings.accGood) / 2);
  assert.equal(acc.b.opening, (S.settings.accBlunder + S.settings.accExcellent) / 2);
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
