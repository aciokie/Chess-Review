import {Chess} from './chess.js';

const names={p:'pawn',n:'knight',b:'bishop',r:'rook',q:'queen',k:'king'};
const value={p:1,n:3,b:3,r:5,q:9,k:0};
const square=s=>typeof s==='string'&&/^[a-h][1-8]$/.test(s);
const join=items=>items.length<2?items[0]:items.slice(0,-1).join(', ')+' and '+items.at(-1);

// A bounded presentation pass over the SAME findings as the inspector. No move
// search or engine requests here. Bounded consequence witnesses come from the worker. Relationships join
// only on exact units, targets or a witnessed change caused by the selected move.
export function fastCoachReply(findings,{input,player,change},urgent) {
  let before,after,move;
  try {before=new Chess(input.fen);after=new Chess(input.fen);move=after.move(input.move);}
  catch {return {items:[],perspectiveKnown:true};}
  const actor=move.color,ours=actor===player,other=actor==='w'?'b':'w';
  const owner=color=>color===player?'Your':'Your opponent’s';
  const unit=(s,possessive=true)=>{
    const p=after.get(s);return p?`${possessive?owner(p.color)+' ':''}${names[p.type]} on ${s}`:null;
  };
  const lower=text=>text[0].toLowerCase()+text.slice(1);
  const candidates=[];
  const add=(f,text,score,theme,targets=[],supporting=[],qualifier='')=>{
    if(!f||!text)return;
    const titles={'direct-attack':'New pressure','opened-bishop-diagonal':'An opened bishop line','minor-development':'Development with a purpose','connected-rooks':'Rook coordination','doubled-pawns':'Pawn structure after the move','pawn-chain':'New pawn support','certified-pawn-target-selection':'A concrete pawn target','legal-line-clearance':'An uncovered attack'};
    const index=findings.indexOf(f),item={...f,name:titles[f.event]||f.name,sourceText:f.text,text,rank:score,theme,targets,supporting,index,qualifier,
      perspective:ours?'What your move changes':'What changes for you',moveAnchor:true};
    candidates.push(item);return item;
  };
  const event=id=>findings.find(f=>f.event===id);
  const e=f=>f.context?.evidence||{};
  const development=event('minor-development');
  const developed=development&&unit(move.to);
  const lead=developed?`${developed} enters play and`:null;
  const equalContact=event('development-exchange-contact');
  if(development&&developed){
    const centers=['d4','e4','d5','e5'].filter(s=>after.attackers(s,actor).includes(move.to));
    const rim=move.piece==='n'&&['a','h'].includes(move.to[0]);
    const lesson=rim?' On the rim, a knight has fewer possible destinations than in the center; check whether this route has a concrete purpose.':
      centers.length?' From there it influences '+join(centers)+', '+(centers.length===1?'a central square.':'central squares.'):
      move.piece==='b'?' It leaves the back rank and gains access along its diagonals.':' It leaves the back rank, bringing another piece into the game.';
    const exchange=equalContact?e(equalContact).consequence:null;
    const caution=exchange?' The contact with the '+names[exchange.target.type]+' on '+exchange.target.square+' offers an equal-value exchange after a recapture, rather than an immediate material gain.':'';
    add(development,developed+' develops from '+move.from+'.'+lesson+caution,4800,'development',centers,equalContact?[equalContact]:[]);
  }
  // Urgent rule outcomes, actual mate proofs and defensive certificates retain
  // precedence. Hypothetical turn-flipped patterns are not immediate threats.
  for(const item of urgent.items.filter(i=>i.rank>=7500||['pin','exposure','missed-mate'].includes(i.theme))){
    const copy={...item,index:findings.findIndex(f=>f.event===item.event&&f.text===item.sourceText),qualifier:'',moveAnchor:false};
    if(item.theme==='exposure'&&e(item).target){
      const target=e(item).target,attackers=target.attackers.filter(s=>square(s)&&unit(s));
      copy.text=unit(target.square)+' loses its pawn support and has no geometric defender'+(attackers.length?', while '+join(attackers.map(s=>lower(unit(s))))+(attackers.length===1?' attacks it.':' attack it.') :'.')+' Check the capture and reply before treating it as a material gain.';
      copy.rank=(target.color===player?6900:6200)+value[target.type]*70;
    }
    if(item.event==='absolute-pin'&&square(e(item).blocker)&&square(e(item).slider)&&unit(e(item).slider)){
      copy.text=unit(e(item).blocker)+' is pinned to the king by '+lower(unit(e(item).slider))+'; it cannot leave that line.';
    }
    if(item.event==='saving-piece'&&square(e(item).target)){
      copy.text=`${owner(actor)} ${names[e(item).piece]} retreats to ${e(item).target}, avoiding the immediate capture loss recorded before the move.`;
      copy.targets=[e(item).target];copy.moveAnchor=true;
    }
    candidates.push(copy);
  }
  // Newly added defenses matter when the defended unit was already attacked.
  // Geometric support alone does not certify a safe exchange or erase a threat.
  if(change?.last?.uci===input.move){
    const moved=change.unitChanges?.find(d=>d.after?.square===move.to&&d.after.color===actor);
    for(const d of change.attackChanges||[]){
      const target=after.get(d.target);
      if(!moved||d.color!==actor||!target||target.color!==actor||target.type==='k'||!d.added.includes(moved.id))continue;
      const attackers=before.attackers(d.target,other).filter(s=>before.get(s)?.color===other);
      if(!attackers.length)continue;
      const f=development||event('pawn-chain')||event('defending-piece');if(!f)continue;
      const text=lead?`${lead} also defends the ${names[target.type]} on ${d.target}, which ${actor===player?'your opponent attacks':'you attack'}.`:
        `${unit(move.to)} now defends the ${names[target.type]} on ${d.target}, which ${actor===player?'your opponent attacks':'you attack'}.`;
      const ledger={event:'recorded-move-changes',name:'Recorded changes in defenders',text:move.san+' adds a geometric defense of '+d.target+' by the moved unit '+moved.id+'.',researchStatus:'provisional',scopes:[{occurrence:'E200 (provisional)',scope:'Recorded unit identities and changes in geometric attacks for this legal move. This does not establish a safe exchange or strategic benefit.'}]};
      add(f,text,6400+value[target.type]*50,'defense-added',[d.target],[ledger]);
    }
  }
  for(const f of findings){
    const ev=e(f),id=f.event;
    if(id==='direct-attack'&&square(ev.to)&&ev.to===move.to){
      const targets=(ev.targets||[]).filter(square).filter(s=>after.get(s)?.color===other);
      if(!targets.length)continue;
      targets.sort((a,b)=>value[after.get(b).type]-value[after.get(a).type]);
      const attacked=join(targets.slice(0,3).map(s=>lower(unit(s))));
      const max=Math.max(...targets.map(s=>value[after.get(s).type]));
      const equalExchange=equalContact&&targets.includes(e(equalContact).consequence?.target?.square);
      const loose=findings.filter(u=>u.event==='undefended-unit-observation'&&targets.includes(e(u).target?.square)&&e(u).target.color===other);
      const start=lead?`${lead} also attacks`:`${unit(move.to)} now attacks`;
      const text=`${start} ${attacked}${targets.length>1?' at the same time':''}.`;
      // A routine contact with a guarded pawn rarely gives the learner a
      // decision. Development can still explain the purpose of the placement.
      if(targets.length===1&&max===1&&!loose.length&&!development)continue;
      const qualifier=loose.length?`The ${names[e(loose[0]).target.type]} on ${e(loose[0]).target.square} is undefended; check the replies before taking it.`:'';
      add(f,text,equalExchange?2200:targets.filter(s=>after.get(s).type!=='p').length>1?7600: max>value[after.get(move.to).type]?7100:loose.length?6500:5100+max*80,'attack',targets,loose,qualifier);
    }
    if(id==='certified-pawn-target-selection'){
      const selected=ev.pawnTargets?.[0],capture=selected?.move;
      if(!capture||!square(capture.from)||!square(capture.to)||!unit(capture.from)||after.get(capture.to)?.color!==other||!Number.isFinite(selected.minimumGain)||selected.minimumGain<=0)continue;
      const target=after.get(capture.to);
      const conditional=after.turn()!==actor;
      const timing=conditional?`If ${ours?'you':'your opponent'} could move again in this exact position`:`In this position`;
      const worth=selected.minimumGain===1?'a pawn’s worth of material':`${selected.minimumGain} points of material`;
      const next=conditional?` ${after.turn()===player?'You move':'Your opponent moves'} next and can change that calculation.`:'';
      add(f,`${unit(capture.from)} has a concrete target in the ${names[target.type]} on ${capture.to}.`,6600,'pawn-target',[capture.to],[],
        `${timing}, taking it would gain at least ${worth} after any immediate reply.${next}`);
    }
    if(id==='legal-line-clearance'&&ev.slider&&ev.target){
      const slider=ev.slider,target=ev.target;
      if(!square(slider.square)||!square(target.square)||!unit(slider.square)||after.get(target.square)?.color!==other)continue;
      add(f,`Moving the ${names[move.piece]} from ${move.from} to ${move.to} opens a line for ${lower(unit(slider.square))} to attack ${target.color===player?'your':'your opponent’s'} ${names[target.type]} on ${target.square}.`,5600+value[target.type]*160,'opened-attack',[target.square,slider.square]);
    }
    if(id==='discovered-attack'&&!event('legal-line-clearance')&&square(ev.attacker)&&ev.target&&unit(ev.attacker)){
      add(f,`Moving ${names[move.piece]} from ${move.from} to ${move.to} reveals an attack by ${lower(unit(ev.attacker))} on the ${names[ev.target.type]} on ${ev.target.square}.`,5600+value[ev.target.type]*160,'opened-attack',[ev.target.square,ev.attacker]);
    }
    if(id==='allows-capture'&&typeof ev.capture==='string'&&square(ev.target)){
      const from=ev.capture.slice(0,2),target=after.get(ev.target),attacker=after.get(from);
      if(!target||!attacker||target.color!==actor||attacker.color!==other)continue;
      // Do not elevate every ordinary, defended pawn exchange into a warning.
      const defenders=after.attackers(ev.target,actor);
      if(value[target.type]<=1&&defenders.length)continue;
      add(f,`${owner(actor)} ${names[target.type]} on ${ev.target} is now available to ${lower(unit(from))} for capture${defenders.length?'':' and has no geometric defender'}.`,defenders.length?6200:7800,'exposure',[ev.target],[], 'Check the exchange before assuming that capture wins material.');
    }
    if(id==='pawn-chain'&&ev.newEdges?.length){
      const edge=ev.newEdges.find(x=>square(x.base)&&square(x.head)&&after.get(x.base)?.color===actor&&after.get(x.head)?.color===actor);
      if(!edge)continue;
      const attacked=after.attackers(edge.head,other).length>0;
      add(f,`${owner(actor)} pawn on ${edge.base} now supports the pawn on ${edge.head}${attacked?', which is under attack':''}.`,attacked?6200:3500,'pawn-support',[edge.base,edge.head]);
    }
    if(id==='opened-bishop-diagonal'&&square(ev.bishop)&&ev.line?.length>1&&unit(ev.bishop)){
      add(f,`${ours?'Your move':'Your opponent’s move'} clears ${move.from}, opening the ${ev.line[0]}–${ev.line.at(-1)} diagonal for ${lower(unit(ev.bishop))}.`,3800,'bishop-line',[ev.bishop],[], 'That gives the bishop access to squares along that diagonal.');
    }
    if(id==='connected-rooks'&&ev.squares?.length===2&&ev.squares.every(s=>after.get(s)?.type==='r'&&after.get(s).color===actor)){
      add(f,`${ours?'Your move':'Your opponent’s move'} connects the rooks on ${ev.squares.join(' and ')}: the ${ev.file?'file':'rank'} between them is now clear, so they defend each other.`,4500,'rook-coordination',ev.squares);
    }
    if(['open-file','semi-open-file'].includes(id)&&ev.piece==='r'&&square(ev.square)&&unit(ev.square)){
      add(f,`${unit(ev.square)} enters the ${ev.file}-file, ${id==='open-file'?'where no pawns remain':'where only opposing pawns remain'}.`,4600,'rook-file',[ev.square],[], id==='open-file'?'The file offers a clear pawn-free line for the rook; control of it is not established.':'The opposing pawns are potential targets along that file; a winning attack is not established.');
    }
    if(id==='central-pawn-control'&&square(ev.pawn)&&ev.squares?.length){
      add(f,`${unit(ev.pawn)} also controls ${join(ev.squares)}, ${ev.squares.length===1?'a central square':'central squares'} beyond its own square.`,3700,'central-control',[ev.pawn,...ev.squares]);
    }
    if(id==='queen-bishop-battery'&&square(ev.queen)&&square(ev.bishop)){
      add(f,`${owner(actor)} queen on ${ev.queen} and bishop on ${ev.bishop} now share a clear diagonal, linking their lines of action.`,3100,'battery',[ev.queen,ev.bishop],[], 'The alignment itself does not prove a winning attack.');
    }
    if(id==='queen-rook-battery'&&square(ev.queen)&&square(ev.rook)){
      add(f,`${owner(actor)} queen on ${ev.queen} and rook on ${ev.rook} now align with a clear line between them.`,4300,'battery',[ev.queen,ev.rook],[], 'That alignment is available for coordination; a tactical gain is not established.');
    }
    if(id==='rook-behind-passer'&&square(ev.rook)&&square(ev.pawn)){
      add(f,`${unit(ev.rook)} now sits behind ${ev.pawnColor===player?'your':'your opponent’s'} passed pawn on ${ev.pawn} along the same file.`,4700,'rook-passer',[ev.rook,ev.pawn],[], 'Its line follows the pawn’s path; the observation does not settle whether the pawn can promote.');
    }
    if(id==='doubled-pawns'&&ev.squares?.length>1){
      const squares=ev.squares.filter(s=>after.get(s)?.type==='p'&&after.get(s).color===actor);
      if(squares.length<2)continue;
      add(f,`${ours?'Your move':'Your opponent’s move'} leaves doubled pawns on the ${ev.file}-file: ${squares.join(' and ')} share one file and cannot support each other as a pawn chain.`,4100,'pawn-structure',squares);
    }
    if(id==='isolated-pawn'&&ev.squares?.length){
      const squares=ev.squares.filter(s=>after.get(s)?.type==='p'&&after.get(s).color===actor);if(!squares.length)continue;
      add(f,`${owner(actor)} pawn${squares.length>1?'s':''} on ${join(squares)} ${squares.length>1?'are':'is'} now isolated, with no friendly pawn on either neighboring file.`,4300,'pawn-structure',squares,[], 'Any defense of these pawns must come from pieces; isolation alone does not prove they can be won.');
    }
    if(id==='pawn-tension'&&square(ev.own)&&square(ev.enemy)){
      add(f,`${owner(actor)} pawn on ${ev.own} now confronts ${actor===player?'your opponent’s':'your'} pawn on ${ev.enemy}; the two pawns attack each other.`,4200,'pawn-tension',[ev.own,ev.enemy]);
    }
  }
  // Additional Fast certificates have explicit horizons, rather than relying on
  // category names or free-text keywords to imply tactical importance.
  for(const f of findings){
    const ev=e(f),id=f.event;
    if(ev.pressure?.proven && ['certified-unit-tempo','development-lead-with-threat'].includes(id)&&unit(ev.pressure.target)){
      add(f,`${lead?lead+' also attacks':unit(move.to)+' attacks'} ${lower(unit(ev.pressure.target))}.`,8200,'tempo',[ev.pressure.target],[],
        'This attack needs an answer: ignoring it allows a material gain in the next exchange.');
    }
    if(ev.concession?.proven && ['certified-tempo-concession','repeated-minor-tempo-warning','early-queen-development-warning'].includes(id)){
      const r=ev.concession.reply;if(!r||!square(r.to)||!names[r.piece])continue;
      add(f,`${ours?'Your move':'Your opponent’s move'} permits ${actor===player?'your opponent':'you'} to play ${r.san||r.from+'–'+r.to}, bringing the ${names[r.piece]} into play while attacking ${lower(unit(move.to))}.`,7900,'tempo-concession',[move.to],[],
        'That attack needs an answer or it allows a material gain in the next exchange.');
    }
    if(id==='simplification-material-loss'&&ev.loss){
      const l=ev.loss,from=l.capture?.slice(0,2),to=l.capture?.slice(2,4);
      if(!square(from)||!square(to)||!unit(from)||!unit(to))continue;
      add(f,`${ours?'Your exchange':'Your opponent’s exchange'} allows ${lower(unit(from))} to capture ${lower(unit(to))}.`,8500,'material-loss',[to],[],
        `The exchange ${ours?'costs you':'gains you'} at least ${l.minimumNetLoss} points of material even after any immediate reply. Longer continuations are not covered.`);
    }
    if(id==='conditional-development-constraint'&&ev.restricted?.length){
      const r=ev.restricted[0];if(!r.move||!r.capture||!unit(r.capture.from))continue;
      add(f,`If ${actor===player?'your opponent':'you'} develops the ${names[r.move.piece]} from ${r.move.from} to ${r.move.to}, ${lower(unit(r.capture.from))} could capture it there.`,2400,'development-constraint',[r.move.to],[],
        `The detector certifies at least ${r.net} pawn-value points through every immediate counterreply for that conditional line; it does not show that development is impossible.`);
    }
    const certificates={
      'forced-tactical-liquidation':['Exchanging down', 'every defense permits a capture that leaves a pawn ending or only one non-pawn piece family without nominal material loss.'],
      'profitable-tactical-retreat':['Retreat with a resource', 'the threatened piece retreats, and every defense then permits a capture preserving at least one pawn-value point through the immediate counterreply.'],
      'defensive-material-combination':['Answering check', 'the move escapes check, and every reply permits a capture retaining at least the material balance from before the move.'],
      'forced-material-recovery':['Recovering material', 'the move answers the recorded capture, and every defense permits a capture restoring the pre-loss balance through the immediate counterreply.'],
    };
    if(certificates[id]){const [name,claim]=certificates[id];const c=add(f,`${ours?'For you':'For your opponent'}, ${claim}`,7900,'material-policy',[],[], 'This covers the short capture sequence; it does not establish a lasting advantage.');c.name=name;}
    if(['forcing-check-repetition','checking-draw-fortress'].includes(id))add(f,`${ours?'Your move':'Your opponent’s move'} forces a threefold claim opportunity within the detector’s bounded continuation, with checking moves covering every defense.`,9100,'draw-resource');
    if(id==='forced-own-stalemate-resource')add(f,`${ours?'You':'Your opponent'} can force ${ours?'your own':'their own'} stalemate after this offer within the certified bounded continuation, against every legal defense.`,9100,'draw-resource');
    if(id==='causal-castling-prevention')add(f,`${unit(move.to)} removes a previously legal castling option for ${actor===player?'your opponent':'you'} by attacking its path.`,5700,'castling-prevention');
    if(id==='rook-ending-king-cutoff'&&ev.cutoffs?.length) add(f,`${unit(move.to)} cuts off ${actor===player?'your opponent’s':'your'} king from ${join(ev.cutoffs)}; those previously legal king steps are now unavailable.`,5600,'king-restriction',ev.cutoffs);
    if(id==='no-king-evasion')add(f,`${ours?'Your check':'Your opponent’s check'} leaves no legal king move: ${ours?'your opponent must':'you must'} answer with a capture or a block by another piece.`,7200,'check-defense');
    if(id==='passed-pawn'&&ev.squares?.length)for(const s of ev.squares.filter(s=>after.get(s)?.type==='p'))add(f,`${unit(s)} is now passed: no opposing pawn remains ahead of it on its own or neighboring files.`,4600,'passer',[s],[], 'Pieces can still stop it; a promotion route has not been established.');
    if(id==='rook-seventh'&&ev.squares?.length)add(f,`${owner(actor)} rook on ${ev.squares[0]} reaches ${actor===player?'your opponent’s':'your'} second rank, where it can attack along the rank.`,4600,'rook-entry',ev.squares,[], 'The entry itself does not establish a material gain.');
    if(id==='passed-pawn-blockade'&&square(ev.square)&&square(ev.pawn))add(f,`${unit(ev.square)} blocks the passed pawn on ${ev.pawn} from advancing straight ahead.`,4900,'blockade',[ev.square,ev.pawn],[], 'The blockade is present now; its permanence is not established.');
    if(id==='file-opening'&&ev.file&&!event('open-file'))add(f,`${ours?'Your move':'Your opponent’s move'} opens the ${ev.file}-file: no pawn remains on it, so either side may be able to use it with a rook.`,3600,'open-file');
    if(id==='pawn-ending-transition')add(f,`${ours?'Your capture':'Your opponent’s capture'} removes the last non-pawn piece, leaving a pawn ending. King activity and the pawn races now need attention; this observation does not settle the result.`,4900,'ending');
  }

  for(const f of findings.filter(f=>f.study==='P006')){
    const c=e(f).consequence;if(!c||c.inputFen!==input.fen||c.playedMove!==input.move||c.afterFen!==after.fen())continue;
    const side=c.actor||actor,ourSide=side===player;
    const label=(color,type,s)=>owner(color)+' '+names[type]+' on '+s;
    const targets=(c.targets||[]).map(t=>lower(label(t.color,t.type,t.square)));
    if(f.event==='next-knight-fork'&&targets.length>=2){
      const knight=after.get(c.from);if(knight?.type!=='n'||knight.color!==side)continue;
      const text=c.persists?
        (after.attackers(c.from,actor).includes(move.to)?owner(actor)+' pawn on '+move.to+' attacks the knight, but '+lower(label(side,'n',c.from))+' is still able to jump':'The move leaves '+lower(label(side,'n',c.from))+' able to jump')+' to '+c.to+', forking '+join(targets)+'.':
        label(side,'n',c.from)+' is poised for '+c.san+': '+(c.captured?'taking the '+names[c.captured]+' on '+c.to:'a jump to '+c.to)+' would fork '+join(targets)+'.';
      add(f,text,c.hypothetical?7350:8250,'knight-continuation',[...c.targets.map(t=>t.square),c.from,...(c.captured?[c.to]:[])],[],c.hypothetical?
        (after.turn()===player?'You move first':'Your opponent moves first')+'; check this jump before choosing a reply.':
        'The jump is legal now; check the replies before treating it as a material win.');
    }
    if(f.event==='unplayed-knight-fork'&&targets.length>=2){
      const contact=event('direct-attack'),attacked=(e(contact||{}).targets||[]).filter(s=>after.get(s)?.color!==actor&&after.get(s));
      const text=(ours?'You choose':'Your opponent chooses')+' '+move.san+' instead of the available '+c.san+', which would fork '+join(targets)+'.'+
        (attacked.length?' The knight on '+move.to+' instead attacks '+join(attacked.map(s=>lower(unit(s))))+'.':'');
      add(f,text,7750,'unplayed-fork',c.targets.map(t=>t.square),contact?[contact]:[],
        'Whether the fork wins material still depends on the replies.');
    }
    if(f.event==='immediate-capture-gain'&&c.minimumGain>0){
      add(f,label(actor,move.promotion||move.piece,move.to)+' takes '+(ours?'your opponent’s':'your')+' '+names[c.captured]+' on '+(c.capturedSquare||move.to)+'. '+
        (ours?'You keep':'Your opponent keeps')+' at least '+(c.minimumGain===1?'a pawn’s worth':c.minimumGain+' pawn-value points')+' of the material gain through every immediate reply.',8400,'capture-gain',[move.to],[],
        'This covers the immediate replies; later continuations can change the assessment.');
    }
    if(f.event==='immediate-pawn-offer'&&after.get(c.from)?.color===other){
      add(f,owner(actor)+' pawn push leaves the pawn on '+c.to+' undefended. '+label(other,c.piece,c.from)+' can take it, and '+(ours?'you have':'your opponent has')+' no immediate recapture on '+c.to+'.',8100,'capture-loss',[c.to],[],
        'Compensation or later pawn recovery may still be possible.');
    }
    if(f.event==='immediate-capture-loss'&&c.minimumGain>0&&after.get(c.from)?.color===other){
      add(f,owner(actor)+' move offers the '+names[c.captured]+' on '+c.to+' to '+lower(label(other,c.piece,c.from))+'. After '+c.from+'×'+c.to+', '+
        (ours?'you lose':'you gain')+' at least '+(c.minimumGain===1?'a pawn’s worth':c.minimumGain+' pawn-value points')+' of material through every immediate counterreply.',8490,'capture-loss',[c.to],[],
        'Later recovery or compensation is not ruled out; this explains the immediate material consequence.');
    }
    if(f.event==='opening-pawn-preparation')add(f,owner(actor)+' pawn move to '+c.support+' may prepare '+c.from+'–'+c.to+': the pawn on '+c.support+' would support the advanced d-pawn on '+c.to+'.',4950,'opening-plan',[c.support,c.to],[],
      (after.turn()===player?'You move next':'Your opponent moves next')+' and can respond to that central plan.');
  }

  candidates.sort((a,b)=>b.rank-a.rank||a.index-b.index);
  // Alias certificates contribute evidence, never repeated prose.
  const unique=[];
  for(const item of candidates){const alias=unique.find(c=>c.theme===item.theme&&JSON.stringify(c.targets)===JSON.stringify(item.targets));if(alias)alias.supporting.push(item);else unique.push(item);}
  candidates.splice(0,candidates.length,...unique);
  // One useful lesson per move. Low-value geometry stays in All concepts;
  // separate effects of the same move do not automatically make a better story.
  const first=candidates.find(c=>c.rank>=4100);if(!first)return {items:[],perspectiveKnown:true};
  // Same target: strengthen one explanation with the more precise certificate,
  // not another label. Same move: connect independently witnessed changes without
  // claiming that one caused the other. Unchanged facts never enter this graph.
  if(first.theme==='pawn-target'){
    const contact=candidates.find(c=>c.theme==='attack'&&c.targets.some(t=>first.targets.includes(t)));
    if(contact){first.text=contact.text;first.supporting.push(contact,...contact.supporting);}
  }
  // Conditional timing and short tactical horizons stay in the reply. General
  // positional disclaimers belong beside the original proof, not in every chat.
  if(first.qualifier&&['rook-coordination','rook-file','battery','rook-passer','pawn-structure','passer','rook-entry','blockade'].includes(first.theme)){
    first.proofNote=first.qualifier;first.qualifier='';
  }
  if(first.qualifier)first.text+=' '+first.qualifier;
  for(const c of candidates){const keys=new Set([c.event+':'+c.sourceText]);c.supporting=c.supporting.map(s=>({...s,sourceText:s.sourceText||s.text})).filter(s=>{const k=s.event+':'+s.sourceText;if(keys.has(k))return false;keys.add(k);return true;});}
  const items=[first];
  const target=first.targets[0];
  const lessons={
    'development':equalContact?'Before trading, compare what each side gets from opening that line.':'Before moving this piece again, look for a way to bring another piece into play.',
    'defense-added':`Count the new defender on ${target} before deciding whether to exchange.`,
    'attack':ours?'Look for the opponent’s strongest reply before following up the attack.':'Check whether you can meet the attack while improving a piece of your own.',
    'pawn-target':ours?'Recheck the defenders after the opponent’s reply before taking the pawn.':'Use your move to address the target before that capture becomes available.',
    'opened-attack':`When a piece moves away, check the line it leaves behind as well as its destination.`,
    'exposure':`Before moving a defender, check which pieces will be left under attack.`,
    'capture-loss':'Before committing to a move, calculate the opponent’s captures and your best reply.',
    'material-loss':'Before exchanging, count what remains after the opponent’s capture and your reply.',
    'capture-gain':'When you spot a capture, check the opponent’s replies before counting the gain.',
    'knight-continuation':`Check the knight’s landing square before spending a move chasing it.`,
    'unplayed-fork':'When moving a knight, look for jumps that attack two valuable targets.',
    'tempo':'Before making a quiet move, check which attacks need an immediate answer.',
    'tempo-concession':'Before bringing the queen or a minor piece out, look for developing moves that could attack it.',
    'pin':`A piece pinned to its king may be unable to recapture; check its legal moves before counting it as a defender.`,
    'rook-file':'Look for an entry square along the file and check whether the opponent can contest it.',
    'rook-coordination':'Look for a useful file for the rooks; defending each other is only the starting point.',
    'rook-passer':'Before pushing the passer, check whether the rook’s line will remain clear.',
    'pawn-structure':`Look at how the pawn on ${target} can be defended by pieces, and what those defenders give up elsewhere.`,
    'pawn-tension':'Before exchanging pawns, compare which lines open for both sides.',
    'passer':`Look for the piece blocking ${target} and check how the king or rook could help the pawn advance.`,
    'blockade':'Check whether the blockading piece can be driven away before pushing the pawn.',
    'opening-plan':'Before the central pawn push, check the captures that would become available to both sides.',
    'king-restriction':'In a rook ending, check the king’s route before choosing pawn moves.',
    'ending':'Recount the pawn races and check the king’s route before making another exchange.',
  };
  first.takeaway=lessons[first.theme]||'';
  const titles={'defense-added':'The new defender','pawn-target':'A pawn to keep an eye on','opened-attack':'Look at the line left behind','capture-loss':'Watch the capture','material-loss':'The cost of this exchange','capture-gain':'A capture that holds up','knight-continuation':'Look one knight jump ahead','unplayed-fork':'Another knight jump to consider','tempo':'An attack that needs an answer','tempo-concession':'Developing with a threat','pawn-tension':'Think before releasing the tension','pin':'A restricted defender'};
  first.name=titles[first.theme]||first.name;
  for(const item of items){
    // A teaching synthesis is not a new accepted detector. Keep the status and
    // exact scope of every contributing observation visible in its evidence.
    const sources=[item,...item.supporting];
    item.kind='Coach synthesis — original source scopes below';
    item.researchStatus=sources.some(s=>s.researchStatus==='provisional')?'provisional':item.researchStatus;
    const seen=new Set();item.scopes=sources.flatMap(s=>s.scopes||[]).filter(s=>{const key=s.occurrence+':'+s.scope;if(seen.has(key))return false;seen.add(key);return true;});
  }
  return {items,perspectiveKnown:true};
}
