import test from 'node:test';
import assert from 'node:assert/strict';
import { app, loadGame } from './helpers/app.mjs';

// Upstream 852839b4 / a4340dc6 measured most of the review's navigation cost as pure DOM rebuilding:
// navigating a finished game replaced the graph, the player strips and the library list even when
// their content was identical. Our port keeps those nodes mounted and only touches what changed.
function board(t) {
  const a = app(t);
  loadGame(a, '1. e4 e5 2. Nf3 Nc6');
  a.call('computeDerived');
  a.call('buildUI');
  a.call('renderAll');
  return a;
}
const node = (a, sel) => a.dom.window.document.querySelector(sel);

test('the eval graph is kept when the plot is unchanged and only its marker moves', t => {
  const a = board(t);
  a.call('renderGraph');
  const svg = node(a, '#graphMount .evalgraph svg');
  const marker = node(a, '#graphMount .eg-pos');
  assert.ok(svg && marker, 'the graph and its position marker exist');

  const before = marker.getAttribute('x1');
  a.state.idx = 3;
  a.call('renderGraph');
  assert.equal(node(a, '#graphMount .evalgraph svg'), svg, 'the same graph node is reused');
  assert.equal(node(a, '#graphMount .eg-pos'), marker, 'the same marker node is reused');
  assert.notEqual(marker.getAttribute('x1'), before, 'the marker moved to the new position');

  // A real change to the plot still redraws it.
  a.state.evals[3] = { cp: 250 };
  a.call('renderGraph');
  assert.notEqual(node(a, '#graphMount .evalgraph svg'), svg, 'a changed evaluation redraws the graph');
});

test('the player strips are kept while nothing about them changes', t => {
  const a = board(t);
  a.call('renderPlayers');
  const top = node(a, '#playerTop .player-strip');
  const bot = node(a, '#playerBot .player-strip');
  a.call('renderPlayers');
  assert.equal(node(a, '#playerTop .player-strip'), top, 'the top strip is reused');
  assert.equal(node(a, '#playerBot .player-strip'), bot);

  // The side to move changes the "active" highlight, so that does rebuild.
  a.call('go', 1);
  a.call('renderPlayers');
  assert.notEqual(node(a, '#playerTop .player-strip'), top, 'a real change rebuilds the strip');
});

test('the engine panel is kept while the lines for the position are unchanged', t => {
  const a = board(t);
  a.call('renderEngineCurrent');
  const panel = node(a, '#engineMount .panel');
  a.call('renderEngineCurrent');
  assert.equal(node(a, '#engineMount .panel'), panel, 'the same panel node is reused');

  a.state.bests[2] = { bestmove: 'g1f3', score: { cp: 12 }, lines: [{ pv: 'g1f3', score: { cp: 12 } }] };
  a.call('go', 2);
  a.call('renderEngineCurrent');
  assert.notEqual(node(a, '#engineMount .panel'), panel, 'new lines redraw the panel');
});

test('the library list is kept while the records and the filters are unchanged', t => {
  const a = board(t);
  a.state.library = [
    { id: 'g1', savedAt: 2, result: 'win', myAcc: 80, opAcc: 70, myName: 'Me', opName: 'You', type: 'Blitz', fav: false, solved: false, hasBrilliant: false, pgn: '1. e4' },
    { id: 'g2', savedAt: 1, result: 'loss', myAcc: 60, opAcc: 75, myName: 'Me', opName: 'You', type: 'Blitz', fav: true, solved: true, hasBrilliant: false, pgn: '1. d4' },
  ];
  // jsdom cannot build the sidebar dropdowns (they parse HTML through DOMParser); the list itself is
  // what this test is about.
  a.replace('libDropdown', (label, value, options) => a.dom.window.document.createElement('span'));
  a.call('renderLibrary');
  const card = node(a, '#libList .lib-card, #libList > *');
  const control = node(a, '#libControls > *');
  assert.ok(card, 'cards are rendered');

  a.call('renderLibrary');
  assert.equal(node(a, '#libList .lib-card, #libList > *'), card, 'the same card node is reused');
  assert.equal(node(a, '#libControls > *'), control, 'the filter controls are reused too');

  a.state.library = a.state.library.map((r) => r.id === 'g1' ? { ...r, fav: true } : r);
  a.call('renderLibrary');
  assert.notEqual(node(a, '#libList .lib-card, #libList > *'), card, 'a changed record rebuilds the list');
});
