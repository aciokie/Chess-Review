import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Chess} from '../lib/chess.js';
import {DEFAULT_CONCEPT_GROUPS,CONCEPT_ITEMS,normalizeDisabledConcepts,detectorInput,studyEnabled} from '../lib/concepts/controls.js';
import {inspectFastConsequences} from '../lib/concepts/fast-consequences.js';
import {startConceptRun,runConceptStage,DETECTORS,supplementalConcepts,conceptRunSummary} from '../lib/concepts/runtime.js';
import {coachReply} from '../lib/coach-insights.js';
import {ConceptSession,conceptKey} from '../lib/concepts/session.js';
import {app,loadGame,branch} from './helpers/app.mjs';
const provenance=JSON.parse(await readFile(new URL('../lib/concepts/integration-provenance.json',import.meta.url)));
// The user's supplied example, used only for this requested implementation check.
const sans='d4 c6 Bf4 d5 e4 dxe4 Nc3 Nf6 Bc4 e6 Qe2 e3 fxe3 b5 Bb3 b4 Na4 a5 Rd1 Ba6 Bc4 Bd6 Bxd6 Qxd6 Nc5 Bxc4 Qxc4 O-O Nb7 Qc7 Nc5 Nd5 e4 Nb6 Qe2 N8d7 Nxd7 Qxd7 Nf3 Rae8 O-O f5 Ne5 Qd6 exf5 exf5 Qf3 Nd5 c3 g6 c4 Nf6 c5 Qd5 Qxd5+ Nxd5 Nxc6'.split(' ');
const board=new Chess(),initial=board.fen(),history=[],rows=[];
const run=input=>{const job=startConceptRun(input,provenance);supplementalConcepts(job,'fast');for(const d of DETECTORS)runConceptStage(job,d);supplementalConcepts(job,'deep');return conceptRunSummary(job);};
for(const san of sans){const m=board.moves({verbose:true}).find(m=>m.san===san),input={fen:board.fen(),move:m.from+m.to,history:{fen:initial,moves:[...history]},conceptGroups:DEFAULT_CONCEPT_GROUPS};rows.push({input,san,mover:m.color});board.move(input.move);history.push(input.move);}
const row=ply=>{const r=rows[ply-1];r.result||=run(r.input);return r;};
const answer=(ply,player='w')=>{const r=row(ply);return coachReply(r.result.findings,{input:r.input,player,mover:r.mover,change:r.result.change});};
const text=(ply,player)=>answer(ply,player).items.map(i=>i.text).join(' ');

test('Example knight jump explains the queen/rook fork, its persistence, and the passed-up pattern',()=>{
 assert.match(text(32),/opponent’s knight on d5.*Nxe3.*queen on c4.*rook on d1/);
 assert.match(text(32),/You move first/);
 assert.match(text(33),/pawn on e4 attacks the knight, but.*knight on d5 is still able to jump to e3.*queen on c4.*rook on d1/);
 assert.equal((text(33).match(/attacks the knight/g)||[]).length,1);
 assert.match(text(34),/opponent chooses Nb6 instead of the available Ne3.*your queen on c4.*your rook on d1/);
 assert.match(text(34),/knight on b6 instead attacks your queen/);
 assert.match(text(34),/Whether the fork wins material still depends on the replies/);
 assert.match(text(32,'b'),/Your knight on d5.*opponent’s queen on c4.*opponent’s rook on d1.*opponent moves first/);
 assert.match(text(33,'b'),/opponent’s pawn on e4.*your knight on d5.*opponent’s queen on c4/);
 assert.match(text(34,'b'),/You choose Nb6.*opponent’s queen on c4.*opponent’s rook on d1/);
 for(const ply of [32,33,34])for(const color of ['w','b'])assert.doesNotMatch(text(ply,color),/guarantees material|winning fork|best move|forced win/);
 const f=row(33).result.findings.find(f=>f.event==='next-knight-fork');assert.equal(f.researchStatus,'provisional');assert.equal(f.study,'P006');
 const position=new Chess(row(33).input.fen);position.move(row(33).input.move);position.move(f.context.evidence.consequence.move);
 assert.ok(position.attackers('c4','b').includes('e3'));assert.ok(position.attackers('d1','b').includes('e3'));
});

test('Opening replies explain development, conditional preparation, and the unprotected pawn offer',()=>{
 assert.match(text(2),/pawn move to c6 may prepare d7–d5.*support.*d5/);
 assert.doesNotMatch(text(2),/b7 now supports/);
 assert.match(text(3),/bishop on f4 develops from c1.*central square.*equal-value exchange/);
 assert.doesNotMatch(text(3),/wins|should take|now attacks.*knight on b8/);
 assert.match(text(5),/pawn on e4 undefended.*pawn on d5 can take it.*no immediate recapture/);
 assert.match(text(5,'b'),/opponent’s pawn push.*Your pawn on d5.*opponent has no immediate recapture/);
 assert.doesNotMatch(text(5),/forced pawn loss|no compensation|loses the game/);
 assert.match(text(7),/knight on c3 enters play.*pawn on e4/);
 const r=row(5),offered=r.result.findings.find(f=>f.event==='immediate-pawn-offer'),b=new Chess(r.input.fen);b.move(r.input.move);b.move(offered.context.evidence.consequence.capture);
 assert.ok(!b.moves({verbose:true}).some(m=>m.captured&&m.to==='e4'));
});

test('Quiet central and rim development teach qualified lessons without requiring an attack',()=>{
 for(const [move,expected] of [['b1c3',/Your knight on c3 develops.*e4 and d5/],['g1h3',/Your knight on h3 develops.*rim.*concrete purpose/]]){
  const input={fen:initial,move,history:{fen:initial,moves:[]},conceptGroups:DEFAULT_CONCEPT_GROUPS},result=run(input);
  const reply=coachReply(result.findings,{input,player:'w',mover:'w',change:result.change});assert.match(reply.items[0].text,expected);assert.doesNotMatch(reply.items[0].text,/bad move|always|dim/);
 }
});

test('Captured pawn gain is independently replayable; queen recapture is not misreported as a windfall',()=>{
 assert.match(text(57),/knight on c6 takes.*pawn on c6.*at least a pawn’s worth.*every immediate reply/);
 assert.match(text(57,'b'),/opponent’s knight on c6 takes your pawn.*opponent keeps/);
 assert.ok(!row(56).result.findings.some(f=>f.event==='immediate-capture-gain'));
 assert.doesNotMatch(text(56),/takes your queen.*gain|wins.*queen/);
 const r=row(57),w=r.result.findings.find(f=>f.event==='immediate-capture-gain').details;
 const c=new Chess(r.input.fen),values={p:1,n:3,b:3,r:5,q:9,k:0},balance=()=>c.board().flat().filter(Boolean).reduce((sum,p)=>sum+(p.color==='w'?1:-1)*values[p.type],0),baseline=balance();c.move(r.input.move);
 assert.deepEqual(w.replies.map(r=>r.reply),c.moves({verbose:true}).map(m=>m.from+m.to+(m.promotion||'')));
 for(const reply of w.replies){c.move(reply.reply);assert.ok(balance()-baseline>=1);assert.equal(balance()-baseline,reply.gain);c.undo();}
});

test('Counterexamples suppress fork fantasies and unsafe capture gains',()=>{
 // A pinned knight cannot jump; and capturing a guarded pawn is not a gain.
 const inputs=[{fen:'3r3k/4p3/8/3N1r2/2q5/8/8/3K4 b - - 0 1',move:'e7e6'},
 {fen:'4k3/8/3p4/4p3/8/5N2/8/4K3 w - - 0 1',move:'f3e5'}];
 for(const input of inputs){const r=inspectFastConsequences({...input,conceptGroups:DEFAULT_CONCEPT_GROUPS});assert.ok(!r.events.some(e=>e.id==='immediate-capture-gain'));
 if(input.move==='e7e6')assert.ok(!r.events.some(e=>e.id==='next-knight-fork'));
 }
 const unpinned=inspectFastConsequences({fen:'7k/4p3/8/3N1r2/2q5/8/8/3K4 b - - 0 1',move:'e7e6',conceptGroups:DEFAULT_CONCEPT_GROUPS});assert.ok(unpinned.events.some(e=>e.id==='next-knight-fork'));
 const r=inspectFastConsequences({...row(32).input,disabledConcepts:['next-knight-fork']});assert.ok(!r.events.some(e=>e.id==='next-knight-fork'));
 assert.equal(inspectFastConsequences({...row(32).input,conceptGroups:[]}).events.length,0);
});

test('Individual choices remove findings, skip fully disabled study owners, and retain strict detector inputs',()=>{
 const source=row(32).input,disabledConcepts=['next-knight-fork','direct-attack'],filtered=run({...source,disabledConcepts});
 assert.ok(!filtered.findings.some(f=>disabledConcepts.includes(f.event)));
 assert.notEqual(conceptKey({...source,disabledConcepts}),conceptKey(source));
 assert.deepEqual(detectorInput({...source,disabledConcepts}),{fen:source.fen,move:source.move,history:source.history});
 const off=CONCEPT_ITEMS.filter(item=>item.studies.includes('E096')).map(item=>item.id),input={...row(5).input,conceptGroups:[...DEFAULT_CONCEPT_GROUPS,'history'],disabledConcepts:off};
 assert.equal(studyEnabled(input,'E096'),false);assert.ok(!run(input).stages.some(s=>s.detector==='E096'));
 assert.deepEqual(normalizeDisabledConcepts(['direct-attack','not-implemented','direct-attack']),['direct-attack']);
 const ids=new Set(CONCEPT_ITEMS.map(item=>item.id));for(const ply of [2,3,5,7,32,33,34,56,57])for(const f of row(ply).result.findings)assert.ok(ids.has(f.event)||['capture','check','castling'].includes(f.event),'Finding needs a control: '+f.event);
});

test('Settings groups expand independently, preserve rapid item changes, and reset only concept customizations',t=>{
 const a=app(t),S=loadGame(a,'1. d4 c6 2. Bf4');a.call('buildUI');a.call('go',3);S.settings.conceptsEnabled=true;S.settings.conceptsView='reply';a.call('toggleSettings');a.dom.window.document.querySelectorAll('.set-tab')[2].click();
 const doc=a.dom.window.document,expand=id=>{const d=doc.querySelector('[data-concept-detail="group:'+id+'"]');d.open=true;d._populateConceptItems();return d;};
 assert.equal(doc.querySelectorAll('.concept-item-row').length,0,'Closed groups do not build hundreds of inputs');
 const excluded=doc.querySelector('#conceptsExcluded');assert.ok(excluded);excluded.open=true;
 expand('features');expand('immediate');const baseline=conceptKey(a.call('selectedConceptInput'));
 doc.querySelector('#concept-item-direct-attack').click();doc.querySelector('#concept-item-next-knight-fork').click();
 assert.deepEqual(Array.from(S.settings.disabledConcepts),['direct-attack','next-knight-fork']);assert.notEqual(conceptKey(a.call('selectedConceptInput')),baseline);
 doc.querySelector('#concept-item-direct-attack').focus();a.call('renderSettings');assert.equal(doc.activeElement.id,'concept-item-direct-attack');
 assert.ok(doc.querySelector('#conceptsExcluded').open);assert.ok(doc.querySelector('[data-concept-detail="group:immediate"]').open);
 assert.equal(doc.querySelector('#concept-item-direct-attack').checked,false);
 const before=a.call('selectedConceptInput');S.meSide='b';S.flipped=true;assert.equal(conceptKey(a.call('selectedConceptInput')),conceptKey(before));
 branch(a,1,1);assert.notEqual(conceptKey(a.call('selectedConceptInput')),conceptKey(before));
 doc.querySelector('#conceptsReset').click();assert.deepEqual(Array.from(S.settings.disabledConcepts),[]);assert.deepEqual(Array.from(S.settings.conceptGroups),DEFAULT_CONCEPT_GROUPS);assert.equal(S.settings.conceptsEnabled,true);assert.equal(S.settings.conceptsView,'reply');
 assert.equal(a.writes.at(-1).settings.disabledConcepts.length,0);
});

test('Old async replies cannot repopulate the result after an individual control change',()=>{
 const workers=[],s=new ConceptSession({demandOnly:true,worker:()=>{const w={postMessage(){},terminate(){}};workers.push(w);return w;}});
 try{const input=row(32).input;s.configure([input],true);const oldKey=s.include(input,true),old=workers[0],next={...input,disabledConcepts:['next-knight-fork']};s.configure([next],true);const key=s.include(next,true);
 old.onmessage({data:{key:oldKey,phase:'complete',result:{findings:[{event:'next-knight-fork'}]}}});assert.equal(s.entries.get(key).status,'running');assert.equal(s.entries.get(key).findings.length,0);
 workers[1].onmessage({data:{key,phase:'complete',result:{findings:[],errors:[],issues:[],unavailable:[],timeMs:1}}});assert.equal(s.entries.get(key).status,'complete');
 }finally{s.stop();}
});

test('Fast consequence pass remains bounded across the complete supplied game',()=>{
 const started=performance.now();let nodes=0;
 for(const r of rows){const result=inspectFastConsequences(r.input);nodes+=result.nodes;assert.ok(result.nodes<1024);assert.ok(result.events.every(e=>e.integrationStudy==='P006'&&e.qualityClaim===false));}
 assert.ok(performance.now()-started<6000,'57 local consequence inspections must stay below six seconds');
 console.log('P006 full-game consequence work:',Math.round(performance.now()-started)+' ms,',nodes,'bounded work units');
});

test('Quiet bishop moves skip knight scans, while relevant pawn chases retain their fork witness',()=>{
 const quiet=inspectFastConsequences(row(3).input);assert.equal(quiet.nodes,0);
 assert.ok(!quiet.stages.some(s=>s.detector==='P006-knight'));
 const chase=inspectFastConsequences(row(33).input);assert.ok(chase.events.some(e=>e.id==='next-knight-fork'));
 assert.ok(chase.nodes<48,'Scan the relevant knight, not both armies');
});


test('Presentation rejects stale consequence witnesses and names en-passant victims on their actual square',()=>{
 const r=row(32),stale=row(33),forged={...r.result.findings.find(f=>f.event==='next-knight-fork')};
 const reply=coachReply([forged],{input:stale.input,player:'w',mover:'w'});assert.deepEqual(reply.items,[]);
 const fen='7k/8/8/3pP3/8/8/8/K7 w - d6 0 2',input={fen,move:'e5d6',conceptGroups:DEFAULT_CONCEPT_GROUPS},result=run(input);
 const text=coachReply(result.findings,{input,player:'w',mover:'w'}).items[0].text;
 assert.match(text,/pawn on d6 takes.*pawn on d5/);assert.doesNotMatch(text,/takes.*pawn on d6/);
});


test('Pawn-offer control stays independent of capture-proof control, and disabling all new witnesses stops their stage',()=>{
 const source=row(5).input,newIds=CONCEPT_ITEMS.filter(i=>i.studies.includes('P006')).map(i=>i.id);
 const onlyOffer={...source,disabledConcepts:newIds.filter(id=>id!=='immediate-pawn-offer')};
 const result=inspectFastConsequences(onlyOffer);assert.ok(result.events.some(e=>e.id==='immediate-pawn-offer'));assert.equal(result.nodes,0);
 const off={...source,disabledConcepts:newIds};assert.equal(studyEnabled(off,'P006'),false);assert.ok(!run(off).stages.some(s=>s.detector==='P006'));
});
