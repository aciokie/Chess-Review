import test from 'node:test';
import assert from 'node:assert/strict';
import {app,loadGame,branch} from './helpers/app.mjs';

// Authored material-offer fixtures with synthetic scores; no human precision claim.
function fixture(t,build,color) {
  const a=app(t);a.state.settings.enginePath=build;
  const black=color==='b',fen=black?'k2q4/8/8/8/8/4P3/8/7K b - - 0 1':'7k/8/4p3/8/8/8/8/K2Q4 w - - 0 1';
  const move=black?'d8d4':'d1d5',top=black?'d8e8':'d1e1';
  const S=loadGame(a,`[SetUp "1"]\n[FEN "${fen}"]\n\n${black?'1... Qd4':'1. Qd5'}`);
  S.bests[0]={bestmove:top,score:{cp:0},lines:[
    {multipv:1,depth:16,bound:'exact',pv:top,score:{cp:0}},
    {multipv:2,depth:16,bound:'exact',pv:move,score:{cp:0}},
  ]};
  return {a,S,move,top};
}
const invalid=[
  ['lower bound',root=>root.lines[1].bound='lowerbound'],
  ['upper bound',root=>root.lines[1].bound='upperbound'],
  ['stale depth',root=>root.lines[1].depth=15],
  ['missing bound',root=>delete root.lines[1].bound],
  ['missing depth',root=>delete root.lines[1].depth],
  ['invalid rank',root=>root.lines[1].multipv=1],
  ['missing rank',root=>delete root.lines[1].multipv],
  ['zero depth',root=>{root.lines[0].depth=0;root.lines[1].depth=0;}],
  ['mismatched top',root=>root.bestmove='a1a1'],
  ['illegal top',root=>{root.bestmove='a1a1';root.lines[0].pv='a1a1';}],
];
for(const build of ['nnue','sf19lite'])for(const color of ['w','b']) {
  test(`${build} ${color}: invalid used evidence cannot award Brilliant or a variation grade`,t=>{
    const {a,S}=fixture(t,build,color),original=structuredClone(S.bests[0]);
    a.call('computeDerived');assert.equal(S.classif[1],'brilliant');
    for(const [label,mutate] of invalid) {
      S.bests[0]=structuredClone(original);mutate(S.bests[0]);a.call('computeDerived');
      assert.equal(S.classif[1],null,label);assert.equal(S.moveGrades[1],null,label);
      const saved=JSON.stringify({bests:S.bests,evals:S.evals,classif:S.classif,grades:S.moveGrades,acc:S.acc,elo:S.accElo});
      const v=branch(a);a.call('classifyVariationMoves');assert.equal(v.positions[1].classif,null,label);
      assert.equal(JSON.stringify({bests:S.bests,evals:S.evals,classif:S.classif,grades:S.moveGrades,acc:S.acc,elo:S.accElo}),saved);
      S.analysisMode=false;S.variation=null;
    }
  });
  test(`${build} ${color}: paired decisions and unused lines retain their existing results`,t=>{
    const {a,S,top}=fixture(t,build,color);
    S.bests[0].playedScore={cp:0};a.call('computeDerived');
    const saved=JSON.stringify({classif:S.classif,grades:S.moveGrades,acc:S.acc,elo:S.accElo});
    S.bests[0].lines[1].bound='upperbound';S.bests[0].lines[1].depth=15;a.call('computeDerived');
    assert.equal(JSON.stringify({classif:S.classif,grades:S.moveGrades,acc:S.acc,elo:S.accElo}),saved);
    delete S.bests[0].playedScore;
    S.bests[0].lines=[{multipv:1,depth:16,bound:'exact',pv:top,score:{cp:0}},
      {multipv:2,depth:15,bound:'upperbound',pv:color==='w'?'d1f1':'d8f8',score:{cp:-300}}];
    a.call('computeDerived');assert.equal(S.classif[1],'brilliant','unused stale line must not suppress independent child evidence');
  });
}
