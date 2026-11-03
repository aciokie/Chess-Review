import test from 'node:test';
import assert from 'node:assert/strict';
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
