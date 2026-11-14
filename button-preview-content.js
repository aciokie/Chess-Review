// button-preview-content.js — the chess.com-style game review preview shown on a finished game's
// page, under the extension's own "Analyze with Chess Review" button.
//
// It never sees a PGN, an engine observation or any review evidence: it asks the background for a
// small versioned summary ({accuracy, counts, estimated}) and renders it. A full review's numbers
// win over an estimate; the estimate itself is a bounded 20,000-node pass and says so.
(() => {
  const CATEGORY_LABELS = {
    brilliant: "Brilliant", great: "Great", best: "Best", forced: "Forced", excellent: "Excellent",
    good: "Good", book: "Book", inacc: "Inaccuracy", mistake: "Mistake", miss: "Miss", blunder: "Blunder",
  };
  const CATEGORY_SYMBOLS = {
    brilliant: "!!", great: "!", best: "★", forced: "→", excellent: "✓", good: "✓",
    book: "♟", inacc: "?!", mistake: "?", miss: "×", blunder: "??",
  };
  // Chess.com does not badge every move: only the ones worth looking at get a badge. This is the
  // review's own NOTEWORTHY set (analysis.js) — the categories that earn a board and move-list
  // badge. Best/Excellent/Good/Book/Forced are volume, not story, and stay off the card.
  const BADGES = ["brilliant", "great", "inacc", "mistake", "miss", "blunder"];
  // The extension's actual badge icons (icons/<name>.svg, listed in web_accessible_resources).
  const ICON_FILES = { inacc: "inaccuracy" };
  // What the card says when it cannot produce numbers. It never guesses a score: it names the reason
  // and offers another try, because most of these are transient (an archive lagging behind a game
  // that just ended, a browser that could not start the bundled engine, a slow machine).
  const REASONS = {
    archive: "This game isn't in the public archive yet — it can take a few seconds to appear.",
    engine: "The preview engine couldn't start in this browser. The full review uses a different engine and still works.",
    host: "The preview engine didn't come up. Try again, or open the full review.",
    timeout: "Scoring took too long on this machine. Try again, or open the full review.",
    changed: "The game changed while the preview was being computed.",
    unknown: "The preview couldn't be computed for this game. The full review still works.",
    reload: "The extension was updated or reloaded — reload this page to reconnect.",
  };
  const RETRY_DELAYS = [2000, 5000, 10000, 20000, 30000];
  // Retrying a timeout or a game that changed under the tab only burns CPU; those keep the button.
  // "reload" cannot succeed from this page at all: the old content script lost its extension context.
  const AUTO_RETRY = { archive: true, engine: true, host: true, unknown: true, timeout: false, changed: false, reload: false };

  const entries = new Set();
  let api = null;
  let current = null;      // { key, done, result, token }
  let generation = 0;
  let retryTimer = null;
  let storageBound = false;
  let dead = false;        // the extension context was invalidated (update/reload/uninstall)
  let observed = false;
  let refreshTimer = null;
  const failures = new Map();
  const logged = new Set();

  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (name === "class") node.className = value;
      else if (name === "text") node.textContent = value;
      else node.setAttribute(name, String(value));
    }
    for (const child of children.flat()) if (child != null && child !== "") node.append(child);
    return node;
  }

  function number(value) {
    return Number.isFinite(value) && value >= 0 && value <= 100 ? value.toFixed(1) + "%" : null;
  }

  function contextOf(entry) {
    try { return entry.getContext() || {}; } catch { return {}; }
  }

  function createCard() {
    const card = h("div", { class: "chess-review-preview", "data-state": "pending" },
      h("div", { class: "chess-review-preview-head" },
        h("span", { class: "chess-review-preview-title", text: "Game review preview" }),
        h("span", { class: "chess-review-preview-tag", "data-estimate": "true", text: "Estimating…" })),
      h("div", { class: "chess-review-preview-sides" }),
      h("div", { class: "chess-review-preview-note" }));
    card.setAttribute("aria-live", "polite");
    return card;
  }

  // The button is registered while it is still detached (the page's builder inserts it afterwards),
  // so the card is mounted on the first refresh that finds the button in the document. chess.com also
  // re-renders these rows wholesale: the button can survive while its card is dropped, so an existing
  // card is moved back under the button rather than replaced.
  function mountCard(entry) {
    if (!entry.card) entry.card = createCard();
    if (!entry.button.isConnected) return false;
    if (!entry.card.isConnected || entry.card.previousElementSibling !== entry.button) {
      entry.button.insertAdjacentElement("afterend", entry.card);
    }
    return true;
  }

  function iconUrl(category) {
    try { return api.runtime.getURL("icons/" + (ICON_FILES[category] || category) + ".svg"); }
    catch { return ""; }
  }

  function badge(category, count) {
    const chip = h("span", {
      class: "chess-review-preview-badge", "data-cat": category,
      title: CATEGORY_LABELS[category] + ": " + count,
    });
    const src = iconUrl(category);
    const icon = h("img", {
      class: "chess-review-preview-badge-icon", src, alt: CATEGORY_LABELS[category], draggable: "false",
    });
    // If a packaged icon is ever missing, fall back to the plain glyph rather than a broken image.
    icon.addEventListener("error", () => {
      icon.replaceWith(h("b", { text: CATEGORY_SYMBOLS[category] || "•" }));
    });
    chip.append(icon, h("span", { class: "chess-review-preview-badge-count", text: String(count) }));
    return chip;
  }

  function sideRow(side, result) {
    const accuracy = number(result.accuracy?.[side]);
    const name = (result.players?.[side] || (side === "w" ? "White" : "Black"));
    const row = h("div", { class: "chess-review-preview-side", "data-side": side },
      h("div", { class: "chess-review-preview-line" },
        h("span", { class: "chess-review-preview-name", text: name }),
        h("span", { class: "chess-review-preview-acc", text: accuracy ? (result.estimated ? "~" : "") + accuracy : "—" })));
    const counts = result.counts?.[side];
    const chips = BADGES
      .filter((category) => Number.isFinite(counts?.[category]) && counts[category] > 0)
      .map((category) => badge(category, counts[category]));
    if (chips.length) row.append(h("div", { class: "chess-review-preview-badges" }, chips));
    if (result.me && result.me === side) row.setAttribute("data-self", "true");
    return row;
  }

  const PENDING_STAMP = {};

  // Rendering is idempotent: a refresh that changes nothing must not touch the DOM, or the page's
  // own MutationObserver (and ours) would see the card as a change and keep asking for a repaint.
  function renderEntry(entry) {
    const card = entry.card;
    if (!card?.isConnected) return;
    const context = contextOf(entry);
    const key = context.key || null;
    const state = key && current?.key === key ? current : null;
    const stamp = key ? (state ? (state.done ? (state.result || null) : PENDING_STAMP) : null) : PENDING_STAMP;
    const pendingState = state && !state.done ? state : null;
    if (card.dataset.rendered === "1" && entry.renderedKey === key && entry.renderedStamp === stamp
      && entry.renderedState === pendingState) return;
    entry.renderedKey = key;
    entry.renderedStamp = stamp;
    entry.renderedState = pendingState;
    card.dataset.rendered = "1";
    if (!key) { card.hidden = true; return; }
    const sides = card.querySelector(".chess-review-preview-sides");
    const note = card.querySelector(".chess-review-preview-note");
    const tag = card.querySelector(".chess-review-preview-tag");
    if (!state || !state.done) {
      card.hidden = false;
      card.dataset.state = "pending";
      delete card.dataset.reason;
      tag.textContent = "Estimating…";
      tag.dataset.estimate = "true";
      sides.replaceChildren(h("div", { class: "chess-review-preview-wait", text: "Scoring every move at 20,000 nodes…" }));
      note.textContent = "";
      return;
    }
    const result = state.result;
    if (!result?.ok) {
      const reason = REASONS[result?.reason] ? result.reason : "unknown";
      const retry = h("button", { class: "chess-review-preview-retry", type: "button", text: "Retry" });
      retry.addEventListener("click", () => retryNow(key));
      card.hidden = false;
      card.dataset.state = "unavailable";
      card.dataset.reason = reason;
      tag.textContent = "Unavailable";
      sides.replaceChildren(
        h("div", { class: "chess-review-preview-wait", text: REASONS[reason], title: result?.error || REASONS[reason] }),
        // Nothing this page can do will reconnect a dead extension context: ask for a reload instead.
        ...(reason === "reload" ? [] : [retry]),
      );
      note.textContent = "";
      return;
    }
    delete card.dataset.reason;
    card.hidden = false;
    card.dataset.state = "ready";
    tag.textContent = result.estimated ? "Estimate" : "Full review";
    tag.dataset.estimate = result.estimated ? "true" : "false";
    const order = result.me === "b" ? ["b", "w"] : ["w", "b"];
    sides.replaceChildren(...order.map((side) => sideRow(side, result)));
    note.textContent = result.estimated
      ? "Quick 20,000-node pass. Open the review for the exact scores."
      : "From your saved review of this game.";
  }

  function renderAll() {
    for (const entry of entries) renderEntry(entry);
  }

  function cancelPending() {
    if (!current) return;
    const key = current.key;
    current = null;
    try { Promise.resolve(api.runtime.sendMessage({ type: "cancelButtonPreview", key })).catch(() => {}); } catch {}
  }

  // One console line per distinct failure, so a user can report what actually went wrong without
  // the page filling with repeats from the automatic retries.
  function logFailure(key, reason, message) {
    const signature = key + "|" + reason + "|" + (message || "");
    if (logged.has(signature)) return;
    logged.add(signature);
    while (logged.size > 16) logged.delete(logged.values().next().value);
    try { console.warn("[Chess Review] review preview unavailable (" + reason + "):", message || reason); } catch {}
  }

  function retryNow(key) {
    if (!key || dead) return;
    failures.delete(key);
    clearTimeout(retryTimer); retryTimer = null;
    request(key);
  }

  // Chrome both throws and rejects here, depending on when the update happened, so the send is
  // wrapped: a page must never see an uncaught error because the extension was reloaded.
  function send(message) {
    try { return Promise.resolve(api.runtime.sendMessage(message)); }
    catch (error) { return Promise.reject(error); }
  }

  function contextLost(error) {
    return /extension context invalidated/i.test(String(error?.message || error || ""));
  }

  function request(key) {
    if (dead) return;
    clearTimeout(retryTimer); retryTimer = null;
    cancelPending();
    const token = ++generation;
    const state = { key, done: false, result: null, token };
    current = state;
    renderAll();
    try {
      send({ type: "buttonPreview", key })
        .catch((error) => (contextLost(error)
          ? { ok: false, key, reason: "reload", error: "Extension context invalidated" }
          : null))
        .then((result) => {
          if (generation !== token || current !== state) return;
          const first = [...entries].find((entry) => entry.card?.isConnected);
          if (!first || contextOf(first).key !== key) return;
          state.done = true;
          state.result = result?.key === key ? result : null;
          const reason = state.result?.reason || "unknown";
          if (reason === "reload") dead = true;
          for (const entry of entries) renderEntry(entry);
          if (!state.result?.ok) {
            logFailure(key, reason, state.result?.error);
            const attempt = failures.get(key) || 0;
            failures.set(key, attempt + 1);
            while (failures.size > 8) failures.delete(failures.keys().next().value);
            // An archive that has not caught up, or a host that started late, usually settles within
            // half a minute. After the last automatic try the card keeps its Retry button.
            if (AUTO_RETRY[reason] !== false && attempt < RETRY_DELAYS.length) {
              retryTimer = setTimeout(() => {
                if (generation !== token || current !== state) return;
                request(key);
              }, RETRY_DELAYS[attempt]);
            }
          }
        });
    } catch { state.done = true; }
  }

  // A host-page quirk inside one of our selectors must never break injection for the whole page.
  function refresh(force = false) {
    try { refreshInner(force); }
    catch (error) {
      logFailure("refresh", "unknown", String(error?.message || error || ""));
    }
  }

  function refreshInner(force = false) {
    for (const entry of entries) {
      if (!entry.button.isConnected) {
        // A page builder may register its button before inserting it, so a button that has never
        // carried a card is still being built — only one that leaves the document after mounting
        // (a discarded modal) is gone for good.
        if (!entry.card) continue;
        entry.card.remove();
        entries.delete(entry);
        continue;
      }
      mountCard(entry);
    }
    while (entries.size > 12) {
      const stale = [...entries].find((entry) => !entry.card && !entry.button.isConnected);
      if (!stale) break;
      entries.delete(stale);
    }
    const first = [...entries].find((entry) => entry.card?.isConnected);
    if (!first) { cancelPending(); return; }
    const key = contextOf(first).key || null;
    if (!key) { cancelPending(); renderAll(); return; }
    if (document.hidden) return;
    if (current?.key === key && !force) { renderAll(); return; }
    if (current?.key === key && force && current.done) { current.done = false; current.result = null; }
    request(key);
  }

  function register(button, options = {}) {
    if (!button || !options.getContext) return;
    api ||= options.api;
    if (!api) return;
    const existing = [...entries].find((entry) => entry.button === button);
    if (existing) { refresh(); return; }
    if (!storageBound) {
      storageBound = true;
      // A review saved while the page is open upgrades the estimate to the real numbers.
      try { api.storage?.onChanged?.addListener((changes, area) => {
        if (area === "local" && changes.library) refresh(true);
      }); } catch { /* no storage events → the estimate simply stays */ }
    }
    entries.add({ button, card: null, getContext: options.getContext });
    refresh();
  }

  // Whatever the page does to its own DOM — an SPA route change, a re-rendered row, a replaced
  // body — a card that was dropped goes back. The check is cheap, and it only schedules work when
  // something actually went missing, so a page that mutates every frame costs nothing.
  function startObserver() {
    if (observed || typeof MutationObserver !== "function") return;
    observed = true;
    try {
      new MutationObserver(() => {
        let missing = false;
        for (const entry of entries) {
          if (entry.button.isConnected && (!entry.card || !entry.card.isConnected)) { missing = true; break; }
        }
        if (!missing || refreshTimer) return;
        refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 150);
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch { /* no observer → the page's own scans still call refresh */ }
  }

  globalThis.ChessReviewButtonPreview = { register, refresh };

  addEventListener("pagehide", () => {
    cancelPending();
    clearTimeout(retryTimer); retryTimer = null;
    clearTimeout(refreshTimer); refreshTimer = null;
  });
  addEventListener("pageshow", () => refresh());
  addEventListener("popstate", () => refresh());
  // Coming back online is exactly when an archive/network failure can succeed.
  addEventListener("online", () => {
    if (current?.done && !current.result?.ok) retryNow(current.key);
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  startObserver();
})();
