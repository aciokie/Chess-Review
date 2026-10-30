// A minimal `chrome` stub for tests that import extension modules in plain Node.
// gamecache.js / browser-compat.js read the `chrome` global ONCE when they first
// evaluate, so this module must be imported before lichess.js. The backing store is
// swappable per test via `chromeStub.storage.local`.
export const chromeStub = { storage: { local: null } };
globalThis.chrome = chromeStub;
