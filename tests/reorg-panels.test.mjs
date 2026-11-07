import test from 'node:test';
import assert from 'node:assert/strict';
import { app, loadGame, settle } from './helpers/app.mjs';

// The Reorganize canvas (ported from upstream): panels can be selected (✓ or Ctrl/Cmd/Shift on a
// handle), moved or scaled as one group, the toolbar offers the snap grid, selection actions and a
// layout export. Everything is driven through real pointer events on the modules.
function reorg(t) {
  const a = app(t);
  loadGame(a, '1. e4 e5');
  a.call('computeDerived'); a.call('buildUI'); a.call('renderAll');
  a.context.innerWidth = 1920; a.context.innerHeight = 920;   // composed reference → stable boxes
  a.call('toggleReorganize');
  const doc = a.dom.window.document;
  const mod = (key) => doc.querySelector(`[data-mod="${key}"]`);
  const press = (el, type, opts = {}) => el.dispatchEvent(new a.dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...opts }));
  const selected = () => [...a.run('selectedPanelKeys()')];
  // Boxes/arrays come from the vm realm; comparing them with deepEqual needs same-realm copies.
  const clone = (value) => JSON.parse(JSON.stringify(value));
  return { a, doc, mod, press, selected, clone };
}

test('the ✓ toggle selects and unselects a panel and outlines it', t => {
  const { a, doc, mod, selected } = reorg(t);
  const moves = mod('moves');
  const toggle = moves.querySelector('.mod-select');
  assert.ok(toggle, 'every module carries a selection toggle');
  toggle.dispatchEvent(new a.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.deepEqual(selected(), ['moves']);
  assert.equal(moves.classList.contains('panel-selected'), true);
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  toggle.dispatchEvent(new a.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.deepEqual(selected(), []);
  assert.equal(moves.classList.contains('panel-selected'), false);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(doc.querySelector('.reorg-count').textContent, '0 panels selected');
});

test('Ctrl on a handle toggles the selection instead of starting a drag', t => {
  const { a, mod, press, selected, clone } = reorg(t);
  const before = clone(a.state.layout);
  press(mod('accuracy').querySelector('.mod-handle'), 'pointerdown', { ctrlKey: true, clientX: 500, clientY: 300 });
  press(a.dom.window, 'pointermove', { clientX: 560, clientY: 360 });
  press(a.dom.window, 'pointerup', { clientX: 560, clientY: 360 });
  assert.deepEqual(selected(), ['accuracy'], 'the panel joined the selection');
  assert.deepEqual(clone(a.state.layout), before, 'and nothing moved');
});

test('dragging one selected panel moves the whole group by the snapped delta', t => {
  const { a, mod, press } = reorg(t);
  a.call('selectPanels', ['moves', 'graph']);
  const before = structuredClone(a.state.layout);
  press(mod('moves').querySelector('.mod-handle'), 'pointerdown', { clientX: 100, clientY: 100 });
  press(a.dom.window, 'pointermove', { clientX: 140, clientY: 150 });
  press(a.dom.window, 'pointerup', { clientX: 140, clientY: 150 });
  const grid = a.call('layoutGridSize');
  const bounds = a.call('panelGroupBounds', before, ['moves', 'graph']);
  const dx = Math.round((bounds.x + 40) / grid) * grid - bounds.x;
  const dy = Math.round((bounds.y + 50) / grid) * grid - bounds.y;
  assert.equal(a.state.layout.moves.x, before.moves.x + dx);
  assert.equal(a.state.layout.moves.y, before.moves.y + dy);
  assert.equal(a.state.layout.graph.x, before.graph.x + dx, 'the second selected panel rides along');
  assert.equal(a.state.layout.graph.y, before.graph.y + dy);
  assert.deepEqual(a.state.layout.board, before.board, 'unselected panels stay put');
  assert.equal(a.state.layout.moves.w, before.moves.w, 'a move never resizes');
});

test('a corner grip on a selected panel scales the whole group', t => {
  const { a, mod, press } = reorg(t);
  a.call('selectPanels', ['moves', 'graph']);
  const before = structuredClone(a.state.layout);
  press(mod('moves').querySelector('.mod-resize.se'), 'pointerdown', { clientX: 500, clientY: 700 });
  press(a.dom.window, 'pointermove', { clientX: 532, clientY: 732 });
  press(a.dom.window, 'pointerup', { clientX: 532, clientY: 732 });
  assert.ok(a.state.layout.moves.w > before.moves.w, 'the dragged panel grew');
  assert.ok(a.state.layout.graph.w > before.graph.w, 'and so did the rest of the group');
  assert.ok(a.state.layout.graph.h > before.graph.h);
  const ratio = a.state.layout.graph.w / before.graph.w;
  assert.ok(Math.abs(a.state.layout.moves.w / before.moves.w - ratio) < 1e-9, 'one shared factor');
  assert.ok(Math.abs(a.state.layout.graph.scale / (before.graph.scale || 1) - ratio) < 1e-9, 'content scales with the box');
  assert.deepEqual(a.state.layout.accuracy, before.accuracy, 'unselected panels stay put');
});

test('a single-panel resize snaps the dragged edge to the grid and keeps the minimum width', t => {
  const { a, mod, press } = reorg(t);
  const before = structuredClone(a.state.layout);
  press(mod('moves').querySelector('.mod-resize.e'), 'pointerdown', { clientX: 400, clientY: 300 });
  press(a.dom.window, 'pointermove', { clientX: 430, clientY: 300 });
  press(a.dom.window, 'pointerup', { clientX: 430, clientY: 300 });
  const expected = a.call('snapPanelEdge', before.moves.x, before.moves.w, 30, a.call('modMinW', 'moves'));
  assert.equal(a.state.layout.moves.w, expected);
  assert.ok(a.state.layout.moves.w >= 170, 'never below the minimum width');
  assert.equal(a.state.layout.graph.w, before.graph.w, 'a single resize touches only its own panel');
});

test('the toolbar offers the three grid spacings and repaints the visible grid', async t => {
  const { a, doc } = reorg(t);
  const select = doc.querySelector('.reorg-grid select');
  assert.ok(select, 'the grid select is mounted');
  assert.deepEqual([...select.options].map((o) => o.value), ['16', '8', '2']);
  assert.equal(select.value, '16', 'Standard is the default');
  select.value = '8';
  select.dispatchEvent(new a.dom.window.Event('change', { bubbles: true }));
  await settle();
  assert.equal(a.state.settings.layoutGridSize, 8);
  assert.equal(a.store.settings.layoutGridSize, 8, 'the choice is persisted');
  const canvas = doc.querySelector('.stage');
  assert.equal(canvas.style.getPropertyValue('--layout-grid-size'), '8px');
  assert.equal(canvas.style.getPropertyValue('--layout-grid-major'), '32px');
  // A hand-edited storage value cannot go loose: an unknown spacing falls back to the default.
  a.state.settings.layoutGridSize = 13;
  assert.equal(a.call('layoutGridSize'), 16);
  assert.equal(a.call('snapGrid', 20), 16);
});

test('Right panels selects the side column, Clear empties it, All selects everything', t => {
  const { a, doc, selected } = reorg(t);
  const banner = doc.querySelector('.reorg-banner');
  banner.querySelector('[data-reorg=right]').click();
  const right = selected();
  assert.ok(right.includes('review'), 'the review column is right of the board');
  assert.ok(right.includes('moves') && right.includes('accuracy') && right.includes('graph'));
  assert.equal(right.includes('board'), false, 'the board itself is not part of the side column');
  assert.equal(banner.querySelector('[data-reorg=clear]').disabled, false);
  assert.match(banner.querySelector('.reorg-count').textContent, /panels selected$/);
  banner.querySelector('[data-reorg=clear]').click();
  assert.deepEqual(selected(), []);
  assert.equal(banner.querySelector('[data-reorg=clear]').disabled, true);
  banner.querySelector('[data-reorg=all]').click();
  assert.equal(selected().length, a.call('visiblePanelKeys').length);
});

test('the layout export carries the whole arrangement as JSON', async t => {
  const { a } = reorg(t);
  let blob = null;
  a.dom.window.URL.createObjectURL = (value) => { blob = value; return 'blob:test'; };
  a.dom.window.URL.revokeObjectURL = () => {};
  a.dom.window.HTMLAnchorElement.prototype.click = function () {};   // never navigate in jsdom
  a.call('selectPanels', ['moves', 'graph']);
  a.call('exportPanelLayout');
  assert.ok(blob, 'a Blob was handed to the downloader');
  // jsdom's Blob has no text(); read it the classic way.
  const text = await new Promise((resolve, reject) => {
    const reader = new a.dom.window.FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
  const data = JSON.parse(text);
  assert.equal(data.schema, 'chess-review-layout-v1');
  assert.equal(data.layoutVersion, a.run('LAYOUT_VERSION'));
  assert.equal(data.layoutMode, 'custom');
  assert.ok(data.layout.moves && data.layout.accuracy, 'the saved baseline is exported');
  assert.ok(data.displayedLayout.moves, 'and what is on screen right now');
  assert.deepEqual(data.visiblePanels.includes('moves'), true);
  assert.equal(data.accuracyExpanded, false);
  assert.equal(typeof data.viewport.width, 'number');
  assert.equal(typeof data.viewport.devicePixelRatio, 'number');
});

test('minimising keeps the drag handle and Done leaves Reorganize cleanly', t => {
  const { a, doc, selected } = reorg(t);
  const banner = doc.querySelector('.reorg-banner');
  assert.equal(banner.getAttribute('role'), 'toolbar');
  const minimize = banner.querySelector('.reorg-minimize');
  minimize.click();
  assert.equal(banner.classList.contains('is-minimized'), true);
  assert.equal(banner.querySelector('.reorg-grid').hidden, true);
  assert.equal(banner.querySelector('.reorg-actions').hidden, true);
  assert.equal(minimize.getAttribute('aria-expanded'), 'false');
  minimize.click();
  assert.equal(banner.querySelector('.reorg-grid').hidden, false);
  a.call('selectPanels', ['moves']);
  banner.querySelector('.reorg-done').click();
  assert.equal(a.state.reorganize, false);
  assert.equal(doc.querySelector('.reorg-banner'), null, 'the toolbar is removed');
  assert.deepEqual(selected(), [], 'the selection is dropped with the mode');
});

test('a selection survives a grid change but not leaving the mode', async t => {
  const { a, selected } = reorg(t);
  a.call('selectPanels', ['moves', 'accuracy']);
  await a.call('setLayoutGridSize', 2);
  assert.deepEqual(selected(), ['moves', 'accuracy']);
  a.call('toggleReorganize');
  a.call('toggleReorganize');
  assert.deepEqual(selected(), []);
});
