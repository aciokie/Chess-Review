import test from 'node:test';
import assert from 'node:assert/strict';
// Import order matters: chrome-stub must run before lichess.js so gamecache sees a store.
import { chromeStub } from './helpers/chrome-stub.mjs';
import { fetchGamePgn } from '../lichess.js';

// Regression tests for the Lichess import fixes (port of upstream b58b5fed):
//  * a 200 response that is actually a signup/login HTML page must not be cached or parsed;
//  * an HTML page that slipped into the cache earlier is ignored and re-fetched;
//  * a real PGN is returned and cached.

function makeStore(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    get: async (k) => (data.has(k) ? { [k]: data.get(k) } : {}),
    set: async (obj) => { for (const [k, v] of Object.entries(obj)) data.set(k, v); },
    remove: async (keys) => { for (const k of keys) data.delete(k); },
  };
}

const PGNS = '[Event "Test"]\n[Site "https://lichess.org/CZmytj0X"]\n\n1. e4 e5 2. Nf3 *';
const cacheKey = 'gamecache:lichess:CZmytj0X';

async function withStore(store, fetchImpl, fn) {
  const origFetch = globalThis.fetch;
  chromeStub.storage.local = store;
  globalThis.fetch = fetchImpl;
  try {
    const result = await fn();
    // setCachedGame is fire-and-forget inside fetchGamePgn; let it settle before assertions.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return result;
  } finally {
    globalThis.fetch = origFetch;
  }
}

const htmlResponse = () => ({ ok: true, status: 200, text: async () => '<!doctype html><html>sign up</html>' });
const pgnResponse = (body) => ({ ok: true, status: 200, text: async () => body });

test('an HTML page returned with HTTP 200 is rejected and never cached', async () => {
  const store = makeStore();
  let calls = 0;
  await withStore(store, async () => { calls++; return htmlResponse(); }, async () => {
    await assert.rejects(() => fetchGamePgn('CZmytj0X'), /web page instead of a PGN/);
  });
  assert.equal(calls, 1);
  assert.equal(store.data.has(cacheKey), false, 'HTML must not be cached as a PGN');
});

test('an HTML page already in the cache is ignored and the PGN is re-fetched', async () => {
  const store = makeStore({ [cacheKey]: { t: 1, data: '<!doctype html><html>stale</html>' } });
  let calls = 0;
  await withStore(store, async () => { calls++; return pgnResponse(PGNS); }, async () => {
    assert.equal(await fetchGamePgn('CZmytj0X'), PGNS);
  });
  assert.equal(calls, 1, 'the stale HTML entry must not satisfy the cache');
  assert.equal(store.data.get(cacheKey).data, PGNS, 'the good PGN replaces the stale entry');
});

test('a cached finished PGN is returned without any network call', async () => {
  const store = makeStore({ [cacheKey]: { t: 1, data: PGNS } });
  let calls = 0;
  await withStore(store, async () => { calls++; return pgnResponse('nope'); }, async () => {
    assert.equal(await fetchGamePgn('CZmytj0X'), PGNS);
  });
  assert.equal(calls, 0);
});

test('a fresh finished PGN is cached', async () => {
  const store = makeStore();
  await withStore(store, async () => pgnResponse(PGNS), async () => {
    assert.equal(await fetchGamePgn('CZmytj0X'), PGNS);
  });
  assert.equal(store.data.get(cacheKey).data, PGNS);
});
