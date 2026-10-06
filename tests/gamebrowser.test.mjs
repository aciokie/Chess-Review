import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { fetchUserGamesList } from '../chesscom.js';
import { fetchLichessUserGamesList, parsePgnHeaders } from '../lichess.js';
import { renderGameBrowser } from '../gamebrowser.js';

// Setup basic global DOM for tests
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
  url: 'https://localhost/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;

test('parsePgnHeaders extracts header key-values from PGN string and handles malformed strings', () => {
  const pgn = `[Event "Rated Blitz game"]
[Site "https://lichess.org/ABC12345"]
[Date "2026.01.15"]
[White "MagnusCarlsen"]
[Black "Hikaru"]
[Result "1-0"]
[WhiteElo "2880"]
[BlackElo "2820"]

1. e4 e5 2. Nf3 Nc6 1-0`;

  const headers = parsePgnHeaders(pgn);
  assert.equal(headers.Event, 'Rated Blitz game');
  assert.equal(headers.Site, 'https://lichess.org/ABC12345');
  assert.equal(headers.White, 'MagnusCarlsen');
  assert.equal(headers.Black, 'Hikaru');
  assert.equal(headers.Result, '1-0');
  assert.equal(headers.WhiteElo, '2880');
  assert.equal(headers.BlackElo, '2820');

  // Empty string / invalid input
  const emptyHeaders = parsePgnHeaders('');
  assert.deepEqual(emptyHeaders, {});

  const nullHeaders = parsePgnHeaders(null);
  assert.deepEqual(nullHeaders, {});
});

test('fetchLichessUserGamesList parses multi-game PGN responses and calculates outcome relative to user', async () => {
  const originalFetch = globalThis.fetch;
  const sampleMultiPgn = `[Event "Rated Blitz game"]
[Site "https://lichess.org/GameOne1"]
[UTCDate "2026.02.10"]
[UTCTime "14:00:00"]
[White "testuser"]
[Black "opponent1"]
[Result "1-0"]
[WhiteElo "1800"]
[BlackElo "1750"]
[TimeControl "180+0"]

1. e4 e5 1-0

[Event "Rated Bullet game"]
[Site "https://lichess.org/GameTwo2"]
[UTCDate "2026.02.09"]
[UTCTime "10:00:00"]
[White "opponent2"]
[Black "testuser"]
[Result "1-0"]
[WhiteElo "1900"]
[BlackElo "1800"]
[TimeControl "60+0"]

1. d4 d5 1-0

[Event "Rated Rapid game"]
[Site "https://lichess.org/GameThr3"]
[UTCDate "2026.02.08"]
[UTCTime "08:00:00"]
[White "testuser"]
[Black "opponent3"]
[Result "1/2-1/2"]
[WhiteElo "1800"]
[BlackElo "1800"]
[TimeControl "600+0"]

1. e4 e5 1/2-1/2`;

  globalThis.fetch = async (url) => {
    return {
      ok: true,
      text: async () => sampleMultiPgn,
    };
  };

  try {
    const res = await fetchLichessUserGamesList('testuser', { limit: 50, timeClass: 'all' });
    assert.equal(res.games.length, 3);

    const game1 = res.games[0];
    assert.equal(game1.id, 'GameOne1');
    assert.equal(game1.mySide, 'w');
    assert.equal(game1.result, 'win');
    assert.equal(game1.opponent.username, 'opponent1');
    assert.equal(game1.opponent.rating, 1750);
    assert.equal(game1.timeClass, 'blitz');

    const game2 = res.games[1];
    assert.equal(game2.id, 'GameTwo2');
    assert.equal(game2.mySide, 'b');
    assert.equal(game2.result, 'loss');
    assert.equal(game2.opponent.username, 'opponent2');
    assert.equal(game2.opponent.rating, 1900);
    assert.equal(game2.timeClass, 'bullet');

    const game3 = res.games[2];
    assert.equal(game3.id, 'GameThr3');
    assert.equal(game3.result, 'draw');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchLichessUserGamesList throws on HTTP error like 404 non-existent user', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
  });

  try {
    await assert.rejects(
      async () => {
        await fetchLichessUserGamesList('non_existent_user_99999');
      },
      /not found/i
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchUserGamesList handles month archives, filters by timeClass, and supports pagination state', async () => {
  const originalFetch = globalThis.fetch;

  const testUser = 'unique_gb_user_' + Date.now();
  const archiveUrl1 = `https://api.chess.com/pub/player/${testUser}/games/2026/02`;
  const archiveUrl2 = `https://api.chess.com/pub/player/${testUser}/games/2026/01`;

  globalThis.fetch = async (url) => {
    if (url.includes('/games/archives')) {
      return {
        ok: true,
        json: async () => ({
          archives: [archiveUrl2, archiveUrl1], // January then February
        }),
      };
    }
    if (url === archiveUrl1) {
      return {
        ok: true,
        json: async () => ({
          games: [
            {
              url: 'https://www.chess.com/game/live/1000000101',
              pgn: '1. e4 e5 1-0',
              time_class: 'blitz',
              time_control: '180+0',
              end_time: 1770000000,
              white: { username: testUser, rating: 1600, result: 'win' },
              black: { username: 'rival1', rating: 1550, result: 'resigned' },
            },
            {
              url: 'https://www.chess.com/game/live/1000000102',
              pgn: '1. d4 d5 0-1',
              time_class: 'rapid',
              time_control: '600+0',
              end_time: 1770001000,
              white: { username: 'rival2', rating: 1700, result: 'win' },
              black: { username: testUser, rating: 1600, result: 'checkmated' },
            },
          ],
        }),
      };
    }
    if (url === archiveUrl2) {
      return {
        ok: true,
        json: async () => ({
          games: [
            {
              url: 'https://www.chess.com/game/live/1000000100',
              pgn: '1. c4 c5 1/2-1/2',
              time_class: 'blitz',
              time_control: '180+0',
              end_time: 1769000000,
              white: { username: testUser, rating: 1580, result: 'stalemate' },
              black: { username: 'rival3', rating: 1590, result: 'stalemate' },
            },
          ],
        }),
      };
    }
    return { ok: false, status: 404 };
  };

  try {
    // 1. Fetch limit 1 game
    const res1 = await fetchUserGamesList(testUser, { limit: 1, timeClass: 'all' });
    assert.equal(res1.games.length, 1);
    assert.equal(res1.games[0].id, '1000000102'); // Newer game first
    assert.equal(res1.hasMore, true);

    // 2. Fetch second game using archiveState pagination
    const res2 = await fetchUserGamesList(testUser, {
      limit: 1,
      archiveState: res1.archiveState,
      timeClass: 'all',
    });
    assert.equal(res2.games.length, 1);
    assert.equal(res2.games[0].id, '1000000101');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchUserGamesList throws on user not found (404 archives)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
  });

  try {
    await assert.rejects(
      async () => {
        await fetchUserGamesList('definitely_non_existent_player_123456');
      },
      /HTTP 404/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('renderGameBrowser UI element interactions and filter toggles', async () => {
  localStorage.clear();
  const container = document.createElement('div');
  document.body.appendChild(container);

  let selectedGame = null;

  renderGameBrowser(container, {
    onSelectGame: (g) => { selectedGame = g; },
    onPastePgn: () => {},
    onExplore: () => {},
  });

  await new Promise((r) => setTimeout(r, 20));

  const searchInput = container.querySelector('.gb-search-input');
  assert.ok(searchInput);

  let filterBtns = container.querySelectorAll('.gb-filter-btn');
  assert.equal(filterBtns.length, 5);

  // Click Blitz filter button
  filterBtns[1].click();

  // Query new filter buttons after render re-creation
  filterBtns = container.querySelectorAll('.gb-filter-btn');
  assert.ok(filterBtns[1].classList.contains('on'));

  // Switch to Lichess platform
  let platformBtns = container.querySelectorAll('.gb-platform-toggle button');
  platformBtns[1].click();

  platformBtns = container.querySelectorAll('.gb-platform-toggle button');
  assert.ok(platformBtns[1].classList.contains('on'));
});
