import {isDeepStrictEqual} from '../assert.js';
import {controls,prepare} from './E189-context.mjs';
import {verifyPanel} from './E143-check-witness.mjs';
import {plain} from './E183-plain.mjs';
const admitted=[];
export function inspectDecisionSupport(input,options={},panel){
 const o=controls(input,options),r={schema:'E189-decision-support-v1',limit:o.limit,plies:o.H,nodes:0,status:'disabled',claims:{C0788:false,C0799:false,C0803:false},qualityClaim:false,witness:null,panel:null};if(!o.enabled)return r;
 const x=prepare(input);r.status=x.status;if(x.status!=='ready')return r;const exhausted=()=>({...r,nodes:o.limit+1,status:'exhausted'});if(x.setup>o.limit)return exhausted();if(panel===undefined)return{...r,nodes:x.setup,status:'panel-prerequisite'};
 plain(panel);if(!panel||!Number.isSafeInteger(panel.nodes)||panel.nodes<0||!Array.isArray(panel.rows))throw Error('Require complete mate panel');const cost=x.setup+panel.nodes+panel.rows.length;if(cost>o.limit)return exhausted();
 const key=[input.fen,input.history,o.H,panel];let admission=admitted.find(s=>isDeepStrictEqual(s.key,key));if(!admission){const v=verifyPanel({...input,forcingTempoPlies:o.H},panel);admission={key:structuredClone(key),claim:v.claimContext,nodes:v.nodes};admitted.push(admission);}
 r.nodes=x.setup+admission.nodes+panel.rows.length;r.panel=structuredClone(panel);if(admission.claim)return{...r,status:'claim-rule-prerequisite'};
 const actor=x.c.turn(),enemy=actor==='w'?'b':'w',choices=[],shortlist=[],certifiedLosses=[],mechanicalDraws=[],unresolved=[];
 for(const row of panel.rows){x.c.move(row.move);let role,winner=null;if(row.actor.tree.win){role='actor-mate';winner=actor;shortlist.push(row.move);}else if(row.opponent.tree.win){role='opponent-mate';winner=enemy;certifiedLosses.push(row.move);}else if(x.c.isStalemate()||x.c.isInsufficientMaterial()){role='mechanical-draw';mechanicalDraws.push(row.move);}else{role='unresolved-within-bound';unresolved.push(row.move);}choices.push({move:row.move,after:x.c.fen(),role,winner});x.c.undo();}
 const actual=choices.find(q=>q.move===input.move);if(!actual)throw Error('Missing actual choice');let evaluation=null;if(o.view&&actual.winner)evaluation={frame:'after-actual',fen:actual.after,perspective:o.view.perspective,winner:actual.winner,outcome:actual.winner===o.view.perspective?'winning':'losing',continuationPlies:o.H,proofSide:actual.role==='actor-mate'?'actor':'opponent'};
 r.claims={C0788:shortlist.length>0,C0799:evaluation!==null,C0803:shortlist.length>0&&certifiedLosses.length>0};r.witness={actor,before:panel.before,after:actual.after,choices,shortlist,certifiedLosses,mechanicalDraws,unresolved,evaluation,stakes:{frame:'before-actual',actorOptions:[...shortlist],opponentOptions:[...certifiedLosses],continuationPlies:o.H}};r.status=Object.values(r.claims).some(Boolean)?'proven':'compared';return r;
}
