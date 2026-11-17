import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app, loadGame } from './helpers/app.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const fx = (snd) => ({ snd, pitch: 0, speed: 1, volume: 100 });

test('captures override check and mate sounds in review and practice moves', t => {
  const a = app(t), played = [];
  a.state.settings.sound = true;
  a.replace('playEvent', event => played.push(event));

  for (const san of ['Bxf7+', 'Qxh7#', 'exd6+', 'gxh8=Q+']) {
    a.state.positions = [{}, { san }];
    a.call('playMoveSound', 1);
    a.call('playSanSound', san);
  }

  assert.deepEqual(played, Array(8).fill('capture'));
});

test('quiet moves, captures, checks, mates and castling retain their sounds', t => {
  const a = app(t);
  for (const [san, expected] of [
    ['e4', 'move'], ['Bxf7', 'capture'], ['Qh5+', 'check'], ['Qh7#', 'check'],
    ['O-O', 'castle'], ['O-O-O', 'castle'], ['0-0', 'castle'], ['O-O+', 'check'],
    [undefined, 'move'],
  ]) {
    assert.equal(a.call('sanSound', san), expected, san);
  }
});

// A brilliant cue replaces the usual SAN cue only when the review is moving FORWARD onto an already
// classified move: undoing a move never celebrates it, and practice keeps its own cues.
test('a classified brilliant move plays the brilliant cue on forward navigation only', t => {
  const a = app(t), played = [];
  a.state.settings.sound = true;
  a.state.settings.soundFx = { ...a.state.settings.soundFx, brilliant: fx('default') };
  a.replace('playEvent', event => played.push(event));
  a.state.positions = [{}, { san: 'Qxf7+' }];
  a.state.classif = [null, 'brilliant'];

  a.call('playMoveSound', 1);          // forward onto the brilliant move
  a.call('playMoveSound', 1, false);   // undo it again: the SAN cue
  a.state.practice = {};
  a.call('playMoveSound', 1);          // practice has no review verdict yet
  a.state.practice = null;
  a.state.classif[1] = 'best';
  a.call('playMoveSound', 1);          // not brilliant: the SAN cue

  assert.deepEqual(played, ['brilliant', 'capture', 'capture', 'capture']);
});

test('brilliant Off restores the SAN cue instead of the brilliant one', t => {
  const a = app(t), played = [];
  a.state.settings.sound = true;
  a.state.settings.soundFx = { ...a.state.settings.soundFx, brilliant: fx('none') };
  a.replace('playEvent', event => played.push(event));
  a.state.positions = [{}, { san: 'O-O' }];
  a.state.classif = [null, 'brilliant'];

  a.call('playMoveSound', 1);
  assert.deepEqual(played, ['castle']);
});

test('each event resolves its own candidates, the shared effects and Off', t => {
  const a = app(t);
  a.state.settings.soundFx = {
    ...a.state.settings.soundFx,
    check: fx('check-16-firm-alert'),
    castle: fx('castle-08-low-lock'),
    move: fx('07'),
    brilliant: fx('default'),
  };
  assert.deepEqual(
    ['check', 'castle', 'move', 'brilliant'].map(ev => a.call('fxUrl', ev)),
    [
      'https://extension.test/sounds/check/16-firm-alert.wav',
      'https://extension.test/sounds/castle/08-low-lock.wav',
      'https://extension.test/sounds/fx/chess_sound_07.wav',
      'https://extension.test/sounds/brilliant/01-crystal-revelation.wav',
    ],
  );
  // An unknown id, and a candidate from the WRONG event, fall back to that event's default cue.
  a.state.settings.soundFx = { ...a.state.settings.soundFx, check: fx('check-99-nowhere') };
  assert.equal(a.call('fxConfig', 'check').snd, 'default');
  a.state.settings.soundFx = { ...a.state.settings.soundFx, check: fx('castle-01-classic-pair') };
  assert.equal(a.call('fxConfig', 'check').snd, 'default');
  // Off is silent, and still a valid stored choice.
  a.state.settings.soundFx = { ...a.state.settings.soundFx, check: fx('none') };
  assert.equal(a.call('fxConfig', 'check').snd, 'none');
  assert.equal(a.call('fxUrl', 'check'), null);
});

test('every offered candidate is a packaged sound file, and defaults stay Lichess', t => {
  const a = app(t);
  const events = a.run('EVENT_SOUNDS');
  const shipped = JSON.parse(JSON.stringify(a.run('SOUND_EVENTS')));
  const files = events.check.concat(events.castle, events.brilliant).map(([, , file]) => file);
  assert.equal(events.check.length, 30);
  assert.equal(events.castle.length, 15);
  assert.equal(events.brilliant.length, 10);
  for (const file of files) assert.ok(existsSync(ROOT + file), 'missing ' + file);
  // The brilliant default is its first candidate; the existing move-event defaults are untouched.
  assert.equal(events.brilliant[0][0], 'default');
  assert.deepEqual(shipped.map(([key, , file]) => [key, file]), [
    ['move', 'sounds/move-self.mp3'],
    ['capture', 'sounds/capture.mp3'],
    ['check', 'sounds/Check.mp3'],
    ['castle', 'sounds/Castling.mp3'],
    ['brilliant', 'sounds/brilliant/01-crystal-revelation.wav'],
  ]);
});

// The panel is where a user actually meets the candidates: every one must be listed (plus the shared
// effects and Off), the closed button must name its event, and a click must save the choice.
test('the sound panel lists every candidate and saves the chosen cue', t => {
  const a = app(t);
  loadGame(a, '1. e4 e5');
  a.call('computeDerived'); a.call('buildUI'); a.call('renderAll');
  a.call('toggleSettings');          // the panel must be open for a click to re-render it
  a.call('selectSettingsCategory', 'sound');
  const doc = a.dom.window.document;
  const controls = (ev) => doc.querySelector(`[data-sound-event="${ev}"]`);
  const options = (ev) => [...controls(ev).querySelectorAll('.lib-dd-opt')].map(n => n.textContent);

  assert.equal(options('check').length, 41, '30 candidates + Lichess + 9 shared effects + Off');
  assert.equal(options('castle').length, 26, '15 candidates + Lichess + 9 shared effects + Off');
  assert.equal(options('brilliant').length, 20, '10 candidates (first is the default) + 9 shared + Off');
  assert.equal(options('check')[0], 'Lichess');
  assert.equal(options('brilliant')[0], '01 · Crystal Revelation');
  for (const ev of ['check', 'castle', 'brilliant']) {
    assert.equal(options(ev).at(-1), 'Off');
    assert.equal(controls(ev).querySelector('.lib-dd-btn').getAttribute('aria-label'), ev === 'brilliant' ? 'Brilliant move sound' : ev[0].toUpperCase() + ev.slice(1) + ' sound');
  }

  [...controls('check').querySelectorAll('.lib-dd-opt')].find(n => n.textContent === '16 · Firm Alert').click();
  assert.equal(a.state.settings.soundFx.check.snd, 'check-16-firm-alert');
  assert.equal(a.store.settings.soundFx.check.snd, 'check-16-firm-alert');
  assert.equal(controls('check').querySelector('.lib-dd-cur').textContent, '16 · Firm Alert');

  [...controls('brilliant').querySelectorAll('.lib-dd-opt')].find(n => n.textContent === 'Off').click();
  assert.equal(a.store.settings.soundFx.brilliant.snd, 'none');
  assert.equal(controls('brilliant').querySelector('.lib-dd-cur').textContent, 'Off');
});
