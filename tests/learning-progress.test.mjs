import test from 'node:test';
import assert from 'node:assert/strict';
import {ProgressStore, normalizeProgress, PROGRESS_KEY, recordPuzzle, progressTotals, ChallengeClock, challengeResult} from '../lib/learning/progress.js';
const memory=()=>{const values={};return {values,async get(key){return {[key]:structuredClone(values[key])};},async set(data){Object.assign(values,structuredClone(data));}};};
test('unique solves, repeats, assistance and struggles remain distinct across reloads',async()=>{
  const storage=memory(),store=new ProgressStore(storage);
  await store.load();
  await store.update(p=>{recordPuzzle(p,'a',{completed:true,assisted:true});recordPuzzle(p,'a',{completed:true,assisted:false});recordPuzzle(p,'a',{completed:true,assisted:false});recordPuzzle(p,'b',{completed:false,skipped:true,mistakes:2});p.resume={kind:'puzzle',id:'c',step:2,assisted:true};});
  const reopened=new ProgressStore(storage);await reopened.load();
  assert.deepEqual(progressTotals(reopened.value),{unique:1,repeats:1,assisted:1,lessons:0,openings:0});
  assert.equal(reopened.value.puzzles.a.struggled,false);assert.equal(reopened.value.puzzles.b.struggled,true);
  assert.equal(reopened.value.resume.step,2);assert.ok(storage.values[PROGRESS_KEY]);
});
test('shared lock and reread preserve progress written concurrently from two review tabs',async()=>{
  let queue=Promise.resolve();const locks={request(name,task){const next=queue.then(task);queue=next.catch(()=>{});return next;}};
  const storage=memory(),a=new ProgressStore(storage,locks),b=new ProgressStore(storage,locks);
  await Promise.all([a.load(),b.load()]);
  await Promise.all([a.update(p=>{p.lessons.fork={status:'completed'};}),b.update(p=>{p.openings.italian={status:'in progress'};}),a.update(p=>recordPuzzle(p,'first',{completed:true}))]);
  await b.load();assert.equal(b.value.lessons.fork.status,'completed');assert.equal(b.value.openings.italian.status,'in progress');assert.equal(b.value.puzzles.first.clean,1);
});
test('storage failures are exposed and do not report a false saved completion',async()=>{
  const store=new ProgressStore({async get(){return {};},async set(){throw Error('Quota');}});
  await store.load();await assert.rejects(store.update(p=>recordPuzzle(p,'x',{completed:true})),/Quota/);await store.queue;
  assert.ok(store.error);assert.equal(store.value.puzzles.x,undefined);assert.deepEqual(normalizeProgress({schema:22}),normalizeProgress(null));
});
test('all durations count thinking time while excluding time before readiness and during validation',()=>{
  for(const seconds of [60,300,600]){
    let now=0;const clock=new ChallengeClock(seconds,()=>now);
    now=100000;assert.equal(clock.remaining(),seconds*1000);assert.equal(clock.expired(),false);
    clock.ready();now+=1500;assert.equal(clock.remaining(),seconds*1000-1500);
    clock.pause();now+=45000;assert.equal(clock.remaining(),seconds*1000-1500);
    clock.ready();clock.ready();now+=seconds*1000;assert.equal(clock.remaining(),0);assert.equal(clock.expired(),true);
  }
});
test('challenge statistics exclude assisted completions from score and compute submitted-move accuracy',()=>{
  const result=challengeResult({duration:60,solved:4,assisted:2,mistakes:3,skips:1,correctMoves:9,missed:['a','b','a']},3);
  assert.equal(result.solved,4);assert.equal(result.best,4);assert.equal(result.personalBest,true);assert.equal(result.accuracy,75);assert.deepEqual(result.missed,['a','b']);
});
