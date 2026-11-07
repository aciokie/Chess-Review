import test from 'node:test';
import assert from 'node:assert/strict';
import { panelGroupBounds, scalePanelGroup, movePanelGroup } from '../lib/panel-layout.js';

// The Reorganize canvas moves/scales a selection as one unit (ported from upstream's
// lib/panel-layout.js). These functions are pure: the gesture applies them to the boxes it froze
// when the drag began, so every pointer move recomputes from the same start.
const layout = () => ({
  moves: { x: 100, y: 200, w: 300, h: 400, scale: 1 },
  accuracy: { x: 420, y: 200, w: 200, h: 600, scale: .5 },
  graph: { x: 100, y: 620, w: 520, h: 150 },
});

test('the group bounds cover every named panel', () => {
  assert.deepEqual(panelGroupBounds(layout(), ['moves', 'accuracy']), { x: 100, y: 200, w: 520, h: 600 });
  assert.deepEqual(panelGroupBounds(layout(), ['moves']), { x: 100, y: 200, w: 300, h: 400 });
  assert.equal(panelGroupBounds(layout(), ['missing']), null);
});

test('a group move shifts every member by the same delta and leaves the rest alone', () => {
  const out = movePanelGroup(layout(), ['moves', 'graph'], 40, -20);
  assert.deepEqual(out.moves, { x: 140, y: 180, w: 300, h: 400, scale: 1 });
  assert.deepEqual(out.graph, { x: 140, y: 600, w: 520, h: 150 });
  assert.deepEqual(out.accuracy, layout().accuracy, 'unselected panels are untouched');
});

test('a group move stops at the canvas origin instead of clipping', () => {
  const out = movePanelGroup(layout(), ['moves', 'graph'], -500, -1000);
  assert.equal(out.moves.x, 0, 'the group may not cross the origin, so x moves by -100 at most');
  assert.equal(out.moves.y, 0, 'y moves by -200 at most');
  assert.equal(out.graph.y, out.moves.y + 420, 'the members keep their relative offsets');
});

test('a group scale grows every box and its content scale about the group corner', () => {
  const out = scalePanelGroup(layout(), ['moves', 'accuracy'], 2);
  assert.deepEqual(out.moves, { x: 100, y: 200, w: 600, h: 800, scale: 2 });
  assert.deepEqual(out.accuracy, { x: 740, y: 200, w: 400, h: 1200, scale: 1 });
  assert.deepEqual(out.graph, layout().graph, 'unselected panels are untouched');
});

test('the scale factor is clamped so no member leaves the 0.25–4 range', () => {
  const out = scalePanelGroup(layout(), ['moves', 'accuracy'], 100);
  assert.equal(out.moves.scale, 4, 'a scale-1 box may only grow fourfold');
  assert.equal(out.accuracy.scale, 2, 'the factor is shared, so the .5 box lands at half of it');
  const shrunk = scalePanelGroup(layout(), ['moves', 'accuracy'], 0.01);
  assert.equal(shrunk.accuracy.scale, .25, 'the smallest member sets the floor');
  assert.ok(Math.abs(shrunk.moves.scale - .5) < 1e-9);
});
