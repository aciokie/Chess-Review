import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { previewGameKey, savedButtonSummary } from '../lib/button-preview.js';
import { analyseButtonPreview, finishedPreviewGame, previewCategory, PREVIEW_NODES } from '../lib/preview-analysis.js';
import { createButtonPreviewService } from '../lib/button-preview-service.js';
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

test('a game that changed under the tab is refused', async () => {
  const service = createButtonPreviewService({
    api: { storage: { local: { get: async () => ({}) } } },
    loadGame: async () => ({ pgn: PGN, meta: { url: 'https://www.chess.com/game/live/99999999' } }),
    runPreview: async () => { throw Error('must not run'); },
  });
  const result = await service.get(7, 'chesscom:12345678');
  assert.equal(result.ok, false);
});

test('the in-page card renders the estimate with accuracy and badge chips', async () => {
  const dom = new JSDOM('<div class="row"><button id="review">Analyze with Chess Review</button></div>', {
    url: 'https://www.chess.com/game/live/12345678', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window;
  const sent = [];
  w.chrome = { runtime: { sendMessage: async (message) => {
    sent.push(message);
    if (message.type !== 'buttonPreview') return { ok: true };
    return {
      ok: true, key: 'chesscom:12345678', estimated: true,
      players: { w: 'Alice', b: 'Bob' }, accuracy: { w: 88.8, b: 77.7 },
      counts: { w: { best: 3, blunder: 1 }, b: { mistake: 2 } }, me: 'w',
    };
  } } };
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
  assert.equal(sides[0].querySelectorAll('.chess-review-preview-badge').length, 2);
  assert.equal(sides[1].querySelectorAll('.chess-review-preview-badge').length, 1);
  assert.equal(sides[0].querySelector('[data-cat="best"]').getAttribute('title'), 'Best: 3');
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
