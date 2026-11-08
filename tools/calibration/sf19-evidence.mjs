// The SF19 rating evidence writer and its frozen cohort contract.
//
// data/calibration.json's two SF19 models (context.sf19 and movesOnly.sf19) are fitted from
// public/sf19-rating-evidence.json.gz. That file is produced from a search cache created by
// tools/calibration-experiments/analyze-games.mjs running the pinned SF19 Lite WASM at one fixed
// budget (cold, single-thread, Hash 32), so a protocol change is always an evidence regeneration
// plus a refit - never a coefficient tweak. This module turns such a cache into the published
// format and verifies it against tools/calibration/sf19-cohort.json, which pins exactly which 750
// training games and which player sides the models were fitted on.
//
// Field semantics (verified against the published file; the runtime mirrors them in
// lib/public-scoring.js):
//   expected points = engine WDL (wins + draws/2) / 1000, mate = 1/0        [engineExpectedPoints]
//   top             = the played move was the engine's best                  bestmove === played
//   eligible        = the position had more than one legal move              legalChoices > 1
//   residual        = bestExpected - playedExpected                          (may be negative)
//   loss            = top or forced ? 0 : max(0, residual)
//   quality         = 100 * (1 - loss)
// A player side is included only with at least 10 nonforced decisions (the moves-only minimum).
// Two black sides of the cohort fall below that and are excluded, which is why the evidence holds
// 52,239 of the cohort's 52,259 plies; sf19-cohort.json records them under droppedSides.
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { hash, save } from './io.mjs';
import { engineExpectedPoints } from '../../lib/public-scoring.js';
import { Chess } from '../../lib/chess.js';

export const SF19_EVIDENCE_SCHEMA = 'public-rating-evidence-v1';
export const SF19_COHORT_SCHEMA = 'sf19-rating-cohort-v1';
export const SF19_MIN_DECISIONS = 10;

/** Every ply of a game with the mover, the legal-choice count and the history before it. */
export function gamePlies(moves) {
  const chess = new Chess();
  const plies = [];
  for (let index = 0; index < moves.length; index++) {
    const played = moves[index];
    plies.push({ ply: index + 1, color: chess.turn(), played, legalChoices: chess.moves().length, history: moves.slice(0, index) });
    chess.move({ from: played.slice(0, 2), to: played.slice(2, 4), promotion: played[4] });
  }
  return plies;
}

/** Index search-cache rows ({ history, played, bestmove, score }) for (history, played) lookups. */
export function indexCache(rows) {
  const index = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.history || [], row.played || null]);
    if (index.has(key)) throw Error('Duplicate search cache entry');
    index.set(key, row);
  }
  return { size: index.size, get(history, played = null) { return index.get(JSON.stringify([history, played])) || null; } };
}

/** Build the published evidence object from the dataset games, the frozen cohort and a cache index. */
export function buildSf19Evidence({ games, cohort, cache, config }) {
  if (cohort?.schema !== SF19_COHORT_SCHEMA) throw Error('Cohort contract missing');
  const byId = new Map(games.map((game) => [game.id, game]));
  const rows = [];
  for (const side of cohort.sides) {
    const game = byId.get(side.gameId);
    if (!game) throw Error('Cohort game missing from the dataset: ' + side.gameId);
    const player = game.players.find((entry) => entry.color === side.color);
    if (!player) throw Error('Cohort side missing from the dataset: ' + side.gameId + ' ' + side.color);
    const contextMoves = [];
    let eligible = 0;
    for (const ply of gamePlies(game.moves)) {
      if (ply.color !== side.color) continue;
      const best = cache.get(ply.history);
      const actual = best && best.bestmove === ply.played ? best : cache.get(ply.history, ply.played);
      if (!best || !actual) throw Error(`Search cache is missing ${side.gameId} ${side.color} ply ${ply.ply}`);
      const top = best.bestmove === ply.played;
      const bestExpected = engineExpectedPoints(best.score);
      const playedExpected = engineExpectedPoints(actual.score);
      const forced = ply.legalChoices === 1;
      const loss = top || forced ? 0 : Math.max(0, bestExpected - playedExpected);
      if (!forced) eligible++;
      contextMoves.push({ ply: ply.ply, color: side.color, top, legalChoices: ply.legalChoices,
        bestExpected, playedExpected, bestMate: best.score.mate ?? null, playedMate: actual.score.mate ?? null,
        loss, quality: 100 * (1 - loss), residual: bestExpected - playedExpected, eligible: !forced });
    }
    if (contextMoves.length !== side.count || contextMoves[0]?.ply !== side.first) {
      throw Error(`Cohort ply set differs for ${side.gameId} ${side.color}: expected ${side.count} plies from ${side.first}`);
    }
    if (eligible < SF19_MIN_DECISIONS) {
      throw Error(`A cohort side has fewer than ${SF19_MIN_DECISIONS} nonforced decisions: ${side.gameId} ${side.color}`);
    }
    rows.push({ gameId: side.gameId, playerId: player.id, color: side.color, split: game.split,
      ratingTarget: player.rating, band: game.band, contextMoves });
  }
  return { schema: SF19_EVIDENCE_SCHEMA, engineConfig: config, rows };
}

function checkContextMove(row, move, gameId) {
  const fail = (why) => { throw Error(`Invalid contextMove (${gameId} ${row.color} ply ${move.ply}): ${why}`); };
  if (!Number.isInteger(move.ply) || move.ply < 1) fail('ply');
  if (!Number.isInteger(move.legalChoices) || move.legalChoices < 1) fail('legalChoices');
  if (typeof move.top !== 'boolean') fail('top');
  if (move.eligible !== (move.legalChoices > 1)) fail('eligible');
  for (const name of ['bestExpected', 'playedExpected', 'loss', 'quality', 'residual']) {
    if (!Number.isFinite(move[name])) fail(name);
  }
  if (move.bestExpected < 0 || move.bestExpected > 1 || move.playedExpected < 0 || move.playedExpected > 1) fail('expected range');
  for (const name of ['bestMate', 'playedMate']) {
    if (move[name] != null && (!Number.isInteger(move[name]) || move[name] === 0)) fail(name);
  }
  const residual = move.bestExpected - move.playedExpected;
  const loss = move.top || !move.eligible ? 0 : Math.max(0, residual);
  if (Math.abs(move.residual - residual) > 1e-9) fail('residual');
  if (Math.abs(move.loss - loss) > 1e-9) fail('loss');
  if (Math.abs(move.quality - 100 * (1 - loss)) > 1e-9) fail('quality');
}

/** Verify evidence against the cohort contract (and optionally the dataset's ratings/bands/splits). */
export function verifySf19Evidence(evidence, cohort, { games = null } = {}) {
  if (evidence?.schema !== SF19_EVIDENCE_SCHEMA) throw Error('Unexpected evidence schema');
  if (cohort?.schema !== SF19_COHORT_SCHEMA) throw Error('Cohort contract missing');
  if (!evidence.engineConfig || !evidence.engineConfig.budget) throw Error('Evidence engine configuration missing');
  const byId = games ? new Map(games.map((game) => [game.id, game])) : null;
  const expected = new Map(cohort.sides.map((side) => [side.gameId + '|' + side.color, side]));
  let plies = 0, eligible = 0, decisionsOk = 0;
  for (const row of evidence.rows) {
    const key = row.gameId + '|' + row.color;
    const side = expected.get(key);
    if (!side) throw Error('Evidence row outside the cohort: ' + key);
    expected.delete(key);
    if (row.contextMoves.length !== side.count) throw Error(`Ply count differs for ${key}`);
    const game = byId?.get(row.gameId);
    if (game) {
      const player = game.players.find((entry) => entry.color === row.color);
      if (!player || row.playerId !== player.id || row.ratingTarget !== player.rating) throw Error('Rating evidence differs for ' + key);
      if (row.split !== game.split || row.band !== game.band) throw Error('Split/band evidence differs for ' + key);
    }
    const seen = [];
    let sideEligible = 0;
    for (const move of row.contextMoves) {
      if (move.color !== row.color) throw Error('Context move color differs for ' + key);
      checkContextMove(row, move, row.gameId);
      if (move.eligible) { sideEligible++; eligible++; }
      seen.push(move.ply);
    }
    for (let index = 0; index < seen.length; index++) {
      if (seen[index] !== side.first + index * 2) throw Error('Ply set differs for ' + key);
    }
    if (sideEligible < SF19_MIN_DECISIONS) throw Error('A cohort side has fewer than 10 nonforced decisions: ' + key);
    plies += seen.length;
    decisionsOk++;
  }
  if (expected.size) throw Error('Evidence is missing cohort sides: ' + [...expected.keys()].slice(0, 3).join(', '));
  if (decisionsOk !== cohort.sideCount || plies !== cohort.plies) throw Error('Evidence totals differ from the cohort contract');
  return { games: cohort.gameCount, sides: evidence.rows.length, plies, eligible };
}

/** The frozen cohort contract derived from an evidence file (used once to create sf19-cohort.json). */
export function cohortFromEvidence(evidence, { droppedSides = [], definition = '' } = {}) {
  const sides = evidence.rows.map((row) => {
    const plies = row.contextMoves.map((move) => move.ply);
    if (!plies.length) throw Error('Empty evidence row: ' + row.gameId);
    for (let index = 0; index < plies.length; index++) {
      if (plies[index] !== plies[0] + index * 2) throw Error('Non-contiguous side plies: ' + row.gameId);
    }
    return { gameId: row.gameId, color: row.color, first: plies[0], count: plies.length };
  });
  const plies = sides.reduce((sum, side) => sum + side.count, 0);
  const cohort = { schema: SF19_COHORT_SCHEMA, definition, cohortHash: hash(JSON.stringify(sides.map((side) => [side.gameId, side.color, side.first, side.count]))),
    gameCount: new Set(sides.map((side) => side.gameId)).size, sideCount: sides.length, plies,
    sides, droppedSides };
  return cohort;
}

/** Sides the cohort excludes because they have fewer than ten nonforced decisions. */
export function droppedSidesFor(games, cohort) {
  const included = new Set(cohort.sides.map((side) => side.gameId + '|' + side.color));
  const dropped = [];
  for (const game of games) {
    if (!cohort.sides.some((side) => side.gameId === game.id)) continue;
    for (const color of ['w', 'b']) {
      if (included.has(game.id + '|' + color)) continue;
      const eligible = gamePlies(game.moves).filter((ply) => ply.color === color && ply.legalChoices > 1).length;
      dropped.push({ gameId: game.id, color, eligible });
    }
  }
  return dropped;
}

async function readJsonGz(file) { return JSON.parse(gunzipSync(await readFile(file))); }

async function main() {
  const root = new URL('./', import.meta.url);
  const evidenceFile = new URL('public/sf19-rating-evidence.json.gz', root);
  const cohortFile = new URL('sf19-cohort.json', root);
  const datasetFile = new URL('public/dataset.json.gz', root);
  const command = process.argv[2];
  if (command === 'freeze-cohort') {
    const evidence = await readJsonGz(evidenceFile);
    const games = await readJsonGz(datasetFile);
    const base = cohortFromEvidence(evidence);
    const cohort = cohortFromEvidence(evidence, {
      droppedSides: droppedSidesFor(games, base),
      definition: '750 training games of public/dataset.json.gz; both player sides except sides with fewer than ten nonforced decisions; every ply of an included side is one contextMove.',
    });
    await save(fileURLToPath(cohortFile), cohort);
    console.log(`cohort frozen: ${cohort.gameCount} games, ${cohort.sideCount} sides, ${cohort.plies} plies, hash ${cohort.cohortHash}`);
    console.log('dropped sides:', JSON.stringify(cohort.droppedSides));
    return;
  }
  if (command === 'verify') {
    const cohort = JSON.parse(await readFile(cohortFile, 'utf8'));
    const evidence = await readJsonGz(evidenceFile);
    const games = await readJsonGz(datasetFile);
    const summary = verifySf19Evidence(evidence, cohort, { games });
    console.log('published evidence verifies:', JSON.stringify(summary));
    return;
  }
  console.log('usage: node tools/calibration/sf19-evidence.mjs freeze-cohort | verify');
  process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
