// The learning workspace (lib/learning) is vendored from upstream: puzzles, lessons and openings
// that take over the review board. These tests cover the shipped puzzle library, the pure
// progress/rating bookkeeping, the packaging split and the analysis.js integration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Chess } from '../lib/chess.js';
import { app, loadGame, settle } from './helpers/app.mjs';
import { loadLearningWorkspace } from '../lib/learning-loader.js';
import { PuzzleLibrary, loadPuzzleData } from '../lib/learning/puzzle-library.js';
import { INITIAL_PUZZLE_ELO, PROVISIONAL_PUZZLES, normalizePuzzleRating, canRatePuzzle, ratePuzzle, pickRatedPuzzle } from '../lib/learning/puzzle-rating.js';
import { normalizeProgress, progressTotals, recordPuzzle, ChallengeClock, challengeResult, PROGRESS_KEY } from '../lib/learning/progress.js';
import { puzzleStatistics } from '../lib/learning/statistics.js';
import { PUZZLE_RUN_MODES, runPuzzleRating, pickRunPuzzle, runBest } from '../lib/learning/puzzle-runs.js';
import { LESSONS, OPENINGS, CATEGORIES, DIFFICULTIES, THEME_NAMES, playUci, linePositions } from '../lib/learning/content.js';
import { packagePuzzles } from '../scripts/package-puzzles.mjs';

// Node cannot fetch file: URLs, so serve the bundled JSON through the loader's injected fetcher.
// The same call path runs in the browser against runtime.getURL().
const readJson = async request => ({ ok: true, json: async () => JSON.parse(await readFile(String(request), 'utf8')) });
let libraryPromise;
const library = () => libraryPromise ||= loadPuzzleData(p => p, readJson);

const MATE_IN_ONE = { id: 'test-mate', fen: '7k/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1',
  setup: { fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 b - - 0 1', move: 'g8h8' },
  solution: ['a1a8'], rating: 1200, theme: 'mateIn1', themes: ['mateIn1'] };

const REVIEW_PGN = `[Event "Learning test"]
[White "White"]
[Black "Black"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. d3 Nf6 5. O-O d6 1-0`;

/* ---------------- the shipped puzzle library ---------------- */

test('the shipped puzzle library is well formed and playable', async () => {
  const data = await library();
  assert.equal(data.schema, 1);
  assert.equal(data.license, 'CC0-1.0');
  assert.ok(data.puzzles.length >= 10000, `expected a real library, got ${data.puzzles.length}`);
  assert.equal(data.puzzleFiles, undefined, 'the source tree ships one readable file, not the packaged parts');

  const ids = new Set();
  for (const puzzle of data.puzzles) {
    assert.ok(!ids.has(puzzle.id), 'duplicate puzzle id ' + puzzle.id);
    ids.add(puzzle.id);
    assert.ok(Number.isFinite(puzzle.rating), 'puzzle without a rating: ' + puzzle.id);
    assert.ok(Array.isArray(puzzle.solution) && puzzle.solution.length, 'puzzle without a solution: ' + puzzle.id);
    assert.ok(THEME_NAMES[puzzle.theme], `puzzle type ${puzzle.theme} has no filter name`);
    assert.ok(puzzle.themes.includes(puzzle.theme), 'the filterable type must appear in the wider theme list');
  }
});

test('every sampled puzzle line is legal from its stored position', async () => {
  const { puzzles } = await library();
  let checked = 0;
  for (let i = 0; i < puzzles.length; i += 997) {
    const puzzle = puzzles[i];
    const before = new Chess(puzzle.setup.fen);
    assert.ok(playUci(before, puzzle.setup.move), `illegal setup move for ${puzzle.id}`);
    assert.equal(before.fen(), puzzle.fen, `the setup move must reach the puzzle position (${puzzle.id})`);
    const board = new Chess(puzzle.fen);
    for (const move of puzzle.solution) assert.ok(playUci(board, move), `illegal solution move ${move} for ${puzzle.id}`);
    checked++;
  }
  assert.ok(checked >= 10, 'expected to sample a reasonable number of puzzles');
});

test('the library index caches counts per filter and they agree with a manual pass', async () => {
  const { puzzles } = await library();
  const index = new PuzzleLibrary();
  const bounds = index.bounds(puzzles);
  assert.equal(bounds.length, 2);
  assert.ok(bounds[0] % 50 === 0 && bounds[1] % 50 === 0, 'bounds are rounded to 50s');
  assert.ok(bounds[0] <= Math.min(...puzzles.map(p => p.rating)) && bounds[1] >= Math.max(...puzzles.map(p => p.rating)));

  const mateInOne = new Set(['mateIn1']);
  const manual = puzzles.filter(p => p.themes.some(t => mateInOne.has(t))).length;
  assert.equal(index.count(puzzles, null, mateInOne), manual);
  assert.equal(index.count(puzzles, null, new Set()), puzzles.length);
  const range = [1000, 1200], both = puzzles.filter(p => p.rating >= 1000 && p.rating <= 1200 && p.themes.includes('fork')).length;
  assert.equal(index.count(puzzles, range, new Set(['fork'])), both);

  // find() and matching() must not hand the caller a shared array it could sort in place.
  const picked = index.matching(puzzles, range, new Set());
  assert.notEqual(picked, index.matching(puzzles, range, new Set()));
  assert.equal(index.find(puzzles, puzzles[7].id), puzzles[7]);
  assert.equal(index.find(puzzles, 'not-a-puzzle'), undefined);
});

/* ---------------- progress, rating and run bookkeeping ---------------- */

test('a puzzle rating starts provisional, moves once per puzzle and refuses repeats', async () => {
  const { puzzles } = await library();
  const puzzle = puzzles.find(p => p.rating > 1400);
  const progress = normalizeProgress(null);
  assert.deepEqual(normalizePuzzleRating(progress.puzzleRating), { elo: INITIAL_PUZZLE_ELO, played: 0, wins: 0, losses: 0 });
  assert.equal(progress.puzzleRatingEnabled, true);

  assert.equal(canRatePuzzle(progress, puzzle), true);
  const won = ratePuzzle(progress, puzzle, true);
  assert.equal(won.before, INITIAL_PUZZLE_ELO);
  assert.ok(won.delta > 0 && won.delta <= 48, 'a provisional win uses the wider K factor');
  assert.equal(progress.puzzleRating.played, 1);
  // The stored per-puzzle result is what makes a retry, a resume or a save retry idempotent.
  assert.equal(canRatePuzzle(progress, puzzle), false);
  assert.equal(ratePuzzle(progress, puzzle, true), null);

  const lost = ratePuzzle(progress, puzzles.find(p => p.id !== puzzle.id && p.rating < 1000), false);
  assert.ok(lost.delta < 0);
  assert.equal(progress.puzzleRating.losses, 1);

  const established = normalizeProgress({ schema: 1, puzzleRating: { elo: 1500, wins: PROVISIONAL_PUZZLES, losses: 0 } });
  assert.ok(Math.abs(ratePuzzle(established, puzzle, true).delta) <= 24, 'settled players use the smaller K factor');
});

test('rating picks prefer the player\'s level and never reuse a struggled puzzle', async () => {
  const { puzzles } = await library();
  const progress = normalizeProgress({ schema: 1, puzzleRating: { elo: 1600, wins: 40, losses: 10 } });
  const pool = puzzles.slice(0, 4000);
  const chosen = pickRatedPuzzle(pool, progress, { random: () => 0.5 });
  assert.ok(chosen, 'a puzzle near the player rating must be available');
  assert.ok(Math.abs(chosen.rating - 1600) <= 200, `picked an off-level puzzle: ${chosen.rating}`);

  recordPuzzle(progress, chosen.id, { completed: true, mistakes: 1 });
  assert.equal(pickRatedPuzzle(pool.filter(p => p.id === chosen.id), progress, { random: () => 0 }), null,
    'a struggled puzzle is not offered again');
  // A puzzle already answered correctly is equally out of the pool for rating.
  const solved = pool.find(p => p.id !== chosen.id);
  ratePuzzle(progress, solved, true);
  assert.equal(pickRatedPuzzle(pool.filter(p => p.id === solved.id), progress, { random: () => 0 }), null);
});

test('progress totals, statistics and run modes read the stored shape', () => {
  const progress = normalizeProgress(null);
  recordPuzzle(progress, 'a', { completed: true, mistakes: 0 });
  recordPuzzle(progress, 'a', { completed: true, mistakes: 0 });
  recordPuzzle(progress, 'b', { completed: true, mistakes: 3 });
  recordPuzzle(progress, 'c', { completed: false, skipped: true });
  const totals = progressTotals(progress);
  // "unique" counts puzzles solved without help; b was recovered with mistakes, so it is not one.
  assert.deepEqual({ unique: totals.unique, repeats: totals.repeats }, { unique: 1, repeats: 1 });
  assert.equal(progress.puzzles.b.recovered, 1, 'a recovered puzzle is counted separately from a clean one');
  assert.equal(progress.puzzles.b.clean, 0);
  assert.equal(progress.puzzles.c.struggled, true);

  // normalizeProgress is the only door into stored data: junk must not reach the reports.
  const broken = normalizeProgress({ schema: 1, puzzles: [], lessons: 'x', challenges: 'y', puzzleRating: { elo: 'nope' } });
  assert.deepEqual(broken.puzzles, {});
  assert.equal(broken.puzzleRating.elo, INITIAL_PUZZLE_ELO);
  assert.deepEqual(broken.challenges, []);
  assert.equal(normalizeProgress({ schema: 2 }).schema, 1, 'an unknown schema resets rather than migrating blindly');

  // Statistics score the recorded ids against the puzzle list they are given.
  const known = [{ ...MATE_IN_ONE, id: 'a' }, { ...MATE_IN_ONE, id: 'b' }];
  const stats = puzzleStatistics(progress, known);
  assert.equal(stats.attempts, progress.puzzles.a.attempts + progress.puzzles.b.attempts);
  assert.equal(stats.needsWork, 1, 'only the recovered puzzle needs work');
  assert.ok(stats.clean >= 1, 'the twice-solved puzzle is counted as clean');
  assert.ok(stats.rate > 0 && stats.rate <= 1);
  assert.ok(stats.types.every(t => THEME_NAMES[t.theme]), 'statistics only report filterable types');
  assert.equal(puzzleStatistics(progress, []).attempts, 0, 'no puzzles means nothing to report');

  assert.deepEqual(Object.keys(PUZZLE_RUN_MODES).sort(), ['knockout', 'timeAttack']);
  assert.equal(runBest(progress, 'timeAttack'), 0);
  assert.equal(runPuzzleRating(0), runPuzzleRating(0));
  assert.ok(pickRunPuzzle([MATE_IN_ONE], [], 'timeAttack', () => 0) === MATE_IN_ONE);
});

test('the challenge clock only counts active time', () => {
  let now = 0;
  const clock = new ChallengeClock(60, () => now);
  assert.equal(clock.remaining(), 60000);
  clock.ready();
  now = 10000;
  assert.equal(clock.remaining(), 50000);
  clock.pause();
  now = 60000;
  assert.equal(clock.remaining(), 50000, 'time while paused does not count');
  clock.ready();
  now = 110000;
  assert.equal(clock.expired(), true);
  const result = challengeResult({ duration: 60000, solved: 8, assisted: 1, mistakes: 2, skips: 0, correctMoves: 18, missed: ['a', 'a', 'b'] }, 5);
  assert.deepEqual({ solved: result.solved, personalBest: result.personalBest, best: result.best, missed: result.missed },
    { solved: 8, personalBest: true, best: 8, missed: ['a', 'b'] });
  assert.equal(result.accuracy, 90);
});

/* ---------------- lessons and openings ---------------- */

test('every bundled lesson exercise and opening line is playable', () => {
  assert.ok(LESSONS.length >= 10 && OPENINGS.length >= 10);
  assert.ok(CATEGORIES.every(c => LESSONS.some(l => l.category === c)), 'every category has a lesson');
  assert.ok(LESSONS.every(l => DIFFICULTIES.includes(l.level === 1 ? 'Introductory' : l.level === 2 ? 'Intermediate' : 'Advanced')));

  let exercises = 0, lines = 0;
  for (const lesson of LESSONS) {
    assert.ok(lesson.exercises.length, `lesson ${lesson.id} has no exercises`);
    for (const example of lesson.examples || []) {
      const board = new Chess(example.fen);
      for (const move of example.moves) assert.ok(playUci(board, move), `illegal example move in ${lesson.id}`);
    }
    for (const exercise of lesson.exercises) {
      assert.ok(new Chess(exercise.fen), `unreadable FEN in ${lesson.id}`);
      assert.ok(['move', 'choice', 'squares'].includes(exercise.type), `unknown exercise type in ${lesson.id}`);
      if (exercise.type === 'move') {
        for (const solution of exercise.solution) {
          const board = new Chess(exercise.fen);
          assert.ok(playUci(board, solution), `illegal solution ${solution} in ${lesson.id}`);
        }
      }
      exercises++;
    }
  }
  for (const opening of OPENINGS) {
    for (const line of opening.lines) {
      const played = linePositions(line);
      assert.equal(played.positions.length, line.moves.length + 1, `line ${opening.id}/${line.name} did not play out`);
      assert.equal(played.moves.length, line.moves.length);
      lines++;
    }
  }
  assert.ok(exercises >= 20 && lines >= 100, `expected substantial content, got ${exercises} exercises and ${lines} lines`);
});

/* ---------------- packaging ---------------- */

test('the package step splits the library into parts the loader still reads as one', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'chess-review-puzzles-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'data/learning'), { recursive: true });
  const puzzles = Array.from({ length: 40 }, (_, i) => ({ ...MATE_IN_ONE, id: 'p' + i, rating: 1000 + i }));
  await writeFile(path.join(dir, 'data/learning/puzzles.json'),
    JSON.stringify({ schema: 1, license: 'CC0-1.0', puzzles }));

  // A tiny budget forces several parts without writing a 27 MB fixture.
  const result = await packagePuzzles(dir, 2048);
  assert.equal(result.count, puzzles.length);
  assert.ok(result.parts > 1, 'the split must produce more than one part at this budget');
  const index = JSON.parse(await readFile(path.join(dir, 'data/learning/puzzles.json'), 'utf8'));
  assert.equal(index.puzzles, undefined, 'the packaged index carries no puzzle bodies');
  assert.equal(index.puzzleCount, puzzles.length);
  assert.equal(index.puzzleFiles.length, result.parts, 'the record reports the part count the index lists');
  assert.deepEqual(Object.keys(result.files).sort(),
    ['data/learning/puzzles.json', ...index.puzzleFiles.map(f => 'data/learning/' + f)].sort());

  const reloaded = await loadPuzzleData(p => path.join(dir, p), readJson);
  assert.equal(reloaded.puzzles.length, puzzles.length);
  assert.deepEqual(reloaded.puzzles.map(p => p.id).sort(), puzzles.map(p => p.id).sort());

  // A malformed library must be refused rather than half-loaded.
  await writeFile(path.join(dir, 'data/learning/puzzles.json'), JSON.stringify({ schema: 2, puzzles: [] }));
  await assert.rejects(() => loadPuzzleData(p => path.join(dir, p), readJson), /unsupported format/);
  await writeFile(path.join(dir, 'data/learning/puzzles.json'), JSON.stringify({ schema: 1, puzzleFiles: ['puzzles-001.json'], puzzleCount: 9 }));
  await assert.rejects(() => loadPuzzleData(p => path.join(dir, p), readJson), /unsupported format/);
});

/* ---------------- the review-page integration ---------------- */

function learningApp(t) {
  const a = app(t);
  loadGame(a, REVIEW_PGN);
  a.context.loadLearningWorkspace = loadLearningWorkspace;
  a.call('buildUI');
  a.call('buildBoard');
  a.call('paintBoard');
  return a;
}

// lib/learning reads its bundled JSON with fetch inside its own realm; serve it from disk here.
// The same request goes to runtime.getURL() in the extension.
function servePuzzles(t) {
  const real = globalThis.fetch;
  globalThis.fetch = async url => {
    const relative = decodeURIComponent(new URL(String(url)).pathname.replace(/^\//, ''));
    return { ok: true, json: async () => JSON.parse(await readFile(relative, 'utf8')) };
  };
  t.after(() => { globalThis.fetch = real; });
}

test('the review page offers two learning entry points and they follow the workspace', async t => {
  const a = learningApp(t);
  const document = a.dom.window.document;
  assert.ok(document.querySelector('#learningToggle'), 'the top-bar toggle must exist');
  assert.ok(document.querySelector('.learn-entry-button'), 'the board-side button must exist');
  assert.match(document.querySelector('#learningToggle').textContent, /Learn with Chess review/);
  assert.equal(document.querySelector('#learningToggle').dataset.mode, undefined, 'no mode until it is used');

  await a.call('openLearning');
  const workspace = a.run('learningWorkspace');
  assert.ok(workspace, 'the real workspace must construct');
  assert.match(document.querySelector('#learningToggle').textContent, /Return to Game review/);
  assert.equal(document.querySelector('#learningToggle').dataset.mode, 'learning');

  await workspace.close();
  assert.equal(a.run('learningWorkspace'), null);
  assert.match(document.querySelector('#learningToggle').textContent, /Learn with Chess review/);
  assert.equal(document.querySelector('#learningToggle').dataset.mode, 'review');
});

test('opening the workspace takes the board over and closing it gives the review board back', async t => {
  const a = learningApp(t);
  const document = a.dom.window.document;
  const stage = document.querySelector('#canvas');
  const originalBoardClass = document.querySelector('.board').className;
  const originalSquareClass = document.querySelector('.board').firstElementChild.className;

  await a.call('openLearning');
  assert.equal(stage.classList.contains('learning-active'), true, 'the review modules are hidden behind it');
  const board = document.querySelector('.board');
  assert.notEqual(board.className, originalBoardClass, 'the board reports it belongs to the workspace');
  assert.match(board.className, /learn-board/);
  assert.match(board.className, /framed/, 'the review board frame survives the handover');
  assert.equal(board.children.length, 64);
  assert.notEqual(board.firstElementChild.className, originalSquareClass, 'the squares are the workspace\'s own');
  assert.match(board.firstElementChild.className, /learn-square/);

  const workspace = a.run('learningWorkspace');
  await workspace.close();
  assert.equal(stage.classList.contains('learning-active'), false);
  assert.equal(document.querySelector('.board').className, originalBoardClass);
  assert.equal(document.querySelector('.board').firstElementChild.className, originalSquareClass);
});

test('the review cannot repaint the board out from under an open workspace', async t => {
  const a = learningApp(t);
  const document = a.dom.window.document;
  await a.call('openLearning');
  const board = document.querySelector('.board');
  const before = board.innerHTML;

  a.call('paintBoard');            // a late batch flush, a settings change, a resize
  a.call('buildBoard');
  a.call('renderBestArrow');
  a.call('renderUserArrows');
  a.call('renderUserMarks');
  a.call('alignPlayers');
  assert.equal(board.innerHTML, before, 'nothing may rebuild the squares the workspace is using');
  assert.equal(document.querySelector('.board'), board, 'the board element itself must survive');

  // Navigation keys belong to the workspace while it is open.
  const idx = a.state.idx;
  document.dispatchEvent(new a.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  document.dispatchEvent(new a.dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  assert.equal(a.state.idx, idx, 'the review must not step while a puzzle is open');

  await a.run('learningWorkspace').close();
  a.call('paintBoard');
  assert.notEqual(document.querySelector('.board').innerHTML, before, 'the review repaints again once closed');
});

test('a member can open the workspace straight from the board-side button', async t => {
  const a = learningApp(t);
  const button = a.dom.window.document.querySelector('.learn-entry-button');
  assert.equal(button.getAttribute('data-motion'), 'off', 'the harness runs with motion off');
  button.click();
  await settle();
  assert.ok(a.run('learningWorkspace'), 'clicking the button opens the workspace');
  assert.equal(button.classList.contains('is-activating'), true, 'and plays its activation state');
});

test('a puzzle is played to completion on the review board and stored', async t => {
  servePuzzles(t);
  const a = learningApp(t);
  const document = a.dom.window.document;
  await a.call('openLearning');
  const workspace = a.run('learningWorkspace');
  assert.ok(workspace.puzzles.length > 1000, 'the real library is loaded into the workspace');

  const puzzle = workspace.puzzles.find(p => p.theme === 'mateIn1' && p.solution.length === 1 && p.fen.split(' ')[1] === 'w');
  assert.ok(puzzle, 'the library must contain a one-move mate for White');
  await workspace.startPuzzleSelection([puzzle]);
  await settle();
  assert.deepEqual(workspace.activity, { kind: 'puzzle', id: puzzle.id, step: 0, assisted: false, mistakes: 0, replay: false, rated: true, adaptive: false });
  // The board shows the puzzle position, not the review game's.
  const board = document.querySelector('.board');
  assert.match(board.className, /learn-board/);
  assert.equal(board.children.length, 64);

  await workspace.submitPuzzle(puzzle.solution[0]);
  await settle();
  assert.equal(workspace.feedback.status, 'completed');
  assert.ok(document.querySelector('.board .puzzle-result-badge'), 'the result is shown on the destination square');

  const stored = a.store[PROGRESS_KEY];
  assert.ok(stored, 'progress is written to storage.local');
  assert.equal(stored.puzzles[puzzle.id].clean, 1);
  assert.equal(stored.puzzles[puzzle.id].ratingResult.won, true);
  assert.equal(stored.puzzleRating.elo, INITIAL_PUZZLE_ELO + stored.puzzles[puzzle.id].ratingResult.delta);
});

test('a wrong puzzle answer is reported as incorrect and never as a solve', async t => {
  servePuzzles(t);
  const a = learningApp(t);
  await a.call('openLearning');
  const workspace = a.run('learningWorkspace');
  const puzzle = workspace.puzzles.find(p => p.theme === 'mateIn1' && p.solution.length === 1);
  assert.ok(puzzle, 'the library must contain a one-move mate');

  // A legal move that is not the mate: the answer the engine would accept, but not the solution.
  const board = new Chess(puzzle.fen);
  const wrong = board.moves({ verbose: true }).map(m => m.lan).find(lan => !puzzle.solution.includes(lan));
  assert.ok(wrong, 'the position must offer more than the mating move');

  await workspace.startPuzzleSelection([puzzle]);
  await settle();
  await workspace.submitPuzzle(wrong);
  await settle();
  assert.notEqual(workspace.feedback.status, 'completed', 'the wrong answer must not complete the puzzle');
  assert.equal(workspace.activity.step, 0, 'the puzzle stays on its first move');
  assert.ok(!a.store[PROGRESS_KEY]?.puzzles?.[puzzle.id]?.clean, 'a wrong answer must not count as clean');
});
