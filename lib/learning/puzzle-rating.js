export const INITIAL_PUZZLE_ELO = 1200;
export const PROVISIONAL_PUZZLES = 20;

export function normalizePuzzleRating(value) {
  const count = n => Number.isSafeInteger(n) && n >= 0 ? n : 0;
  const wins = count(value?.wins), losses = count(value?.losses);
  return {elo:Number.isSafeInteger(value?.elo) && Math.abs(value.elo)<100000 ? value.elo : INITIAL_PUZZLE_ELO,
    played:wins+losses, wins, losses};
}

export function canRatePuzzle(progress, puzzle) {
  const record = progress.puzzles[puzzle.id];
  // A known solution is useful practice, but cannot be used to farm Elo.
  return !record?.ratingResult && !record?.attempts && !record?.clean && !record?.assisted && !record?.recovered;
}

// Call inside the progress store's locked transaction. The per-puzzle result
// makes wrong answers, retries, resumed sessions and save retries idempotent.
export function ratePuzzle(progress, puzzle, won, reason) {
  if (progress.puzzleRatingEnabled === false) return null;
  if (!canRatePuzzle(progress,puzzle) || !Number.isFinite(puzzle.rating)) return null;
  const rating = normalizePuzzleRating(progress.puzzleRating);
  const expected = 1 / (1 + 10 ** ((puzzle.rating-rating.elo)/400));
  const k = rating.played < PROVISIONAL_PUZZLES ? 48 : 24;
  const magnitude = Math.max(1, Math.round(k * (won ? 1-expected : expected)));
  const delta = won ? magnitude : -magnitude;
  const result = {before:rating.elo, after:rating.elo+delta, delta, won, reason, opponent:puzzle.rating, at:Date.now()};
  const record = progress.puzzles[puzzle.id] ||= {clean:0, assisted:0, mistakes:0, attempts:0, struggled:false};
  record.ratingResult = result;
  progress.puzzleRating = {elo:result.after, played:rating.played+1, wins:rating.wins+Number(won), losses:rating.losses+Number(!won)};
  return result;
}

export function pickRatedPuzzle(puzzles, progress, {seen = new Set(), random = Math.random} = {}) {
  const elo = normalizePuzzleRating(progress.puzzleRating).elo;
  const candidates = puzzles.filter(p => !seen.has(p.id) && Number.isFinite(p.rating) && canRatePuzzle(progress,p) && !progress.puzzles[p.id]?.struggled);
  if (!candidates.length) return null;
  const near = candidates.filter(p => Math.abs(p.rating-elo)<=200);
  const pool = near.length ? near : candidates.sort((a,b)=>Math.abs(a.rating-elo)-Math.abs(b.rating-elo)).slice(0,10);
  return pool[Math.min(pool.length-1, Math.max(0, Math.floor(random()*pool.length)))];
}
