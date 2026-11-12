import test from 'node:test';
import assert from 'node:assert/strict';
import { app, loadGame, settle } from './helpers/app.mjs';

// The shared panel-design registry (lib/panel-designs.js), the premade setups (lib/ui-setups.js)
// and the variants this fork renders: engine minimal, move-list designs and the flat eval bar.
function withApp(t) {
  const a = app(t);
  loadGame(a, '1. e4 e5');
  a.call('computeDerived'); a.call('buildUI'); a.call('renderAll');
  return a;
}
const doc = (a) => a.dom.window.document;

test('unknown and retired design ids fall back, and load migrates them', (t) => {
  const a = app(t);
  a.state.settings.graphDesign = 'nope';
  assert.equal(a.call('panelDesign', 'graph', a.state.settings), 'bars3');
  // A retired value still renders until the next load migrates it (upstream keeps the same door open).
  a.state.settings.graphDesign = 'bars2';
  assert.equal(a.call('panelDesign', 'graph', a.state.settings), 'bars2');
  assert.equal(a.call('normalizePanelDesigns', a.state.settings), true);
  assert.equal(a.state.settings.graphDesign, 'bars3');
  assert.equal(a.call('normalizePanelDesigns', a.state.settings), false, 'a normalised object stays stable');
  // Every panel has a setting with a default.
  for (const design of a.run('PANEL_DESIGNS')) {
    assert.ok(design.setting in a.run('DEFAULT_SETTINGS'), design.setting + ' has a default');
    assert.ok(design.versions.some((version) => version.id === a.run('DEFAULT_SETTINGS')[design.setting]));
  }
});

test('premade setups select every design, and a manual choice marks the setup Custom', (t) => {
  const a = withApp(t);
  a.call('applyUiSetup', 'modern');
  assert.equal(a.state.settings.uiSetup, 'modern');
  assert.equal(a.state.settings.engineDesign, 'minimal');
  assert.equal(a.state.settings.movesDesign, 'zoom20');
  assert.equal(a.state.settings.graphDesign, 'bars3');
  a.call('setDesignSetting', 'graphDesign', 'original');
  assert.equal(a.state.settings.uiSetup, 'custom', 'a design that no longer matches the preset is Custom');
  a.call('applyUiSetup', 'old');
  assert.equal(a.state.settings.uiSetup, 'old');
  assert.equal(a.state.settings.graphDesign, 'original');
  assert.equal(a.state.settings.engineDesign, 'original');
  assert.equal(a.state.settings.movesDesign, 'original');
  // The Visual category shows the three setups, with the active one marked.
  a.call('selectSettingsCategory', 'visual');
  const buttons = [...doc(a).querySelectorAll('#settings .set-seg button')];
  const setup = buttons.filter((b) => ['Old', 'Modern', 'Custom'].includes(b.textContent));
  assert.deepEqual(setup.map((b) => [b.textContent, b.classList.contains('on')]), [['Modern', false], ['Old', true], ['Custom', false]]);
  // The Tabs section offers the versions with more than one choice.
  const optTexts = [...doc(a).querySelectorAll('#settings .lib-dd-opt')].map((o) => o.textContent);
  assert.ok(optTexts.includes('Colored bars'));
  assert.ok(optTexts.includes('Large text'));
  assert.ok(optTexts.includes('Flat'));
  assert.ok(optTexts.includes('Edge-to-edge'));
});

test('the engine minimal design renders the focus shell with the line controls', async (t) => {
  const a = withApp(t);
  a.state.bests[a.state.idx] = { bestmove: 'e2e4', score: { cp: 20 }, lines: [{ pv: 'e2e4 e7e5 g1f3', score: { cp: 30 } }] };
  a.call('setDesignSetting', 'engineDesign', 'minimal');
  assert.ok(doc(a).querySelector('.engine-focus.engine-minimal'), 'the minimal shell is mounted');
  assert.ok(doc(a).querySelector('.engine-minimal-controls .engine-minimal-add'), 'a line can be added');
  assert.ok(doc(a).querySelector('.engine-focus-candidate'), 'candidates render as focus rows');
  assert.equal(doc(a).querySelector('.engine-bestwalk'), null, 'playback lives in the header, not a footer button');
  // Removing a line is offered once more than one is shown.
  a.state.settings.engineLines = 2;
  a.call('renderEngineCurrent');
  assert.ok(doc(a).querySelector('.engine-minimal-remove'));
  // The +Add control changes the setting (the panel refreshes without re-analysing).
  a.state.settings.engineLines = 1;
  a.call('renderEngineCurrent');
  doc(a).querySelector('.engine-minimal-add').click();
  await settle();
  assert.equal(a.state.settings.engineLines, 2);
  // Back to the classic panel.
  a.call('setDesignSetting', 'engineDesign', 'original');
  assert.equal(doc(a).querySelector('.engine-focus'), null);
  assert.ok(doc(a).querySelector('.engine-bestwalk'));
});

test('the move list records its design; the modern designs hide head and footer', (t) => {
  const a = withApp(t);
  a.call('renderMoves');
  const panel = doc(a).querySelector('.moves-panel');
  assert.equal(panel.dataset.design, 'original', 'the default is the classic panel with its head');
  assert.ok(panel.querySelector('.panel-head'));
  a.call('setDesignSetting', 'movesDesign', 'zoom20');
  assert.equal(doc(a).querySelector('.moves-panel').dataset.design, 'zoom20');
  a.call('setDesignSetting', 'movesDesign', 'zoomed');
  assert.equal(doc(a).querySelector('.moves-panel').dataset.design, 'zoomed');
});

test('the visual reset returns the designs and the setup label to their defaults', async (t) => {
  const a = withApp(t);
  a.call('applyUiSetup', 'modern');
  await a.call('resetVisualSettings');
  assert.equal(a.state.settings.uiSetup, 'custom');
  assert.equal(a.state.settings.graphDesign, 'bars3');
  assert.equal(a.state.settings.engineDesign, 'original');
  assert.equal(a.state.settings.movesDesign, 'original');
});

test('the eval bar offers the flat rail and remembers the classic look', async (t) => {
  const a = withApp(t);
  a.call('renderEvalBar');
  assert.ok(doc(a).querySelector('.evalbar.eb-flat2'), 'flat2 is the default look');
  await a.call('setSetting', 'barStyle', 'mono');
  assert.ok(doc(a).querySelector('.evalbar.eb-mono'));
  assert.equal(doc(a).querySelector('.evalbar.eb-flat2'), null, 'the class follows the choice');
});
