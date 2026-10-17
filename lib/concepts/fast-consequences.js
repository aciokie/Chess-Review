import {Chess} from '../chess.js';
import {certifyCapture} from './detectors/E022-tactics.mjs';
import {turnBoard} from './detectors/E027-defense.mjs';
import {conceptEnabled,selectedGroups,isFastSelection} from './controls.js';
const points={p:1,n:3,b:3,r:5,q:9,k:0},names={p:'pawn',n:'knight',b:'bishop',r:'rook',q:'queen',k:'king'};
const uci=m=>m.from+m.to+(m.promotion||'');
const unit=(board,s)=>({...board.get(s),square:s});
// Small local teaching witnesses, not new research acceptance. Geometry never
// becomes a winning-fork claim. Capture certificates reuse the admitted finite
// proof and cover EVERY immediate reply; a hard work cap cannot imply absence.
export function inspectFastConsequences(input) {
  if(!isFastSelection(input))return {events:[],status:'disabled',nodes:0};
  const before=new Chess(input.fen),after=new Chess(input.fen),played=after.move(input.move),actor=played.color,enemy=actor==='w'?'b':'w',groups=selectedGroups(input);
  const events=[],stages=[];
  const add=(id,detail,text)=>{if(conceptEnabled(input,id))events.push({id,text,qualityClaim:false,integrationStudy:'P006',evidence:{actor,detail:{...detail,inputFen:input.fen,playedMove:input.move,afterFen:after.fen()}}});};
  let nodes=0,forkNodes=0;
  const forkLimit=48;
  const proof=(root,board,move)=>{
    let used=0;try{return certifyCapture(root,board,move,{tick(){nodes++;if(++used>128)throw Error('immediate-capture-budget');}});}
    catch(error){if(error.message!=='immediate-capture-budget')throw error;stages.push({detector:'P006-capture',status:'exhausted',nodes:used});return null;}
  };
  if(groups.includes('immediate')){
    let recapture=false;
    if(played.captured&&conceptEnabled(input,'immediate-capture-gain')&&input.history?.moves.length){
      const replay=new Chess(input.history.fen);for(const code of input.history.moves)replay.move(code);
      const prior=replay.history({verbose:true}).at(-1);recapture=replay.fen()===input.fen&&prior?.captured&&prior.to===played.to;
    }
    if(played.captured&&!recapture&&conceptEnabled(input,'immediate-capture-gain')){
      const p=proof(before,after,played);
      if(p)add('immediate-capture-gain',{move:uci(played),from:played.from,to:played.to,piece:played.piece,captured:played.captured,capturedSquare:played.isEnPassant()?played.to[0]+played.from[1]:played.to,minimumGain:p.minimumGain,replies:p.witnesses,horizon:1},`${played.san} gains at least ${p.minimumGain} nominal material through every immediate legal reply; later continuations remain unresolved.`);
    }
    if(conceptEnabled(input,'immediate-capture-loss')||conceptEnabled(input,'immediate-pawn-offer')){
      const candidates=after.moves({verbose:true}).filter(m=>m.captured&&m.to===played.to);
      if(candidates.length>4)stages.push({detector:'P006-offers',status:'exhausted',nodes:4});
      const offers=candidates.slice(0,4);
      for(const capture of offers){const root=new Chess(after.fen());after.move(capture);let p;try{p=conceptEnabled(input,'immediate-capture-loss')?proof(root,after,capture):null;}finally{after.undo();}
        if(!p&&played.piece==='p'&&!after.attackers(played.to,actor).length&&conceptEnabled(input,'immediate-pawn-offer')){
          after.move(capture);let recover;try{recover=after.moves({verbose:true}).some(m=>m.captured&&m.to===capture.to);}finally{after.undo();}
          if(!recover)add('immediate-pawn-offer',{capture:uci(capture),from:capture.from,to:capture.to,piece:capture.piece,captured:'p'},`The pawn on ${played.to} can be captured by ${capture.san}, with no legal immediate recapture on that square. Other counterplay and later recovery remain unresolved.`);
        }
        const net=p?p.minimumGain-(points[played.captured]||0)-(played.promotion?points[played.promotion]-1:0):null;
        if(net>0)add('immediate-capture-loss',{capture:uci(capture),from:capture.from,to:capture.to,piece:capture.piece,captured:capture.captured,minimumGain:net,captureGain:p.minimumGain,replies:p.witnesses,horizon:1},`${played.san} permits ${capture.san}, retaining at least ${net} nominal enemy net material gain from before the played move through every immediate counterreply; later recovery remains unresolved.`);
      }
    }
    const forks=(position,color,from=null)=>{
      // A flipped turn is only a labelled diagram; don't generate one in check.
      if(position.turn()!==color&&position.isCheck())return [];
      const board=position.turn()===color?new Chess(position.fen()):turnBoard(position,color),patterns=[];
      const candidates=board.moves({verbose:true}).filter(m=>m.piece==='n'&&(!from||from.includes(m.from)));
      for(const m of candidates){
        if(++forkNodes>forkLimit){if(!stages.some(s=>s.detector==='P006-knight'))stages.push({detector:'P006-knight',status:'exhausted',nodes:forkNodes});break;}
        nodes++;board.move(m);try{
        const targets=board.board().flat().filter(p=>p&&p.color!==color&&'nbrqk'.includes(p.type)&&board.attackers(p.square,color).includes(m.to)).map(p=>({square:p.square,type:p.type,color:p.color}));
        // Focus Fast on concrete high-value pairs rather than every two contacts.
        if(targets.length>=2&&(targets.some(p=>p.type==='q')&&targets.some(p=>['r','k'].includes(p.type))))
          if(!board.moves({verbose:true}).some(reply=>reply.captured==='n'&&reply.to===m.to))patterns.push({actor:color,move:uci(m),san:m.san,from:m.from,to:m.to,captured:m.captured||null,targets,hypothetical:position.turn()!==color});
      }finally{board.undo();}}
      return patterns;
    };
    if(conceptEnabled(input,'next-knight-fork')&&['p','n'].includes(played.piece)){
      // Persistent forks can only be taught here for a pawn chasing a knight
      // or the knight moved on the previous turn. Other pieces add no finding.
      const relevant=played.piece==='p'?after.board().flat().filter(p=>p?.type==='n'&&p.color===enemy&&(after.attackers(p.square,actor).includes(played.to)||input.history?.moves.at(-1)?.slice(2,4)===p.square)).map(p=>p.square):[];
      const oldEnemy=relevant.length?forks(before,enemy,relevant):[],nextEnemy=relevant.length?forks(after,enemy,relevant):[];
      for(const pattern of nextEnemy.filter(p=>oldEnemy.some(o=>o.move===p.move&&JSON.stringify(o.targets)===JSON.stringify(p.targets))).slice(0,2))
        add('next-knight-fork',{...pattern,persists:true},`The legal ${pattern.san} attacks ${pattern.targets.map(p=>names[p.type]+' '+p.square).join(' and ')}; the played move leaves this knight-jump pattern available. A material gain is not certified.`);
      if(played.piece==='n')for(const pattern of forks(after,actor,[played.to]).slice(0,2))
        add('next-knight-fork',pattern,`In an actor-turn diagram ${pattern.san} attacks ${pattern.targets.map(p=>names[p.type]+' '+p.square).join(' and ')}. The defender moves first; no forced gain is established.`);
    }
    if(played.piece==='n'&&conceptEnabled(input,'unplayed-knight-fork')){
      const alternatives=forks(before,actor,[played.from]).filter(p=>p.move!==input.move);
      if(alternatives.length){const pattern=alternatives[0];add('unplayed-knight-fork',pattern,`${played.san} chooses a different knight jump from the available ${pattern.san}, which would attack ${pattern.targets.map(p=>names[p.type]+' '+p.square).join(' and ')}. This is a missed pattern, not a best-move or winning-fork certificate.`);}
    }
  }
  if(groups.includes('features')){
    if(conceptEnabled(input,'opening-pawn-preparation')&&played.piece==='p'&&input.history?.fen===new Chess().fen()&&input.history.moves.length<12&&played.from==='c'+(actor==='w'?'2':'7')&&played.to==='c'+(actor==='w'?'3':'6')){
      const from='d'+(actor==='w'?'2':'7'),to='d'+(actor==='w'?'4':'5'),frame=turnBoard(after,actor);
      if(frame.moves({verbose:true}).some(m=>m.from===from&&m.to===to)&&frame.attackers(to,actor).includes(played.to))
        add('opening-pawn-preparation',{from,to,support:played.to,actor,hypothetical:true},`The c-pawn move may prepare ${from}–${to}: the advanced d-pawn would be supported from ${played.to}. This is a legal conditional plan, not an inferred intention or a best-move claim.`);
    }
    if(conceptEnabled(input,'development-exchange-contact')&&['n','b'].includes(played.piece)&&input.history?.moves.length<16){
      const frame=turnBoard(after,actor);
      for(const capture of frame.moves({verbose:true}).filter(m=>m.from===played.to&&m.captured&&points[m.captured]===points[m.piece]&&m.to[1]===(enemy==='w'?'1':'8'))){
        frame.move(capture);try{const recapture=frame.moves({verbose:true}).find(m=>m.to===capture.to&&m.captured===capture.piece);
          if(recapture)add('development-exchange-contact',{capture:uci(capture),target:unit(after,capture.to),recapture:uci(recapture)},`${capture.san} would allow ${recapture.san}, exchanging equal-value minor pieces. The contact alone does not establish a useful opening capture.`);
        }finally{frame.undo();}
      }
    }
  }
  return {events,stages,status:stages.length?'exhausted':'complete',nodes};
}
