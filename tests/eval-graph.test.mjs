import test from 'node:test';
import assert from 'node:assert/strict';
import { app, loadGame } from './helpers/app.mjs';

// Workers return positions out of order, so the graph must draw whatever has come back and leave the
// still-pending positions empty. Stopping at the first gap hid every later result behind one slow
// search (upstream 2d40eb33).
function graph(t, { style = 'line', design = 'original', evals } = {}) {
  const a = app(t);
  loadGame(a, '1. e4 e5 2. Nf3 Nc6');
  const S = a.state;
  S.evals = evals || [{ cp: 0 }, { cp: 50 }, null, null, { cp: -30 }];
  S.bests = S.positions.map(() => ({ bestmove: 'a1a1', score: { cp: 0 }, lines: [] }));
  S.settings.graphStyle = style;
  S.settings.graphDesign = design;
  a.call('computeDerived');
  a.call('buildUI');
  a.call('renderGraph');
  const svg = a.dom.window.document.querySelector('#graphMount .evalgraph svg');
  return { a, svg, paths: [...svg.querySelectorAll('path')].map((p) => p.getAttribute('d')).join(' ') };
}

test('the eval curve keeps drawing after a pending position instead of stopping at the gap', t => {
  const { svg, paths } = graph(t);
  assert.equal((paths.match(/M/g) || []).length, 2, 'one segment before the gap and one after it');
  // The isolated result at ply 4 is drawn as a visible sliver, so it cannot disappear entirely.
  const runs = paths.split('M').slice(1);
  assert.match(runs[1], /^[\d.]+,[\d.]+ L[\d.]+,[\d.]+$/, 'the lone result is a two-point sliver');
  assert.ok(svg.querySelector('.eval-hover'), 'the hover marker is still mounted');
});

test('a complete review draws a single unbroken curve', t => {
  const { paths } = graph(t, { evals: [{ cp: 0 }, { cp: 30 }, { cp: -20 }, { cp: 10 }, { cp: 0 }] });
  assert.equal((paths.match(/M/g) || []).length, 1);
});

test('the colour style fills each run separately and leaves pending positions unpainted', t => {
  const { svg, paths } = graph(t, { style: 'color' });
  // White field, black field and the boundary all follow the runs.
  assert.equal((paths.match(/M/g) || []).length, 6, 'three paths of two runs each');
  assert.equal(svg.querySelector('rect[fill="#f4f2ea"]'), null, 'no full-canvas white background');
});

test('nothing is drawn before the first evaluation arrives', t => {
  const { paths } = graph(t, { evals: [null, null, null, null, null] });
  assert.equal(paths, '', 'no curve at all');
});

test('the default design is the Move bars: one column per evaluated position plus the readout', t => {
  const { a, svg } = graph(t, { design: 'bars3' });
  assert.equal(svg.querySelectorAll('rect.evaluation-column').length, 3, 'only evaluated positions get a bar');
  assert.ok(svg.querySelector('.evaluation-position-guide'), 'the bars3 position guide is drawn');
  assert.ok(a.dom.window.document.querySelector('.evaluation-panel.evaluation-bars3'), 'the design class is set');
  const readout = a.dom.window.document.querySelector('.evaluation-score');
  assert.ok(readout, 'the score readout exists');
  assert.match(readout.textContent, /[0-9—M]/, 'the readout shows a score (or a dash while pending)');
  const chart = a.dom.window.document.querySelector('.evalgraph[role="slider"]');
  assert.ok(chart, 'the plot is a slider for keyboard users');
  assert.ok(a.dom.window.document.querySelector('.evaluation-position-marker'), 'the bars position marker is mounted');
});

test('bars4 colours the columns by move category', t => {
  const { a, svg } = graph(t, { design: 'bars4', evals: [{ cp: 0 }, { cp: 50 }, { cp: -20 }, { cp: 10 }, { cp: 0 }] });
  a.state.classif = { 1: 'brilliant', 2: 'mistake' };
  a.call('renderGraph');
  const coloured = [...a.dom.window.document.querySelectorAll('rect.evaluation-column')].filter((r) => r.hasAttribute('data-category'));
  assert.ok(coloured.length >= 1, 'at least one column carries its category colour');
});

test('the timeline design draws the area and curve classes', t => {
  const { svg } = graph(t, { design: 'timeline' });
  assert.ok(svg.querySelector('.evaluation-curve'), 'the curve is drawn');
  assert.ok(svg.querySelector('.evaluation-area'), 'the area fill is drawn');
});

test('arrow keys move through the game while the plot is focused', t => {
  const { a } = graph(t, { design: 'bars3' });
  const { document, KeyboardEvent } = a.dom.window;
  const chart = document.querySelector('.evalgraph[role="slider"]');
  const start = a.state.idx;
  chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.ok(a.state.idx > start, `idx moved from ${start} to ${a.state.idx}`);
  chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  assert.equal(a.state.idx, 0, 'Home returns to the start');
});
