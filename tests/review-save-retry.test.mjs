import test from 'node:test';
import assert from 'node:assert/strict';
import { app, loadGame } from './helpers/app.mjs';

// Upstream keeps a failed library write as a snapshot: the review is never lost silently, the top
// bar offers a retry, and the tab warns before closing while a review is still unsaved.
function reviewed(t) {
  const a = app(t);
  loadGame(a, '1. e4 e5 2. Nf3 Nc6');
  a.call('computeDerived'); a.call('buildUI'); a.call('renderAll');
  return a;
}

test('a failed library write keeps the review pending, warns on close and can be retried', async t => {
  const a = reviewed(t);
  const okSet = a.context.browserAPI.storage.local.set;
  a.context.browserAPI.storage.local.set = async () => { throw Error('quota exceeded'); };
  await a.call('saveToLibrary');
  const status = a.dom.window.document.querySelector('.review-save-status');
  assert.ok(status, 'the status element exists');
  assert.equal(status.hidden, false, 'the status row is shown');
  assert.match(status.textContent, /has not been saved/);
  assert.equal(a.run('_pendingReviewSaves.size'), 1, 'the review is kept as a pending snapshot');

  const ev = new a.dom.window.Event('beforeunload', { cancelable: true });
  a.dom.window.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true, 'closing the tab is blocked while a review is unsaved');

  a.context.browserAPI.storage.local.set = okSet;
  await a.call('retryReviewSaves');
  assert.equal(a.run('_pendingReviewSaves.size'), 0, 'the retry cleared the pending review');
  assert.equal(status.hidden, true, 'the status row is hidden again');
  assert.equal(a.store.library.some((g) => g.pgn === a.state.pgn), true, 'the game reached the library');
});

test('a successful save leaves nothing pending and no warning armed', async t => {
  const a = reviewed(t);
  await a.call('saveToLibrary');
  assert.equal(a.run('_pendingReviewSaves.size'), 0);
  assert.equal(a.dom.window.document.querySelector('.review-save-status').hidden, true);
  assert.equal(a.store.library.length, 1);
  const ev = new a.dom.window.Event('beforeunload', { cancelable: true });
  a.dom.window.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, false, 'nothing pending, nothing to warn about');
});
