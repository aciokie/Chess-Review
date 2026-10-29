import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { app, loadGame } from './helpers/app.mjs';

function review(t, build) {
  const a = app(t), S = loadGame(a, '1. e4 e5 2. Nf3 Nc6');
  a.context.__pc = JSON.parse(fs.readFileSync(new URL('../data/calibration.json', import.meta.url)));
  a.run('PUBLIC_CALIB = __pc');
  Object.assign(S.settings, { enginePath: build, engineDepth: 16, engineHash: 16, engineSkill: 20, classifyLines: 1 });
  S.activeEngineBuild = build;
  for (const name of ['renderEngineCurrent', 'renderSettings', 'resetLiveEngine', 'invalidateVariationEvals', 'writeSettings']) a.replace(name, () => {});
  return { a, S };
}

for (const build of ['sf19lite', 'sf19full', 'native19']) {
  test(`${build}: depth, hash, skill and worker changes keep a finished review`, async t => {
    const { a, S } = review(t, build);
    let restarts = 0; a.replace('scheduleReanalyze', () => restarts++);
    const key = a.call('analysisSettingsKey');
    for (const [name, value] of [['engineDepth', 8], ['engineHash', 64], ['engineSkill', 3], ['engineWorkers', 3]]) {
      await a.call('setEngineSetting', name, value);
      assert.equal(a.call('analysisSettingsKey'), key, name);
    }
    assert.equal(restarts, 0);
    assert.equal(S.activeEngineBuild, build);
  });

  test(`${build}: more annotation lines or another build are different reviews`, async t => {
    const { a } = review(t, build);
    let restarts = 0; a.replace('scheduleReanalyze', () => restarts++);
    const key = a.call('analysisSettingsKey');
    await a.call('setEngineSetting', 'classifyLines', 2);
    assert.notEqual(a.call('analysisSettingsKey'), key);
    assert.equal(restarts, 1);
  });
}

test('Stockfish 18 NNUE still re-analyzes when depth, hash or skill change', async t => {
  const { a } = review(t, 'nnue');
  let restarts = 0; a.replace('scheduleReanalyze', () => restarts++);
  const key = a.call('analysisSettingsKey');
  await a.call('setEngineSetting', 'engineHash', 64);
  assert.notEqual(a.call('analysisSettingsKey'), key);
  assert.equal(restarts, 1);
});

test('workers only restart a review that is still running', async t => {
  const { a, S } = review(t, 'nnue');
  let restarts = 0; a.replace('scheduleReanalyze', () => restarts++);
  await a.call('setEngineSetting', 'engineWorkers', 2);
  assert.equal(restarts, 0);
  S.analyzing = true; S.evalEngines = [{ buildKey: 'nnue' }];
  await a.call('setEngineSetting', 'engineWorkers', 3);
  assert.equal(restarts, 1);
});
