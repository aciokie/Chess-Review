import test from 'node:test';
import assert from 'node:assert/strict';
import { app, settle, fakeEngine } from './helpers/app.mjs';
import { analysisCacheKey } from '../gameid.js';

// A live board is an ordinary game that starts empty and grows one move at a time: every played
// move is appended to the mainline, so the review panels (eval graph, accuracy, Elo estimate and
// the three phase estimates) come from the normal pipeline, and a finished game is handed back to
// applyGame() for a full review and a library save.
function liveBoard(t, { engine } = {}) {
  const a = app(t, { url: 'https://extension.test/analysis.html#live' });
  const S = a.state;
  const payload = a.call('freshLivePayload');
  S.pgn = payload.pgn;
  S.meta = payload.meta;
  S.headers = a.call('parseHeaders', payload.pgn);
  S.clocks = a.call('parseClocks', payload.pgn);
  S.positions = a.call('buildPositions', payload.pgn);
  S.total = S.positions.length - 1;
  S.evals = new Array(S.total + 1).fill(null);
  S.bests = new Array(S.total + 1).fill(null);
  S.players = a.call('derivePlayers', S.headers, S.meta, '').players;
  S.meSide = 'w'; S.flipped = false; S.idx = 0; S.analyzing = false;
  S.live = { ...payload.meta.liveCfg };
  a.call('buildUI');
  a.call('computeDerived');
  a.call('renderAll');
  S.liveEngine = engine || fakeEngine();
  return a;
}

test('a new live board is an empty game with review-ready headers', t => {
  const a = app(t, { url: 'https://extension.test/analysis.html#live' });
  const payload = a.call('freshLivePayload');
  assert.equal(payload.meta.live, true);
  assert.equal(payload.meta.liveOver, undefined, 'a fresh board is still in progress');
  assert.equal(payload.source, 'live');
  // The headers a reviewed game needs, and a movetext that is only the open result.
  for (const tag of ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result']) {
    assert.match(payload.pgn, new RegExp(`^\\[${tag} "`, 'm'), `${tag} header`);
  }
  assert.match(payload.pgn, /\[Result "\*"\]/);
  assert.equal(payload.pgn.trim().endsWith('*'), true);
  assert.equal(a.call('buildPositions', payload.pgn).length, 1, 'the game has no moves yet');
});

test('the live PGN is numbered move text with the Result stamped in', t => {
  const a = app(t);
  const positions = a.call('buildPositions', '[Result "*"]\n\n1. e4 e5 2. Nf3 Nc6\n');
  const text = a.call('livePgnText', { white: 'Ann "A"', black: 'Bob', date: '2026.01.02' }, positions, '1-0');
  assert.match(text, /\[White "Ann 'A'"\]/, 'quotes are escaped, never breaking the header');
  assert.match(text, /\[Date "2026\.01\.02"\]/);
  assert.match(text, /\[Result "1-0"\]/);
  assert.match(text, /\n\n1\. e4 e5 2\. Nf3 Nc6 1-0\n$/);
  // The same builder produces the open result while the game is still running.
  assert.match(a.call('livePgnText', {}, positions, '*'), /2\. Nf3 Nc6 \*\n$/);
  assert.equal(a.call('buildPositions', text).length, 5, 'the text round-trips through the parser');
});

test('only a move at the end of the line is played into the game', async t => {
  const a = liveBoard(t, { engine: fakeEngine(async () => ({ score: { cp: 30 }, bestmove: 'e7e5', lines: [] })) });
  const S = a.state;
  a.call('applyUserMove', 'e2', 'e4', false);
  await settle();
  assert.equal(S.analysisMode, false, 'a live move never opens a variation');
  assert.equal(S.variation, null);
  assert.equal(S.total, 1);
  assert.equal(S.positions[1].san, 'e4');
  assert.equal(S.idx, 1, 'the board stays on the position it just played');
  assert.match(S.pgn, /1\. e4/);
  assert.equal(S.headers.Result, '*', 'the game is still open');
  // The move's search ran and the review panels scored it.
  assert.ok(S.bests[1], 'the engine line for the new position is stored');
  assert.equal(S.evals[1].cp, -30, 'engine scores are stored White-relative');
  assert.ok(Number.isFinite(S.acc.w), 'live accuracy is available');
  assert.ok(S.evals.length === S.total + 1 && S.bests.length === S.total + 1);
});

test('a move from an earlier ply is a review variation and leaves the game alone', async t => {
  const a = liveBoard(t);
  const S = a.state;
  a.call('applyUserMove', 'e2', 'e4', false);
  await settle();
  a.call('go', 0);
  a.call('applyUserMove', 'd2', 'd4', false);
  await settle();
  assert.equal(S.analysisMode, true, 'reviewing the game must not end it');
  assert.equal(S.variation.branchIdx, 0);
  assert.equal(S.variation.positions.at(-1).san, 'd4');
  assert.equal(S.total, 1, 'the mainline did not grow');
  assert.doesNotMatch(S.pgn, /d4/);
  assert.equal(a.call('isLiveBoard'), true);
});

test('the live board carries the eval graph, live ratings, phases and a Resign per side', async t => {
  const a = liveBoard(t);
  const { document } = a.dom.window;
  const resigns = [...document.querySelectorAll('.player-strip .live-resign')];
  assert.equal(resigns.length, 2, 'one at the top and one at the bottom of the board');
  assert.deepEqual(resigns.map((b) => b.title), ['Resign as Black', 'Resign as White'],
    'the top strip is Black while the board is unflipped');
  assert.ok(resigns.every((b) => b.disabled), 'nothing to resign before a move is played');

  a.call('applyUserMove', 'e2', 'e4', false);
  await settle();

  const after = [...document.querySelectorAll('.player-strip .live-resign')];
  assert.ok(after.every((b) => !b.disabled), 'both sides may resign once the game started');
  assert.equal(document.querySelectorAll('.player-strip .live-elo').length, 2, 'a live rating per player');
  assert.ok(document.querySelectorAll('.player-strip .live-elo')[0].textContent.trim().length);
  assert.equal(document.querySelector('#graphMount').closest('.mod').hidden, false, 'the eval graph is shown');
  assert.ok(document.querySelector('#graphMount .evalgraph'), 'the graph is drawn');
  assert.equal(document.querySelectorAll('.phase-line').length, 2, 'opening / middlegame / endgame per side');
  assert.match(document.getElementById('meta').textContent, /Live/);
  assert.ok(document.querySelectorAll('.acc-val').length >= 2);
});

test('the board badge and the best-move arrow appear as soon as the live search answers', async t => {
  const startFen = 'rnbqkbnr/pppppppp';
  const a = liveBoard(t, { engine: fakeEngine(async (fen) => ({
    score: { cp: 30 },
    bestmove: fen.startsWith(startFen) ? 'e2e4' : 'e7e5',
    lines: [],
  })) });
  const S = a.state;
  a.call('applyUserMove', 'e2', 'e4', false);
  await settle();
  assert.equal(S.classif[1], 'best', 'White played the engine move');
  const { document } = a.dom.window;
  // e4 is the destination square of ply 1 on an unflipped board.
  const e4 = document.querySelectorAll('.sq')[(8 - 4) * 8 + 4];
  assert.ok(e4.classList.contains('has-badge'), 'the destination square carries the category badge');
  assert.equal(e4.querySelectorAll('.sq-badge').length, 1);
  // A review board suppresses the arrow when the move played was the engine's own choice; the live
  // board is an analysis board being played and keeps showing the position's best move.
  assert.ok(document.querySelector('.board svg.best-arrow'), 'the arrow is drawn on the live board');
});

test('a normal review of a finished game has no live controls', t => {
  const a = app(t);
  const S = a.state;
  S.pgn = '1. e4 e5';
  S.meta = {};
  S.headers = a.call('parseHeaders', S.pgn);
  S.positions = a.call('buildPositions', S.pgn);
  S.total = S.positions.length - 1;
  S.evals = S.positions.map(() => ({ cp: 0 }));
  S.bests = S.positions.map(() => ({ bestmove: 'a1a1', score: { cp: 0 }, lines: [] }));
  S.players = a.call('derivePlayers', S.headers, S.meta, '').players;
  a.call('buildUI'); a.call('computeDerived'); a.call('renderAll');
  const { document } = a.dom.window;
  assert.equal(document.querySelectorAll('.player-strip .live-resign').length, 0);
  assert.equal(document.querySelectorAll('.player-strip .live-elo').length, 0);
  assert.equal(document.getElementById('graphFoot').hidden, true, 'no end-of-game choice for a review');
});

test('a finished live game waits on the board and only the player starts the formal review', async t => {
  const a = liveBoard(t);
  const S = a.state;
  const { document } = a.dom.window;
  a.call('applyUserMove', 'e2', 'e4', false); await settle();
  a.call('applyUserMove', 'e7', 'e5', false); await settle();
  const plies = S.total;
  // jsdom cannot build the sidebar dropdowns; the library write itself is what matters here.
  a.replace('renderLibrary', () => {});
  // Stub only the batch search: the hand-off is what is under test, and the finished game then goes
  // through the ordinary save guard (completed analysis, no errors).
  let reviews = 0;
  a.replace('startAnalysis', () => {
    reviews++;
    const s = a.state;
    s.evals = s.positions.map(() => ({ cp: 0 }));
    s.bests = s.positions.map(() => ({ bestmove: 'a1a1', score: { cp: 0 }, lines: [] }));
    s.analyzing = false; s.progress = s.total;
    a.call('computeDerived');
    a.call('saveToLibrary');
  });

  a.call('resignLive', 'b');
  // Nothing is forced on the player: the stamped game just stays here.
  assert.equal(S.meta.liveOver, true);
  assert.equal(S.meta.liveEnd, 'resign');
  assert.equal(S.meta.result, '1-0', 'Black resigned, so White wins');
  assert.equal(S.headers.Result, '1-0');
  assert.equal(a.call('isLiveBoard'), false, 'the game is over');
  assert.equal(S.total, plies, 'the finished game keeps its moves');
  assert.equal(S.analyzing, false, 'no analysis was started');
  assert.equal(reviews, 0, 'the formal review did not start on its own');
  assert.equal((a.store.library || []).length, 0, 'nothing was saved before the player decided');
  assert.equal(document.querySelectorAll('.player-strip .live-resign').length, 0, 'resign is gone once the game is over');
  assert.match(document.getElementById('meta').textContent, /White wins/);
  // The choice sits under the graph.
  const foot = document.getElementById('graphFoot');
  assert.equal(foot.hidden, false);
  const btn = foot.querySelector('.gf-btn');
  assert.ok(btn, 'a button under the eval graph');
  assert.match(foot.textContent, /Resigned/);

  btn.click();
  assert.equal(S.meta.liveReviewed, true);
  assert.equal(foot.hidden, true, 'the button is gone once the review is under way');
  await settle();
  assert.equal(reviews, 1, 'the button runs the ordinary review');

  const library = a.store.library || [];
  assert.equal(library.length, 1);
  const rec = library[0];
  assert.equal(rec.result, 'win');
  assert.equal(rec.plies, plies);
  assert.match(rec.pgn, /\[Result "1-0"\]/);
  assert.match(rec.pgn, /1\. e4 e5 1-0/);
  assert.equal(rec.meta.live, true);
  assert.equal(rec.meta.liveOver, true);
  assert.equal(rec.meta.liveReviewed, true);
  assert.ok(a.store[analysisCacheKey(rec.id)], 'the analysis blob is stored with the game');
  assert.match(document.getElementById('meta').textContent, /White wins/);
});

test('checkmate ends the live game and leaves the review to the player', async t => {
  const a = liveBoard(t);
  const S = a.state;
  let reviews = 0;
  a.replace('startAnalysis', () => { reviews++; });
  const moves = [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']];
  for (const [from, to] of moves) { a.call('applyUserMove', from, to, false); await settle(); }
  assert.equal(S.total, 4);
  assert.equal(S.meta.liveOver, true);
  assert.equal(S.meta.liveEnd, 'checkmate');
  assert.equal(S.meta.result, '0-1', 'White is mated, so Black wins');
  assert.equal(S.headers.Result, '0-1');
  assert.match(S.pgn, /Qh4# 0-1/);
  assert.equal(a.call('isLiveBoard'), false);
  assert.equal(reviews, 0, 'checkmate does not drag the player into a batch analysis');
  assert.equal(S.analyzing, false);
  assert.ok(a.dom.window.document.querySelector('#graphFoot .gf-btn'), 'the player can still ask for it');
  // The mating position is scored off the board, so the graph covers the last move too.
  assert.equal(S.evals[S.total].mate, -1, 'White is mated, from the board and no engine');
  assert.ok(S.bests[S.total]);
});

test('the end-of-game button exists for a finished live game only', async t => {
  const a = liveBoard(t);
  const { document } = a.dom.window;
  const foot = document.getElementById('graphFoot');
  assert.equal(foot.hidden, true, 'nothing to decide while the game is in progress');
  a.call('applyUserMove', 'e2', 'e4', false); await settle();
  assert.equal(foot.hidden, true);
  a.call('resignLive', 'w');
  assert.equal(foot.hidden, false, 'shown the moment the game is finished');
  assert.equal(document.querySelectorAll('.player-strip .live-resign').length, 0);
  // A finished live game that was already reviewed never offers it again.
  a.state.meta.liveReviewed = true;
  a.call('renderGraph');
  assert.equal(foot.hidden, true);
});

test('undo takes back the move just played so a misclick never stays in the game', async t => {
  const a = liveBoard(t, { engine: fakeEngine(async () => ({ score: { cp: 30 }, bestmove: 'e7e5', lines: [] })) });
  const S = a.state;
  a.call('applyUserMove', 'e2', 'e4', false); await settle();
  a.call('applyUserMove', 'e7', 'e5', false); await settle();
  assert.equal(S.total, 2);
  assert.equal(S.positions.length, 3);
  assert.equal(a.call('canUndoLiveMove'), true);

  a.call('undoLiveMove');

  assert.equal(S.total, 1, 'only the last move is removed');
  assert.equal(S.positions.length, S.total + 1);
  assert.equal(S.positions.at(-1).san, 'e4');
  assert.equal(S.evals.length, S.total + 1, 'the removed ply’s evidence is gone');
  assert.equal(S.bests.length, S.total + 1);
  assert.equal(S.idx, 1, 'the board sits on the new last move');
  assert.equal(S.idx, S.total);
  assert.match(S.pgn, /1\. e4 \*/);
  assert.doesNotMatch(S.pgn, /e5/);
  assert.equal(S.headers.Result, '*', 'the game is still open');
  assert.equal(a.call('isLiveBoard'), true, 'undo never ends the game');
});

test('undo is offered only at the live tip and never once the game has ended', async t => {
  const a = liveBoard(t);
  const S = a.state;
  assert.equal(a.call('canUndoLiveMove'), false, 'nothing to undo on an empty board');
  a.call('applyUserMove', 'e2', 'e4', false); await settle();
  assert.equal(a.call('canUndoLiveMove'), true, 'the board is on the move just played');
  a.call('go', 0);
  assert.equal(a.call('canUndoLiveMove'), false, 'reviewing an earlier ply is not the live tip');
  a.call('go', S.total);
  assert.equal(a.call('canUndoLiveMove'), true);
  a.call('finishLive', '1-0', 'resign');
  assert.equal(a.call('canUndoLiveMove'), false, 'a finished game keeps its stamped result');
});

test('the live controls bar carries an undo button that is disabled until a move is played', async t => {
  const a = liveBoard(t);
  const { document } = a.dom.window;
  const button = () => document.querySelector('.controls .live-undo');
  assert.ok(button(), 'the live board has an undo button');
  assert.equal(button().disabled, true, 'nothing to undo yet');
  a.call('applyUserMove', 'e2', 'e4', false); await settle();
  assert.equal(button().disabled, false);
  button().click();
  assert.equal(a.state.total, 0, 'clicking it takes the move back');
  assert.equal(button().disabled, true, 'and is disabled again on the empty board');
});

test('the live board fetches the runner-up so Great can fire during play', async t => {
  const line = (cp, move) => ({ score: { cp }, pv: move, depth: 16, bound: 'exact', multipv: 1 });
  const root = (cp, move) => ({ score: { cp }, bestmove: move, lines: [line(cp, move)] });
  const twoLines = {
    bestmove: 'g1f3', score: { cp: 120 }, lines: [
      { score: { cp: 120 }, pv: 'g1f3', depth: 16, bound: 'exact', multipv: 1 },
      { score: { cp: -100 }, pv: 'd2d4', depth: 16, bound: 'exact', multipv: 2 },
    ],
  };
  const a = liveBoard(t, { engine: fakeEngine(async (fen, depth, count) => {
    if (count === 2) return twoLines;
    const board = fen.split(' ')[0];
    if (board === 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR') return root(0, 'e2e4');
    if (board === 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR') return root(0, 'c7c5'); // Black plays e5 anyway
    if (board === 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR') return root(120, 'g1f3');
    return root(-120, 'b8c6');
  }) });
  const S = a.state;
  a.call('applyUserMove', 'e2', 'e4', false); await settle();
  a.call('applyUserMove', 'e7', 'e5', false); await settle();
  a.call('applyUserMove', 'g1', 'f3', false); await settle();
  assert.equal(S.classif[2], 'inacc', 'Black slipped but is not across a clear-advantage line');
  assert.equal(S.classif[3], 'great', 'the live tail search now includes the runner-up');
  assert.ok(S.bests[2].annotationSearch, 'the live runner-up is kept apart from the scored line');
  assert.equal(S.bests[2].lines.length, 1, 'the scored live root is untouched');
});

test('a fully scored live board never reports an engine failure from the optional runner-up pass', async t => {
  const a = liveBoard(t, { engine: fakeEngine(async (fen) => ({
    score: { cp: 30 },
    bestmove: fen.length > 50 ? 'e2e4' : 'e7e5',
    lines: [],
  })) });
  const S = a.state;
  a.call('applyUserMove', 'e2', 'e4', false);
  await settle();
  assert.ok(S.evals[1] && S.bests[1], 'the move is scored');
  // From here the only reason to touch the engine is the annotation pass.
  a.replace('ensureLiveEngine', async () => { throw Error('engine could not start'); });
  S.liveError = null;
  await a.call('requestLiveAnalysis');
  await settle();
  assert.equal(S.liveError, null, 'a finished board keeps its analysis instead of an error');
});

test('a live tab reload resumes the game in progress, a new tab starts a fresh one', async t => {
  const a = liveBoard(t);
  a.call('applyUserMove', 'e2', 'e4', false); await settle();
  assert.equal(a.call('rememberReviewJob'), true);
  const resumed = await a.call('loadJob');
  assert.match(resumed.pgn, /1\. e4/);
  assert.equal(resumed.meta.live, true);
  assert.equal(resumed.meta.liveOver, undefined);
  // A brand new tab has no session copy, so #live opens an empty board.
  const b = app(t, { url: 'https://extension.test/analysis.html#live' });
  const fresh = await b.call('loadJob');
  assert.equal(b.call('buildPositions', fresh.pgn).length, 1);
  assert.equal(fresh.meta.live, true);
});
