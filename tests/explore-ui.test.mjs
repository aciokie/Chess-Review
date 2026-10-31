import test from 'node:test';
import assert from 'node:assert/strict';
import { app, loadGame, branch, settle, fakeEngine } from './helpers/app.mjs';

function board(t,pgn='1. e4 e5') {
  const a=app(t);loadGame(a,pgn);branch(a);a.state.meta={explore:true};
  a.call('computeDerived');a.call('buildUI');a.call('renderAll');return a;
}

test('Explore move list replaces an equal-length branch even when badges are equal',t=>{
  const a=board(t,'1. e4');const old=a.state.variation.positions[1];old.classif='book';a.call('renderMoves');
  assert.match(a.dom.window.document.getElementById('movesBody').textContent,/e4/);
  const next=a.call('buildPositions','1. d4')[1];
  a.state.variation.positions[1]={...old,...next};a.call('renderMoves');
  const text=a.dom.window.document.getElementById('movesBody').textContent;
  assert.match(text,/d4/);assert.doesNotMatch(text,/e4/);
});

test('cached navigation refreshes highlight, opening, and Position panel',async t=>{
  const a=board(t);const v=a.state.variation;
  a.context.__book={ [a.call('epdOf',v.positions[1].fen)]:['B00','First opening'],[a.call('epdOf',v.positions[2].fen)]:['C20','Second opening'] };
  a.run('BOOK = __book');v.positions[1].eval={cp:70};v.positions[2].eval={cp:30};
  await a.call('requestLiveEval');
  assert.match(a.dom.window.document.getElementById('reviewMount').textContent,/Second opening/);
  a.call('gotoVar',1);await settle();
  assert.equal(a.dom.window.document.querySelector('#movesBody .current').dataset.ply,'1');
  assert.match(a.dom.window.document.getElementById('reviewMount').textContent,/First opening/);
  assert.match(a.dom.window.document.getElementById('statsMount').textContent,/\+0\.7/);
});

test('Home, End, and Escape keep Explore history and never enter a blank review',async t=>{
  const a=board(t);const v=a.state.variation;const {document,KeyboardEvent}=a.dom.window;
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Home'}));await settle();assert.equal(v.idx,0);
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'End'}));await settle();assert.equal(v.idx,2);
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));await settle();assert.equal(v.idx,0);
  assert.equal(a.state.variation,v);assert.equal(v.positions.length,3);assert.equal(a.state.analysisMode,true);
  assert.equal(document.querySelector('#controls .exit-analysis'),null);
});

test('making an alternative preserves capture and promotion metadata for classification',async t=>{
  const a=board(t,'1. e4 d5');a.state.liveEngine=fakeEngine();
  a.call('applyUserMove','e4','d5',false);await settle();
  const pos=a.state.variation.positions.at(-1);assert.equal(pos.san,'exd5');assert.equal(pos.captured,'p');
  assert.match(a.dom.window.document.getElementById('movesBody').textContent,/exd5/);
});

test('both live and batch failures offer a Retry button',async t=>{
  const a=board(t);const S=a.state;
  S.liveError='Engine failed';a.call('renderReview');
  assert.match(a.dom.window.document.getElementById('reviewMount').textContent,/Retry analysis/);
  S.analysisMode=false;S.analysisError='Engine failed';a.call('renderReview');
  assert.match(a.dom.window.document.getElementById('reviewMount').textContent,/Retry analysis/);
});

test('credits include Stockfish 19, upstream source and contributors',t=>{
  const a=board(t);a.call('openCredits');const overlay=a.dom.window.document.querySelector('.credits-overlay');
  assert.match(overlay.textContent,/Stockfish 19/);assert.match(overlay.textContent,/aciokie/);assert.match(overlay.textContent,/neuroflowinfinix/);
  assert.ok(overlay.querySelector('a[href="https://github.com/nmrugg/stockfish.js/tree/v19.0.0"]'));
  assert.ok(overlay.querySelector('a[href="https://github.com/aciokie/Chess-Review"]'), 'source link points at this fork');
  assert.ok(overlay.querySelector('a[href="https://github.com/T-Julsgaard/Chess-Review"]'), 'the original project stays credited');
  assert.ok(overlay.querySelector('a[href="https://github.com/neuroflowinfinix"]'));
});

test('arrow settings remain attributes and cannot inject SVG markup', t => {
  const a = board(t);
  a.state.settings.arrowOpacity = '1"><script>bad()</script><g opacity="1';
  a.state.settings.arrowShaft = '0.2" onload="bad()';
  const node = a.call('arrowNode', [{x:0,y:0},{x:1,y:1}], [{x:1,y:1},{x:0.8,y:1}], '#85ae4a');
  assert.equal(node.querySelector('script'), null);
  assert.equal(node.querySelector('[onload]'), null);
  assert.equal(node.querySelectorAll('polyline').length, 1);
  assert.equal(node.querySelectorAll('polygon').length, 1);
  assert.equal(node.getAttribute('opacity'), a.state.settings.arrowOpacity);
});

test('renderBestArrow renders multiple candidate move arrows when engineLines > 1', t => {
  const a = board(t);
  a.state.settings.bestArrow = true;
  a.state.settings.engineLines = 4;
  a.state.analysisMode = true;
  a.state.variation = {
    branchIdx: 0,
    positions: [{ fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', best: {
      lines: [
        { pv: 'e2e4 e7e5' },
        { pv: 'd2d4 d7d5' },
        { pv: 'c2c4 e7e6' },
        { pv: 'g1f3 d7d5' }
      ]
    }}],
    idx: 0
  };

  a.call('renderBestArrow');
  const svg = a.dom.window.document.querySelector('.board svg.best-arrow');
  assert.ok(svg);
  const groups = svg.querySelectorAll('g');
  assert.equal(groups.length, 4);

  // SVG elements rendered in reverse rank order (4, 3, 2, 1) so Rank 1 (green) stays on top
  const topRankNode = groups[3]; // Last element in DOM is on top
  assert.equal(topRankNode.getAttribute('fill'), '#85ae4a');

  const rank4Node = groups[0];
  assert.equal(rank4Node.getAttribute('fill'), '#5a8bef');

  const rank1Polyline = topRankNode.querySelector('polyline');
  const rank4Polyline = rank4Node.querySelector('polyline');
  const rank1Width = parseFloat(rank1Polyline.getAttribute('stroke-width'));
  const rank4Width = parseFloat(rank4Polyline.getAttribute('stroke-width'));

  assert.ok(rank1Width > rank4Width);
});

test('standalone Explore board keeps full colour and never calls its moves a variation', async t => {
  const a = board(t, '1. e4'); const { document } = a.dom.window;
  a.call('paintBoard'); a.call('renderReview'); a.call('renderCoachPanel');
  assert.ok(!document.querySelector('.board').classList.contains('analysis'), 'no gray analysis filter in Explore');
  assert.doesNotMatch(document.getElementById('reviewMount').textContent, /Exploring a variation/);
  const coach = document.querySelector('.coach-position');
  if (coach) { assert.doesNotMatch(coach.textContent, /Variation|Player identity unavailable/); assert.match(coach.textContent, /Explore board/); }
});

test('a side line off a reviewed game still gets the gray analysis look and variation wording', async t => {
  const a = app(t); loadGame(a, '1. e4 e5 2. Nf3'); branch(a); a.state.meta = {};
  a.call('computeDerived'); a.call('buildUI'); a.call('renderAll'); a.call('paintBoard'); a.call('renderReview');
  assert.ok(a.dom.window.document.querySelector('.board').classList.contains('analysis'));
  assert.match(a.dom.window.document.getElementById('reviewMount').textContent, /Exploring a variation/);
});

test('the Explore controls never announce "Variation" to assistive tech, but a side line still does', t => {
  const labels = a => [...a.dom.window.document.querySelectorAll('#controls button')]
    .map(b => b.getAttribute('aria-label')).filter(Boolean);
  const explore = board(t, '1. e4'); explore.call('renderControls');
  assert.deepEqual(labels(explore), ['Line start', 'Previous move', 'Next move', 'Line end']);
  const side = app(t); loadGame(side, '1. e4 e5 2. Nf3'); branch(side); side.state.meta = {};
  side.call('computeDerived'); side.call('buildUI'); side.call('renderAll'); side.call('renderControls');
  assert.deepEqual(labels(side), ['Variation start', 'Previous move', 'Next move', 'Variation end']);
});
