import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { app, loadGame } from './helpers/app.mjs';
import { SCREEN_SIZES, previewScale, monitorViewport, normalizePreviewZoom, mountViewportPreview } from '../lib/viewport-preview.js';

// The screen-size preview (ported from upstream): a viewer page renders the real analysis app in an
// iframe sized to a chosen screen. The app inside runs with memory storage, so nothing is saved.

test('fit shrinks a larger screen, never upscales, and monitors convert through display scaling', () => {
  assert.equal(previewScale(1920, 1080, 960, 540, 'fit'), 0.5);
  assert.equal(previewScale(800, 600, 1200, 900, 'fit'), 1, 'a smaller screen is shown at its real size');
  assert.equal(previewScale(1920, 1080, 960, 540, '1'), 1, 'actual size never scales');
  assert.deepEqual(monitorViewport(1920, 1080, { pixelRatio: 2, insetWidth: 20, insetHeight: 60 }), [940, 480]);
  assert.deepEqual(monitorViewport(1920, 1080, {}), [1920, 1080], 'a missing ratio or inset is treated as none');
  assert.ok(Object.keys(SCREEN_SIZES).every((group) => Array.isArray(SCREEN_SIZES[group])));
});

test('the zoom normaliser is a no-op without tab APIs', async () => {
  await normalizePreviewZoom(undefined);
  await normalizePreviewZoom({});
});

async function viewer(t) {
  const dom = new JSDOM(await readFile(new URL('../screen-preview.html', import.meta.url), 'utf8'),
    { url: 'https://extension.test/screen-preview.html', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const stage = doc.getElementById('preview-stage');
  Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 1200 });
  Object.defineProperty(stage, 'clientHeight', { configurable: true, value: 800 });
  const mounted = mountViewportPreview(doc);
  return { dom, doc, stage, ...mounted,
    // Events must come from the jsdom realm or dispatchEvent refuses them.
    ev: (type, init) => new dom.window.Event(type, { bubbles: true, ...init }),
    key: (key) => new dom.window.KeyboardEvent('keydown', { key, bubbles: true }),
    text: (id) => doc.getElementById(id).textContent,
    options: () => [...doc.getElementById('screen-preset').options].map((o) => o.textContent) };
}

test('the viewer mounts, lists every size group and keeps the app iframe alive', async t => {
  const { doc, frame, text, options } = await viewer(t);
  assert.deepEqual([...doc.querySelectorAll('#device-tabs button')].map((b) => b.textContent),
    ['Current', 'Desktop', 'Laptop', 'Tablet', 'Phone', 'Custom']);
  assert.equal(doc.querySelector('#device-tabs button').getAttribute('aria-pressed'), 'true', 'the current window starts selected');
  assert.equal(options().length, 1);
  assert.match(text('screen-readout'), /^\d+ × \d+ · (Fit \d+%|Actual size)$/);
  assert.equal(frame.getAttribute('src'), 'analysis.html?viewport-preview=1', 'the iframe loads the app in preview mode');
});

test('choosing a phone size sizes the iframe to that CSS viewport', async t => {
  const { doc, frame, text, ev } = await viewer(t);
  [...doc.querySelectorAll('#device-tabs button')].find((b) => b.textContent === 'Phone').click();
  assert.match(text('screen-readout'), /^320 × 568 · Fit/, 'a group starts on its first preset');
  // Picking another preset of the group switches the size.
  const preset = doc.getElementById('screen-preset');
  preset.value = '1';
  preset.dispatchEvent(ev('change'));
  assert.match(text('screen-readout'), /^390 × 844 · Fit/);
  assert.equal(frame.style.width, '390px');
  assert.equal(frame.style.height, '844px');
  const fit = Number(/scale\(([\d.]+)\)/.exec(frame.style.transform)?.[1]);
  assert.ok(fit > 0 && fit <= 1, `fitted scale ${fit}`);
  // Actual size shows the screen 1:1 and lets the stage scroll.
  doc.getElementById('preview-scale').value = '1';
  doc.getElementById('preview-scale').dispatchEvent(ev('change'));
  assert.equal(frame.style.transform, 'scale(1)');
  assert.match(text('screen-readout'), /Actual size$/);
});

test('custom width/height and rotate drive the Custom group', async t => {
  const { doc, frame, text, options, ev } = await viewer(t);
  const width = doc.getElementById('screen-width'), height = doc.getElementById('screen-height');
  width.value = '500'; height.value = '900';
  width.dispatchEvent(ev('change'));
  assert.deepEqual(options(), ['Custom size']);
  assert.ok(doc.getElementById('screen-preset').disabled, 'a custom size has no preset to pick');
  assert.equal(frame.style.width, '500px');
  [...doc.querySelectorAll('#device-tabs button')].find((b) => b.textContent === 'Custom').click();
  assert.equal(doc.querySelector('#device-tabs button[aria-pressed="true"]').textContent, 'Custom');
  doc.getElementById('rotate-screen').click();
  assert.equal(frame.style.width, '900px');
  assert.equal(frame.style.height, '500px');
  assert.match(text('screen-readout'), /^900 × 500/);
});

test('the toolbar can hide itself and the setup panel opens, closes and answers Escape', async t => {
  const { doc, key } = await viewer(t);
  const toolbar = doc.getElementById('preview-toolbar'), show = doc.getElementById('show-controls');
  const settings = doc.getElementById('preview-settings'), toggle = doc.getElementById('toggle-settings');
  toggle.click();
  assert.equal(settings.hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  doc.dispatchEvent(key('Escape'));
  assert.equal(settings.hidden, true, 'Escape closes the setup panel');
  doc.getElementById('hide-controls').click();
  assert.equal(toolbar.hidden, true);
  assert.equal(show.hidden, false);
  assert.equal(settings.hidden, true, 'hiding the controls also closes the setup panel');
  show.click();
  assert.equal(toolbar.hidden, false);
  assert.equal(show.hidden, true);
});

// The launcher hands the preview this tab's game, layout and preferences through sessionStorage
// (window.open copies it synchronously). The preview tab itself runs on memory storage.
test('the preview runs on memory storage seeded from the real one', async t => {
  const a = app(t, { url: 'https://extension.test/analysis.html?viewport-preview=1#preview' });
  assert.equal(a.run('VIEWPORT_PREVIEW'), true);
  a.store.settings = { theme: 'dark', engineWorkers: 4, sound: true };
  a.store.username = 'someone';
  await a.call('installPreviewStorage');
  const local = a.context.browserAPI.storage.local;
  // Compare as JSON: the adapter's objects come from the vm realm.
  const json = async (keys) => JSON.stringify(await local.get(keys));
  assert.equal(await json('settings'), JSON.stringify({ settings: { theme: 'dark', engineWorkers: 1, sound: false } }),
    'sound off, one worker — kept in memory only');
  assert.equal(a.store.settings.engineWorkers, 4, 'the real settings are untouched');
  assert.equal((await local.get('username')).username, 'someone');
  await local.set({ marker: 7 });
  assert.equal((await local.get('marker')).marker, 7);
  assert.equal(a.store.marker, undefined, 'writes stay in the preview’s memory');
  await local.remove('marker');
  assert.equal((await local.get('marker')).marker, undefined);
  assert.equal(await json(null), JSON.stringify({ settings: { theme: 'dark', engineWorkers: 1, sound: false }, username: 'someone' }));
});

test('the preview game comes from the launch snapshot, or the sample without one', async t => {
  const a = app(t, { url: 'https://extension.test/analysis.html?viewport-preview=1#preview' });
  const sample = await a.call('loadJob');
  assert.match(sample.pgn, /Preview White/, 'a direct visit gets the sample game');
  a.dom.window.sessionStorage.setItem('screen-size-preview', JSON.stringify({
    job: { pgn: '[White "Launched"]\n\n1. d4 d5 *', meta: { gameId: 'launched' } },
    preferences: { layoutMode: 'custom' },
  }));
  const job = await a.call('loadJob');
  assert.match(job.pgn, /Launched/);
  assert.equal(job.meta.gameId, 'launched');
  await a.call('installPreviewStorage');
  assert.equal((await a.context.browserAPI.storage.local.get('layoutMode')).layoutMode, 'custom', 'preferences seed the memory store');
});

test('the launcher snapshots the game, layout and display, then removes the handoff', async t => {
  const a = app(t, { url: 'https://extension.test/analysis.html#probe' });
  loadGame(a, '1. e4 e5 2. Nf3 Nc6');
  a.call('computeDerived'); a.call('buildUI');
  a.state.idx = 2;
  let captured = null;
  a.dom.window.open = () => {
    captured = JSON.parse(a.dom.window.sessionStorage.getItem('screen-size-preview'));
    return { focus() {} };   // a real browser returns the new tab synchronously
  };
  a.call('openScreenSizePreview');
  assert.ok(captured, 'the viewer can read the snapshot at window.open time');
  assert.equal(captured.job.pgn, a.state.pgn);
  assert.equal(captured.idx, 2);
  assert.equal(captured.preferences.layoutMode, a.state.layoutMode);
  assert.ok(captured.preferences.layout && captured.preferences.layout.board, 'the layout travels with it');
  assert.ok(captured.display.width > 0 && captured.display.height > 0);
  assert.ok(captured.job.analysis?.evals?.length === a.state.total + 1, 'a finished review travels ready to show');
  assert.equal(a.dom.window.sessionStorage.getItem('screen-size-preview'), null, 'the handoff key is removed again');
  assert.equal(a.run('VIEWPORT_PREVIEW'), false, 'the normal page is not a preview');
});
