import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Chess} from '../lib/chess.js';
import {analyseCalibratedPosition} from '../lib/calibrated-search.js';
import {calibratedReview, scoringEvidenceComplete} from '../lib/calibrated-review.js';
import {SF19_BUILDS, SF19_NODES, isSf19Build} from '../lib/scoring-builds.js';

const calibration = JSON.parse(await readFile(new URL('../data/calibration.json', import.meta.url)));
const START = new Chess().fen();
const wdl = cp => { const win = Math.max(0, Math.min(1000, 500 + cp)), loss = Math.max(0, Math.min(1000 - win, 400 - cp)); return [win, 1000 - win - loss, loss]; };

test('every Stockfish 19 build is one scoring family; Stockfish 18 is not', () => {
  assert.deepEqual([...SF19_BUILDS].sort(), ['native19', 'sf19full', 'sf19lite']);
  for (const build of SF19_BUILDS) assert.equal(isSf19Build(build), true);
  for (const build of ['nnue', 'wasm', undefined, null]) assert.equal(isSf19Build(build), false);
});

function recordingEngine(build, identity) {
  const calls = [], options = [];
  return {calls, options, engine: {buildKey: build, identity,
    async setOptions(o) { options.push(o); },
    async analyse(fen, depth, lines, history, progress, config) {
      calls.push({depth, lines, config});
      const move = config.searchMove || 'e2e4', cp = config.searchMove === 'a2a3' ? -20 : 35;
      return {bestmove: move, score: {cp, wdl: wdl(cp)}, pv: move, lines: []};
    }}};
}

for (const build of SF19_BUILDS) {
  test(`${build} runs the fixed 20,000-node exact protocol and records the SF19 evidence`, async () => {
    const {engine, calls, options} = recordingEngine(build, 'Stockfish 19');
    const root = await analyseCalibratedPosition(engine, {fen: START, history: {initialFen: START, moves: []}, played: 'a2a3',
      calibration, settings: {enginePath: build, engineDepth: 16, engineHash: 16, engineSkill: 12, classifyLines: 3}});
    assert.deepEqual(calls[0].config.budget, {kind: 'nodes', value: SF19_NODES});
    assert.equal(calls[0].config.cold, true); assert.equal(calls[0].config.requireExact, true);
    assert.equal(calls[1].config.searchMove, 'a2a3');
    assert.equal(options[0].Hash, 32); assert.equal(options[0]['Skill Level'], 20); assert.equal(options[0].UCI_ShowWDL, true);
    assert.equal(root.calibration.build, build); assert.equal(root.calibration.nodes, SF19_NODES);
    assert.equal(root.calibration.contextVersion, calibration.context.sf19.candidateVersion);
    assert.equal(root.ratingEvidence.candidateVersion, calibration.movesOnly.sf19.candidateVersion);
    assert.deepEqual(root.ratingEvidence.played.wdl, wdl(-20));
  });
}

test('a native or WASM engine that is not Stockfish 19 is refused for SF19 scoring', async () => {
  for (const build of SF19_BUILDS) {
    const {engine} = recordingEngine(build, 'Stockfish 18');
    await assert.rejects(analyseCalibratedPosition(engine, {fen: START, history: null, played: 'e2e4', calibration,
      settings: {enginePath: build, engineDepth: 16}}), /identity/);
  }
});

function game(build) {
  const positions = [{fen: START}], bests = [];
  const chess = new Chess(), line = 'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7 f1e1 b7b5 a4b3 d7d6 c2c3 e8g8 h2h3 c6a5 b3c2 c7c5 d2d4 d8c7 b1d2 a5c6'.split(' ');
  for (const [index, move] of line.entries()) {
    const root = chess.fen();
    const done = chess.move({from: move.slice(0, 2), to: move.slice(2, 4)});
    positions.push({fen: chess.fen(), color: done.color, from: done.from, to: done.to});
    const top = index % 3 !== 2;
    const bestCp = 30, playedCp = top ? 30 : -60;
    bests.push({bestmove: top ? move : 'g8f6', score: {cp: bestCp, wdl: wdl(bestCp)}, playedScore: top ? undefined : {cp: playedCp, wdl: wdl(playedCp)},
      calibration: {version: calibration.version, build, nodes: SF19_NODES, contextVersion: calibration.context.sf19.candidateVersion, qualityVersion: null},
      ratingEvidence: {candidateVersion: calibration.movesOnly.sf19.candidateVersion, best: {cp: bestCp, wdl: wdl(bestCp)}, played: {cp: top ? bestCp : playedCp, wdl: wdl(top ? bestCp : playedCp)}, bestmove: top ? move : 'g8f6'}});
  }
  return {positions, bests};
}

test('SF19 Full and Native produce exactly the accuracy and rating Lite produces for the same observations', () => {
  const players = {w: {rating: 1500}, b: {rating: 1500}};
  const reference = calibratedReview(game('sf19lite').positions, game('sf19lite').bests, calibration, players, 'context');
  assert.ok(reference.w.accuracy != null && reference.b.accuracy != null);
  for (const build of ['sf19full', 'native19']) {
    const {positions, bests} = game(build);
    const review = calibratedReview(positions, bests, calibration, players, 'context');
    assert.equal(review.w.accuracy, reference.w.accuracy); assert.equal(review.b.accuracy, reference.b.accuracy);
    assert.equal(review.w.rating, reference.w.rating); assert.equal(review.b.rating, reference.b.rating);
    assert.equal(review.w.ratingMethod, reference.w.ratingMethod);
    const moves = calibratedReview(positions, bests, calibration, {}, 'moves');
    assert.equal(moves.b.ratingMethod, 'moves'); assert.ok(moves.b.rating > 0);
  }
});

test('stored evidence is accepted for every SF19 build, but never mixed across builds or at another node budget', () => {
  for (const build of SF19_BUILDS) {
    const {positions, bests} = game(build);
    bests.forEach(root => { root.score = {cp: 30}; root.playedScore = {cp: 30}; });
    assert.equal(scoringEvidenceComplete(bests, positions.length - 1, calibration), true, build);
  }
  const {positions, bests} = game('sf19full');
  bests.forEach(root => { root.score = {cp: 30}; root.playedScore = {cp: 30}; });
  bests[2].calibration = {...bests[2].calibration, build: 'native19'};
  assert.equal(scoringEvidenceComplete(bests, positions.length - 1, calibration), false);
  bests[2].calibration = {...bests[2].calibration, build: 'sf19full', nodes: 10000};
  assert.equal(scoringEvidenceComplete(bests, positions.length - 1, calibration), false);
});
