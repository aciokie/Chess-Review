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

A Brilliant move is a sound, voluntary piece sacrifice evaluated using strict board and engine evidence (`isSacrifice` and `brilliantEligible`). It requires:

- **Sound material offer.** The move must be in the `excellent` win%-drop bucket. The resulting position score must meet a soundness floor of at least -0.5 pawns (or a winning mate).
- **Sound mate maintenance.** If a winning mate existed before, the move must maintain or accelerate a winning mate (`soundMate`).
- **Already-winning gate / Real alternative.** In undecided positions (< +5 pawns), the sound sacrifice qualifies. In clearly winning positions (>= +5 pawns or pre-existing winning mate), it requires MultiPV > 1 with the top alternative line falling below +5 pawns and not retaining a winning mate.

Promotions credit captured material and promotion gains before requiring a strictly positive net material cost; pure pawn offers never qualify.

### Sacrifice test (`isSacrifice`)

Sacrifices are evaluated via bounded legal exchange analysis (`exchangeGain`, capped at 128 nodes per candidate square) on non-pawn pieces:

- **Net material cost.** The local exchange gain on the attacked square must strictly exceed any material captured or gained via promotion on the played move. Equal or profitable trades do not qualify.
- **Move attribution.** For unmoved hanging pieces, exchange gains before and after are compared (or prior threats / tempo sacrifices evaluated) to ensure the offer was created or increased by the move itself.
- **Real choice (`couldBeSaved`).** The piece must have had a legal alternative move that avoided the material loss (moving, defending, attacking, or equal trading). Forced sole legal moves remain Best.

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

## Stricter Brilliant Policy Alignment

This fork aligns with the stricter Brilliant policy:
- Uses bounded exchange analysis (`exchangeGain` with 128-node cap) to confirm strictly positive material loss.
- Requires attribution to the move itself for unmoved pieces.
- Enforces a soundness floor of -0.5 pawns or winning mate.
- Gates already-winning positions (>= +5 pawns) by checking that the MultiPV > 1 runner-up line drops below +5 pawns.
- Does not require a preceding opponent error.
