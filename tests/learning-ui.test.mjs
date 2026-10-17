import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import {LearningWorkspace} from '../lib/learning/workspace.js';
import {LESSONS, OPENINGS, linePositions} from '../lib/learning/content.js';
import {validateExercise} from '../lib/learning/validation.js';
import {app, loadGame, branch} from './helpers/app.mjs';
import {capturePanels, morphPanels} from '../lib/learning/morph.js';

const library=JSON.parse(fs.readFileSync(new URL('../data/learning/puzzles.json',import.meta.url)));
const savedFetch=globalThis.fetch;
globalThis.fetch=async()=>({ok:true,async json(){return structuredClone(library);}});
test.after(()=>{globalThis.fetch=savedFetch;});
const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
async function workspace(t,options={}) {
  const dom=new JSDOM('<div id="root"><div class="app"><button id="entry">Learn</button></div></div>',{url:'https://extension.test'});
  const data={},storage={async get(key){return {[key]:structuredClone(data[key])};},async set(values){Object.assign(data,structuredClone(values));}};
  const w=new LearningWorkspace({document:dom.window.document,storage,makePiece:(type,color)=>{const img=dom.window.document.createElement('img');img.className='piece-img';img.dataset.piece=color+type;return img;},...options});
  t.after(async()=>{await w.close();dom.window.close();});await w.open();return {w,dom,data};
}
test('home destinations, loading errors, filtered empty states and focus restoration all work',async t=>{
  const {w,dom}=await workspace(t);const doc=dom.window.document;
  assert.ok(doc.querySelector('.learning-workspace'));assert.equal(doc.querySelector('.app').inert,true);
  assert.ok(w.root.textContent.includes(`${library.puzzles.length} verified positions`));assert.equal(w.root.querySelectorAll('.destinations .learn-card').length,3);
  await w.navigate('concepts');w.filters.search='no such topic';w.render();assert.ok(w.root.querySelector('.learn-empty'));
  w.root.querySelector('.learn-empty button').click();assert.ok(w.root.textContent.includes('Develop your pieces'));
  await w.navigate('openings');w.filters.bookmarks=true;w.render();assert.ok(w.root.querySelector('.learn-empty'));
  const old=globalThis.fetch;globalThis.fetch=async()=>{throw Error('Offline library missing');};await w.load();assert.match(w.root.textContent,/Offline library missing/);
  globalThis.fetch=old;await w.load();assert.equal(w.ready,true);await w.close();assert.equal(doc.querySelector('.app').inert,false);
});
test('square exercise uses selection, alternative answers, lesson completion and durable difficult-exercise tracking',async t=>{
  const {w,data}=await workspace(t);await w.startLesson('outpost');await w.lessonTab('practise');
  w.root.querySelector('[data-square="e5"]').click();assert.deepEqual([...w.marked],['e5']);
  await w.submitExercise(['e5']);assert.equal(w.feedback.status,'correct');assert.equal(w.store.value.lessons.outpost.exercises[0].passed,true);
  w.activity.exercise=1;w.clearAnswer();w.render();await w.submitExercise(1);assert.equal(w.store.value.lessons.outpost.exercises[1].struggled,true);
  await w.submitExercise(0);assert.equal(w.store.value.lessons.outpost.status,'completed');assert.equal(w.store.value.lessons.outpost.exercises[1].struggled,false);
  assert.equal(data['learning:v1'].resume,null);
});
test('inconclusive exercise feedback records neither a mistake nor completion',async t=>{
  const {w}=await workspace(t);await w.startLesson('fork');await w.lessonTab('practise');
  w.checkExercise=async(ex,answer)=>validateExercise(ex,answer,{maxNodes:1});
  await w.submitExercise('e4f6');assert.equal(w.feedback.status,'inconclusive');assert.deepEqual(w.store.value.lessons.fork.exercises,{});
});
test('the difficult-exercise library resumes the actual exercise that needs another attempt',async t=>{
  const {w}=await workspace(t);await w.startLesson('outpost');await w.lessonTab('practise');w.activity.exercise=1;await w.submitExercise(1);
  await w.navigate('concepts');w.filters.status='Struggled';await w.startLesson('outpost');
  assert.equal(w.activity.tab,'practise');assert.equal(w.activity.exercise,1);
});
test('board click input, keyboard navigation and opening replies support both colors',async t=>{
  const {w,dom}=await workspace(t);await w.startOpening('italian');w.activity.practice=true;w.activity.ply=0;w.render();
  w.root.querySelector('[data-square="e2"]').click();w.root.querySelector('[data-square="e4"]').click();await settle();
  assert.equal(w.activity.ply,2);assert.match(w.feedback.feedback,/opponent has replied/);
  const square=w.root.querySelector('[data-square="a8"]');square.focus();square.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));assert.equal(dom.window.document.activeElement.dataset.square,'b8');
  await w.startOpening('italian',{color:'b',practice:true});assert.equal(w.activity.ply,1);assert.equal(w.flipped,true);
  await w.submitOpening('e7e5');assert.equal(w.activity.ply,3);assert.equal(w.openingState.positions.length,11);
});
test('each opening practice line completes from both sides and legal deviations stay neutral',async t=>{
  const {w}=await workspace(t);
  for(const o of OPENINGS)for(let line=0;line<o.lines.length;line++)for(const color of ['w','b']) {
    await w.startOpening(o.id,{line,color,practice:true});const state=linePositions(o.lines[line]);
    while(w.activity.ply<state.moves.length)await w.submitOpening(state.moves[w.activity.ply]);
    assert.equal(w.feedback.status,'completed');assert.ok(w.store.value.openings[o.id].completed[line+':'+color]);
  }
  assert.ok(OPENINGS.every(o=>w.store.value.openings[o.id].status==='completed'));
  await w.startOpening('italian',{practice:true});await w.submitOpening('d2d4');assert.equal(w.activity.ply,0);assert.equal(w.feedback.status,'info');assert.match(w.feedback.feedback,/does not mean it is a bad move/);
  await w.startOpening('italian',{practice:true,color:'b',ply:5});await w.submitOpening('g8f6');assert.equal(w.activity.line,1);assert.equal(w.activity.ply,7);
});
test('puzzles hide solution information, persist intermediate steps and distinguish assisted and repeat solves',async t=>{
  const {w,data}=await workspace(t);const p=w.puzzles.find(p=>p.solution.length>=3);
  await w.startPuzzleSelection([p]);assert.ok(!w.root.textContent.includes('Why the solution works'));assert.equal(w.root.querySelectorAll('.annotated').length,0);
  await w.submitPuzzle(p.solution[0]);assert.equal(w.activity.step,2);assert.equal(data['learning:v1'].resume.step,2);
  const resume=structuredClone(data['learning:v1'].resume);await w.navigate('home');await w.resume(resume);assert.equal(w.activity.step,2);
  while(!w.attemptRecorded)await w.submitPuzzle(p.solution[w.activity.step]);assert.equal(w.store.value.puzzles[p.id].clean,1);
  await w.preparePuzzle(p);await w.hintPuzzle();assert.equal(w.activity.assisted,true);assert.equal(w.root.querySelectorAll('.annotated').length,1);
  await w.revealPuzzle();assert.equal(w.store.value.puzzles[p.id].assisted,1);assert.equal(w.store.value.puzzles[p.id].clean,1);
  await w.preparePuzzle(p);while(!w.attemptRecorded)await w.submitPuzzle(p.solution[w.activity.step]);assert.equal(w.store.value.puzzles[p.id].clean,2);
});
test('timed challenges start ready, count mistakes/skips/assistance and save personal best and review list',async t=>{
  const {w}=await workspace(t);const first=w.puzzles.find(p=>p.theme==='mateIn1'),second=w.puzzles.find(p=>p.theme==='fork');
  w.shuffle=()=>[first,second];await w.startChallenge(60);assert.ok(w.run.clock.started);assert.equal(w.root.querySelector('#learn-clock').textContent,'1:00');
  await w.revealPuzzle();assert.equal(w.run.solved,0);assert.equal(w.run.assisted,1);await w.nextPuzzle();
  const wrong=new (await import('../lib/chess.js')).Chess(second.fen).moves({verbose:true}).find(m=>m.lan!==second.solution[0]);
  await w.submitPuzzle(wrong.lan);assert.equal(w.run.mistakes,1);await w.skipPuzzle();assert.equal(w.run,null);
  assert.equal(w.result.assisted,1);assert.equal(w.result.mistakes,1);assert.equal(w.result.skips,1);assert.ok(w.result.missed.includes(second.id));assert.ok(w.store.value.challenges.length);
});
test('all timed modes end at expiry before accepting another answer; partially hinted puzzles enter review',async t=>{
  const {w}=await workspace(t);for(const duration of [60,300,600]){
    await w.startChallenge(duration);await w.hintPuzzle();w.run.clock.remainingMs=0;w.run.clock.runningAt=null;
    await w.submitPuzzle(w.puzzles.find(p=>p.id===w.activity.id).solution[0]);
    assert.equal(w.run,null);assert.equal(w.result.solved,0);assert.equal(w.result.missed.length,1);assert.equal(w.store.value.bests[duration],0);
  }
});
test('review game, move, variation, board orientation and keyboard state survive learning',async t=>{
  const a=app(t);loadGame(a,'1. e4 e5 2. Nf3 Nc6');a.call('computeDerived');a.call('buildUI');a.call('renderAll');
  a.call('go',2);a.state.flipped=true;a.call('buildBoard');const before={idx:a.state.idx,flipped:a.state.flipped,pgn:a.state.pgn,positions:a.state.positions};
  await a.call('openLearning');const w=a.run('learningWorkspace');assert.ok(w.ready);
  a.dom.window.document.dispatchEvent(new a.dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
  assert.equal(a.state.idx,before.idx);await w.startOpening('italian');await w.submitOpening('e2e4');await w.close();
  assert.equal(a.state.idx,before.idx);assert.equal(a.state.flipped,before.flipped);assert.equal(a.state.pgn,before.pgn);assert.equal(a.state.positions,before.positions);
  a.dom.window.document.dispatchEvent(new a.dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));assert.equal(a.state.idx,before.idx+1);
});
test('a playing review variation pauses and resumes without losing its branch or selected move',async t=>{
  const a=app(t);loadGame(a,'1. e4 e5 2. Nf3 Nc6');a.call('computeDerived');a.call('buildUI');a.call('renderAll');
  a.replace('requestLiveEval',async()=>{});const v=branch(a,0,1),positions=v.positions;
  a.call('paintBoard');a.call('startLineWalk');assert.equal(a.state.lineWalking,true);
  await a.call('openLearning');assert.equal(a.state.lineWalking,false);const w=a.run('learningWorkspace');
  await w.startLesson('chain');w.flipped=!w.flipped;await w.close();
  assert.equal(a.state.analysisMode,true);assert.equal(a.state.variation,v);assert.equal(v.idx,1);assert.equal(v.positions,positions);
  assert.equal(a.state.lineWalking,true);a.call('stopLineWalk');
});

test('in-place learning preserves the actual board and topbar across all destinations and restores review input',async t=>{
  const a=app(t);loadGame(a,'1. e4 e5 2. Nf3 Nc6');a.call('computeDerived');a.call('buildUI');a.call('renderAll');
  const doc=a.dom.window.document,board=doc.querySelector('.board'),topbar=doc.querySelector('.topbar'),squares=[...board.children];
  const wrap=doc.querySelector('#boardWrap'),parent=wrap.parentNode;
  await a.call('openLearning');const w=a.run('learningWorkspace');
  assert.ok(w.embedded);assert.ok(doc.querySelector('.learning-embedded'));assert.notEqual(doc.querySelector('.app').inert,true);
  assert.equal(doc.querySelector('.topbar'),topbar);assert.equal(doc.querySelector('.board'),board);
  assert.deepEqual([...board.children],squares);assert.equal(board.inert,true);
  a.call('toggleFlip');assert.ok(board.querySelector('.learn-square'));assert.equal(w.flipped,!a.state.flipped);
  a.call('toggleFlip');assert.deepEqual([...board.children],squares);
  assert.ok([...doc.querySelectorAll('.mod')].every(node=>node.inert));
  await w.startLesson('outpost');await w.lessonTab('practise');
  assert.equal(doc.querySelector('.board'),board);assert.equal(doc.querySelectorAll('.learn-board').length,1);
  board.querySelector('[data-square=e5]').click();assert.ok(w.marked.has('e5'));
  await w.submitExercise(['e5']);assert.equal(w.feedback.status,'correct');
  await w.startOpening('italian',{practice:true});
  board.querySelector('[data-square=e2]').click();board.querySelector('[data-square=e4]').click();await settle();
  assert.equal(w.activity.ply,2);assert.equal(a.state.idx,0);
  const drag=new a.dom.window.Event('dragstart',{bubbles:true,cancelable:true});board.dispatchEvent(drag);assert.equal(drag.defaultPrevented,false);
  const orientation=a.state.flipped;a.call('toggleFlip');assert.equal(a.state.flipped,orientation);assert.equal(w.flipped,true);
  await w.startPuzzleSelection([w.puzzles.find(p=>p.theme==='mateIn1')]);
  assert.equal(doc.querySelector('.board'),board);assert.equal(board.querySelectorAll('.annotated').length,0);
  // An asynchronous review repaint must not overwrite the learning board.
  a.call('buildBoard');a.call('paintBoard');assert.equal(doc.querySelector('.board'),board);assert.ok(board.querySelector('.learn-square'));
  a.state.bests[0]={bestmove:'e2e4'};a.state.userArrows=[{from:'e2',to:'e4'}];a.call('refreshArrows');
  assert.equal(board.querySelector('svg'),null,'Review arrows must never appear over a learning position');
  w.shell.scrollTop=300;await w.navigate('concepts');assert.equal(w.shell.scrollTop,0);assert.deepEqual([...board.children],squares);
  await w.close();assert.equal(wrap.parentNode,parent);assert.equal(doc.querySelector('.board'),board);
  assert.deepEqual([...board.querySelectorAll('.sq')],squares.filter(node=>node.classList.contains('sq')));assert.equal(board.inert,false);
  assert.ok(board.querySelector('svg.user-arrows'));
  assert.ok([...doc.querySelectorAll('.mod')].every(node=>!node.inert));assert.equal(doc.querySelector('.learn-board-placeholder'),null);
  doc.dispatchEvent(new a.dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));assert.equal(a.state.idx,1);
});

test('learning presentation saves under Visual, resets to morph, and retains the separate-page experience',async t=>{
  const a=app(t);loadGame(a,'1. e4 e5');a.call('computeDerived');a.call('buildUI');a.call('renderAll');a.call('toggleSettings');
  const doc=a.dom.window.document;
  const section=[...doc.querySelectorAll('.set-section')].find(node=>node.querySelector('.set-sect-head').textContent==='Learning experience');
  assert.ok(section);section.querySelector('.set-sect-head').click();
  const choices=section.querySelectorAll('.learn-style-option');
  assert.deepEqual([...choices].map(node=>node.querySelector('strong').textContent),['Morph in place','Studio Morph','Minimal morph','Board morph','Separate page']);
  assert.equal(choices[0].getAttribute('aria-pressed'),'true');
  choices[4].click();await settle();assert.equal(a.store.settings.learningTransition,'page');
  await a.call('openLearning');const legacy=a.run('learningWorkspace');assert.equal(legacy.embedded,null);
  assert.equal(doc.querySelector('.app').inert,true);assert.equal(legacy.root.getAttribute('aria-modal'),'true');
  await legacy.close();await a.call('resetVisualSettings');assert.equal(a.store.settings.learningTransition,'morph');
  await a.call('openLearning');assert.ok(a.run('learningWorkspace').embedded);
  await a.call('toggleSettings');assert.equal(a.run('learningWorkspace'),null);assert.equal(doc.querySelector('#settings').hidden,false);
});

for (const presentation of ['studio','minimal','board']) test(`${presentation} is a distinct selectable design with shared practice and preserved review state`,async t=>{
  const a=app(t);loadGame(a,'1. e4 e5 2. Nf3 Nc6');a.call('computeDerived');a.call('buildUI');a.call('renderAll');a.call('go',2);
  const doc=a.dom.window.document,board=doc.querySelector('.board'),topbar=doc.querySelector('.topbar');
  a.call('toggleSettings');
  [...doc.querySelectorAll('.set-sect-head')].find(node=>node.textContent==='Learning experience').click();
  doc.querySelector(`.learn-style-option[data-presentation="${presentation}"]`).click();await settle();
  assert.equal(a.store.settings.learningTransition,presentation);
  await a.call('openLearning');const w=a.run('learningWorkspace');
  assert.equal(w.presentation,presentation);assert.equal(w.root.dataset.presentation,presentation);
  assert.equal(doc.querySelector('.board'),board);assert.equal(doc.querySelector('.topbar'),topbar);
  if(presentation==='minimal')assert.ok(w.root.querySelector('.learn-desk-home'));
  if(presentation==='board')assert.equal(w.root.querySelectorAll('.studio-destination').length,3);
  await w.startLesson('outpost');await w.lessonTab('practise');
  board.querySelector('[data-square=e5]').click();await w.submitExercise(['e5']);assert.equal(w.feedback.status,'correct');
  await w.startOpening('italian',{practice:true,color:'b'});
  board.querySelector('[data-square=e7]').click();board.querySelector('[data-square=e5]').click();await settle();assert.equal(w.activity.ply,3);
  await w.startPuzzleSelection([w.puzzles.find(p=>p.theme==='mateIn1')]);
  assert.equal(doc.querySelectorAll('.board').length,1);assert.equal(board.querySelectorAll('.annotated').length,0);
  await w.revealPuzzle();assert.ok(w.attemptRecorded);
  await w.close();assert.equal(doc.querySelector('.board'),board);assert.equal(a.state.idx,2);assert.equal(a.state.flipped,false);
  assert.equal(doc.querySelector('.learning-workspace'),null);
});

test('the four designs keep their distinct timing and motion and migrate old branch preferences',async t=>{
  assert.equal(LearningWorkspace.presentationFor({learningPresentation:'studio'}),'board');
  assert.equal(LearningWorkspace.presentationFor({learningLayout:'morph'}),'minimal');
  assert.equal(LearningWorkspace.presentationFor({learningTransition:'studio'}),'studio');
  assert.equal(LearningWorkspace.presentationFor({learningLayout:'page'}),'page');
  assert.equal(LearningWorkspace.presentationFor({learningTransition:'morph',learningLayout:'page'}),'morph');
  const dom=new JSDOM('<div id="source"></div><div id="target"></div>');t.after(()=>dom.window.close());
  const doc=dom.window.document,source=doc.querySelector('#source'),target=doc.querySelector('#target');
  for(const node of [source,target])node.getBoundingClientRect=()=>({x:10,y:20,width:200,height:100});
  const motions={};
  for(const variant of ['morph','studio','minimal','board']) {
    const effects=[];dom.window.Element.prototype.animate=(frames,options)=>{effects.push({frames,options});return {finished:Promise.resolve(),cancel(){}};};
    await morphPanels(doc,capturePanels([source]),[target],{variant});
    motions[variant]=effects;
    assert.equal(doc.querySelector('.learn-morph-layer'),null);
  }
  assert.equal(motions.morph[0].options.duration,760);assert.equal(motions.studio[0].options.duration,280);
  assert.equal(motions.minimal[0].options.duration,280);assert.equal(motions.board[0].options.duration,300);
  assert.ok(motions.studio.at(-1).frames[0].filter);assert.match(motions.minimal.at(-1).frames[0].transform,/translateY/);
  assert.match(motions.board.at(-1).frames[0].transform,/translateX/);
});

test('panel morph respects reduced motion and cleans up all surfaces when resized or finished',async t=>{
  const dom=new JSDOM('<div id="old">Review panel</div><div id="new">Learning panel</div>');t.after(()=>dom.window.close());
  const {document:doc}=dom.window,old=doc.querySelector('#old'),next=doc.querySelector('#new');
  for(const node of [old,next])node.getBoundingClientRect=()=>({x:20,y:40,width:240,height:160});
  const animations=[];
  dom.window.Element.prototype.animate=function(frames,options){const animation={frames,options,finished:new Promise(()=>{}),cancelled:false,cancel(){this.cancelled=true;}};animations.push(animation);return animation;};
  dom.window.matchMedia=()=>({matches:true});
  await morphPanels(doc,capturePanels([old]),[next]);assert.equal(animations.length,0);assert.equal(doc.querySelector('.learn-morph-layer'),null);
  dom.window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  const pending=morphPanels(doc,capturePanels([old]),[next]);assert.equal(animations.length,3);
  assert.equal(doc.querySelector('.learn-morph-layer').getAttribute('aria-hidden'),'true');assert.equal(doc.querySelectorAll('#old').length,1);
  dom.window.dispatchEvent(new dom.window.Event('resize'));await pending;
  assert.ok(animations.every(a=>a.cancelled));assert.equal(doc.querySelector('.learn-morph-layer'),null);
  animations.length=0;
  dom.window.Element.prototype.animate=function(){const animation={finished:Promise.resolve(),cancelled:false,cancel(){this.cancelled=true;}};animations.push(animation);return animation;};
  await morphPanels(doc,capturePanels([old]),[next]);assert.ok(animations.every(a=>a.cancelled));assert.equal(doc.querySelector('.learn-morph-layer'),null);
});
