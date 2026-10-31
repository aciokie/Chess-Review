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
});

test('resigning hands the finished game to the normal review and saves it to the library', async t => {
  const a = liveBoard(t);
  const S = a.state;
  a.call('applyUserMove', 'e2', 'e4', false); await settle();
  a.call('applyUserMove', 'e7', 'e5', false); await settle();
  const plies = S.total;
  // jsdom cannot build the sidebar dropdowns; the library write itself is what matters here.
  a.replace('renderLibrary', () => {});
  // Stub only the batch search: the hand-off is what is under test here, and the finished game then
  // goes through the ordinary save guard (completed analysis, no errors).
  a.replace('startAnalysis', () => {
    const s = a.state;
    s.evals = s.positions.map(() => ({ cp: 0 }));
    s.bests = s.positions.map(() => ({ bestmove: 'a1a1', score: { cp: 0 }, lines: [] }));
    s.analyzing = false; s.progress = s.total;
    a.call('computeDerived');
    a.call('saveToLibrary');
  });
  a.call('resignLive', 'b');
  assert.equal(S.meta.liveOver, true);
  assert.equal(S.meta.liveEnd, 'resign');
  assert.equal(S.meta.result, '1-0', 'Black resigned, so White wins');
  assert.equal(S.headers.Result, '1-0');
  assert.equal(a.call('isLiveBoard'), false, 'the game is over');
  assert.equal(S.total, plies, 'the finished game keeps its moves');
  assert.equal(S.analyzing, true, 'the finished game is analyzed like any review');
  await settle();

  const library = a.store.library || [];
  assert.equal(library.length, 1);
  const rec = library[0];
  assert.equal(rec.result, 'win');
  assert.equal(rec.plies, plies);
  assert.match(rec.pgn, /\[Result "1-0"\]/);
  assert.match(rec.pgn, /1\. e4 e5 1-0/);
  assert.equal(rec.meta.live, true);
  assert.equal(rec.meta.liveOver, true);
  assert.ok(a.store[analysisCacheKey(rec.id)], 'the analysis blob is stored with the game');
  // The finished game reads as a review, with the result in the header chips.
  const chips = a.dom.window.document.getElementById('meta').textContent;
  assert.match(chips, /White wins/);
  assert.equal(a.dom.window.document.querySelectorAll('.player-strip .live-resign').length, 0);
});

test('checkmate ends the live game without waiting for a resign', async t => {
  const a = liveBoard(t);
  const S = a.state;
  a.replace('startAnalysis', () => {});       // the finished review itself is covered above
  const moves = [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']];
  for (const [from, to] of moves) { a.call('applyUserMove', from, to, false); await settle(); }
  assert.equal(S.total, 4);
  assert.equal(S.meta.liveOver, true);
  assert.equal(S.meta.liveEnd, 'checkmate');
  assert.equal(S.meta.result, '0-1', 'White is mated, so Black wins');
  assert.equal(S.headers.Result, '0-1');
  assert.match(S.pgn, /Qh4# 0-1/);
  assert.equal(a.call('isLiveBoard'), false);
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
