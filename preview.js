// Offscreen host for the post-game preview (Chrome). The background asks it to analyse one game;
// every request is cancellable, and nothing here writes to storage.
import { browserAPI } from "./browser-compat.js";
import { analyseButtonPreview } from "./lib/preview-analysis.js";
import { createImportRequest } from "./lib/import-request.js";

const jobs = new Map();

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== "button-preview-host") return;
  if (message.type === "cancel") {
    jobs.get(message.id)?.cancel();
    return;
  }
  if (message.type !== "analyse" || typeof message.pgn !== "string") return;
  const request = createImportRequest(undefined, 120000);
  jobs.set(message.id, request);
  analyseButtonPreview(message.pgn, { signal: request.signal }).then(
    (summary) => { try { sendResponse({ ok: true, summary }); } catch { /* the asker is gone */ } },
    (error) => {
      try {
        sendResponse({ ok: false, error: error?.message || "Preview unavailable", code: error?.code || null });
      } catch { /* gone */ }
    },
  ).finally(() => {
    if (jobs.get(message.id) === request) jobs.delete(message.id);
    request.dispose();
  });
  return true;   // keep the channel open for the async answer
});
