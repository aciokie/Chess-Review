import {legalPosition,uci} from './E020-concepts.mjs';
import {validateHistory} from './E024-transitions.mjs';
import {plain} from './E183-plain.mjs';
import {inspectDecisionSupport} from './E189-support.mjs';

export function inspectChecksCapturesThreats(input,options={},panel){
  plain(input);plain(options);
  if(!input||typeof input!=='object'||Array.isArray(input)||!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!['enabled','plies','maxNodes'].includes(k)))throw Error('Invalid question interface');
  const enabled=options.enabled===undefined?false:options.enabled,H=options.plies===undefined?1:options.plies,limit=options.maxNodes===undefined?50000:options.maxNodes;
  if(typeof enabled!=='boolean'||!Number.isSafeInteger(H)||H<0||H>2||!Number.isSafeInteger(limit)||limit<0||limit>50000)throw Error('Invalid question controls');
  const r={schema:'E201-check-capture-threat-question',status:'disabled',limit,plies:H,nodes:0,answer:null,panel:null};
  if(!enabled)return r;
  const exhausted=()=>({...r,status:'exhausted',nodes:limit+1,answer:null,panel:null});
  if(input.history!==undefined&&(!input.history||typeof input.history.fen!=='string'||!Array.isArray(input.history.moves)||input.history.moves.length>1000))throw Error('Invalid supplied history');
  const L=input.history?.moves.length||0;if(L+1>limit)return exhausted();
  const h=validateHistory(input),c=legalPosition(h?.start||input.fen);for(const move of h?.moves||[])c.move(move);
  if(c.isGameOver())return {...r,status:'not-live',nodes:L+1};
  const legal=c.moves({verbose:true}).sort((a,b)=>uci(a).localeCompare(uci(b))),setup=2+L+legal.length;
  if(setup>limit)return exhausted();r.nodes=setup;r.status='answered';
  const moves=legal.map(m=>({move:uci(m),san:m.san,from:m.from,to:m.to,piece:m.piece,captured:m.captured||null,promotion:m.promotion||null,enPassant:m.isEnPassant(),check:/[+#]/.test(m.san),mate:m.san.includes('#')}));
  const threats={status:!h?'history-prerequisite':panel===undefined?'panel-prerequisite':'pending',continuationPlies:H,totalPliesIncludingCandidate:H+1,resources:[],candidateOutcomes:[],notCertifiedGeneralThreats:moves.map(m=>m.move),generalThreatCompleteness:false};
  r.answer={id:'C1061',fen:c.fen(),actor:c.turn(),historyKnown:!!h,moves,checks:moves.filter(m=>m.check).map(m=>m.move),captures:moves.filter(m=>m.captured).map(m=>m.move),threats};
  if(!h||panel===undefined)return r;
  // A legal representative satisfies the source interface only. Every candidate
  // is classified; neither input.move nor this representative is a user choice.
  const sourceInput={fen:input.fen,history:input.history,move:moves[0].move},source=inspectDecisionSupport(sourceInput,{enabled:true,plies:H,maxNodes:limit-setup},panel);
  if(source.status==='exhausted')return exhausted();
  r.nodes+=source.nodes;r.panel=source.panel;
  if(source.status==='claim-rule-prerequisite'){threats.status=source.status;return r;}
  if(!source.witness)throw Error('Source did not supply a complete candidate domain');
  threats.status='bounded-domain-answered';
  threats.candidateOutcomes=source.witness.choices.map((q,index)=>({move:q.move,after:q.after,role:q.role,proofRow:index}));
  threats.resources=source.witness.shortlist.map(move=>{const index=source.panel.rows.findIndex(q=>q.move===move),row=source.panel.rows[index];return {move,san:row.san,after:row.after,kind:row.mate?'immediate-mate':row.check?'checking-mating-continuation':row.capture?'capture-mating-threat':'quiet-mating-threat',proofRow:index};});
  threats.notCertifiedGeneralThreats=moves.filter(m=>!source.witness.shortlist.includes(m.move)).map(m=>m.move);
  return r;
}
