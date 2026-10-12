# Move classification: Brilliant and special-move rules

This document describes what this fork's classifier does today (`classifyMove`, `isSacrifice`,
`classifyLine` in `analysis.js`). It is a description of the implemented rules, not a proposal.
The last section compares them with the upstream project's published policy.

Evaluations are read from the white-relative `S.evals[]` and converted to the mover's point of view.
"Loss" is the eval drop (in pawns) caused by the move; the baseline bucket uses the **win% drop**.

## Baseline buckets

`getStandardRating` buckets a move by win% drop (`data/calibration.json` → `clsWp`):

| Win% drop | Bucket |
|-----------|--------|
| below 2   | excellent |
| 2 to 5    | good |
| 5 to 20   | inaccuracy (split to mistake at 10 or more, in the plain-move fallback) |
| 20 or more | blunder |

Special categories are decided first; anything not claimed by a rule below falls back to this bucket.

## Tunable thresholds (Engine settings → Move classification)

| Setting | Default | Meaning |
|---------|---------|---------|
| `clsClearAdv` | 2.0 pawns | What counts as a "clear advantage" |
| `clsMistakeLoss` | 1.2 pawns | Minimum eval lost for a Mistake, and for an opponent slip to be "punishable" |
| `clsMissTol` | 0.5 pawns | How close to giving back the whole advantage still counts as a Miss |

## Rule order

`classifyMove` evaluates top to bottom and returns at the first match.

1. **Book.** The resulting position is in `data/book.json`. Theory is ignored if the move walks into
   a losing mate or its win% drop is 5 or more (`safeBook` in `classifyLine`).
2. **Forced move → Best.** Only one legal move existed. There is no separate "forced" icon.
3. **Brilliant** (below).
4. **Great** (below).
5. **Best.** The move is the engine's top move (including a mating move).
6. **Mate handling** (excellent / good): starting or keeping a forced mate is Excellent; delaying
   your own mate, or slowing an unavoidable mate against you, is Good.
7. **Miss** (below).
8. **Mistake / Blunder from mate or advantage swings.**
9. **Fallback** to the baseline bucket.

## Brilliant

A Brilliant move is a real, voluntary sacrifice that is also sound. It needs `sac[i]` (see the
sacrifice test) **and** one of:

- **Punishing a slip.** The move is in the Excellent bucket, no mate score is involved, and the
  opponent's previous move was an Inaccuracy or Blunder. A slip two or three plies back also counts
  when the plies in between were clean. It is suppressed if the previous move was itself a Brilliant
  sacrifice (`previousBrilliant`), so back-to-back sacrifices don't both get the label.
- **Starting a mate.** There was no mate before, the move creates a forced mate, and the mover is winning.
- **Keeping a mate.** A mate existed before and still does, it is not slowed, and the mover is winning.

Promotions are never treated as sacrifices.

### Sacrifice test (`isSacrifice`)

The board after the move is inspected for mover pieces (never pawns) that can be captured.
A piece counts as sacrificed when:

- It has no legal defenders, it is attacked, and the move itself did not capture a piece larger than a pawn.
- It is a knight or bishop, the move captured nothing, and a pawn attacks it.
- It is a rook that is attacked, unless the move captured a rook or queen, or the only attacker is a
  queen or rook and the rook is defended, or the move captured a minor piece and the rook is defended.
- It is a queen that is attacked, unless the move captured a queen, or the only attacker is a queen
  (or a rook, when the move captured a rook) and the queen is defended.

Attackers and defenders are legal ones, and defenders are counted after a hypothetical capture so x-ray
recaptures are seen. Finally, the piece must have been **savable** in the position before the move
(`couldBeSaved`): it was unattacked and some other move existed, or it had a safe flight square. This is
what separates a sacrifice from a forced loss.

An equal trade is therefore never Brilliant.

## Great

A Great move is an only-good move that capitalises on the opponent's error. All of these hold:

- Excellent bucket, no mate score involved, no mate in the two preceding positions.
- The opponent's previous move was a Blunder, or a Mistake-sized slip (an Inaccuracy-bucket move that
  lost at least `clsMistakeLoss` and gave up or handed over a clear advantage).
- The previous move was not itself part of a "miss" chain (`previousMiss`).

Great is not awarded on top of an existing Brilliant, which is checked first.

## Miss

A Miss means an opportunity was not taken:

- **Lost mate.** A forced mate existed, was thrown away, and the mover had been winning.
- **Failed to punish.** The opponent just blundered or made a punishable mistake, the mover's move is
  an Inaccuracy or Blunder, and its loss is no more than the opponent's loss plus `clsMissTol`.

Miss is contextual: the opponent's earlier error is not charged to the mover.

## Mistake and Blunder involving mate or a clear advantage

- Inaccuracy-sized loss of at least `clsMistakeLoss` that drops the mover from a clear advantage to
  below it, or from not-clearly-worse to clearly worse, becomes a **Mistake**.
- Walking into a mate becomes a **Mistake** if the mover wasn't already clearly lost, otherwise a **Blunder**.
- Throwing a win straight into a mate is a **Blunder**.

## Not covered by these rules

- Delayed or multi-move sacrifices, and compensation that only shows up later.
- Intermediate checks elsewhere on the board.
- Brilliant is only judged against single-line evaluations. There is no check that the sacrifice was
  the only winning option, so a sacrifice that wins when many moves also win can still be labelled.
- Accuracy and the rating estimate are computed from the win%-based method, not from these labels
  (see `computeDerived`). The displayed accuracy is derived from categories; the Elo estimate is not.

## How this differs from upstream

The upstream project (T-Julsgaard/Chess-Review) documents a stricter Brilliant policy in
`tools/calibration/BRILLIANT_MOVES.md`. In summary it requires:

- A bounded legal exchange analysis on one square (cap of 128 positions per candidate), with the net
  material cost strictly positive. This fork uses the attacker/defender heuristic above instead.
- The offer must be attributable to the move itself, not to unrelated hanging material.
- A real alternative: a forced sole legal move stays Best, and pure pawn offers never qualify.
- A soundness floor of about -0.5 pawns (or a winning mate) after the move.
- A competitive-relevance gate: at +5 pawns or better, the best alternative must be below +5.
  This needs MultiPV above 1; with MultiPV=1 the move keeps its ordinary category.
- Exact, same-depth root scores, with bounded or incomplete lines withholding the label.
- No requirement that the opponent erred on the previous move.

Upstream's Great also gates on a runner-up gap, and its grading code is in `move-grades.js`. This fork
does not have that file. This fork's rules derive from Brilliant-Chess (MIT, see `THIRD_PARTY_NOTICES.md`),
which is why the two policies differ. Moving to the upstream policy would change which moves are labelled
and would need its own tests. It is not part of this document.
