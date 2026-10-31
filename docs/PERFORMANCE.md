# Performance baseline and spikes

Measurement first: every optimisation in this fork is judged against the numbers below. The harness
runs the real `analysis.js` in the same vm harness the tests use, with **no engine and no browser**,
on a deterministic 160-ply game and a 300-game library.

```bash
npm run perf                                   # table (medians)
node scripts/perf-audit.mjs --json             # machine-readable, for before/after diffs
node scripts/perf-audit.mjs --plies=200 --library=1000 --reps=9
```

Compare runs only at the same `--reps`: the first reps are colder, so a 3-rep run reads noticeably
higher than a 7-rep one on the same revision.

## Baseline — 2026-10-31

160 plies · 300-game library · 7 reps · medians in ms

| Operation | Median | What it covers |
|---|---:|---|
| `parsePgn` | 23.5 | `buildPositions` for the whole game |
| `open` | 44.1 | parse + players + evidence + `buildUI` |
| `classify` | 7.7 | `computeDerived` (classification, accuracy, phases, Elo) |
| `flushRender` | 27.9 | `computeDerived` + `renderAll` (one analysis flush) |
| **`navigate30`** | **395.7** | 30 plies of full navigation (~13 ms per ply) |
| `navigate30MarkerOnly` | 12.2 | the same 30 plies when only the graph marker moves |
| `saveSync` | 0.15 | the synchronous part of `saveToLibrary` |
| `save` | 2.0 | the awaited save (storage write + library merge) |
| `libraryRender` | 81.2 | building 300 library cards |
| `libraryRenderUnchanged` | 0.16 | the same render with nothing changed (retention path) |

What this says:

- **Navigation dominates** (~13 ms/ply, vs 0.4 ms for a graph-only update). That is where the
  candidate optimisations (queue priority, speculative pre-analysis, one layout pass per frame)
  should pay off, and it is why they are ranked above engine work.
- The retention work already shipped is visible: **library 81 → 0.16 ms** and the graph marker path
  **395 → 12 ms** when content is unchanged.
- Classification is cheap (7.7 ms for 160 plies); the cost is DOM and layout, not scoring.

## Spike: is the fixed-node protocol cacheable? (A11)

Driven headlessly in Node against the bundled single-threaded builds, real protocol options
(`Threads 1`, `Hash 32`, `UCI_ShowWDL true`, `MultiPV 1`), same position searched repeatedly:

| Build | separate processes | carried hash | via move history | after another position |
|---|---|---|---|---|
| `stockfish-19-lite-single` | identical | identical | identical | identical |
| `stockfish-19-single` (sf19full) | identical | identical | identical | identical |
| `stockfish-nnue` (SF18 default) | identical | identical | identical | identical |

Sample (`sf19full`): `cp 35 · wdl 70/925/5 · f1b5 · depth 14 · nodes 20017`, byte-identical every time.

Two findings a cache must respect:

1. **The line at the node limit can be a bound, not a verdict.** `stockfish-19-lite-single` ends on
   `score cp 31 lowerbound`, SF18 NNUE on `cp 54 upperbound` — while the classifier only accepts
   *exact* evidence. A cache must therefore store the last **exact** line (lite: `cp 31 · wdl 61/934/5 ·
   depth 11 · nodes 10294`), not simply the last line.
2. **Node counts overshoot slightly and consistently**: 20,000 exactly for lite, 20,017 for full,
   20,001 for nnue. Stable across runs, so still reproducible.

Verdict: the protocol is reproducible enough to cache. **A11 is unblocked.**

## Spike: threading (A16)

Multithreaded build (`stockfish-19.js/.wasm`, 99 MB) loaded in Node, same position:

| Threads | NPS (movetime 3 s) | Speed-up | Depth | Exact score at **20,000 nodes** | Best move |
|---:|---:|---:|---:|---|---|
| 1 | 208,218 | ×1.0 | 20 | cp 35 · wdl 70/925/5 | f1b5 |
| 2 | 603,986 | ×2.9 | 23 | cp 40 · wdl 83/913/4 | f1b5 |
| 4 | 1,241,216 | ×6.0 | 25 | cp 42 · wdl 89/907/4 | f1b5 |
| 8 | 1,724,371 | ×8.3 | 24 | cp 35 · wdl 71/924/5 | **d2d4** |

- **Threads are worth a lot**: ×2.9 at two, ×6.0 at four, ×8.3 at eight nodes/second.
- **But they must never touch scoring.** At the fixed 20,000-node protocol the score moves with the
  thread count, and at eight threads the node limit broke down completely (74,863 nodes searched and
  a different best move). Our published models were fitted single-threaded, and CI's
  `reproduce-public` replay would no longer match.
- Therefore: threads are for the **non-scoring** paths only — live board, engine-panel candidates,
  explore board and practice hints — while scored reviews stay `Threads 1` at 20,000 nodes.

### Cross-origin isolation is not needed

With `cross_origin_embedder_policy`/`cross_origin_opener_policy` in the manifest, an extension page
still reported `crossOriginIsolated: false` — but `SharedArrayBuffer` and a shared
`WebAssembly.Memory` **already work** in extension pages without them. The keys were removed again
(they changed nothing observable). A browser-side probe that actually runs the threaded build inside
an extension page is still outstanding.

## Spike: network reachability (explorer)

From this machine, with a normal browser user agent:

| Endpoint | Status |
|---|---|
| `api.chess.com/pub/...` | 200 |
| `lichess.org/api/user/...` | 200 |
| `explorer.lichess.org/lichess` | **401** |
| `explorer.lichess.org/masters` | **401** |
| `explorer.lichess.ovh/lichess` | **401** |

The Lichess **opening explorer** refuses anonymous requests (its spec declares OAuth2), while the
rest of the Lichess API still works. Consequence for the planned explorer feature: it needs a
**Lichess personal API token**, or a different data source — the personal (own-games) explorer,
which needs no network at all, becomes the offline-safe default.
