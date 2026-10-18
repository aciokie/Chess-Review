import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMonths, newestMonth, archiveChecksum, decideUpdate } from '../tools/calibration/update-dataset.mjs';

const LIST = [
  'https://database.lichess.org/standard/lichess_db_standard_rated_2026-09.pgn.zst',
  'https://database.lichess.org/standard/lichess_db_standard_rated_2026-08.pgn.zst',
  'https://database.lichess.org/standard/lichess_db_standard_rated_2026-08.pgn.zst',
  'https://database.lichess.org/standard/lichess_db_standard_rated_2015-01.pgn.zst',
].join('\n');

test('parseMonths returns unique months newest first and newestMonth picks the head', () => {
  assert.deepEqual(parseMonths(LIST), ['2026-09', '2026-08', '2015-01']);
  assert.equal(newestMonth(LIST), '2026-09');
  assert.equal(newestMonth('no months here'), null);
});

test('archiveChecksum extracts the published sha256 for the requested month only', () => {
  const sums = [
    `${'a'.repeat(64)}  lichess_db_standard_rated_2026-08.pgn.zst`,
    `${'b'.repeat(64)}  lichess_db_standard_rated_2026-09.pgn.zst`,
  ].join('\n');
  assert.equal(archiveChecksum(sums, '2026-09'), 'b'.repeat(64));
  assert.equal(archiveChecksum(sums, '2026-07'), null);
});

test('decideUpdate updates when there is no sample, refreshes for a newer month, and no-ops when current', () => {
  assert.equal(decideUpdate({ sample: null }, '2026-09').action, 'update');
  assert.equal(decideUpdate({ sample: { month: '2026-08' } }, '2026-09').action, 'update');
  assert.equal(decideUpdate({ sample: { month: '2026-09' } }, '2026-09').action, 'current');
  assert.equal(decideUpdate({ sample: { month: '2026-09' } }, '2026-09', { force: true }).action, 'update');
  assert.equal(decideUpdate({ sample: { month: '2026-09' } }, null).action, 'unknown');
});

test('decideUpdate honours the cadence when the lock is ahead of the published list', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  const recent = { sample: { month: '2026-09' }, check: { checkedAt: '2026-09-20T00:00:00Z' } };
  assert.equal(decideUpdate(recent, '2026-08', { now }).action, 'current');
  const stale = { sample: { month: '2026-09' }, check: { checkedAt: '2026-08-01T00:00:00Z' } };
  assert.equal(decideUpdate(stale, '2026-08', { now }).action, 'update');
});
