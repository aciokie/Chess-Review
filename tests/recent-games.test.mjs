import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECENT_MAX, splitMultiGamePgn, pgnHeader, timeClassFromLichessTimeControl,
  lichessGameToEntry, fetchLichessRecentGames, chessComResult, chessComGameToEntry,
  fetchChessComRecentGames, fetchRecentGames, isValidUsername, describeEntry,
  countMoves, formatTimeControl, chessComOpening, describeDetails, createRecentGamesPager,
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

test('Lichess time classes count the increment (estimated duration = base + 40 x increment)', () => {
  assert.equal(timeClassFromLichessTimeControl('120+2'), 'blitz');       // 2+2  → 200 s
  assert.equal(timeClassFromLichessTimeControl('120+1'), 'bullet');      // 2+1  → 160 s
  assert.equal(timeClassFromLichessTimeControl('300+3'), 'blitz');       // 5+3  → 420 s
  assert.equal(timeClassFromLichessTimeControl('300+5'), 'rapid');       // 5+5  → 500 s
  assert.equal(timeClassFromLichessTimeControl('420+5'), 'rapid');       // 7+5  → 620 s
  assert.equal(timeClassFromLichessTimeControl('900+10'), 'rapid');      // 15+10 → 1300 s
  assert.equal(timeClassFromLichessTimeControl('1200+10'), 'classical'); // 20+10 → 1600 s
  assert.equal(timeClassFromLichessTimeControl('180+x'), 'blitz');       // junk increment is ignored
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

test('describeEntry labels a Lichess draw ("1/2-1/2") and a Chess.com draw ("½-½") as Draw', () => {
  const li = lichessGameToEntry(liGame({ id: 'abcd1234', white: 'Ana', black: 'Bob', result: '1/2-1/2', date: '2026.10.01', time: '12:00:00', tc: '300+0', elo: 1500 }));
  assert.equal(describeEntry(li, 'ana').mine, 'Draw');
  assert.equal(describeEntry(li, 'BOB').mine, 'Draw');
  assert.equal(describeEntry(li, 'guest').mine, '');
  const cc = { white: 'Ana', black: 'Bob', result: '½-½' };
  assert.equal(describeEntry(cc, 'ana').mine, 'Draw');
  assert.equal(describeEntry({ white: 'Ana', black: 'Bob', result: '*' }, 'ana').mine, ''); // unfinished: no label
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

/* ---------------- list details: move count, time control, opening ---------------- */

const ccPgn = [
  '[Event "Live Chess"]', '[White "a"]', '[Black "b"]', '[Result "0-1"]', '[ECO "B12"]',
  '[ECOUrl "https://www.chess.com/openings/Caro-Kann-Defense-Advance-Variation-3...c5-4.Nf3"]', '',
  '1. e4 {[%clk 0:03:00.0]} 1... c6 {[%clk 0:03:00.0]} 2. d4 {[%clk 0:02:59.1]} 2... d5 {[%clk 0:02:58.7]} 3. e5 {[%clk 0:02:57]} 3... Bf5 {[%clk 0:02:55]} 0-1',
].join('\n');

test('countMoves counts full moves and ignores clocks, comments, variations and the result', () => {
  assert.equal(countMoves(ccPgn), 3);
  assert.equal(countMoves('[Event "x"]\n\n1. e4 e5 2. Nf3 *'), 2);                 // Black has not replied yet
  assert.equal(countMoves('1. e4 e5 (1... c5 2. Nf3) 2. Nf3 { a comment } Nc6 $1 1/2-1/2'), 2);
  assert.equal(countMoves('[Event "x"]\n\n*'), 0);
  assert.equal(countMoves(''), 0);
  assert.equal(countMoves('1. e4 1-0'), 1);
});

test('formatTimeControl turns raw controls into readable labels', () => {
  assert.equal(formatTimeControl('600'), '10 min');
  assert.equal(formatTimeControl('180+2'), '3+2');
  assert.equal(formatTimeControl('180+0'), '3 min');
  assert.equal(formatTimeControl('30'), '30 s');
  assert.equal(formatTimeControl('900+10'), '15+10');
  assert.equal(formatTimeControl('1/86400'), 'Daily');
  assert.equal(formatTimeControl('-'), '');
  assert.equal(formatTimeControl(''), '');
  assert.equal(formatTimeControl(undefined), '');
});

test('chessComOpening reads the name from ECOUrl and drops the trailing moves', () => {
  assert.deepEqual(chessComOpening(ccPgn), { eco: 'B12', name: 'Caro-Kann Defense Advance Variation' });
  const noMoves = '[ECO "C50"]\n[ECOUrl "https://www.chess.com/openings/Italian-Game"]\n\n1. e4 *';
  assert.deepEqual(chessComOpening(noMoves), { eco: 'C50', name: 'Italian Game' });
  assert.equal(chessComOpening('[ECOUrl "https://www.chess.com/openings/Queens-Pawn-Opening-Torre-Attack"]').name, "Queen's Pawn Opening Torre Attack");
  assert.equal(chessComOpening('[ECOUrl "https://www.chess.com/openings/Kings-Indian-Defense-Fianchetto-Variation-3.g3"]').name, "King's Indian Defense Fianchetto Variation");
  assert.equal(chessComOpening('[ECOUrl "https://www.chess.com/openings/Nimzo-Indian-Defense-Classical-Variation"]').name, 'Nimzo-Indian Defense Classical Variation');
  assert.deepEqual(chessComOpening('[Event "x"]\n\n1. e4 *'), { eco: '', name: '' });
});

test('entries from both sites carry moves, time control and opening', () => {
  const li = lichessGameToEntry(liGame({ id: 'abcd1234', white: 'me', black: 'foe', result: '1-0', date: '2026.10.01', time: '10:00:00', tc: '180+2', elo: 1500 }));
  assert.equal(li.moves, 2); assert.equal(li.timeControl, '3+2'); assert.equal(li.opening, 'Italian Game');
  const cc = chessComGameToEntry({ ...ccGame({ id: '1', white: 'a', whiteResult: 'timeout', black: 'b', blackResult: 'win', endTime: 1760000000 }), pgn: ccPgn, time_control: '180' });
  assert.equal(cc.moves, 3); assert.equal(cc.timeControl, '3 min'); assert.equal(cc.eco, 'B12'); assert.equal(cc.opening, 'Caro-Kann Defense Advance Variation');
});

test('describeDetails builds the two extra lines under a game', () => {
  assert.deepEqual(describeDetails({ timeClass: 'blitz', timeControl: '3+2', moves: 34, eco: 'B12', opening: 'Caro Kann Defense' }),
    { meta: 'blitz 3+2 | 34 moves', opening: 'B12 Caro Kann Defense' });
  assert.deepEqual(describeDetails({ timeClass: 'unknown', timeControl: '', moves: 1, eco: '', opening: '' }), { meta: '1 move', opening: '' });
  assert.deepEqual(describeDetails({ timeClass: 'rapid', timeControl: '10 min', moves: 0, eco: '', opening: 'Italian Game' }), { meta: 'rapid 10 min', opening: 'Italian Game' });
});

/* ---------------- paging: Load more until the games run out ---------------- */

// 75 Lichess games, one per minute, newest first; the fake server honours max= and until=.
const lichessServer = (total) => {
  const base = Date.parse('2026-10-20T12:00:00Z');
  const all = Array.from({ length: total }, (_, i) => {
    const t = new Date(base - i * 60000).toISOString();            // i = 0 is the newest
    return { id: `g${String(i).padStart(7, '0')}`, ms: base - i * 60000,
      pgn: liGame({ id: `g${String(i).padStart(7, '0')}`, white: 'Ana', black: 'Bob', result: '1-0', date: t.slice(0, 10).replace(/-/g, '.'), time: t.slice(11, 19), tc: '300+0', elo: 1700 }) };
  });
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const max = +/max=(\d+)/.exec(url)[1], until = /until=(\d+)/.exec(url);
    const pool = until ? all.filter((g) => g.ms <= +until[1]) : all;
    return new Response(pool.slice(0, max).map((g) => g.pgn).join('\n\n'), { status: 200 });
  };
  return { fetchImpl, calls, all };
};

test('Lichess pager returns every game exactly once, page after page, then reports done', async () => {
  const { fetchImpl, calls, all } = lichessServer(75);
  const pager = createRecentGamesPager('ana', 'lichess', { pageSize: 30, fetchImpl });
  const ids = [];
  let pages = 0, last;
  do { last = await pager.loadMore(); ids.push(...last.games.map((g) => g.gameId)); pages++; } while (!last.done && pages < 10);
  assert.equal(ids.length, 75);
  assert.equal(new Set(ids).size, 75, 'no duplicates across page boundaries');
  assert.deepEqual(ids, all.map((g) => g.id), 'newest first, nothing skipped');
  assert.equal(pages, 3); assert.equal(pager.done, true); assert.equal(pager.loaded, 75);
  assert.ok(!/until=/.test(calls[0]) && /until=\d+/.test(calls[1]), 'only the later pages send until=');
  assert.deepEqual(await pager.loadMore(), { games: [], done: true }, 'a finished pager makes no more requests');
  assert.equal(calls.length, 3);
});

test('Lichess pager does not skip games that share the boundary second', async () => {
  // Three games inside the same second would straddle a page of 2 — all must still arrive once.
  const mk = (id, ms) => ({ id, ms, pgn: liGame({ id, white: 'Ana', black: 'Bob', result: '1-0', date: '2026.10.20', time: '12:00:00', tc: '300+0', elo: 1700 }) });
  const all = [mk('aaaaaaa1', 3), mk('aaaaaaa2', 2), mk('aaaaaaa3', 1)].map((g, i) => ({ ...g, ms: Date.parse('2026-10-20T12:00:00Z') + (3 - i) }));
  const fetchImpl = async (url) => {
    const max = +/max=(\d+)/.exec(url)[1], until = /until=(\d+)/.exec(url);
    return new Response(all.filter((g) => !until || g.ms <= +until[1]).slice(0, max).map((g) => g.pgn).join('\n\n'));
  };
  const pager = createRecentGamesPager('ana', 'lichess', { pageSize: 2, fetchImpl });
  const got = [];
  for (let i = 0; i < 5 && !pager.done; i++) got.push(...(await pager.loadMore()).games.map((g) => g.gameId));
  assert.deepEqual([...new Set(got)].sort(), ['aaaaaaa1', 'aaaaaaa2', 'aaaaaaa3']);
  assert.equal(got.length, 3);
});

// Chess.com: 3 monthly archives holding 40 / 40 / 25 games.
const chessComServer = () => {
  const month = (m, n, end0) => ({ games: Array.from({ length: n }, (_, i) =>
    ccGame({ id: `${m}${String(i).padStart(6, '0')}`, white: 'Ana', whiteResult: 'win', black: 'Bob', blackResult: 'resign', endTime: end0 + i * 100 })) });
  const data = { '2026/08': month('08', 25, 1000000), '2026/09': month('09', 40, 2000000), '2026/10': month('10', 40, 3000000) };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/games/archives')) return jsonResponse({ archives: Object.keys(data).map((k) => `https://api.chess.com/pub/player/ana/games/${k}`) });
    const key = Object.keys(data).find((k) => url.endsWith(k));
    return key ? jsonResponse(data[key]) : new Response('nf', { status: 404 });
  };
  return { fetchImpl, calls };
};

test('Chess.com pager walks months newest first, carries a month over pages, and ends when the archives do', async () => {
  const { fetchImpl, calls } = chessComServer();
  const pager = createRecentGamesPager('Ana', 'chesscom', { pageSize: 30, fetchImpl });
  const sizes = [], ids = [];
  let r;
  do { r = await pager.loadMore(); sizes.push(r.games.length); ids.push(...r.games.map((g) => g.gameId)); } while (!r.done && sizes.length < 10);
  assert.deepEqual(sizes, [30, 30, 30, 15]);                         // 105 games, 30 at a time
  assert.equal(new Set(ids).size, 105);
  assert.ok(ids.slice(0, 40).every((id) => id.startsWith('10')) , 'October first');
  assert.ok(ids.slice(80).every((id) => id.startsWith('08')), 'August last');
  assert.equal(calls.filter((u) => /2026\/10$/.test(u)).length, 1, 'each month is fetched once');
  assert.equal(pager.done, true);
});

test('a pager failure on a later page can be retried without losing or repeating games', async () => {
  const { fetchImpl } = chessComServer();
  let failNext = false;
  const flaky = async (url) => { if (failNext && /2026\/09$/.test(url)) { failNext = false; return new Response('boom', { status: 429 }); } return fetchImpl(url); };
  const pager = createRecentGamesPager('Ana', 'chesscom', { pageSize: 30, fetchImpl: flaky });
  const first = await pager.loadMore();
  failNext = true;
  await assert.rejects(pager.loadMore(), /rate-limited/);
  const retry = await pager.loadMore();
  assert.equal(new Set([...first.games, ...retry.games].map((g) => g.gameId)).size, 60);
});

test('pager validates the username, shares in-flight calls and rejects an empty account', async () => {
  assert.throws(() => createRecentGamesPager('', 'lichess'), /Type a username/);
  assert.throws(() => createRecentGamesPager('has space', 'lichess'), /valid Lichess username/);
  const { fetchImpl, calls } = lichessServer(5);
  const pager = createRecentGamesPager('ana', 'lichess', { pageSize: 30, fetchImpl });
  const [a, b] = await Promise.all([pager.loadMore(), pager.loadMore()]);
  assert.equal(a, b); assert.equal(calls.length, 1);
  const empty = createRecentGamesPager('ana', 'lichess', { fetchImpl: async () => new Response('', { status: 200 }) });
  await assert.rejects(empty.loadMore(), /No public games/);
});
