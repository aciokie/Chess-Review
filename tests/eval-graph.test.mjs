import test from 'node:test';
import assert from 'node:assert/strict';
import { app, loadGame } from './helpers/app.mjs';

// Workers return positions out of order, so the graph must draw whatever has come back and leave the
// still-pending positions empty. Stopping at the first gap hid every later result behind one slow
// search (upstream 2d40eb33).
function graph(t, { style = 'line', evals } = {}) {
  const a = app(t);
  loadGame(a, '1. e4 e5 2. Nf3 Nc6');
  const S = a.state;
  S.evals = evals || [{ cp: 0 }, { cp: 50 }, null, null, { cp: -30 }];
  S.bests = S.positions.map(() => ({ bestmove: 'a1a1', score: { cp: 0 }, lines: [] }));
  S.settings.graphStyle = style;
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
