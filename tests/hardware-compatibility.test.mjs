import test from 'node:test';
import assert from 'node:assert/strict';
import { engineCapabilityError, Engine } from '../engine/uci.js';
import { app, loadGame, fakeEngine } from './helpers/app.mjs';

// Port of upstream a2c0a762 + 19d18da2: worker defaults keep the original CPU-based
// parallelism, explicit choices are respected, a partial startup failure finishes the
// review with the surviving pool, and unsupported WebAssembly/SIMD fails with a clear
// message before any worker starts.

const profiles = [
  ['single-core PC', { hardwareConcurrency: 1, deviceMemory: 2 }, 1],
  ['dual-core PC', { hardwareConcurrency: 2, deviceMemory: 4 }, 1],
  ['many cores with 2 GB RAM', { hardwareConcurrency: 16, deviceMemory: 2 }, 4],
  ['4 GB laptop', { hardwareConcurrency: 8, deviceMemory: 4 }, 4],
  ['8 GB desktop', { hardwareConcurrency: 8, deviceMemory: 8 }, 4],
  ['Firefox without a memory hint', { hardwareConcurrency: 16 }, 4],
  ['privacy settings hide hardware hints', {}, 3],
  ['invalid hardware hints', { hardwareConcurrency: NaN, deviceMemory: Infinity }, 3],
];

for (const [label, hardware, expected] of profiles) {
  test(`${label} retains the original default parallelism and search settings`, async (t) => {
    const a = app(t, { hardware }), S = loadGame(a, '1. e4 e5 2. Nf3 Nc6');
    for (const name of ['paintBoard', 'renderEvalBar', 'renderMoves', 'renderControls', 'renderReview', 'renderStats', 'renderEngineCurrent', 'renderBestArrow', 'renderGraph']) a.replace(name, () => {});
    assert.equal(S.settings.engineWorkers, expected); S.settings.engineHash = 16;
    const settings = structuredClone(S.settings); let started = 0, saved = 0;
    a.replace('createEngine', async () => { started++; return fakeEngine(); });
    a.replace('saveToLibrary', () => saved++);
    await a.call('startAnalysis');
    assert.equal(started, expected); assert.equal(saved, 1); assert.equal(S.analysisError, null);
    assert.ok(S.evals.every(Boolean)); assert.deepEqual(structuredClone(S.settings), settings);
  });

  test(`${label} honors manual worker choices even with a large hash`, async (t) => {
    const a = app(t, { hardware }), S = loadGame(a, '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6');
    for (const name of ['paintBoard', 'renderEvalBar', 'renderMoves', 'renderControls', 'renderReview', 'renderStats', 'renderEngineCurrent', 'renderBestArrow', 'renderGraph']) a.replace(name, () => {});
    S.settings.engineHash = 256; let started = 0, saved = 0;
    a.replace('createEngine', async (opts) => { assert.equal(opts.Hash, 256); started++; return fakeEngine(); });
    a.replace('saveToLibrary', () => saved++);
    for (const requested of [1, 2, 4, 8]) {
      started = 0; S.settings.engineWorkers = requested;
      await a.call('startAnalysis');
      assert.equal(started, requested); assert.equal(S.analysisError, null); assert.ok(S.evals.every(Boolean));
      assert.equal(S.settings.engineWorkers, requested); assert.equal(S.settings.engineHash, 256);
    }
    assert.equal(saved, 4);
  });
}

test('worker preferences are bounded only by the supported range and positions', (t) => {
  const a = app(t);
  assert.equal(a.call('engineWorkerCount', 999, 100, { hardwareConcurrency: 64 }), 8);
  assert.equal(a.call('engineWorkerCount', 4, 1, { hardwareConcurrency: 16, deviceMemory: 8 }), 1);
  assert.equal(a.call('engineWorkerCount', NaN, 100, {}), 3);
});

test('a pool with different startup fallbacks uses one scoring engine throughout', async (t) => {
  const a = app(t), S = loadGame(a, '1. e4'); S.settings.engineWorkers = 2;
  Object.defineProperty(a.context.navigator, 'hardwareConcurrency', { value: 4, configurable: true });
  for (const name of ['paintBoard', 'renderEvalBar', 'renderMoves', 'renderControls', 'renderReview', 'renderStats', 'renderEngineCurrent', 'renderBestArrow', 'renderGraph']) a.replace(name, () => {});
  const searches = [], engines = ['nnue', 'sf19lite'].map((buildKey) => Object.assign(fakeEngine(async () => {
    searches.push(buildKey); return { score: { cp: 0 }, bestmove: 'e2e4', lines: [] };
  }), { buildKey }));
  let started = 0; a.replace('createEngine', async () => engines[started++]); a.replace('saveToLibrary', () => {});
  await a.call('startAnalysis');
  assert.ok(searches.length); assert.ok(searches.every((build) => 'nnue' === build));
  assert.ok(engines.every((engine) => engine.dead)); assert.equal(S.activeEngineBuild, 'nnue'); assert.equal(S.engineFallbackBuild, null);
});

test('capability detection distinguishes missing WASM and unsupported SIMD', () => {
  assert.equal(engineCapabilityError(), null);
  assert.match(engineCapabilityError(null).message, /WebAssembly is unavailable/);
  assert.match(engineCapabilityError({ validate: () => false }).message, /SIMD is unavailable/);
});

test('unsupported SIMD fails immediately before creating a worker', async (t) => {
  t.mock.method(WebAssembly, 'validate', () => false);
  const engine = new Engine(); t.after(() => engine.terminate());
  await assert.rejects(engine.setOptions(), { code: 'ENGINE_UNSUPPORTED' });
  assert.equal(engine.worker, undefined); assert.equal(engine.dead, true);
});

test('unsupported hardware exposes its specific recovery message in the review', async (t) => {
  const a = app(t); loadGame(a, '1. e4');
  for (const name of ['paintBoard', 'renderEvalBar', 'renderMoves', 'renderControls', 'renderReview', 'renderStats', 'renderEngineCurrent', 'renderBestArrow', 'renderGraph']) a.replace(name, () => {});
  a.replace('createEngine', async () => { throw engineCapabilityError({ validate: () => false }); });
  await a.call('startAnalysis');
  assert.match(a.state.analysisError, /SIMD is unavailable/); assert.equal(a.state.analyzing, false);
});

// A native helper can die mid-review (a killed process, antivirus quarantine, a wedged engine). One
// bad moment must not throw away a review that is otherwise complete: the position in flight is
// retried on a fresh engine — pinned to the SAME build, because mixing builds inside one review
// would silently null that side's accuracy (calibrated-review refuses to average two builds).
const quietReview = (a) => {
  for (const name of ['paintBoard', 'renderEvalBar', 'renderMoves', 'renderControls', 'renderReview', 'renderStats', 'renderEngineCurrent', 'renderBestArrow', 'renderGraph']) a.replace(name, () => {});
};
const answer = async () => ({ score: { cp: 10 }, bestmove: 'e2e4', lines: [] });
const dies = async () => { throw Error('native engine search timed out'); };

test('an engine that dies mid-review is replaced and the position retried on the same build', async (t) => {
  const a = app(t), S = loadGame(a, '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');
  quietReview(a);
  S.settings.engineWorkers = 1;
  const pins = [];
  a.replace('createEngine', async (opts, pin) => {
    pins.push(pin || null);
    const buildKey = pin?.build || 'nnue';
    // The first engine dies on its very first position; the replacement answers everything.
    return Object.assign(fakeEngine(pins.length === 1 ? dies : answer), { buildKey });
  });
  let saved = 0; a.replace('saveToLibrary', () => saved++);
  await a.call('startAnalysis');
  assert.equal(S.analysisError, null, 'the review finished instead of stopping');
  assert.equal(saved, 1, 'and it was saved');
  assert.equal(pins.length, 2, 'exactly one replacement for one death');
  assert.equal(pins[0], null, 'a normal start is not pinned');
  assert.equal(pins[1]?.build, 'nnue', 'the replacement is pinned to the build the review started with');
  assert.ok(S.evals.every(Boolean), 'every position has an evaluation');
});

test('a flapping engine cannot retry for ever: the rebuild budget is finite', async (t) => {
  const a = app(t), S = loadGame(a, '1. e4 e5 2. Nf3 Nc6');
  quietReview(a);
  S.settings.engineWorkers = 1;
  let created = 0;
  a.replace('createEngine', async () => { created++; return Object.assign(fakeEngine(dies), { buildKey: 'nnue' }); });
  a.replace('saveToLibrary', () => { throw Error('a stopped review must not be saved'); });
  await a.call('startAnalysis');
  assert.equal(created, 3, 'the initial engine plus two rebuilds, then it gives up');
  assert.equal(S.analyzing, false);
  // What the review panel actually renders: "Analysis stopped early: …" plus a Retry button.
  assert.match(S.analysisError, /engine stopped responding/);
});

test('an engine that cannot be replaced still stops the review with the honest message', async (t) => {
  const a = app(t), S = loadGame(a, '1. e4 e5 2. Nf3 Nc6');
  quietReview(a);
  S.settings.engineWorkers = 1;
  let created = 0;
  a.replace('createEngine', async () => {
    created++;
    if (created > 1) throw Error('native host could not be started');
    return Object.assign(fakeEngine(dies), { buildKey: 'nnue' });
  });
  a.replace('saveToLibrary', () => { throw Error('a stopped review must not be saved'); });
  await a.call('startAnalysis');
  assert.equal(created, 2, 'it tried once to replace the engine');
  assert.equal(S.analyzing, false);
  assert.match(S.analysisError, /engine stopped responding/);
});
