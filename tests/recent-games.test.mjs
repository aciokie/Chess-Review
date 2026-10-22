import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECENT_MAX, splitMultiGamePgn, pgnHeader, timeClassFromLichessTimeControl,
  lichessGameToEntry, fetchLichessRecentGames, chessComResult, chessComGameToEntry,
  fetchChessComRecentGames, fetchRecentGames, isValidUsername, describeEntry,
} from '../recent-games.js';

/* ---------------- fixtures ---------------- */

const liGame = ({ id, white, black, result, date, time, tc, elo, opening }) => [
  `[Event "Rated Blitz game"]`,
  `[Site "https://lichess.org/${id}"]`,
  `[Date "2026.10.01"]`,
  `[White "${white}"]`,
  `[Black "${black}"]`,
  `[Result "${result}"]`,
  `[UTCDate "${date}"]`,
  `[UTCTime "${time}"]`,
  `[WhiteElo "${elo}"]`,
  `[BlackElo "${elo + 5}"]`,
  `[TimeControl "${tc}"]`,
  `[ECO "C50"]`,
  `[Opening "Italian Game"]`,
  ``,
  `1. e4 e5 2. Nf3 *`,
].join('\n');

const ccGame = ({ id, white, whiteResult, black, blackResult, whiteElo = 1500, blackElo = 1500, timeClass = 'blitz', endTime, rated = true }) => ({
  url: `https://www.chess.com/game/live/${id}`,
  pgn: `[Event "Live Chess"]\n[White "${white}"]\n[Black "${black}"]\n[Result "${whiteResult === 'win' ? '1-0' : blackResult === 'win' ? '0-1' : '1/2-1/2'}"]\n\n1. e4 e5 *`,
  time_control: '600',
  end_time: endTime,
  rated,
  white: { username: white, rating: whiteElo, result: whiteResult },
  black: { username: black, rating: blackElo, result: blackResult },
  time_class: timeClass,
});

const jsonResponse = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const fetchFrom = (routes) => async (url) => {
  for (const [pattern, responder] of routes) {
    if (url.includes(pattern)) return typeof responder === 'function' ? responder(url) : responder;
  }
  return new Response('nope', { status: 404 });
};

/* ---------------- Lichess ---------------- */

test('a multi-game Lichess export splits into per-game PGNs with headers read back', () => {
  const text = [liGame({ id: 'aaaaaaaa', white: 'Ana', black: 'Bob', result: '1-0', date: '2026.10.01', time: '10:00:00', tc: '300+0', elo: 1700 }),
                liGame({ id: 'bbbbbbbb', white: 'Cy', black: 'Ana', result: '0-1', date: '2026.10.02', time: '22:30:00', tc: '60+0', elo: 1701 })].join('\n\n');
  const games = splitMultiGamePgn(text);
  assert.equal(games.length, 2);
  assert.equal(pgnHeader(games[0], 'Site'), 'https://lichess.org/aaaaaaaa');
  assert.equal(pgnHeader(games[0], 'White'), 'Ana');
  const entry = lichessGameToEntry(games[0]);
  assert.equal(entry.gameId, 'aaaaaaaa');
  assert.equal(entry.url, 'https://lichess.org/aaaaaaaa');
  assert.equal(entry.white, 'Ana');
  assert.equal(entry.result, '1-0');
  assert.equal(entry.timeClass, 'blitz');
  assert.equal(entry.opening, 'Italian Game');
  assert.equal(entry.eco, 'C50');
  assert.match(entry.playedAt, /^2026-10-01T10:00/);
});

test('Lichess time controls map to the same classes Lichess uses', () => {
  assert.equal(timeClassFromLichessTimeControl('60+0'), 'bullet');
  assert.equal(timeClassFromLichessTimeControl('179'), 'bullet');
  assert.equal(timeClassFromLichessTimeControl('180+0'), 'blitz');
  assert.equal(timeClassFromLichessTimeControl('479'), 'blitz');
  assert.equal(timeClassFromLichessTimeControl('480+0'), 'rapid');
  assert.equal(timeClassFromLichessTimeControl('480+2'), 'rapid');
  assert.equal(timeClassFromLichessTimeControl('1500+20'), 'classical');
  assert.equal(timeClassFromLichessTimeControl('-'), 'unlimited');
  assert.equal(timeClassFromLichessTimeControl(''), 'unlimited');
});

test('Lichess recent games come back newest first, capped at max', async () => {
  const mk = (i, date) => liGame({ id: `id${String(i).padStart(6, '0')}`, white: 'Ana', black: 'Bob', result: '1-0', date, time: '12:00:00', tc: '300+0', elo: 1700 });
  const games = Array.from({ length: 40 }, (_, i) => {
    const day = String((i % 28) + 1).padStart(2, '0');
    return mk(i, `2026.${String((i % 12) + 1).padStart(2, '0')}.${day}`);
  }).join('\n\n');
  const fetchImpl = fetchFrom([['/api/games/user/ana', jsonResponse(games)]]);
  const list = await fetchLichessRecentGames('ana', { max: 30, fetchImpl });
  assert.equal(list.length, 30);
  assert.equal(list[0].playedAt >= list[1].playedAt, true, 'sorted newest first');
  assert.ok(list.every((e) => e.source === 'lichess' && /^[a-z0-9]{8}$/.test(e.gameId)));
});

test('Lichess errors are human-readable: unknown user, rate limit, HTTP', async () => {
  await assert.rejects(
    fetchLichessRecentGames('ghost', { fetchImpl: fetchFrom([['/api/games/user/ghost', new Response('not found', { status: 404 })]]) }),
    /not found/i,
  );
  await assert.rejects(
    fetchLichessRecentGames('ana', { fetchImpl: fetchFrom([['/api/games/user/ana', new Response('slow down', { status: 429 })]]) }),
    /rate-limited/i,
  );
  await assert.rejects(
    fetchLichessRecentGames('ana', { fetchImpl: fetchFrom([['/api/games/user/ana', new Response('boom', { status: 500 })]]) }),
    /HTTP 500/,
  );
});

/* ---------------- Chess.com ---------------- */

test('Chess.com result strings reduce to a game result, and entries map cleanly', () => {
  assert.equal(chessComResult('win', 'resign'), '1-0');
  assert.equal(chessComResult('checkmated', 'win'), '0-1');
  assert.equal(chessComResult('agreed', 'agreed'), '½-½');
  assert.equal(chessComResult('timeout', 'timeout'), '½-½'); // both non-win → draw per chess.com data
  const entry = chessComGameToEntry(ccGame({ id: '1234567890', white: 'Ana', whiteResult: 'win', black: 'Bob', blackResult: 'resign', timeClass: 'rapid', endTime: 1760000000 }));
  assert.equal(entry.result, '1-0');
  assert.equal(entry.gameId, '1234567890');
  assert.equal(entry.timeClass, 'rapid');
  assert.equal(entry.whiteElo, 1500);
  assert.match(entry.playedAt, /^2025-10/);
  assert.equal(chessComGameToEntry({ url: 'https://www.chess.com/game/live/1' }), null, 'a game without PGN is dropped');
});

test('Chess.com recent games walk archives newest first and stop at max', async () => {
  const monthA = { games: [
    ccGame({ id: '1000012345', white: 'Ana', whiteResult: 'win', black: 'X', blackResult: 'resign', endTime: 1000 }),
    ccGame({ id: '1000012346', white: 'Y', whiteResult: 'win', black: 'Ana', blackResult: 'checkmated', endTime: 2000 }),
  ] };
  const monthB = { games: [
    ccGame({ id: '2000012345', white: 'Ana', whiteResult: 'win', black: 'Z', blackResult: 'resign', endTime: 3000 }),
    ccGame({ id: '2000012346', white: 'W', whiteResult: 'win', black: 'Ana', blackResult: 'resign', endTime: 4000 }),
  ] };
  const routes = [
    ['/games/archives', () => jsonResponse({ archives: ['https://api.chess.com/pub/player/ana/games/2026/09', 'https://api.chess.com/pub/player/ana/games/2026/10'] })],
    ['/games/2026/10', () => jsonResponse(monthB)],
    ['/games/2026/09', () => jsonResponse(monthA)],
  ];
  const list = await fetchChessComRecentGames('Ana', { max: 30, fetchImpl: fetchFrom(routes) });
  assert.deepEqual(list.map((e) => e.gameId), ['2000012346', '2000012345', '1000012346', '1000012345'], 'newest month first, newest game first within it');
  assert.equal(list[0].playedAt >= list[1].playedAt, true);

  const capped = await fetchChessComRecentGames('Ana', { max: 3, fetchImpl: fetchFrom(routes) });
  assert.equal(capped.length, 3);
});

test('Chess.com 404 on the archives index means unknown user, and 5xx is retried', async () => {
  await assert.rejects(
    fetchChessComRecentGames('ghost', { fetchImpl: fetchFrom([['/games/archives', new Response('nf', { status: 404 })]]) }),
    /not found/i,
  );
  let calls = 0;
  const flaky = async () => { calls += 1; if (calls < 3) return new Response('boom', { status: 502 }); return jsonResponse({ archives: [] }); };
  const list = await fetchChessComRecentGames('ana', { fetchImpl: flaky });
  assert.deepEqual(list, []);
  assert.equal(calls, 3);
});

/* ---------------- shared ---------------- */

test('fetchRecentGames validates usernames and dispatches per site', async () => {
  await assert.rejects(fetchRecentGames('', 'lichess'), /Type a username/);
  await assert.rejects(fetchRecentGames('has space', 'lichess'), /valid Lichess username/);
  await assert.rejects(fetchRecentGames('ab', 'chesscom'), /valid Chess\.com username/);
  const list = await fetchRecentGames('ana', 'lichess', { fetchImpl: fetchFrom([['/api/games/user/ana', jsonResponse(liGame({ id: 'aaaaaaaa', white: 'Ana', black: 'Bob', result: '1-0', date: '2026.10.01', time: '10:00:00', tc: '300+0', elo: 1700 }))]]) });
  assert.equal(list.length, 1);
});

test('isValidUsername matches each site rules', () => {
  assert.equal(isValidUsername('DrNykterstein', 'lichess'), true);
  assert.equal(isValidUsername('a-b_1', 'lichess'), true);
  assert.equal(isValidUsername('-leading', 'lichess'), false);
  assert.equal(isValidUsername('has space', 'lichess'), false);
  assert.equal(isValidUsername('hikaru', 'chesscom'), true);
  assert.equal(isValidUsername('ab', 'chesscom'), false);
});

test('describeEntry reads the result from the viewer side when they played', () => {
  const entry = { white: 'Ana', black: 'Bob', result: '1-0', whiteElo: 1500, blackElo: 1500 };
  assert.equal(describeEntry(entry, 'ana').mine, 'Win');
  assert.equal(describeEntry(entry, 'bob').mine, 'Loss');
  assert.equal(describeEntry(entry, 'guest').mine, '');
  assert.equal(describeEntry(entry, 'ana').who, 'Ana (1500) vs Bob (1500)');
});

/* ---------------- variants are never listed (the analyzer only handles standard chess) ---------------- */

import { isStandardVariant } from '../recent-games.js';
import { parseLichessGameId } from '../lichess.js';

test('isStandardVariant accepts standard chess and rejects variants', () => {
  for (const v of ['', undefined, 'Standard', 'Chess', 'From Position']) assert.equal(isStandardVariant(v), true, String(v));
  for (const v of ['Chess960', 'Crazyhouse', 'Atomic', 'Antichess', 'Horde']) assert.equal(isStandardVariant(v), false, v);
});

test('a Lichess variant game is dropped from the list', () => {
  const pgn = liGame({ id: 'abcd1234', white: 'a', black: 'b', result: '1-0', date: '2026.10.01', time: '10:00:00', tc: '300+0', elo: 1500 })
    .replace('[Event', '[Variant "Crazyhouse"]\n[Event');
  assert.equal(lichessGameToEntry(pgn), null);
});

test('Chess.com non-standard rules are dropped, standard ones kept', () => {
  const base = ccGame({ id: 111111, white: 'a', whiteResult: 'win', black: 'b', blackResult: 'resigned', endTime: 1700000000 });
  assert.ok(chessComGameToEntry({ ...base, rules: 'chess' }));
  assert.ok(chessComGameToEntry(base)); // no rules field → assume standard
  assert.equal(chessComGameToEntry({ ...base, rules: 'chess960' }), null);
  assert.equal(chessComGameToEntry({ ...base, rules: 'bughouse' }), null);
});

test('8-letter Lichess page names are not mistaken for game ids', () => {
  for (const p of ['insights', 'database', 'feedback', 'training', 'analysis']) {
    assert.equal(parseLichessGameId(`https://lichess.org/${p}`), null, p);
  }
  assert.deepEqual(parseLichessGameId('https://lichess.org/AbCd1234'), { id: 'AbCd1234' });
});
