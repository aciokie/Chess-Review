import {legalPosition,uci,VALUES} from './E020-concepts.mjs';
import {validateHistory} from './E024-transitions.mjs';
import {plain} from './E183-plain.mjs';

const squares=Array.from({length:64},(_,i)=>'abcdefgh'[i%8]+(1+Math.floor(i/8)));
const sorted=units=>structuredClone(units).sort((a,b)=>a.id.localeCompare(b.id));
function snapshot(c,units,tick){
  tick();
  const inventory=sorted(units.filter(u=>u.alive)),counts={w:{p:0,n:0,b:0,r:0,q:0,k:0},b:{p:0,n:0,b:0,r:0,q:0,k:0}};
  for(const u of inventory)counts[u.color][u.type]++;
  const value=color=>Object.entries(counts[color]).reduce((n,[t,k])=>n+VALUES[t]*k,0);
  const attacks=[];
  for(const color of ['w','b'])for(const target of squares){
    tick();attacks.push({color,target,from:c.attackers(target,color).map(s=>inventory.find(u=>u.square===s&&u.color===color).id).sort()});
  }
  const [placement,turn,castling,enPassant,halfmove,fullmove]=c.fen().split(' ');
  const legal=c.moves({verbose:true}).map(m=>({uci:uci(m),check:/[+#]/.test(m.san),capture:!!m.captured})).sort((a,b)=>a.uci.localeCompare(b.uci));
  return {fen:c.fen(),units:sorted(units),inventory,material:{counts,nominal:{w:value('w'),b:value('b'),whiteMinusBlack:value('w')-value('b')}},
    fields:{placement,turn,castling,enPassant,halfmove:+halfmove,fullmove:+fullmove},
    rules:{check:c.isCheck(),checkmate:c.isCheckmate(),stalemate:c.isStalemate(),insufficientMaterial:c.isInsufficientMaterial(),fiftyMoveClaim:c.isDrawByFiftyMoves(),threefoldClaim:c.isThreefoldRepetition(),libraryGameOver:c.isGameOver()},
    legal:{actor:c.turn(),moves:legal.map(m=>m.uci),checks:legal.filter(m=>m.check).map(m=>m.uci),captures:legal.filter(m=>m.capture).map(m=>m.uci)},attacks};
}
export function lastMoveChanges(input){
  plain(input);if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Expected input object');
  const enabled=input.enabled===undefined?true:input.enabled;if(typeof enabled!=='boolean')throw Error('enabled must be boolean');
  const limit=input.maxChangeNodes===undefined?10000:input.maxChangeNodes;
  if(!Number.isSafeInteger(limit)||limit<0||limit>100000)throw Error('maxChangeNodes must be integer0..100000');
  let nodes=0;
  const done=(status,answer=null)=>({schema:'coach-last-recorded-change-E200',status,limit,nodes,answer});
  if(!enabled)return done('disabled');
  if(input.history===undefined)return done('unavailable');
  const h=input.history;
  if(!h||typeof h.fen!=='string'||!Array.isArray(h.moves)||h.moves.length>1000||typeof input.fen!=='string')throw Error('Invalid history interface');
  const tick=(n=1)=>{if(nodes+n>limit){nodes=limit;throw Error('change-budget');}nodes+=n;};
  try{
    tick(h.moves.length+1);const validated=validateHistory(input);
    if(!validated.moves.length)return done('unavailable');
    const c=legalPosition(validated.start),units=c.board().flat().filter(Boolean).map(p=>({id:p.color+p.type+p.square,color:p.color,originalType:p.type,type:p.type,square:p.square,alive:true}));
    let before,last;
    for(let i=0;i<validated.moves.length;i++){
      tick();const code=validated.moves[i],m=c.moves({verbose:true}).find(m=>uci(m)===code);
      if(i===validated.moves.length-1)before=snapshot(c,units,tick);
      const mover=units.find(u=>u.alive&&u.square===m.from),victimSquare=m.isEnPassant()?m.to[0]+m.from[1]:m.to;
      const victim=units.find(u=>u.alive&&u.color!==m.color&&u.square===victimSquare);
      if(victim)victim.alive=false;
      mover.square=m.to;mover.type=m.promotion||mover.type;
      let rook=null;
      if(m.isKingsideCastle()||m.isQueensideCastle()){
        const from=(m.isKingsideCastle()?'h':'a')+m.from[1],to=(m.isKingsideCastle()?'f':'d')+m.from[1];
        const unit=units.find(u=>u.alive&&u.square===from&&u.color===m.color&&u.type==='r');
        if(!unit)throw Error('Missing original castling rook');unit.square=to;rook={id:unit.id,from,to};
      }
      c.move(code);last={uci:code,san:m.san,color:m.color,unit:mover.id,from:m.from,to:m.to,piece:m.piece,promotion:m.promotion||null,captured:victim?{id:victim.id,type:victim.type,square:victimSquare}:null,castlingRook:rook};
    }
    const after=snapshot(c,units,tick);tick();
    const attackChanges=after.attacks.flatMap((a,i)=>{const b=before.attacks[i],added=a.from.filter(id=>!b.from.includes(id)),removed=b.from.filter(id=>!a.from.includes(id));return added.length||removed.length?[{color:a.color,target:a.target,added,removed}]:[];});
    const unitChanges=after.units.filter((u,i)=>JSON.stringify(u)!==JSON.stringify(before.units[i])).map(u=>({id:u.id,before:before.units.find(v=>v.id===u.id),after:u}));
    return done('answered',{id:'C1060',history:{fen:legalPosition(validated.start).fen(),moves:validated.moves},last,before,after,unitChanges,attackChanges,
      boundaries:{frame:'last-recorded-move',geometry:'pinned attacks included; no legal recapture or favorable-change inference',repetition:'supplied starting position and recorded continuation only',legalOptions:'each frame has its actual side to move; not a same-player comparison',evaluation:'strategic consequences and usefulness unavailable'}});
  }catch(e){if(e.message!=='change-budget')throw e;return done('exhausted');}
}
