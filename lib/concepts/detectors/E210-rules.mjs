import {legalPosition,uci} from './E020-concepts.mjs';
export const key=c=>c.fen().split(' ').slice(0,4).join(' ');
export function outcome(c,counts,actor){
 if(c.isCheckmate())return'mate';
 if(c.isStalemate()||c.isInsufficientMaterial())return'board-draw';
 const n=counts.get(key(c))||0,half=+c.fen().split(' ')[4];
 if(n>=5)return'automatic-fivefold';if(half>=150)return'automatic-seventy-five';
 if(c.turn()===actor&&n>=3)return'actor-threefold-claim';
 if(c.turn()===actor&&half>=100)return'actor-fifty-claim';return null;
}
export function actual(input){
 const h=input.history;if(!h)return null;
 if(!h||typeof h.fen!=='string'||!Array.isArray(h.moves)||h.moves.length>1000)throw Error('Invalid actual history');
 const c=legalPosition(h.fen),counts=new Map();const add=()=>counts.set(key(c),(counts.get(key(c))||0)+1);add();
 for(const move of h.moves){const end=outcome(c,counts,null);if(end)throw Error('History continues an automatic terminal');if(typeof move!=='string'||!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)||!c.moves({verbose:true}).some(m=>uci(m)===move))throw Error('Illegal actual history move');c.move(move);add();}
 if(c.fen()!==legalPosition(input.fen).fen())throw Error('Actual history endpoint mismatch');return{c,counts};
}
