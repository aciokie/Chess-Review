# Reproducible public calibration methodology

This document summarizes the reproducibility methodology and engine scoring formulas used for calibration.

## Scored Engine Quality

Expected game points from evaluation centipawns:
`E(cp) = 1 / (1 + exp(-k * cp))`

Move quality from expected points drop `d = E(best) - E(played)`:
`quality = 100 * exp(-beta * max(0, d))`

## Category Classification

Move categories use expected-points loss bands along with board and context rules:
- **Brilliant:** Sound voluntary piece sacrifice verified by bounded exchange analysis (`exchangeGain` capped at 128 nodes), meeting a soundness floor (-0.5 pawns) and competitive-relevance gate (+5 pawns MultiPV check).
- **Great:** Only-good move that capitalises on an opponent blunder or mistake.
- **Best:** Top move reported by the engine or sole forced move.
- **Excellent / Good / Inaccuracy / Mistake / Blunder:** Categorized by expected-points loss drop thresholds.

## Accuracy Aggregation

Game accuracy combines per-move quality scores using weighted/power aggregation over nonforced decisions:
`Accuracy = weightedMean(moveQuality, volatilityWeights)`

Annotations and move labels are independent of numerical accuracy and Elo estimation models.
