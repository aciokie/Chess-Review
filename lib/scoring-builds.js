// Which engine builds are scored with the Stockfish 19 protocol (fixed 20,000-node exact searches,
// Hash 32, WDL, Lichess accuracy curve). Every SF19 build - the two bundled WASM builds and the
// optional native executable - uses the same protocol and the same models; only the engine that
// performs the search differs. Stockfish 18 NNUE keeps its own depth-based protocol.
export const SF19_BUILDS = Object.freeze(['sf19lite', 'sf19full', 'native19']);
export const SF19_NODES = 20000;
export const isSf19Build = build => SF19_BUILDS.includes(build);
export const scoringBuilds = Object.freeze(['nnue', ...SF19_BUILDS]);
