import test from 'node:test';
import assert from 'node:assert/strict';
import { app, loadGame } from './helpers/app.mjs';
import { Chess } from '../lib/chess.js';

// Ported from upstream: after a review, one extra engine warms the extra engine-panel candidate
// lines for every position (visible one first) so navigating finds them instantly, and a warmed
// search that passes the annotation validation can also answer the Great/Brilliant pass. The job is
// interrupted by any interaction and only ever writes display lines and annotationSearch.
const exactLines = (fen, depth, count) => {
  const legal = new Chess(fen).moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion || '')).slice(0, count);
  return { bestmove: legal[0],
    lines: legal.map((move, index) => ({ multipv: index + 1, depth, bound: 'exact', pv: move + ' e7e5', score: { cp: 30 - index * 10 } })) };
};

function precalc(t, { engineLines = 3, classifyLines = 1 } = {}) {
  const a = app(t);
  loadGame(a, '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');
  a.call('computeDerived');
  a.call('buildUI');
  a.state.settings.engineLines = engineLines;
  a.state.settings.classifyLines = classifyLines;
  const engines = [], calls = [];
  a.replace('createEngine', async () => {
    const engine = {
      dead: false, current: null,
      analyse: async (fen, depth, count) => { calls.push(fen); return exactLines(fen, depth, count); },
      stop() {}, cancelPending() {}, terminate() { this.dead = true; },
    };
    engines.push(engine);
    return engine;
  });
  // The waits are the whole point in the browser; in a test they would only add wall time.
  a.replace('waitForBackgroundAnalysis', async () => true);
  // A category change re-saves the review; the library sidebar cannot be built in jsdom.
  a.replace('renderLibrary', () => {});
  const runJob = async () => { await new Promise((r) => setTimeout(r, 5)); await a.run('panelWarmJob?.promise'); };
  return { a, engines, calls, runJob };
}

test('a single line everywhere has nothing to warm', t => {
  const { a, calls } = precalc(t, { engineLines: 1, classifyLines: 1 });
  a.call('schedulePanelPrecalculation');
  assert.equal(a.run('panelWarmJob'), null, 'no job is scheduled');
  assert.equal(calls.length, 0);
});

test('the warm job caches the panel lines for every position and feeds the annotation evidence', async t => {
  const { a, calls, runJob } = precalc(t);
  const S = a.state;
  const scoringBefore = JSON.stringify(S.bests.map((b) => ({ score: b.score, bestmove: b.bestmove, lines: b.lines })));
  const evalsBefore = JSON.stringify(S.evals);
  a.call('schedulePanelPrecalculation');
  await runJob();
  assert.equal(calls.length, S.total + 1, 'every position was warmed once');
  assert.equal(calls[0], S.positions[0].fen, 'the position in view was warmed first');
  for (let i = 0; i <= S.total; i++) {
    const cached = a.run(`panelCachedLines(${i}, 3)`);
    assert.equal(cached?.length, 3, `position ${i} found its candidate lines ready`);
    // The final position decides no move, so it never carries an annotation search.
    if (i === S.total) continue;
    const search = S.bests[i].annotationSearch;
    assert.ok(search, `position ${i} stored annotation evidence`);
    assert.equal(search.count, 3);
    assert.equal(search.key, a.call('engineContextKey', S.positions[i].fen, a.call('searchHistory', S.positions, i)));
    assert.ok(a.call('annotationRoot', i).lines.length >= 2, 'the stored search is what the classifier reads');
  }
  assert.equal(JSON.stringify(S.bests.map((b) => ({ score: b.score, bestmove: b.bestmove, lines: b.lines }))), scoringBefore,
    'the scored best/played pair is untouched — warm lines are display/annotation evidence only');
  assert.equal(JSON.stringify(S.evals), evalsBefore);
});

test('the panel shows a warmed position instantly, with no live search', async t => {
  const { a, runJob } = precalc(t);
  a.call('schedulePanelPrecalculation');
  await runJob();
  a.state.idx = 2;
  a.state._panelCache = null;
  a.replace('ensureLiveEngine', async () => { throw Error('the live engine must not be needed'); });
  await a.call('requestPanelLines');
  assert.equal(a.state._panelCache?.idx, 2, 'the cache answered the request');
  assert.equal(a.state._panelCache.lines.length, 3);
});

test('an interrupted search is thrown away and retried, never cached', async t => {
  const a = app(t);
  loadGame(a, '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');
  a.call('computeDerived');
  a.call('buildUI');
  a.state.settings.engineLines = 3; a.state.settings.classifyLines = 1;
  const calls = [];
  let release = null, held = false;
  a.replace('createEngine', async () => ({
    dead: false, current: null,
    analyse: async (fen, depth, count) => {
      calls.push(fen);
      if (!held) { held = true; await new Promise((resolve) => { release = resolve; }); }
      return exactLines(fen, depth, count);
    },
    stop() {}, cancelPending() {}, terminate() { this.dead = true; },
  }));
  a.replace('waitForBackgroundAnalysis', async () => true);
  a.replace('renderLibrary', () => {});
  a.call('schedulePanelPrecalculation');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 1, 'the first search is running');
  a.call('pauseBackgroundAnalysis');
  assert.equal(a.call('backgroundAnalysisBusy'), true, 'a fresh interaction marks the background as busy');
  release();
  await a.run('panelWarmJob.promise');
  assert.equal(calls.filter((f) => f === a.state.positions[0].fen).length, 2, 'the interrupted position was searched again');
  assert.equal(calls.length, a.state.total + 2, 'the rest warmed once, the interrupted one twice');
  assert.equal(a.call('panelCachedLines', 0, 3)?.length, 3, 'only the retry left a complete entry');
});

test('the background stays busy for half a second after an interaction', t => {
  const { a } = precalc(t);
  a.run('backgroundInteractionAt = 0');
  assert.equal(a.call('backgroundAnalysisBusy'), false);
  a.call('pauseBackgroundAnalysis');
  assert.equal(a.call('backgroundAnalysisBusy'), true);
  a.run('backgroundInteractionAt = Date.now() - 1000');
  assert.equal(a.call('backgroundAnalysisBusy'), false);
});

test('stopping the job terminates its engine and drops the schedule', async t => {
  const { a, engines, runJob } = precalc(t);
  a.call('schedulePanelPrecalculation');
  await runJob();
  assert.ok(engines.length >= 1, 'the job created its own engine');
  a.call('schedulePanelPrecalculation');   // same context: the existing job is kept
  const job = a.run('panelWarmJob');
  a.call('stopPanelPrecalculation');
  assert.equal(a.run('panelWarmJob'), null);
  assert.equal(job.cancelled, true);
  assert.equal(engines[0].dead, true, 'the warm engine was terminated');
});
