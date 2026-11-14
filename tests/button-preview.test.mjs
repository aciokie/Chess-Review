import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { previewGameKey, savedButtonSummary } from '../lib/button-preview.js';
import { analyseButtonPreview, finishedPreviewGame, previewCategory, PREVIEW_NODES } from '../lib/preview-analysis.js';
import { createButtonPreviewService, previewFailureReason } from '../lib/button-preview-service.js';
import { createPreviewRunner } from '../lib/preview-runner.js';
import { app, loadGame } from './helpers/app.mjs';

// The public SF18 model the preview scores with (values from data/calibration.json). The preview
// must use the shipped model, never a private curve.
const MODEL = {
  quality: { outcome: { slopePerPawn: 0.21367705872097242 }, choice: { temperature: 21.42704255760559 } },
  clsWp: { good: 2, inacc: 5, mistake: 10, blunder: 20 },
};

const PGN = `[Event "Preview probe"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 O-O 1-0`;

test('preview keys come from the game URL only', () => {
  assert.equal(previewGameKey('https://www.chess.com/game/live/12345678'), 'chesscom:12345678');
  assert.equal(previewGameKey('https://www.chess.com/analysis/game/live/12345678/review'), 'chesscom:12345678');
  assert.equal(previewGameKey('https://lichess.org/abcd1234/black'), 'lichess:abcd1234');
  assert.equal(previewGameKey('https://lichess.org/game/abcd1234'), 'lichess:abcd1234');
  // No game → no preview: routes, other hosts and non-https are refused.
  assert.equal(previewGameKey('https://lichess.org/training/abcd1234'), null);
  assert.equal(previewGameKey('https://example.com/game/live/12345678'), null);
  assert.equal(previewGameKey('not a url'), null);
});

test('only a completed standard game can be previewed', () => {
  assert.deepEqual(finishedPreviewGame(PGN).players, { w: 'Alice', b: 'Bob' });
  assert.equal(finishedPreviewGame(PGN).moves.length, 14);
  assert.throws(() => finishedPreviewGame(PGN.replace('[Result "1-0"]', '[Result "*"]')), /completed game/);
  assert.throws(() => finishedPreviewGame(PGN.replace('[Result "1-0"]', '[Result "1-0"]\n[FEN "8/8/8/8/8/8/8/K6k w - - 0 1"]')), /Unsupported/);
  assert.throws(() => finishedPreviewGame(PGN.replace('[Result "1-0"]', '[Result "1-0"]\n[Variant "Chess960"]')), /variant/);
});

test('a preview badge uses the review thresholds, and forced moves are not decisions', () => {
  const t = MODEL.clsWp;
  assert.equal(previewCategory({ forced: true, top: false, loss: .4 }, t), 'forced');
  assert.equal(previewCategory({ top: true, loss: 0 }, t), 'best');
  assert.equal(previewCategory({ top: false, loss: .01 }, t), 'excellent');
  assert.equal(previewCategory({ top: false, loss: .03 }, t), 'good');
  assert.equal(previewCategory({ top: false, loss: .07 }, t), 'inacc');
  assert.equal(previewCategory({ top: false, loss: .15 }, t), 'mistake');
  assert.equal(previewCategory({ top: false, loss: .5 }, t), 'blunder');
});

test('the preview searches every decision at 20,000 nodes and reports accuracy with a tally', async () => {
  const calls = [];
  const engine = () => ({
    async setOptions(options) { this.options = options; },
    async analyse(fen, depth, multipv, history, onProgress, options = {}) {
      calls.push({ fen, options });
      // The unrestricted search is the reference; the restricted one is the move actually played.
      return { bestmove: options.searchMove || 'a2a3', score: options.searchMove ? { cp: -120 } : { cp: 0 }, pv: '', lines: [] };
    },
    terminate() {},
  });
  const result = await analyseButtonPreview(PGN, {
    createEngine: engine,
    loadCalibration: async () => MODEL,
    workers: 2,
  });
  assert.equal(result.estimated, true, 'a preview is always labelled an estimate');
  assert.equal(result.budget, PREVIEW_NODES);
  assert.ok(calls.length >= 14, 'every ply was searched');
  for (const call of calls) {
    assert.deepEqual(call.options.budget, { kind: 'nodes', value: PREVIEW_NODES });
  }
  assert.ok(calls.some((call) => call.options.searchMove), 'the played move is searched at the same budget');
  // 14 plies, 7 each side; no forced position in this game.
  assert.equal(result.counts.w.forced + Object.entries(result.counts.w).filter(([k]) => k !== 'forced').reduce((n, [, v]) => n + v, 0), 7);
  assert.equal(result.counts.b.forced + Object.entries(result.counts.b).filter(([k]) => k !== 'forced').reduce((n, [, v]) => n + v, 0), 7);
  for (const side of ['w', 'b']) {
    assert.ok(Number.isFinite(result.accuracy[side]) && result.accuracy[side] > 0 && result.accuracy[side] < 100);
  }
});

test('the preview never reaches storage and a saved review wins over it', async () => {
  const payload = { pgn: PGN, meta: { url: 'https://www.chess.com/game/live/12345678' } };
  const library = [{
    id: '12345678', pgn: PGN, url: 'https://www.chess.com/game/live/12345678', meSide: 'w',
    myAcc: 91.2, opAcc: 84.4,
    myCounts: { best: 10, great: 1, blunder: 1 }, opCounts: { best: 9, inacc: 2 },
  }];
  let previews = 0;
  const service = createButtonPreviewService({
    api: { storage: { local: { get: async () => ({ username: 'alice', library }) } } },
    loadGame: async () => payload,
    runPreview: async () => { previews++; throw Error('must not run'); },
  });
  const saved = await service.get(7, 'chesscom:12345678');
  assert.equal(saved.ok, true);
  assert.equal(saved.estimated, false, 'a full review is not an estimate');
  assert.deepEqual(saved.accuracy, { w: 91.2, b: 84.4 });
  assert.deepEqual(saved.counts.w, { best: 10, great: 1, blunder: 1 });
  assert.equal(saved.me, 'w', 'the stored handle seats the summary');
  assert.equal(previews, 0);
});

test('without a saved review the estimate is computed once and cached', async () => {
  const payload = { pgn: PGN, meta: { url: 'https://www.chess.com/game/live/12345678' } };
  let previews = 0;
  const service = createButtonPreviewService({
    api: { storage: { local: { get: async () => ({ username: '', library: [] }) } } },
    loadGame: async () => payload,
    runPreview: async () => {
      previews++;
      return { estimated: true, accuracy: { w: 70.5, b: 65.1 }, counts: { w: { best: 4 }, b: { blunder: 2 } } };
    },
  });
  const first = await service.get(7, 'chesscom:12345678');
  assert.equal(first.ok, true);
  assert.equal(first.estimated, true);
  assert.equal(first.me, null);
  const second = await service.get(7, 'chesscom:12345678');
  assert.deepEqual(second.accuracy, first.accuracy);
  assert.equal(previews, 1, 'the session cache answers the repeat');
});

test('a failed lookup is labelled with a reason the page can explain', () => {
  assert.equal(previewFailureReason({ code: 'GAME_NOT_ARCHIVED' }), 'archive');
  assert.equal(previewFailureReason({ code: 'PREVIEW_ENGINE_UNAVAILABLE' }), 'engine');
  assert.equal(previewFailureReason({ code: 'PREVIEW_HOST_UNAVAILABLE' }), 'host');
  assert.equal(previewFailureReason({ code: 'PREVIEW_TIMEOUT' }), 'timeout');
  assert.equal(previewFailureReason({ code: 'IMPORT_TIMEOUT' }), 'timeout');
  assert.equal(previewFailureReason({ code: 'PREVIEW_GAME_CHANGED' }), 'changed');
  assert.equal(previewFailureReason({ code: 'IMPORT_CANCELLED' }), 'unknown');
  assert.equal(previewFailureReason(Error('boom')), 'unknown', 'no code is still a diagnosable failure');
});

test('an engine that never starts is an environment failure, not a bad game', async () => {
  await assert.rejects(
    () => analyseButtonPreview(PGN, {
      createEngine: () => { throw Error('wasm blocked'); },
      loadCalibration: async () => MODEL,
    }),
    (error) => error.code === 'PREVIEW_ENGINE_UNAVAILABLE' && /wasm blocked/.test(error.message),
  );
  await assert.rejects(
    () => analyseButtonPreview(PGN, {
      createEngine: () => ({
        async setOptions() { throw Error('engine died'); }, terminate() {},
      }),
      loadCalibration: async () => MODEL,
    }),
    (error) => error.code === 'PREVIEW_ENGINE_UNAVAILABLE',
  );
});

test('the reason survives the service and reaches the card', async () => {
  const archived = Object.assign(Error('not archived yet'), { code: 'GAME_NOT_ARCHIVED' });
  const service = createButtonPreviewService({
    api: { storage: { local: { get: async () => ({}) } } },
    loadGame: async () => { throw archived; },
    runPreview: async () => { throw Error('must not run'); },
  });
  const result = await service.get(7, 'chesscom:12345678');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'archive');
  assert.match(result.error, /not archived yet/);
});

test('a slow preview host is waited for, and re-created mid-way', async () => {
  let attempts = 0, created = 0;
  const api = {
    runtime: {
      getURL: (path) => 'chrome-extension://test/' + path,
      getContexts: async () => [],
      sendMessage: async (message) => {
        if (message.type !== 'analyse') return undefined;
        attempts++;
        return attempts < 5 ? undefined : { ok: true, summary: { estimated: true } };
      },
    },
    offscreen: { createDocument: async () => { created++; }, closeDocument: async () => {} },
  };
  const runner = createPreviewRunner(api, async () => { throw Error('unused'); }, { delays: [0, 0, 0, 0, 0, 0, 0] });
  const summary = await runner(PGN);
  assert.deepEqual(summary, { estimated: true });
  assert.equal(attempts, 5);
  assert.equal(created, 2, 'the document is ensured again when the first attempts go nowhere');
});

test('a host that dies before scoring is rebuilt and the job is retried once', async () => {
  let attempts = 0, closed = 0, created = 0;
  const api = {
    runtime: {
      getURL: (path) => 'chrome-extension://test/' + path,
      getContexts: async () => [],
      sendMessage: async (message) => {
        if (message.type !== 'analyse') return undefined;
        attempts++;
        return attempts <= 4 ? undefined : { ok: true, summary: { estimated: true, budget: PREVIEW_NODES } };
      },
    },
    offscreen: { createDocument: async () => { created++; }, closeDocument: async () => { closed++; } },
  };
  const runner = createPreviewRunner(api, async () => { throw Error('unused'); }, { delays: [0, 0, 0, 0] });
  const summary = await runner(PGN);
  assert.equal(summary.estimated, true);
  assert.equal(attempts, 5, 'the dead host is dropped and one fresh attempt is made');
  assert.ok(closed >= 1, 'the dead document is closed before the retry');
  assert.ok(created >= 2);
});

test('a host that never answers reports a host failure, not a silent hang', async () => {
  const api = {
    runtime: {
      getURL: (path) => 'chrome-extension://test/' + path,
      getContexts: async () => [],
      sendMessage: async () => undefined,
    },
    offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
  };
  const runner = createPreviewRunner(api, async () => { throw Error('unused'); }, { delays: [0, 0, 0, 0] });
  await assert.rejects(() => runner(PGN), (error) => error.code === 'PREVIEW_HOST_UNAVAILABLE');
});

test('a game that changed under the tab is refused', async () => {
  const service = createButtonPreviewService({
    api: { storage: { local: { get: async () => ({}) } } },
    loadGame: async () => ({ pgn: PGN, meta: { url: 'https://www.chess.com/game/live/99999999' } }),
    runPreview: async () => { throw Error('must not run'); },
  });
  const result = await service.get(7, 'chesscom:12345678');
  assert.equal(result.ok, false);
});

// Chess.com badges only the moves worth looking at. Listing all ten categories would be noise, so
// the card shows the review's own NOTEWORTHY set with the extension's real badge artwork — and a
// category it does not show must be absent, not a zero.
test('the in-page card renders the estimate with accuracy and only the notable badges', async () => {
  const dom = new JSDOM('<div class="row"><button id="review">Analyze with Chess Review</button></div>', {
    url: 'https://www.chess.com/game/live/12345678', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window;
  const sent = [];
  w.chrome = { runtime: {
    getURL: (path) => 'chrome-extension://test/' + path,
    sendMessage: async (message) => {
      sent.push(message);
      if (message.type !== 'buttonPreview') return { ok: true };
      return {
        ok: true, key: 'chesscom:12345678', estimated: true,
        players: { w: 'Alice', b: 'Bob' }, accuracy: { w: 88.8, b: 77.7 },
        counts: {
          w: { brilliant: 1, best: 3, excellent: 2, blunder: 1 },
          b: { inacc: 2, excellent: 4, forced: 1 },
        },
        me: 'w',
      };
    },
  } };
  w.eval(readFileSync(new URL('../button-preview-content.js', import.meta.url), 'utf8'));
  const button = w.document.getElementById('review');
  w.ChessReviewButtonPreview.register(button, { getContext: () => ({ key: 'chesscom:12345678' }), api: w.chrome });
  await new Promise((resolve) => w.setTimeout(resolve, 0));

  const card = button.nextElementSibling;
  assert.equal(card.className, 'chess-review-preview');
  assert.equal(card.dataset.state, 'ready');
  assert.equal(card.querySelector('.chess-review-preview-tag').textContent, 'Estimate');
  assert.match(card.querySelector('.chess-review-preview-note').textContent, /20,000/);
  assert.equal(sent[0].type, 'buttonPreview');
  const sides = [...card.querySelectorAll('.chess-review-preview-side')];
  assert.deepEqual(sides.map((side) => side.dataset.side), ['w', 'b'], 'the open seat is listed first');
  assert.equal(sides[0].dataset.self, 'true');
  assert.equal(sides[0].querySelector('.chess-review-preview-acc').textContent, '~88.8%');

  const cats = (side) => [...side.querySelectorAll('.chess-review-preview-badge')].map((chip) => chip.dataset.cat);
  assert.deepEqual(cats(sides[0]), ['brilliant', 'blunder'], 'only the notable categories are badged');
  assert.deepEqual(cats(sides[1]), ['inacc'], 'Best/Excellent/Good/Forced never earn a badge');

  // The artwork is the extension's own SVG badge, not a text glyph standing in for it.
  assert.match(sides[0].querySelector('[data-cat="brilliant"] img').src, /icons\/brilliant\.svg$/);
  assert.match(sides[1].querySelector('[data-cat="inacc"] img').src, /icons\/inaccuracy\.svg$/);
  assert.equal(sides[0].querySelector('[data-cat="brilliant"] .chess-review-preview-badge-count').textContent, '1');
  assert.equal(sides[0].querySelector('[data-cat="brilliant"]').getAttribute('title'), 'Brilliant: 1');
  dom.window.close();
});

// "Unavailable" with no explanation and no way back was the worst failure mode: name the reason and
// let the user ask again.
test('an unavailable card explains itself and retries on demand', async () => {
  const dom = new JSDOM('<div class="row"><button id="review">Analyze with Chess Review</button></div>', {
    url: 'https://www.chess.com/game/live/12345678', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window;
  const warnings = [];
  w.console.warn = (...args) => warnings.push(args.join(' '));
  let answers = 0, requests = 0;
  w.chrome = { runtime: { sendMessage: async (message) => {
    if (message.type !== 'buttonPreview') return { ok: true };
    requests++;
    if (++answers === 1) return { ok: false, key: 'chesscom:12345678', reason: 'engine', error: 'wasm blocked' };
    return {
      ok: true, key: 'chesscom:12345678', estimated: true, players: { w: 'Alice', b: 'Bob' },
      accuracy: { w: 80, b: 70 }, counts: { w: { best: 1 }, b: { best: 1 } }, me: null,
    };
  } } };
  w.eval(readFileSync(new URL('../button-preview-content.js', import.meta.url), 'utf8'));
  const button = w.document.getElementById('review');
  w.ChessReviewButtonPreview.register(button, { getContext: () => ({ key: 'chesscom:12345678' }), api: w.chrome });
  await new Promise((resolve) => w.setTimeout(resolve, 0));

  const card = button.nextElementSibling;
  assert.equal(card.dataset.state, 'unavailable');
  assert.equal(card.dataset.reason, 'engine');
  assert.match(card.querySelector('.chess-review-preview-wait').textContent, /engine couldn't start/);
  assert.equal(card.querySelector('.chess-review-preview-wait').getAttribute('title'), 'wasm blocked');
  assert.equal(warnings.length, 1, 'the raw failure is logged once for a bug report');
  assert.match(warnings[0], /preview unavailable \(engine\)/);

  const retry = card.querySelector('.chess-review-preview-retry');
  assert.ok(retry, 'the card offers a way forward');
  retry.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => w.setTimeout(resolve, 0));
  assert.equal(requests, 2);
  assert.equal(card.dataset.state, 'ready');
  assert.equal(card.querySelector('.chess-review-preview-acc').textContent, '~80.0%');
  dom.window.close();
});

// After an extension update the old content script can never talk to the new background. Saying so
// beats a Retry button that is guaranteed to fail, and it must not keep retrying in the background.
test('a dead extension context asks for a reload instead of retrying', async () => {
  const dom = new JSDOM('<div class="row"><button id="review">Analyze</button></div>', {
    url: 'https://www.chess.com/game/live/12345678', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window;
  w.console.warn = () => {};
  let requests = 0;
  w.chrome = { runtime: { sendMessage: async (message) => {
    if (message.type !== 'buttonPreview') return { ok: true };
    requests++;
    throw Error('Extension context invalidated.');
  } } };
  w.eval(readFileSync(new URL('../button-preview-content.js', import.meta.url), 'utf8'));
  const button = w.document.getElementById('review');
  w.ChessReviewButtonPreview.register(button, { getContext: () => ({ key: 'chesscom:12345678' }), api: w.chrome });
  await new Promise((resolve) => w.setTimeout(resolve, 0));

  const card = button.nextElementSibling;
  assert.equal(card.dataset.state, 'unavailable');
  assert.equal(card.dataset.reason, 'reload');
  assert.match(card.querySelector('.chess-review-preview-wait').textContent, /reload this page/);
  assert.equal(card.querySelector('.chess-review-preview-retry'), null, 'nothing on this page can reconnect');

  w.ChessReviewButtonPreview.refresh(true);
  w.dispatchEvent(new w.Event('online'));
  await new Promise((resolve) => w.setTimeout(resolve, 30));
  assert.equal(requests, 1, 'a dead context is not re-asked');
  dom.window.close();
});

test('coming back online retries a failed preview', async () => {
  const dom = new JSDOM('<div class="row"><button id="review">Analyze</button></div>', {
    url: 'https://www.chess.com/game/live/12345678', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window;
  w.console.warn = () => {};
  let requests = 0;
  w.chrome = { runtime: { sendMessage: async (message) => {
    if (message.type !== 'buttonPreview') return { ok: true };
    requests++;
    if (requests === 1) return { ok: false, key: 'chesscom:12345678', reason: 'archive', error: 'not archived yet' };
    return { ok: true, key: 'chesscom:12345678', estimated: true, players: { w: 'Alice', b: 'Bob' },
      accuracy: { w: 80, b: 70 }, counts: { w: { best: 1 }, b: { best: 1 } }, me: null };
  } } };
  w.eval(readFileSync(new URL('../button-preview-content.js', import.meta.url), 'utf8'));
  const button = w.document.getElementById('review');
  w.ChessReviewButtonPreview.register(button, { getContext: () => ({ key: 'chesscom:12345678' }), api: w.chrome });
  await new Promise((resolve) => w.setTimeout(resolve, 0));
  assert.equal(button.nextElementSibling.dataset.state, 'unavailable');

  w.dispatchEvent(new w.Event('online'));
  await new Promise((resolve) => w.setTimeout(resolve, 0));
  assert.equal(requests, 2);
  assert.equal(button.nextElementSibling.dataset.state, 'ready');
  dom.window.close();
});

// chess.com can drop our card without touching our button (a partial re-render). The card must come
// back on its own, and a refresh that changes nothing must not churn the DOM.
test('a dropped card is re-mounted, and a no-op refresh leaves the DOM alone', async () => {
  const dom = new JSDOM('<div class="row"><button id="review">Analyze</button></div>', {
    url: 'https://www.chess.com/game/live/12345678', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window;
  w.chrome = { runtime: { sendMessage: async () => ({ ok: true, key: 'chesscom:12345678', estimated: true,
    players: { w: 'Alice', b: 'Bob' }, accuracy: { w: 80, b: 70 }, counts: { w: { best: 1 }, b: { best: 1 } }, me: null }) } };
  w.eval(readFileSync(new URL('../button-preview-content.js', import.meta.url), 'utf8'));
  const button = w.document.getElementById('review');
  w.ChessReviewButtonPreview.register(button, { getContext: () => ({ key: 'chesscom:12345678' }), api: w.chrome });
  await new Promise((resolve) => w.setTimeout(resolve, 0));

  const card = button.nextElementSibling;
  const sides = card.querySelector('.chess-review-preview-sides');
  const firstRow = sides.firstChild;
  w.ChessReviewButtonPreview.refresh();
  assert.equal(button.nextElementSibling, card);
  assert.equal(card.querySelector('.chess-review-preview-sides').firstChild, firstRow, 'no repaint for an unchanged view');

  card.remove();
  w.document.body.append(w.document.createElement('div'));
  await new Promise((resolve) => w.setTimeout(resolve, 300));
  assert.equal(button.nextElementSibling, card, 'the observer puts the same card back');
  assert.equal(card.dataset.state, 'ready');
  dom.window.close();
});

// chess.com builds our button and inserts it a moment later: the card must mount when the button
// reaches the document, and follow it if the page re-renders the row.
test('the card mounts when a registered button is inserted later, and re-follows it', async () => {
  const dom = new JSDOM('<div id="row"></div>', {
    url: 'https://www.chess.com/game/live/12345678', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window;
  w.chrome = { runtime: { sendMessage: async () => ({ ok: true, key: 'chesscom:12345678', estimated: true,
    players: { w: 'Alice', b: 'Bob' }, accuracy: { w: 80, b: 70 }, counts: { w: { best: 1 }, b: { best: 1 } }, me: null }) } };
  w.eval(readFileSync(new URL('../button-preview-content.js', import.meta.url), 'utf8'));
  const button = w.document.createElement('button');
  button.className = 'chess-analyzer-free-review';
  w.ChessReviewButtonPreview.register(button, { getContext: () => ({ key: 'chesscom:12345678' }), api: w.chrome });
  assert.equal(w.document.querySelector('.chess-review-preview'), null, 'a detached button has no card yet');

  w.document.getElementById('row').append(button);
  w.ChessReviewButtonPreview.refresh();
  const card = w.document.querySelector('.chess-review-preview');
  assert.ok(card, 'the card mounts once the button is in the document');
  assert.equal(button.nextElementSibling, card);

  // A re-rendered row that drops the card puts it back rather than losing the preview.
  card.remove();
  w.ChessReviewButtonPreview.refresh();
  assert.equal(button.nextElementSibling, w.document.querySelector('.chess-review-preview'));
  await new Promise((resolve) => w.setTimeout(resolve, 0));
  assert.equal(w.document.querySelector('.chess-review-preview').dataset.state, 'ready');
  dom.window.close();
});

test('a saved review carries the compact preview summary', async (t) => {
  const a = app(t);
  loadGame(a, '1. e4 e5 2. Nf3 Nc6');
  a.call('computeDerived'); a.call('buildUI'); a.call('renderAll');
  await a.call('saveToLibrary');
  const record = a.store.library[0];
  assert.equal(record.buttonSummary.version, 1);
  assert.deepEqual(record.buttonSummary.accuracy, { w: a.state.acc.w, b: a.state.acc.b });
  assert.equal(record.buttonSummary.counts.w.best >= 0, true, 'the classifier tally travels with the save');
});
