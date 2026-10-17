import {plain} from './E183-plain.mjs';
import {inspectChecksCapturesThreats} from './E201-question.mjs';

export function inspectOpponentResources(input,options={},panel){
  plain(input);plain(options);
  if(!input||typeof input!=='object'||Array.isArray(input)||!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!['enabled','perspective','plies','maxNodes'].includes(k)))throw Error('Invalid opponent question controls');
  const enabled=options.enabled===undefined?false:options.enabled,player=options.perspective,H=options.plies===undefined?1:options.plies,limit=options.maxNodes===undefined?50000:options.maxNodes;
  if(typeof enabled!=='boolean'||player!==undefined&&!['w','b'].includes(player)||enabled&&player===undefined||!Number.isSafeInteger(H)||H<0||H>2||!Number.isSafeInteger(limit)||limit<0||limit>50000)throw Error('Require explicit w/b player and valid opponent question controls');
  const r={schema:'E202-opponent-resource-perspectives',status:'disabled',limit,plies:H,perspective:player??null,nodes:0,answer:null,source:null};
  const exhausted=()=>({...r,status:'exhausted',nodes:limit+1});
  if(!enabled)return r;if(!limit)return exhausted();
  const source=inspectChecksCapturesThreats(input,{enabled:true,plies:H,maxNodes:limit-1},panel);
  if(source.status==='exhausted')return exhausted();
  r.nodes=1+source.nodes;
  if(!source.answer)return {...r,status:source.status,source:structuredClone(source)};
  if(r.nodes+source.answer.moves.length>limit)return exhausted();r.nodes+=source.answer.moves.length;r.source=structuredClone(source);
  const opponent=player==='w'?'b':'w',ownTurn=source.answer.actor===player,t=source.answer.threats;
  const answer={id:'C1059',player,opponent,frame:{fen:source.answer.fen,actor:source.answer.actor,mode:ownTurn?'after-each-own-candidate':'opponent-to-act-now'},
    evidenceStatus:t.status,intent:'unavailable; resources do not establish what a player privately wants',resources:[],candidateReplies:[],uncertifiedCandidates:source.answer.moves.map(m=>m.move),generalThreatCompleteness:false};
  r.answer=answer;r.status=t.status==='bounded-domain-answered'?'answered':'unavailable';
  if(r.status==='unavailable')return r;
  if(!ownTurn){
    answer.resources=t.resources.map(q=>({enemyMove:q.move,san:q.san,fromFen:answer.frame.fen,afterEnemyMove:q.after,winner:opponent,kind:q.kind,totalPlies:H+1,proofRow:q.proofRow,querySide:'actor'}));
    answer.uncertifiedCandidates=[...t.notCertifiedGeneralThreats];
  }else{
    answer.candidateReplies=source.panel.rows.map((row,index)=>{
      let resource=null;
      if(row.opponent.tree.win){
        if(row.opponent.tree.kind!=='choice')throw Error('Expected actual enemy-to-act winning choice');
        resource={enemyMove:row.opponent.tree.move,fromFen:row.after,winner:opponent,continuationPlies:H,proofRow:index,querySide:'opponent'};
      }
      return {ownMove:row.move,afterOwnMove:row.after,enemyToMove:opponent,status:resource?'certified-enemy-mate':'not-certified-within-bound',resource};
    });
    answer.uncertifiedCandidates=answer.candidateReplies.filter(q=>!q.resource).map(q=>q.ownMove);
  }
  return r;
}
