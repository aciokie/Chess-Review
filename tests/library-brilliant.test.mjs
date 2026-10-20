import test from 'node:test';
import assert from 'node:assert/strict';
import { app, loadGame } from './helpers/app.mjs';

// Keep the DOM rendering out of the way; these tests only exercise library data.
function quiet(a) {
  for (const name of ['paintBoard', 'renderEvalBar', 'renderMoves', 'renderPlayers', 'renderControls',
    'renderReview', 'renderStats', 'renderEngineCurrent', 'renderBestArrow', 'renderGraph', 'renderLibrary']) a.replace(name, () => {});
}

// Save a fully-analyzed game into the library (the same path the app uses).
function savedGame(a, pgn, gameId) {
  const S = loadGame(a, pgn);
  S.meta = { gameId };
  S.players = { w: { name: 'W', rating: '1600' }, b: { name: 'B', rating: '1500' } };
  S.meSide = 'b';
  S.acc = { w: 80, b: 70 };
  S.accElo = { w: 80, b: 70 };
  S.headers = { UTCDate: '2026.10.05' };
  S.opening = { eco: 'C20', name: 'Open game' };
  return S;
}

test('rescan re-derives brilliant games from stored analysis instead of skipping them', async t => {
  const a = app(t);
  quiet(a);
  savedGame(a, '1. e4 e5 2. Nf3 Nc6 1-0', '111');
  await a.call('saveToLibrary');
  assert.equal(a.state.library.length, 1);

  const res = await a.call('rescanLibraryForBrilliants');
  assert.equal(res.skipped, 0, 'a complete stored analysis must not be skipped');
  assert.equal(res.scanned, 1, 'the saved game must actually be re-classified');
});

test('Brilliants sort shows only games flagged with a brilliant move', t => {
  const a = app(t);
  quiet(a);
  a.state.library = [
    { id: 'x', savedAt: 2, hasBrilliant: true },
    { id: 'y', savedAt: 1, hasBrilliant: false },
    { id: 'z', savedAt: 3 },
  ];
  a.state.libSort = 'brilliant';
  const ids = [...a.call('libRecords')].map((r) => r.id);
  assert.deepEqual(ids, ['x']);
});

test('rescan persists hasBrilliant and the filter then lists the game', async t => {
  const a = app(t);
  quiet(a);
  savedGame(a, '1. e4 e5 2. Nf3 Nc6 1-0', '222');
  await a.call('saveToLibrary');
  assert.equal(!!a.state.library[0].hasBrilliant, false, 'a new save starts unflagged');

  // Deterministic stand-in for the real classifier: mark ply 1 as brilliant.
  a.replace('classifyLine', (state) => { state.classif = new Array(state.total + 1).fill(null); state.classif[1] = 'brilliant'; });
  const res = await a.call('rescanLibraryForBrilliants');
  assert.equal(res.scanned, 1);
  assert.equal(res.updated, 1);
  assert.equal(a.state.library[0].hasBrilliant, true, 'the flag must be written back to storage');

  a.state.libSort = 'brilliant';
  assert.deepEqual([...a.call('libRecords')].map((r) => r.id), ['222']);
});