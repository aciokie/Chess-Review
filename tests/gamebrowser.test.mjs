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

test('parsePgnHeaders extracts header key-values from PGN string', () => {
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

1. d4 d5 1-0`;

  globalThis.fetch = async (url) => {
    return {
      ok: true,
      text: async () => sampleMultiPgn,
    };
  };

  try {
    const res = await fetchLichessUserGamesList('testuser', { limit: 50, timeClass: 'all' });
    assert.equal(res.games.length, 2);

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
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchUserGamesList handles month archives and filters by timeClass', async () => {
  const originalFetch = globalThis.fetch;

  const testUser = 'unique_gb_user_' + Date.now();
  const archiveUrl = `https://api.chess.com/pub/player/${testUser}/games/2026/02`;

  globalThis.fetch = async (url) => {
    if (url.includes('/games/archives')) {
      return {
        ok: true,
        json: async () => ({
          archives: [archiveUrl],
        }),
      };
    }
    if (url === archiveUrl) {
      return {
        ok: true,
        json: async () => ({
          games: [
            {
              url: 'https://www.chess.com/game/live/101',
              pgn: '1. e4 e5 1-0',
              time_class: 'blitz',
              time_control: '180+0',
              end_time: 1770000000,
              white: { username: testUser, rating: 1600, result: 'win' },
              black: { username: 'rival1', rating: 1550, result: 'resigned' },
            },
            {
              url: 'https://www.chess.com/game/live/102',
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
    return { ok: false, status: 404 };
  };

  try {
    const res = await fetchUserGamesList(testUser, { limit: 50, timeClass: 'blitz' });
    assert.equal(res.games.length, 1);
    assert.equal(res.games[0].timeClass, 'blitz');
    assert.equal(res.games[0].result, 'win');
    assert.equal(res.games[0].opponent.username, 'rival1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('renderGameBrowser creates UI elements and platform switches correctly', async () => {
  const container = document.createElement('div');
  let selectedGame = null;

  renderGameBrowser(container, {
    onSelectGame: (g) => { selectedGame = g; },
    onPastePgn: () => {},
    onExplore: () => {},
  });

  // Wait for initial async state load to complete and render
  await new Promise((r) => setTimeout(r, 10));

  const title = container.querySelector('.gb-title');
  assert.ok(title);
  assert.match(title.textContent, /Game Browser/);

  const platformButtons = container.querySelectorAll('.gb-platform-toggle button');
  assert.equal(platformButtons.length, 2);
  assert.equal(platformButtons[0].textContent, 'Chess.com');
  assert.equal(platformButtons[1].textContent, 'Lichess');

  const filterButtons = container.querySelectorAll('.gb-filter-btn');
  assert.equal(filterButtons.length, 5); // All, Blitz, Rapid, Bullet, Daily
});
