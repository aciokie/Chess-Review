import {Chess} from '../chess.js';
import {legalPosition, explainMove as basic} from './rules/E020-concepts.mjs';
import {moveEvents} from './rules/E022-tactics.mjs';
import {pawnFeatures, positionFeatures, unobstructed} from './rules/E021-features.mjs';
import {playUci} from './content.js';

const squares = () => [...'abcdefgh'].flatMap(f => Array.from({length:8}, (_,i)=> f+(i+1)));
export function validSquares(exercise) {
  const chess = legalPosition(exercise.fen), actor = exercise.color || 'w';
  const features = pawnFeatures(chess, actor), position = positionFeatures(chess, actor);
  const pawns = chess.board().flat().filter(p => p?.type === 'p' && p.color === actor);
  switch (exercise.rule) {
    case 'isolated': return features.isolated;
    case 'doubled': return pawns.filter(p => features.doubled.includes(p.square[0])).map(p => p.square);
    case 'passed': return features.passed;
    case 'chain-base': return [...new Set(features.components.flatMap(p => p.bases))];
    case 'bishop-pair': return position.bishopPair ? position.bishops : [];
    case 'open-file': return squares().filter(s => position.files.some(f => f.file === s[0] && !f.own && !f.enemy));
    case 'central-pawn-attacks': return ['d4','e4','d5','e5'].filter(s => chess.attackers(s, actor).some(from => chess.get(from).type === 'p'));
    case 'supported-fifth': return squares().filter(s => s[1] === (actor === 'w' ? '5' : '4') && !chess.get(s)
      && chess.attackers(s, actor).some(from=>chess.get(from).type === 'p')
      && !chess.attackers(s, actor === 'w' ? 'b' : 'w').some(from=>chess.get(from).type === 'p'));
    default: return null;
  }
}
const result = (status, feedback, recognition = status, proof = null) => ({status, feedback, recognition, objective:status, moveQuality:'not-assessed', proof});
export function validateExercise(exercise, answer, {maxNodes = 20000} = {}) {
  try {
    if (exercise.type === 'choice') return result(answer === exercise.answer ? 'correct' : 'incorrect', answer === exercise.answer ? exercise.explanation : 'Look again at the position. ' + exercise.explanation);
    if (exercise.type === 'squares') {
      const expected = validSquares(exercise);
      if (!expected) return result('inconclusive', 'This exercise has no supported square validator. Your answer has not been marked wrong.');
      const supplied = [...new Set(answer)];
      const correct = exercise.selection === 'one' ? supplied.length === 1 && expected.includes(supplied[0]) : supplied.length === expected.length && supplied.every(s => expected.includes(s));
      const extra = supplied.filter(s=>!expected.includes(s)), missing = expected.filter(s=>!supplied.includes(s));
      return result(correct ? 'correct' : 'incorrect', correct ? exercise.explanation : `${extra.length ? extra.join(', ') + ' does not fit the definition. ' : ''}${exercise.selection === 'one' ? 'Choose one qualifying square.' : missing.length + ' defining square(s) are still missing.'} ${exercise.explanation}`);
    }
    const before = legalPosition(exercise.fen), chess = new Chess(before.fen());
    let moved;
    try {moved = playUci(chess, answer);} catch {return result('illegal', 'That move is not legal in this position.', 'not-checked');}
    let correct, proof;
    switch (exercise.objective) {
      case 'mate': correct = chess.isCheckmate(); proof = {legalReplies:chess.moves(), check:chess.isCheck()}; break;
      case 'promotion': correct = !!moved.promotion; break;
      case 'castle': correct = moved.isKingsideCastle() || moved.isQueensideCastle(); break;
      case 'develop-knight': correct = moved.piece === 'n' && ['b1','g1','b8','g8'].includes(moved.from) && ['c3','f3','c6','f6'].includes(moved.to); break;
      case 'king-flight': {
        const king=chess.board().flat().find(p=>p?.type==='k'&&p.color===moved.color);
        correct=moved.piece==='p'&&!chess.get(moved.from)
          &&Math.abs(king.square.charCodeAt(0)-moved.from.charCodeAt(0))<=1&&Math.abs(+king.square[1]-+moved.from[1])<=1
          &&!chess.isAttacked(moved.from,chess.turn());break;
      }
      case 'rook-behind': {
        const feature = positionFeatures(chess, moved.color);
        correct = moved.piece === 'r' && feature.behind.some(r=>r.rook === moved.to && r.pawnColor === moved.color && unobstructed(chess, r.rook, r.pawn)); break;
      }
      default: {
        if (!exercise.objective?.startsWith('event:')) return result('inconclusive', 'This move objective is unsupported. No incorrect answer has been recorded.', 'unsupported');
        const eventId = exercise.objective.slice(6);
        const supportedBasic = ['fork','absolute-pin','discovered-check','double-check'];
        const supportedMoves = ['capture-checker','interposition','king-check-evasion','discovered-attack','profitable-capture','absolute-skewer','back-rank-mate','smothered-mate','winning-exchange'];
        if (!supportedBasic.includes(eventId) && !supportedMoves.includes(eventId)) return result('inconclusive', 'This concept objective is unsupported. No incorrect answer was recorded.', 'unsupported');
        const detected = supportedBasic.includes(eventId)
          ? basic({fen:exercise.fen, move:answer, scanReplies:false, maxNodes})
          : moveEvents(before, chess, moved, {maxTacticNodes:maxNodes});
        const events = detected.events, event = events.find(e => e.id === eventId);
        if (event) {correct = true; proof = event.evidence;}
        else if (JSON.stringify(detected.diagnostics).includes('exhausted')) return result('inconclusive', 'The proof reached its search limit. Your answer has not been marked wrong; try again or inspect the example.', 'inconclusive');
        else correct = false;
      }
    }
    return result(correct ? 'correct' : 'incorrect', correct ? exercise.explanation : 'This legal move does not meet the exercise’s stated objective. Check the target, king safety and replies.', correct ? 'recognized' : 'not-recognized', proof);
  } catch (error) {return result('inconclusive', 'Validation unavailable: ' + error.message + '. Your answer has not been marked wrong.', 'unavailable');}
}

export function validatePuzzleMove(puzzle, step, value) {
  const chess = legalPosition(puzzle.fen);
  for (const move of puzzle.solution.slice(0, step)) playUci(chess, move);
  let moved;
  try {moved = playUci(chess, value);} catch {return {status:'illegal', feedback:'That move is not legal. Select a piece of the side to move and a legal destination.'};}
  const terminal = chess.isCheckmate();
  if (value === puzzle.solution[step] || terminal) return {status:'correct', move:moved, fen:chess.fen(), terminal};
  return {status:'incorrect', feedback:'That is outside the verified solution. Reconsider checks, captures and threats; the position has been restored.'};
}
