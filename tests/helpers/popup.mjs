// Run the real popup.js against the real popup.html in JSDOM, stubbing only the browser boundary
// and the pager that would hit Lichess/Chess.com. popup.js is a module with no exports, so tests
// assert through the DOM and storage.local exactly the way a click would — otherwise nothing here
// is exercised at all (the popup has no other suite).
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { isSupportedChessUrl } from '../../analyze-flow.js';
import { describeEntry, describeDetails, isValidUsername } from '../../recent-games.js';
import { parseGameId, parseFlip, gameMeta } from '../../chesscom.js';
import { parseLichessGameId, parseLichessFlip } from '../../lichess.js';

const html = fs.readFileSync(new URL('../../popup.html', import.meta.url), 'utf8');
const raw = fs.readFileSync(new URL('../../popup.js', import.meta.url), 'utf8');
const source = raw.replace(/^import .*;\r?\n/gm, '');

// A game row the list can render: describeEntry/describeDetails are the real ones.
export function game(overrides = {}) {
  return {
    url: 'https://lichess.org/abcd1234',
    pgn: '[Event "Rated blitz"]\n[White "ana"]\n[Black "bob"]\n[Result "1-0"]\n[WhiteElo "1500"]\n[BlackElo "1520"]\n\n1. e4 e5 2. Nf3 1-0',
    gameId: 'abcd1234', source: 'lichess', result: '1-0', playedAt: Date.now(), ...overrides,
  };
}

// popup.js finishes loading asynchronously (init() + initRecent() are fire-and-forget at the end),
// so this resolves only once the popup has settled — otherwise a test reads an empty field.
export async function popup(t, { storage = {}, pager } = {}) {
  const dom = new JSDOM(html, { url: 'https://extension.test/popup.html', pretendToBeVisual: true });
  const win = dom.window;
  const store = structuredClone(storage), writes = [];
  const calls = { fetches: [], opened: [], closed: 0, tabQueries: 0 };
  const browserAPI = {
    storage: { local: {
      async get(key) { return typeof key === 'string' ? { [key]: store[key] } : { ...store }; },
      async set(values) { writes.push(structuredClone(values)); Object.assign(store, structuredClone(values)); },
      async remove(key) { for (const k of Array.isArray(key) ? key : [key]) delete store[k]; },
    } },
    tabs: { query: async () => { calls.tabQueries++; return []; } },
  };
  // The pager is the only network edge: tests decide what a fetch returns, or that it throws.
  const createRecentGamesPager = (user, site) => {
    calls.fetches.push({ user, site });
    const plan = (typeof pager === 'function' ? pager(user, site) : pager) || {};
    return {
      done: plan.done !== false,
      async loadMore() {
        if (plan.error) throw new Error(plan.error);
        return { games: plan.games || [game({ source: site })], done: plan.done !== false };
      },
    };
  };
  const openAnalysisTab = async payload => { calls.opened.push(payload); };
  const closeWindow = win.close.bind(win);
  win.close = () => { calls.closed++; };   // the popup closes itself once it hands a game over

  const context = vm.createContext({
    window: win, document: win.document, navigator: win.navigator, location: win.location,
    HTMLElement: win.HTMLElement, Element: win.Element, Node: win.Node, CustomEvent: win.CustomEvent,
    getComputedStyle: win.getComputedStyle, structuredClone, console, URL, Date, Math, JSON, Object, Array,
    browserAPI, createRecentGamesPager, describeEntry, describeDetails, isValidUsername,
    openAnalysisTab, isSupportedChessUrl,
    analyzeActiveTab: async () => {}, reloadActiveAndAnalyze: async () => {},
    findGameById: async () => null, parseGameId, parseFlip, gameMeta,
    parseLichessGameId, parseLichessFlip, fetchLichessPgn: async () => '',
    MAX_PGN_BYTES: 1024 * 1024,
  });
  vm.runInContext(source, context, { filename: 'popup.js' });

  const $ = id => win.document.getElementById(id);
  const chips = () => [...$('recentSaved').querySelectorAll('button')].map(b => b.textContent);
  const options = () => [...$('recentUserList').options].map(o => o.value);
  // A click on the real Fetch button: exactly what a member does.
  const fetchClick = () => {
    $('fetchRecent').click();
    return settle();
  };
  const pickUser = async name => { $('recentUser').value = name; await fetchClick(); };
  const chooseSite = async (site, index) => {
    win.document.querySelectorAll('#sitePicker .site-btn')[index].click();
    await settle();
  };
  const submit = () => {
    const event = new win.Event('submit', { bubbles: true, cancelable: true });
    $('recentForm').dispatchEvent(event);
    return { prevented: event.defaultPrevented, done: settle() };
  };
  const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  await settle();   // let the popup's own startup finish
  // Drain before closing: a promise still in flight would touch a torn-down document and surface as
  // "asynchronous activity after the test ended" rather than as a real failure.
  t.after(async () => { await settle(); closeWindow(); });

  return { dom, win, document: win.document, $, store, writes, calls, chips, options, fetchClick, pickUser, chooseSite, submit, settle };
}
