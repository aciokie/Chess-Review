import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { app, loadGame, fakeEngine } from './helpers/app.mjs';

// Default review = 1 line per position. Great (and a Brilliant in a won position) compare the played
// move with the runner-up, so the review must fetch that line for the few moves where it decides the
// category; without it those moves silently stay Best/Excellent and the badges "disappear".
function oneLineGreat(a) {
  const S = loadGame(a, '1. e4 e5 2. Nf3', [0, 0, 400, 400].map(cp => ({ cp })));
  S.settings.classifyLines = 1;
  S.bests[2] = { bestmove: 'g1f3', lines: [{ score: { cp: 400 }, pv: 'g1f3', depth: 16, bound: 'exact', multipv: 1 }] };
  return S;
}
const twoLines = async () => ({ bestmove: 'g1f3', score: { cp: 400 }, lines: [
  { score: { cp: 400 }, pv: 'g1f3', depth: 16, bound: 'exact', multipv: 1 },
  { score: { cp: 0 }, pv: 'd2d4', depth: 16, bound: 'exact', multipv: 2 },
] });

test('with one line a Great is only Best, but the review records that the runner-up is what is missing', t => {
  const a = app(t), S = oneLineGreat(a);
  a.call('computeDerived');
  assert.equal(S.classif[3], 'best');
  assert.deepEqual([...S.annotationWanted.great], [3]);
});

test('the post-batch search restores Great at the default Analysis lines, one extra search only', async t => {
  const a = app(t), S = oneLineGreat(a);
  let searches = 0, asked;
  const eng = fakeEngine(async (fen, depth, count) => { searches++; asked = count; return twoLines(); });
  await a.call('annotateKeyMoves', [eng], () => true);
  assert.equal(searches, 1, 'only the one position where the runner-up decides the category');
  assert.equal(asked, 2);
  a.call('computeDerived');
  assert.equal(S.classif[3], 'great');
  assert.ok(S.bests[2].annotationSearch, 'kept apart from the scored best/played pair');
  assert.equal(S.bests[2].lines.length, 1, 'the scored root is untouched');
});

test('a failed or invalid extra search leaves the ordinary category and never throws', async t => {
  const a = app(t), S = oneLineGreat(a);
  await a.call('annotateKeyMoves', [fakeEngine(async () => { throw Error('engine died'); })], () => true);
  a.call('computeDerived'); assert.equal(S.classif[3], 'best');
  const bounded = async () => { const r = await twoLines(); r.lines[1].bound = 'lower'; return r; };
  await a.call('annotateKeyMoves', [fakeEngine(bounded)], () => true);
  a.call('computeDerived'); assert.equal(S.classif[3], 'best');
});

test('a game with no Great or won-position Brilliant candidate runs no extra search', async t => {
  const a = app(t); loadGame(a, '1. e4 e5 2. Nf3', [0, 0, 0, 0].map(cp => ({ cp })));
  let searches = 0;
  await a.call('annotateKeyMoves', [fakeEngine(async () => { searches++; return twoLines(); })], () => true);
  assert.equal(searches, 0);
});

test('a superseded review stops searching', async t => {
  const a = app(t); oneLineGreat(a);
  let searches = 0;
  await a.call('annotateKeyMoves', [fakeEngine(async () => { searches++; return twoLines(); })], () => false);
  assert.equal(searches, 0);
});

test('a Mistake-sized opponent slip is enough to carry a Great when the reply is the only good move', async t => {
  const a = app(t);
  // Black's e5 loses 1.2 pawns (win% drop ~9) but neither side is near the +2 clear-advantage line,
  // so it is a "Mistake-sized slip" rather than the narrow advantage-transition Mistake.
  const S = loadGame(a, '1. e4 e5 2. Nf3', [0, 0, 120, 120].map(cp => ({ cp })));
  S.settings.classifyLines = 1;
  S.bests[2] = { bestmove: 'g1f3', score: { cp: 120 }, lines: [
    { score: { cp: 120 }, pv: 'g1f3', depth: 16, bound: 'exact', multipv: 1 },
  ] };
  a.call('computeDerived');
  assert.equal(S.classif[2], 'inacc', 'the opponent slipped, but not across a clear-advantage line');
  assert.equal(S.classif[3], 'best');
  assert.deepEqual([...S.annotationWanted.great], [3], 'the only-good-reply evidence is still what decides it');
  await a.call('annotateKeyMoves', [fakeEngine(async () => ({
    bestmove: 'g1f3', score: { cp: 120 }, lines: [
      { score: { cp: 120 }, pv: 'g1f3', depth: 16, bound: 'exact', multipv: 1 },
      { score: { cp: -100 }, pv: 'd2d4', depth: 16, bound: 'exact', multipv: 2 },
    ],
  }))], () => true);
  a.call('computeDerived');
  assert.equal(S.classif[3], 'great');
});

test('a full one-line review runs the key-move pass and publishes Great', async t => {
  const a = app(t), S = loadGame(a, '1. e4 e5 2. Nf3');
  a.context.__pc = JSON.parse(fs.readFileSync(new URL('../data/calibration.json', import.meta.url)));
  a.run('PUBLIC_CALIB = __pc');
  Object.assign(S.settings, { enginePath: 'nnue', engineDepth: 16, engineHash: 16, engineSkill: 20, classifyLines: 1, engineWorkers: 1 });
  for (const name of ['paintBoard', 'renderEvalBar', 'renderMoves', 'renderControls', 'renderReview', 'renderStats', 'renderEngineCurrent', 'renderBestArrow', 'renderGraph']) a.replace(name, () => {});
  a.replace('saveToLibrary', () => {});
  // The scored batch: one line per root, with the played move's score recorded separately.
  const scored = {
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR': { move: 'e2e4', cp: 0, played: 0 },
    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR': { move: 'c7c5', cp: 0, played: -120 }, // e5 slips
    'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR': { move: 'g1f3', cp: 120, played: 120 },
    'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R': { move: 'b8c6', cp: -120, played: -120 },
  };
  a.replace('analyseCalibratedPosition', async (eng, { fen }) => {
    const s = scored[fen.split(' ')[0]];
    return { bestmove: s.move, score: { cp: s.cp },
      lines: [{ score: { cp: s.cp }, pv: s.move, depth: 16, bound: 'exact', multipv: 1 }],
      playedScore: { cp: s.played }, calibration: { build: 'nnue' } };
  });
  let annotate = 0;
  a.replace('createEngine', async () => Object.assign(fakeEngine(async (fen, depth, count) => {
    if (count !== 2) throw Error('the scored batch is stubbed; only annotation searches here');
    annotate++;
    return { bestmove: 'g1f3', score: { cp: 120 }, lines: [
      { score: { cp: 120 }, pv: 'g1f3', depth: 16, bound: 'exact', multipv: 1 },
      { score: { cp: -100 }, pv: 'd2d4', depth: 16, bound: 'exact', multipv: 2 },
    ] };
  }), { buildKey: 'nnue' }));
  await a.call('startAnalysis');
  assert.equal(annotate, 1, 'only the key move got the extra search');
  assert.equal(S.classif[2], 'inacc');
  assert.equal(S.classif[3], 'great');
});

test('a runner-up search that fails or yields no usable line is not repeated on every repaint', async t => {
  const a = app(t), S = oneLineGreat(a);
  let first = 0;
  await a.call('annotateKeyMoves', [fakeEngine(async () => { first++; throw Error('engine died'); })], () => true);
  assert.equal(first, 1, 'the attempt was made once');
  let second = 0;
  await a.call('annotateKeyMoves', [fakeEngine(async () => { second++; return twoLines(); })], () => true);
  assert.equal(second, 0, 'the same root is not searched again');
  a.call('computeDerived');
  assert.equal(S.classif[3], 'best', 'and the move keeps its ordinary category');
});

