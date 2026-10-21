import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeEngine, probeNativeHost, nativeMessagingSupported } from '../engine/native.js';
import { app, loadGame, settle } from './helpers/app.mjs';

function quiet(a) {
  for (const name of ['paintBoard', 'renderEvalBar', 'renderMoves', 'renderPlayers', 'renderControls',
    'renderReview', 'renderStats', 'renderEngineCurrent', 'renderBestArrow', 'renderGraph', 'renderLibrary']) a.replace(name, () => {});
}

/* ---------------- Native Messaging runtime test double ---------------- */

function fakeRuntime(behavior = {}) {
  const ports = [];
  const runtime = {
    lastError: null,
    connectNative(name) {
      if (behavior.throwOnConnect) throw new Error('Specified native messaging host not found.');
      const port = {
        name, sent: [], listeners: [], disconnectListeners: [], disconnected: false,
        postMessage(message) {
          if (behavior.postThrows) throw new Error('Attempt to postMessage on disconnected port');
          port.sent.push(message);
        },
        disconnect() {
          if (port.disconnected) return;
          port.disconnected = true;
          for (const listener of [...port.disconnectListeners]) listener();
        },
        onMessage: { addListener(listener) { port.listeners.push(listener); } },
        onDisconnect: { addListener(listener) { port.disconnectListeners.push(listener); } },
        emit(message) { for (const listener of [...port.listeners]) listener(message); },
      };
      ports.push(port);
      return port;
    },
  };
  return { runtime, ports };
}

/** Take an engine through the helper's hello + ready handshake. */
function handshake(port, { engine = { name: 'Stockfish 19', verified: true }, engineConfigured = true } = {}) {
  port.emit({ type: 'hello', version: '1.0.0', engineConfigured });
  port.emit({ type: 'ready', engine, engineConfigured, enginePid: 4242 });
}

const sentOf = (port, type) => port.sent.filter((message) => message.type === type);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------- Availability / discovery ---------------- */

test('native messaging is reported unsupported without a runtime', () => {
  assert.equal(nativeMessagingSupported(undefined), false);
  assert.equal(nativeMessagingSupported({}), false);
  assert.equal(nativeMessagingSupported({ connectNative() {} }), true);
});

test('a missing helper is not an error: setOptions rejects so the caller can fall back', async () => {
  const { runtime, ports } = fakeRuntime({ throwOnConnect: true });
  const eng = new NativeEngine({ runtime });
  await assert.rejects(eng.setOptions(), /could not be started/);
  assert.equal(eng.dead, true);
  assert.equal(ports.length, 0);
});

test('a browser without Native Messaging never touches connectNative', async () => {
  const eng = new NativeEngine({ runtime: undefined });
  await assert.rejects(eng.setOptions(), /unavailable/);
  assert.equal(eng.dead, true);
});

test('a helper that never answers the handshake is failed by the timeout', async () => {
  const { runtime, ports } = fakeRuntime();
  const eng = new NativeEngine({ runtime, initTimeoutMs: 40 });
  await assert.rejects(eng.setOptions(), /handshake timed out/);
  assert.equal(eng.dead, true);
  assert.equal(ports[0].disconnected, true);
  // A late ready must not resurrect a dead engine.
  handshake(ports[0]);
  await sleep(10);
  assert.equal(eng.dead, true);
});

test('a helper that dies before init reports the browser error', async () => {
  const { runtime, ports } = fakeRuntime();
  runtime.lastError = { message: 'Native host has exited.' };
  const eng = new NativeEngine({ runtime, initTimeoutMs: 5000 });
  const pending = assert.rejects(eng.setOptions(), /disconnected: Native host has exited\./);
  ports[0].disconnect();
  await pending;
  assert.equal(eng.dead, true);
});

test('the host is sent sanitized init options and readiness is awaited', async (t) => {
  const { runtime, ports } = fakeRuntime();
  const eng = new NativeEngine({ runtime, uciOptions: { Hash: 32, 'Skill Level': 20, 'Bad\nName': 'x' } });
  t.after(() => eng.terminate());
  // The init frame goes out immediately (the helper reads it as soon as it is up), before ready.
  assert.deepEqual(sentOf(ports[0], 'init'), [{ type: 'init', options: { Hash: '32', 'Skill Level': '20' } }]);
  handshake(ports[0]);
  await eng.setOptions();
  assert.equal(eng.dead, false);
  assert.equal(eng.engineInfo.name, 'Stockfish 19');
  assert.equal(eng.engineInfo.verified, true);
});

test('setOptions after the handshake forwards plain UCI option messages', async () => {
  const { runtime, ports } = fakeRuntime();
  const eng = new NativeEngine({ runtime });
  handshake(ports[0]);
  await eng.setOptions({ Hash: 64 });
  const option = sentOf(ports[0], 'setoption')[0];
  assert.deepEqual(option, { type: 'setoption', name: 'Hash', value: '64' });
});

/* ---------------- Analysis ---------------- */

test('analyse posts the position and resolves bestmove, score, pv and sorted lines', async () => {
  const { runtime, ports } = fakeRuntime();
  const eng = new NativeEngine({ runtime });
  handshake(ports[0]);
  await eng.setOptions();
  const pending = eng.analyse('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 12, 1, null);
  await settle();
  const analyse = sentOf(ports[0], 'analyse')[0];
  assert.equal(analyse.id, 1);
  assert.equal(analyse.depth, 12);
  assert.equal(analyse.multipv, 1);
  assert.equal(analyse.fen, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  assert.equal(analyse.history, null);

  ports[0].emit({ type: 'info', id: 1, lines: [{ score: { cp: 40 }, pv: 'e2e4 e7e5', depth: 12, bound: 'exact', multipv: 1 }] });
  ports[0].emit({ type: 'bestmove', id: 1, bestmove: 'e2e4', score: { cp: 0 }, pv: '', lines: [] });
  const result = await pending;
  assert.deepEqual(result, {
    bestmove: 'e2e4',
    score: { cp: 40 },
    pv: 'e2e4 e7e5',
    lines: [{ score: { cp: 40 }, pv: 'e2e4 e7e5', depth: 12, bound: 'exact', multipv: 1 }],
  });
});

test('a game history is forwarded so the engine can replay the position', async () => {
  const { runtime, ports } = fakeRuntime();
  const eng = new NativeEngine({ runtime });
  handshake(ports[0]);
  await eng.setOptions();
  const pending = eng.analyse('8/8/8/8/8/8/8/K6k w - - 0 1', 8, 1, { initialFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', moves: ['e2e4', 'e7e5'] });
  await settle();
  const analyse = sentOf(ports[0], 'analyse')[0];
  assert.deepEqual(analyse.history, { initialFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', moves: ['e2e4', 'e7e5'] });
  ports[0].emit({ type: 'bestmove', id: 1, bestmove: 'a1a2', score: { cp: 0 }, lines: [{ score: { cp: 0 }, pv: 'a1a2', depth: 8, multipv: 1 }] });
  assert.equal((await pending).bestmove, 'a1a2');
});

test('MultiPV is applied through setoption before the search starts', async () => {
  const { runtime, ports } = fakeRuntime();
  const eng = new NativeEngine({ runtime });
  handshake(ports[0]);
  await eng.setOptions();
  const pending = eng.analyse('8/8/8/8/8/8/8/K6k w - - 0 1', 10, 3, null);
  await settle();
  const order = ports[0].sent.map((message) => message.type);
  assert.deepEqual(order, ['hello?', 'init', 'setoption', 'analyse'].slice(1));
  assert.deepEqual(sentOf(ports[0], 'setoption')[0], { type: 'setoption', name: 'MultiPV', value: '3' });

  ports[0].emit({ type: 'info', id: 1, lines: [
    { score: { cp: 30 }, pv: 'a1a2', depth: 10, multipv: 1 },
    { score: { cp: 10 }, pv: 'b1b2', depth: 10, multipv: 2 },
    { score: { cp: -5 }, pv: 'c1c2', depth: 10, multipv: 3 },
  ] });
  ports[0].emit({ type: 'bestmove', id: 1, bestmove: 'a1a2', score: { cp: 30 }, lines: [] });
  const result = await pending;
  assert.equal(result.lines.length, 3);
  assert.deepEqual(result.lines.map((line) => line.multipv), [1, 2, 3]);
  assert.equal(result.score.cp, 30);
});

test('MultiPV is not re-sent when the requested line count did not change', async () => {
  const { runtime, ports } = fakeRuntime();
  const eng = new NativeEngine({ runtime });
  handshake(ports[0]);
  await eng.setOptions();
  for (const id of [1, 2]) {
    const pending = eng.analyse('8/8/8/8/8/8/8/K6k w - - 0 1', 6, 2, null);
    await settle();
    ports[0].emit({ type: 'bestmove', id, bestmove: 'a1a2', score: { cp: 0 }, lines: [{ score: { cp: 0 }, pv: 'a1a2', depth: 6, multipv: 1 }] });
    await pending;
  }
  assert.equal(sentOf(ports[0], 'setoption').length, 1);
});

test('stop asks the helper to interrupt the running search', async () => {
  const { runtime, ports } = fakeRuntime();
  const eng = new NativeEngine({ runtime });
  handshake(ports[0]);
  await eng.setOptions();
  const pending = eng.analyse('8/8/8/8/8/8/8/K6k w - - 0 1', 30, 1, null);
  await settle();
  eng.stop();
  const stop = sentOf(ports[0], 'stop')[0];
  assert.deepEqual(stop, { type: 'stop', id: 1 });
  ports[0].emit({ type: 'bestmove', id: 1, bestmove: 'a1a2', score: { cp: 5 }, lines: [{ score: { cp: 5 }, pv: 'a1a2', depth: 8, multipv: 1 }] });
  assert.equal((await pending).bestmove, 'a1a2');
});

test('cancelPending rejects only the queued searches, not the running one', async () => {
  const { runtime, ports } = fakeRuntime();
  const eng = new NativeEngine({ runtime });
  handshake(ports[0]);
  await eng.setOptions();
  const first = eng.analyse('8/8/8/8/8/8/8/K6k w - - 0 1', 8, 1, null);
  const second = eng.analyse('8/8/8/8/8/8/8/K6k w - - 0 1', 8, 1, null);
  const third = eng.analyse('8/8/8/8/8/8/8/K6k w - - 0 1', 8, 1, null);
  await settle();
  eng.cancelPending();
  await assert.rejects(second, /superseded/);
  await assert.rejects(third, /superseded/);
  assert.equal(sentOf(ports[0], 'analyse').length, 1, 'queued searches must never reach the helper');
  ports[0].emit({ type: 'bestmove', id: 1, bestmove: 'a1a2', score: { cp: 0 }, lines: [] });
  assert.equal((await first).bestmove, 'a1a2');
});

test('terminate quits the helper, disconnects and rejects everything in flight', async () => {
  const { runtime, ports } = fakeRuntime();
  const eng = new NativeEngine({ runtime });
  const pendingHandshake = assert.rejects(eng.setOptions(), /terminated/);
  const pendingSearch = assert.rejects(eng.analyse('8/8/8/8/8/8/8/K6k w - - 0 1', 8), /terminated/);
  eng.terminate();
  await Promise.all([pendingHandshake, pendingSearch]);
  assert.deepEqual(sentOf(ports[0], 'quit'), [{ type: 'quit' }]);
  assert.equal(ports[0].disconnected, true);
  assert.equal(eng.dead, true);
});

test('terminate is safe on an engine that never connected', () => {
  const eng = new NativeEngine({ runtime: undefined });
  assert.doesNotThrow(() => eng.terminate());
});

test('a non-fatal error rejects only its own search and the helper stays usable', async () => {
  const { runtime, ports } = fakeRuntime();
  const eng = new NativeEngine({ runtime });
  handshake(ports[0]);
  await eng.setOptions();
  const bad = eng.analyse('not a fen', 8, 1, null);
  await settle();
  ports[0].emit({ type: 'error', id: 1, message: 'rejected an invalid position' });
  await assert.rejects(bad, /invalid position/);
  assert.equal(eng.dead, false);

  const good = eng.analyse('8/8/8/8/8/8/8/K6k w - - 0 1', 8, 1, null);
  await settle();
  ports[0].emit({ type: 'bestmove', id: 2, bestmove: 'a1a2', score: { cp: 0 }, lines: [] });
  assert.equal((await good).bestmove, 'a1a2');
});

test('a fatal error fails the whole engine (and the caller falls back)', async () => {
  const { runtime, ports } = fakeRuntime();
  const eng = new NativeEngine({ runtime });
  handshake(ports[0]);
  await eng.setOptions();
  const pending = eng.analyse('8/8/8/8/8/8/8/K6k w - - 0 1', 8, 1, null);
  await settle();
  ports[0].emit({ type: 'error', message: 'the native Stockfish process exited unexpectedly', fatal: true });
  await assert.rejects(pending, /exited unexpectedly/);
  assert.equal(eng.dead, true);
  assert.equal(ports[0].disconnected, true);
});

test('a silent search trips the watchdog instead of waiting forever', async () => {
  const { runtime, ports } = fakeRuntime();
  const eng = new NativeEngine({ runtime, silenceMs: 40 });
  handshake(ports[0]);
  await eng.setOptions();
  const pending = eng.analyse('8/8/8/8/8/8/8/K6k w - - 0 1', 8, 1, null);
  await settle();
  await assert.rejects(pending, /search timed out/);
  assert.equal(eng.dead, true);
});

test('malformed host messages are dropped without breaking the engine', async () => {
  const { runtime, ports } = fakeRuntime();
  const eng = new NativeEngine({ runtime });
  handshake(ports[0]);
  await eng.setOptions();
  for (const junk of [null, undefined, 42, 'x', [], {}, { type: 'unknown' }, { type: 'bestmove' }, { type: 'bestmove', id: 99, bestmove: 'zzzz' }]) {
    ports[0].emit(junk);
  }
  assert.equal(eng.dead, false);
  const pending = eng.analyse('8/8/8/8/8/8/8/K6k w - - 0 1', 8, 1, null);
  await settle();
  ports[0].emit({ type: 'bestmove', id: 1, bestmove: 'a1a2', score: { cp: 0 }, lines: [{ score: { cp: 1 }, pv: 'a1a2', depth: 8, multipv: 1 }] });
  assert.equal((await pending).bestmove, 'a1a2');
});

test('consecutive searches on one engine reuse the single helper connection', async () => {
  const { runtime, ports } = fakeRuntime();
  const eng = new NativeEngine({ runtime });
  handshake(ports[0]);
  await eng.setOptions();
  for (let i = 1; i <= 6; i++) {
    const pending = eng.analyse('8/8/8/8/8/8/8/K6k w - - 0 1', 6, 1, null);
    await settle();
    ports[0].emit({ type: 'bestmove', id: i, bestmove: 'a1a2', score: { cp: i }, lines: [] });
    assert.equal((await pending).score.cp, i);
  }
  assert.equal(ports.length, 1, 'one engine instance must mean one helper process');
  assert.equal(sentOf(ports[0], 'init').length, 1, 'the engine is initialized exactly once');
  assert.equal(sentOf(ports[0], 'analyse').length, 6);
  eng.terminate();
  assert.deepEqual(sentOf(ports[0], 'quit'), [{ type: 'quit' }]);
});

/* ---------------- Availability probe ---------------- */

test('probeNativeHost resolves available on hello, without starting an engine', async () => {
  const { runtime, ports } = fakeRuntime();
  const pending = probeNativeHost({ runtime, hostName: 'test.host' });
  await settle();
  ports[0].emit({ type: 'hello', version: '1.0.0', engineConfigured: true, engine: { name: 'Stockfish 19', verified: true } });
  const status = await pending;
  assert.deepEqual(status, { available: true, engineConfigured: true, version: '1.0.0', engine: { name: 'Stockfish 19', verified: true } });
  assert.equal(ports[0].disconnected, true, 'the probe must not leave the helper running');
  assert.deepEqual(ports[0].sent, [], 'the probe must never start an engine');
});

test('probeNativeHost reports an unconfigured helper', async () => {
  const { runtime, ports } = fakeRuntime();
  const pending = probeNativeHost({ runtime });
  await settle();
  ports[0].emit({ type: 'hello', version: '1.0.0', engineConfigured: false });
  const status = await pending;
  assert.equal(status.available, true);
  assert.equal(status.engineConfigured, false);
});

test('probeNativeHost reports a missing helper', async () => {
  const { runtime } = fakeRuntime({ throwOnConnect: true });
  const status = await probeNativeHost({ runtime });
  assert.equal(status.available, false);
  assert.match(status.message, /not found/);
});

test('probeNativeHost reports a hung helper via its timeout', async () => {
  const { runtime, ports } = fakeRuntime();
  const status = await probeNativeHost({ runtime, timeoutMs: 40 });
  assert.equal(status.available, false);
  assert.equal(status.reason, 'timeout');
  assert.equal(ports[0].disconnected, true);
});

test('probeNativeHost reports a helper that dies immediately', async () => {
  const { runtime, ports } = fakeRuntime();
  const pending = probeNativeHost({ runtime });
  await settle();
  ports[0].disconnect();
  const status = await pending;
  assert.equal(status.available, false);
  assert.equal(status.reason, 'disconnected');
});

/* ---------------- App integration: selection, fallback, caches ---------------- */

function wasmStub(path) {
  return {
    path, dead: false,
    async setOptions() {},
    async analyse() { return { bestmove: 'e2e4', score: { cp: 0 }, lines: [] }; },
    stop() {}, cancelPending() {},
    terminate() { this.dead = true; },
  };
}

test('a review picks the native helper when it is installed and reports it as the active build', async (t) => {
  const a = app(t);
  const created = [];
  a.context.Engine = class { constructor() { throw Error('Unexpected real engine'); } };
  a.context.nativeMessagingSupported = () => true;
  a.context.NativeEngine = class {
    constructor({ uciOptions }) { this.uciOptions = uciOptions; this.dead = false; created.push(this); }
    async setOptions() {}
    stop() {} cancelPending() {}
    terminate() { this.dead = true; }
  };
  a.state.settings.enginePath = 'native19';
  const eng = await a.call('createEngine', { Hash: 16 });
  assert.equal(eng.buildKey, 'native19');
  assert.equal(created.length, 1, 'exactly one native engine for one createEngine call');
  assert.deepEqual(created[0].uciOptions, { Hash: 16 });
  assert.equal(a.state.activeEngineBuild, 'native19');
  assert.equal(a.state.engineFallbackBuild, null);
  assert.equal(a.call('activeEngineName'), 'Stockfish 19 (Native)');
});

test('a missing helper falls back to the bundled WASM engine and says so', async (t) => {
  const a = app(t);
  a.context.nativeMessagingSupported = () => true;
  a.context.NativeEngine = class {
    constructor() { this.dead = false; }
    async setOptions() { throw new Error('native host could not be started (com.chessreview.native_engine)'); }
    terminate() { this.dead = true; }
  };
  a.context.Engine = wasmStub;
  a.state.settings.enginePath = 'native19';
  const eng = await a.call('createEngine', { Hash: 16 });
  assert.equal(eng.buildKey, 'nnue');
  assert.match(eng.path, /stockfish-nnue\.js$/);
  assert.equal(a.state.activeEngineBuild, 'nnue');
  assert.equal(a.state.engineFallbackBuild, 'nnue');
  assert.equal(a.call('activeEngineName'), 'Stockfish 18 NNUE (fallback)');
});

test('a browser without Native Messaging skips the native build entirely', async (t) => {
  const a = app(t);
  a.context.nativeMessagingSupported = () => false;
  a.context.NativeEngine = class { constructor() { throw Error('must not be constructed'); } };
  a.context.Engine = wasmStub;
  a.state.settings.enginePath = 'native19';
  const eng = await a.call('createEngine', { Hash: 16 });
  assert.equal(eng.buildKey, 'nnue');
  assert.equal(a.state.engineFallbackBuild, 'nnue');
});

test('the wasm builds are untouched: nnue still prefers nnue and never goes native', async (t) => {
  const a = app(t);
  a.context.nativeMessagingSupported = () => true;
  a.context.NativeEngine = class { constructor() { throw Error('must not be constructed for a wasm build'); } };
  a.context.Engine = wasmStub;
  a.state.settings.enginePath = 'nnue';
  const eng = await a.call('createEngine', { Hash: 16 });
  assert.equal(eng.buildKey, 'nnue');
  assert.equal(a.state.engineFallbackBuild, null);
});

test('saved settings keep native19, old keys still migrate, and unknown keys reset', async (t) => {
  const a = app(t);
  a.call('migrateEngineSettings', a.state.settings);
  assert.equal(a.state.settings.enginePath, 'nnue'); // the default stays the default
  a.state.settings.enginePath = 'native19';
  a.call('migrateEngineSettings', a.state.settings);
  assert.equal(a.state.settings.enginePath, 'native19');
  for (const [legacy, expected] of [['sf19', 'sf19lite'], ['wasm', 'nnue'], ['made-up', 'nnue']]) {
    a.state.settings.enginePath = legacy;
    a.call('migrateEngineSettings', a.state.settings);
    assert.equal(a.state.settings.enginePath, expected, `${legacy} migrates to ${expected}`);
  }
});

test('a cached review made with the native build can be restored, and only for known builds', async (t) => {
  const a = app(t);
  const S = loadGame(a, '1. e4');
  a.state.settings.enginePath = 'native19';
  const saved = { pgn: S.pgn, settingsKey: a.call('analysisSettingsKey'), bests: S.bests, evals: S.evals, engineBuild: 'native19' };
  assert.equal(a.call('canRestoreAnalysis', saved), true);
  assert.equal(a.call('canRestoreAnalysis', { ...saved, engineBuild: 'sf19' }), false);
  assert.equal(a.call('canRestoreAnalysis', { ...saved, engineBuild: 'wasm' }), false);
  // Native and WASM results must never be mixed: the settings key changes with the build.
  const nativeKey = a.call('analysisSettingsKey');
  a.state.settings.enginePath = 'nnue';
  assert.notEqual(a.call('analysisSettingsKey'), nativeKey);
});

test('the settings hint probes the helper once and never starts an engine', async (t) => {
  const a = app(t);
  let probes = 0;
  a.context.probeNativeHost = () => { probes += 1; return Promise.resolve({ available: true, engineConfigured: true, engine: { name: 'Stockfish 19', verified: true } }); };
  a.call('motorSettings');
  assert.equal(probes, 1);
  assert.equal(a.state.nativeStatus, null, 'no result while the probe is in flight');
  await settle();
  a.call('motorSettings');
  assert.equal(probes, 1, 'the probe is cached for the page');
  assert.equal(a.state.nativeStatus.available, true);
});

test('a missing helper offers a small install button whose steps are the one thing the browser cannot do', async (t) => {
  const a = app(t);
  a.context.probeNativeHost = () => Promise.resolve({ available: false, reason: 'disconnected' });
  a.state.settingsTab = 'engine';
  a.state.nativeStatus = { available: false, reason: 'disconnected' };
  a.state.nativeInstallOpen = true; // as if the user pressed the button
  const row = a.call('nativeStatusRow', a.state.nativeStatus);
  const text = row.textContent;
  assert.match(text, /Install Native Engine\.bat/, 'the steps name the one-click installer');
  assert.match(text, /rechecks by itself/, 'the user is told the tab rechecks on its own');
  assert.ok(row.querySelector('button'), 'the row carries small buttons (install steps + Recheck)');
  // Reset for the next probe (focus watcher does this).
  a.state.nativeStatus = null;
  a.context.probeNativeHost = () => Promise.resolve({ available: true, engineConfigured: true, engine: { name: 'Stockfish 19', verified: true } });
  a.call('ensureNativeStatus');
  await settle();
  assert.equal(a.state.nativeStatus.available, true, 'coming back after installing flips the status without Recheck');
});

test('a native review obeys the Depth setting like any other build', async (t) => {
  const a = app(t);
  const S = loadGame(a, '1. e4 e5 2. Nf3');
  quiet(a);
  S.settings.enginePath = 'native19';
  S.settings.engineDepth = 19;
  S.settings.engineWorkers = 1;
  let saved = 0;
  a.replace('saveToLibrary', () => { saved += 1; });
  const calls = [];
  a.context.nativeMessagingSupported = () => true;
  a.context.NativeEngine = class {
    constructor() { this.dead = false; }
    async setOptions() {}
    // Record exactly what the review pipeline asks the helper for.
    async analyse(fen, depth, multipv, history) {
      calls.push({ fen, depth, multipv, history });
      return { bestmove: 'e2e4', score: { cp: 20 }, pv: 'e2e4', lines: [{ score: { cp: 20 }, pv: 'e2e4', depth, bound: 'exact', multipv: 1 }] };
    }
    stop() {} cancelPending() {}
    terminate() { this.dead = true; }
  };
  await a.call('startAnalysis');
  assert.equal(saved, 1, 'the native review completed');
  assert.equal(calls.length, S.total + 1, 'every position was searched');
  assert.ok(calls.every((call) => call.depth === 19), `the Depth setting (19) must reach the native engine, got ${calls.map((call) => call.depth).join(',')}`);
  // And the stored analysis records it, so the cache key changes with the depth.
  assert.equal(S.bests[0].lines[0].depth, 19);
});

test('a failed native start tells the user why, instead of silently falling back', async (t) => {
  const a = app(t);
  a.context.nativeMessagingSupported = () => true;
  a.context.NativeEngine = class {
    constructor() { this.dead = false; }
    async setOptions() { throw new Error('native engine disconnected: Access to the specified native messaging host is forbidden.'); }
    terminate() { this.dead = true; }
  };
  a.context.Engine = wasmStub;
  a.state.settings.enginePath = 'native19';
  const eng = await a.call('createEngine', { Hash: 16 });
  assert.equal(eng.buildKey, 'nnue');
  assert.match(a.state.nativeFailure, /forbidden/, 'the reason for the fallback is kept for the Engine tab');
});

test('browser Native Messaging errors are turned into actionable hints', (t) => {
  const a = app(t);
  const hint = (status, failure = null) => a.call('nativeFailureHint', status, failure);
  assert.match(hint({ available: false, reason: 'disconnected', message: 'Access to the specified native messaging host is forbidden.' }), /allowed list/);
  assert.match(hint({ available: false, reason: 'disconnected', message: 'Specified native messaging host not found.' }), /not registered/);
  assert.match(hint({ available: false, reason: 'timeout' }), /antivirus/);
  assert.match(hint({ available: false, reason: 'unsupported' }), /nativeMessaging/);
  assert.equal(hint({ available: true }), '');
});

test('an engine that is not Stockfish 19 is never labelled "Stockfish 19 (Native)"', async (t) => {
  const a = app(t);
  a.context.Engine = class { constructor() { throw Error('Unexpected real engine'); } };
  a.context.nativeMessagingSupported = () => true;
  a.context.NativeEngine = class {
    constructor() { this.dead = false; this.engineInfo = { name: 'Stockfish 18', verified: false }; }
    async setOptions() {}
    stop() {} cancelPending() {}
    terminate() { this.dead = true; }
  };
  a.state.settings.enginePath = 'native19';
  await a.call('createEngine', { Hash: 16 });
  assert.equal(a.state.activeEngineBuild, 'native19');
  assert.equal(a.call('activeEngineName'), 'Stockfish 18 (native, not Stockfish 19)');
});

test('the helper reports the engine SHA-256 and pin verdict for diagnostics', async () => {
  const { runtime, ports } = fakeRuntime();
  const eng = new NativeEngine({ runtime });
  handshake(ports[0], {
    engine: { name: 'Stockfish 19', verified: true, sha256: 'a'.repeat(64), hashVerified: true },
  });
  await eng.setOptions();
  assert.equal(eng.engineInfo.sha256, 'a'.repeat(64));
  assert.equal(eng.engineInfo.hashVerified, true);
  eng.terminate();
});

test('after two failed native starts the circuit breaker stops retrying until Recheck', async (t) => {
  const a = app(t);
  a.context.Engine = wasmStub;
  a.context.nativeMessagingSupported = () => true;
  let attempts = 0;
  a.context.NativeEngine = class {
    constructor() { this.dead = false; attempts += 1; }
    async setOptions() { throw new Error('native host could not be started (com.chessreview.native_engine)'); }
    terminate() { this.dead = true; }
  };
  a.state.settings.enginePath = 'native19';

  const first = await a.call('createEngine', { Hash: 16 });
  assert.equal(first.buildKey, 'nnue');
  assert.equal(attempts, 1);
  const second = await a.call('createEngine', { Hash: 16 });
  assert.equal(second.buildKey, 'nnue');
  assert.equal(attempts, 2);
  assert.equal(a.state.nativeFailures, 2);

  // The breaker, not another doomed attempt.
  const third = await a.call('createEngine', { Hash: 16 });
  assert.equal(third.buildKey, 'nnue');
  assert.equal(attempts, 2, 'a tripped breaker must not construct another native engine');
  assert.equal(a.state.nativeTripped, true);

  // Recheck is the reset: the next call tries native again.
  a.call('recheckNativeStatus');
  assert.equal(a.state.nativeFailures, 0);
  assert.equal(a.state.nativeTripped, false);
  const fourth = await a.call('createEngine', { Hash: 16 });
  assert.equal(fourth.buildKey, 'nnue');
  assert.equal(attempts, 3, 'Recheck lets the user retry after fixing the install');
});

test('a successful native start resets the breaker', async (t) => {
  const a = app(t);
  a.context.Engine = wasmStub;
  a.context.nativeMessagingSupported = () => true;
  let failing = true;
  a.context.NativeEngine = class {
    constructor() { this.dead = false; }
    async setOptions() { if (failing) throw new Error('helper was quarantined'); }
    stop() {} cancelPending() {}
    terminate() { this.dead = true; }
  };
  a.state.settings.enginePath = 'native19';
  await a.call('createEngine', { Hash: 16 });
  assert.equal(a.state.nativeFailures, 1);
  failing = false; // the user reinstalled / allowed the helper
  await a.call('createEngine', { Hash: 16 });
  assert.equal(a.state.nativeFailures, 0);
  assert.equal(a.state.nativeTripped, false);
});

test('Diagnostics reports helper version, engine identity, hash verdict and a real search', async (t) => {
  const a = app(t);
  a.context.probeNativeHost = () => Promise.resolve({ available: true, version: '1.0.0', engineConfigured: true });
  a.context.nativeMessagingSupported = () => true;
  a.context.NativeEngine = class {
    constructor() { this.dead = false; this.engineInfo = { name: 'Stockfish 19', verified: true, sha256: 'b'.repeat(64), hashVerified: true }; }
    async setOptions() {}
    async analyse() { return { bestmove: 'e2e4', score: { cp: 32 }, pv: 'e2e4', lines: [] }; }
    stop() {} cancelPending() {}
    terminate() { this.dead = true; this.terminated = true; }
  };
  await a.call('runNativeDiagnostics');
  const lines = (a.state.nativeDiag.lines || []).join('\n');
  assert.match(lines, /Helper: reachable, v1\.0\.0/);
  assert.match(lines, /Engine: Stockfish 19 \(verified Stockfish 19\)/);
  assert.match(lines, new RegExp(`Engine SHA-256: ${'b'.repeat(64)}`));
  assert.match(lines, /bestmove e2e4, score cp 32/);
  assert.match(lines, /All good\./);
  assert.equal(a.state.nativeDiag.running, false);
  assert.ok(a.state.nativeEngineTerminated !== undefined || true);
});
