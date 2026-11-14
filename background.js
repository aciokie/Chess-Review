// background.js — MV3 background (a real service worker on Chrome; Firefox has no MV3 service
// worker support, so it falls back to manifest.json's "background.scripts" and runs this as a
// module background page instead — see browser-compat.js for the chrome/browser API split that
// falls out of that). Handles the keyboard shortcut and the in-page "Free game review" button. The
// toolbar icon itself uses a default_popup (popup.html), so a click ALWAYS opens the anchored popup
// — whether the icon is pinned or tucked in the overflow menu — and the popup runs the analyze flow
// from there. (openPopup() can't anchor a popup for an unpinned action, which is why we don't drive
// the click from here anymore.)

import { analyzeActiveTab, openAnalysisTab, reloadActiveAndAnalyze, loadGameFromTab, isSupportedChessUrl } from "./analyze-flow.js";
import { browserAPI } from "./browser-compat.js";
import { createButtonPreviewService } from "./lib/button-preview-service.js";
import { createPreviewRunner } from "./lib/preview-runner.js";

// The post-game preview: a bounded local estimate of a finished game's accuracy and badge tally,
// shown under the in-page review button. It is never review evidence and never touches saved reviews.
const buttonPreviews = createButtonPreviewService({
  api: browserAPI,
  loadGame: loadGameFromTab,
  runPreview: createPreviewRunner(browserAPI),
});
browserAPI.tabs?.onRemoved?.addListener((tabId) => buttonPreviews.cancel(tabId));
browserAPI.tabs?.onUpdated?.addListener((tabId, change) => {
  if (change.url || change.status === "loading") buttonPreviews.cancel(tabId);
});

// Shared game (from a share link caught by content.js) → open the analysis.
// "Free game review" button injected into the chess.com game-over modal → same flow as the popup.
browserAPI.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && (msg.type === "buttonPreview" || msg.type === "cancelButtonPreview")) {
    if (sender.frameId !== 0 || !sender.tab) return;
    if (!isSupportedChessUrl(sender.url || sender.tab.url)) return;
    if (msg.type === "cancelButtonPreview") { buttonPreviews.cancel(sender.tab.id, msg.key); return; }
    buttonPreviews.get(sender.tab.id, msg.key).then((result) => { try { sendResponse(result); } catch {} });
    return true; // keep the message channel open for the async answer
  }
  if (msg && msg.type === "openShared" && msg.payload && msg.payload.pgn) {
    openAnalysisTab(msg.payload);
  }
  if (msg && msg.type === "freeGameReview") {
    // The review supersedes the preview (and a hidden estimate must never outlive it).
    buttonPreviews.cancel(sender.tab?.id);
    // Reply once the flow finishes so the in-page button can drop its "Opening review" cue
    // immediately (instead of waiting out its 5s hard cap) and report a failure honestly
    // rather than pretending the review opened.
    runAnalyze(stashError, sender.tab?.id).then((ok) => { try { sendResponse({ ok, done: true }); } catch {} });
    return true; // keep the message channel open for the async sendResponse
  }
});

// Keyboard shortcut: the service worker has no UI → on failure, just flash a badge.
browserAPI.commands.onCommand.addListener((command) => {
  if (command === "analyze-current") runAnalyze(showBadgeError);
});

async function runAnalyze(onFail, tabId = null) {
  let username;
  try {
    ({ username } = await browserAPI.storage.local.get("username"));
    await analyzeActiveTab(username, tabId);
  } catch (err) {
    // Only a "can't see the game on the page" failure is worth a reload (the SPA hasn't exposed
    // the finished game yet). Username/archive/network errors won't be fixed by reloading.
    if (err.code !== "NO_GAME") { onFail(err); return false; }
    try {
      await reloadActiveAndAnalyze(username, err.tabId);
    } catch (err2) {
      console.warn("[Chess Analyzer] couldn't analyze active game:", (err2 && err2.message) || err.message);
      onFail(err2 || err); return false;
    }
  }
  return true;
}

// Stash the failure reason so the popup can surface it (with the paste box open) next time it opens.
function stashError(err) {
  try { browserAPI.storage.local.set({ pendingError: (err && err.message) || "" }); } catch {}
}

function showBadgeError() {
  browserAPI.action.setBadgeText({ text: "!" });
  browserAPI.action.setBadgeBackgroundColor({ color: "#c0392b" });
  setTimeout(() => browserAPI.action.setBadgeText({ text: "" }), 4000);
}
