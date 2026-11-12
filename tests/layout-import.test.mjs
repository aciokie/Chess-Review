import test from 'node:test';
import assert from 'node:assert/strict';
import { app, loadGame } from './helpers/app.mjs';

// The export/import round trip: a file written by exportPanelLayout() reads back whole, a file that
// is not a layout is refused whole, and panels missing from a valid file keep their current box.
// Layout objects cross the vm boundary, so comparisons go through JSON (prototypes differ per realm).
function withLayout(t) {
  const a = app(t);
  loadGame(a, '1. e4 e5');
  a.call('computeDerived'); a.call('buildUI'); a.call('renderAll');
  a.state.layout = a.run('structuredClone(DEFAULT_LAYOUT)');
  a.state.layoutMode = 'custom';
  return a;
}
const snapshot = (a) => JSON.stringify(a.state.layout);

test('parsePanelLayout accepts an exported file and keeps missing panels', (t) => {
  const a = withLayout(t);
  const before = JSON.parse(snapshot(a));
  const imported = a.call('parsePanelLayout', {
    schema: 'chess-review-layout-v1', layoutMode: 'custom',
    layout: { moves: { x: 10, y: 20, w: 300, h: 400, scale: 0.9 } },
  });
  assert.ok(imported);
  assert.equal(imported.layoutMode, 'custom');
  assert.deepEqual(JSON.parse(JSON.stringify(imported.layout.moves)), { x: 10, y: 20, w: 300, h: 400, scale: 0.9 });
  assert.deepEqual(JSON.parse(JSON.stringify(imported.layout.accuracy)), before.accuracy, 'a panel missing from the file keeps its current box');
  // A box for a panel this build has no module for is ignored, not copied in.
  const extra = a.call('parsePanelLayout', { schema: 'chess-review-layout-v1', layout: { ghost: { x: 0, y: 0, w: 10, h: 10 }, moves: { x: 1, y: 2, w: 30, h: 40 } } });
  assert.ok(extra);
  assert.equal(Object.hasOwn(extra.layout, 'ghost'), false);
  // A file with no box this build knows is refused (it would change nothing).
  assert.equal(a.call('parsePanelLayout', { schema: 'chess-review-layout-v1', layout: { ghost: { x: 0, y: 0, w: 10, h: 10 } } }), null);
  // An export with no layoutMode falls back to the automatic composition, never to custom.
  const auto = a.call('parsePanelLayout', { schema: 'chess-review-layout-v1', layout: { moves: { x: 1, y: 2, w: 30, h: 40 } } });
  assert.equal(auto.layoutMode, 'auto');
});

test('a file that is not a layout is refused whole', (t) => {
  const a = withLayout(t);
  const before = snapshot(a);
  assert.equal(a.call('parsePanelLayout', null), null);
  assert.equal(a.call('parsePanelLayout', {}), null);
  assert.equal(a.call('parsePanelLayout', { schema: 'other', layout: {} }), null);
  assert.equal(a.call('parsePanelLayout', { schema: 'chess-review-layout-v1', layout: { moves: { x: 0, y: 0, w: 0, h: 10 } } }), null, 'a non-positive box is invalid');
  assert.equal(a.call('parsePanelLayout', { schema: 'chess-review-layout-v1', layout: { moves: { x: '1', y: 0, w: 10, h: 10 } } }), null);
  assert.equal(a.call('parsePanelLayout', { schema: 'chess-review-layout-v1', layout: { moves: { x: 1, y: 2, w: 30, h: 40, scale: -1 } } }), null);
  assert.equal(snapshot(a), before, 'a refused file never becomes the layout');
});

test('applyPanelLayout applies the boxes and the mode', async (t) => {
  const a = withLayout(t);
  const ok = await a.call('applyPanelLayout', {
    schema: 'chess-review-layout-v1', layoutMode: 'custom',
    layout: { moves: { x: 12, y: 34, w: 300, h: 400 }, graph: { x: 12, y: 440, w: 300, h: 160, scale: 0.8 } },
  });
  assert.equal(ok, true);
  assert.equal(a.state.layoutMode, 'custom');
  assert.equal(a.state.layout.moves.x, 12);
  assert.equal(a.state.layout.graph.scale, 0.8);
  // The imported boxes are on the canvas.
  const mod = a.dom.window.document.querySelector('[data-mod="moves"]').style;
  assert.equal(mod.left, '12px');
  assert.equal(mod.top, '34px');
  // An import marks a premade interface setup Custom — it no longer describes the arrangement.
  a.state.settings.uiSetup = 'modern';
  await a.call('applyPanelLayout', {
    schema: 'chess-review-layout-v1', layoutMode: 'custom',
    layout: { moves: { x: 22, y: 34, w: 300, h: 400 } },
  });
  assert.equal(a.state.settings.uiSetup, 'custom');
  // A refused file leaves the arrangement untouched.
  const before = snapshot(a);
  assert.equal(await a.call('applyPanelLayout', { schema: 'nope' }), false);
  assert.equal(snapshot(a), before);
});
