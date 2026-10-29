// Move grades describe a move within its annotation category (ported from the upstream project,
// GPL-3.0). They are not position evaluations, win probabilities, game accuracy, or rating-model inputs.
export const MOVE_GRADE_CONFIG = Object.freeze({
  brilliant: { color: '#26c2a3', min: 10, max: 10 },
  great: { color: '#749bb8', min: 9.5, max: 9.9, criticalLossMax: 50 },
  best: { color: '#81b64c', min: 9, max: 9 },
  excellent: { color: '#81b64c', min: 7, max: 8.9, lossBand: ['zero', 'good'] },
  good: { color: '#95b776', min: 5, max: 6.9, lossBand: ['good', 'inacc'] },
  book: { color: '#a88865', min: null, max: null },
  inacc: { color: '#f7c531', min: 3, max: 4.9, lossBand: ['inacc', 'mistake'] },
  mistake: { color: '#f9a85a', min: 2, max: 2.9, lossBand: ['mistake', 'blunder'] },
  miss: { color: '#f5746a', min: 0, max: 4.9, opportunityDecay: 20, zeroLoss: 99 },
  blunder: { color: '#ee4a2f', min: 0, max: 1.9, lossBand: ['blunder', 'total'] },
});
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const finite = n => typeof n === 'number' && Number.isFinite(n);

export function moveGrade(category, loss, thresholds = {}, criticalLoss = null) {
  const cfg = MOVE_GRADE_CONFIG[category];
  if (!cfg || category === 'book' || !finite(loss)) return null;
  const bands = { zero: 0, good: 2, inacc: 5, mistake: 10, blunder: 20, total: 100, ...thresholds };
  let grade;
  if (cfg.min === cfg.max) grade = cfg.min;
  else if (category === 'great') {
    // The gap to the runner-up is already required by the Great classifier.
    const t = clamp(((finite(criticalLoss) ? criticalLoss : bands.inacc) - bands.inacc)
      / Math.max(1, cfg.criticalLossMax - bands.inacc), 0, 1);
    grade = cfg.min + (cfg.max - cfg.min) * t;
  } else if (category === 'miss') {
    // Miss is contextual, so it shares scores with error categories. Penalise the
    // opportunity actually lost, not the fact that the opponent erred first.
    grade = cfg.max * Math.exp(-Math.max(0, loss) / cfg.opportunityDecay);
    if (loss >= cfg.zeroLoss) grade = 0;
  } else {
    const [from, to] = cfg.lossBand.map(k => bands[k]);
    const t = clamp((Math.max(0, loss) - from) / Math.max(0.001, to - from), 0, 1);
    grade = cfg.max - t * (cfg.max - cfg.min);
  }
  return clamp(Math.round(grade * 10) / 10, cfg.min, cfg.max);
}

export function gradeText(score, fixedDecimals = false) {
  if (!finite(score)) return '—';
  const rounded = Math.round(score * 10) / 10;
  return fixedDecimals ? rounded.toFixed(1) : String(rounded);
}

export function gradeLabel(category, score, name) {
  if (category === 'book') return name;
  return `${name}, score ${finite(score) ? gradeText(score) : 'pending'}`;
}
