import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Chess} from '../lib/chess.js';
import {CONCEPT_GROUPS,CONCEPT_ITEMS,DEFAULT_CONCEPT_GROUPS,normalizeConceptGroups,studyEnabled,FAST_CONCEPT_REMOVALS,curateFastFindings,conceptEnabled,isFastSelection} from '../lib/concepts/controls.js';
import {FLAGS} from '../lib/concepts/profile.js';
import {startConceptRun,runConceptStage,supplementalConcepts,conceptRunSummary,DETECTORS,integrationInput} from '../lib/concepts/runtime.js';
import {ConceptSession,conceptKey} from '../lib/concepts/session.js';
import {coachReply} from '../lib/coach-insights.js';
import {app,loadGame,branch} from './helpers/app.mjs';
const p=JSON.parse(await readFile(new URL('../lib/concepts/integration-provenance.json',import.meta.url)));
const initial=new Chess().fen();
const input={fen:initial,move:'e2e4',history:{fen:initial,moves:[]},conceptGroups:DEFAULT_CONCEPT_GROUPS};
const run=input=>{const job=startConceptRun(input,p);supplementalConcepts(job,'fast');for(const d of DETECTORS)runConceptStage(job,d);supplementalConcepts(job,'deep');return conceptRunSummary(job);};

test('cost groups cover every implemented stage and legacy flag without enabling disabled searches',()=>{
 assert.deepEqual(normalizeConceptGroups(['tactics','features','bogus','features']),['features','tactics']);
 for(const d of DETECTORS)assert.equal(CONCEPT_GROUPS.filter(g=>g.studies.includes(d.study)).length,1,d.study);
 for(const flag of FLAGS)assert.equal(CONCEPT_GROUPS.filter(g=>g.flags.includes(flag)).length,1,flag);
 const off=integrationInput({...input,conceptGroups:[]});
 for(const d of DETECTORS)for(const flag of d.flags)assert.equal(off[flag],false,flag);
 const defaultInput=integrationInput(input);
 assert.equal(defaultInput.maxTacticNodes,1);assert.equal(defaultInput.mateDepth,0);assert.equal(defaultInput.forcingTempoTags,false);
 const all=integrationInput({...input,conceptGroups:CONCEPT_GROUPS.map(g=>g.id)});
 assert.equal(all.maxTacticNodes,4000);assert.equal(all.mateDepth,3);assert.equal(all.forcingTempoTags,true);
 for(const id of ['minor-development','repetition-claim','fifty-move-claim','simplification-material-loss'])assert.equal(conceptEnabled(input,id),true,id);
 assert.equal(studyEnabled(input,'E096'),false);assert.equal(studyEnabled(input,'E086'),false);
 const history={...input,conceptGroups:[...DEFAULT_CONCEPT_GROUPS,'history']};assert.equal(studyEnabled(history,'E096'),true);assert.equal(isFastSelection(history),true);
 for(const item of CONCEPT_ITEMS.filter(i=>i.studies.includes('E091')))assert.equal(item.group,'immediate');
});

test('fast pipeline returns supported changes without running disabled expensive stages',()=>{
 const r=run(input);assert.deepEqual(r.errors,[]);assert.equal(r.change.last.uci,'e2e4');
 assert.ok(r.findings.some(f=>f.study==='E083'));assert.ok(r.disabled);
 assert.ok(r.stages.every(s=>studyEnabled(input,s.detector)));
 assert.ok(!r.stages.some(s=>s.detector==='E143'||s.detector==='E100'||s.detector==='E201-panel'));
 assert.equal(r.stages.filter(s=>s.detector==='E209').length,1,'Actual-turn mate scan is already covered by E201');
 assert.ok(!r.stages.some(s=>s.detector==='E237'),'Ordinary clocks cannot emit a final-ply deadline');
 assert.ok(!r.stages.some(s=>['E086','E096'].includes(s.detector)),'History proof searches are opt-in');
 assert.ok(r.stages.some(s=>s.detector==='E091'),'Keep short exchange proofs in the default');
 const off=run({...input,conceptGroups:[]});assert.deepEqual(off.stages,[]);assert.deepEqual(off.errors,[]);assert.equal(off.change,undefined);
 assert.ok(!off.findings.some(f=>f.study));assert.ok(!off.findings.some(f=>f.event==='legal-input'||f.event==='pawn-phalanx'));
});

test('Fast still attempts the deadline inspector at its exact clock prerequisite',()=>{
 const fen='7k/p7/5KQ1/8/8/8/8/8 b - - 149 1';
 // The legacy parent treats a claimable fifty-move draw as terminal. Exercise
 // the supplemental gate directly; missing history must still abstain.
 const job={input:{fen,move:'a7a6',conceptGroups:['immediate']},result:{events:[]},stages:[],errors:[]};
 supplementalConcepts(job,'fast');
 assert.ok(job.stages.some(s=>s.detector==='E237'&&s.status==='unavailable'));assert.deepEqual(job.errors,[]);
});

test('fast successor mate warnings retain ownership for both player colors',()=>{
 for(const [fen,move,player] of [['7k/p7/5KQ1/8/8/8/8/8 b - - 0 1','a7a6','w'],['8/8/8/8/8/5kq1/P7/7K w - - 0 1','a2a3','b']]){
  const r=run({fen,move,history:{fen,moves:[]},conceptGroups:DEFAULT_CONCEPT_GROUPS});assert.deepEqual(r.errors,[]);
  assert.match(coachReply(r.findings,{player,mover:player==='w'?'b':'w',change:r.change}).items[0].text,/You can now play .* for mate in one/);
 }
});

test('demand session never queues unvisited moves and preempts stale foreground work',()=>{
 const workers=[],timers=new Map();let id=0;
 const s=new ConceptSession({demandOnly:true,worker:()=>{const w={posts:[],postMessage(d){this.posts.push(d);},terminate(){this.stopped=true;}};workers.push(w);return w;},setTimer:fn=>{timers.set(++id,fn);return id;},clearTimer:id=>timers.delete(id)});
 const next={...input,move:'d2d4'};s.configure([input,next],true);assert.equal(workers.length,0);assert.equal(s.queue.length,0);
 const key=s.include(input,true),old=workers[0];
 old.onmessage({data:{key,phase:'facts',result:{findings:[{name:'retained'}],issues:[],errors:[],unavailable:[],timeMs:2}}});
 const second=s.include(next,true);assert.ok(old.stopped);assert.equal(s.entries.get(key).status,'paused');assert.equal(workers[1].posts[0].key,second);
 old.onmessage({data:{key,phase:'complete',result:{findings:[{name:'stale'}]}}});assert.equal(s.entries.get(key).findings[0].name,'retained');
 const r={findings:[],errors:[],issues:[],unavailable:[],timeMs:3};workers[1].onmessage({data:{key:second,phase:'complete',result:r}});
 s.include(next,true);assert.equal(workers[1].posts.length,1);
 s.include(input,true);assert.equal(workers[1].posts.length,2);s.cancelSelected();assert.equal(s.active,null);assert.equal(s.queue.length,0);
 s.configure([next],true);s.include(next,true);assert.equal(s.entries.get(second).reused,true);
 const filtered={...next,conceptGroups:['features']};assert.notEqual(conceptKey(filtered),second);s.configure([filtered],true);s.include(filtered,true);assert.equal(workers.length,3);
 s.stop();
});

test('category changes persist, refresh exact cache keys, preserve perspective and rapid checkbox changes',t=>{
 const a=app(t),S=loadGame(a,'1. e4 e5 2. Nf3');a.call('computeDerived');a.call('buildUI');a.call('go',3);a.call('toggleSettings');a.dom.window.document.querySelectorAll('.set-tab')[2].click();
 const doc=a.dom.window.document;assert.ok(doc.querySelector('.concepts-panel .set-section.open'));assert.equal(doc.querySelectorAll('.concept-group-row input').length,9);
 const before=conceptKey(a.call('selectedConceptInput'));doc.querySelector('#concept-group-pawns').click();doc.querySelector('#concept-group-history').click();
 assert.ok(!S.settings.conceptGroups.includes('pawns'));assert.ok(S.settings.conceptGroups.includes('history'));assert.notEqual(conceptKey(a.call('selectedConceptInput')),before);
 assert.deepEqual(Array.from(a.writes.at(-1).settings.conceptGroups),Array.from(S.settings.conceptGroups));
 doc.querySelector('#concept-group-history').focus();a.call('renderSettings');assert.equal(doc.activeElement.id,'concept-group-history');
 const key=conceptKey(a.call('selectedConceptInput'));S.meSide='b';S.flipped=true;assert.equal(conceptKey(a.call('selectedConceptInput')),key);
 branch(a,1,1);assert.notEqual(conceptKey(a.call('selectedConceptInput')),key);
 a.call('setConceptGroups',DEFAULT_CONCEPT_GROUPS);a.call('go',3);S.analysisMode=false;S.variation=null;assert.equal(conceptKey(a.call('selectedConceptInput')),before);
});

test('real worker publishes early mate observations and completes heavy stages on the same evidence',async t=>{
 const fetch=globalThis.fetch,self=globalThis.self,messages=[];
 t.after(()=>{globalThis.fetch=fetch;globalThis.self=self;});
 globalThis.fetch=async()=>({ok:true,json:async()=>p});globalThis.self={postMessage:message=>messages.push(message)};
 await import('../lib/concepts/worker.js');
 const fen='7k/p7/5KQ1/8/8/8/8/8 b - - 0 1';
 const input={fen,move:'a7a6',history:{fen,moves:[]},conceptGroups:CONCEPT_GROUPS.map(g=>g.id)};
 await globalThis.self.onmessage({data:{key:conceptKey(input),input}});
 assert.equal(messages[0].phase,'facts');assert.equal(messages.at(-1).phase,'complete');
 assert.ok(messages[0].result.findings.some(f=>f.event==='current-mate-in-one'));
 const final=messages.at(-1).result;assert.deepEqual(final.errors,[]);assert.ok(final.stages.some(s=>s.detector==='E143'));
 assert.equal(final.disabled,null);assert.equal(final.change.last.uci,'a7a6');
 assert.equal(new Set(final.findings.map(f=>f.name+' '+f.text)).size,final.findings.length);
});

test('a queued completion yield and stale watchdog cannot clear or fail a later selected job',()=>{
 const timers=new Map(),worker={postMessage(){},terminate(){}};let id=0;
 const s=new ConceptSession({demandOnly:true,worker:()=>worker,setTimer:fn=>{timers.set(++id,fn);return id;},clearTimer:id=>timers.delete(id)});
 const next={...input,move:'d2d4'},result={findings:[],errors:[],issues:[],unavailable:[],timeMs:1};
 s.configure([input,next],true);const first=s.include(input,true),oldWatch=timers.get(s.timer);
 worker.onmessage({data:{key:first,phase:'complete',result}});const oldYield=timers.get(s.timer);
 const second=s.include(next,true),watch=s.timer;assert.equal(timers.size,1);
 oldYield();assert.equal(s.timer,watch);assert.equal(s.active,second);
 oldWatch();assert.equal(s.active,second);assert.deepEqual(s.entries.get(second).errors,[]);
 s.cancelSelected();s.entries.delete(first);s.cache.delete(first);const again=s.include(input,true);oldWatch();assert.equal(s.active,again);assert.deepEqual(s.entries.get(again).errors,[]);s.stop();
});

test('Fast retirement decisions remove filler but preserve warnings and the full inspector',()=>{
 const events=FAST_CONCEPT_REMOVALS.flatMap(r=>r.events).map(event=>({event}));
 const attacked={event:'undefended-unit-observation',context:{evidence:{target:{attackers:['f3']}}}};
 const unguarded={event:'undefended-unit-observation',context:{evidence:{target:{attackers:[]}}}};
 const meaningful=[{event:'current-mate-in-one'},{event:'pawn-chain'},attacked];
 assert.deepEqual(curateFastFindings([...events,...meaningful,unguarded],input),meaningful);
 assert.equal(curateFastFindings(events,{...input,conceptGroups:[...DEFAULT_CONCEPT_GROUPS,'tactics']}),events);
 const options=integrationInput(input);assert.equal(options.foundationTags,false);assert.equal(options.inventoryTags,false);
 const r=run(input);assert.ok(!r.findings.some(f=>events.some(e=>e.event===f.event)));
});
test('Concept settings keep excluded findings discoverable without changing research claims',t=>{
 const a=app(t);loadGame(a,'1. e4');a.call('buildUI');a.call('toggleSettings');a.dom.window.document.querySelectorAll('.set-tab')[2].click();
 const panel=a.dom.window.document.querySelector('.concepts-panel');
 assert.ok(panel.textContent.includes('Temporarily removed / not calculated'));
 for(const item of FAST_CONCEPT_REMOVALS)assert.ok(panel.textContent.includes(item.name)&&panel.textContent.includes(item.reason));
 assert.match(panel.textContent,/not changes to research acceptance/);
 assert.equal(panel.querySelectorAll('input').length,9);
});
