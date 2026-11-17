// Who is "you" in a game? Layered, independent evidence so that a site markup change
// degrades to the next layer instead of silently breaking or guessing wrong.
//
//   1. Signed-in account, read live from the site's page (Chess.com / Lichess header data).
//   2. An explicitly typed handle (this fork's popup "Manual setup" username), when it is a player.
//   3. Accounts seen signed in on this browser before (survives a later markup change).
//   4. The player who recurs across your reviewed games (PGN headers only, no page markup).
//   5. The verified bottom player of the board, used only when nothing above knows who you are.
//
// Layers 1–4 also give a confident "not your game": once we know who you are, a game without
// you never borrows the bottom player as "you". See docs/IDENTITY.md.
import {inferredPlayer, PLAYER_HISTORY_KEY} from './player-history.js';

export const IDENTITY_KEY = 'identity:v1';
export const ACCOUNT_TTL_MS = 90 * 864e5;      // a remembered sign-in stays valid for 90 days
const ACCOUNT_REFRESH_MS = 6 * 36e5;           // re-stamp a known account at most every 6 hours
const MAX_ACCOUNTS = 5;
const SITES = new Set(['chesscom', 'lichess']);

export function accountName(value) {
  const name = String(value ?? '').trim();
  return /^[\w-]{2,30}$/.test(name) && !/^(white|black|anonymous|guest|computer|stockfish)$/i.test(name) ? name : '';
}

export function siteForUrl(value) {
  try {
    const {protocol, hostname} = new URL(value);
    if (protocol !== 'https:') return null;
    if (/^(?:www\.)?chess\.com$/i.test(hostname)) return 'chesscom';
    if (/^(?:www\.)?lichess\.org$/i.test(hostname)) return 'lichess';
  } catch {}
  return null;
}

// Page-reported viewing context, reduced to the only fields identity may use.
// `boardFlip` is the orientation of the board element itself (true = Black at the bottom),
// never a URL hint: a shared ?flip= or ?username= link says nothing about who is viewing.
export function cleanPerspective(value) {
  if (!value || typeof value !== 'object') return null;
  const account = accountName(value.account), bottom = accountName(value.bottom);
  const signedIn = typeof value.signedIn === 'boolean' ? value.signedIn : null;
  const boardFlip = typeof value.boardFlip === 'boolean' ? value.boardFlip : null;
  return account || bottom || signedIn != null || boardFlip != null ? {account, bottom, signedIn, boardFlip} : null;
}

// The side `name` plays, or null when it is neither player (or both, which proves nothing).
function sideOf(players, name) {
  const key = accountName(name).toLowerCase();
  if (!key) return null;
  const w = String(players?.w ?? '').toLowerCase() === key, b = String(players?.b ?? '').toLowerCase() === key;
  return w !== b ? (w ? 'w' : 'b') : null;
}

// Bottom player from two independent reads of the page: the name shown in the bottom player
// block and the board element's orientation. If both exist they must agree; a disagreement means
// the markup is not what we think it is, so neither is trusted.
export function bottomSide(players, perspective) {
  const byName = sideOf(players, perspective?.bottom);
  const flip = perspective?.boardFlip;
  const byBoard = flip === true ? 'b' : flip === false ? 'w' : null;
  if (byName && byBoard && byName !== byBoard) return null;
  return byName || byBoard;
}

export function knownAccounts(store, site, now = Date.now()) {
  const list = store?.[IDENTITY_KEY]?.[site]?.accounts;
  return (Array.isArray(list) ? list : [])
    .filter(entry => accountName(entry?.name) && Number.isFinite(entry.seenAt)
      && entry.seenAt <= now + 864e5 && now - entry.seenAt < ACCOUNT_TTL_MS)
    .sort((a, b) => b.seenAt - a.seenAt)
    .map(entry => entry.name);
}

/**
 * Resolve which side ('w' | 'b') the user played.
 * `extraNames` is this fork's manual-handle layer (the popup's typed username): it outranks
 * remembered/page-history evidence but never a live signed-in account.
 * @returns {{side: 'w'|'b'|null, name: string, source: string|null, reason: string}}
 */
export function resolveIdentity({site, players, perspective, store = {}, now = Date.now(), extraNames = []} = {}) {
  const none = reason => ({side:null, name:'', source:null, reason});
  const playersKnown = accountName(players?.w) && accountName(players?.b)
    && String(players.w).toLowerCase() !== String(players.b).toLowerCase();
  const hit = (side, source) => ({side, name:String(players[side]), source, reason:source});
  if (!playersKnown) return none('players-unknown');
  const view = cleanPerspective(perspective) || {};

  // 1. Signed in right now: decisive either way.
  if (view.account) {
    const side = sideOf(players, view.account);
    return side ? hit(side, 'account') : none('signed-in-account-not-in-game');
  }
  let known = false;
  // 2. An explicitly typed handle (fork-only layer). A typed handle that is not a player is still
  //    evidence about who you are, so it also suppresses the bottom-player guess below.
  for (const value of Array.isArray(extraNames) ? extraNames : []) {
    if (!accountName(value)) continue;
    const side = sideOf(players, value);
    if (side) return hit(side, 'manual');
    known = true;
  }
  if (SITES.has(site)) {
    // 3. Previously signed-in accounts, most recent first.
    for (const name of knownAccounts(store, site, now)) {
      known = true;
      const side = sideOf(players, name);
      if (side) return hit(side, 'remembered-account');
    }
    // 4. The recurring player across reviewed games.
    const learned = inferredPlayer(store, site);
    if (learned) {
      known = true;
      const side = sideOf(players, learned);
      if (side) return hit(side, 'history');
    }
  }
  // We know who you are and you are not in this game: never fall back to the bottom player.
  if (known) return none('known-account-not-in-game');
  // A signed-out visitor is a spectator: the bottom seat is just the site's default view.
  if (view.signedIn === false) return none('signed-out');
  // 5. Nothing known yet: the verified bottom player.
  const side = bottomSide(players, view);
  return side ? hit(side, 'bottom') : none('unknown');
}

export async function identityForGame(storage, game, extra = {}) {
  let store = {};
  try { store = await storage.get([IDENTITY_KEY, PLAYER_HISTORY_KEY, 'library']) || {}; } catch {}
  return resolveIdentity({...game, store, ...extra});
}

let writeQueue = Promise.resolve();
export async function rememberAccount(storage, site, value, via = '', now = Date.now()) {
  const name = accountName(value);
  if (!name || !SITES.has(site)) return false;
  const commit = async () => {
    const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const all = record((await storage.get(IDENTITY_KEY))?.[IDENTITY_KEY]);
    const entry = record(all[site]);
    const accounts = (Array.isArray(entry.accounts) ? entry.accounts : [])
      .filter(a => accountName(a?.name) && Number.isFinite(a.seenAt))
      .sort((a, b) => b.seenAt - a.seenAt);
    const previous = accounts.find(a => String(a.name).toLowerCase() === name.toLowerCase());
    // Skip the write only if nothing would change: same name, same source, recently stamped, and
    // already the most recent account (switching back to an older account must re-stamp it).
    if (previous && previous === accounts[0] && previous.name === name && previous.via === String(via).slice(0, 40)
      && now - previous.seenAt < ACCOUNT_REFRESH_MS && previous.seenAt <= now) return false;
    const next = [{name, seenAt:now, via:String(via).slice(0, 40)}, ...accounts.filter(a => a !== previous)].slice(0, MAX_ACCOUNTS);
    await storage.set({[IDENTITY_KEY]:{...all, [site]:{...entry, accounts:next}}});
    return true;
  };
  try {
    if (globalThis.navigator?.locks?.request) return await navigator.locks.request('chess-review-identity', commit);
    const pending = writeQueue.catch(() => {}).then(commit);
    writeQueue = pending;
    return await pending;
  } catch { return false; }
}
