# Current calibration tools

This directory contains the current public calibration, its supporting math,
and offline reproduction. It is included in source packages; the
extension loads only `data/calibration.json` and the runtime scorers in `lib/`.

With **Node.js 24 or later**, run from the repository root:

```sh
node tools/calibration/reproduce-public.mjs
```

No npm dependencies, network, engine run or old research directory is needed.
See [PUBLIC_METHOD.md](PUBLIC_METHOD.md) for the restricted read-only command,
definitions, source records and interpretation limits.

| Files | Why they stay |
| --- | --- |
| `public/` | Frozen release inputs, engine evidence, expected outputs and hash records. |
| `reproduce-public.mjs` | Refits current coefficients and checks archived scores and hashes. |
| `sf19-evidence.mjs` | Turns a search cache into `public/sf19-rating-evidence.json.gz` and verifies a file against `sf19-cohort.json` (cohort, ply sets, derived fields). CLI: `freeze-cohort`, `verify`. |
| `sf19-run.mjs` | Resumable driver around `../calibration-experiments/analyze-games.mjs`: prepares the run directory from the bundled dataset, runs bounded chunks with the pinned SF19 Lite WASM (`--depth 22`, 4 workers, durable per-search cache), reports coverage/rate/ETA and builds the evidence file. |
| `sf19-cohort.json` | The frozen cohort contract: 750 training games, 1,498 player sides, 52,239 plies, and a hash. Two black sides (HsowT6Qd, 4eLPtn5c) are dropped because they have fewer than ten nonforced decisions - the moves-only minimum - which is exactly the 20-ply difference to the cohort games' 52,259 plies. |
| `human-policy.mjs`, `grouped-human-choice.mjs` | Fit expected human points and game-weighted legal-move choice. |
| `peer-quality.mjs`, `fullgame-context.mjs` | Fit and assess the recorded-rating contextual model. |
| `sf19-context.mjs` | Reconstruct SF19 contextual peers from fixed-node WDL evidence and compare game-separated CRPS with an unconditional baseline. |
| `fit-rating.mjs`, `fit-huber.mjs`, `core.mjs`, `io.mjs` | Shared mathematics, rating regression and provenance/hash helpers. |
| `engine.mjs`, `engine-host.cjs` | Reusable local engine harness, retained for the real-engine regression test and future evidence collection. Not used by offline replay. |
| `category-benchmark.mjs` | Evaluates supplied independent human annotations, reporting disagreement and abstention. No validated benchmark dataset is bundled. |
| [BRILLIANT_MOVES.md](BRILLIANT_MOVES.md) | Current special-annotation mechanics, sources and limitations. |

## Regenerating the SF19 rating evidence

The two SF19 rating models are fitted from engine evidence, so changing the scored search protocol
(as from the old fixed 20,000-node searches to the depth-22 protocol) means regenerating that
evidence and refitting - never editing coefficients. The workflow (all local, no network):

```sh
node tools/calibration/sf19-run.mjs prepare                # dataset + cohort ids in ignored calibration-runs/sf19-d22/
node tools/calibration/sf19-run.mjs run --minutes 40       # repeat; each chunk is bounded and resumable
node tools/calibration/sf19-run.mjs status                 # coverage, distinct-search reference, rate, ETA
node tools/calibration/sf19-run.mjs build --out calibration-runs/sf19-d22/evidence.json.gz
```

Every search is a cold, single-thread, Hash-32 search with the pinned SF19 Lite WASM at the run's
depth, and analyze-games fsyncs each result before the next search starts, so a killed chunk only
loses the searches in flight; `run` bounds its child by a deadline and hard-stops it after that.
The cache deduplicates identical positions across games (it keys on history and played move), so the
cohort needs ~79k distinct searches (48,535 best + ~30,407 restricted) rather than the 84,148
undeduplicated lookups. After `build`, `sf19-evidence.mjs verify` re-checks a promoted file against
the frozen cohort; `tests/sf19-evidence.test.mjs` locks the published file and the cohort hash.

Keep one-off investigations and audit reports in ignored `scratch/`. Maintained
research for future accuracy, rating and move-category methods belongs in the
separate [upstream research workspace](https://github.com/T-Julsgaard/Chess-Review/blob/main/research/README.md), including unsuccessful
experiments. Keep experimental scripts and candidates there, with bulk runs in
ignored `research/runs/`. This directory retains only tooling and evidence needed
by the active model or a maintained calibration tool; promotion updates its
methodology and reproduction inputs explicitly.
