import {inspectFastConsequences} from './fast-consequences.js';
import {Chess} from '../chess.js';
import {CONCEPT_GROUPS, studyEnabled, detectorInput, selectedGroups, isFastSelection} from './controls.js';
import {DETECTORS} from './entries.js';
import {withConceptParent} from './stage.js';
import {conceptInput, ruleFacts, summarizeConcepts} from './analyze.js';
import {explainMove} from './detectors/E080-shield.mjs';
import {inspectQuestion} from './detectors/E199-questions.mjs';
import {lastMoveChanges} from './detectors/E200-changes.mjs';
import {inspectChecksCapturesThreats} from './detectors/E201-question.mjs';
import {inspectHypotheticalOpponent} from './detectors/E209-hypothetical.mjs';
import {collectPanel} from './detectors/E143-panel.mjs';
import {inspectDecisionSupport} from './detectors/E189-support.mjs';
import {inspectOpponentResources} from './detectors/E202-opponent.mjs';
import {inspectKingVulnerability} from './detectors/E206-kings.mjs';
import {inspectDeadline} from './detectors/E237-deadline.mjs';

export {DETECTORS};
export function integrationInput(input) {
  const options=conceptInput(input,true);
  const flags = new Map();
  for(const detector of DETECTORS){for(const flag of detector.flags)flags.set(flag, flags.get(flag) || studyEnabled(input,detector.study));for(const cap of detector.budgets)options[cap]=4000;}
  Object.assign(options,Object.fromEntries(flags));
  if (!input.orderFollowup) options.moveOrderTags=false;
  return options;
}
export function startConceptRun(input, provenance, detailed = true) {
  const result = ruleFacts(explainMove(conceptInput(input, detailed)), input);
  return {input, provenance, result, stages: [], errors: [], elapsed: 0};
}
export function runConceptStage(job, detector) {
  if (!studyEnabled(job.input, detector.study)) return;
  const options = job.options ||= integrationInput(job.input);
  const before = job.result, started = performance.now();
  if (detector.study === "E120" && !options.orderFollowup) {job.stages.push({detector:detector.study,status:"orderFollowup-prerequisite"});return;}
  try {
    const next = withConceptParent(before, () => detector.run(options), options);
    if (next.after !== before.after) throw Error('Staged position differs');
    const prior = new Set(before.events);
    next.events = next.events.map(event => prior.has(event) ? event : {...event, integrationStudy: detector.study});
    const diagnostics = Object.entries(next).filter(([key,value]) => /Analysis$/.test(key) && value !== before[key] && value && typeof value === 'object')
      .map(([key,value]) => ({detector: detector.study, phase: key, status: value.status ?? (value.exhausted ? 'exhausted' : 'complete'), nodes: value.nodes ?? null}));
    job.stages.push(...diagnostics); job.result = next;
  } catch (error) { job.errors.push(detector.study + ': ' + error.message); }
  job.elapsed += performance.now() - started;
}
export function supplementalConcepts(job, phase = 'all') {
  const input = detectorInput(job.input), enabled = study => studyEnabled(job.input, study);
  const fast = phase !== 'deep', deep = phase !== 'fast';
  if(phase !== 'deep' && studyEnabled(job.input,'P006')) {
    const local=inspectFastConsequences(job.input);job.result.events.push(...local.events);
    job.stages.push({detector:'P006',status:local.status,nodes:local.nodes},...(local.stages||[]));
  }
  const after = new Chess(input.fen); after.move(input.move);
  const history = input.history && {...input.history, moves: [...input.history.moves, input.move]};
  const current = {fen: after.fen(), ...(history ? {history} : {})};
  const add = (id, text, study, evidence) => job.result.events.push({id, text, integrationStudy: study, qualityClaim: false, evidence});
  const stage = (study, run) => { try { const r = run(); job.stages.push({detector: study, status: r.status}); return r; } catch (e) { job.errors.push(study + ': ' + e.message); return null; } };
  const selectedPanel=job.result.forcingTempoAnalysis?.witness?.panel;
  if (deep && selectedPanel) {
    const decisions=stage('E189',()=>inspectDecisionSupport(input,{enabled:true,plies:2,maxNodes:4000},selectedPanel));
    if(decisions?.witness&&decisions.claims.C0788) add('bounded-mating-decisions', 'The complete root candidate panel contains certified mating policies within two continuation plies; unclassified candidates remain unresolved.', 'E189', {actor:decisions.witness.actor,detail:{shortlist:decisions.witness.shortlist,certifiedLosses:decisions.witness.certifiedLosses,unresolved:decisions.witness.unresolved}});
    const kings=stage('E206',()=>inspectKingVulnerability(input,{enabled:true,player:'w',plies:2,maxNodes:4000},selectedPanel));
    if(kings?.answer.available)add('bounded-king-vulnerability', (kings.answer.side==='w'?'White':'Black')+' has a king vulnerable to a certified mating continuation within two plies from the selected successor.', 'E206', {actor:kings.answer.side==='w'?'b':'w',kingSide:kings.answer.side,detail:{frame:kings.answer.frame,profiles:kings.witness.profiles}});
  } else if(deep && enabled('E189')) job.stages.push({detector:'E189/E206',status:'complete-panel-prerequisite'});
  if(deep && enabled('E199') && job.result.improvementAnalysis?.witness){
    const weak=stage('E199-C1066',()=>inspectQuestion('C1066',integrationInput(job.input),{enabled:true,maxNodes:4000},job.result));
    if(weak?.available&&weak.answers.length)add('supported-knight-square','The moved knight occupies a newly supported square without a pawn challenge in the certified comparison. This does not establish all-board weakness, permanence or general strategic value.','E199',{actor:new Chess(input.fen).turn(),detail:{answers:weak.answers}});
  }
  const structural=job.result.openingStructureAnalysis;
  if(deep && enabled('E199') && structural?.witness){const contacts=stage('E199-C1067',()=>inspectQuestion('C1067',integrationInput(job.input),{enabled:true,maxNodes:4000},job.result));if(contacts?.available&&contacts.answers.length)add('conditional-central-pawn-contacts','New central pawn contacts are available in an explicit actor-turn snapshot; safe breaks and strategic value are not established.','E199',{actor:new Chess(input.fen).turn(),conditional:true,detail:{contacts:contacts.answers,originalBudgetVerified:false}});}
  const change = fast && enabled('E200') && stage('E200', () => lastMoveChanges({...current, enabled: true, maxChangeNodes: 4000}));
  if (change?.answer) {
    job.change=change.answer; const a=change.answer;
    add("recorded-move-changes", `Recorded ${a.last.san}: ${a.unitChanges.length} original units changed and ${a.attackChanges.length} geometric attack relationships changed; no strategic benefit is inferred.`,"E200",{actor:a.last.color,detail:{last:a.last,unitChanges:a.unitChanges,attackChanges:a.attackChanges}});
  }
  const board = fast && enabled('E199') && stage('E199', () => inspectQuestion('C1062', current, {enabled: true, maxNodes: 4000}));
  if (board?.available && board.answers.length) {
    for (const target of board.answers) add('undefended-unit-observation', `The ${target.color === 'w' ? 'White' : 'Black'} ${target.type === 'q' ? 'queen' : target.type === 'r' ? 'rook' : target.type === 'b' ? 'bishop' : 'knight'} on ${target.square} has no geometric defender${target.attackers.length ? '; attacked from ' + target.attackers.join(', ') : ''}.`, 'E199', {target, actor: after.turn()});
  }
  let currentPanel;
  if(deep && enabled('E202') && history && !after.isGameOver() && after.board().flat().filter(Boolean).length<=10){
    const first=after.moves({verbose:true})[0];
    const frame={...current,move:first.from+first.to+(first.promotion||'')};
    try{currentPanel=collectPanel(frame,2,4000);job.stages.push({detector:'E201-panel',status:'complete',nodes:currentPanel.nodes});}
    catch(error){if(error.message!=='forcing-tempo-budget')job.errors.push('E201-panel: '+error.message);job.stages.push({detector:'E201-panel',status:error.message==='forcing-tempo-budget'?'exhausted':'unavailable'});}
  }else if(deep && enabled('E202') && !after.isGameOver())job.stages.push({detector:'E201-panel',status:history?'profile-unavailable':'history-prerequisite'});
  const candidates = fast && enabled('E201') && stage('E201', () => inspectChecksCapturesThreats(current, {enabled: true, plies:2, maxNodes: 4000},currentPanel));
  if (candidates?.answer) {
    const a = candidates.answer;
    if (a.checks.length || a.captures.length) add('current-checks-captures', `${a.actor === 'w' ? 'White' : 'Black'} has ${a.checks.length} legal checks and ${a.captures.length} legal captures in this position; deeper threats are not classified.`, 'E201', {actor:a.actor, checks:a.checks, captures:a.captures,detail:{moves:a.moves,threats:a.threats.status}});
    for(const m of a.moves.filter(m=>m.mate)) add("current-mate-in-one",`${a.actor==='w'?'White':'Black'} can play ${m.san} for mate in one.`,"E201",{actor:a.actor,san:m.san});
  }
  if(currentPanel){
    for(const perspective of ['w','b']){
      const resources=stage('E202',()=>inspectOpponentResources(current,{enabled:true,perspective,plies:2,maxNodes:4000},currentPanel));
      for(const resource of resources?.answer?.resources||[])add('current-bounded-mating-resource',(resource.winner==='w'?'White':'Black')+' can play '+resource.san+' with a certified mating continuation within three total plies. Other candidates are not all classified.','E202',{actor:resource.winner,san:resource.san,detail:resource});
      const risks=resources?.answer?.candidateReplies.filter(r=>r.resource)||[];
      if(risks.length){const risk=risks[0],own=after.moves({verbose:true}).find(m=>m.from+m.to+(m.promotion||'')===risk.ownMove);add('conditional-reply-mating-risks','Some candidate replies, including '+own.san+', allow a certified opponent mating continuation within two further plies. Unclassified alternatives are not certified safe.','E202',{actor:after.turn(),san:own.san,conditional:true,detail:{risks,unclassified:resources.answer.uncertifiedCandidates}});}
    }
  }
  // Analyze both colors so presentation changes never invalidate a cache entry.
  for (const player of fast && enabled('E209') ? ['w','b'] : []) {
    // E201 already checks the actual side to move. Fast needs only the other
    // side's hypothetical diagram; avoid repeating the same legal mate scan.
    if(isFastSelection(job.input) && (player==='w'?'b':'w')===after.turn() && enabled('E201'))continue;
    const hypothetical = stage('E209', () => inspectHypotheticalOpponent(current, {enabled:true, player, maxNodes:4000}));
    if (hypothetical?.answer.available) add('hypothetical-opponent-mate', `${player === 'w' ? 'Black' : 'White'} could give mate in one in a hypothetical opponent-turn diagram; this is not a legal pass or an actual immediate reply.`, 'E209', {actor: player === 'w' ? 'b' : 'w', hypothetical:true, moves:hypothetical.answer.moves,detail:{mates:hypothetical.witness.moves.filter(m=>m.mate).map(m=>({move:m.move,san:m.san})),model:hypothetical.witness.hypothetical.model}});
  }
  // This certificate requires EXACTLY the last ply before the automatic
  // 75-move draw. Earlier clocks cannot emit a deadline; don't replay history.
  const deadline = fast && enabled('E237') && (!isFastSelection(job.input)||Number(input.fen.split(' ')[4])===149) && stage('E237', () => inspectDeadline({id:input.move, source:'extension-selected-move', ...input}, {enabled:true,maxWork:4000,maxChoices:256}));
  if (deadline?.claims?.C0600) add('one-ply-conversion-deadline', deadline.claims.C1076 ? 'This move gives mate at the final reversible ply; every nonmating ordinary move draws in the supplied ongoing-root model.' : 'Mate was available at the final reversible ply; this nonmating move draws in the supplied ongoing-root model.', 'E237', {actor:new Chess(input.fen).turn(),conditional:true});
}
export function conceptRunSummary(job) {
  const summary = summarizeConcepts(job.result, job.input, job.provenance.verified, true, [...job.provenance.entries,...(job.provenance.supplementalScopes||[])]);
  summary.disabled = selectedGroups(job.input).length < CONCEPT_GROUPS.length || job.input.disabledConcepts?.length ? 'Some concept groups or individual findings are switched off in Settings.' : null;
  summary.stages = job.stages;
  summary.errors.push(...job.errors);
  summary.issues.push(...job.stages.filter(s=>/exhausted|budget|unavailable/.test(s.status)).map(s=>s.detector+': '+s.status));
  summary.unavailable.push(...job.stages.filter(s=>/prerequisite|missing|unavailable/.test(s.status)).map(s=>s.detector+': '+s.status));
  if (job.change) summary.change = {last: job.change.last, attackChanges: job.change.attackChanges, unitChanges: job.change.unitChanges};
  return summary;
}
