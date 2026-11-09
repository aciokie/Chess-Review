// Which engine builds are scored with the Stockfish 19 protocol: an exact depth-22 search (no node
// cap - it reaches millions of nodes), Hash 32, one thread, WDL, exact-only, restricted played-move
// searches. Every SF19 build - the two bundled WASM builds and the optional native executable - uses
// the same protocol and the same models; only the engine that performs the search differs.
// Stockfish 18 NNUE keeps its own depth-based protocol.
//
// The depth is the single source of truth for the scored search. Changing it means regenerating the
// rating evidence and refitting the models (tools/calibration/sf19-run.mjs; see AGENTS.md) - never
// tuning coefficients by hand, and never shipping the protocol without the matching models.
export const SF19_BUILDS = Object.freeze(['sf19lite', 'sf19full', 'native19']);
export const SF19_DEPTH = 22;
export const isSf19Build = build => SF19_BUILDS.includes(build);
export const scoringBuilds = Object.freeze(['nnue', ...SF19_BUILDS]);
