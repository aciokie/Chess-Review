import {isFastSelection} from './concepts/controls.js';
import {fastCoachReply} from './fast-coach.js';

// Presentation policy only: ranks every accepted finding without changing its proof.
const terminal = new Set(['checkmate', 'stalemate', 'insufficient-material']);
const forcing = /forced-mate|missed-mate|mate-in-one|unique-mate-defense|quiet-mating|mating-combination|mating-decoy|sacrifice|attraction-combination|decoy-combination|blocking-combination|pawn-shield-defense/;
const tactical = /fork|skewer|pin|overloaded|defender|saving-piece|defending-piece|eliminating-attacker|counterattack|intermediate|desperado|double-attack|double-check|discovered-check|square-clearance|interference-combination|trapped|dominated|octopus/;
const defense = /defensive|active-defense|luft|stalemate|promotion-route|safe-promotion|pawn-race|king-promotion|waiting-move|reserve-pawn-tempo/;
const activity = /outpost|invasion|penetration|rook-swing|battery|open-file|semi-open|rook-seventh|two-rooks-seventh|development|centralized|bishop/;
const structure = /pawn|chain|majority|space|stonewall|maroczy|carlsbad|hedgehog|scheveningen|closed-file|blocked-position/;

export function insightPriority(event) {
  if (terminal.has(event)) return {rank: 900, category: 'Game result'};
  if (['repetition-claim', 'fifty-move-claim'].includes(event)) return {rank: 850, category: 'Available draw claim'};
  if (forcing.test(event)) return {rank: 800, category: 'Forcing continuation'};
  if (tactical.test(event)) return {rank: 700, category: 'Tactical detail'};
  if (defense.test(event)) return {rank: 600, category: 'Defensive resource'};
  if (event === 'check') return {rank: 550, category: 'Check'};
  if (activity.test(event)) return {rank: 400, category: 'Piece activity'};
  if (structure.test(event)) return {rank: 300, category: 'Pawn structure'};
  return {rank: 100, category: 'Position fact'};
}

// Research templates address the mover as "you". On an opponent move, swap both
// sides in one pass. They/their preserves verb agreement and past-tense claims.
export function playerText(text, mover, player) {
  if (mover === player) return text;
  const swapped = text.replace(/\byour opponent(?:[’']s)?\b|\bthe opponent(?:[’']s)?\b|\bopponent(?:[’']s)?\b|\b(?:the )?enemy (?:king|queen|rook|bishop|knight|pawn|position)s?\b|\b(?:for|against|to|with|leave|leaves) you\b|\byou(?:[’']re|[’']ve|[’']ll)?\b|\byour\b/gi, phrase => {
    const lower = phrase.toLowerCase();
    let replacement;
    if (lower.includes('opponent')) replacement = /[’']s$/.test(lower) ? 'your' : 'you';
    else if (lower.includes('enemy ')) replacement = 'your ' + lower.replace(/^the /, '').slice(6);
    else if (/^(for|against|to|with|leave|leaves) you$/.test(lower)) replacement = lower.split(' ')[0] + ' them';
    else replacement = lower === 'your' ? 'their' : /[’']re$/.test(lower) ? 'they are' : /[’']ve$/.test(lower) ? 'they have' : /[’']ll$/.test(lower) ? 'they will' : 'they';
    return /^[A-Z]/.test(phrase) ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
  });
  const verbs = {has: 'have', is: 'are', captures: 'capture', recaptures: 'recapture', attacks: 'attack', forks: 'fork', wins: 'win', loses: 'lose', plays: 'play', moves: 'move'};
  return swapped.replace(/\byou (has|is|captures|recaptures|attacks|forks|wins|loses|plays|moves)\b/gi,
    (phrase, verb) => (/^[A-Z]/.test(phrase) ? 'You ' : 'you ') + verbs[verb.toLowerCase()]);
}

export function coachInsights(findings, {mover, player}) {
  return findings.map((finding, index) => {
    const priority = insightPriority(finding.event), ours = mover === player;
    let perspective = ours ? 'Your move' : 'Opponent’s move';
    let text = validSide(player) ? playerText(finding.text, mover, player) : neutralText(finding.text, mover);
    if (!validSide(player)) return {...finding,text,sourceText:finding.text,perspective:(mover==='w'?'White':'Black')+' move',...priority,index};
    if (finding.event === 'overloaded-defender' && finding.context?.defender) {
      const defender = finding.context.defender;
      const owner = defender.color === player ? 'Your' : 'Your opponent’s';
      const piece = {p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen'}[defender.type];
      if (piece && /^[a-h][1-8]$/.test(defender.square)) {
        text = finding.text.replace(/^Overloaded [^:]+:/, `${owner} ${piece} on ${defender.square} is overloaded:`);
        perspective = defender.color === player ? 'Conditional risk for you' : 'Conditional opportunity for you';
      }
    } else if (finding.event === 'missed-mate') {
      perspective = ours ? 'Your missed mating chance' : 'Opponent’s missed mating chance';
    } else if (/pawn-shield-defense|unique-mate-defense|saving-piece|defending-piece|active-defense|luft|conditional-stalemate/.test(finding.event)) {
      perspective = ours ? 'Your defensive resource' : 'Opponent’s defensive resource';
    } else if (priority.rank === 700 || finding.event === 'forced-mate') {
      perspective = ours ? 'Your tactical resource' : 'Opponent’s tactical resource';
    }
    return {...finding, text, sourceText: finding.text, perspective, ...priority, index};
  }).sort((a, b) => b.rank - a.rank || a.index - b.index);
}

const opposite = color => color === 'w' ? 'b' : 'w';
const names = {p:'pawn', n:'knight', b:'bishop', r:'rook', q:'queen', k:'king'};
const validSide = side => side === 'w' || side === 'b';
const replyTitles = {
  'current-mate-in-one':'Mate in one', 'immediate-mate-blunder-check':'Mate in one',
  'current-bounded-mating-resource':'Mating continuation', 'bounded-king-vulnerability':'King safety',
  'conditional-reply-mating-risks':'A reply to avoid', 'hypothetical-opponent-mate':'A mating pattern to watch',
  'direct-attack':'New attack', 'undefended-unit-observation':'Lost pawn support',
  'missed-mate':'Missed mating chance', 'forced-mate':'Forced mate',
};
const square = value => typeof value === 'string' && /^[a-h][1-8]$/.test(value);
const neutralText = (text,mover) => text.replace(/\byour opponent(?:[’']s)?\b|\byou(?:[’']re|[’']ve|[’']ll)?\b|\byour\b/gi, phrase => {
  const owner=phrase.toLowerCase().includes('opponent')?opposite(mover):mover;
  const side=owner==='w'?'White':'Black';
  const lower=phrase.toLowerCase();
  if(/[’']re$/.test(lower))return side+' is';
  if(/[’']ve$/.test(lower))return side+' has';
  if(/[’']ll$/.test(lower))return side+' will';
  return /your$|[’']s$/.test(lower)?side+'’s':side;
}).replace(/\b(White|Black) have\b/g,'$1 has').replace(/\b(White|Black) are\b/g,'$1 is');

// Reply policy is deliberately narrower than the all-findings inspector. It uses
// actors, concrete targets and transition evidence; category rank is not a proof.
export function coachReply(findings, {mover, player, change, input} = {}) {
  if (!validSide(player) || !validSide(mover)) return {items:[], perspectiveKnown:false};
  if (isFastSelection(input)) return fastCoachReply(findings,{input,player,change},coachReply(findings,{mover,player,change}));
  const insights=coachInsights(findings,{mover,player}), candidates=[], used=new Map();
  const owner=color=>color===player?'Your':'Your opponent’s';
  const push=(f,text,score,theme,targets=[])=>{
    const key=JSON.stringify([theme,text]);
    if(used.has(key)){const item=used.get(key);item.supporting.push(f);return item;}
    let perspective=f.perspective;
    const actor=f.context?.actor||mover;
    if(theme==='immediate-mate' || theme==='forced-mate'){
      const winner=['immediate-mate-blunder-check','retained-mate-threat'].includes(f.event)?opposite(actor):actor;
      perspective=winner===player?'Your mating opportunity':'Mating threat against you';
    }else if(theme==='reply-risk')perspective='Your defensive decision';
    else if(theme==='contact')perspective=actor===player?'Your new pressure':'Pressure on your piece';
    const item={...f,name:replyTitles[f.event]||f.name,perspective,text,rank:score,theme,targets,supporting:[]};used.set(key,item);candidates.push(item);return item;
  };
  for(const f of insights){
    const e=f.context?.evidence||{}, actor=validSide(f.context?.actor)?f.context.actor:mover, ours=actor===player, id=f.event;
    if(id==='checkmate') {push(f,ours?'Your move gives checkmate.':'Your opponent’s move gives checkmate.',10000,'result');continue;}
    if(['stalemate','insufficient-material'].includes(id)) {push(f,f.text,10000,'result');continue;}
    if(['repetition-claim','fifty-move-claim'].includes(id)) {push(f,f.text,9500,'draw-claim');continue;}
    if(id==='immediate-mate-blunder-check'&&e.opponentMate?.san){
      const beneficiary=opposite(actor),text=beneficiary===player?`You can now play ${e.opponentMate.san} for mate in one.`:`Your move allows ${e.opponentMate.san}, which is mate in one for your opponent.`;
      push(f,text,9800,'immediate-mate');continue;
    }
    if(id==='current-mate-in-one' && e.san){push(f,actor===player?`You can now play ${e.san} for mate in one.`:`Your move allows ${e.san}, which is mate in one for your opponent.`,9800,'immediate-mate');continue;}
    if(id==='current-bounded-mating-resource' && e.san){
      push(f,ours ? `You can play ${e.san} with a certified mating continuation within three total plies.` : `Your move allows ${e.san}, with a certified mating continuation for your opponent within three total plies.`,8800,'forced-mate');continue;
    }
    if(id==='conditional-reply-mating-risks' && ours && e.san){
      push(f,`Be careful with ${e.san}: that reply allows a certified opponent mating continuation within two further plies. Other replies are not all classified.`,7500,'reply-risk');continue;
    }
    if(id==='bounded-king-vulnerability' && validSide(e.kingSide)){
      push(f,`${owner(e.kingSide)} king is vulnerable to a certified mating continuation within two plies from this position. The proof does not classify every possible plan.`,8700,'forced-mate');continue;
    }
    if(id==='hypothetical-opponent-mate' && actor!==player){push(f,"Your opponent has a mate-in-one pattern in a turn-flipped diagram. It is a reason to examine defenses, not proof that mate is forced or an actual immediate reply.",5600,'hypothetical-mate');continue;}
    if(id==='retained-mate-threat'){push(f,f.text,9700,'immediate-mate');continue;}
    if(id==='forced-mate'&&Number.isInteger(e.mateIn)) {push(f,`${ours?'Your move':'Your opponent’s move'} forces mate in ${e.mateIn}.`,9000,'forced-mate');continue;}
    if(id==='missed-mate'&&e.san&&e.mateIn){push(f,`${ours?'You missed':'Your opponent missed'} mate in ${e.mateIn} with ${e.san}.`,ours?9200:5800,'missed-mate');continue;}
    if(id==='missed-immediate-mate-review'){push(f,f.text,ours?9200:5800,'missed-mate');continue;}
    if(id==='one-ply-conversion-deadline'){push(f,f.text,9300,'deadline');continue;}
    if(id==='overloaded-defender'&&validSide(f.context?.defender?.color)){
      const d=f.context.defender;push(f,f.text,d.color===player?7900:6800,'overload',[d.square]);continue;
    }
    if(['fork','broad-fork'].includes(id)&&e.targets?.length){
      const targets=e.targets.map(t=>typeof t==='string'?t:t.square).filter(square);
      push(f,`${ours?'Your':'Your opponent’s'} ${names[e.piece]||'piece'}${square(e.attacker)?' on '+e.attacker:''} attacks multiple targets. ${f.text}`,ours?7100:8100,'fork',targets);continue;
    }
    if(id==='absolute-pin'&&square(e.blocker)&&square(e.slider)){
      push(f,`${owner(opposite(actor))} ${names[e.piece]||'piece'} on ${e.blocker} is pinned to the king by ${ours?'your':'your opponent’s'} piece on ${e.slider}; it cannot leave that line.`,ours?5300:7200,'pin',[e.blocker]);continue;
    }
    if(/^(unique-mate-defense|pawn-shield-defense|saving-piece|defending-piece|eliminating-attacker|active-defense|conditional-stalemate|prevented-immediate-mate)$/.test(id)){
      push(f,f.text,ours?7600:6500,'defense');continue;
    }
    if(id==='undefended-unit-observation'&&e.target&&e.target.attackers?.length){
      const t=e.target,changed=change?.attackChanges?.find(d=>d.color===t.color&&d.target===t.square&&d.removed.some(unit=>unit.startsWith(t.color+'p')));
      if(!changed)continue;
      push(f,`${owner(t.color)} ${names[t.type]} on ${t.square} lost pawn support and now has no geometric defender. It is attacked, but a winning capture has not been established.`,t.color===player?6700:4900,'exposure',[t.square]);continue;
    }
    if(id==='direct-attack'&&e.targets?.length&&names[e.piece]&&square(e.to)){
      const targets=e.targets.filter(square), target=targets[0];if(!target)continue;
      const undefended=insights.find(u=>u.event==='undefended-unit-observation'&&u.context?.evidence?.target?.square===target&&u.context.evidence.target.color===opposite(actor));
      if(undefended){
        const item=push(f,`${owner(actor)} ${names[e.piece]} on ${e.to} now attacks the ${names[undefended.context.evidence.target.type]} on ${target}, which has no geometric defender. This is a capture contact, not proof of a forced gain.`,ours?5500:6900,'contact',[target]);
        item.supporting.push(undefended);
      }
      continue;
    }
    if(id==='pawn-chain'&&e.newEdges?.length){
      const edge=e.newEdges[0];if(square(edge.base)&&square(edge.head))push(f,`${owner(actor)} pawn on ${edge.base} now supports the pawn on ${edge.head}.`,2600,'pawn-support',[edge.base,edge.head]);continue;
    }
    if(id==='isolated-pawn'&&e.squares?.length){push(f,`${owner(actor)} pawn${e.squares.length>1?'s':''} on ${e.squares.join(', ')} now ${e.squares.length>1?'have':'has'} no friendly pawn on an adjacent file. This is a structural observation; it does not prove a weakness can be exploited.`,3100,'pawn-isolation',e.squares);continue;}
    if(id==='file-opening'&&e.file){push(f,`The ${e.file}-file is now open because no pawn remains on it. ${ours?'Your':'Your opponent’s'} move creates a file that either side may be able to use.`,2900,'open-file');continue;}
    // Only concrete emitted bounded consequences get a generic fallback. Counts,
    // legal movement, raw candidate inventories and unchanged geometry abstain.
    if(/certified|forced|missed|sacrifice|mating|counterattack|intermediate|trapped|promotion-route|safe-promotion|pawn-race|outpost|invasion|rook-swing|square-clearance|desperado/.test(id)
      && !/inventory|comparison|candidate|ordering|hypothetical|estimate/.test(id)) {
      const conditional=/\bif\b|conditional|hypothetical|snapshot/i.test(f.sourceText);
      const concrete=/mate|captures?|wins? material|prevents?|removes?|promotion|every reply|every legal|refut/i.test(f.sourceText);
      if(concrete)push(f,f.text,conditional?4700:ours?6200:7000,'bounded-'+id);
    }
  }
  candidates.sort((a,b)=>b.rank-a.rank||a.index-b.index);
  // Alias labels with the same detector explanation add evidence, never sentences.
  const unique=[];
  for(const item of candidates){
    const alias=unique.find(u=>u.event===item.event&&u.sourceText===item.sourceText);
    if(alias){alias.supporting.push(item,...item.supporting);continue;}
    unique.push(item);
  }
  const first=unique[0];if(!first)return{items:[],perspectiveKnown:true};
  return {items:[first],perspectiveKnown:true};
}
