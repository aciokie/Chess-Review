import test from 'node:test';
import assert from 'node:assert/strict';
import { app, loadGame, settle } from './helpers/app.mjs';

function layout(t, initialZoom = 1, defaultZoom = 1) {
  const a = app(t); loadGame(a, '1. e4 e5');
  a.call('computeDerived'); a.call('buildUI'); a.call('renderAll');
  let zoom = initialZoom, size;
  const syncViewport = () => {
    if (!size) return;
    a.context.innerWidth = Math.round(size.w / zoom);
    a.context.innerHeight = Math.round(size.h / zoom);
  };
  const changes = [];
  a.context.browserAPI.tabs = {
    getCurrent: async () => ({ id: 7 }),
    getZoomSettings: async () => ({ defaultZoomFactor: defaultZoom }),
    setZoomSettings: async () => {},
    getZoom: async () => zoom,
    setZoom: async (id, value) => { assert.equal(id, 7); changes.push(value); zoom = value; syncViewport(); },
  };
  const viewport = (w, h) => { size = { w, h }; syncViewport(); };
  const box = (key) => {
    const s = a.dom.window.document.querySelector(`[data-mod="${key}"]`).style;
    return { x: parseFloat(s.left), y: parseFloat(s.top), w: parseFloat(s.width), h: parseFloat(s.height) };
  };
  return { ...a, viewport, changes, zoom: () => zoom, box,
    composed: () => a.dom.window.document.querySelector('.stage').classList.contains('full-hd-reference') };
}

test('custom layouts keep their own geometry and fitting', async t => {
  const a=layout(t); a.state.layoutMode='custom';
  a.state.layout={board:{x:40,y:0,w:800,h:920},moves:{x:880,y:60,w:320,h:500}};
  const before=structuredClone(a.state.layout);
  a.call('applyLayoutMode'); a.viewport(1280,720); await a.call('initTabZoom');
  assert.equal(a.composed(),false); assert.deepEqual(a.state.layout,before);
  assert.equal(a.zoom(),a.call('targetZoomFor',1280,720));
});

test('Stockfish 18 NNUE is selected by default and listed first', t => {
  const a=layout(t); assert.equal(a.state.settings.enginePath,'nnue');
  a.state.settingsTab='engine'; a.call('renderSettings');
  const buttons=[...a.dom.window.document.querySelectorAll('#settings .set-seg button')];
  const first=buttons.findIndex(b=>b.textContent==='Stockfish 18 NNUE');
  assert.ok(first>=0); assert.equal(buttons[first].classList.contains('on'),true);
  assert.equal(buttons[first+1].textContent,'Stockfish 19 Full');
});

test('Honeywood is the default board theme', t => {
  const a = layout(t);
  assert.equal(a.state.settings.boardTheme, 'maple');
});

test('the automatic layout composes itself at the default zoom and does not drift on reopen', async t => {
  const a = layout(t, .87); a.viewport(1920, 920);
  await a.call('initTabZoom');
  assert.equal(a.zoom(), 1, 'a fitted zoom from an older version is given back');
  assert.equal(a.composed(), true);
  const board = a.box('board');
  assert.ok(board.w > 700 && board.w <= 730, `board should fill the window height, got ${board.w}`);
  await a.call('fitTabZoom');
  await a.call('initTabZoom');
  assert.deepEqual(a.changes, [1]);
  assert.deepEqual(a.box('board'), board);
});

test('the composition adapts to the window instead of zooming it', async t => {
  const a = layout(t); a.viewport(1920, 920); await a.call('initTabZoom');
  assert.equal(a.composed(), true); assert.equal(a.zoom(), 1);
  const short = a.box('board').w;
  assert.ok(Math.abs(a.box('review').w / short - 0.75) < 0.02,
    `panels should be ~75% of the board (got ${a.box('review').w} vs ${Math.round(short * 0.75)})`);
  a.viewport(1920, 1240); await a.call('fitTabZoom');
  assert.ok(a.box('board').w > short + 150, 'a taller window gets a bigger board');
  assert.ok(a.box('review').w <= a.box('board').w * 0.78, 'the panel share is a ceiling');
  assert.equal(a.zoom(), 1, 'the page itself is never zoomed');
  a.viewport(900, 800); await a.call('fitTabZoom');
  assert.equal(a.composed(), false, 'small windows fall back to the responsive grid');
  assert.equal(a.zoom(), 1);
  a.viewport(1920, 920); await a.call('fitTabZoom');
  assert.equal(a.composed(), true);
  assert.equal(a.box('board').w, short);
});

test('a saved canvas keeps its geometry and the gap when accuracy collapses', async t => {
  const a = layout(t);
  // Model the rendered category rows; jsdom has no layout engine.
  Object.defineProperty(a.dom.window.HTMLElement.prototype, 'offsetHeight', {
    configurable: true, get() { return this.classList.contains('qbreak-row') ? 22 : 0; },
  });
  a.context.getComputedStyle = () => ({ rowGap: '7px' });
  const mod = key => a.dom.window.document.querySelector(`[data-mod="${key}"]`).style;
  const geometry = () => Object.fromEntries(['accuracy', 'engine', 'graph', 'evalbar'].map(key => {
    const s = mod(key); return [key, [s.left, s.top, s.width, s.height]];
  }));
  a.state.layoutMode = 'custom'; a.call('applyLayoutMode'); a.call('reflowAccuracy', false);
  const savedCanvas = geometry();
  assert.deepEqual(savedCanvas.engine, ['1512px', '652px', '294px', '146px']);
  assert.deepEqual(savedCanvas.accuracy, ['1510px', '216px', '294px', '420px']);
  for (let i = 0; i < 3; i++) {
    a.state.qbreakExpanded = true; a.call('renderStats'); a.call('reflowAccuracy', true);
    assert.equal(mod('accuracy').height, '536px'); assert.equal(mod('engine').top, '768px');
    a.state.qbreakExpanded = false; a.call('renderStats'); a.call('reflowAccuracy', false);
    assert.deepEqual(geometry(), savedCanvas);
  }
});

test('Reorganize opens on exactly what is on screen and Reset returns to the composition', async t => {
  const a = layout(t); a.viewport(1920, 920); await a.call('initTabZoom');
  const stage = a.dom.window.document.querySelector('.stage');
  const mods = [...stage.querySelectorAll('.mod')];
  const geometry = () => mods.map(m => [m.style.left, m.style.top, m.style.width, m.style.height]);
  const shown = geometry();
  a.call('toggleReorganize'); await settle();
  assert.equal(a.state.layoutMode, 'custom');
  assert.deepEqual(geometry(), shown, 'the canvas opens 1:1, with no zoom jump');
  assert.equal(a.zoom(), 1);
  assert.equal(a.state.layout.board.w, a.box('board').w);
  await a.call('resetLayout');
  assert.equal(a.state.layoutMode, 'auto');
  assert.deepEqual(geometry(), shown, 'Reset returns to the same composition');
  assert.equal(a.zoom(), 1);
});

test('settings stays right-aligned through visual and layout resets', async t => {
  const a = layout(t);
  const settings = a.dom.window.document.getElementById('settings');
  a.dom.window.innerWidth = 2200;
  a.call('toggleSettings');
  assert.equal(settings.style.right, '24px');
  await a.call('resetVisualSettings');
  assert.equal(settings.style.right, '24px');
  a.call('resetLayout');
  assert.equal(settings.style.right, '24px');
  a.dom.window.innerWidth = 1920;
  a.dom.window.dispatchEvent(new a.dom.window.Event('resize'));
  assert.equal(settings.style.right, '24px');
  a.dom.window.innerWidth = 500;
  a.dom.window.dispatchEvent(new a.dom.window.Event('resize'));
  assert.equal(settings.style.right, '');
});

test('saved custom canvases reopen at the reset scale across typical screen sizes', async t => {
  for (const [w, h, initial, expected] of [
    [1280, 600, 1.25, .56], [1366, 648, .91, .61], [1536, 744, 1, .70],
    [1920, 916, .91, .86], [1920, 920, .89, .87],
    [2560, 1320, 1, 1.25], [3840, 2040, 2, 1.93],
  ]) {
    const a = layout(t, initial);
    a.state.layoutMode = 'custom'; a.call('applyLayoutMode');
    a.viewport(w, h); await a.call('initTabZoom');
    assert.equal(a.zoom(), expected, `${w} × ${h} saved canvas`);
    for (let i = 0; i < 3; i++) {
      await a.call('initTabZoom');
      assert.equal(a.zoom(), expected, `${w} × ${h} reopen ${i}`);
    }
    assert.deepEqual(a.changes, [expected]);
  }
});

test('reset gives the automatic layout its zoom back after a manual one', async t => {
  const a = layout(t, .91); a.viewport(1920, 916);
  let scopes = 0, active = 0;
  const tabs = a.context.browserAPI.tabs;
  const setZoom = tabs.setZoom;
  tabs.setZoomSettings = async () => { scopes++; };
  tabs.setZoom = async (...args) => {
    assert.equal(active++, 0, 'zoom writes must not overlap');
    await settle(); await setZoom(...args); active--;
  };
  await Promise.all([a.call('initTabZoom'), a.call('initTabZoom'), a.call('fitTabZoom')]);
  assert.equal(scopes, 1); assert.deepEqual(a.changes, [1]);
  await tabs.setZoom(7, .91);
  await a.call('fitTabZoom'); assert.equal(a.zoom(), .91, 'a manual zoom at the same window size is left alone');
  await a.call('resetLayout');
  assert.equal(a.zoom(), 1); assert.equal(scopes, 1);
});

test('an already isolated tab is not re-scoped on reopen', async t => {
  const a = layout(t); a.viewport(1920, 920);
  let scopes = 0;
  const tabs = a.context.browserAPI.tabs;
  tabs.getZoomSettings = async () => ({ defaultZoomFactor: 1, scope: 'per-tab' });
  tabs.setZoomSettings = async () => { scopes++; };
  await a.call('initTabZoom');
  assert.equal(scopes, 0, 'an already per-tab scope must not be reapplied');
  assert.equal(a.zoom(), 1); assert.equal(a.composed(), true);
});

test('a shared-scope tab is isolated once before the layout is built', async t => {
  const a = layout(t); a.viewport(1920, 920);
  let scopes = 0;
  const tabs = a.context.browserAPI.tabs;
  tabs.getZoomSettings = async () => ({ defaultZoomFactor: 1, scope: 'per-origin' });
  tabs.setZoomSettings = async () => { scopes++; };
  await a.call('initTabZoom');
  assert.equal(scopes, 1, 'a per-origin tab must be isolated before the fit is applied');
  assert.equal(a.zoom(), 1); assert.equal(a.composed(), true);
});

test('failed zoom writes can be retried at the same window size', async t => {
  const a = layout(t); a.viewport(1920, 916);
  const tabs = a.context.browserAPI.tabs, setZoom = tabs.setZoom;
  tabs.setZoom = async () => { throw Error('Temporary tab error'); };
  await a.call('initTabZoom');
  tabs.setZoom = setZoom;
  await a.call('fitTabZoom');
  assert.equal(a.zoom(), 1);
});

test('a manual browser zoom survives a resize in the automatic layout', async t => {
  const a = layout(t); a.viewport(1920, 920); await a.call('initTabZoom');
  await a.context.browserAPI.tabs.setZoom(7, .8);      // the user zooms out
  a.viewport(1600, 800); await a.call('fitTabZoom');
  assert.equal(a.zoom(), .8, 'the resize leaves the user zoom alone');
  assert.equal(a.composed(), true);
});

test('small windows use the browser default zoom and the responsive grid', async t => {
  const a = layout(t, .89, 1.25); a.viewport(1000, 800);
  await a.call('initTabZoom');
  assert.equal(a.composed(), false); assert.equal(a.zoom(), 1.25);
  a.viewport(1920, 916); await a.call('fitTabZoom');
  assert.equal(a.composed(), true); assert.equal(a.zoom(), 1.25, 'a nonstandard browser default is respected');
});

test('small custom canvases retain their own bounds instead of inheriting desktop width', async t => {
  const a = layout(t);
  a.state.layoutMode = 'custom';
  a.state.layout = { board: { x: 36, y: 0, w: 640, h: 760 } };
  a.call('applyLayoutMode'); a.viewport(768, 900);
  await a.call('initTabZoom');
  const stage = a.dom.window.document.querySelector('.stage');
  assert.equal(stage.style.minWidth, '688px');
  assert.equal(stage.style.minHeight, '772px');
  assert.equal(a.zoom(), 1.07);
});

test('Engine grows downward for its contents on the custom canvas and cannot be resized below them', async t => {
  const a = layout(t); a.viewport(1920, 916); await a.call('initTabZoom');
  a.call('toggleReorganize');                        // materialise the composition as a canvas
  const mod = a.dom.window.document.querySelector('[data-mod="engine"]');
  const head = mod.querySelector('.panel-head'), body = mod.querySelector('.engine-body');
  head.getBoundingClientRect = () => ({ height: 40.5 });
  Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 250 });
  const top = mod.style.top;
  // The canvas kept the composition's panel scale: the measured lines (250 CSS px) are converted
  // back to the canvas's own pixels. Shrink the panel to its header first — the fit must grow it
  // back so the candidate lines and the action stay visible.
  const scale = a.state.layout.engine.scale;
  assert.ok(scale > 0.8 && scale <= 1.05, `panel scale ${scale}`);
  a.state.layout.engine.h = 40; mod.style.height = '40px';
  a.call('fitEnginePanel');
  const grown = Math.ceil((40.5 / scale + 250 + 4) * scale / 2) * 2;   // measured lines, rounded up
  assert.equal(a.state.layout.engine.h, grown);
  assert.equal(mod.style.height, grown + 'px'); assert.equal(mod.style.top, top);
  const grip = mod.querySelector('.mod-resize.s');
  const event = (type, y) => new a.dom.window.MouseEvent(type, { clientY: y, bubbles: true });
  grip.dispatchEvent(event('pointerdown', 300));
  grip.dispatchEvent(event('pointermove', 0));
  grip.dispatchEvent(event('pointerup', 0));
  assert.equal(a.state.layout.engine.h, grown);
  assert.equal(mod.style.height, grown + 'px'); assert.equal(mod.style.top, top);
});
