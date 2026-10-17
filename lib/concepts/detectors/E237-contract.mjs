import {plain} from './E183-plain.mjs';
const obj=x=>x&&typeof x==='object'&&!Array.isArray(x),exact=(x,ks)=>obj(x)&&Object.keys(x).sort().join(',')===ks.sort().join(','),move=x=>typeof x==='string'&&/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(x);
export function validate(input,options){
 plain([input,options]);
 if(!exact(input,['id','source','fen','move',...(input?.history===undefined?[]:['history'])])||!['id','source','fen'].every(k=>typeof input[k]==='string'&&input[k].trim()&&input[k].length<=2048)||!move(input.move))throw Error('Invalid deadline input');
 if(input.history!==undefined&&(!exact(input.history,['fen','moves'])||typeof input.history.fen!=='string'||input.history.fen.length>2048||!Array.isArray(input.history.moves)||input.history.moves.length>1000||!input.history.moves.every(move)))throw Error('Invalid history');
 if(!obj(options)||Object.keys(options).some(k=>!['enabled','maxWork','maxChoices'].includes(k)))throw Error('Invalid controls');
 const enabled=options.enabled??false,maxWork=options.maxWork===undefined?100000:options.maxWork,maxChoices=options.maxChoices===undefined?256:options.maxChoices;
 if(typeof enabled!=='boolean'||!Number.isSafeInteger(maxWork)||maxWork<0||maxWork>100000||!Number.isSafeInteger(maxChoices)||maxChoices<0||maxChoices>256||options.enabled===null)throw Error('Invalid limits');return{enabled,maxWork,maxChoices};
}
export const empty=o=>({schema:'E237-rule-deadline',status:'disabled',reason:null,work:0,limits:{maxWork:o.maxWork,maxChoices:o.maxChoices},claims:{C0600:false,C1075:false,C1076:false},context:null});
