import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { args, integer, hashFile, json, save } from './io.mjs';

// Bounded, refreshable validation dataset built from the official Lichess CC0 monthly exports
// (https://database.lichess.org/). The heavyweight sample lives under the git-ignored
// calibration-runs/ tree; only the small provenance lock (tools/calibration-experiments/dataset-lock.json)
// is committed. A scheduled workflow runs this every ~30 days: it checks the published file list,
// does nothing when the newest month is already held, and otherwise rebuilds the sample and lock.
export const LIST_URL = 'https://database.lichess.org/standard/list.txt';
export const SUMS_URL = 'https://database.lichess.org/standard/sha256sums.txt';
export const DEFAULT_CADENCE_DAYS = 30;

// Newest-first unique months found in a published file list.
export function parseMonths(listText) {
  const found = [...String(listText).matchAll(/lichess_db_standard_rated_(\d{4}-\d{2})\.pgn\.zst/g)].map(m => m[1]);
  return [...new Set(found)].sort().reverse();
}
export function newestMonth(listText) { return parseMonths(listText)[0] || null; }

// The published SHA-256 for one month's FULL archive. Recorded as provenance; the bounded sampler
// verifies the frames it actually reads, not the whole archive.
export function archiveChecksum(sumsText, month) {
  const line = String(sumsText).split('\n').find(l => l.includes(`lichess_db_standard_rated_${month}.pgn.zst`));
  const m = line && /^([a-f0-9]{64})\s/.exec(line.trim());
  return m ? m[1] : null;
}

// Decide what to do with the lock given the newest published month.
//   current  -> newest month already held (or the check ran again inside the cadence)
//   update   -> a newer month is available (or --force / no sample yet)
//   unknown  -> the published list could not be read
export function decideUpdate(lock, newest, { force = false, cadenceDays = DEFAULT_CADENCE_DAYS, now = Date.now() } = {}) {
  if (!newest) return { action: 'unknown', reason: 'no published months found' };
  const current = lock?.sample?.month || null;
  if (current === newest && !force) return { action: 'current', reason: `already at newest month ${newest}` };
  if (!force && current && lock?.check?.checkedAt) {
    const ageDays = (now - Date.parse(lock.check.checkedAt)) / 86400000;
    if (current > newest && ageDays < cadenceDays) return { action: 'current', reason: `checked ${ageDays.toFixed(1)}d ago; newest month unchanged` };
  }
  return { action: 'update', reason: current ? `newest published month ${newest} (have ${current})` : `no sample yet; newest ${newest}` };
}

function withCheck(lock, { newestMonth: month, checkedAt, result, reason }) {
  return { ...lock, check: { checkedAt, newestMonth: month, result, reason } };
}
async function fetchText(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw Error(`${url} HTTP ${response.status}`);
  return response.text();
}
async function exists(file) { try { await access(file); return true; } catch { return false; } }
// Reuse the tested bounded sampler: download evenly spaced compressed frames + per-frame SHA-256,
// rank with seeded reservoirs, and freeze train/validation/test splits per rating band.
async function runSampler(month, { out, games, windows, seed }) {
  const script = fileURLToPath(new URL('./recent-dataset.mjs', import.meta.url));
  const argv = [script, '--months', month, '--games', String(games), '--windows', String(windows), '--seed', seed, '--out', out];
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolve() : reject(Error(`recent-dataset.mjs exited with ${code}`))));
  });
}

export async function main() {
  const o = args({ lock: 'tools/calibration-experiments/dataset-lock.json', out: 'calibration-runs/validation/dataset',
    games: '2000', windows: '20', seed: 'validation-v1', 'cadence-days': String(DEFAULT_CADENCE_DAYS),
    force: false, 'check-only': false });
  const games = integer(o.games, 'games', 100, 20000), windows = integer(o.windows, 'windows', 1, 100);
  const cadenceDays = integer(o['cadence-days'], 'cadence-days', 1, 3650);
  const now = Date.now(), checkedAt = new Date(now).toISOString();

  const newest = newestMonth(await fetchText(LIST_URL));
  let lock = (await exists(o.lock)) ? await json(o.lock)
    : { schemaVersion: 1, cadenceDays, source: LIST_URL, license: 'CC0-1.0', licenseDocumentation: 'https://database.lichess.org/', sample: null };
  const decision = decideUpdate(lock, newest, { force: o.force, cadenceDays, now });
  console.log(`Validation dataset: newest published=${newest || 'none'} held=${lock?.sample?.month || 'none'} -> ${decision.action} (${decision.reason})`);

  if (decision.action === 'unknown') { await save(o.lock, withCheck(lock, { newestMonth: null, checkedAt, result: 'unknown', reason: decision.reason })); console.log('No published month found; lock left without a sample.'); process.exitCode = 1; return; }
  if (o['check-only']) {
    await save(o.lock, withCheck(lock, { newestMonth: newest, checkedAt, result: decision.action, reason: decision.reason }));
    console.log(`Check only: ${decision.action}.`); return;
  }
  if (decision.action === 'current') {
    await save(o.lock, withCheck(lock, { newestMonth: newest, checkedAt, result: 'current', reason: decision.reason }));
    console.log('No validation dataset update needed.'); return;
  }

  const url = `https://database.lichess.org/standard/lichess_db_standard_rated_${newest}.pgn.zst`;
  const archiveSha256 = archiveChecksum(await fetchText(SUMS_URL), newest);
  await runSampler(newest, { out: o.out, games, windows, seed: o.seed });
  const manifestPath = path.join(o.out, 'manifest.json'), gamesPath = path.join(o.out, 'games.jsonl');
  const manifest = await json(manifestPath);
  if (manifest.sources.length !== 1 || manifest.sources[0].month !== newest) throw Error('Sampler produced the wrong month');
  const gamesSha256 = await hashFile(gamesPath);
  if (manifest.gamesSha256 !== gamesSha256) throw Error('Sample checksum does not match its manifest');

  lock = { schemaVersion: 1, cadenceDays, source: LIST_URL, license: 'CC0-1.0', licenseDocumentation: 'https://database.lichess.org/',
    check: { checkedAt, newestMonth: newest, result: 'updated', reason: decision.reason },
    sample: { month: newest, url, archiveSha256, archiveChecksumSource: SUMS_URL, games, windows, seed: o.seed,
      dir: o.out, gamesSha256, manifestSha256: await hashFile(manifestPath), builtAt: checkedAt,
      verification: 'TLS + sampled bounded frames with per-frame SHA-256 (recent-dataset.mjs); full archive checksum recorded but not byte-verified' } };
  await save(o.lock, lock);
  console.log(`Refreshed validation sample for ${newest}: ${manifest.selectedGames} games -> ${o.out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
