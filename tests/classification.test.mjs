import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { app, loadGame, branch } from './helpers/app.mjs';

const pgn = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6';

test('alternative ratings match mainline for both sides and retain pre-branch context', t => {
  const a = app(t);
  const scenarios = [
    [70,-20,80,50,-80,10,0].map(cp=>({cp})),
    [0,0,350,340,100,80,500].map(cp=>({cp})),
    [{cp:0},{mate:-2},{mate:-4},{cp:20},{mate:2},{mate:4},{cp:0}],
  ];
  for (const evals of scenarios) {
    const S = loadGame(a,pgn,evals);
    a.call('computeDerived');
    const expected = Array.from(S.classif);
    const originalEvals = JSON.stringify(S.evals);
    for (let ply=0;ply<S.total;ply++) {
      const v=branch(a,ply);
      a.call('classifyVariationMoves');
      assert.deepEqual(Array.from(v.positions.slice(1),p=>p.classif),expected.slice(ply+1));
      assert.equal(JSON.stringify(S.evals),originalEvals);
      assert.deepEqual(Array.from(S.classif),expected);
    }
  }
});

test('pawn thresholds are not compared to centipawns', t => {
  const a=app(t);const S=loadGame(a,'1. e4',[{cp:70},{cp:-20}]);
  a.call('computeDerived');const v=branch(a);a.call('classifyVariationMoves');
  assert.equal(S.classif[1],'inacc');assert.equal(v.positions[1].classif,'inacc');
});

test('delaying a forced mate is Good in either review mode', t => {
  const a=app(t);const S=loadGame(a,'1. e4',[{mate:2},{mate:4}]);
  a.call('computeDerived');const v=branch(a);a.call('classifyVariationMoves');
  assert.equal(S.classif[1],'good');assert.equal(v.positions[1].classif,'good');
});

test('offline theory beyond four moves remains Book; losing traps do not', t => {
  const a=app(t);
  a.context.__book=JSON.parse(fs.readFileSync(new URL('../data/book.json',import.meta.url))).epd;
  a.run('BOOK = __book');
  const S=loadGame(a,'1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7');
  a.call('computeDerived');assert.equal(S.classif[10],'book');
  const v=branch(a);a.call('classifyVariationMoves');assert.equal(v.positions[10].classif,'book');
  loadGame(a,'1. f3 e5 2. g4',[{cp:0},{cp:-20},{cp:-20},{mate:-1}]);
  a.call('computeDerived');assert.notEqual(S.classif[3],'book');
  assert.ok(['mistake','blunder'].includes(S.classif[3]));
});

test('promotion identity is preserved in best-move comparison', t => {
  const a=app(t);
  const S=loadGame(a,'[SetUp "1"]\n[FEN "7k/P7/8/8/8/8/8/7K w - - 0 1"]\n\n1. a8=N');
  S.bests[0].bestmove='a7a8q';
  a.call('computeDerived');assert.notEqual(S.classif[1],'best');
  S.bests[0].bestmove='a7a8n';a.call('computeDerived');assert.equal(S.classif[1],'best');
});

test('missing evaluations do not invent a rating', t => {
  const a=app(t);loadGame(a,'1. e4',[{cp:0},null]);
  const v=branch(a);a.call('classifyVariationMoves');assert.equal(v.positions[1].classif,null);
});

test('terminal detection retains threefold history in Explore', t => {
  const a=app(t);const S=loadGame(a,'1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8');
  assert.equal(S.positions[8].draw,'threefold');
  const v=branch(a);assert.equal(a.call('variationTerminal',v,8).cp,0);
  assert.equal(a.call('variationTerminal',v,4),null);
});

test('the current variation opening follows the viewed prefix', t => {
  const a=app(t);loadGame(a,'1. e4 e5');const v=branch(a);a.state.meta={explore:true};
  a.context.__book={
    [a.call('epdOf',v.positions[1].fen)]:['B00','King pawn'],
    [a.call('epdOf',v.positions[2].fen)]:['C20','Open game'],
  };a.run('BOOK = __book');
  assert.equal(a.call('variationOpening').name,'Open game');
  v.idx=1;assert.equal(a.call('variationOpening').name,'King pawn');
  v.idx=0;assert.equal(a.call('variationOpening'),null);
});

test('original PGN IDs remain stable and distinct', t => {
  const a=app(t);const games=['1. e4 e5 *','1. d4 d5 *','1. c4 c5 *'];
  assert.equal(new Set(games.map(p=>a.call('simpleHash',p))).size,3);
  // Known ID produced by the released implementation.
  assert.equal(a.call('simpleHash',''),'45h');
});

test('stricter brilliant rules: bounded exchange analysis, soundness floor, and MultiPV gate', t => {
  const a = app(t);

  // 1. Equal trade is not a sacrifice
  const tradePgn = '1. e4 e5 2. Nf3 Nc6 3. Nxe5 Nxe5';
  const tradeS = loadGame(a, tradePgn, [{cp:0},{cp:0},{cp:0},{cp:0},{cp:0},{cp:0}]);
  a.call('computeDerived');
  assert.notEqual(tradeS.classif[6], 'brilliant');

  // 2. Pure pawn move is not a sacrifice
  const pawnPgn = '1. e4 e5';
  const pawnS = loadGame(a, pawnPgn, [{cp:0},{cp:0}]);
  a.call('computeDerived');
  assert.notEqual(pawnS.classif[2], 'brilliant');

  // 3. Unsound sacrifice (after score below -0.5 pawns / -50 cp) fails brilliantEligible
  const unsoundPgn = '1. e4 e5 2. Qh5 Nc6 3. Qxf7+ Kxf7';
  // Move 3: White plays Qxf7+ (loses queen for pawn -> -800 cp)
  const unsoundS = loadGame(a, unsoundPgn, [{cp:0},{cp:0},{cp:0},{cp:0},{cp:0},{cp:-800}]);
  a.call('computeDerived');
  assert.notEqual(unsoundS.classif[5], 'brilliant');

  // 4. Already winning position (>= +5 pawns / +500 cp) with MultiPV=1 does not grant Brilliant
  // (requires MultiPV > 1 with runner-up line falling below +5 pawns)
  const winningPgn = '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. Bxf7+ Kxf7';
  const winningS = loadGame(a, winningPgn, [{cp:600},{cp:600},{cp:600},{cp:600},{cp:600},{cp:600},{cp:600},{cp:600}]);
  winningS.bests[6] = { bestmove: 'b2b3', lines: [{ multipv: 1, score: { cp: 600 }, depth: 16, pv: 'b2b3' }] };
  a.call('computeDerived');
  assert.notEqual(winningS.classif[7], 'brilliant');
});
