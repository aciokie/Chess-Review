import test from 'node:test';
import assert from 'node:assert/strict';
import { fullHdReferenceLayout, panelScale, DESIGN } from '../lib/full-hd-layout.js';

const box = (layout, key) => layout[key];
const right = layout => Math.max(...Object.values(layout).map(b => b.x + b.w));
const bottom = layout => Math.max(...Object.values(layout).map(b => b.y + b.h));
const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

test('small windows have no reference composition', () => {
  assert.equal(fullHdReferenceLayout(1099, 900), null);
  assert.equal(fullHdReferenceLayout(1920, 519), null);
  assert.equal(fullHdReferenceLayout(800, 600), null);
});

test('a Full HD window composes inside the viewport with no page overflow', () => {
  const l = fullHdReferenceLayout(1920, 1080);
  assert.ok(l, 'expected a composition');
  for (const [key, b] of Object.entries(l)) {
    assert.ok(b.x >= 0, `${key} starts left of the viewport`);
    assert.ok(b.y >= 0, `${key} starts above the viewport`);
    assert.ok(b.x + b.w <= 1920, `${key} overflows the right edge`);
    assert.ok(b.y + b.h <= 1080 - DESIGN.topbar, `${key} overflows the bottom edge`);
    assert.ok(b.scale > 0 && b.scale <= DESIGN.maxScale);
  }
  assert.ok(right(l) <= 1920 && bottom(l) <= 1080 - DESIGN.topbar);
});

test('the board takes the window height and stays square', () => {
  for (const [w, h] of [[1920, 920], [1920, 1080], [2560, 1440], [3440, 1200]]) {
    const l = fullHdReferenceLayout(w, h);
    const board = box(l, 'board');
    const strip = DESIGN.strip * board.scale;
    assert.ok(Math.abs((board.h - board.w) - 2 * strip) <= 1, `${w}x${h}: board is not square + strips`);
    assert.ok(board.h <= h - DESIGN.topbar, `${w}x${h}: board module taller than the stage`);
    assert.ok(board.w >= DESIGN.minBoard, `${w}x${h}: board below its minimum`);
  }
});

test('a taller window gives a bigger board and the panels keep their share', () => {
  const short = fullHdReferenceLayout(1920, 920);
  const tall = fullHdReferenceLayout(1920, 1400);
  assert.ok(box(tall, 'board').w > box(short, 'board').w);
  for (const [name, l] of [['920', short], ['1400', tall]]) {
    const board = box(l, 'board').w, side = box(l, 'review').w;
    assert.ok(side <= board * 0.75 + 30, `${name}: panels take more than their share (${side} vs ${board})`);
    assert.ok(side >= DESIGN.minSide - 1, `${name}: panels below the minimum`);
    assert.ok(box(l, 'review').scale >= DESIGN.minColScale && box(l, 'review').scale <= DESIGN.maxPanelScale,
      `${name}: panel scale out of range (${box(l, 'review').scale})`);
  }
});

test('the graph sits under the move list in the same column', () => {
  const l = fullHdReferenceLayout(1920, 1080);
  const graph = box(l, 'graph'), moves = box(l, 'moves'), controls = box(l, 'controls');
  assert.equal(graph.x, moves.x, 'graph shares the move list column');
  assert.ok(graph.y >= moves.y + moves.h, 'graph sits below the move list');
  assert.ok(controls.y >= graph.y + graph.h, 'controls sit below the graph');
  assert.ok(!overlaps(graph, moves) && !overlaps(controls, graph));
});

test('the panels are two columns about 75% of the board', () => {
  const l = fullHdReferenceLayout(1920, 1080);
  const board = box(l, 'board'), review = box(l, 'review');
  const moves = box(l, 'moves'), accuracy = box(l, 'accuracy');
  assert.ok(Math.abs(review.w - board.w * 0.75) <= 25, `panel area ${review.w} vs 75% of ${board.w}`);
  assert.ok(Math.abs(moves.w - accuracy.w) <= 2, 'the two columns are equal');
  assert.equal(box(l, 'graph').x, moves.x, 'the graph sits under the move list');
  assert.equal(box(l, 'engine').x, accuracy.x, 'the engine sits under the accuracy');
  assert.ok(accuracy.scale >= DESIGN.minColScale && accuracy.scale <= DESIGN.maxPanelScale);
});

test('the panel percentage is honoured and never overflows the window', () => {
  for (const pct of [40, 75, 120]) {
    const l = fullHdReferenceLayout(1920, 1080, { panelPct: pct });
    const board = box(l, 'board').w, side = box(l, 'review').w;
    assert.ok(right(l) <= 1920 - DESIGN.margin + 1, `${pct}%: composition overflows the window`);
    assert.ok(side >= DESIGN.minSide - 1, `${pct}%: panels below the minimum`);
    if (pct === 75) assert.ok(Math.abs(side - board * 0.75) <= 25, 'the default share is 75%');
    if (pct === 120) assert.ok(side > board * 0.75, 'raising the percentage widens the panels');
  }
});

test('the eval bar is wide enough for its score labels', () => {
  for (const h of [920, 1080, 1440]) {
    const l = fullHdReferenceLayout(1920, h);
    assert.ok(box(l, 'evalbar').w >= 48, `eval bar too thin at ${h}: ${box(l, 'evalbar').w}`);
  }
});

test('panel rows stack without overlapping', () => {
  for (const [w, h] of [[1280, 720], [1920, 1080], [2560, 1440]]) {
    const l = fullHdReferenceLayout(w, h);
    const rows = ['review', 'moves', 'graph', 'controls'];
    for (let i = 0; i < rows.length - 1; i++) {
      const a = box(l, rows[i]), b = box(l, rows[i + 1]);
      assert.ok(!overlaps(a, b), `${w}x${h}: ${rows[i]} overlaps ${rows[i + 1]}`);
    }
    assert.ok(!overlaps(box(l, 'moves'), box(l, 'accuracy')), `${w}x${h}: move list overlaps accuracy`);
    assert.ok(!overlaps(box(l, 'graph'), box(l, 'engine')), `${w}x${h}: graph overlaps engine`);
    assert.ok(!overlaps(box(l, 'board'), box(l, 'review')), `${w}x${h}: board overlaps the panel column`);
  }
});

test('the eval bar spans the board square and the coach fits inside the insight panel', () => {
  const l = fullHdReferenceLayout(1920, 1080);
  const board = box(l, 'board'), evalbar = box(l, 'evalbar');
  assert.ok(Math.abs(evalbar.h - board.w) <= 1, 'eval bar should span the square');
  assert.ok(evalbar.x + evalbar.w <= board.x, 'eval bar must stay left of the board');
  assert.ok(evalbar.y >= board.y && evalbar.y + evalbar.h <= board.y + board.h);
  const coach = box(l, 'coach'), review = box(l, 'review');
  assert.ok(coach.x + coach.w <= review.x + review.w + 1, 'coach floats at the column right edge');
  assert.equal(coach.y, review.y);
  assert.ok(coach.y + coach.h <= review.y + review.h + 1,
    `coach must not spill below the insight panel (coach ${coach.h}, review ${review.h})`);
});

test('component scales stay readable and never outgrow their cap', () => {
  for (const [w, h] of [[1100, 520], [1920, 920], [3840, 2160]]) {
    const l = fullHdReferenceLayout(w, h);
    const s = box(l, 'board').scale, sg = box(l, 'review').scale;
    assert.ok(s >= DESIGN.minScale && s <= DESIGN.maxScale, `${w}x${h}: board scale ${s}`);
    assert.ok(sg >= DESIGN.minColScale && sg <= DESIGN.maxPanelScale, `${w}x${h}: panel scale ${sg}`);
  }
});

test('very wide and very tall windows keep the composition centred and bounded', () => {
  for (const [w, h] of [[3440, 1440], [3840, 1080], [1600, 1800]]) {
    const l = fullHdReferenceLayout(w, h);
    const left = Math.min(...Object.values(l).map(b => b.x));
    const r = right(l);
    assert.ok(left >= DESIGN.margin - 1, `${w}x${h}: content starts left of the margin`);
    assert.ok(r <= w - DESIGN.margin + 1, `${w}x${h}: content runs past the right margin`);
    // Centred when the composition cannot use the width: both sides within 2px of each other.
    if (w - (r - left) > 120) assert.ok(Math.abs(left - (w - r)) <= 2, `${w}x${h}: not centred`);
  }
});

test('panelScale reads only sane scales', () => {
  assert.equal(panelScale({ scale: 1.25 }), 1.25);
  assert.equal(panelScale({}), 1);
  assert.equal(panelScale({ scale: 0 }), 1);
  assert.equal(panelScale({ scale: 9 }), 1);
  assert.equal(panelScale(null), 1);
});
