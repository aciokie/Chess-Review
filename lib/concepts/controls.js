import {CONCEPT_ITEMS} from './catalog.js';
export {CONCEPT_ITEMS};
// Cost-ordered execution groups. These are implementation controls, not research acceptance.
// Rule validation and terminal states are always retained. Teaching output is curated separately.
const group = (id, name, cost, description, flags, studies, defaultOn = false) =>
  ({id, name, cost, description, flags: flags.split(' ').filter(Boolean), studies: studies.split(' ').filter(Boolean), defaultOn});
export const CONCEPT_GROUPS = [
  group('features', 'Attacks, lines & piece placement', 'Fast', 'Direct attacks, pins, open lines, placement and changes in defenders.',
    'foundationTags inventoryTags openLineTags placementTags', 'E081 E083 E084 E087 E199 E200', true),
  group('pawns', 'Pawn structure & board features', 'Fast–moderate', 'Pawn chains, isolated pawns, central contacts, symmetry and rook-ending shapes.',
    'centerTags structureTags formationTags pawnSpaceTags closedFileTags', 'E082 E090 E092 E093 FRIEND-01 FRIEND-02', true),
  group('history', 'Recorded routes & development tempo', 'Slow', 'Optional history and response-threat proofs. These search many hypothetical replies and rarely add a focused lesson.',
    '', 'E086 E096'),
  group('immediate', 'Immediate checks, exchanges & mating warnings', 'Moderate', 'Legal checks and captures, short exchange-loss proofs, mate in one, move review and conditional opponent-turn warnings.',
    'pawnShieldTags', 'E085 E091 E201 E209 E237', true),
  group('tactics', 'Tactical proof searches', 'Slow', 'Forks, material gains, overload, sacrifices, mating nets and defensive resources.',
    'intermediateSacrificeTags namedDecoyTags crossCheckTags desperadoTags interferenceTags clearanceRecoveryTags overloadTags defenseCountTags historyMateTags netPatternTags supportedMateTags combinationTags decoyTags defensiveTags uniqueDefense',
    'E088 E095 E098 E099 E101 E104 E107 E108 E110 E115 E117 E118 E119 E121 E122 E123 E131 E136 E139 E142'),
  group('endgames', 'Pawn races & endgame policies', 'Slow', 'Promotion routes, pawn races, opposition, reserve tempi and bounded conversion policies.',
    'kingCenterTags waitingTempoTags pawnRaceTags triangulationTags wrongBishopTags rookCheckTags blockadeTags',
    'E089 E097 E102 E105 E106 E109 E112 E124 E125 E126 E127 E134 E135'),
  group('positional', 'Detailed positional comparisons', 'Very slow', 'Tracked opening formations, outposts, pawn breaks, mobility comparisons and restriction proofs.',
    'octopusTags outpostTags invasionTags rookSwingTags blockedPositionTags pawnStormTags pawnBreakTags pawnRestraintTags',
    'E094 E100 E111 E113 E114 E116 E128 E129 E130 E132 E133 E147 E148 E149 E151 E152 E157 E159 E160 E161 FRIEND-03'),
  group('policies', 'Complete candidate & objective policies', 'Very slow', 'Complete mating panels, coordination and declared-goal comparisons. Many require inputs unavailable in a normal review.',
    '', 'E103 E120 E137 E138 E140 E141 E143 E144 E145 E146 E150 E153 E154 E155 E156 E158 E162 E163 E164 E165 E166 E167 E168 E169 E170 E171 E172 E173 E174 E175 E177 E189 E202 E206'),
];
export const DEFAULT_CONCEPT_GROUPS = CONCEPT_GROUPS.filter(g => g.defaultOn).map(g => g.id);
export function normalizeConceptGroups(value = DEFAULT_CONCEPT_GROUPS) {
  return CONCEPT_GROUPS.filter(g => Array.isArray(value) && value.includes(g.id)).map(g => g.id);
}
export function selectedGroups(input) { return normalizeConceptGroups(input.conceptGroups ?? CONCEPT_GROUPS.map(g => g.id)); }
export function studyEnabled(input, study) {
  if(study==='P006')return isFastSelection(input)&&CONCEPT_ITEMS.some(item=>item.studies.includes('P006')&&conceptEnabled(input,item.id));
  const outputs = CONCEPT_ITEMS.filter(item=>item.studies.includes(study));
  return CONCEPT_GROUPS.some(g => selectedGroups(input).includes(g.id) && g.studies.includes(study)) &&
    (!outputs.length || outputs.some(item=>conceptEnabled(input,item.id)));
}
const itemGroups = new Map(CONCEPT_ITEMS.map(item=>[item.id,item.group]));
const itemIds = new Set(itemGroups.keys());
export function normalizeDisabledConcepts(value = []) {
  return [...new Set(Array.isArray(value) ? value.filter(id=>itemIds.has(id)) : [])].sort();
}
export function conceptEnabled(input,id) {
  const group=itemGroups.get(id);
  return !input.disabledConcepts?.includes(id)&&(!group||selectedGroups(input).includes(group));
}
export function filterConceptFindings(findings,input) {return findings.filter(f=>conceptEnabled(input,f.event));}
export function detectorInput(input) { const {conceptGroups, disabledConcepts, ...clean} = input; return clean; }
export function groupFlags(input) {
  const selected = selectedGroups(input);
  return Object.fromEntries(CONCEPT_GROUPS.flatMap(g => g.flags).map(flag => [flag,
    CONCEPT_GROUPS.some(g => selected.includes(g.id) && g.flags.includes(flag)) &&
      (!CONCEPT_ITEMS.some(item=>item.flags.includes(flag)) || CONCEPT_ITEMS.some(item=>item.flags.includes(flag)&&conceptEnabled(input,item.id)))]));
}

// Fast-only teaching decisions, separate from source/research acceptance. Shared
// witnesses remain available to meaningful findings even when their raw counters
// are omitted. Enabling a heavier group restores the uncurated research inspector.
export function isFastSelection(input) {
  // Optional history stays compatible with the focused reply and local P006
  // witnesses; default selection and presentation eligibility are independent.
  return Array.isArray(input?.conceptGroups) && selectedGroups(input).every(id => ['features','pawns','history','immediate'].includes(id));
}
export const FAST_CONCEPT_REMOVALS = [
  {name:'Legal move, piece movement & board coordinates', status:'Not calculated', reason:'Routine legality and square descriptions teach no move-specific lesson. Input validation remains active.', events:['legal-input','piece-movement','board-coordinates']},
  {name:'Material totals & raw piece inventories', status:'Not calculated', reason:'Generic counts do not explain the move. Captures, promotions and meaningful material consequences remain.', events:['material-inventory','nominal-balance','material-imbalance','pawn-skeleton','paired-bishop-armies','rook-minor-armies','passed-count-imbalance','flank-count-imbalance']},
  {name:'Candidate counts & calculation-tree summaries', status:'Removed from findings', reason:'Shared legal scans still check mating warnings; their counts are not coaching insights.', events:['legal-forcing-candidates','one-ply-calculation-tree','checks-captures-mates-inventory','current-checks-captures','recorded-move-changes']},
  {name:'Square-color attack labels & line-opening aliases', status:'Removed from findings', reason:'Duplicate labels add no lesson beyond the named attack or cleared line. Their evidence is retained with that finding.', events:['dark-square-contact','light-square-contact','legal-clearance','legal-line-opening','legal-opening-lines','legal-alignment','legal-line-contact','legal-alignment-contact']},
  {name:'Raw pawn geometry & routine rule resets', status:'Removed from findings', reason:'Pawn-square inventories, color counts and fifty-move resets usually add noise. Pawn support, tension, structural changes and draw claims remain.', events:['pawn-structure-change','pawn-phalanx','bishop-pawn-color','irreversible-move']},
  {name:'Unattacked, undefended units', status:'Removed when irrelevant', reason:'An unguarded starting rook is not itself a threat. Attacked units without defenders remain available.', events:[]},
];
export function curateFastFindings(findings, input) {
  if (!isFastSelection(input)) return findings;
  const removed = new Set(FAST_CONCEPT_REMOVALS.flatMap(item=>item.events));
  return findings.filter(f=>!removed.has(f.event) && !(f.event==='undefended-unit-observation' && !f.context?.evidence?.target?.attackers?.length));
}
