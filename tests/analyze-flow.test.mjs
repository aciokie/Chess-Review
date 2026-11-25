import test from 'node:test';
import assert from 'node:assert/strict';

// The API facade is captured at import time, just as it is in an extension page.
globalThis.chrome = {};
const { analyzeActiveTab, reloadActiveAndAnalyze, loadGameFromTab } = await import('../analyze-flow.js');

function setup(t, url = 'https://www.chess.com/game/live/12345678') {
  const store = {}, opened = [], listeners = new Set();
  const tabs = new Map([[1, { id: 1, url }]]);
  const state = { activeId: 1, store, opened, listeners, tabs };
  Object.assign(globalThis.chrome, {
    runtime: { getURL: path => `chrome-extension://test/${path}` },
    storage: { local: {
      async get(key) { return { [key]: store[key] }; },
      async set(data) { Object.assign(store, structuredClone(data)); },
      async remove(key) { delete store[key]; },
    } },
    tabs: {
      async query() { return [tabs.get(state.activeId)]; },
      async get(id) { if (!tabs.has(id)) throw Error('Tab closed'); return tabs.get(id); },
      async sendMessage() { throw Error('Receiving end does not exist'); },
      async create(data) { opened.push(data); },
      onUpdated: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } },
      async reload(id) { for (const listener of [...listeners]) listener(id, { status: 'complete' }); },
    },
  });
  t.mock.method(globalThis, 'fetch', async url => ({
    ok: true,
    json: async () => ({ games: [{ url: 'https://www.chess.com/game/live/12345678', pgn: '1. e4 e5 1-0' }] }),
    text: async () => '[Result "1-0"]\n\n1. e4 e5 1-0',
  }));
  state.payload = () => Object.entries(store).find(([key]) => key.startsWith('job:'))?.[1];
  return state;
}

test('Chess.com without a content script uses the saved username and URL', async t => {
  const s = setup(t);
  await analyzeActiveTab('saved-user');
  assert.equal(s.opened.length, 1);
  assert.equal(s.payload().meta.gameId, '12345678');
  assert.equal(Object.hasOwn(s.payload(), 'theme'), false);
});

for (const url of ['https://www.chess.com/game/live/12345678', 'https://lichess.org/AAAAAAAA']) {
  test(`source themes from stale content scripts are discarded: ${url}`, async t => {
    const s = setup(t, url);
    t.mock.method(chrome.tabs, 'sendMessage', async () => ({
      ok: true, gameId: url.includes('lichess') ? 'AAAAAAAA' : '12345678',
      theme: { boardTheme: 'green', boardUrl: 'https://example.test/board.png' },
    }));
    await analyzeActiveTab('saved-user');
    assert.equal(s.opened.length, 1);
    assert.equal(Object.hasOwn(s.payload(), 'theme'), false);
  });
}

test('missing content script and username produces a recoverable username error', async t => {
  setup(t);
  await assert.rejects(analyzeActiveTab(''), err => err.code === 'NO_USERNAME' && err.tabId === 1);
});

// The post-game preview imports the same game read-only. Merely visiting a finished game must never
// turn that page's bottom player into the tracked account (which seats reviews and drives Progress).
test('the read-only preview import resolves the game without writing the account handle', async t => {
  const s = setup(t);
  t.mock.method(chrome.tabs, 'sendMessage', async () => ({
    ok: true, gameId: '12345678', usernames: ['PagePlayer', 'Opponent'], flip: false,
  }));
  const payload = await loadGameFromTab(1);
  assert.equal(payload.meta.gameId, '12345678');
  assert.equal(payload.pgn.includes('1. e4 e5'), true);
  assert.equal('username' in s.store, false, 'a visited page must not become the tracked account');

  // The review flow itself still seeds an empty store from the page on first run.
  await analyzeActiveTab('');
  assert.equal(s.store.username, 'PagePlayer');
});

test('retry retains the original tab before and during the reload', async t => {
  const s = setup(t, 'https://lichess.org/');
  s.tabs.set(2, { id: 2, url: 'https://lichess.org/BBBBBBBB' });
  let originalError;
  try { await analyzeActiveTab(''); } catch (err) { originalError = err; }
  assert.equal(originalError.code, 'NO_GAME');
  s.activeId = 2;
  let reloaded;
  t.mock.method(chrome.tabs, 'reload', async id => {
    reloaded = id;
    s.tabs.get(1).url = 'https://lichess.org/AAAAAAAA';
    for (const fn of [...s.listeners]) fn(id, { status: 'complete' });
  });
  await reloadActiveAndAnalyze('', originalError.tabId);
  assert.equal(reloaded, 1);
  assert.equal(s.payload().meta.gameId, 'AAAAAAAA');
  assert.equal(s.listeners.size, 0);
});

test('a rejected reload immediately cleans up its listener', async t => {
  const s = setup(t);
  t.mock.method(chrome.tabs, 'reload', async () => { throw Error('Reload denied'); });
  await assert.rejects(reloadActiveAndAnalyze('', 1), /Reload denied/);
  assert.equal(s.listeners.size, 0);
});

test('a closed original tab never falls back to the active tab', async t => {
  const s = setup(t);
  s.tabs.set(2, { id: 2, url: 'https://lichess.org/BBBBBBBB' });
  s.tabs.delete(1); s.activeId = 2;
  await assert.rejects(reloadActiveAndAnalyze('', 1), /Tab closed/);
  assert.equal(s.opened.length, 0);
});

test('a Lichess /game/<id> URL imports the exported PGN', async t => {
  const s = setup(t, 'https://lichess.org/game/9pnmvxvA');
  await analyzeActiveTab('');
  assert.equal(s.opened.length, 1);
  assert.equal(s.payload().meta.gameId, '9pnmvxvA');
  assert.equal(s.payload().pgn, '[Result "1-0"]\n\n1. e4 e5 1-0');
});

test('a cached Lichess signup page is ignored and the PGN is re-fetched', async t => {
  const s = setup(t, 'https://lichess.org/game/9pnmvxvA');
  s.store['gamecache:lichess:9pnmvxvA'] = { data: '<!DOCTYPE html><html>Sign up</html>', t: 0 };
  await analyzeActiveTab('');
  assert.equal(s.opened.length, 1);
  assert.equal(s.payload().pgn, '[Result "1-0"]\n\n1. e4 e5 1-0');
  assert.equal(s.store['gamecache:lichess:9pnmvxvA'].data, '[Result "1-0"]\n\n1. e4 e5 1-0');
});

test('Lichess replay recovery prefers the full PGN so ratings, result and setup are retained', async t => {
  const s = setup(t, 'https://lichess.org/game/9pnmvxvA/black');
  const pgn = '[Event "Replay"]\n[White "Player"]\n[WhiteElo "1500"]\n[Result "*"]\n[SetUp "1"]\n[FEN "7k/8/8/8/8/8/4P3/4K3 b - - 0 37"]\n\n37... Kh7 38. e4 *';
  t.mock.method(chrome.tabs, 'sendMessage', async () => ({ site: 'lichess', gameId: '9pnmvxvA', pgn, movetext: '1. e4 e5', flip: true }));
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, text: async () => '<html>Sign up</html>' }));
  await analyzeActiveTab('');
  assert.equal(s.opened.length, 1);
  assert.equal(s.payload().pgn, pgn);
  assert.equal(s.payload().meta.flip, true);
});

// The page's signed-in account and bottom player travel with the launch so the review can resolve
// whose game it is. They are reduced to validated fields on the way in, and a shared link never
// carries them (background strips them) — so nothing here can label a stranger's game as ours.
test('a Chess.com launch carries the page identity, reduced to validated fields', async t => {
  const s = setup(t);
  t.mock.method(chrome.tabs, 'sendMessage', async () => ({
    ok: true, gameId: '12345678',
    perspective: { account: 'Hero', bottom: 'Hero', signedIn: true, boardFlip: false, junk: 'ignored' },
  }));
  await analyzeActiveTab('saved-user');
  assert.deepEqual(s.payload().meta.perspective, { account: 'Hero', bottom: 'Hero', signedIn: true, boardFlip: false });
});

test('a Lichess launch carries the page identity too, and unreadable identity is dropped', async t => {
  const s = setup(t, 'https://lichess.org/game/9pnmvxvA');
  t.mock.method(chrome.tabs, 'sendMessage', async () => ({
    site: 'lichess', gameId: '9pnmvxvA', flip: false, perspective: { account: 'Hero', boardFlip: true },
  }));
  await analyzeActiveTab('');
  assert.deepEqual(s.payload().meta.perspective, { account: 'Hero', bottom: '', signedIn: null, boardFlip: true });

  const junk = setup(t, 'https://lichess.org/game/9pnmvxvA');
  t.mock.method(chrome.tabs, 'sendMessage', async () => ({
    site: 'lichess', gameId: '9pnmvxvA', perspective: { account: 'not a name!', signedIn: 'yes' },
  }));
  await analyzeActiveTab('');
  assert.equal(Object.hasOwn(junk.payload().meta, 'perspective'), false, 'a broken read never reaches the review');
});

// Guest accounts have no public archive, so the archive sweep always misses. The callback endpoint
// /callback/live/game/{id} returns moveList in TCN plus pgnHeaders — decode it to a PGN and import.
test('a guest game with no archive imports via the callback endpoint', async t => {
  const s = setup(t);
  t.mock.method(chrome.tabs, 'sendMessage', async () => ({
    ok: true, gameId: '12345678',
    usernames: ['Guest2278703354', 'Guest318362458'],
  }));
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).includes('/callback/live/game/')) {
      return {
        ok: true,
        json: async () => ({
          game: {
            id: 12345678,
            plyCount: 61,
            moveList: 'gv2UmC92lBZRbs!Tpx8!cu5QfH6ZegWOHA0KBKRKuI98vMZSMS1SnvQBsmTZIBKBmBZPAS!?SJPJCJ7Jks47BrJAdc8mfnOGcf78rGAIGrIPad2VrBVufmunmn',
            pgnHeaders: {
              White: 'Guest2278703354',
              Black: 'Guest318362458',
              Result: '1-0',
              Event: 'Live Chess',
              Site: 'Chess.com',
              Date: '2017.12.12',
              ECO: 'B06',
              WhiteElo: '1500',
              BlackElo: '1500',
              TimeControl: '180+2',
              Termination: 'Guest2278703354 won by resignation',
              SetUp: '1',
              FEN: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            },
          },
        }),
      };
    }
    // Archive lookups miss — guests have no archive.
    return { ok: true, json: async () => ({ games: [] }) };
  });
  await analyzeActiveTab('');
  assert.equal(s.opened.length, 1);
  const p = s.payload();
  assert.equal(p.meta.gameId, '12345678');
  assert.equal(p.pgn.includes('[White "Guest2278703354"]'), true);
  assert.equal(p.pgn.includes('[Black "Guest318362458"]'), true);
  assert.equal(p.pgn.includes('[Result "1-0"]'), true);
  assert.equal(p.pgn.includes('1. Nf3'), true);
  assert.equal('username' in s.store, false, 'a guest name must not be stored as the username');
});

// The callback endpoint does NOT serve guest games: for a real guest game Chess.com answers
// 404 {"message":"Game is not found."} (the game arrived over the live socket and was never
// archived). The page itself always renders the game, so the import must fall back to its move list.
test('a guest game imports from the page move list when the callback answers 404', async t => {
  const s = setup(t, 'https://www.chess.com/game/187970608596');
  t.mock.method(chrome.tabs, 'sendMessage', async () => ({
    ok: true, gameId: '187970608596',
    usernames: ['Guest0400982242', 'Guest9400511873'], flip: false,
    movetext: 'd4 g5 Nf3 Bg7 e4 d6', result: '1-0',
  }));
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).includes('/callback/live/game/')) {
      return { ok: false, status: 404, json: async () => ({ message: 'Game is not found.' }) };
    }
    return { ok: true, json: async () => ({ games: [] }) }; // no archive for a guest
  });
  await analyzeActiveTab('');
  assert.equal(s.opened.length, 1);
  const p = s.payload();
  assert.equal(p.meta.gameId, '187970608596');
  // Both players keep their names (the API-shaped record gameMeta reads must use `username`).
  assert.equal(p.meta.white.user, 'Guest0400982242');
  assert.equal(p.meta.black.user, 'Guest9400511873');
  assert.equal(p.pgn.includes('[White "Guest0400982242"]'), true);
  assert.equal(p.pgn.includes('[Black "Guest9400511873"]'), true);
  assert.equal(p.pgn.includes('[Result "1-0"]'), true);
  assert.equal(p.pgn.includes('1. d4 g5 2. Nf3 Bg7 3. e4 d6'), true);
  assert.equal('username' in s.store, false, 'a guest name must not be stored as the username');
});

// A flipped board means the bottom player is Black, so the seats must not be swapped.
test('the page move list seats the players by board orientation', async t => {
  const s = setup(t, 'https://www.chess.com/game/187971780462');
  t.mock.method(chrome.tabs, 'sendMessage', async () => ({
    ok: true, gameId: '187971780462',
    usernames: ['Guest3423701053', 'Guest7324745241'], flip: true,
    movetext: 'e4 e5 Nf3 Nc6', result: '0-1',
  }));
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 404, json: async () => ({}) }));
  await analyzeActiveTab('');
  const p = s.payload();
  assert.equal(p.meta.white.user, 'Guest7324745241', 'the top player is White when Black is at the bottom');
  assert.equal(p.meta.black.user, 'Guest3423701053');
  assert.equal(p.pgn.includes('[Result "0-1"]'), true);
});
