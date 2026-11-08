import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { Chess } from '../lib/chess.js';
import {
  SF19_COHORT_SCHEMA, SF19_EVIDENCE_SCHEMA, SF19_MIN_DECISIONS,
  gamePlies, indexCache, buildSf19Evidence, verifySf19Evidence, cohortFromEvidence, droppedSidesFor,
} from '../tools/calibration/sf19-evidence.mjs';

// The SF19 rating models are fitted from the published evidence file; the writer turns a fresh
// search cache into that format and the verifier pins it against tools/calibration/sf19-cohort.json.

const MAIN_LINE = 'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7 f1e1 b7b5 a4b3 d7d6 c2c3 e8g8 h2h3 c6a5 b3c2 c7c5 d2d4'.split(' ');

function legalMoves(history) {
  const chess = new Chess();
  for (const move of history) chess.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });
  return chess.moves({ verbose: true }).map((move) => move.from + move.to + (move.promotion || ''));
}

// A deterministic cache over a move list: every root gets a best row; non-top plies get a restricted
// row with a worse expected score. `topAt` lists the histories (indexes) that stay engine-top.
function syntheticCache(moves, { topIndexes = [], mateAt = -1 } = {}) {
  const rows = [];
  const wdl = (index, worse) => {
    const win = worse ? 300 : 500 + (index % 5) * 4;
    const loss = worse ? 300 : 300 - (index % 5) * 4;
    return [win, 1000 - win - loss, loss];
  };
  for (let index = 0; index < moves.length; index++) {
    const history = moves.slice(0, index), played = moves[index];
    const legal = legalMoves(history);
    const top = topIndexes.includes(index);
    const bestmove = top ? played : legal.find((move) => move !== played);
    const best = { history, played: null, bestmove, score: index === mateAt ? { mate: 3 } : { cp: 20, wdl: wdl(index, false) } };
    rows.push(best);
    if (!top) rows.push({ history, played, bestmove: played, score: { cp: 10, wdl: wdl(index, true) } });
  }
  return { rows, cache: indexCache(rows) };
}

function sideOf(gameId, color, plies) {
  const first = color === 'w' ? 1 : 2;
  const count = plies.filter((ply) => ply.color === color).length;
  return { gameId, color, first, count };
}

function cohortFor(games) {
  const sides = [];
  for (const game of games) {
    const plies = gamePlies(game.moves);
    for (const color of ['w', 'b']) {
      const own = plies.filter((ply) => ply.color === color);
      if (own.filter((ply) => ply.legalChoices > 1).length >= SF19_MIN_DECISIONS) sides.push(sideOf(game.id, color, plies));
    }
  }
  return { schema: SF19_COHORT_SCHEMA, definition: 'fixture', cohortHash: '', gameCount: games.length,
    sideCount: sides.length, plies: sides.reduce((sum, side) => sum + side.count, 0), sides, droppedSides: [] };
}

const GAMES = [
  { id: 'g1', split: 'train', band: 2, players: [{ id: 'p1', color: 'w', rating: 1500 }, { id: 'p2', color: 'b', rating: 1480 }], moves: MAIN_LINE },
  { id: 'g2', split: 'train', band: 3, players: [{ id: 'p3', color: 'w', rating: 1700 }, { id: 'p4', color: 'b', rating: 1650 }], moves: MAIN_LINE.slice(0, 3) },
];
const CONFIG = { version: 'Stockfish 19 (identity verified at UCI startup)', majorVersion: 19, build: 'stockfish.js lite single-threaded',
  budget: { kind: 'depth', value: 22 }, options: { Threads: 1, Hash: 32, MultiPV: 1, 'Skill Level': 20, UCI_ShowWDL: true } };

test('the writer derives the published fields from a cache: top, loss, quality, mate and eligible', () => {
  // White's 1st move (index 0) and 3rd move (index 4, mate) are engine-top; the 2nd (index 2) is not.
  const { cache } = syntheticCache(MAIN_LINE, { topIndexes: [0, 4], mateAt: 4 });
  const cohort = cohortFor(GAMES);
  assert.equal(cohort.sides.length, 2, 'g2 is too short (fewer than ten decisions), g1 keeps both sides');
  const evidence = buildSf19Evidence({ games: GAMES, cohort, cache, config: CONFIG });
  assert.equal(evidence.schema, SF19_EVIDENCE_SCHEMA);
  assert.equal(evidence.engineConfig.budget.kind, 'depth');
  assert.equal(evidence.rows.length, 2);
  const white = evidence.rows.find((row) => row.color === 'w');
  assert.equal(white.playerId, 'p1');
  assert.equal(white.ratingTarget, 1500);
  assert.equal(white.band, 2);
  assert.equal(white.split, 'train');
  const [first, second, third] = white.contextMoves;
  assert.equal(first.top, true);
  assert.equal(first.loss, 0);
  assert.equal(first.quality, 100);
  assert.equal(second.ply, 3);
  assert.equal(second.top, false);
  assert.ok(second.loss > 0, 'a non-top move must carry a loss');
  assert.equal(second.quality, 100 * (1 - second.loss));
  assert.ok(Math.abs(second.residual - (second.bestExpected - second.playedExpected)) < 1e-12);
  assert.equal(third.ply, 5);
  assert.equal(third.bestExpected, 1, 'a mate score is expected points 1');
  assert.equal(third.bestMate, 3);
  assert.equal(third.playedMate, 3);
  assert.ok(white.contextMoves.every((move) => move.eligible === move.legalChoices > 1));
  assert.deepEqual(verifySf19Evidence(evidence, cohort, { games: GAMES }), { games: 2, sides: 2, plies: 21, eligible: 21 });
});

test('the builder refuses a missing search and a side below the decision minimum', () => {
  const cohort = cohortFor(GAMES);
  const { rows, cache } = syntheticCache(MAIN_LINE);
  // Remove one restricted row: the affected side cannot be built.
  const partial = indexCache(rows.filter((row) => !(row.played && row.history.length === 1)));
  assert.throws(() => buildSf19Evidence({ games: GAMES, cohort, cache: partial, config: CONFIG }), /missing/);
  // A cohort side that cannot reach ten decisions is refused outright.
  const bad = { ...cohort, sides: [...cohort.sides, { gameId: 'g2', color: 'b', first: 2, count: 1 }] };
  assert.throws(() => buildSf19Evidence({ games: GAMES, cohort: bad, cache, config: CONFIG }), /fewer than 10 nonforced decisions/);
});

test('the verifier catches cohort, ply and field drift', () => {
  const cohort = cohortFor(GAMES);
  const { cache } = syntheticCache(MAIN_LINE);
  const evidence = buildSf19Evidence({ games: GAMES, cohort, cache, config: CONFIG });
  verifySf19Evidence(evidence, cohort, { games: GAMES });
  const clone = () => JSON.parse(JSON.stringify(evidence));
  assert.throws(() => { const bad = clone(); bad.rows.pop(); verifySf19Evidence(bad, cohort); }, /missing cohort sides/);
  assert.throws(() => { const bad = clone(); bad.rows[0].contextMoves[2].ply += 2; verifySf19Evidence(bad, cohort); }, /Ply set differs/);
  assert.throws(() => { const bad = clone(); bad.rows[0].contextMoves[0].loss = 0.5; verifySf19Evidence(bad, cohort); }, /loss/);
  assert.throws(() => { const bad = clone(); bad.rows[0].ratingTarget = 1; verifySf19Evidence(bad, cohort, { games: GAMES }); }, /Rating evidence differs/);
  assert.throws(() => { const bad = clone(); bad.rows[0].contextMoves[0].eligible = false; verifySf19Evidence(bad, cohort); }, /eligible/);
});

test('the published evidence verifies against the frozen cohort contract', async () => {
  const evidence = JSON.parse(gunzipSync(await readFile(new URL('../tools/calibration/public/sf19-rating-evidence.json.gz', import.meta.url))));
  const cohort = JSON.parse(await readFile(new URL('../tools/calibration/sf19-cohort.json', import.meta.url), 'utf8'));
  assert.equal(cohort.schema, SF19_COHORT_SCHEMA);
  assert.deepEqual(verifySf19Evidence(evidence, cohort), { games: 750, sides: 1498, plies: 52239, eligible: 51765 });
  assert.equal(cohort.cohortHash, '724d9148e2b2358015670b27ca8cf4bcea6dad3888638f0a1e0474badd4190e4',
    'the cohort hash pins exactly which games, sides and plies the models were fitted on');
  const derived = cohortFromEvidence(evidence, { droppedSides: cohort.droppedSides });
  assert.equal(derived.cohortHash, cohort.cohortHash, 'the published file still matches the contract');
  assert.equal(derived.sideCount, cohort.sideCount);
  assert.equal(derived.plies, cohort.plies);
});

test('the twenty-ply gap is the documented decision minimum, not a lost ply', async () => {
  const evidence = JSON.parse(gunzipSync(await readFile(new URL('../tools/calibration/public/sf19-rating-evidence.json.gz', import.meta.url))));
  const cohort = JSON.parse(await readFile(new URL('../tools/calibration/sf19-cohort.json', import.meta.url), 'utf8'));
  const games = JSON.parse(gunzipSync(await readFile(new URL('../tools/calibration/public/dataset.json.gz', import.meta.url))));
  const cohortGames = new Set(cohort.sides.map((side) => side.gameId));
  const totalPlies = games.filter((game) => cohortGames.has(game.id)).reduce((sum, game) => sum + game.moves.length, 0);
  assert.equal(totalPlies, 52259);
  assert.equal(cohort.plies, 52239, 'the twenty missing plies');
  const dropped = droppedSidesFor(games, cohort);
  assert.deepEqual(dropped, cohort.droppedSides, 'the dropped sides are exactly the sub-minimum ones recorded in the contract');
  assert.deepEqual(dropped.map((side) => [side.gameId, side.color, side.eligible]),
    [['HsowT6Qd', 'b', 9], ['4eLPtn5c', 'b', 8]]);
  for (const side of dropped) assert.ok(side.eligible < SF19_MIN_DECISIONS);
  // Every game contributes its white side; two black sides are dropped, so 748 games keep both.
  assert.equal(new Set(cohort.sides.map((side) => side.gameId)).size, 750);
  assert.equal(new Set(cohort.sides.filter((side) => side.color === 'w').map((side) => side.gameId)).size, 750);
  assert.equal(new Set(cohort.sides.filter((side) => side.color === 'b').map((side) => side.gameId)).size, 748);
  assert.equal(evidence.rows.length, cohort.sideCount, 'no evidence row belongs to a dropped side');
});

test('the driver exposes the same frozen cohort, engine and depth to the run', async () => {
  const run = await import('../tools/calibration/sf19-run.mjs');
  assert.equal(run.DEPTH, 22);
  assert.equal(run.ENGINE, 'engine/stockfish-19-lite-single.js');
  assert.equal(run.WORKERS, 4);
  assert.match(run.RUN_DIR.replace(/\\/g, '/'), /calibration-runs\/sf19-d22$/);
  assert.equal(run.REFERENCE_BEST_SEARCHES, 48535);
  assert.equal(run.REFERENCE_RESTRICTED_SEARCHES, 30407);
  assert.equal(run.REFERENCE_SEARCHES, 78942, 'distinct-position reference for the cohort');
});
