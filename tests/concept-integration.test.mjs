import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {isDeepStrictEqual as nodeEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {Chess} from '../lib/chess.js';
import {DETECTORS,startConceptRun,runConceptStage,supplementalConcepts,conceptRunSummary,integrationInput} from '../lib/concepts/runtime.js';
import {coachReply,coachInsights} from '../lib/coach-insights.js';
import browserAssert,{isDeepStrictEqual} from '../lib/concepts/assert.js';
import {ConceptSession,conceptKey} from '../lib/concepts/session.js';
import {app,loadGame,branch} from './helpers/app.mjs';
const p=JSON.parse(await fs.readFile(new URL('../lib/concepts/integration-provenance.json',import.meta.url)));
import {stagedParent,withConceptParent} from '../lib/concepts/stage.js';
import {INTEGRATION_FINGERPRINT} from '../lib/concepts/integration-profile.js';
const hash=text=>createHash('sha256').update(text).digest('hex');
const normal=text=>text.replaceAll('\r\n','\n');
const f=(event,text,evidence={},actor='w',extra={})=>({event,text,name:event,kind:'Bounded proof',scopes:[{occurrence:'test',scope:'Synthetic scope'}],context:{mover:'w',actor,evidence},...extra});
const inputFor=(moves,move)=>{const c=new Chess();for(const m of moves)c.move(m);return{fen:c.fen(),move,history:{fen:new Chess().fen(),moves}};};
const run=input=>{const job=startConceptRun(input,p);for(const d of DETECTORS)runConceptStage(job,d);supplementalConcepts(job);return {job,summary:conceptRunSummary(job)};};

test('promotion retains research bytes and explicit adaptation; accepted tracker and support remain separate',async()=>{
 for(const [file,expected] of Object.entries(p.runtime)) assert.equal(hash(normal(await fs.readFile(new URL('../'+file,import.meta.url),'utf8'))),expected,file);
 assert.equal(INTEGRATION_FINGERPRINT,hash(JSON.stringify({records:p.sources,runtime:p.runtime,entries:p.entries,verified:p.verified,profile:'P003-staged-4000-panels-v1'})));
 const tracker=normal(await fs.readFile(new URL('../'+p.trackerPath,import.meta.url),'utf8'));
 assert.equal(hash(tracker),p.trackerSha256);assert.equal(p.verified.length,378);assert.equal(DETECTORS.length,99);assert.equal(DETECTORS.filter(d=>d.role==='detector').length,98);assert.equal(DETECTORS.find(d=>d.study==='E140').researchStatus,'support');
 for(const [file,r]of Object.entries(p.sources)){
  const original=normal(await fs.readFile(new URL('../'+file,import.meta.url),'utf8'));
  assert.equal(hash(original),r.sha256,file);
  let adapted=original.replace(/((?:from\s*|import\s*\(\s*|import\s*)['"])([^'"]+)(['"])/g,(_,a,s,z)=>{
   if(s==='node:assert/strict'||s==='node:util')return a+'../assert.js'+z;
   const target=path.posix.normalize(path.posix.join(path.posix.dirname(file),s));
   return a+(target==='lib/chess.js'?'../../chess.js':'./'+p.sources[target].file)+z;
  });
  if(r.staged)adapted="import {stagedParent} from '../stage.js';\n"+adapted.replace(/explainMove as parent/,'explainMove as originalParent')+'\nconst parent = input => stagedParent(originalParent, input);\n';
  adapted=adapted.replace(/\n+$/,'\n');
  const production=normal(await fs.readFile(new URL('../lib/concepts/detectors/'+r.file,import.meta.url),'utf8'));
  assert.equal(production,adapted,file);assert.equal(hash(production),r.promotedSha256,file);
  assert.doesNotMatch(production,/from ['"]node:/);
 }
 assert.ok(p.inventory.filter(r=>r.study>='E221'&&r.study<='E229').every(r=>r.disposition==='support'));
 assert.ok(p.inventory.find(r=>r.study==='E269').reason.includes('private'));
 assert.ok(p.entries.filter(r=>r.researchStatus==='accepted').every(r=>['E081','E082'].includes(r.study)));
});

test('browser assertions preserve the plain-data certificate checker semantics',()=>{
 const cases=[[{a:1,b:[2,NaN]},{b:[2,NaN],a:1},true],[[,1],[undefined,1],false],[0,-0,false],[{a:undefined},{},false],[new Uint8Array([1,2]),new Uint8Array([1,3]),false],[Object.create(null),{},false]];
 for(const [a,b,expected]of cases){assert.equal(isDeepStrictEqual(a,b),expected);assert.equal(isDeepStrictEqual(a,b),nodeEqual(a,b));}
 assert.throws(()=>browserAssert.deepEqual({proof:true},{proof:false}));assert.throws(()=>browserAssert.equal(0,-0));assert.throws(()=>isDeepStrictEqual(new Map(),new Map()));
});

test('staged chain agrees with original research on events, evidence and statuses for a real opening move',async()=>{
 const input=inputFor(['e2e4','e7e5'],'g1f3');
 const {explainMove}=await import('../research/experiments/E177-queen-exchange-ending/code/ending.mjs');
 const source=explainMove(integrationInput(input));
 const {job,summary}=run(input);
 assert.deepEqual(summary.errors,[]);
 const clean=e=>{const {integrationStudy,...raw}=e;return raw;};
 assert.deepEqual(job.result.events.filter(e=>!e.integrationStudy || /^E(?:08[1-9]|09[0-9]|1[0-6][0-9]|17[0-7])$/.test(e.integrationStudy)).map(clean),source.events);
 for(const [key,value]of Object.entries(source).filter(([k])=>/Analysis$/.test(k)))assert.deepEqual(job.result[key],value,key);
 assert.ok(summary.findings.some(f=>f.study==='E083'&&f.researchStatus==='provisional'));
 assert.ok(summary.unavailable.some(x=>x.includes('orderFollowup-prerequisite')));
 assert.ok(summary.issues.some(x=>x.includes('exhausted')));
 assert.ok(summary.change?.last.uci==='g1f3');
 assert.ok(!JSON.stringify(summary).includes('"tree"'));assert.ok(!summary.findings.some(f=>f.study==='E140'));
});

test('both player colors get the real successor mate opportunity after opponent moves',()=>{
 for(const [fen,move,actor]of [['7k/p7/5KQ1/8/8/8/8/8 b - - 0 1','a7a6','w'],['8/8/8/8/8/5kq1/P7/7K w - - 0 1','a2a3','b']]){
  const input={fen,move,history:{fen,moves:[]}},job=startConceptRun(input,p);runConceptStage(job,DETECTORS.find(d=>d.study==='E085'));supplementalConcepts(job);
  const summary=conceptRunSummary(job);assert.deepEqual(summary.errors,[]);
  const reply=coachReply(summary.findings,{mover:actor==='w'?'b':'w',player:actor,change:summary.change});
  assert.match(reply.items[0].text,/You can now play .* for mate in one/);
  const risk=coachReply(summary.findings,{mover:actor==='w'?'b':'w',player:actor==='w'?'b':'w'});
  assert.match(risk.items[0].text,/Your move allows .* mate in one for your opponent/);
 }
});

test('urgency beats category, combined contact is supported, aliases and unchanged facts abstain',()=>{
 const inventory=f('material-inventory','Material: White has pieces.');
 const chain=f('pawn-chain','Pawn chain.',{},'b');
 const observation=f('undefended-unit-observation','White knight d4 has no geometric defender.',{target:{color:'w',type:'n',square:'d4',attackers:['e6']}},'w');
 const contact=f('direct-attack','Direct attack: your bishop on e6 attacks knight d4.',{piece:'b',to:'e6',targets:['d4']},'b');
 const reply=coachReply([inventory,chain,observation,contact,{...contact,name:'Attack on a piece'}],{mover:'b',player:'w'});
 assert.equal(reply.items.length,1);assert.match(reply.items[0].text,/Your opponent’s bishop on e6 now attacks the knight on d4, which has no geometric defender/);
 assert.match(reply.items[0].text,/not proof of a forced gain/);assert.ok(reply.items[0].supporting.some(f=>f.event==='undefended-unit-observation'));
 const urgent=f('current-mate-in-one','Black can mate.',{san:'Qh4#'},'b');
 const withMate=coachReply([contact,observation,urgent],{mover:'w',player:'w'});
 assert.equal(withMate.items.length,1);assert.match(withMate.items[0].text,/Your move allows Qh4#/);
 assert.deepEqual(coachReply([inventory,chain,f('legal-input','Black moved a legal piece.')],{mover:'b',player:'w'}).items,[]);
 assert.deepEqual(coachReply([urgent],{mover:'w',player:null}).items,[]);
 assert.match(coachInsights([f('inventory',"You're ready; you've moved; you'll see.")],{mover:'b',player:null})[0].text,/Black is ready; Black has moved; Black will see/);
 assert.doesNotMatch(coachInsights([f('pawn-chain','Your pawn supports your opponent’s pawn.')],{mover:'b',player:null})[0].text,/\byour\b|\byou\b/i);
});

test('pawn support removal uses actual transition and target ownership, never labels a forced gain',()=>{
 const observation=f('undefended-unit-observation','Observation',{target:{color:'b',type:'n',square:'d4',attackers:['e6']}},'w');
 const change={attackChanges:[{color:'b',target:'d4',removed:['bpc5'],added:[]}]};
 assert.equal(coachReply([observation],{mover:'b',player:'w'}).items.length,0);
 const reply=coachReply([observation],{mover:'b',player:'w',change}).items[0];
 assert.match(reply.text,/Your opponent’s knight on d4 lost pawn support/);assert.match(reply.text,/winning capture has not been established/);
 assert.match(coachReply([observation],{mover:'b',player:'b',change}).items[0].text,/Your knight/);
});

test('main Concepts switch reuses results, follows navigation/variation/perspective, keeps Settings independent',t=>{
 const a=app(t),S=loadGame(a,'1. e4 e5 2. Nf3');a.call('computeDerived');a.call('buildUI');a.call('renderReview');
 const doc=a.dom.window.document;let posts=0;
 const session=new ConceptSession({worker:()=>({postMessage(){posts++;},terminate(){}})});t.after(()=>session.stop());
 a.context.__session=session;a.run('_conceptSession=__session');a.call('setConceptEnabled',true);a.call('go',3);
 const key=conceptKey(a.call('selectedConceptInput'));
 const findings=[f('material-inventory','Inventory'),f('current-mate-in-one','Black can mate.',{san:'Qh4#'},'b')];
 session.entries.set(key,{status:'complete',findings,errors:[],issues:[],unavailable:[],timeMs:1});a.call('renderCoachPanel');
 const beforePosts=posts;assert.equal(doc.querySelectorAll('.coach-insight').length,2);
 doc.querySelector('#concept-view-reply').click();assert.equal(posts,beforePosts);assert.equal(doc.querySelectorAll('.coach-insight').length,1);assert.equal(doc.querySelector('#concept-view-reply').getAttribute('aria-pressed'),'true');assert.match(doc.querySelector('.coach-insight > p').textContent,/Your move allows/);
 S.flipped=true;a.call('renderCoachPanel');assert.match(doc.querySelector('.coach-position').textContent,/Playing White/);
 S.meSide='b';a.call('renderCoachPanel');assert.match(doc.querySelector('.coach-insight > p').textContent,/You can now play/);
 S.playerKnown=false;a.call('renderCoachPanel');assert.equal(doc.querySelectorAll('.coach-insight').length,0);assert.match(doc.querySelector('.coach-position').textContent,/identity unavailable/);
 doc.querySelector('#concept-view-all').click();assert.equal(doc.querySelectorAll('.coach-insight').length,2);assert.equal(posts,beforePosts);
 a.call('go',2);assert.doesNotMatch(doc.querySelector('.coach-insights-body').textContent,/Qh4/);session.entries.get(key).findings.push(f('check','Stale'));a.call('renderCoachPanel');assert.doesNotMatch(doc.querySelector('.coach-insights-body').textContent,/Stale/);
 branch(a,1,1);a.call('renderReview');assert.match(doc.querySelector('.coach-position').textContent,/Variation/);assert.notEqual(conceptKey(a.call('selectedConceptInput')),key);
 a.call('toggleSettings');doc.querySelectorAll('.set-tab')[2].click();assert.equal(doc.querySelector('.concepts-panel .concept-view-switch'),null);
});

test('detected identity is independent of orientation and ambiguous names stay explicit',t=>{
 const a=app(t);const w=a.call('derivePlayers',{White:'Me',Black:'Other'},{flip:true},'Me');assert.equal(w.meSide,'w');assert.equal(w.playerKnown,true);
 const b=a.call('derivePlayers',{White:'Other',Black:'Me'},{flip:false},'Me');assert.equal(b.meSide,'b');assert.equal(b.playerKnown,true);
 assert.equal(a.call('derivePlayers',{White:'Me',Black:'Me'},{},'Me').playerKnown,false);
 assert.equal(a.call('derivePlayers',{White:'A',Black:'B'},{flip:true},'').playerKnown,false);
 const saved=a.call('derivePlayers',{White:'A',Black:'B'},{myName:'B'},'A');assert.equal(saved.meSide,'b');
});

test('bounded resources and vulnerabilities preserve horizon and actual owner without duplicate mate prose',()=>{
 for(const player of ['w','b']){
  const enemy=player==='w'?'b':'w';
  const resource=f('current-bounded-mating-resource','Bounded proof',{san:'Qg7+'},player);
  const vulnerability=f('bounded-king-vulnerability','King proof',{kingSide:enemy},player);
  const items=coachReply([resource,vulnerability],{mover:enemy,player}).items;
  const immediate=f('current-mate-in-one','Mate proof',{san:'Qg7#'},player);
  assert.equal(coachReply([immediate,resource,vulnerability],{mover:enemy,player}).items.length,1);
  assert.equal(items.length,1);assert.match(items[0].text,/You can play Qg7.*three total plies/);assert.doesNotMatch(items[0].text,/best|advantage|winning material/);
  assert.match(coachReply([vulnerability],{mover:enemy,player}).items[0].text,/Your opponent’s king.*two plies/);
  assert.equal(items[0].perspective,'Your mating opportunity');
  const retained=f('retained-mate-threat','The earlier threat remains.',{},player);
  assert.equal(coachReply([retained],{mover:player,player}).items[0].perspective,'Mating threat against you');
  const risk=f('conditional-reply-mating-risks','Risk',{san:'Ra2',conditional:true},player);
  assert.match(coachReply([risk],{mover:enemy,player}).items[0].text,/Be careful with Ra2.*two further plies/);
  assert.deepEqual(coachReply([risk],{mover:enemy,player:enemy}).items,[]);
 }
});

test('share links preserve orientation without manufacturing an unknown player identity',async t=>{
 const a=app(t),S=loadGame(a,'1. e4');S.players={w:{name:'Alice'},b:{name:'Bob'}};S.flipped=true;S.meSide='w';
 let copied;Object.defineProperty(a.dom.window.navigator,'clipboard',{value:{writeText:async text=>{copied=text;}}});
 a.replace('toast',()=>{});
 S.playerKnown=false;a.call('shareGame');await Promise.resolve();
 const decode=()=>JSON.parse(Buffer.from(decodeURIComponent(copied.split('#gambit=')[1]),'base64').toString());
 assert.equal(decode().meta.flip,true);assert.equal(decode().meta.myName,'');
 S.playerKnown=true;a.call('shareGame');await Promise.resolve();assert.equal(decode().meta.myName,'Alice');
});

test('staged parent reuse requires matching flags, budgets and declared goals, and clears after failure',()=>{
 const input={...inputFor([],'e2e4'),directAttackTags:true,maxNodes:4000},base={after:'completed'},original=i=>({controls:i});
 withConceptParent(base,()=>{
  assert.equal(stagedParent(original,structuredClone(input)),base);
  for(const altered of [{...input,maxNodes:1},{...input,directAttackTags:false},{...input,objectiveTarget:'e5'},{...input,move:'d2d4'}]){
   assert.deepEqual(stagedParent(original,altered),{controls:altered});
  }
 },input);
 assert.throws(()=>withConceptParent(base,()=>{throw Error('failed stage');},input));
 assert.deepEqual(stagedParent(original,input),{controls:input});
});
