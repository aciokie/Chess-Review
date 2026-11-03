import test from 'node:test';
import assert from 'node:assert/strict';
import { app, loadGame, deferred } from './helpers/app.mjs';
import { analysisCacheKey } from '../gameid.js';
import { libraryFlip } from '../lib/library-seat.js';

// Two independent analysis tabs = two vm contexts with their own S.library snapshots, sharing one
// browser storage and one Web Locks manager — exactly like two extension tabs sharing
// browserAPI.storage.local["library"]. This lets us interleave their read/modify/write cycles.
function sharedTabs(t) {
  const tabs = [app(t), app(t)];
  const store = { library: [] };
  let lock = Promise.resolve();
  const locks = {
    request(name, callback) {
      assert.equal(name, 'chess-review-library');
      const next = lock.then(callback);
      lock = next.catch(() => {});
      return next;
    },
  };
  const storage = {
    async get(key) {
      if (Array.isArray(key)) {
        const out = {}; for (const k of key) out[k] = structuredClone(store[k]); return out;
      }
      return { [key]: structuredClone(store[key]) };
    },
    async set(values) { Object.assign(store, structuredClone(values)); },
    async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k]; },
  };
  for (const a of tabs) {
    a.context.browserAPI.storage.local = storage;
    Object.defineProperty(a.dom.window.navigator, 'locks', { value: locks, configurable: true });
    a.replace('renderLibrary', () => {});
    loadGame(a, '1. e4 e5');
    a.call('computeDerived');
  }
  return { tabs, store, storage };
}

test('1: simultaneous saves in stale tabs keep both games and their analysis', async t => {
  const { tabs: [a, b], store, storage } = sharedTabs(t);
  a.state.meta = { gameId: 'a' };
  b.state.meta = { gameId: 'b' };
  // Force a real interleaving: hold tab A's read open until tab B has queued its save.
  const firstRead = deferred(), release = deferred();
  const get = storage.get;
  let reads = 0;
  storage.get = async (key) => {
    if (++reads === 1) { firstRead.resolve(); await release.promise; }
    return get(key);
  };
  const first = a.call('saveToLibrary');
  await firstRead.promise;
  const second = b.call('saveToLibrary');
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(store.library.map((g) => g.id).sort(), ['a', 'b']);
  assert.ok(store[analysisCacheKey('a')]);
  assert.ok(store[analysisCacheKey('b')]);
});

test('2: a favorite set in one tab survives another tab saving', async t => {
  const { tabs: [a, b], store } = sharedTabs(t);
  a.state.meta = { gameId: 'a' };
  b.state.meta = { gameId: 'b' };
  await a.call('saveToLibrary');
  // Tab B still holds the stale (empty) library; both mutations are in flight together.
  const fav = a.call('toggleFav', 'a');
  const save = b.call('saveToLibrary');
  await Promise.all([fav, save]);
  assert.equal(store.library.find((g) => g.id === 'a').fav, true);
  assert.ok(store.library.find((g) => g.id === 'b'));
});

test('3: a solved mark in one tab survives another tab saving', async t => {
  const { tabs: [a, b], store } = sharedTabs(t);
  a.state.meta = { gameId: 'a' };
  b.state.meta = { gameId: 'b' };
  await a.call('saveToLibrary');
  const solved = a.call('markCurrentSolved');
  const save = b.call('saveToLibrary');
  await Promise.all([solved, save]);
  assert.equal(store.library.find((g) => g.id === 'a').solved, true);
  assert.ok(store.library.find((g) => g.id === 'b'));
});

test('4: a stale tab writing later does not lose another tab changes', async t => {
  const { tabs: [a, b], store } = sharedTabs(t);
  a.state.meta = { gameId: 'a' };
  b.state.meta = { gameId: 'b' };
  await a.call('saveToLibrary');
  await a.call('toggleFav', 'a');
  assert.equal(store.library.find((g) => g.id === 'a').fav, true);
  // Tab B never refreshed: its in-memory library is still the initial empty list.
  assert.equal(b.state.library.length, 0);
  await b.call('saveToLibrary');               // the stale write lands afterwards
  assert.equal(store.library.length, 2);
  assert.equal(store.library.find((g) => g.id === 'a').fav, true);
  assert.equal(store.library.find((g) => g.id === 'a').solved, true);
  assert.ok(store.library.find((g) => g.id === 'b'));
});

test('5: two tabs saving the same game id keep exactly one record', async t => {
  const { tabs: [a, b], store } = sharedTabs(t);
  a.state.meta = { gameId: 'x' };
  b.state.meta = { gameId: 'x' };
  store.library = [{ id: 'x', fav: true, solved: true, savedAt: 1 }]; // already a favorite
  await Promise.all([a.call('saveToLibrary'), b.call('saveToLibrary')]);
  assert.equal(store.library.filter((g) => g.id === 'x').length, 1);
  assert.equal(store.library.find((g) => g.id === 'x').fav, true);
  assert.equal(store.library.find((g) => g.id === 'x').solved, true);
});

test('6: eviction still holds under concurrent writes', async t => {
  const { tabs: [a, b], store } = sharedTabs(t);
  store.library = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), savedAt: i }));
  store[analysisCacheKey('999')] = { old: true };
  store[analysisCacheKey('0')] = { retained: true };
  a.state.meta = { gameId: 'newA' };
  b.state.meta = { gameId: 'newB' };
  await Promise.all([a.call('saveToLibrary'), b.call('saveToLibrary')]);
  assert.equal(store.library.length, 1000);
  assert.equal(store.library[0].id, 'newB');               // last queued is newest
  assert.ok(store.library.some((g) => g.id === 'newA'));
  assert.equal(store[analysisCacheKey('999')], undefined); // evicted blob cleaned up
  assert.ok(store[analysisCacheKey('0')]);                 // untouched blob retained
});

test('7: the saved record carries the game length and per-phase accuracy', async t => {
  const { tabs: [a], store } = sharedTabs(t);
  a.state.meta = { gameId: 'p' };
  await a.call('saveToLibrary');
  const rec = store.library.find((g) => g.id === 'p');
  assert.equal(rec.plies, a.state.total);                  // the Progress page's "fastest win"
  // Per-phase accuracy is stored as an object of the three phases (or null when it couldn't be
  // computed); the Progress page reads exactly this shape.
  assert.ok(rec.myPhases === null || ["opening", "middlegame", "endgame"].every((k) => k in rec.myPhases));
  // The rating the review estimates for each side (the board's "≈ N elo") is stored too, so Progress
  // reports this review's number instead of only the PGN's platform rating.
  assert.equal(rec.myEstimate, a.call('ratingEstimate', a.state.meSide));
  assert.equal(rec.opEstimate, a.call('ratingEstimate', a.state.meSide === 'w' ? 'b' : 'w'));
});

test('8: the saved record carries each side worst decision for deep links', async t => {
  const { tabs: [a], store } = sharedTabs(t);
  a.state.meta = { gameId: 'worst' };
  // meSide defaults to White here; ply 1 is White's move, ply 2 Black's.
  a.state.classif = [null, 'blunder', 'mistake'];
  await a.call('saveToLibrary');
  const rec = store.library.find((g) => g.id === 'worst');
  assert.deepEqual(rec.myWorst, { ply: 1, cat: 'blunder' });
  assert.deepEqual(rec.opWorst, { ply: 2, cat: 'mistake' });
});

test('12: a header-less PGN is saved under the tracked handle, not the "White" placeholder', async t => {
  // A pasted movetext or bare FEN reviews as White/Black. If the record kept those placeholders the
  // Progress page could not match it to the account and would silently drop the game.
  const a = app(t);
  a.state.username = 'Tester';
  loadGame(a, '1. e4 e5');
  a.call('computeDerived');
  await a.call('saveToLibrary');
  const [rec] = a.store.library;
  assert.equal(rec.myName, 'Tester');
  assert.equal(rec.opName, 'Black', 'the opponent keeps its placeholder');
});

test('13: real header names are never replaced by the handle', async t => {
  const a = app(t);
  a.state.username = 'Tester';
  loadGame(a, '[White "Ann"]\n[Black "Bob"]\n\n1. e4 e5');
  // applyGame is what derives these from the PGN headers; loadGame leaves the placeholder players.
  a.state.players = { w: { name: 'Ann' }, b: { name: 'Bob' } };
  a.call('computeDerived');
  await a.call('saveToLibrary');
  const [rec] = a.store.library;
  assert.equal(rec.myName, 'Ann');
  assert.equal(rec.opName, 'Bob');
});

test('14: a junk entry in stored library does not break a save', async t => {
  // storage is user-editable; a null used to throw in every list operation, including the save that
  // would otherwise repair it.
  const a = app(t);
  loadGame(a, '1. e4 e5');
  a.call('computeDerived');
  a.store.library = [null, 42, 'junk', { id: 'keep', pgn: '1. e4' }];
  await a.call('saveToLibrary');
  assert.ok(a.store.library.every((rec) => rec && typeof rec === 'object' && typeof rec.id === 'string'));
  assert.ok(a.store.library.some((rec) => rec.id === 'keep'), 'the real record survives');
  assert.equal(a.store.library.length, 2, 'the junk is dropped, the new game is added');
});

test('16: the library sidebar and the Progress page seat a saved game the same way', async t => {
  // The two doors into a saved game used to disagree: Progress opened a record saved from the
  // opponent's seat facing the tracked account, the analyzer's sidebar faced the seat it was saved
  // for. Both now call the same rule (lib/library-seat.js).
  const a = app(t);
  const pgn = '[White "Carl"]\n[Black "Ann"]\n\n1. e4 e5';
  loadGame(a, pgn);
  a.state.username = 'Ann';
  a.state.players = { w: { name: 'Carl' }, b: { name: 'Ann' } };
  const rec = { id: 'saved-from-theirs', pgn, meta: {}, meSide: 'w', myName: 'Carl', opName: 'Ann' };
  let payload = null;
  a.replace('applyGame', (p) => { payload = p; });
  await a.call('openLibraryGame', rec);
  assert.equal(payload.meta.flip, true, 'seated as the tracked account (Black), not as the saved seat');
  assert.equal(payload.meta.flip, libraryFlip(rec, 'Ann'), 'and it is the shared rule, not a second one');

  // A game saved for this account keeps its own orientation, including a manual flip hint.
  const mine = { ...rec, id: 'mine', meta: { flip: true }, meSide: 'b', myName: 'Ann', opName: 'Carl' };
  payload = null;
  await a.call('openLibraryGame', mine);
  assert.equal(payload.meta.flip, true);
  assert.equal(payload.meta.flip, libraryFlip(mine, 'Ann'));
});

test('15: a non-array stored library does not wipe the saved games', async t => {
  // `??` only falls back on null/undefined, so a half-written string or object in storage was cleaned
  // to [] and then written straight back - erasing every saved game on the next save/favorite.
  const a = app(t);
  a.replace('renderLibrary', () => {});
  loadGame(a, '1. e4 e5');
  a.call('computeDerived');
  a.state.meta = { gameId: 'a' };
  await a.call('saveToLibrary');
  assert.deepEqual(a.store.library.map((rec) => rec.id), ['a']);
  a.store.library = { not: 'a library' };
  await a.call('toggleFav', 'a');
  assert.deepEqual(a.store.library.map((rec) => rec.id), ['a'], 'the in-memory list is used, not the bad value');
  assert.equal(a.store.library[0].fav, true);
});
