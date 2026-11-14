// Runs one preview at a time across every tab. Chrome hosts the engine workers in an offscreen
// document (a service worker cannot create Workers); Firefox's module background page can host them
// directly, so there the analysis runs in place. Either way the queue bounds CPU.
import { analyseButtonPreview } from "./preview-analysis.js";
import { checkImport, waitImport } from "./import-request.js";

const HOST_TARGET = "button-preview-host";

export function createPreviewRunner(api, analyse = analyseButtonPreview) {
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

  // The document's scripts register their listener asynchronously, so the first message can land
  // before anyone is listening. Resend briefly rather than declaring the preview unavailable.
  async function sendToHost(message, attempts = 6) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const result = await api.runtime.sendMessage(message);
        if (result !== undefined) return result;
        lastError = Error("Preview host not ready");
      } catch (error) { lastError = error; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw lastError || Error("Preview host not ready");
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
        if (!result?.ok) throw Error(result?.error || "Preview unavailable");
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
