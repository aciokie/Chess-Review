import test from 'node:test';
import assert from 'node:assert/strict';
import { app, loadGame } from './helpers/app.mjs';

// Everything crossing the vm boundary is round-tripped so the comparison uses this realm's
// prototypes (a vm array has a different Array.prototype).
const plan = (a, settings, flipped = false) =>
  JSON.parse(JSON.stringify(a.call('boardFramePlan', settings, flipped)));

const base = { boardFrame: 'wood', coordsOutside: true, showCoords: true };

test('boardFramePlan draws the bezel and prints the coordinates on it', (t) => {
  const a = app(t);
  const p = plan(a, base);
  assert.equal(p.frame, 'wood');
  assert.equal(p.on, true);
  assert.equal(p.outside, true);
  assert.deepEqual(p.files, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  assert.deepEqual(p.ranks, [8, 7, 6, 5, 4, 3, 2, 1]);
});

test('a flipped board reverses the frame labels so they still name the right squares', (t) => {
  const a = app(t);
  const p = plan(a, base, true);
  assert.deepEqual(p.files, ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a']);
  assert.deepEqual(p.ranks, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('the accent frame is a frame; frame "off" is not', (t) => {
  const a = app(t);
  assert.equal(plan(a, { ...base, boardFrame: 'accent' }).on, true);
  const off = plan(a, { ...base, boardFrame: 'off' });
  assert.equal(off.on, false);
  assert.equal(off.outside, false);          // nothing to print the coordinates on
  assert.equal(plan(a, { ...base, boardFrame: 'nonsense' }).frame, 'wood');   // unknown -> default
});

test('coordinates stay in the squares when they are off or the frame is off', (t) => {
  const a = app(t);
  assert.equal(plan(a, { ...base, coordsOutside: false }).outside, false);
  assert.equal(plan(a, { ...base, showCoords: false }).outside, false);
  assert.equal(plan(a, { ...base, showCoords: false }).on, true);   // the frame itself stays
  // A missing flag reads as the default (a settings object saved before the option existed).
  assert.equal(plan(a, { boardFrame: 'wood', showCoords: true }).outside, true);
});

test('boardInner reports the playing area, not the whole frame', (t) => {
  const a = app(t);
  const stub = {
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 420, height: 420 }),
    clientLeft: 18, clientTop: 18,
  };
  assert.deepEqual(JSON.parse(JSON.stringify(a.call('boardInner', stub))),
    { left: 118, top: 68, width: 384, height: 384 });
  // With no frame border the playing area is the whole element, as before.
  const plain = { getBoundingClientRect: () => ({ left: 10, top: 20, width: 320, height: 320 }), clientLeft: 0, clientTop: 0 };
  assert.deepEqual(JSON.parse(JSON.stringify(a.call('boardInner', plain))),
    { left: 10, top: 20, width: 320, height: 320 });
});

test('the Visual panel offers the frame and only offers the on-frame coords with a frame', (t) => {
  const a = app(t);
  a.state.settings.boardFrame = 'wood';
  const withFrame = a.call('visualSettings').textContent;
  for (const label of ['Frame', 'off', 'wood', 'accent', 'Coordinates', 'On the frame', 'Size']) {
    assert.ok(withFrame.includes(label), `panel should offer ${label}`);
  }
  a.state.settings.boardFrame = 'off';
  const without = a.call('visualSettings').textContent;
  assert.ok(without.includes('Frame'));
  assert.equal(without.includes('On the frame'), false);   // nothing to print the coords on
});

test('choosing a frame saves it and restyles the board in place', async (t) => {
  const a = app(t);
  loadGame(a, '1. e4 e5');
  a.call('buildUI');
  a.call('buildBoard');
  await a.call('setSetting', 'boardFrame', 'accent');
  assert.equal(a.store.settings.boardFrame, 'accent');
  const board = a.dom.window.document.querySelector('.board');
  assert.ok(board.classList.contains('framed'));
  assert.ok(board.classList.contains('frame-accent'));
  assert.equal(a.dom.window.document.querySelectorAll('.coords-out').length, 1);
});

test('the board element carries the frame class and its labels', (t) => {
  const a = app(t);
  loadGame(a, '1. e4 e5');
  a.call('buildUI');
  a.call('buildBoard');
  const doc = a.dom.window.document;
  const texts = (sel) => [...doc.querySelectorAll(sel)].map((n) => n.textContent);

  const board = doc.querySelector('.board');
  assert.ok(board.classList.contains('framed'));
  assert.ok(board.classList.contains('frame-wood'));
  assert.ok(board.classList.contains('coords-outside'));
  assert.equal(doc.querySelectorAll('.coords-out').length, 1);
  assert.deepEqual(texts('.coords-out .co-files span'), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  assert.deepEqual(texts('.coords-out .co-ranks span'), ['8', '7', '6', '5', '4', '3', '2', '1']);

  a.state.settings.boardFrame = 'accent';
  a.call('buildBoard');
  assert.ok(doc.querySelector('.board').classList.contains('frame-accent'));
  assert.equal(doc.querySelectorAll('.coords-out').length, 1);   // replaced, never duplicated

  a.state.settings.boardFrame = 'off';
  a.call('buildBoard');
  const flat = doc.querySelector('.board');
  assert.equal(flat.classList.contains('framed'), false);
  assert.equal(flat.querySelector('.coords-out'), null);

  a.state.settings.boardFrame = 'wood';
  a.state.settings.showCoords = false;
  a.call('buildBoard');
  assert.ok(doc.querySelector('.board').classList.contains('coords-outside') === false);
  assert.equal(doc.querySelector('.board .coords-out'), null);
});
