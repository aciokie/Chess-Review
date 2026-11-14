// Small, versioned summaries that a post-game preview may show. Nothing here is review evidence:
// a preview is a bounded, cheap estimate and it is never stored as a scored observation.
export const BUTTON_PREVIEW_VERSION = 1;

// The categories a single-line, node-budgeted pass can decide. Brilliant and Great need a runner-up
// line (and Book needs the opening book), so they only appear in the full review.
export const PREVIEW_CATEGORIES = Object.freeze(["best", "excellent", "good", "inacc", "mistake", "blunder", "forced"]);
// Every category a saved FULL review can carry. A saved review's tally is shown whole, so the
// preview categories above must never be the filter applied to it.
export const REVIEW_CATEGORIES = Object.freeze([
  "brilliant", "great", "best", "forced", "excellent", "good", "book", "inacc", "mistake", "miss", "blunder",
]);

// Recognise the two supported platforms' finished-game URLs. The key is what ties a page to one
// game across navigation, so it must come from the URL alone (never from DOM text).
export function previewGameKey(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (/^(www\.)?chess\.com$/i.test(url.hostname)) {
      const id = url.pathname.match(/\/game\/(?:[a-z][a-z-]*\/)?(\d{4,})/i)?.[1];
      return id ? "chesscom:" + id : null;
    }
    if (url.hostname === "lichess.org" || url.hostname === "www.lichess.org") {
      const segment = url.pathname.replace(/^\/+/, "").replace(/^game\//, "").split("/")[0];
      if (/^(training|analysis|practice|streamer|tournament|broadcast)$/i.test(segment)) return null;
      return /^(?:[a-z0-9]{8}|[a-z0-9]{12})$/i.test(segment) ? "lichess:" + segment.slice(0, 8) : null;
    }
  } catch { /* not a URL → not a preview key */ }
  return null;
}

function validAccuracy(accuracy) {
  return accuracy && ["w", "b"].every((side) => Number.isFinite(accuracy[side]) && accuracy[side] >= 0 && accuracy[side] <= 100);
}

function normalizeCounts(counts) {
  if (!counts || typeof counts !== "object") return null;
  const out = {};
  let any = false;
  for (const category of REVIEW_CATEGORIES) {
    const value = counts[category];
    if (Number.isFinite(value) && value >= 0) { out[category] = Math.round(value); any ||= value > 0; }
  }
  return any || Object.keys(out).length ? out : null;
}

// Reuse a FULL review that is already saved for this exact game: its accuracy is exact and its
// category tally is the real one, so the preview must not replace it with an estimate.
export function savedButtonSummary(record, payload, key) {
  if (!record || !key || !payload || record.pgn !== payload.pgn) return null;
  const urlKey = previewGameKey(record.url || record.meta?.url || "");
  // Records saved from the Live board or a pasted PGN have no URL; their canonical id still matches.
  const id = key.startsWith("chesscom:") ? key.slice("chesscom:".length) : key.slice("lichess:".length);
  if (urlKey !== key && String(record.id || "") !== id) return null;
  const saved = record.buttonSummary?.version === BUTTON_PREVIEW_VERSION ? record.buttonSummary : null;
  const accuracy = saved?.accuracy
    || (record.meSide === "w" ? { w: record.myAcc, b: record.opAcc }
      : record.meSide === "b" ? { b: record.myAcc, w: record.opAcc } : null);
  if (!validAccuracy(accuracy)) return null;
  const counts = saved?.counts
    || (record.meSide === "w" ? { w: record.myCounts, b: record.opCounts }
      : record.meSide === "b" ? { b: record.myCounts, w: record.opCounts } : null);
  return {
    version: BUTTON_PREVIEW_VERSION,
    key,
    accuracy: { w: accuracy.w, b: accuracy.b },
    counts: counts ? { w: normalizeCounts(counts.w), b: normalizeCounts(counts.b) } : null,
    estimated: false,
  };
}
