// Cancellation and timeout plumbing shared by everything that imports a game from a page.
// A request owns one AbortSignal; every step (tab read, network fetch, engine search) is raced
// against it, so navigating away or closing the tab ends the work instead of leaving it running.
export function importError(message = "Import canceled.", code = "IMPORT_CANCELLED") {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = code;
  return error;
}

export function checkImport(signal) {
  if (signal?.aborted) throw signal.reason || importError();
}

export function waitImport(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason || importError()); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
    if (signal.aborted) abort();
  });
}

export function createImportRequest(parent, budget = 180000) {
  const controller = new AbortController();
  let timer;
  const abort = () => controller.abort(parent.reason || importError());
  if (parent?.aborted) abort(); else parent?.addEventListener("abort", abort, { once: true });
  if (!controller.signal.aborted) {
    timer = setTimeout(() => controller.abort(importError("Import took too long. Retry or paste the PGN.", "IMPORT_TIMEOUT")), budget);
  }
  return {
    signal: controller.signal,
    cancel: () => controller.abort(importError()),
    dispose() { clearTimeout(timer); parent?.removeEventListener("abort", abort); },
  };
}
