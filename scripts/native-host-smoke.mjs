// scripts/native-host-smoke.mjs — end-to-end test of the Chess Review Native Messaging host.
//
// It compiles native/host/ChessReviewHost.cs and the UCI test double native/test/FakeEngine.cs with
// the csc.exe that ships with Windows, then talks to the real helper over the real Native Messaging
// protocol (length-prefixed JSON on stdio) exactly as the browser does.
//
// This is what verifies the parts the browser-side unit tests cannot: stdio framing, silent child
// startup, the UCI handshake, MultiPV, stop/cancel, engine-crash detection, the silence watchdog,
// oversize/invalid frame rejection, quit/EOF shutdown and orphan-process cleanup.
//
// It needs no genuine Stockfish executable (none is bundled with the repo). Run:
//   npm run test:native-host
// Skips cleanly (exit 0) off Windows or when csc.exe is missing.
//
// NOTE: antivirus "behavior shield" features emulate freshly compiled executables, which makes each
// launch slow and can briefly show extra lookalike processes. That is why the functional checks
// share ONE helper process, and why orphan detection pins the exact engine PID (reported by the
// host in `ready`) instead of counting processes by name.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const buildDir = path.join(root, 'web-ext-artifacts', 'native-host-smoke');
const keep = process.argv.includes('--keep');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.platform !== 'win32') {
  console.log('[native-host-smoke] skipped: the native helper is Windows-only');
  process.exit(0);
}

let csc = null;
for (const candidate of [
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
]) {
  try { await fs.access(candidate); csc = candidate; break; } catch { /* try the next one */ }
}
if (!csc) {
  console.log('[native-host-smoke] skipped: csc.exe not found (.NET Framework 4.x compiler missing)');
  process.exit(0);
}

await fs.rm(buildDir, { recursive: true, force: true });
await fs.mkdir(buildDir, { recursive: true });
const hostExe = path.join(buildDir, 'ChessReviewHost.exe');
const fakeExe = path.join(buildDir, 'FakeEngine.exe');

function compile(exe, source) {
  execFileSync(csc, ['/nologo', '/target:exe', '/optimize+', `/out:${exe}`,
    '/r:System.dll', '/r:System.Core.dll', '/r:System.Web.Extensions.dll',
    path.join(root, source)], { stdio: ['ignore', 'pipe', 'pipe'] });
}
try {
  compile(hostExe, 'native/host/ChessReviewHost.cs');
  compile(fakeExe, 'native/test/FakeEngine.cs');
} catch (error) {
  console.error('[native-host-smoke] compilation failed');
  console.error(error.stdout?.toString() || error.message);
  process.exit(1);
}

/* ---------------- Native Messaging framing ---------------- */

function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/**
 * Start one helper process, reading config.json from next to the exe (as the browser does), and
 * return a small client that speaks the wire protocol. Runs share the build directory so antivirus
 * does not rescan a fresh copy of the executables for every check.
 */
async function boot(options = {}) {
  const config = {
    enginePath: options.enginePath === null ? '' : (options.enginePath || fakeExe),
    threads: 1,
    hashMb: 16,
    searchTimeoutMs: options.searchTimeoutMs || 120000,
  };
  await fs.writeFile(path.join(buildDir, 'config.json'), JSON.stringify(config));

  const child = spawn(hostExe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd: buildDir });
  const state = { messages: [], logs: '', exited: null, buffer: Buffer.alloc(0) };
  const waiters = [];
  const flush = () => waiters.splice(0).forEach((waiter) => waiter());

  child.stdout.on('data', (chunk) => {
    state.buffer = Buffer.concat([state.buffer, chunk]);
    while (state.buffer.length >= 4) {
      const length = state.buffer.readUInt32LE(0);
      if (state.buffer.length < 4 + length) break;
      const payload = state.buffer.subarray(4, 4 + length);
      state.buffer = state.buffer.subarray(4 + length);
      try { state.messages.push(JSON.parse(payload.toString('utf8'))); }
      catch { state.messages.push({ type: '__unparsable__' }); }
      flush();
    }
  });
  child.stderr.on('data', (chunk) => { state.logs += chunk.toString('utf8'); });
  child.on('exit', (code, signal) => { state.exited = { code, signal }; flush(); });

  const api = {
    state, child,
    send(message) { child.stdin.write(encodeFrame(message)); },
    sendRaw(buffer) { child.stdin.write(buffer); },
    /**
     * Wait for a message of `type` that arrives from now on. Every wait is scoped to messages that
     * appear AFTER it is called — a shared helper session would otherwise satisfy a new wait with a
     * stale `bestmove`/`error` from an earlier check.
     */
    waitFor(predicate, timeoutMs = 8000, label = 'message') {
      return new Promise((resolve, reject) => {
        const start = state.messages.length;
        const find = () => {
          for (let i = start; i < state.messages.length; i++) {
            if (predicate(state.messages[i])) return state.messages[i];
          }
          return null;
        };
        const immediate = find();
        if (immediate) return resolve(immediate);
        const timer = setTimeout(() => {
          reject(new Error(`timed out waiting for ${label}; messages=${JSON.stringify(state.messages.slice(start))}; logs=${state.logs.slice(-400)}`));
        }, timeoutMs);
        waiters.push(() => { const hit = find(); if (hit) { clearTimeout(timer); resolve(hit); } });
      });
    },
    waitForExit(timeoutMs = 8000) {
      return new Promise((resolve, reject) => {
        if (state.exited) return resolve(state.exited);
        const timer = setTimeout(() => reject(new Error(`timed out waiting for host exit; logs=${state.logs.slice(-400)}`)), timeoutMs);
        waiters.push(() => { clearTimeout(timer); resolve(state.exited); });
      });
    },
    /** End this helper the way the browser ends it, and wait until it is really gone. */
    async close() {
      try { child.stdin.end(); } catch { /* already closed */ }
      try { await this.waitForExit(6000); } catch { try { child.kill(); } catch { /* gone */ } }
      await sleep(100);
    },
  };

  // The helper sends `hello` before it starts any engine; that is also our "process is up" signal.
  await api.waitFor((message) => message.type === 'hello', 60000, 'hello');
  return api;
}

function analyse(overrides = {}) {
  return {
    type: 'analyse', id: 1, depth: 6, multipv: 1,
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    ...overrides,
  };
}

// The test double reads its crash/hang scenarios from the fullmove number (the FEN must stay valid).
const CRASH_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 9999';
const HANG_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 9998';
const NOMOVE_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 9997';

/** True while the exact engine process (pid reported by the host) is still alive. */
function engineAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; } // ESRCH = gone; EPERM = alive
}

async function waitForEngine(pid, alive, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (engineAlive(pid) !== alive && Date.now() < deadline) await sleep(120);
  return engineAlive(pid) === alive;
}

/* ---------------- Runner ---------------- */

const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log(`  ok    ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.message }); console.log(`  FAIL  ${name}\n        ${error.message}`); }
}
function assert(condition, message) { if (!condition) throw new Error(message); }

/* ---------------- Session 1: one helper, one engine, all functional behaviour ---------------- */

let host = null;
let enginePid = 0;

await check('hello arrives before any engine starts, and reports the config state', async () => {
  host = await boot();
  const hello = host.state.messages.find((message) => message.type === 'hello');
  assert(hello && hello.engineConfigured === true, `unexpected hello: ${JSON.stringify(hello)}`);
  assert(!host.state.messages.some((message) => message.type === 'ready'), 'no engine may start before init');
});

await check('init performs the UCI handshake and reports the engine identity', async () => {
  host.send({ type: 'init', options: { Hash: 16, 'Skill Level': 20 } });
  const ready = await host.waitFor((message) => message.type === 'ready', 60000, 'ready');
  assert(ready.engine && /Stockfish/.test(ready.engine.name), `engine name not reported: ${JSON.stringify(ready)}`);
  assert(ready.engine.verified === true, 'a Stockfish id name must be reported as verified');
  enginePid = ready.enginePid;
  assert(await waitForEngine(enginePid, true) === true, 'the reported engine pid should be running');
});

await check('a second init on one port does not start a second engine process', async () => {
  host.send({ type: 'init', options: { Hash: 32 } });
  const second = await host.waitFor((message) => message.type === 'ready', 10000, 'second ready');
  assert(second.enginePid === enginePid, 'the same engine must keep serving the port');
  assert(await waitForEngine(enginePid, true) === true, 'the first engine should still be running');
});

await check('a position is analysed and returns bestmove, score and lines', async () => {
  host.send(analyse({ depth: 6 }));
  const result = await host.waitFor((message) => message.type === 'bestmove', 10000, 'bestmove');
  assert(result.bestmove === 'e2e4', `unexpected bestmove ${result.bestmove}`);
  assert(Number.isFinite(result.score.cp), 'score.cp missing');
  assert(Array.isArray(result.lines) && result.lines.length === 1, `expected 1 line, got ${JSON.stringify(result.lines)}`);
  assert(result.lines[0].multipv === 1 && result.lines[0].depth > 0 && result.lines[0].bound === 'exact', 'line metadata wrong');
  assert(result.lines[0].pv.startsWith('e2e4'), 'pv missing');
});

await check('search limits are honoured: MultiPV yields one line per requested line', async () => {
  host.send(analyse({ depth: 5, multipv: 3 }));
  const result = await host.waitFor((message) => message.type === 'bestmove', 10000, 'bestmove');
  assert(result.lines.length === 3, `expected 3 lines, got ${result.lines.length}`);
  assert(result.lines.map((line) => line.multipv).join(',') === '1,2,3', 'lines must be ordered 1..n');
  assert(result.lines[0].score.cp > result.lines[2].score.cp, 'the test engine reports decreasing scores per line');
});

await check('a game history is replayed and an invalid position is rejected without killing the host', async () => {
  host.send(analyse({
    id: 7, depth: 4,
    history: { initialFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', moves: ['e2e4', 'e7e5'] },
  }));
  const withHistory = await host.waitFor((message) => message.type === 'bestmove' && message.id === 7, 10000, 'history bestmove');
  assert(withHistory.bestmove === 'e2e4', 'the history search failed');

  host.send(analyse({ id: 8, fen: 'not-a-fen' }));
  const rejected = await host.waitFor((message) => message.type === 'error' && message.id === 8, 6000, 'rejection');
  assert(!rejected.fatal, 'a bad position must not be fatal');

  host.send(analyse({ id: 9, depth: 4 }));
  const alive = await host.waitFor((message) => message.type === 'bestmove' && message.id === 9, 10000, 'bestmove after rejection');
  assert(alive.bestmove === 'e2e4', 'the host must keep working after a rejected message');
});

await check('an unsafe move in the history is rejected too', async () => {
  host.send(analyse({ id: 10, depth: 3, history: { initialFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', moves: ['e2e4', 'drop table users'] } }));
  const rejected = await host.waitFor((message) => message.type === 'error' && message.id === 10, 6000, 'rejection');
  assert(!rejected.fatal, 'a bad history must not be fatal');
});

await check('stop interrupts a long search and still answers', async () => {
  host.send(analyse({ depth: 40 }));
  await sleep(220);
  const started = Date.now();
  host.send({ type: 'stop', id: 1 });
  await host.waitFor((message) => message.type === 'bestmove', 4000, 'bestmove after stop');
  assert(Date.now() - started < 3000, 'stop must return quickly');
});

await check('an unknown message type is rejected without killing the host', async () => {
  host.send({ type: 'nonsense' });
  const error = await host.waitFor((message) => message.type === 'error', 6000, 'error');
  assert(!error.fatal, 'an unknown type must not be fatal');
  host.send({ type: 'ping' });
  await host.waitFor((message) => message.type === 'pong', 6000, 'pong');
});

await check('five consecutive searches reuse one engine, then quit reaps it and exits cleanly', async () => {
  for (let i = 1; i <= 5; i++) {
    host.send(analyse({ id: 100 + i, depth: 3 }));
    await host.waitFor((message) => message.type === 'bestmove' && message.id === 100 + i, 10000, `bestmove ${i}`);
  }
  assert(await waitForEngine(enginePid, true) === true, 'one engine should have served all five searches');
  host.send({ type: 'quit' });
  const exit = await host.waitForExit(6000);
  assert(exit.code === 0, `expected exit code 0, got ${JSON.stringify(exit)}`);
  assert(await waitForEngine(enginePid, false) === true, 'the engine process must not survive quit');
  host = null;
});

/* ---------------- Sessions 2+: one lifecycle scenario per helper ---------------- */

await check('closing stdin (browser/extension gone) reaps the engine and exits', async () => {
  host = await boot();
  host.send({ type: 'init', options: {} });
  const ready = await host.waitFor((message) => message.type === 'ready', 60000, 'ready');
  enginePid = ready.enginePid;
  host.child.stdin.end();
  const exit = await host.waitForExit(6000);
  assert(exit.code === 0, `expected exit code 0, got ${JSON.stringify(exit)}`);
  assert(await waitForEngine(enginePid, false) === true, 'the engine process must not be orphaned on EOF');
  host = null;
});

await check('force-killing the helper still reaps its engine (job object)', async () => {
  host = await boot();
  host.send({ type: 'init', options: {} });
  const ready = await host.waitFor((message) => message.type === 'ready', 60000, 'ready');
  enginePid = ready.enginePid;
  assert(await waitForEngine(enginePid, true) === true, 'the engine should be running');
  host.child.kill('SIGKILL'); // the browser force-kills a host when it closes
  assert(await waitForEngine(enginePid, false, 8000) === true, 'no engine may survive a force-killed helper');
  await host.close();
  host = null;
});

await check('an engine crash becomes a fatal error and the host exits', async () => {
  host = await boot();
  host.send({ type: 'init', options: {} });
  const ready = await host.waitFor((message) => message.type === 'ready', 60000, 'ready');
  enginePid = ready.enginePid;
  host.send(analyse({ id: 3, fen: CRASH_FEN }));
  const fatal = await host.waitFor((message) => message.type === 'error' && message.fatal, 8000, 'fatal error');
  assert(/exited/i.test(fatal.message), `unexpected message: ${fatal.message}`);
  const exit = await host.waitForExit(6000);
  assert(exit.code === 2, `expected exit code 2, got ${JSON.stringify(exit)}`);
  assert(await waitForEngine(enginePid, false) === true, 'the crashed engine must be reaped');
  host = null;
});

await check('an engine that dies while the helper is idle is noticed and the helper exits', async () => {
  host = await boot();
  host.send({ type: 'init', options: {} });
  const ready = await host.waitFor((message) => message.type === 'ready', 60000, 'ready');
  enginePid = ready.enginePid;
  // No stdin close, no quit: the browser crashed and the engine died on its own.
  execFileSync('taskkill', ['/PID', String(enginePid), '/F'], { stdio: 'ignore' });
  const fatal = await host.waitFor((message) => message.type === 'error' && message.fatal, 8000, 'engine-exit error');
  assert(/exited/i.test(fatal.message), `unexpected message: ${fatal.message}`);
  const exit = await host.waitForExit(6000);
  assert(exit.code === 2, `expected exit code 2, got ${JSON.stringify(exit)}`);
  host = null;
});

await check('a silent engine trips the search watchdog and the host exits', async () => {
  host = await boot({ searchTimeoutMs: 1200 });
  host.send({ type: 'init', options: {} });
  const ready = await host.waitFor((message) => message.type === 'ready', 60000, 'ready');
  enginePid = ready.enginePid;
  host.send(analyse({ id: 4, fen: HANG_FEN }));
  const fatal = await host.waitFor((message) => message.type === 'error' && message.fatal, 8000, 'watchdog error');
  assert(/responding|silent/i.test(fatal.message), `unexpected message: ${fatal.message}`);
  await host.waitForExit(6000);
  assert(await waitForEngine(enginePid, false) === true, 'the wedged engine must be reaped');
  host = null;
});

await check('an oversize frame is a fatal protocol error', async () => {
  host = await boot();
  const header = Buffer.alloc(4);
  header.writeUInt32LE(9 * 1024 * 1024, 0);
  host.sendRaw(header);
  const fatal = await host.waitFor((message) => message.type === 'error' && message.fatal, 6000, 'fatal protocol error');
  assert(/protocol error/i.test(fatal.message), `unexpected message: ${fatal.message}`);
  await host.waitForExit(6000);
  host = null;
});

await check('an unparsable frame is a fatal protocol error', async () => {
  host = await boot();
  const payload = Buffer.from('{this is not json', 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  host.sendRaw(Buffer.concat([header, payload]));
  const fatal = await host.waitFor((message) => message.type === 'error' && message.fatal, 6000, 'fatal protocol error');
  assert(/invalid JSON/i.test(fatal.message), `unexpected message: ${fatal.message}`);
  await host.waitForExit(6000);
  host = null;
});

await check('a missing engine configuration fails loudly instead of pretending to work', async () => {
  host = await boot({ enginePath: null });
  const hello = host.state.messages.find((message) => message.type === 'hello');
  assert(hello.engineConfigured === false, 'hello must report the missing engine');
  host.send({ type: 'init', options: {} });
  const fatal = await host.waitFor((message) => message.type === 'error' && message.fatal, 6000, 'fatal error');
  assert(/no Stockfish executable is configured/i.test(fatal.message), `unexpected message: ${fatal.message}`);
  await host.waitForExit(6000);
  host = null;
});

await check('a configured file that cannot be executed fails instead of hanging the review', async () => {
  host = await boot({ enginePath: path.join(root, 'native', 'host', 'ChessReviewHost.cs') });
  host.send({ type: 'init', options: {} });
  const fatal = await host.waitFor((message) => message.type === 'error' && message.fatal, 20000, 'fatal error');
  assert(/could not start/i.test(fatal.message), `unexpected message: ${fatal.message}`);
  await host.waitForExit(6000);
  host = null;
});

// Reference the unused NOMOVE_FEN scenario so it stays documented: the host must pass "(none)"
// through as an empty bestmove, which the extension adapter maps to `bestmove: null`.
await check('a "(none)" bestmove is passed through as an empty move', async () => {
  host = await boot();
  host.send({ type: 'init', options: {} });
  await host.waitFor((message) => message.type === 'ready', 60000, 'ready');
  host.send(analyse({ id: 11, fen: NOMOVE_FEN, depth: 3 }));
  const result = await host.waitFor((message) => message.type === 'bestmove' && message.id === 11, 10000, 'bestmove');
  assert(result.bestmove === '', `expected an empty bestmove, got ${JSON.stringify(result.bestmove)}`);
  await host.close();
  host = null;
});

/* ---------------- Report ---------------- */

if (host) { try { await host.close(); } catch { /* already gone */ } }

const failed = results.filter((result) => !result.ok);
console.log(`\n[native-host-smoke] ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('  failures:');
  for (const failure of failed) console.log(`    - ${failure.name}: ${failure.error}`);
}
try {
  if (!keep) await fs.rm(buildDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch { /* a stuck process may still hold a handle; not worth failing the report over */ }
process.exit(failed.length ? 1 : 0);