import { previewGameKey, savedButtonSummary } from "./button-preview.js";
import { finishedPreviewGame } from "./preview-analysis.js";
import { createImportRequest, checkImport, waitImport } from "./import-request.js";
import { PLAYER_HISTORY_KEY } from "./player-history.js";
import { IDENTITY_KEY, resolveIdentity } from "./identity.js";

// Turns a failed lookup into a short, honest reason the page can show next to a Retry button. The
// raw message is kept for the console; the reason is what the card speaks aloud. Failures that name
// the GAME (not finished, a variant) must be distinguishable from failures of this machine, or the
// card would blame the browser for a property of the game — and retry forever for an answer that
// cannot change.
const FAILURE_REASONS = {
  GAME_NOT_ARCHIVED: "archive",
  GAME_NOT_FINISHED: "unfinished",
  PREVIEW_UNSUPPORTED: "unsupported",
  PREVIEW_ENGINE_UNAVAILABLE: "engine",
  PREVIEW_HOST_UNAVAILABLE: "host",
  PREVIEW_TIMEOUT: "timeout",
  IMPORT_TIMEOUT: "timeout",
  PREVIEW_GAME_CHANGED: "changed",
  // Cancelled on purpose: the page asked for a new game, the tab navigated, or a review started.
  // That is not a failure of the preview and must not be reported as one.
  IMPORT_CANCELLED: "canceled",
};

export function previewFailureReason(error) {
  return FAILURE_REASONS[error?.code] || "unknown";
}

// Looks up one finished game and answers with a small summary. Order of preference:
//   1. a full review already saved for this exact game (exact numbers, never an estimate),
//   2. a summary cached during this session,
//   3. a fresh 20,000-node preview.
// A tab has at most one lookup in flight; navigating cancels it.
export function createButtonPreviewService({ api, loadGame, runPreview, budgetMs = 60000 }) {
  const pending = new Map(), cache = new Map();

  const cancel = (tabId, key) => {
    const job = pending.get(tabId);
    if (job && (!key || job.key === key)) { job.request.cancel(); pending.delete(tabId); }
  };

  return {
    cancel,
    async get(tabId, key) {
      // Every answer is shaped the same way (ok/key/reason/error) so a page always has something to
      // say. An unshaped "no" is turned into a generic "couldn't be computed" and a pointless retry.
      const refusal = (reason, message) => ({ ok: false, key: key ?? null, reason, error: message });
      if (!Number.isInteger(tabId) || !/^(chesscom:\d{4,}|lichess:[a-z0-9]{8})$/i.test(key || "")) {
        return refusal("unknown", "Unsupported preview request");
      }
      const previous = pending.get(tabId);
      if (previous?.key === key) return previous.promise;
      cancel(tabId);
      // Each queued preview can hold four engine workers, so past a handful of tabs the honest
      // answer is "busy" — retryable, and never an unbounded pile of waiting engine work.
      if (pending.size >= 8) return refusal("busy", "Too many previews at once");
      const request = createImportRequest(undefined, budgetMs);
      const job = { key, request };
      job.promise = (async () => {
        const payload = await waitImport(loadGame(tabId, { signal: request.signal }), request.signal);
        checkImport(request.signal);
        if (previewGameKey(payload?.meta?.url) !== key) {
          const error = Error("Game changed during lookup");
          error.code = "PREVIEW_GAME_CHANGED";
          throw error;
        }
        const parsed = finishedPreviewGame(payload.pgn);
        const stored = await waitImport(api.storage.local.get([IDENTITY_KEY, PLAYER_HISTORY_KEY, "username", "library"]), request.signal);
        // Identity is re-resolved on every request (never cached): it can be learned between games.
        // The typed handle is this fork's manual layer, so it outranks remembered/history evidence.
        const identity = resolveIdentity({
          site: key.split(":")[0], players: parsed.players,
          perspective: payload.meta?.perspective, store: stored,
          extraNames: stored.username ? [stored.username] : [],
        });
        const me = { me: identity.side, meSource: identity.source };
        for (const record of Array.isArray(stored.library) ? stored.library : []) {
          const summary = savedButtonSummary(record, payload, key);
          if (summary) return { ok: true, ...summary, players: parsed.players, ...me };
        }
        const cacheKey = key + "\n" + payload.pgn;
        if (cache.has(cacheKey)) return { ok: true, ...cache.get(cacheKey), ...me };
        const summary = await waitImport(runPreview(payload.pgn, request.signal), request.signal);
        checkImport(request.signal);
        const result = { ...summary, key, players: parsed.players, ...me };
        cache.set(cacheKey, result);
        while (cache.size > 30) cache.delete(cache.keys().next().value);
        return { ok: true, ...result };
      })().catch((error) => ({
        ok: false,
        key,
        reason: previewFailureReason(error),
        error: error?.message || "Preview unavailable",
      })).finally(() => {
        request.dispose();
        if (pending.get(tabId) === job) pending.delete(tabId);
      });
      pending.set(tabId, job);
      return job.promise;
    },
  };
}
