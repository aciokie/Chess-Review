import {Chess} from '../chess.js';
import {explainMove} from './detectors/E080-shield.mjs';
import {findingsFor} from './registry.js';
import {FLAGS, BUDGETS} from './profile.js';
import {detectorInput, groupFlags, selectedGroups, isFastSelection, curateFastFindings, filterConceptFindings} from './controls.js';

export function conceptInput(input, detailed = true) {
  const options = {...detectorInput(input), scanReplies: detailed, maxNodes: detailed ? 4000 : 1,
    mateDepth: detailed ? 3 : 0, promotionDepth: detailed ? 6 : 0,
    kingSupportDepth: detailed ? 6 : 0, pawnRaceDepth: detailed ? 6 : 0,
    compareAlternatives: true};
  for (const key of FLAGS) options[key] = true;
  for (const key of BUDGETS) options[key] = detailed ? 4000 : 0;
  for (const key of ['maxTacticNodes', 'maxBroadNodes']) options[key] = detailed ? 4000 : 1;
  // Complete inexpensive inventories and geometric proofs before bounded searches.
  for (const key of ['maxFoundationNodes', 'maxInventoryNodes', 'maxOpenLineNodes', 'maxPlacementNodes']) options[key] = 4000;
  if (input.conceptGroups) {
    Object.assign(options, groupFlags(input));
    const groups = selectedGroups(input);
    if (isFastSelection(input)) {options.foundationTags=false;options.inventoryTags=false;}
    if (!groups.includes('tactics')) {options.scanReplies=false;options.maxNodes=1;options.maxTacticNodes=1;options.maxBroadNodes=1;options.mateDepth=0;}
    if (!groups.includes('endgames')) {options.promotionDepth=0;options.kingSupportDepth=0;options.pawnRaceDepth=0;}
  }
  return options;
}

// The research comment selector sometimes suppresses basic rules at terminal moves.
// Retain its exact detectors; add only directly validated played-move rule facts.
export function ruleFacts(result, input) {
  const before = new Chess(input.fen), move = before.move(input.move);
  if (before.fen() !== result.after) throw Error('Concept resulting position differs');
  const events = [...result.events], add = (id, text, evidence) => {
    if (!events.some(e => e.id === id)) events.push({id, text, evidence, qualityClaim: false});
  };
  if (before.isCheck()) add('check', 'Check: the resulting position attacks the opponent’s king.', {});
  if (move.captured) add('capture', `Capture: the ${move.captured === 'p' ? 'pawn' : move.captured === 'n' ? 'knight' : move.captured === 'b' ? 'bishop' : move.captured === 'r' ? 'rook' : 'queen'} is removed from ${move.isEnPassant() ? move.to[0] + move.from[1] : move.to}.`, {});
  if (move.promotion) add('promotion', `Promotion: the pawn becomes a ${move.promotion === 'q' ? 'queen' : move.promotion === 'r' ? 'rook' : move.promotion === 'b' ? 'bishop' : 'knight'}.`,
    {piece: move.promotion, underpromotion: move.promotion !== 'q'});
  if (move.isKingsideCastle() || move.isQueensideCastle()) add('castling', `You castled ${move.isKingsideCastle() ? 'kingside' : 'queenside'}.`, {wing: move.isKingsideCastle() ? 'kingside' : 'queenside'});
  if (move.isEnPassant()) add('en-passant', `En passant: ${move.to} removes the pawn from ${move.to[0] + move.from[1]}.`, {from: move.from, to: move.to, capturedSquare: move.to[0] + move.from[1]});
  return {...result, events};
}

function diagnostics(result) {
  const issues = [];
  function visit(value, path) {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'events' || key === 'evidence' || key === 'tree' || key === 'actual' || key === 'alternatives') continue;
      if (key === 'exhausted' && item === true || typeof item === 'string' && /exhausted|unavailable|short-profile/.test(item)) issues.push(`${path}.${key}: ${item}`);
      else if (typeof item === 'object') visit(item, path + '.' + key);
    }
  }
  visit(result, 'detector');
  return [...new Set(issues)];
}

const detailFor = event => event.evidence?.detail;
const extraAccepted = {'direct-attack':'Direct attack','attack-on-pawn':'Attack on a pawn','attack-on-piece':'Attack on a piece','side-check-proof':'Side checks','rook-four-three':'Four versus three','rook-three-two':'Three versus two'};
const pieceFields = ['color','type','square','from','to','san','piece','mateIn','gain','file','base','head','attackers'];
function compact(value, depth = 0) {
  if (value === null || ['string','number','boolean'].includes(typeof value)) return value;
  if (depth > 2 || !value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) return value.slice(0,8).map(v=>compact(v,depth+1)).filter(v=>v!==undefined);
  return Object.fromEntries(pieceFields.filter(k=>value[k]!==undefined).map(k=>[k,compact(value[k],depth+1)]).filter(([,v])=>v!==undefined));
}
export function summarizeConcepts(result, input, verified, detailed = true, studies = []) {
  const mapped = findingsFor({...result, events: result.events.filter(e=>!e.integrationStudy)}, verified);
  for (const event of result.events.filter(e=>e.integrationStudy)) {
    const study = studies.find(s=>s.study===event.integrationStudy);
    const acceptedName = ["E081","E082"].includes(event.integrationStudy) ? extraAccepted[event.id] : null;
    const scopes = acceptedName ? verified.filter(s=>s.name===acceptedName) : [{occurrence:event.integrationStudy,scope:'Exact emitted observation: '+event.text+' Broader catalog meaning and human usefulness remain unresolved.'}];
    if (acceptedName && !scopes.length) continue;
    mapped.findings.push({event:event.id, name:acceptedName || event.id.replaceAll('-',' ').replace(/^./,c=>c.toUpperCase()), text:event.text,
      kind:acceptedName?'Accepted mechanics — see scope':'Provisional implementation — see scope', researchStatus:acceptedName?'accepted':'provisional', study:event.integrationStudy,
      scopes, studyScopes:study?.claims || [], details:event.evidence?.detail || null});
  }
  const mover = new Chess(input.fen).turn();
  for (const finding of mapped.findings) {
    const event = result.events.find(e=>e.id===finding.event&&e.text===finding.text), e=event?.evidence || {}, w=e.witness || e;
    finding.researchStatus ||= 'accepted';
    finding.context = {mover, actor:['w','b'].includes(w.actor)?w.actor:mover};
    if (finding.event==='overloaded-defender'&&e.defender) {const {color,type,square}=e.defender;finding.context.defender={color,type,square};}
    const keys=['mateIn','san','alternative','square','squares','from','to','file','piece','attacker','slider','blocker','king','targets','newEdges','bases','heads','own','enemy','target','opponentMate','threat','defender','hypothetical','conditional','kingSide','bishop','line','vacated','capture','pawn','pawns','queen','rook','rank','pawnColor','denied','cutoffs'];
    finding.context.evidence=Object.fromEntries(keys.filter(k=>(e[k]??w[k])!==undefined).map(k=>[k,compact(e[k]??w[k])]).filter(([,v])=>v!==undefined));
    if(event?.integrationStudy==='P006') finding.context.evidence.consequence=detailFor(event);
    // Small named certificates for presentation; never copy full reply trees.
    const detail=e.detail||{};
    if (finding.event==='certified-pawn-target-selection' && Array.isArray(detail.selected)) finding.context.evidence.pawnTargets=detail.selected.slice(0,3).map(s=>({move:compact(s.move),minimumGain:s.proof?.minimumGain}));
    if (['certified-unit-tempo','development-lead-with-threat'].includes(finding.event) && detail.pressure) finding.context.evidence.pressure={target:detail.pressure.target,type:detail.pressure.type,proven:detail.pressure.proven};
    if (['certified-tempo-concession','repeated-minor-tempo-warning','early-queen-development-warning'].includes(finding.event) && detail.concession) finding.context.evidence.concession={reply:compact(detail.concession.reply),target:detail.concession.pressure?.target,proven:detail.concession.pressure?.proven,firstMinor:detail.concession.firstMinor};
    const loss=e.loss||detail.loss;
    if (finding.event==='simplification-material-loss' && loss) finding.context.evidence.loss={capture:loss.capture,minimumNetLoss:loss.minimumNetLoss};
    if (finding.event==='conditional-development-constraint' && Array.isArray(detail.restricted)) finding.context.evidence.restricted=detail.restricted.slice(0,3).map(r=>({move:compact(r.move),capture:compact(r.capture),net:r.net}));
    if (w.played?.san) finding.context.playedSan=w.played.san;
    if (event?.integrationStudy==='E081') Object.assign(finding.context.evidence,{piece:w.attacker,to:w.played?.to});
  }
  mapped.findings = filterConceptFindings(curateFastFindings(mapped.findings, input), input);
  const unavailable=[...mapped.unavailable];
  if(!input.history)unavailable.push('Move history unavailable: history-dependent claims abstain.');
  if(input.history&&input.history.fen!==new Chess().fen())unavailable.push('Initial-position history unavailable: original-piece opening claims abstain.');
  return {...mapped,unavailable,issues:detailed?diagnostics(result):[],errors:[],timeMs:0};
}
export function analyzeConcepts(input, verified, detailed = true) {
  const started = performance.now();
  try {const result=ruleFacts(explainMove(conceptInput(input,detailed)),input);return {...summarizeConcepts(result,input,verified,detailed),timeMs:performance.now()-started};}
  catch(error){return {findings:[],unavailable:[],issues:[],errors:[error.message],timeMs:performance.now()-started};}
}
