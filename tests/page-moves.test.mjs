import test from 'node:test';
import assert from 'node:assert/strict';

import { sanMovesToPgn, cleanSanToken } from '../lib/page-moves.js';

test('rebuilds a PGN from the SAN a game page shows', () => {
  const pgn = sanMovesToPgn(['d4', 'g5', 'Nf3', 'Bg7'], { White: 'Guest1', Black: 'Guest2', Result: '1-0' });
  assert.match(pgn, /\[White "Guest1"\]/);
  assert.match(pgn, /\[Black "Guest2"\]/);
  assert.match(pgn, /\[Result "1-0"\]/);
  assert.match(pgn, /1\. d4 g5 2\. Nf3 Bg7/);
});

test('accepts one whitespace-separated string and ignores numbers, clocks and the result token', () => {
  const pgn = sanMovesToPgn('1. e4 0.1s e5 5.7s 2. Nf3 Nc6 1/2-1/2', { White: 'A', Black: 'B', Result: '1/2-1/2' });
  assert.match(pgn, /1\. e4 e5 2\. Nf3 Nc6/);
  assert.match(pgn, /\[Result "1\/2-1\/2"\]/);
});

test('reads castling and a promotion', () => {
  const moves = ['e4', 'd5', 'exd5', 'c6', 'dxc6', 'Nf6', 'cxb7', 'a6', 'bxa8=Q'];
  const pgn = sanMovesToPgn(moves, { White: 'A', Black: 'B' });
  assert.match(pgn, /bxa8=Q/);
  const castled = sanMovesToPgn(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O'], { White: 'A', Black: 'B' });
  assert.match(castled, /4\. O-O/);
});

test('annotation glyphs on a token are stripped, not treated as a different move', () => {
  assert.equal(cleanSanToken('Nf3!'), 'Nf3');
  assert.equal(cleanSanToken(' Qxd8+? '), 'Qxd8+');
  assert.match(sanMovesToPgn(['e4!', 'e5?!', 'Nf3'], {}), /1\. e4 e5 2\. Nf3/);
});

test('skips an unplayable move instead of failing the whole import', () => {
  const pgn = sanMovesToPgn(['e4', 'e5', 'Nf3', 'Nf3'], {});
  assert.match(pgn, /1\. e4 e5 2\. Nf3/);
});

test('refuses an empty move list', () => {
  assert.throws(() => sanMovesToPgn([], {}), /empty/);
  assert.throws(() => sanMovesToPgn('1-0', {}), /empty/);
});
