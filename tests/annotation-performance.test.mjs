import test from 'node:test';
import assert from 'node:assert/strict';
import {app,loadGame,branch} from './helpers/app.mjs';

test('missing and ineligible scoring evidence does not run sacrifice searches',t=>{
  const a=app(t),S=loadGame(a,'1. e4 e5 2. Nf3 Nc6');
  let calls=0;a.replace('isSacrifice',()=>{calls++;return false;});
  S.evals.fill(null);S.bests.fill(null);a.call('computeDerived');
  assert.equal(calls,0);assert.ok(S.classif.every(c=>c===null));
  loadGame(a,'1. e4',[{cp:0},{cp:-500}]);a.call('computeDerived');
  assert.equal(calls,0);assert.notEqual(S.classif[1],'brilliant');
});

test('eligible sacrifices are still checked, cached and reused by repeated classification',t=>{
  const a=app(t),S=loadGame(a,'[SetUp "1"]\n[FEN "7k/8/4p3/8/8/8/8/K2Q4 w - - 0 1"]\n\n1. Qd5');
  const check=a.run('isSacrifice');let calls=0;a.replace('isSacrifice',m=>{calls++;return check(m);});
  a.call('computeDerived');assert.equal(S.classif[1],'brilliant');assert.equal(calls,1);
  const before=JSON.stringify([S.acc,S.counts,S.moveGrades]);a.call('computeDerived');
  assert.equal(calls,1);assert.equal(JSON.stringify([S.acc,S.counts,S.moveGrades]),before);
  const v=branch(a);a.call('classifyVariationMoves');assert.equal(v.positions[1].classif,'brilliant');
});
