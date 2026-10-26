import test from 'node:test';
import assert from 'node:assert/strict';
import { app, loadGame, branch, settle, fakeEngine } from './helpers/app.mjs';

// Explore board parked on a custom promotion position.
function promoBoard(t, fen = '8/P6k/8/8/8/8/8/K7 w - - 0 1', flipped = false) {
  const a = app(t); loadGame(a, '1. e4 e5'); branch(a); a.state.meta = { explore: true };
  a.call('computeDerived'); a.call('buildUI'); a.call('renderAll');
  a.state.liveEngine = fakeEngine();
  const v = a.state.variation; v.positions = [{ fen, san: null, eval: null, best: null }]; v.idx = 0;
  if (flipped) { a.state.flipped = true; a.call('buildBoard'); }
  return a;
}
const picker = (a) => a.dom.window.document.querySelector('.promo-picker');
const key = (a, k) => a.dom.window.document.dispatchEvent(new a.dom.window.KeyboardEvent('keydown', { key: k }));

test('reaching the last rank opens a 4-piece panel instead of auto-queening', async t => {
  const a = promoBoard(t);
  a.call('applyUserMove', 'a7', 'a8', false); await settle();
  assert.ok(picker(a), 'panel is shown');
  assert.deepEqual([...picker(a).querySelectorAll('.promo-opt')].map(b => b.dataset.piece), ['q', 'n', 'r', 'b']);
  assert.equal(a.state.variation.positions.length, 1, 'no move is made until a piece is chosen');
});

test('choosing a piece plays that promotion (including underpromotion)', async t => {
  const a = promoBoard(t);
  a.call('applyUserMove', 'a7', 'a8', false); await settle();
  picker(a).querySelector('[data-piece="n"]').click(); await settle();
  const pos = a.state.variation.positions.at(-1);
  assert.equal(pos.promotion, 'n'); assert.match(pos.san, /^a8=N/);
  assert.equal(picker(a), null, 'panel closes after the choice');
});

test('keyboard picks a piece and Escape cancels without moving', async t => {
  const a = promoBoard(t);
  a.call('applyUserMove', 'a7', 'a8', false); await settle();
  key(a, 'r'); await settle();
  assert.equal(a.state.variation.positions.at(-1).promotion, 'r');
  const b = promoBoard(t);
  b.call('applyUserMove', 'a7', 'a8', false); await settle();
  key(b, 'Escape'); await settle();
  assert.equal(picker(b), null); assert.equal(b.state.variation.positions.length, 1);
  assert.equal(b.state.analysisMode, true, 'Escape only closes the panel, it does not leave Explore');
});

test('clicking the dimmed board outside the panel cancels', async t => {
  const a = promoBoard(t);
  a.call('applyUserMove', 'a7', 'a8', false); await settle();
  picker(a).dispatchEvent(new a.dom.window.Event('pointerdown', { bubbles: true, cancelable: true }));
  assert.equal(picker(a), null); assert.equal(a.state.variation.positions.length, 1);
});

test('panel sits on the promotion file and flips with the board', async t => {
  const white = promoBoard(t); white.call('applyUserMove', 'a7', 'a8', false); await settle();
  let panel = picker(white).querySelector('.promo-panel');
  assert.equal(panel.style.left, '0%'); assert.equal(panel.style.top, '0%'); assert.ok(!panel.classList.contains('from-bottom'));
  const black = promoBoard(t, '7k/8/8/8/8/8/p7/4K3 b - - 0 1'); black.call('applyUserMove', 'a2', 'a1', false); await settle();
  panel = picker(black).querySelector('.promo-panel');
  assert.equal(panel.style.left, '0%'); assert.equal(panel.style.top, '50%'); assert.ok(panel.classList.contains('from-bottom'));
  const flipped = promoBoard(t, '8/P6k/8/8/8/8/8/K7 w - - 0 1', true); flipped.call('applyUserMove', 'a7', 'a8', false); await settle();
  panel = picker(flipped).querySelector('.promo-panel');
  assert.equal(panel.style.left, '87.5%'); assert.equal(panel.style.top, '50%'); assert.ok(panel.classList.contains('from-bottom'));
});

test('capture-promotions and ordinary moves behave correctly', async t => {
  const a = promoBoard(t, '1n5k/P7/8/8/8/8/8/K7 w - - 0 1');
  a.call('applyUserMove', 'a7', 'b8', false); await settle();   // capture-promotion → panel on the b-file
  assert.equal(picker(a).querySelector('.promo-panel').style.left, '12.5%');
  picker(a).querySelector('[data-piece="b"]').click(); await settle();
  const pos = a.state.variation.positions.at(-1); assert.equal(pos.promotion, 'b'); assert.equal(pos.captured, 'n');
  const b = promoBoard(t, '8/8/8/8/8/8/P6k/K7 w - - 0 1');
  b.call('applyUserMove', 'a2', 'a3', false); await settle();   // not a promotion → no panel
  assert.equal(picker(b), null); assert.equal(b.state.variation.positions.at(-1).san, 'a3');
});

test('a stale pick after the position changed is ignored', async t => {
  const a = promoBoard(t);
  a.call('applyUserMove', 'a7', 'a8', false); await settle();
  const btn = picker(a).querySelector('[data-piece="q"]');
  a.state.variation.positions[0].fen = '8/8/8/8/8/8/8/K6k w - - 0 1';   // position replaced underneath the panel
  btn.click(); await settle();
  assert.equal(a.state.variation.positions.length, 1);
});
