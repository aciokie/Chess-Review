import test from 'node:test';
import assert from 'node:assert/strict';
import { app, loadGame } from './helpers/app.mjs';

// The Quality page carries upstream's "distribution" design: a summary with both sides' classified
// totals and a per-category spectrum, plus share bars painted behind each category's counts.
function quality(t) {
  const a = app(t);
  loadGame(a, '1. e4 e5 2. Nf3 Nc6');
  a.call('computeDerived'); a.call('buildUI'); a.call('renderAll');
  a.call('setAccuracyPage', 1);
  return a;
}

test('the Quality page shows the summary spectrums and per-category share bars', t => {
  const a = quality(t);
  const doc = a.dom.window.document;
  const root = doc.querySelector('.accuracy-panel .quality-distribution');
  assert.ok(root, 'the distribution wrapper exists');
  assert.equal(root.querySelectorAll('.quality-totals [data-quality-total]').length, 2, 'both totals');
  assert.equal(root.querySelectorAll('.quality-spectrum').length, 2, 'one spectrum per side');
  const categories = a.run('QBREAK_FULL').length;
  assert.equal(root.querySelectorAll('.quality-spectrum i[data-quality-segment]').length, 2 * categories);
  const rows = [...root.querySelectorAll('.qbreak-row')];
  assert.ok(rows.length >= 6, `visible category rows: ${rows.length}`);
  for (const row of rows) {
    assert.ok(row.style.getPropertyValue('--quality-color'), 'row carries its category colour');
    assert.match(row.style.getPropertyValue('--share-left'), /%$/, 'left share set');
    assert.match(row.style.getPropertyValue('--share-right'), /%$/, 'right share set');
    assert.ok(row.querySelector('.ct.left') && row.querySelector('.ct:not(.left)'), 'both counts');
  }
});

test('totals and share bars update in place while analysing', t => {
  const a = quality(t);
  a.state.analyzing = true;
  a.call('renderStats');                       // builds with statsRefs so later updates are in place
  assert.ok(a.run('statsRefs'), 'the in-place update state is armed');
  a.state.counts = { w: { brilliant: 2, blunder: 2 }, b: { blunder: 1 } };
  a.call('renderStats');
  const doc = a.dom.window.document;
  assert.equal(doc.querySelector('[data-quality-total="w"]').textContent, '4');
  assert.equal(doc.querySelector('[data-quality-total="b"]').textContent, '1');
  const row = doc.querySelector('.qbreak-row[data-quality-cat="brilliant"]');
  assert.equal(row.style.getPropertyValue('--share-left'), '50%');
  assert.equal(row.style.getPropertyValue('--share-right'), '0%');
  assert.equal(doc.querySelector('[data-quality-segment="w-brilliant"]').style.width, '50%');
  assert.equal(doc.querySelector('[data-quality-segment="b-blunder"]').style.width, '100%');
  const blunder = doc.querySelector('.qbreak-row[data-quality-cat="blunder"]');
  assert.equal(blunder.style.getPropertyValue('--share-right'), '100%');
});
