import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Chess} from '../lib/chess.js';
import {coachInsights, coachReply, playerText, tidyText} from '../lib/coach-insights.js';
import {startConceptRun, runConceptStage, supplementalConcepts, conceptRunSummary, DETECTORS} from '../lib/concepts/runtime.js';
import {studyEnabled, DEFAULT_CONCEPT_GROUPS} from '../lib/concepts/controls.js';

const provenance = JSON.parse(fs.readFileSync(new URL('../lib/concepts/integration-provenance.json', import.meta.url), 'utf8'));
const finding = (text, extra = {}) => ({event: 'x', name: 'x', text, kind: 'Factual observation', scopes: [], context: {mover: 'w', actor: 'w'}, ...extra});

// Runs the same stages the worker runs, so presentation is tested on real detector output.
function analyze(fen, san, {history = [], groups = DEFAULT_CONCEPT_GROUPS} = {}) {
  const game = new Chess(fen), initial = game.fen(), played = [];
  for (const prior of history) { const m = game.move(prior); played.push(m.from + m.to + (m.promotion || '')); }
  const before = game.fen(), mv = game.move(san);
  const input = {fen: before, move: mv.from + mv.to + (mv.promotion || ''), history: {fen: initial, moves: played}, conceptGroups: groups};
  const job = startConceptRun(input, provenance, true);
  supplementalConcepts(job, 'fast');
  for (const detector of DETECTORS.filter(d => studyEnabled(input, d.study))) runConceptStage(job, detector);
  supplementalConcepts(job, 'deep');
  return {input, mover: mv.color, summary: conceptRunSummary(job)};
}
const reply = (run, player) => coachReply(run.summary.findings, {mover: run.mover, player, change: run.summary.change, input: run.input}).items;

test('perspective swap keeps diagram names, negations and bare possessives readable', () => {
  assert.equal(playerText('White could give mate in one in a hypothetical opponent-turn diagram.', 'w', 'b'),
    'White could give mate in one in a hypothetical opponent-turn diagram.');
  assert.equal(playerText('Passed pawn on c2: no enemy pawn remains ahead on its file.', 'w', 'b'),
    'Passed pawn on c2: no pawn of yours remains ahead on its file.');
  assert.equal(playerText('Pawn skeleton: your pawns are on a7/b7; your opponent\'s on a2/b2.', 'w', 'b'),
    'Pawn skeleton: their pawns are on a7/b7; yours on a2/b2.');
  // Object pronouns stay objects; subject pronouns still flip.
  assert.equal(playerText('This lets you recapture and would leave you with no move.', 'w', 'b'), 'This lets them recapture and would leave them with no move.');
});

test('unknown player identity names the side and conjugates the verb', () => {
  const neutral = text => coachInsights([finding(text)], {mover: 'w', player: null})[0].text;
  assert.equal(neutral('You capture the pawn on d5.'), 'White captures the pawn on d5.');
  assert.equal(neutral('You now have 2 pawn islands; occupied files form 2 separate groups.'), 'White now has 2 pawn islands; occupied files form 2 separate groups.');
  assert.equal(neutral('Exchange: you recapture on d5.'), 'Exchange: White recaptures on d5.');
  assert.equal(neutral('You castled kingside.'), 'White castled kingside.');
  assert.equal(neutral('You found mate in one; your opponent has no legal reply.'), 'White found mate in one; Black has no legal reply.');
  assert.equal(neutral('This still lets you recapture the knight.'), 'This still lets White recapture the knight.');
});

test('count and coordinate wording is repaired without touching lists of squares', () => {
  assert.equal(tidyText('Black has 1 legal checks and 1 legal captures; at least 1 nominal points; 1 pawns against 0.'),
    'Black has 1 legal check and 1 legal capture; at least 1 nominal point; 1 pawn against 0.');
  assert.equal(tidyText('Candidate moves: 1 legal checks or captures were available; 3 legal checks or captures were available.'),
    'Candidate moves: 1 legal check or capture was available; 3 legal checks or captures were available.');
  assert.equal(tidyText('Nf6 removes all 1 immediate mates seen in the hypothetical opponent-turn snapshot.'),
    'Nf6 removes the 1 immediate mate seen in the hypothetical opponent-turn snapshot.');
  assert.equal(tidyText('e4 remain occupied by their pawns; d4/e4 remain occupied by their pawns.'),
    'e4 remains occupied by their pawn; d4/e4 remain occupied by their pawns.');
  assert.equal(tidyText('Pawn target: c4f7 is legal; New legal center capture: f6e4. Lists a2/b2/c2 and a6–f1 stay.'),
    'Pawn target: c4→f7 is legal; New legal center capture: f6→e4. Lists a2/b2/c2 and a6–f1 stay.');
  assert.equal(tidyText('They now have 0 pawn islands; occupied files form 0 separate groups.'), 'They no longer have any pawns.');
  assert.equal(tidyText('King restriction: removes c4 and c5 and c6 from the king.'), 'King restriction: removes c4, c5 and c6 from the king.');
});

test('an attack on the player’s own loose piece is never described as a capture to take', () => {
  const moves = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Ng5'];
  const run = analyze(undefined, 'd5', {history: moves});
  const asWhite = reply(run, 'w'), asBlack = reply(run, 'b');
  assert.equal(asWhite.length, 1); assert.equal(asBlack.length, 1);
  assert.match(asWhite[0].text, /Your opponent’s pawn on d5 now attacks your bishop on c4/);
  assert.match(asWhite[0].text, /Your bishop on c4 is undefended; decide how you will meet the threat/);
  assert.doesNotMatch(asWhite[0].text, /before taking it/);
  assert.match(asBlack[0].text, /Your pawn on d5 now attacks your opponent’s bishop on c4/);
  assert.match(asBlack[0].text, /The bishop on c4 is undefended; check the replies before taking it/);
});

test('a promotion or en passant capture is the lesson of that move in both reply paths', () => {
  const promotion = '8/5P1k/8/8/8/8/8/K7 w - - 0 1', enPassant = '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1';
  for (const groups of [DEFAULT_CONCEPT_GROUPS, ['features', 'pawns', 'immediate', 'endgames']]) {
    const queen = analyze(promotion, 'f8=Q+', {groups});
    assert.deepEqual(reply(queen, 'w').map(i => [i.name, i.text]), [['Promotion', 'Promotion: your pawn becomes a queen.']]);
    assert.deepEqual(reply(queen, 'b').map(i => [i.name, i.text]), [['Promotion', 'Promotion: their pawn becomes a queen.']]);
    const ep = analyze(enPassant, 'exd6', {groups}), lesson = reply(ep, 'w')[0];
    assert.doesNotMatch(lesson.text, /now open/);
    // The fast profile has a certified material-gain lesson that rightly outranks the bare rule fact.
    // Either way the captured pawn is named on its real square, not on the landing square.
    if (groups === DEFAULT_CONCEPT_GROUPS) { assert.equal(lesson.name, 'A capture that holds up'); assert.match(lesson.text, /takes your opponent’s pawn on d5/); }
    else assert.deepEqual([lesson.name, lesson.text], ['En passant', 'En passant: pawn d6 captures the pawn from d5.']);
  }
});

test('the full inspector shows the reworded facts for the opponent’s view of a real position', () => {
  const run = analyze(undefined, 'Bxb5+', {history: 'e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5'.split(' ')});
  const texts = coachInsights(run.summary.findings, {mover: run.mover, player: 'b'}).map(f => f.text);
  assert.ok(texts.some(t => /^Passed pawn on c2: no pawn of yours remains ahead/.test(t)), texts.join('\n'));
  assert.ok(!texts.some(t => /no your|your on |you-turn/.test(t)), texts.join('\n'));
});
