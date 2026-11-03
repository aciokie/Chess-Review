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
import { validateExercise, validSquares } from '../lib/learning/validation.js';
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

// lib/learning reads its bundled JSON with fetch inside its own realm, so serve it from disk here;
// the same request goes to runtime.getURL() in the extension. Without it the workspace never leaves
// its loading state and silently falls back to the free board — which looks like a working page.
function servePuzzles(t) {
  const real = globalThis.fetch;
  globalThis.fetch = async url => {
    const relative = decodeURIComponent(new URL(String(url)).pathname.replace(/^\//, ''));
    return { ok: true, json: async () => JSON.parse(await readFile(relative, 'utf8')) };
  };
  t.after(() => { globalThis.fetch = real; });
}

function learningApp(t) {
  servePuzzles(t);
  const a = app(t);
  loadGame(a, REVIEW_PGN);
  a.context.loadLearningWorkspace = loadLearningWorkspace;
  a.call('buildUI');
  a.call('buildBoard');
  a.call('paintBoard');
  return a;
}

// Every workspace test needs the loaded library: assert it rather than discover it later.
const assertReady = workspace => assert.equal(workspace.ready, true,
  'the workspace must finish loading (progress + puzzle library) before its views render');

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

/* ---------------- board input on the learning board ----------------
   The workspace builds the squares and hands the host its own movement context, so these tests drive
   the real input path (pointer events on the squares) instead of calling the workspace's API. A
   regression here leaves a puzzle board that renders perfectly and cannot be played. */

// A fabricated one-move mate, appended to the loaded library so the input path is deterministic.
const INPUT_PUZZLE = { id: 'test-input-mate', fen: '7k/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1',
  solution: ['a1a8'], rating: 1200, theme: 'mateIn1', themes: ['mateIn1'] };

async function openPuzzle(t) {
  const a = learningApp(t);
  await a.call('openLearning');
  const workspace = a.run('learningWorkspace');
  workspace.puzzles.push(INPUT_PUZZLE);
  await workspace.startPuzzleSelection([INPUT_PUZZLE]);
  await settle();
  assert.deepEqual(workspace.activity && { kind: workspace.activity.kind, id: workspace.activity.id, step: workspace.activity.step },
    { kind: 'puzzle', id: INPUT_PUZZLE.id, step: 0 });
  return { a, workspace };
}

// jsdom has neither PointerEvent nor layout (every rect is zero), so build a MouseEvent that carries
// pointerId and give the board a real box for the workspace's own square hit-test.
function pointerInput(a, size = 800) {
  const view = a.dom.window;
  const board = view.document.querySelector('.board');
  board.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: size, bottom: size, width: size, height: size });
  const centre = sq => ({ x: (sq.charCodeAt(0) - 97 + 0.5) * (size / 8), y: (8 - Number(sq[1]) + 0.5) * (size / 8) });
  const fire = (target, type, { at = { x: 0, y: 0 }, button = 0, detail = 0 } = {}) => {
    const event = new view.MouseEvent(type,
      { bubbles: true, cancelable: true, button, detail, clientX: at.x, clientY: at.y });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    target.dispatchEvent(event);
  };
  return { fire, centre, view, doc: view.document };
}

const pieceAt = (doc, sq) => doc.querySelector(`.board [data-square="${sq}"] .piece-img`)?.dataset.piece || null;
const square = (doc, sq) => doc.querySelector(`.board [data-square="${sq}"]`);

test('a dragged puzzle piece moves on the puzzle board, not the review board', async t => {
  const { a, workspace } = await openPuzzle(t);
  const { fire, centre, view, doc } = pointerInput(a);
  assert.equal(pieceAt(doc, 'a1'), 'wR', 'the rook starts on a1');

  fire(square(doc, 'a1'), 'pointerdown', { at: centre('a1') });
  const ghost = doc.querySelector('.drag-piece');
  assert.ok(ghost, 'picking a piece up shows the drag ghost');
  assert.equal(ghost.querySelector('.piece-img')?.dataset.piece, 'wR', 'the ghost carries the picked piece');

  fire(view, 'pointermove', { at: centre('a8') });
  const target = square(doc, 'a8');
  assert.equal(target.classList.contains('drag-over'), true,
    'a8 is marked as a legal target - the drag must read the puzzle position, not the review game');

  fire(view, 'pointerup', { at: centre('a8') });
  await settle();
  assert.equal(pieceAt(doc, 'a8'), 'wR', 'the rook is on a8 after the drop');
  assert.equal(pieceAt(doc, 'a1'), null, 'the rook left a1');
  assert.equal(ghost.isConnected, false, 'the ghost is removed when the drag ends');
  assert.equal(workspace.feedback.status, 'completed', 'the mate completes the puzzle');
});

test('a drag that is dropped on an illegal square changes nothing', async t => {
  const { a } = await openPuzzle(t);
  const { fire, centre, view, doc } = pointerInput(a);
  fire(square(doc, 'a1'), 'pointerdown', { at: centre('a1') });
  fire(view, 'pointermove', { at: centre('b3') });
  assert.equal(square(doc, 'b3').classList.contains('drag-over'), false, 'a rook does not reach b3 from a1');
  fire(view, 'pointerup', { at: centre('b3') });
  await settle();
  assert.equal(pieceAt(doc, 'a1'), 'wR', 'the rook is back on a1');
  assert.equal(pieceAt(doc, 'b3'), null);
  assert.equal(doc.querySelector('.drag-piece'), null, 'the ghost is removed');
});

test('clicking a puzzle piece and its target plays the move too', async t => {
  const { a } = await openPuzzle(t);
  const { fire, centre, doc } = pointerInput(a);
  const click = sq => {
    fire(square(doc, sq), 'pointerdown', { at: centre(sq) });
    fire(square(doc, sq), 'pointerup', { at: centre(sq) });
    fire(square(doc, sq), 'click', { at: centre(sq), detail: 1 });
  };
  click('a1');
  assert.equal(square(doc, 'a1').classList.contains('sel'), true, 'the rook is selected');
  assert.equal(square(doc, 'a2').classList.contains('legal'), true, 'its legal targets are marked');
  assert.equal(square(doc, 'b3').classList.contains('legal'), false, 'and only the legal ones');
  click('a8');
  await settle();
  assert.equal(pieceAt(doc, 'a8'), 'wR', 'click-to-move plays the same move');
});

test('cancelling a held drag leaves the puzzle untouched', async t => {
  const { a, workspace } = await openPuzzle(t);
  const { fire, centre, view, doc } = pointerInput(a);
  fire(square(doc, 'a1'), 'pointerdown', { at: centre('a1') });
  fire(view, 'pointercancel', { at: centre('a1') });
  await settle();
  assert.equal(pieceAt(doc, 'a1'), 'wR', 'the piece stays where it was');
  assert.equal(workspace.activity.step, 0, 'no move was made');
  assert.equal(doc.querySelector('.drag-piece'), null);
  // The workspace cancels a held drag when it is closed or repainted; that hook must exist.
  fire(square(doc, 'a1'), 'pointerdown', { at: centre('a1') });
  assert.equal(typeof workspace.cancelBoardInput?.refresh, 'function', 'a held drag can be re-pointed at repainted squares');
  assert.equal(workspace.cancelBoardInput.active(), true, 'and reports that it is still live');
  workspace.cancelBoardInput.refresh({ a1: square(doc, 'a1') });
  assert.equal(workspace.cancelBoardInput.active(), true, 'the same piece keeps the drag alive');
  fire(view, 'pointerup', { at: centre('a1') });
  await settle();
  assert.equal(pieceAt(doc, 'a1'), 'wR');
});

/* ---------------- lessons and openings on the same board ---------------- */

test('a lesson exercise is answered on the board, but only on the Practise tab', async t => {
  const a = learningApp(t);
  await a.call('openLearning');
  const workspace = a.run('learningWorkspace');
  const lesson = LESSONS.find(l => l.exercises.some(e => e.type === 'move' && !e.objective.startsWith('event:')));
  const answer = lesson.exercises.find(e => e.type === 'move' && !e.objective.startsWith('event:')).solution[0];

  await workspace.startLesson(lesson.id);
  await settle();
  assert.equal(workspace.activity.tab, 'understand');
  const { fire, centre, doc } = pointerInput(a);
  const click = sq => {
    fire(square(doc, sq), 'pointerdown', { at: centre(sq) });
    fire(square(doc, sq), 'pointerup', { at: centre(sq) });
    fire(square(doc, sq), 'click', { at: centre(sq), detail: 1 });
  };
  // "Understand" and "Observe" show a diagram of the idea; the board deliberately ignores input.
  click(answer.slice(0, 2));
  assert.equal(square(doc, answer.slice(0, 2)).classList.contains('sel'), false, 'the diagram board is not selectable');
  assert.equal(workspace.feedback, null);

  await workspace.lessonTab('practise');
  await settle();
  // The exercise position, not the example's.
  assert.equal(workspace.currentFen(), lesson.exercises.find(e => e.type === 'move').fen);
  click(answer.slice(0, 2));
  assert.equal(square(doc, answer.slice(0, 2)).classList.contains('sel'), true, 'the practice board is selectable');
  click(answer.slice(2, 4));
  await settle();
  assert.equal(workspace.feedback.status, 'correct', 'the board answer is graded');
  const stored = a.store['learning:v1'];
  assert.equal(stored.lessons[lesson.id].exercises[0].passed, true, 'a correct answer is recorded');
});

test('lesson choice and squares exercises are answered from their own controls', async t => {
  const a = learningApp(t);
  await a.call('openLearning');
  const workspace = a.run('learningWorkspace');
  const { fire, centre, doc } = pointerInput(a);
  const click = sq => {
    fire(square(doc, sq), 'pointerdown', { at: centre(sq) });
    fire(square(doc, sq), 'pointerup', { at: centre(sq) });
    fire(square(doc, sq), 'click', { at: centre(sq), detail: 1 });
  };

  const choiceLesson = LESSONS.find(l => l.exercises.some(e => e.type === 'choice'));
  const choiceIndex = choiceLesson.exercises.findIndex(e => e.type === 'choice');
  await workspace.startLesson(choiceLesson.id);
  await workspace.lessonTab('practise');
  workspace.activity.exercise = choiceIndex;
  workspace.clearAnswer();
  workspace.render();
  await settle();
  const options = [...doc.querySelectorAll('.learn-options button')];
  assert.ok(options.length >= 2, 'a choice exercise offers its options');
  // Pick the option the rules engine accepts rather than assuming its position in the list.
  const choiceExercise = choiceLesson.exercises[choiceIndex];
  const right = choiceExercise.options.findIndex((_, i) => validateExercise(choiceExercise, i).status === 'correct');
  assert.ok(right >= 0, 'one option must be accepted');
  options[right].click();
  await settle();
  assert.equal(workspace.feedback.status, 'correct');

  const squareLesson = LESSONS.find(l => l.exercises.some(e => e.type === 'squares'));
  const squareIndex = squareLesson.exercises.findIndex(e => e.type === 'squares');
  const squareExercise = squareLesson.exercises[squareIndex];
  const wanted = validSquares(squareExercise);
  assert.ok(wanted.length, 'the rules engine knows the answer squares');
  await workspace.startLesson(squareLesson.id);
  await workspace.lessonTab('practise');
  workspace.activity.exercise = squareIndex;
  workspace.clearAnswer();
  workspace.render();
  await settle();
  for (const name of wanted) click(name);
  await settle();
  assert.deepEqual([...workspace.marked].sort(), [...wanted].sort(), 'the clicks collect the answer squares');
  // A squares exercise shows its selection with .selected (right-click marks use .marked).
  assert.deepEqual([...doc.querySelectorAll('.board .selected')].map(n => n.dataset.square).sort(), [...wanted].sort());
  [...doc.querySelectorAll('button')].find(b => b.textContent.trim() === 'Check selection').click();
  await settle();
  assert.equal(workspace.feedback.status, 'correct', 'selecting the right squares passes the exercise');
});

test('an opening line steps through the moves table on the review board', async t => {
  const a = learningApp(t);
  await a.call('openLearning');
  const workspace = a.run('learningWorkspace');
  const opening = OPENINGS.find(o => o.lines.length >= 3 && o.lines[0].moves.length >= 3);
  await workspace.startOpening(opening.id);
  await settle();
  const doc = a.dom.window.document;
  const buttons = [...doc.querySelectorAll('.learn-opening-moves tbody button')];
  assert.equal(buttons.length, opening.lines[0].moves.length, 'every move of the line is listed');
  const expected = linePositions(opening.lines[0]);
  assert.equal(workspace.currentFen(), expected.positions[0], 'the line starts from the standard position');
  buttons[2].click();
  await settle();
  assert.equal(workspace.currentFen(), expected.positions[3], 'clicking a move jumps to that position');
  assert.equal(workspace.activity.ply, 3);
});

test('a wrong puzzle answer is reported as incorrect and never as a solve', async t => {
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
