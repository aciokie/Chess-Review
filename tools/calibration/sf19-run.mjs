// Resumable driver for regenerating the SF19 rating evidence at a new search budget.
//
// The evidence behind context.sf19 and movesOnly.sf19 comes from ~85k engine searches with the
// pinned SF19 Lite WASM (tools/calibration-experiments/analyze-games.mjs, cold single-thread Hash 32
// searches). That is hours of CPU, so this driver makes the work chunked and restart-safe:
//
//   node tools/calibration/sf19-run.mjs prepare      # dataset + cohort ids from the bundled data
//   node tools/calibration/sf19-run.mjs status      # coverage, rate and remaining time
//   node tools/calibration/sf19-run.mjs run --minutes 40   # one bounded chunk (repeatable)
//   node tools/calibration/sf19-run.mjs build       # evidence file (requires full coverage)
//
// Every search is written and fsynced by analyze-games before the next one starts, so a killed chunk
// only loses the search in flight. `run` bounds its child with --deadline and, as a backstop, a hard
// kill past the deadline - it never returns while the child could keep running. The JSONL cache is
// re-walked from the start on every chunk (cheap RAM lookups) which is also why chunks are bounded
// by time rather than --max-new-games: that option counts re-walked games with a JSONL cache.
import { spawn } from 'node:child_process';
import { gunzipSync, gzipSync } from 'node:zlib';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, save } from './io.mjs';
import { gamePlies, indexCache, buildSf19Evidence, verifySf19Evidence, SF19_COHORT_SCHEMA } from './sf19-evidence.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const RUN_DIR = path.join(ROOT, 'calibration-runs', 'sf19-d22');
const DATASET_DIR = path.join(RUN_DIR, 'dataset');
const CACHE_DIR = path.join(RUN_DIR, 'cache');
const IDS_FILE = path.join(RUN_DIR, 'cohort-ids.json');
const STATUS_FILE = path.join(RUN_DIR, 'status.json');
const COHORT_FILE = path.join(ROOT, 'tools', 'calibration', 'sf19-cohort.json');
const DATASET_GZ = path.join(ROOT, 'tools', 'calibration', 'public', 'dataset.json.gz');
export const ENGINE = 'engine/stockfish-19-lite-single.js';
export const DEPTH = 22;
export const WORKERS = 4;
// The published evidence's 20k-node searches, deduplicated by position: the cache keys on
// (history, played), so games share identical openings. Undeduplicated lookups were 84,148
// (52,239 best + 31,909 restricted); the distinct searches were 48,535 best + 30,407 restricted.
// The depth-22 top rate moves the restricted subtotal a little; the best subtotal is exact.
export const REFERENCE_BEST_SEARCHES = 48535;
export const REFERENCE_RESTRICTED_SEARCHES = 30407;
export const REFERENCE_SEARCHES = REFERENCE_BEST_SEARCHES + REFERENCE_RESTRICTED_SEARCHES;

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const readJsonGz = async (file) => JSON.parse(gunzipSync(await readFile(file)));

export async function prepare() {
  const games = await readJsonGz(DATASET_GZ);
  const lines = games.map((game) => JSON.stringify(game)).join('\n') + '\n';
  const cohort = await readJson(COHORT_FILE);
  if (cohort.schema !== SF19_COHORT_SCHEMA) throw Error('Cohort contract missing');
  const ids = [...new Set(cohort.sides.map((side) => side.gameId))];
  const manifest = { schemaVersion: 2, generatedAt: new Date().toISOString(),
    sources: [{ url: 'tools/calibration/public/dataset.json.gz (bundled public calibration dataset)' }],
    license: 'CC0-1.0', licenseDocumentation: 'https://database.lichess.org/',
    gamesSha256: hash(lines), games: games.length, seed: 'public-dataset-v1', category: 'blitz',
    selection: `analyze-games --game-ids selects the ${ids.length} cohort games of tools/calibration/sf19-cohort.json` };
  // Refuse to overwrite a frozen dataset whose bytes differ (the run binding would change).
  try {
    const previous = await readJson(path.join(DATASET_DIR, 'manifest.json'));
    const current = await readFile(path.join(DATASET_DIR, 'games.jsonl'), 'utf8');
    if (previous.gamesSha256 !== hash(current) || hash(current) !== manifest.gamesSha256) throw Error('A different dataset is already prepared; delete ' + DATASET_DIR + ' to rebuild it');
    console.log('dataset already prepared:', previous.games, 'games');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(DATASET_DIR, { recursive: true });
    await writeFile(path.join(DATASET_DIR, 'games.jsonl'), lines);
    await save(path.join(DATASET_DIR, 'manifest.json'), manifest);
    console.log('dataset prepared:', games.length, 'games ->', path.relative(ROOT, DATASET_DIR));
  }
  try {
    const previous = await readJson(IDS_FILE);
    if (JSON.stringify(previous) !== JSON.stringify(ids)) throw Error('A different cohort ids file exists; delete ' + IDS_FILE + ' to rebuild it');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await save(IDS_FILE, ids);
    console.log('cohort ids prepared:', ids.length, 'games ->', path.relative(ROOT, IDS_FILE));
  }
}

async function loadRun() {
  const cohort = await readJson(COHORT_FILE);
  let gamesJson = null;
  try { gamesJson = await readFile(path.join(DATASET_DIR, 'games.jsonl'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') throw Error('run directory not prepared yet: node tools/calibration/sf19-run.mjs prepare'); throw error; }
  const games = gamesJson.trim().split('\n').map(JSON.parse);
  const byId = new Map(games.map((game) => [game.id, game]));
  let cache = null, rows = 0;
  try {
    const raw = await readFile(path.join(CACHE_DIR, 'evaluations.jsonl'), 'utf8');
    const parsed = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    cache = indexCache(parsed);
    rows = parsed.length;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    cache = indexCache([]);
  }
  return { cohort, games, byId, cache, rows };
}

/** How much of the cohort's search work is present in the cache. */
export async function status() {
  const { cohort, byId, cache, rows } = await loadRun();
  let plies = 0, best = 0, restricted = 0, missing = 0, sidesComplete = 0;
  const distinctBest = new Set(), distinctRestricted = new Set();
  for (const side of cohort.sides) {
    const game = byId.get(side.gameId);
    if (!game) throw Error('Cohort game missing from the prepared dataset: ' + side.gameId);
    let complete = true;
    for (const ply of gamePlies(game.moves)) {
      if (ply.color !== side.color) continue;
      plies++;
      const bestRow = cache.get(ply.history);
      if (bestRow) { best++; distinctBest.add(JSON.stringify([ply.history, null])); }
      else { complete = false; missing++; continue; }
      if (bestRow.bestmove !== ply.played) {
        if (cache.get(ply.history, ply.played)) { restricted++; distinctRestricted.add(JSON.stringify([ply.history, ply.played])); }
        else { complete = false; missing++; }
      }
    }
    if (complete) sidesComplete++;
  }
  const searches = best + restricted;
  const report = { rows, plies, best, restricted, searches, missing, sidesComplete, sides: cohort.sides.length,
    distinctBest: distinctBest.size, distinctRestricted: distinctRestricted.size,
    distinctTotal: distinctBest.size + distinctRestricted.size,
    referenceBest: REFERENCE_BEST_SEARCHES, referenceRestricted: REFERENCE_RESTRICTED_SEARCHES, referenceSearches: REFERENCE_SEARCHES,
    complete: missing === 0 };
  try {
    const progress = await readJson(path.join(CACHE_DIR, 'progress.json'));
    report.lastChunk = { pid: progress.pid, done: progress.done, total: progress.total, newSearches: progress.newSearches,
      elapsedSeconds: Math.round(progress.elapsedSeconds), updatedAt: progress.updatedAt,
      alive: isAlive(progress.pid) };
  } catch { /* no chunk has run yet */ }
  try { report.past = await readJson(STATUS_FILE); } catch { /* first status */ }
  return report;
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function printStatus(report) {
  console.log(`cohort: ${report.sidesComplete}/${report.sides} sides complete | searches performed: ${report.rows}`);
  console.log(`distinct coverage: best ${report.distinctBest}/${report.referenceBest}, ` +
    `restricted ${report.distinctRestricted}/~${report.referenceRestricted} (20k reference; the depth-22 top rate moves it slightly)`);
  console.log(`lookups still missing: ${report.missing} of ${report.plies} plies' worth`);
  if (report.lastChunk) {
    console.log(`last chunk: pid ${report.lastChunk.pid}${report.lastChunk.alive ? ' (still running)' : ''}, ` +
      `${report.lastChunk.newSearches} new searches, ${report.lastChunk.elapsedSeconds}s, updated ${report.lastChunk.updatedAt}`);
  }
  if (report.past?.sessions) {
    const past = report.past;
    console.log(`sessions so far: ${past.sessions}, searches performed across them: ${past.searchesDone}`);
    // The cumulative rate is the honest one: a short chunk also pays the cache re-walk.
    const elapsed = past.elapsedSecondsTotal || past.lastElapsedSeconds || 0;
    const rate = elapsed > 0 ? past.searchesDone / elapsed : null;
    if (rate) {
      const remaining = Math.max(0, REFERENCE_SEARCHES - report.rows);
      const hours = remaining / rate / 3600;
      console.log(`measured rate: ${rate.toFixed(2)} searches/s (cumulative) -> estimated remaining: ${hours.toFixed(1)} h ` +
        `(${remaining} distinct-reference searches left; actual tails may differ)`);
    }
  }
  if (report.complete) console.log('COVERAGE COMPLETE - run `build` to write the evidence file');
}

const LOCK_FILE = () => path.join(CACHE_DIR, '.chunk.lock');

/** One bounded chunk: run analyze-games with the pinned engine until the deadline, then hard-stop it. */
export async function run({ minutes = 40, workers = WORKERS } = {}) {
  const report = await status();
  if (report.lastChunk?.alive) throw Error(`a chunk is already running (pid ${report.lastChunk.pid}); wait for it or kill it first`);
  // A lock of the driver's own: two chunks writing one cache would duplicate work and race the
  // fsync per search, and progress.json only appears after a first completed game.
  try {
    const lock = await readJson(LOCK_FILE());
    if (isAlive(lock.pid)) throw Error(`a chunk is already running (driver pid ${lock.pid}); wait for it or kill it first`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (report.complete) { console.log('coverage already complete; nothing to do'); return report; }
  await mkdir(CACHE_DIR, { recursive: true });
  await save(LOCK_FILE(), { pid: process.pid, startedAt: new Date().toISOString(), minutes });
  const deadline = new Date(Date.now() + minutes * 60000);
  const args = [path.join(ROOT, 'tools', 'calibration-experiments', 'analyze-games.mjs'),
    '--dataset', DATASET_DIR, '--out', CACHE_DIR, '--engine', ENGINE,
    '--depth', String(DEPTH), '--workers', String(workers), '--game-ids', IDS_FILE,
    '--deadline', deadline.toISOString()];
  console.log(`chunk: ${minutes} min, ${workers} workers, depth ${DEPTH}, until ${deadline.toISOString()}`);
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  const startedAt = Date.now();
  const softTimer = setTimeout(() => { console.log('chunk: deadline reached, asking the tool to stop'); child.kill('SIGINT'); },
    deadline - Date.now() + 30000);
  const hardTimer = setTimeout(() => { console.log('chunk: hard stop'); child.kill(); }, deadline - Date.now() + 120000);
  let code;
  try {
    code = await new Promise((resolve) => child.on('exit', (exitCode) => resolve(exitCode)));
  } finally {
    clearTimeout(softTimer); clearTimeout(hardTimer);
    try { await rm(LOCK_FILE(), { force: true }); } catch { /* a stale lock is only a hint */ }
  }
  const after = await status();
  const sessions = (after.past?.sessions || 0) + 1;
  const rowsDone = Math.max(0, after.rows - report.rows);
  const searchesDone = (after.past?.searchesDone || 0) + rowsDone;
  const lastElapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  await save(STATUS_FILE, { schemaVersion: 1, updatedAt: new Date().toISOString(), sessions, searchesDone,
    lastMinutes: minutes, lastExitCode: code, lastRowsDone: rowsDone, lastElapsedSeconds,
    elapsedSecondsTotal: (after.past?.elapsedSecondsTotal || 0) + lastElapsedSeconds });
  console.log(`chunk finished (exit ${code}) after ${Math.round((Date.now() - startedAt) / 1000)}s`);
  printStatus(after);
  return after;
}

/** Assemble the public evidence file from a fully covered cache. */
export async function build({ out = path.join(RUN_DIR, 'evidence.json.gz') } = {}) {
  const { cohort, games, cache } = await loadRun();
  const report = await status();
  if (!report.complete) throw Error(`search cache is not complete (${report.missing} lookups missing); run more chunks`);
  const runManifest = await readJson(path.join(CACHE_DIR, 'manifest.json'));
  const config = runManifest.binding?.engineConfig;
  if (!config) throw Error('run manifest has no engine configuration');
  const evidence = buildSf19Evidence({ games, cohort, cache, config });
  const summary = verifySf19Evidence(evidence, cohort, { games });
  const json = JSON.stringify(evidence);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, gzipSync(json));
  const bytes = await readFile(out);
  console.log(`evidence written: ${path.relative(ROOT, out)} (${bytes.length} bytes, sha256 ${createHash('sha256').update(bytes).digest('hex')})`);
  console.log(`verified: ${JSON.stringify(summary)}`);
  console.log(`plain sha256: ${hash(json)}`);
  return { summary, out };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const option = (name, fallback) => { const index = rest.indexOf('--' + name); return index >= 0 && rest[index + 1] ? rest[index + 1] : fallback; };
  if (command === 'prepare') await prepare();
  else if (command === 'status') printStatus(await status());
  else if (command === 'run') printStatus(await run({ minutes: Number(option('minutes', 40)), workers: Number(option('workers', WORKERS)) }));
  else if (command === 'build') await build({ out: option('out', path.join(RUN_DIR, 'evidence.json.gz')) });
  else {
    console.log('usage: node tools/calibration/sf19-run.mjs prepare|status|run [--minutes N] [--workers N]|build [--out file]');
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
