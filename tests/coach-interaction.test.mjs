import test from 'node:test';
import assert from 'node:assert/strict';
import { app, loadGame } from './helpers/app.mjs';

// Upstream's interactive portrait: the transparent iframe cannot capture input, so the parent
// document hit-tests the painted figure and follows the pointer with the head/eyes.
function coach(t) {
  const a = app(t);
  loadGame(a, '1. e4 e5 2. Nf3 Nc6');
  a.call('computeDerived'); a.call('buildUI');
  const messages = [];
  const figure = { closest: (sel) => (sel === '#figure' ? figure : null) };
  const frame = {
    style: {}, clientWidth: 200, clientHeight: 200,
    contentWindow: { postMessage: (m) => messages.push(m) },
    contentDocument: { elementFromPoint: () => figure },
    getBoundingClientRect: () => ({ left: 100, top: 100, right: 300, bottom: 300, width: 200, height: 200 }),
  };
  a.context.__frame = frame;
  a.run('_coachFrame = __frame; _coachReady = true;');
  delete a.context.__frame;
  a.context.requestAnimationFrame = (fn) => { fn(); return 1; };   // paint coalescing runs outright
  a.dom.window.document.elementFromPoint = () => frame;            // jsdom has no hit-testing
  a.call('bindCoachPointer');
  return { a, messages, frame };
}

test('pressing the painted figure shakes the coach, elsewhere clicks pass through', t => {
  const { a, messages } = coach(t);
  const doc = a.dom.window.document;
  const over = new a.dom.window.MouseEvent('pointerdown', { clientX: 150, clientY: 150, bubbles: true, cancelable: true });
  doc.dispatchEvent(over);
  assert.ok(messages.some((m) => m.coachCmd === 'shake'), 'the press reaches the rig');
  assert.equal(over.defaultPrevented, true, 'the press is consumed');

  const away = new a.dom.window.MouseEvent('pointerdown', { clientX: 900, clientY: 900, bubbles: true, cancelable: true });
  doc.dispatchEvent(away);
  assert.equal(away.defaultPrevented, false, 'clicks elsewhere are untouched');
  assert.equal(messages.filter((m) => m.coachCmd === 'shake').length, 1);
});

test('moving the pointer near the portrait forwards normalised coordinates', t => {
  const { a, messages } = coach(t);
  const doc = a.dom.window.document;
  doc.dispatchEvent(new a.dom.window.MouseEvent('pointermove', { clientX: 200, clientY: 250, bubbles: true }));
  const pointer = messages.find((m) => m.coachCmd === 'pointer');
  assert.ok(pointer, 'a pointer message is sent');
  // Compare fields: the value object comes from the vm realm, so its prototype is not ours.
  assert.equal(pointer.value.x, 0.5);
  assert.equal(pointer.value.y, 0.75);
});

test('a pointer out of reach clears the follow instead of sending coordinates', t => {
  const { a, messages } = coach(t);
  const doc = a.dom.window.document;
  doc.dispatchEvent(new a.dom.window.MouseEvent('pointermove', { clientX: 900, clientY: 900, bubbles: true }));
  assert.equal(messages.some((m) => m.coachCmd === 'pointer' && m.value), false, 'no follow outside the reach');
});

test('switching the coach off resets pending animation state', t => {
  const { a } = coach(t);
  a.state.settings.coach = '';
  a.call('renderCoachAvatar');
  assert.equal(a.run('_coachFrame'), null, 'the frame is dropped');
  assert.equal(a.run('_coachTalking'), false, 'talking state is reset');
});
