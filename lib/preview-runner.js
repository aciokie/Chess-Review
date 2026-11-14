// Runs one preview at a time across every tab. Chrome hosts the engine workers in an offscreen
// document (a service worker cannot create Workers); Firefox's module background page can host them
// directly, so there the analysis runs in place. Either way the queue bounds CPU.
import { analyseButtonPreview } from "./preview-analysis.js";
import { checkImport, waitImport } from "./import-request.js";

const HOST_TARGET = "button-preview-host";
// The host document's scripts register their listener asynchronously, and Chrome can close an
// offscreen document while the background sleeps. Wait it out rather than failing the preview.
const HOST_DELAYS = [0, 100, 200, 400, 800, 1200, 1200];

export function createPreviewRunner(api, analyse = analyseButtonPreview, { delays = HOST_DELAYS } = {}) {
  let tail = Promise.resolve(), creating = null, queued = 0;

  async function ensureDocument() {
    if (creating) return creating;
    creating = (async () => {
      const contexts = await api.runtime.getContexts?.({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [api.runtime.getURL("preview.html")],
      });
      if (contexts?.length) return;
      await api.offscreen.createDocument({
        url: "preview.html",
        reasons: ["WORKERS"],
        justification: "Calculate local accuracy estimates for completed games on review buttons.",
      });
    })();
    try { await creating; } finally { creating = null; }
  }

  async function sendToHost(message) {
    let lastError = null;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt]) await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      try {
        const result = await api.runtime.sendMessage(message);
        if (result !== undefined) return result;
        lastError = Error("Preview host not ready");
      } catch (error) { lastError = error; }
      // Half way through, make sure the document still exists: a sleeping worker or an earlier
      // cancellation can have closed it, and every later attempt would go nowhere.
      if (attempt === Math.floor(delays.length / 2)) {
        try { await ensureDocument(); } catch { /* the next attempt reports the real failure */ }
      }
    }
    const error = Error("The preview engine did not start.");
    error.code = "PREVIEW_HOST_UNAVAILABLE";
    if (lastError) error.cause = lastError;
    throw error;
  }

  return (pgn, signal) => {
    queued++;
    const run = tail.catch(() => {}).then(async () => {
      checkImport(signal);
      if (!api.offscreen?.createDocument) return analyse(pgn, { signal });
      await ensureDocument();
      checkImport(signal);
      const id = globalThis.crypto?.randomUUID?.() || String(Date.now()) + Math.random().toString(36).slice(2);
      const cancel = () => { void api.runtime.sendMessage({ target: HOST_TARGET, type: "cancel", id }).catch(() => {}); };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        const result = await waitImport(sendToHost({ target: HOST_TARGET, type: "analyse", id, pgn }), signal);
        if (!result?.ok) {
          const error = Error(result?.error || "Preview unavailable");
          if (result?.code) error.code = result.code;
          throw error;
        }
        return result.summary;
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
    });
    const settled = run.finally(async () => {
      queued--;
      if (!queued && api.offscreen?.closeDocument) {
        try { await api.offscreen.closeDocument(); } catch { /* already closed by cancellation */ }
      }
    });
    tail = settled.catch(() => {});
    return settled;
  };
}
