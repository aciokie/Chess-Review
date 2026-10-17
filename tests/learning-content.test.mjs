import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Chess} from '../lib/chess.js';
import {LESSONS, OPENINGS, CATEGORIES, THEME_NAMES, playUci, linePositions, positionKey} from '../lib/learning/content.js';
import {legalPosition} from '../lib/concepts/detectors/E020-concepts.mjs';
import {validateExercise, validatePuzzleMove, validSquares} from '../lib/learning/validation.js';
import {puzzleExplanation} from '../lib/learning/workspace.js';

const library=JSON.parse(fs.readFileSync(new URL('../data/learning/puzzles.json',import.meta.url)));
const book=JSON.parse(fs.readFileSync(new URL('../data/book.json',import.meta.url))).epd;
test('every complete lesson has legal examples, a contrast, and passing exercises across all seven categories',()=>{
  assert.deepEqual(new Set(LESSONS.map(l=>l.category)),new Set(CATEGORIES));
  assert.equal(new Set(LESSONS.map(l=>l.id)).size,LESSONS.length);
  for(const l of LESSONS){
    assert.ok(l.explanation&&l.why&&l.mistakes.length>=2&&l.exercises.length>=2);
    assert.ok(l.exercises.some(e=>e.type==='choice'),'A board contrast is required: '+l.id);
    for(const ex of l.examples){const c=legalPosition(ex.fen);assert.equal(ex.captions.length,ex.moves.length+1);for(const move of ex.moves)playUci(c,move);legalPosition(c.fen());}
    for(const ex of l.exercises){
      legalPosition(ex.fen);
      const answer=ex.type==='choice'?ex.answer:ex.type==='squares'?(ex.selection==='one'?validSquares(ex).slice(0,1):validSquares(ex)):ex.solution?.[0];
      assert.ok(answer!==undefined,'Recorded solution required: '+l.id);
      assert.equal(validateExercise(ex,answer).status,'correct',l.id);
    }
    for(const id of l.prerequisites)assert.ok(LESSONS.some(p=>p.id===id));
  }
});
test('alternative valid moves and square answers are accepted without claiming move quality',()=>{
  const dev=LESSONS.find(l=>l.id==='development').exercises[0];
  for(const move of ['g1f3','b1c3']){const r=validateExercise(dev,move);assert.equal(r.status,'correct');assert.equal(r.moveQuality,'not-assessed');}
  const outpost=LESSONS.find(l=>l.id==='outpost').exercises[0];
  for(const sq of ['c5','e5'])assert.equal(validateExercise(outpost,[sq]).status,'correct');
  assert.equal(validateExercise(outpost,['c5','e5']).status,'incorrect');
  const discovery=LESSONS.find(l=>l.id==='discovery').exercises[0];
  for(const move of ['c3d4','c3b4','c3f6'])assert.equal(validateExercise(discovery,move).status,'correct');
  const promo=LESSONS.find(l=>l.id==='promotion').exercises[0];
  for(const piece of 'qrbn')assert.equal(validateExercise(promo,'e7e8'+piece).status,'correct');
  const luft=LESSONS.find(l=>l.id==='back-rank').exercises[2];
  for(const move of ['h7h6','h7h5','g7g6','f7f6'])assert.equal(validateExercise(luft,move).status,'correct');
});
test('unsupported objectives, failed admission and exhausted proofs abstain; legal wrong moves are separate',()=>{
  const fork=LESSONS.find(l=>l.id==='fork').exercises[0];
  assert.equal(validateExercise(fork,'e4f6',{maxNodes:1}).status,'inconclusive');
  assert.equal(validateExercise({...fork,objective:'event:unknown'},'e4f6').status,'inconclusive');
  assert.equal(validateExercise({...fork,type:'squares',rule:'unknown'},['a1']).status,'inconclusive');
  assert.equal(validateExercise({...fork,fen:'bad'},'e4f6').status,'inconclusive');
  assert.equal(validateExercise(fork,'e4e5').status,'illegal');
  assert.equal(validateExercise(fork,'e4c5').status,'incorrect');
});
test('25,000 distinct licensed puzzles replay legally and cover every theme and difficulty, with sampled runtime validation and explanations',()=>{
  assert.equal(library.schema,1);assert.equal(library.license,'CC0-1.0');assert.equal(library.puzzles.length,25_000);
  assert.equal(new Set(library.puzzles.map(p=>p.id)).size,library.puzzles.length);
  assert.equal(new Set(library.puzzles.map(p=>positionKey(p.fen))).size,library.puzzles.length);
  const quotas={};
  for(const p of library.puzzles){
    const detailed=(quotas[p.theme+':'+p.difficulty]||0)<3||parseInt(p.id,36)%503===0;
    const c=legalPosition(p.setup.fen);playUci(c,p.setup.move);assert.equal(c.fen(),p.fen);
    assert.ok(p.solution.length%2===1&&/^[a-f0-9]{64}$/.test(p.source.rowSha256)&&p.source.url.endsWith('/'+p.id));
    assert.equal(p.source.license,'CC0-1.0');assert.ok(p.themes.includes(p.theme));
    assert.equal(p.difficulty,p.rating<1300?'Introductory':p.rating<1850?'Intermediate':'Advanced');
    for(let i=0;i<p.solution.length;i++){
      // Exercise the runtime validator on a deterministic sample; every move in
      // every puzzle still receives full legal replay and admission below.
      if(!(i%2)&&detailed)assert.equal(validatePuzzleMove(p,i,p.solution[i]).status,'correct',p.id+':'+i);
      playUci(c,p.solution[i]);legalPosition(c.fen());
    }
    if(p.themes.includes('mate'))assert.ok(c.isCheckmate(),p.id);
    if(detailed)assert.equal(puzzleExplanation(p).length,p.solution.length);
    quotas[p.theme+':'+p.difficulty]=(quotas[p.theme+':'+p.difficulty]||0)+1;
  }
  assert.equal(Object.keys(quotas).length,36);
  for(const theme of Object.keys(THEME_NAMES))for(const difficulty of ['Introductory','Intermediate','Advanced']){
    const n=quotas[theme+':'+difficulty];assert.ok(n>=12&&n<=1042,theme+':'+difficulty+' = '+n);
    assert.equal(library.selection.groups[theme+difficulty],n);
  }
  assert.ok(library.selection.compressedBytesRead<=library.selection.maxDownloadBytes);
});
test('any legal checkmate wins a mate-in-one puzzle, while illegal moves remain uncounted',()=>{
  const p={fen:'7k/8/5KQ1/8/8/8/8/8 w - - 0 1',solution:['g6g7'],themes:['mateIn1']};
  for(const move of new Chess(p.fen).moves({verbose:true})){
    const c=new Chess(p.fen);c.move(move);if(c.isCheckmate())assert.equal(validatePuzzleMove(p,0,move.lan).status,'correct');
  }
  assert.equal(validatePuzzleMove(p,0,'a1a2').status,'illegal');
  assert.equal(validatePuzzleMove(p,0,'g6g5').status,'incorrect');
});
test('all opening variations have legal annotated moves and reuse named positions from the offline book',()=>{
  assert.equal(OPENINGS.length,12);
  for(const o of OPENINGS){
    assert.ok(o.plans&&o.structure&&o.mistakes&&o.tactic&&o.source);
    assert.ok(o.lines.length>=2);assert.deepEqual(o.colors,['w','b']);
    for(const line of o.lines){assert.equal(line.moves.length,line.notes.length);const {positions}=linePositions(line);assert.ok(positions.slice(1).some(fen=>Array.isArray(book[positionKey(fen)])),o.id);for(const fen of positions)legalPosition(fen);}
  }
});
test('instructional tactical examples distinguish an uncovered attack from a safe gain and replay the Italian king hunt legally',()=>{
  const discovery=LESSONS.find(l=>l.id==='discovery').exercises[0],c=new Chess(discovery.fen);
  playUci(c,'c3d4');assert.equal(c.move('Qxc1+').captured,'r');
  const italian=new Chess();for(const san of 'e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Nxd5 Nxf7 Kxf7 Qf3+'.split(' '))italian.move(san);
  assert.ok(italian.isCheck());assert.equal(italian.get('f7').type,'k');
});
