import test from 'node:test';
import assert from 'node:assert/strict';
import { app, loadGame, fakeEngine, deferred, settle } from './helpers/app.mjs';
import { canonicalGameId, analysisCacheKey } from '../gameid.js';
import { Chess } from '../lib/chess.js';

// Every game in this file is between the SAME two players. Only the immutable platform game id
// differs — which is exactly the situation the original bug report describes.
const WHITE = 'Friend';
const BLACK = 'Me';

function quiet(a) {
  for (const name of ['paintBoard', 'renderEvalBar', 'renderMoves', 'renderPlayers', 'renderControls',
    'renderReview', 'renderStats', 'renderEngineCurrent', 'renderBestArrow', 'renderGraph', 'renderLibrary']) a.replace(name, () => {});
}

// Load a game whose identity is a real platform id (not a PGN hash) and the shared player pair.
function withGame(a, pgn, gameId) {
  const S = loadGame(a, pgn);
  S.meta = {
    gameId,
    url: `https://www.chess.com/game/live/${gameId}`,
    white: { user: WHITE },
    black: { user: BLACK },
  };
  S.players = {
    w: { name: WHITE, rating: '1600', result: '1-0' },
    b: { name: BLACK, rating: '1500', result: '0-1' },
  };
  S.meSide = 'b';
  S.acc = { w: 82, b: 68 };
  S.accElo = { w: 82, b: 68 };
  S.headers = { UTCDate: '2026.10.05', Result: '1-0' };
  S.opening = { eco: 'C20', name: 'Open game' };
  return S;
}

test('A/G: same players, different ids stay independent across several games', async t => {
  const a = app(t);
  withGame(a, '1. e4 e5 2. Nf3 Nc6 1-0', '111');
  const id1 = a.call('currentGameId');
  await a.call('saveToLibrary');
  withGame(a, '1. d4 d5 2. c4 e6 0-1', '222');
  const id2 = a.call('currentGameId');
  await a.call('saveToLibrary');

  assert.equal(id1, '111');
  assert.equal(id2, '222');
  assert.notEqual(id1, id2);
  assert.deepEqual([...a.state.library.map((r) => r.id)].sort(), ['111', '222']);
  assert.ok(a.store[analysisCacheKey('111')]);
  assert.ok(a.store[analysisCacheKey('222')]);
  assert.notEqual(a.store[analysisCacheKey('111')].pgn, a.store[analysisCacheKey('222')].pgn);
});

test('B: a cached 111 never answers a lookup for 222', t => {
  const a = app(t);
  withGame(a, '1. e4 e5 1-0', '111');
  a.store[analysisCacheKey('111')] = {
    pgn: a.state.pgn, settingsKey: a.call('analysisSettingsKey'),
    bests: a.state.bests, evals: a.state.evals,
  };
  withGame(a, '1. d4 d5 0-1', '222');
  const key222 = analysisCacheKey(a.call('currentGameId'));
  assert.notEqual(key222, analysisCacheKey('111'));
  assert.equal(a.store[key222], undefined);
  assert.equal(a.call('canRestoreAnalysis', a.store[key222] || null), false);
});

test('C/D: each game restores only its own cached analysis', async t => {
  const a = app(t);
  withGame(a, '1. e4 e5 1-0', '111'); await a.call('saveToLibrary');
  withGame(a, '1. d4 d5 0-1', '222'); await a.call('saveToLibrary');
  const s111 = a.store[analysisCacheKey('111')];
  const s222 = a.store[analysisCacheKey('222')];

  withGame(a, s111.pgn, '111');
  assert.equal(a.call('canRestoreAnalysis', a.store[analysisCacheKey('111')]), true);
  assert.equal(a.call('canRestoreAnalysis', s222), false); // 222's blob is not 111's

  withGame(a, s222.pgn, '222');
  assert.equal(a.call('canRestoreAnalysis', a.store[analysisCacheKey('222')]), true);
  assert.equal(a.call('canRestoreAnalysis', s111), false); // 111's blob is not 222's
});

test('E: navigating 111 -> 222 never carries 111 state into 222', async t => {
  const a = app(t); quiet(a); a.call('buildUI');
  const S = withGame(a, '1. e4 e5 1-0', '111');
  S.bests = ['stale', 'stale', 'stale'];
  S.evals = ['stale', 'stale', 'stale'];
  S.progress = 2;
  S.analyzing = true;
  a.replace('startAnalysis', () => {});

  await a.call('applyGame', { pgn: '1. d4 d5 0-1', meta: { gameId: '222' }, analysis: null });

  assert.equal(a.call('currentGameId'), '222');
  assert.equal(S.pgn, '1. d4 d5 0-1');
  assert.equal(S.meta.gameId, '222');
  assert.equal(S.progress, 0);
  assert.ok(S.bests.every((b) => b === null));
  assert.ok(S.evals.every((e) => e === null));
});

test('F: a late search from 111 cannot overwrite 222', async t => {
  const a = app(t); quiet(a); a.call('buildUI');
  const S = withGame(a, '1. e4 e5 1-0', '111');
  S.settings.engineWorkers = 1;
  let saved = 0;
  a.replace('saveToLibrary', () => { saved++; });
  const search = deferred();
  a.replace('createEngine', async () => fakeEngine(() => search.promise));

  const run = a.call('startAnalysis'); // batch for 111, now blocked on its first search
  await settle();

  a.replace('startAnalysis', () => {});
  await a.call('applyGame', { pgn: '1. d4 d5 0-1', meta: { gameId: '222' }, analysis: null });

  search.resolve({ score: { cp: 123 }, bestmove: 'e2e4', lines: [] }); // 111's result arrives late
  await run;

  assert.equal(saved, 0, 'a superseded game must not be written to the library');
  assert.equal(S.meta.gameId, '222');
  assert.ok(S.bests.every((b) => b === null));
  assert.ok(S.evals.every((e) => e === null));
});

test('G: many consecutive games against one opponent never collide', async t => {
  const a = app(t);
  const ids = ['9001', '9002', '9003', '9004'];
  for (const id of ids) {
    withGame(a, `1. e4 e5 ${id === '9003' ? '2. Bc4 Nf6' : '2. Nf3 Nc6'} 1-0`, id);
    await a.call('saveToLibrary');
  }
  assert.deepEqual([...a.state.library.map((r) => r.id)].sort(), [...ids].sort());
  for (const id of ids) assert.ok(a.store[analysisCacheKey(id)]);
  assert.equal(new Set(a.state.library.map((r) => r.id)).size, ids.length);
});

test('id-less pastes still get distinct PGN-derived keys', t => {
  const a = app(t);
  loadGame(a, '1. e4 e5'); a.state.meta = {};
  const k1 = a.call('currentGameId');
  loadGame(a, '1. d4 d5'); a.state.meta = {};
  const k2 = a.call('currentGameId');
  assert.match(k1, /^pgn:/);
  assert.match(k2, /^pgn:/);
  assert.notEqual(k1, k2);
});

test('search history is line-specific, so a transposition does not share a cached search', t => {
  const a = app(t);
  loadGame(a, '1. e4 e5 2. Nf3 Nc6');            // same final position…
  const h1 = a.call('searchHistory', a.state.positions, 4);
  const board = (i) => a.state.positions[i].fen.split(' ').slice(0, 4).join(' ');
  const board1 = board(4);
  loadGame(a, '1. Nf3 Nc6 2. e4 e5');            // …reached by a different move order
  const h2 = a.call('searchHistory', a.state.positions, 4);
  const board2 = board(4);
  assert.equal(board1, board2);                   // board (incl. castling/ep) is identical
  assert.deepEqual([...h1.moves], ['e2e4', 'e7e5', 'g1f3', 'b8c6']);
  assert.deepEqual([...h2.moves], ['g1f3', 'b8c6', 'e2e4', 'e7e5']);
  assert.notDeepEqual([...h1.moves], [...h2.moves]); // history (and the cache key) differs
});

test('search history is windowed for very long games so the native helper never rejects it', t => {
  const a = app(t);
  // 1200 plies of knight shuffling: legal, and longer than the helper's 1024-move limit.
  // Positions are built directly (same shape as buildPositions) — no need to load the whole UI.
  const cycle = [['g1', 'f3'], ['g8', 'f6'], ['f3', 'g1'], ['f6', 'g8']];
  const c = new Chess();
  const positions = [{ fen: c.fen(), san: null }];
  for (let i = 0; i < 1200; i++) {
    const [from, to] = cycle[i % 4];
    const mv = c.move({ from, to });
    positions.push({ fen: c.fen(), san: mv.san, from, to, promotion: '' });
  }
  const hist = (idx) => { const h = a.call('searchHistory', positions, idx); return { initialFen: h.initialFen, moves: [...h.moves] }; };

  const last = hist(1200);                                         // the final position of the game
  assert.equal(last.moves.length, 1000);
  assert.equal(last.initialFen, positions[200].fen);               // window starts from its own FEN
  const replay = new Chess(last.initialFen);                       // replaying it lands on the searched position
  for (const uci of last.moves) replay.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
  assert.equal(replay.fen(), positions[1200].fen);
  for (let i = 0; i <= 1200; i += 37) assert.ok(hist(i).moves.length <= 1000, `ply ${i} exceeds the window`);

  assert.equal(hist(10).initialFen, positions[0].fen);             // short histories keep the whole game
  assert.equal(hist(10).moves.length, 10);
  assert.equal(hist(1000).initialFen, positions[0].fen);           // exactly at the cap: untouched
  assert.equal(hist(1001).initialFen, positions[1].fen);           // one over: the window slides by one
});

test('canonical identity prefers the real game id over the PGN hash', () => {
  assert.equal(canonicalGameId({ gameId: '222', pgn: 'anything' }), '222');
  assert.equal(canonicalGameId({ gameId: 222, pgn: 'anything' }), '222'); // numbers normalise
  assert.match(canonicalGameId({ pgn: 'anything' }), /^pgn:/);
  assert.notEqual(canonicalGameId({ pgn: 'game one' }), canonicalGameId({ pgn: 'game two' }));
});
