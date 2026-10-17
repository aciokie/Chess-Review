import {legalPosition,uci} from './E020-concepts.mjs';
import {validateHistory} from './E024-transitions.mjs';
import {plain} from './E183-plain.mjs';
export function controls(input,options={}){
 plain(input);plain(options);if(!input||typeof input!=='object'||Array.isArray(input)||!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!['enabled','plies','maxNodes','view'].includes(k)))throw Error('Invalid decision-support controls');
 const enabled=options.enabled===undefined?false:options.enabled,H=options.plies===undefined?1:options.plies,limit=options.maxNodes===undefined?50000:options.maxNodes;
 if(typeof enabled!=='boolean'||!Number.isSafeInteger(H)||H<0||H>2||!Number.isSafeInteger(limit)||limit<0||limit>50000)throw Error('Invalid decision-support controls');
 const v=options.view;if(v!==undefined&&(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['frame','perspective'].includes(k))||v.frame!=='after-actual'||!['w','b'].includes(v.perspective)))throw Error('Require explicit after-actual frame and w/b perspective');return{enabled,H,limit,view:v};
}
export function prepare(input){
 if(typeof input.fen!=='string'||typeof input.move!=='string'||!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(input.move))throw Error('Require FEN and actual UCI');
 const h=validateHistory(input),c=legalPosition(h?.start||input.fen);for(const m of h?.moves||[])c.move(m);if(c.isGameOver())return{status:'not-live'};
 if(!c.moves({verbose:true}).some(m=>uci(m)===input.move))throw Error('Actual must be legal');if(!h)return{status:'history-prerequisite'};return{status:'ready',c,setup:2+h.moves.length};
}
