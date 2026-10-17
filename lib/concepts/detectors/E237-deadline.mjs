import {Chess} from '../../chess.js';
import {uci} from './E020-concepts.mjs';
import {actual,outcome,key} from './E210-rules.mjs';
import {validate,empty} from './E237-contract.mjs';
export function inspectDeadline(input,options={}){
 const o=validate(input,options),r=empty(o);if(!o.enabled)return r;
 const exhaust=reason=>({...r,status:'budget-unavailable',reason,work:o.maxWork+1});
 if(!input.history){r.status='unavailable';r.reason='history-prerequisite';return r;}
 const minimum=133+input.history.moves.length;if(minimum>o.maxWork)return exhaust('logical-work-cap');
 const {c,counts}=actual(input),before=c.fen(),actor=c.turn(),terminal=outcome(c,counts,null);r.work=minimum;
 if(terminal){r.status='unavailable';r.reason=terminal;return r;}
 const choices=c.moves({verbose:true}).map(uci).sort();if(!choices.includes(input.move))throw Error('Illegal actual');
 if(+before.split(' ')[4]!==149){r.status='not-established';r.reason='not-final-reversible-ply';return r;}
 if(choices.length>o.maxChoices)return exhaust('choice-domain-cap');const charge=minimum+260*choices.length;if(charge>o.maxWork)return exhaust('logical-work-cap');r.work=charge;
 const lowerFields=before.split(' ');lowerFields[4]='148';const lowerRoot=lowerFields.join(' '),rows=[];
 for(const move of choices){const b=new Chess(before),m=b.move(move),n=new Map(counts);n.set(key(b),(n.get(key(b))??0)+1);const end=outcome(b,n,null),low=new Chess(lowerRoot);low.move(move);const lowEnd=outcome(low,n,null);rows.push({move,after:b.fen(),zeroing:m.piece==='p'||Boolean(m.captured),terminal:end,value:end==='mate'?'win':end?'draw':'live',legalResponses:b.moves({verbose:true}).map(uci).sort(),lowerAfter:low.fen(),lowerTerminal:lowEnd});}
 const mates=rows.filter(x=>x.terminal==='mate').map(x=>x.move),clockDraws=rows.filter(x=>x.terminal==='automatic-seventy-five'&&x.lowerTerminal===null).map(x=>x.move),other=rows.filter(x=>x.terminal!=='mate'),temporal=mates.length>0&&clockDraws.length>0&&other.every(x=>!x.zeroing&&['board-draw','automatic-seventy-five'].includes(x.terminal)),converted=temporal&&mates.includes(input.move);
 r.claims={C0600:temporal,C1075:temporal,C1076:converted};r.status=temporal?'proven':'not-established';
 r.context={actor,before,actual:input.move,rows,mates,clockDraws,windowPlies:1,measure:'immediate forced win versus automatic draw',expiry:'every nonmating ordinary move terminates as draw',counterfactual:'Same board and legal action with reversible counter 148; live does not assert a win.',optionalOwnDrawClaim:'May be declined; choosing a valid claim draws instead.',knownRootOccurrences:counts.get(key(c))??0,priorHistoryComplete:input.history.fen===new Chess().fen(),ongoingRootAssumption:'Conditional on the supplied root being ongoing; incomplete prior history cannot exclude earlier adjudication or unrecorded automatic repetition.',actualGameAdjudicationClaim:false,generalStrategicValueClaim:false,mentalStateClaim:false,freshSearches:0};return r;
}
