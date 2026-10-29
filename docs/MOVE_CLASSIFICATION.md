# Move classification

This document describes what the classifier does today (`classifyMove`, `isSacrifice`,
`brilliantEligible`, `onlyGoodReply`, `classifyLine` in `analysis.js`). The rules follow the upstream
project's published policy (<https://github.com/T-Julsgaard/Chess-Review>); the category names, icons,
coach wording and the tunable thresholds below are this fork's.

Categories are **annotations**. They never change accuracy or the rating estimate, which come only from
the scoring models (`lib/calibrated-review.js`).

## Evidence

* **Paired evidence (`annotationPair`).** For a completed review the best score and the played move's
  score come from the *same* root search (the played move is searched separately with `searchmoves`
  when it is not the best move). Scores are mover-relative. A position still streaming in, or a side
  line in Explore, falls back to the two neighbouring evaluations, or to MultiPV lines that are exact,
  at one depth, legal, and for the right move.
* **Expected points, not centipawns.** The bucket is the drop in expected points (0–100) between the
  best and the played move, using the public outcome curve of the engine that searched the position:
  Lichess's curve for every Stockfish 19 build (Lite, Full, Native), the fitted public curve for
  Stockfish 18 NNUE (`data/calibration.json` → `quality.outcome`). If the public model failed to load,
  the earlier win% curve is used instead.
* **Mate scores** are compared by sign and distance, never converted to centipawns.

## Baseline buckets

`getStandardRating` buckets the expected-points drop (`data/calibration-legacy.json` → `clsWp`):

| Drop | Bucket |
|------|--------|
| below 2   | excellent |
| 2 to 5    | good |
| 5 to 20   | inaccuracy (mistake from 10 in the plain-move fallback) |
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
   a losing mate or its drop is 5 or more (`safeBook` in `classifyLine`).
2. **Forced move → Best.** Only one legal move existed.
3. **Brilliant** (below).
4. **Great** (below).
5. **Mate transitions** (mover-relative): throwing a mate away into being mated is a Blunder; delaying
   your own mate is Good; escaping a mate against you is Best/Excellent; slowing an unavoidable mate
   keeps the ordinary bucket.
6. **Best.** The move is the engine's top move.
7. Starting or keeping a forced mate is Excellent.
8. **Miss** (below).
9. **Mistake / Blunder from mate or advantage swings.**
10. **Fallback** to the baseline bucket.

## Brilliant

A sound, voluntary piece offer with strict board and engine evidence. All of these hold:

- **Real offer (`isSacrifice`).** A non-pawn piece is left capturable at a strictly positive local
  material cost, after crediting what the move itself captured or promoted. Bounded legal exchange
  search (128 nodes) finds the cost; the piece must have had a legal way to avoid the loss
  (`couldBeSaved`); an offer that was already there is not credited to this move; and the offer must
  be **lasting** (`hasLastingOffer`): a short forcing capture sequence (3 plies, 512 nodes, finishing
  each exchange) must not simply win the material back.
- **Sound.** The move is in the Excellent bucket, is evaluated at least -0.5 pawns for the mover (or a
  winning mate), and does not delay a known mate.
- **Not already won.** In an undecided position (below +5 pawns) the sound offer qualifies. In a clearly
  winning position it also needs a second exact MultiPV line at the same depth showing the best
  alternative is below +5 pawns. With a single line this is unknown, so the move stays Best/Excellent.

A preceding opponent error is not required.

## Great

A Great move is the **only good reply**, not merely a reply after an error:

- Excellent bucket, no mate involved, and the opponent's previous move was a Blunder or a Mistake-sized
  slip that was not itself part of a "miss" chain.
- `onlyGoodReply`: the root has an exact second line at the same depth for a different legal move, and
  that runner-up is at least the Inaccuracy threshold (5 expected points) worse than the played move.
  With one line this is unknown and the move keeps its ordinary category.

## Miss

- **Lost mate.** A forced mate existed, was thrown away, and the mover had been winning.
- **Failed to punish.** The opponent just erred, the mover's move is an Inaccuracy or Blunder, it does
  not leave the mover clearly ahead, and its loss is no more than the opponent's loss plus `clsMissTol`.

## Extra annotation lines

Brilliant in a won position and Great need a second line. With **Analysis lines = 1** (the default)
the review searches one line per position (fast) and those two cases stay at Best/Excellent. Raising
**Analysis lines** to 2 or more makes the review run one extra multi-line search per position at the
chosen depth (stored as `annotationSearch`, validated for exactness/depth/legality). It is used only
for categories and never replaces the scored best/played pair.

## Move grades

`lib/move-grades.js` (`moveGrade`) gives each move a 0–10 score *within* its category (for example an
Excellent move that lost 1 point scores lower than one that lost none; a Great move scores higher the
larger its gap to the runner-up). Grades are shown in the move-info header. They do not feed accuracy
or rating.

## Game statistics

When a public scoring model applies and the review is complete, `lib/game-statistics.js` derives
top-move match, average pawn loss, largest loss, longest clean streak and (when the game has a clock
record) average think time from the already-scored decisions. Nothing is re-searched, and mate scores
are excluded from the centipawn statistics.

## Not covered by these rules

- Delayed or multi-move sacrifices, and compensation that only shows up later.
- Intermediate checks elsewhere on the board.
