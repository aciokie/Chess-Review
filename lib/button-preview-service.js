import { previewGameKey, savedButtonSummary } from "./button-preview.js";
import { finishedPreviewGame } from "./preview-analysis.js";
import { createImportRequest, checkImport, waitImport } from "./import-request.js";

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

  function ownSide(stored, players) {
    const handle = String(stored?.username || "").trim().toLowerCase();
    if (!handle) return null;
    for (const side of ["w", "b"]) if (String(players?.[side] || "").trim().toLowerCase() === handle) return side;
    return null;
  }

  return {
    cancel,
    async get(tabId, key) {
      if (!Number.isInteger(tabId) || !/^(chesscom:\d{4,}|lichess:[a-z0-9]{8})$/i.test(key || "")) return { ok: false };
      const previous = pending.get(tabId);
      if (previous?.key === key) return previous.promise;
      cancel(tabId);
      if (pending.size >= 8) return { ok: false, key };
      const request = createImportRequest(undefined, budgetMs);
      const job = { key, request };
      job.promise = (async () => {
        const payload = await waitImport(loadGame(tabId, { signal: request.signal }), request.signal);
        checkImport(request.signal);
        if (previewGameKey(payload?.meta?.url) !== key) throw Error("Game changed during lookup");
        const parsed = finishedPreviewGame(payload.pgn);
        const stored = await waitImport(api.storage.local.get(["username", "library"]), request.signal);
        const me = ownSide(stored, parsed.players);
        for (const record of Array.isArray(stored.library) ? stored.library : []) {
          const summary = savedButtonSummary(record, payload, key);
          if (summary) return { ok: true, ...summary, players: parsed.players, me };
        }
        const cacheKey = key + "\n" + payload.pgn;
        if (cache.has(cacheKey)) return { ok: true, ...cache.get(cacheKey), players: parsed.players, me };
        const summary = await waitImport(runPreview(payload.pgn, request.signal), request.signal);
        checkImport(request.signal);
        const result = { ...summary, key, players: parsed.players, me };
        cache.set(cacheKey, result);
        while (cache.size > 30) cache.delete(cache.keys().next().value);
        return { ok: true, ...result };
      })().catch((error) => ({ ok: false, key, error: error?.message || "Preview unavailable" })).finally(() => {
        request.dispose();
        if (pending.get(tabId) === job) pending.delete(tabId);
      });
      pending.set(tabId, job);
      return job.promise;
    },
  };
}
