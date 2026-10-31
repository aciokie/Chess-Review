// Timed audit of the review's own work, with no engine and no browser.
//
// Runs the real analysis.js in the same vm harness the tests use, on a deterministic 160-ply game
// and a 300-game library, and reports medians for the operations a user actually waits on:
// opening a game, stepping through it, one analysis flush, saving to the library, and drawing the
// library sidebar. Synthetic evaluations keep it reproducible and cheap; the point is to compare
// revisions, not to measure Stockfish.
//
//   node scripts/perf-audit.mjs            # table
//   node scripts/perf-audit.mjs --json     # machine-readable, for before/after diffs
//   node scripts/perf-audit.mjs --plies=200 --library=1000 --reps=9
import fs from 'node:fs';
import { Chess } from '../lib/chess.js';
import { app } from '../tests/helpers/app.mjs';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};
const PLIES = arg('plies', 160);          // even, so the game ends on Black's move
const LIBRARY = arg('library', 300);
const REPS = arg('reps', 7);
const AS_JSON = process.argv.includes('--json');

/* ---------------- Fixtures ---------------- */

// A deterministic, legal long game: a seeded pick from the legal moves at each ply. Real move text,
// so PGN parsing, the opening book, SAN rendering and the move list all do genuine work.
function longGame(plies) {
  const chess = new Chess();
  let seed = 0x2f6e2b1;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const text = [];
  for (let i = 0; i < plies; i++) {
    const moves = chess.moves({ verbose: true });
    if (!moves.length) break;
    const mv = moves[Math.floor(rnd() * moves.length)];
    chess.move(mv);
    if (i % 2 === 0) text.push(`${i / 2 + 1}.`);
    text.push(mv.san);
  }
  return `[Event "Perf fixture"]\n[Site "local"]\n[Date "2026.01.01"]\n[White "PerfWhite"]\n[Black "PerfBlack"]\n[Result "*"]\n\n${text.join(' ')} *\n`;
}

// Deterministic evidence for every ply, in the shapes the classifier and panels consume.
function evidence(S) {
  let x = 987654321;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  S.evals = S.positions.map((_, i) => (i === 0 ? { cp: 20 } : { cp: Math.round((rnd() - 0.5) * 500) }));
  S.bests = S.positions.map((_, i) => ({
    bestmove: i % 3 === 0 ? 'g1f3' : 'b1c3', score: { cp: S.evals[i].cp }, lines: [],
  }));
  S.analyzing = false; S.progress = S.total; S.completed = S.total;
}

function library(n, pgn, plies) {
  return Array.from({ length: n }, (_, i) => ({
    id: `g${i}`, savedAt: 1_700_000_000_000 - i * 1000, pgn,
    meta: {}, meSide: i % 2 ? 'b' : 'w', myName: 'PerfWhite', opName: 'PerfBlack',
    myAcc: 60 + (i % 40), opAcc: 60 + ((i * 7) % 40), myRating: 1500, opRating: 1500,
    result: ['win', 'loss', 'draw'][i % 3], type: 'Blitz', eco: 'C50', opening: 'Italian Game',
    date: '2026.01.01', hasBrilliant: i % 5 === 0, brilliantCount: i % 2, myBrilliant: false,
    plies, myPhases: { opening: 80, middlegame: 70, endgame: null },
  }));
}

/* ---------------- Timing ---------------- */

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { median: s[Math.floor(s.length / 2)], min: s[0], max: s[s.length - 1] };
};
const timed = (fn) => { const t0 = performance.now(); fn(); return performance.now() - t0; };
const repeat = (reps, fn) => { const out = []; for (let i = 0; i < reps; i++) out.push(timed(fn)); return stats(out); };

/* ---------------- Runs ---------------- */

const pgn = longGame(PLIES);
const t = { after() {} };

// A fresh app per measurement phase: jsdom state never leaks between numbers.
const freshApp = () => {
  const a = app(t, { url: 'https://extension.test/analysis.html#perf' });
  // jsdom cannot build the sidebar <select>s (they parse HTML through DOMParser). Only the controls
  // are stubbed - the library list itself, which is what we time, stays the real implementation.
  a.replace('libDropdown', () => a.dom.window.document.createElement('span'));
  a.replace('ensureLiveEngine', async () => ({ dead: false, analyse: async () => ({ score: { cp: 0 }, bestmove: 'e2e4', lines: [] }), stop() {}, cancelPending() {}, terminate() {} }));
  return a;
};
function openGame(a) {
  const S = a.state;
  S.pgn = pgn; S.meta = {}; S.headers = a.call('parseHeaders', pgn);
  S.positions = a.call('buildPositions', pgn); S.total = S.positions.length - 1;
  S.players = a.call('derivePlayers', S.headers, S.meta, '').players;
  S.meSide = 'w'; S.flipped = false; S.idx = 0;
  evidence(S);
  a.call('buildUI');
}

const results = {};
{
  const build = freshApp();
  results.parsePgn = repeat(REPS, () => build.call('buildPositions', pgn));

  const open = freshApp();
  results.open = repeat(REPS, () => openGame(open));
}
{
  const a = freshApp();
  openGame(a);
  a.call('computeDerived');
  a.call('renderAll');
  const total = a.state.total;
  results.classify = repeat(REPS, () => a.call('computeDerived'));
  results.flushRender = repeat(REPS, () => { a.call('computeDerived'); a.call('renderAll'); });
  results.navigate30 = repeat(REPS, () => {
    for (let i = 0; i <= Math.min(30, total); i++) a.call('go', i);   // full paint + every panel
  });
  results.navigate30MarkerOnly = repeat(REPS, () => {
    a.state.idx = 0;
    for (let i = 0; i <= Math.min(30, total); i++) { a.state.idx = i; a.call('renderGraph'); }
  });
  results.saveSync = repeat(REPS, () => a.call('saveToLibrary'));     // the synchronous part only
}
{
  const a = freshApp();
  openGame(a);
  a.state.library = library(LIBRARY, pgn, a.state.total);
  // UI.libSig is the retention flag: clearing it forces a real rebuild of every card.
  results.libraryRender = repeat(REPS, () => { a.run('UI.libSig = null'); a.call('renderLibrary'); });
  results.libraryRenderUnchanged = repeat(REPS, () => a.call('renderLibrary'));   // the retention path
}
{
  // Saving is async (storage + library merge), so it is timed as a promise.
  const a = freshApp();
  openGame(a);
  const save = [];
  for (let i = 0; i < REPS; i++) {
    const t0 = performance.now();
    await a.call('saveToLibrary');
    save.push(performance.now() - t0);
  }
  results.save = stats(save);
}

/* ---------------- Report ---------------- */

const rows = Object.entries(results).map(([name, s]) => ({ name, median: +s.median.toFixed(2), min: +s.min.toFixed(2), max: +s.max.toFixed(2) }));
const payload = { plies: PLIES, library: LIBRARY, reps: REPS, rows };
if (AS_JSON) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  const w = Math.max(...rows.map((r) => r.name.length));
  console.log(`\nperf-audit  ${PLIES} plies · ${LIBRARY}-game library · ${REPS} reps · medians in ms\n`);
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(w)}  ${String(r.median).padStart(8)}   (min ${String(r.min).padStart(7)}  max ${String(r.max).padStart(8)})`);
  }
  console.log('');
}
