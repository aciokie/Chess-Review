import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Chess} from '../lib/chess.js';
import {DEFAULT_CONCEPT_GROUPS,CONCEPT_GROUPS} from '../lib/concepts/controls.js';
import {startConceptRun,runConceptStage,DETECTORS,supplementalConcepts,conceptRunSummary} from '../lib/concepts/runtime.js';
import {coachReply} from '../lib/coach-insights.js';
import {app,loadGame,branch} from './helpers/app.mjs';
import {ConceptSession,conceptKey} from '../lib/concepts/session.js';
const provenance=JSON.parse(await readFile(new URL('../lib/concepts/integration-provenance.json',import.meta.url)));
const initial=new Chess().fen(),history=[],board=new Chess(),rows=[];
const sans=['e4','e5','Nf3','Nc6','Bc4','Nf6','d3','Bc5','O-O','d6','Nc3','O-O','Be3','Bxe3','fxe3','Ng4','Qe2','Kh8','h3','Nh6','d4','exd4'];
const run=input=>{const job=startConceptRun(input,provenance);supplementalConcepts(job,'fast');for(const detector of DETECTORS)runConceptStage(job,detector);supplementalConcepts(job,'deep');return conceptRunSummary(job);};
// Authored legal sequence: exercises real Fast detectors, not hand-written coach
// messages. Neither external game data nor historical research is rerun here.
for(const san of sans){const m=board.moves({verbose:true}).find(m=>m.san===san),move=m.from+m.to;const input={fen:board.fen(),move,history:{fen:initial,moves:[...history]},conceptGroups:DEFAULT_CONCEPT_GROUPS};rows.push({san,input,result:run(input),mover:board.turn()});board.move(move);history.push(move);}
const row=san=>rows.find(r=>r.san===san);
const reply=(r,player='w')=>coachReply(r.result.findings,{mover:r.mover,player,change:r.result.change,input:r.input});
const text=(san,player='w')=>reply(row(san),player).items.map(i=>i.text).join(' ');

test('Fast coach picks concrete attacks and defenses with correct ownership for both players',()=>{
 assert.match(text('Nf3'),/Your knight on f3.*attacks your opponent’s pawn on e5/);
 assert.match(text('Nf3'),/If you could move again in this exact position.*any immediate reply.*Your opponent moves next/);
 assert.match(text('Nf3','b'),/Your opponent’s knight on f3.*attacks your pawn on e5/);
 assert.match(text('Nf3','b'),/If your opponent could move again in this exact position.*You move next/);
 assert.match(text('Nc6'),/opponent’s knight on c6.*defends the pawn on e5, which you attack/);
 assert.match(text('Nc6','b'),/Your knight on c6.*defends.*pawn on e5/);
 assert.match(text('Nf6'),/opponent’s knight on f6.*attacks your pawn on e4/);
 assert.match(text('h3'),/Your pawn on h3 now attacks your opponent’s knight on g4/);
 assert.doesNotMatch(text('h3'),/wins|forced gain|best move/);
 for(const r of rows)for(const player of ['w','b']){
  const a=reply(r,player);assert.ok(a.items.length<=2);
  assert.ok(!a.items.some(i=>/legal-input|inventory|piece-movement/.test(i.event)));
  assert.doesNotMatch(a.items.map(i=>i.text).join(' '),/you also (attacks|defends)|undefined|\bf3 can take\b/);
 }
});

test('Fast replies select one lesson and keep unrelated effects in the inspector',()=>{
 const support=reply(row('d3')).items[0];
 assert.match(support.text,/pawn on d3 now defends.*pawn on e4/);
 assert.doesNotMatch(support.text,/bishop on c1/);
 assert.ok(row('d3').result.findings.some(f=>f.event==='opened-bishop-diagonal'));
 assert.match(support.takeaway,/new defender on e4/);
 const double=reply(row('exd4')).items[0];
 assert.match(double.text,/pawn on d4.*knight on c3.*pawn on e3.*same time/);
 assert.doesNotMatch(double.text,/doubled pawns/);
 assert.ok(row('exd4').result.findings.some(f=>f.event==='doubled-pawns'));
 const clearance=reply(row('Nh6')).items[0];
 assert.match(clearance.text,/knight from g4 to h6.*opponent’s bishop on c8.*your pawn on h3/);
 assert.equal(reply(row('Nh6')).items.filter(i=>/c8.*h3/.test(i.text)).length,1);
 assert.match(text('Qe2'),/connects the rooks on a1 and f1.*defend each other/);
 for(const r of rows)for(const i of reply(r).items){
  const keys=i.supporting.map(f=>f.event+':'+f.sourceText);assert.equal(new Set(keys).size,keys.length);
  assert.ok(i.supporting.every(f=>f.sourceText));
 }
 assert.equal(reply(row('Kh8')).items.length,0);
 for(const r of rows)for(const player of ['w','b'])assert.ok(reply(r,player).items.length<=1);
});

test('Quiet facts abstain and coaching gives a concrete thinking task without claiming best play',()=>{
 for(const san of ['e4','e5'])assert.deepEqual(reply(row(san)).items,[]);
 for(const san of ['Nf3','Nc6','d3','h3','exd4'])for(const player of ['w','b']){
  const answer=reply(row(san),player).items[0];assert.ok(answer.takeaway);
  assert.doesNotMatch(answer.takeaway,/best move|guaranteed|always|winning/);
 }
 assert.match(reply(row('Nh6')).items[0].takeaway,/line it leaves behind/);
 const contact={event:'direct-attack',name:'Contact',text:'A geometric contact.',context:{actor:'b',evidence:{to:'c5',targets:['e3']}}};
 const r=row('Bc5');assert.deepEqual(coachReply([contact],{mover:'b',player:'w',input:r.input}).items,[]);
});

test('Reply tab keeps the lesson readable and diagnostics collapsed, with evidence accessible',t=>{
 const a=app(t),S=loadGame(a,'1. e4 e5 2. Nf3 Nc6');a.call('computeDerived');a.call('buildUI');
 const session=new ConceptSession({demandOnly:true,worker:()=>({postMessage(){},terminate(){}})});t.after(()=>session.stop());a.context.__session=session;a.run('_conceptSession=__session');
 S.settings.conceptsEnabled=true;S.settings.conceptsView='reply';S.meSide='w';S.playerKnown=true;
 a.call('go',4);session.entries.set(conceptKey(a.call('selectedConceptInput')),{...row('Nc6').result,status:'complete'});a.call('renderCoachPanel');
 const doc=a.dom.window.document;
 assert.equal(doc.querySelectorAll('.coach-insight').length,1);
 assert.equal(doc.querySelector('.coach-perspective'),null);assert.equal(doc.querySelector('.coach-move-quality'),null);
 assert.match(doc.querySelector('.coach-takeaway').textContent,/new defender on e5/);
 const notes=doc.querySelector('.coach-analysis-notes');assert.equal(notes.open,false);
 assert.ok(notes.textContent.includes('Some groups'));notes.open=true;a.call('renderCoachPanel');assert.equal(doc.querySelector('.coach-analysis-notes').open,true);
 const details=doc.querySelector('.coach-insight details');assert.equal(details.open,false);assert.equal(details.querySelector('summary').textContent,'Why this reply?');assert.match(details.textContent,/E200 \(provisional\)/);
 session.entries.get(conceptKey(a.call('selectedConceptInput'))).errors=['Check failed'];a.call('renderCoachPanel');assert.match(doc.querySelector('[role="status"]').textContent,/incomplete/);
 S.playerKnown=false;a.call('renderCoachPanel');assert.equal(doc.querySelector('.coach-empty'),null);
});

test('Urgent actual mate outranks development; unknown identity and unsupported claims abstain',()=>{
 for(const [fen,move,player] of [['7k/p7/5KQ1/8/8/8/8/8 b - - 0 1','a7a6','w'],['8/8/8/8/8/5kq1/P7/7K w - - 0 1','a2a3','b']]){
  const input={fen,move,conceptGroups:DEFAULT_CONCEPT_GROUPS,history:{fen,moves:[]}},result=run(input),mover=player==='w'?'b':'w';
  const r={input,result,mover};assert.match(reply(r,player).items[0].text,/You can now play .*mate in one/);
  assert.match(reply(r,mover).items[0].text,/Your move allows .*mate in one/);
  assert.equal(reply(r,null).perspectiveKnown,false);assert.deepEqual(reply(r,null).items,[]);
 }
 const r=row('Kh8'),fake=[{event:'strategic-winning-attack',name:'Unverified attack',text:'You have a winning attack.',context:{actor:'b',evidence:{}}}];
 assert.deepEqual(coachReply(fake,{mover:'b',player:'w',input:r.input}).items,[]);
 assert.deepEqual(coachReply(row('Nf3').result.findings,{mover:'w',player:null,input:row('Nf3').input}).items,[]);
});

test('Position facts alone do not become new threats or invented causal stories',()=>{
 const r=row('Kh8');
 const unchanged={event:'undefended-unit-observation',name:'Loose unit',text:'A loose rook.',context:{actor:'w',evidence:{target:{square:'a8',type:'r',color:'b',attackers:[]}}}};
 assert.deepEqual(coachReply([unchanged],{mover:'b',player:'w',input:r.input,change:r.result.change}).items,[]);
 const r2=row('Nf3');const misleading={event:'direct-attack',name:'Wrong target',text:'Your knight attacks your own pawn.',context:{actor:'w',evidence:{piece:'n',to:'f3',targets:['e4']}}};
 assert.deepEqual(coachReply([misleading],{mover:'w',player:'w',input:r2.input}).items,[]);
 assert.ok(!text('Nf3').includes('forced win'));assert.ok(!text('Nc6').includes('safe exchange'));
});

test('Fast narration follows navigation, variations and perspective using cached results',t=>{
 const a=app(t),S=loadGame(a,'1. e4 e5 2. Nf3 Nc6');a.call('computeDerived');a.call('buildUI');
 const session=new ConceptSession({demandOnly:true,worker:()=>({postMessage(){},terminate(){}})});t.after(()=>session.stop());a.context.__session=session;a.run('_conceptSession=__session');
 S.settings.conceptsEnabled=true;S.settings.conceptsView='reply';S.meSide='w';S.playerKnown=true;
 for(const ply of [3,4]){a.call('go',ply);const key=conceptKey(a.call('selectedConceptInput'));session.entries.set(key,{...row(ply===3?'Nf3':'Nc6').result,status:'complete'});a.call('renderCoachPanel');assert.match(a.dom.window.document.querySelector('.coach-insight > p').textContent,ply===3?/knight on f3/:/knight on c6/);}
 S.meSide='b';S.flipped=true;a.call('renderCoachPanel');assert.match(a.dom.window.document.querySelector('.coach-insight > p').textContent,/Your knight on c6/);
 branch(a,2,1);const selected=a.call('selectedConceptInput');assert.equal(selected.move,'g1f3');session.entries.set(conceptKey(selected),{...row('Nf3').result,status:'complete'});a.call('renderCoachPanel');assert.match(a.dom.window.document.querySelector('.coach-insight > p').textContent,/Your opponent’s knight on f3/);
 S.playerKnown=false;a.call('renderCoachPanel');assert.match(a.dom.window.document.querySelector('.coach-insights-body').textContent,/could not be identified/);assert.equal(a.dom.window.document.querySelector('.coach-insight'),null);
});

test('Coach selection stays inexpensive and deterministic across repeated view and perspective changes',()=>{
 const started=performance.now();for(let i=0;i<100;i++)for(const r of rows)reply(r,i%2?'w':'b');
 assert.ok(performance.now()-started<3000,'Presentation unexpectedly performs expensive searches');
 const r=row('exd4');const first=reply(r);assert.deepEqual(reply(r),first);assert.deepEqual(r.result.errors,[]);
});

test('A proven losing capture outweighs an interesting response threat created by the same move',()=>{
 for(const [fen,move,mover,from,to] of [['1r4k1/1b6/8/8/8/8/1Q6/7K w - - 0 1','b2b7','w','b8','b7'],['7k/1q6/8/8/8/8/1B6/1R4K1 b - - 0 1','b7b2','b','b1','b2']]){
  const input={fen,move,conceptGroups:[...DEFAULT_CONCEPT_GROUPS,'history'],history:{fen,moves:[]}},result=run(input),r={input,result,mover};
  assert.ok(result.findings.some(f=>f.event==='certified-unit-tempo'),'Competing offensive proof must really be present');
  const loss=result.findings.find(f=>f.event==='simplification-material-loss');assert.equal(loss.context.evidence.loss.minimumNetLoss,6);
  for(const player of ['w','b']){
   const answer=reply(r,player).items[0];assert.equal(answer.event,'simplification-material-loss');
   assert.ok(answer.text.includes(`rook on ${from}`)&&answer.text.includes(`queen on ${to}`));
   assert.match(answer.text,/at least 6 points of material.*any immediate reply/);
   assert.doesNotMatch(answer.text,/lasting advantage|best move|wins the game/);
  }
 }
});

test('Presentation certificates never reinterpret another detector’s similarly named details',async()=>{
 const {summarizeConcepts}=await import('../lib/concepts/analyze.js');
 const input={...row('e4').input,conceptGroups:CONCEPT_GROUPS.map(g=>g.id)},result={events:[{id:'required-king-continuation',text:'A bounded king route.',integrationStudy:'E102',evidence:{actor:'w',detail:{restricted:'pawnOnly',selected:{policy:1},pressure:'unrelated'}}}]};
 const summary=summarizeConcepts(result,input,provenance.verified,true,provenance.entries);
 assert.equal(summary.findings.length,1);assert.equal(summary.findings[0].context.evidence.restricted,undefined);
 assert.equal(summary.findings[0].context.evidence.pawnTargets,undefined);assert.equal(summary.findings[0].context.evidence.pressure,undefined);
});

test('Removing pawn support is a real risk or opportunity even when the attack itself is unchanged',()=>{
 for(const [fen,move,mover,target] of [['k7/1b6/8/8/8/5N2/4P3/7K w - - 0 1','e2e3','w','f3'],['7k/4p3/5n2/8/8/8/1B6/K7 b - - 0 1','e7e6','b','f6']]){
  const input={fen,move,conceptGroups:DEFAULT_CONCEPT_GROUPS,history:{fen,moves:[]}},result=run(input),r={input,result,mover};
  for(const player of ['w','b']){
   const answer=reply(r,player).items[0];assert.equal(answer.event,'undefended-unit-observation');
   assert.ok(answer.text.includes(`knight on ${target} loses its pawn support`));assert.match(answer.text,/bishop on.*attacks it/);
   assert.ok(answer.text.startsWith(player===mover?'Your knight':'Your opponent’s knight'));
   assert.doesNotMatch(answer.text,/wins material|forced gain|best/);
  }
 }
});

test('Combined coaching keeps provisional change evidence separate from accepted development',()=>{
 const r=row('Nc6'),f=r.result.findings.find(f=>f.event==='minor-development');assert.equal(f.researchStatus,'accepted');
 const answer=reply(r).items[0];assert.equal(answer.researchStatus,'provisional');assert.match(answer.kind,/Coach synthesis/);
 assert.ok(answer.scopes.some(s=>s.occurrence==='E200 (provisional)'));
 assert.ok(f.scopes.every(s=>answer.scopes.some(a=>a.occurrence===s.occurrence&&a.scope===s.scope)));
 assert.ok(answer.supporting.some(s=>s.event==='recorded-move-changes'&&s.sourceText.includes('e5')));
 assert.equal(f.researchStatus,'accepted');assert.ok(!f.scopes.some(s=>s.occurrence==='E200 (provisional)'));
});
