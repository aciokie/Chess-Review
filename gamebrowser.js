// gamebrowser.js — Mobile-first Game Browser for Chess.com & Lichess user games.
// Renders username input, platform toggle, time control filters, recent usernames chips,
// paginated game list, and quick actions for pasting PGN or opening board explorer.

import { fetchUserGamesList } from "./chesscom.js";
import { fetchLichessUserGamesList } from "./lichess.js";
import { browserAPI } from "./browser-compat.js";

const RECENT_USERS_KEY = "recentUsers";
const MAX_RECENT_USERS = 5;

/** Format a timestamp into a readable date string */
function formatDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Render the mobile-friendly Game Browser component inside target container */
export function renderGameBrowser(container, { onSelectGame, onPastePgn, onExplore }) {
  let platform = "chesscom";
  let username = "";
  let timeClass = "all";
  let games = [];
  let loading = false;
  let loadingMore = false;
  let error = null;
  let hasMore = false;
  let paginationState = {}; // { archiveState, until }
  let recentUsers = [];

  // Load saved recent users and last platform/username
  async function loadInitialState() {
    try {
      const stored = await browserAPI.storage.local.get([RECENT_USERS_KEY, "username", "lastPlatform"]);
      recentUsers = Array.isArray(stored[RECENT_USERS_KEY]) ? stored[RECENT_USERS_KEY] : [];
      if (stored.username) username = stored.username;
      if (stored.lastPlatform && (stored.lastPlatform === "chesscom" || stored.lastPlatform === "lichess")) {
        platform = stored.lastPlatform;
      }
    } catch {}
  }

  // Save a searched username to recent users
  async function saveRecentUser(user, plat) {
    if (!user || !user.trim()) return;
    const clean = user.trim().toLowerCase();
    recentUsers = recentUsers.filter((u) => !(u.username.toLowerCase() === clean && u.platform === plat));
    recentUsers.unshift({ username: user.trim(), platform: plat });
    recentUsers = recentUsers.slice(0, MAX_RECENT_USERS);

    try {
      await browserAPI.storage.local.set({
        [RECENT_USERS_KEY]: recentUsers,
        username: user.trim(),
        lastPlatform: plat,
      });
    } catch {}
  }

  // Perform fetching of games (first page or load more)
  async function doFetch({ append = false } = {}) {
    const cleanUser = username.trim();
    if (!cleanUser) {
      error = "Please enter a username.";
      render();
      return;
    }

    if (append) {
      loadingMore = true;
    } else {
      loading = true;
      games = [];
      paginationState = {};
    }
    error = null;
    render();

    try {
      let res;
      if (platform === "chesscom") {
        res = await fetchUserGamesList(cleanUser, {
          limit: 50,
          archiveState: paginationState.archiveState || null,
          timeClass,
        });
        paginationState.archiveState = res.archiveState;
      } else {
        res = await fetchLichessUserGamesList(cleanUser, {
          limit: 50,
          until: paginationState.until || null,
          timeClass,
        });
        paginationState.until = res.until;
      }

      if (append) {
        games = games.concat(res.games);
      } else {
        games = res.games;
      }
      hasMore = res.hasMore;

      if (!append && games.length > 0) {
        await saveRecentUser(cleanUser, platform);
      }
      if (games.length === 0 && !append) {
        error = `No ${timeClass !== "all" ? timeClass + " " : ""}games found for '${cleanUser}' on ${platform === "chesscom" ? "Chess.com" : "Lichess"}.`;
      }
    } catch (err) {
      error = err.message || "Failed to fetch games.";
    } finally {
      loading = false;
      loadingMore = false;
      render();
    }
  }

  function render() {
    container.replaceChildren();

    const root = document.createElement("div");
    root.className = "gb-container";

    // Panel card
    const panel = document.createElement("div");
    panel.className = "gb-panel";

    // Header with Title and Platform Toggle
    const headerRow = document.createElement("div");
    headerRow.className = "gb-header-row";

    const title = document.createElement("div");
    title.className = "gb-title";
    title.textContent = "♟ Game Browser";

    const platformToggle = document.createElement("div");
    platformToggle.className = "gb-platform-toggle";

    const chesscomBtn = document.createElement("button");
    chesscomBtn.className = platform === "chesscom" ? "on" : "";
    chesscomBtn.textContent = "Chess.com";
    chesscomBtn.onclick = () => {
      if (platform !== "chesscom") {
        platform = "chesscom";
        games = [];
        error = null;
        render();
      }
    };

    const lichessBtn = document.createElement("button");
    lichessBtn.className = platform === "lichess" ? "on" : "";
    lichessBtn.textContent = "Lichess";
    lichessBtn.onclick = () => {
      if (platform !== "lichess") {
        platform = "lichess";
        games = [];
        error = null;
        render();
      }
    };

    platformToggle.append(chesscomBtn, lichessBtn);
    headerRow.append(title, platformToggle);
    panel.append(headerRow);

    // Search Row
    const searchRow = document.createElement("div");
    searchRow.className = "gb-search-row";

    const input = document.createElement("input");
    input.className = "gb-search-input";
    input.type = "text";
    input.placeholder = platform === "chesscom" ? "Chess.com username (e.g. Hikaru)" : "Lichess username (e.g. MagnusCarlsen)";
    input.value = username;
    input.oninput = (e) => {
      username = e.target.value;
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        doFetch({ append: false });
      }
    };

    const searchBtn = document.createElement("button");
    searchBtn.className = "gb-search-btn";
    searchBtn.textContent = loading ? "Fetching..." : "Fetch Games";
    searchBtn.disabled = loading;
    searchBtn.onclick = () => doFetch({ append: false });

    searchRow.append(input, searchBtn);
    panel.append(searchRow);

    // Recent Users Chips Row
    if (recentUsers.length > 0) {
      const chipsRow = document.createElement("div");
      chipsRow.className = "gb-chips-row";

      const label = document.createElement("span");
      label.className = "gb-chip-label";
      label.textContent = "Recent:";
      chipsRow.append(label);

      recentUsers.forEach((userItem) => {
        const chip = document.createElement("button");
        chip.className = "gb-chip";
        chip.textContent = `${userItem.username} `;
        const platSpan = document.createElement("span");
        platSpan.className = "gb-chip-platform";
        platSpan.textContent = `(${userItem.platform === "chesscom" ? "chess.com" : "lichess"})`;
        chip.append(platSpan);

        chip.onclick = () => {
          username = userItem.username;
          platform = userItem.platform;
          doFetch({ append: false });
        };
        chipsRow.append(chip);
      });
      panel.append(chipsRow);
    }

    // Time Control Filter Pills
    const filtersRow = document.createElement("div");
    filtersRow.className = "gb-filters-row";

    const timeClasses = [
      { id: "all", label: "All" },
      { id: "blitz", label: "Blitz" },
      { id: "rapid", label: "Rapid" },
      { id: "bullet", label: "Bullet" },
      { id: "daily", label: "Daily" },
    ];

    timeClasses.forEach((tc) => {
      const filterBtn = document.createElement("button");
      filterBtn.className = "gb-filter-btn" + (timeClass === tc.id ? " on" : "");
      filterBtn.textContent = tc.label;
      filterBtn.onclick = () => {
        if (timeClass !== tc.id) {
          timeClass = tc.id;
          if (username.trim()) {
            doFetch({ append: false });
          } else {
            render();
          }
        }
      };
      filtersRow.append(filterBtn);
    });
    panel.append(filtersRow);

    // Error Message
    if (error) {
      const errDiv = document.createElement("div");
      errDiv.className = "gb-empty-msg";
      errDiv.style.color = "var(--q-blunder)";
      errDiv.textContent = error;
      panel.append(errDiv);
    }

    // Loading State
    if (loading) {
      const loadingDiv = document.createElement("div");
      loadingDiv.className = "gb-empty-msg";
      loadingDiv.textContent = `Fetching games for '${username}' on ${platform === "chesscom" ? "Chess.com" : "Lichess"}...`;
      panel.append(loadingDiv);
    }

    // Games List
    if (!loading && games.length > 0) {
      const list = document.createElement("div");
      list.className = "gb-games-list";

      games.forEach((game) => {
        const card = document.createElement("div");
        card.className = "gb-card";
        card.onclick = () => {
          if (typeof onSelectGame === "function") {
            onSelectGame(game);
          }
        };

        const cardLeft = document.createElement("div");
        cardLeft.className = "gb-card-left";

        const badgeClass =
          game.result === "win" ? "gb-badge-win" : game.result === "loss" ? "gb-badge-loss" : "gb-badge-draw";
        const outcomeLabel = game.result === "win" ? "WIN" : game.result === "loss" ? "LOSS" : "DRAW";

        const badge = document.createElement("div");
        badge.className = `gb-outcome-pill ${badgeClass}`;
        badge.textContent = outcomeLabel;

        const info = document.createElement("div");
        info.className = "gb-card-info";

        const opp = document.createElement("div");
        opp.className = "gb-card-opp";
        opp.textContent = `vs ${game.opponent.username}`;
        if (game.opponent.rating) {
          const ratingSpan = document.createElement("span");
          ratingSpan.className = "gb-card-rating";
          ratingSpan.textContent = `(${game.opponent.rating})`;
          opp.append(ratingSpan);
        }

        const meta = document.createElement("div");
        meta.className = "gb-card-meta";
        meta.textContent = formatDate(game.endTime);

        info.append(opp, meta);
        cardLeft.append(badge, info);

        const cardRight = document.createElement("div");
        cardRight.className = "gb-card-right";

        const sideIcon = document.createElement("div");
        sideIcon.className = "gb-side-icon";
        sideIcon.textContent = game.mySide === "w" ? "♔ White" : "♚ Black";

        const tcTag = document.createElement("div");
        tcTag.className = "gb-tc-tag";
        tcTag.textContent = game.timeClass;

        cardRight.append(sideIcon, tcTag);
        card.append(cardLeft, cardRight);
        list.append(card);
      });

      panel.append(list);

      // Load More Button
      if (hasMore) {
        const loadMoreBtn = document.createElement("button");
        loadMoreBtn.className = "gb-load-more";
        loadMoreBtn.textContent = loadingMore ? "Loading more games..." : "Load More Games";
        loadMoreBtn.disabled = loadingMore;
        loadMoreBtn.onclick = () => doFetch({ append: true });
        panel.append(loadMoreBtn);
      }
    }

    // Quick Actions Row (Paste PGN / Explore Board)
    const actionsRow = document.createElement("div");
    actionsRow.className = "gb-actions-row";

    if (typeof onPastePgn === "function") {
      const pasteBtn = document.createElement("button");
      pasteBtn.className = "gb-action-btn";
      pasteBtn.textContent = "📋 Paste PGN / URL";
      pasteBtn.onclick = onPastePgn;
      actionsRow.append(pasteBtn);
    }

    if (typeof onExplore === "function") {
      const exploreBtn = document.createElement("button");
      exploreBtn.className = "gb-action-btn";
      exploreBtn.textContent = "🧭 Explore Board";
      exploreBtn.onclick = onExplore;
      actionsRow.append(exploreBtn);
    }

    if (actionsRow.children.length > 0) {
      panel.append(actionsRow);
    }

    root.append(panel);
    container.append(root);
  }

  loadInitialState().then(() => {
    if (username) {
      doFetch({ append: false });
    } else {
      render();
    }
  });
}
