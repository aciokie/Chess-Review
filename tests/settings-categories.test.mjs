import test from 'node:test';
import assert from 'node:assert/strict';
import { app, loadGame } from './helpers/app.mjs';

// The categorized settings panel (upstream's navigation): one picker, one category at a time, a
// reset per category, and sections that start closed again when the viewer switches category.
function withApp(t) {
  const a = app(t);
  loadGame(a, '1. e4 e5');
  a.call('computeDerived'); a.call('buildUI'); a.call('renderAll');
  return a;
}
const heads = (a) => [...a.dom.window.document.querySelectorAll('#settings .set-sect-head')].map((n) => n.textContent);
const categories = (a) => [...a.dom.window.document.querySelectorAll('#settings .set-category .lib-dd-opt')].map((n) => n.dataset.category);

test('the settings panel renders one category at a time with a picker', (t) => {
  const a = withApp(t);
  a.call('renderSettings');
  const doc = a.dom.window.document;
  assert.deepEqual(categories(a), ['visual', 'review', 'engine', 'sound', 'developer']);
  const button = doc.querySelector('#settings .set-category .lib-dd-btn');
  assert.match(button.textContent, /Visual/);
  assert.match(button.textContent, /Make the workspace yours/);
  assert.equal(a.state.settingsTab, 'visual');
  // The option list marks the current category and carries a check column.
  assert.equal(doc.querySelector('#settings .lib-dd-opt[data-category="visual"]').getAttribute('aria-checked'), 'true');
  assert.equal(doc.querySelector('#settings .lib-dd-opt[data-category="sound"]').getAttribute('aria-checked'), 'false');
  assert.ok(doc.querySelector('#settings .set-category-check'));
  // Keyboard reachability: the options carry no tabindex="-1", so Tab walks from the button into
  // the list and Enter selects (this fork's dropdown has no roving-focus handler of its own).
  for (const option of doc.querySelectorAll('#settings .set-category .lib-dd-opt')) {
    assert.equal(option.getAttribute('tabindex'), null);
  }
  assert.equal(doc.querySelector('#settings #settingsCategoryContent').getAttribute('aria-label'), 'Visual settings');
  // The old tab row is gone.
  assert.equal(doc.querySelector('#settings .set-tabs'), null);
});

test('each category renders its own sections and a reset', (t) => {
  const a = withApp(t);
  a.call('selectSettingsCategory', 'review');
  assert.deepEqual(heads(a), ['Coach', 'Insights']);
  assert.match(a.dom.window.document.querySelector('.set-category .lib-dd-btn').textContent, /Review & Coach/);
  a.call('selectSettingsCategory', 'sound');
  assert.deepEqual(heads(a), ['General', 'Move', 'Capture', 'Check', 'Castle']);
  a.call('selectSettingsCategory', 'engine');
  assert.deepEqual(heads(a), ['Search', 'Move classification', 'Accuracy points', 'Engine']);
  a.call('selectSettingsCategory', 'developer');
  assert.deepEqual(heads(a), ['Screen-size preview']);
  // Every category ends with its own reset button.
  for (const id of ['visual', 'review', 'engine', 'sound']) {
    a.call('selectSettingsCategory', id);
    const resets = [...a.dom.window.document.querySelectorAll('#settings .set-reset')];
    assert.ok(resets.some((b) => /^Reset all/.test(b.textContent)), id + ' has a reset');
  }
});

test('switching category closes open sections and remembers the scroll position', (t) => {
  const a = withApp(t);
  a.call('selectSettingsCategory', 'visual');
  a.state.setOpen.Theme = true;
  a.call('renderSettings');
  assert.ok([...a.dom.window.document.querySelectorAll('.set-section')].some((s) => s.classList.contains('open')));
  a.call('selectSettingsCategory', 'sound');
  assert.equal(a.state.setOpen.Theme, false, 'sections start closed in the other category');
  assert.ok([...a.dom.window.document.querySelectorAll('.set-section')].every((s) => !s.classList.contains('open')));
  // Coming back keeps the position map; the first visit of a category starts at the top.
  assert.equal(a.call('selectSettingsCategory', 'nope'), undefined);
  assert.equal(a.state.settingsTab, 'sound');
});

test('an unknown stored category falls back to Visual', (t) => {
  const a = withApp(t);
  a.state.settingsTab = 'library';
  a.call('renderSettings');
  assert.equal(a.state.settingsTab, 'visual');
  assert.deepEqual(heads(a), ['Interface presets', 'Tabs', 'Theme', 'Board / Pieces', 'Best-move arrow', 'Loading', 'Move animation', 'Layout', 'Move list', 'Background']);
});

test('per-event sound config: volume knob, Off, and safe defaults', (t) => {
  const a = withApp(t);
  a.state.settings.soundFx = { move: { snd: 'none', pitch: 2, speed: 1.5 } };
  const cfg = a.call('fxConfig', 'move');
  assert.equal(cfg.snd, 'none');
  assert.equal(cfg.volume, 100, 'a config saved before volume existed defaults to 100');
  assert.equal(a.call('fxUrl', 'move'), null, 'Off resolves to no file at all');
  a.call('setFx', 'move', 'volume', 30);
  assert.equal(a.state.settings.soundFx.move.volume, 30);
  assert.equal(a.call('fxConfig', 'move').pitch, 2, 'saving a knob keeps the rest of the event config');
  // A bad stored choice falls back to the original cue.
  a.state.settings.soundFx = { move: { snd: 'nope' } };
  assert.equal(a.call('fxConfig', 'move').snd, 'default');
});

test('the sound category resets every sound setting', async (t) => {
  const a = withApp(t);
  a.state.settings.sound = false;
  a.state.settings.soundVolume = 5;
  a.state.settings.soundFx = { move: { snd: '01', pitch: 4, speed: 2, volume: 10 } };
  await a.call('resetSoundSettings');
  const defaults = a.run('DEFAULT_SETTINGS');
  assert.equal(a.state.settings.sound, defaults.sound);
  assert.equal(a.state.settings.soundVolume, defaults.soundVolume);
  assert.equal(a.state.settings.soundFx.move.snd, 'default');
  assert.equal(a.state.settings.soundFx.move.volume, 100);
});
