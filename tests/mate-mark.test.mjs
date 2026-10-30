import test from 'node:test';
import assert from 'node:assert/strict';
import { app, loadGame, branch } from './helpers/app.mjs';

// Ported from upstream 406157fa ("show checkmate on the board"). The learning-board
// test is dropped (this fork removed the Learn module).
const FOOLS_MATE = '1. f3 e5 2. g4 Qh4#';

function review(t, pgn = FOOLS_MATE) {
  const a = app(t);
  loadGame(a, pgn); a.call('computeDerived');
  a.call('buildUI'); a.call('buildBoard');
  return a;
}
const squares = (a) => [...a.dom.window.document.querySelectorAll('.mate-glow')].map((n) => n.closest('.sq'));
const sqName = (a, node) => Object.entries(a.run('sqByName')).find(([, sq]) => sq === node)?.[0];

test('matedKingSquare only returns a square for checkmate', (t) => {
  const a = app(t);
  // Black to move, mated (Qg7 defended by Kg6 covers every escape).
  assert.equal(a.run("matedKingSquare(new Chess('7k/6Q1/6K1/8/8/8/8/8 b - - 0 1'))"), 'h8');
  // Plain check: black king e8 is attacked by the e7 queen but can capture it.
  assert.equal(a.run("matedKingSquare(new Chess('4k3/8/8/8/8/8/4Q3/4K3 b - - 0 1'))"), null);
  // Nothing: no king in check at all.
  assert.equal(a.run("matedKingSquare(new Chess('4k3/8/8/8/8/8/8/4K2R w K - 0 1'))"), null);
});

test('the final mated position marks the mated king with a glow and a "#" badge', (t) => {
  const a = review(t);
  a.state.idx = a.state.total; a.state.classif[a.state.idx] = 'best'; a.call('paintBoard');
  const marked = squares(a);
  assert.equal(marked.length, 1);
  assert.equal(sqName(a, marked[0]), 'e1');
  assert.ok(marked[0].querySelector('.mate-glow'));
  assert.equal(a.dom.window.document.querySelector('.mate-badge').getAttribute('aria-label'), 'Checkmate');
});

test('the mark clears when navigating away and returns on the final move', (t) => {
  const a = review(t);
  a.state.idx = a.state.total; a.call('paintBoard');
  assert.equal(squares(a).length, 1);
  a.state.idx -= 1; a.call('paintBoard');
  assert.equal(a.dom.window.document.querySelectorAll('.mate-glow, .mate-badge').length, 0);
  a.state.idx += 1; a.call('paintBoard'); a.call('paintBoard');
  assert.equal(a.dom.window.document.querySelectorAll('.mate-glow').length, 1);
});

test('the mark stays on the mated king when the board is flipped', (t) => {
  const a = review(t);
  a.state.idx = a.state.total; a.state.flipped = true; a.call('buildBoard');
  assert.equal(sqName(a, squares(a)[0]), 'e1');
});

test('a mate reached in a variation is marked, while a temporary check is not', (t) => {
  const a = review(t, '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6');
  const v = branch(a, a.state.total, 0);
  a.call('paintBoard');
  assert.equal(squares(a).length, 0);
  v.positions.push({ ...v.positions[0], fen: 'r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4', from: 'h5', to: 'f7', san: 'Qxf7#' });
  v.idx = 1; a.call('paintBoard');
  assert.equal(sqName(a, squares(a)[0]), 'e8');
  // A check that is not mate must not leave a mark behind.
  v.positions[1] = { ...v.positions[1], fen: 'rnbqkbnr/ppp2ppp/8/1B1pp3/4P3/8/PPPP1PPP/RNBQK1NR b KQkq - 1 3', from: 'f1', to: 'b5', san: 'Bb5+' };
  a.call('paintBoard');
  assert.equal(a.dom.window.document.querySelectorAll('.mate-glow, .mate-badge').length, 0);
});
