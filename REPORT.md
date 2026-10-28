# Audit & fix report — Chess Review

Date: 2026-10-28
Branch: `main` (pushed directly, per repo convention)
Base commit at start: `dd1e669` (`origin/main`, clean, nothing uncommitted)

This report covers: verification of the three previously unverified commits, a full
baseline run, a real-browser end-to-end pass, native-engine verification, the two open
investigations (Concepts "duplicates" and the Explore/promotion audit), a review of
PR #10, and the one fix that came out of the audit.

Everything below was run on this machine. Where a check could not be run, it is listed
under **What could not be done** with the reason.

---

## 0. The fix that came out of the audit

| | |
|---|---|
| **Bug** | On the standalone Explore board the two jump buttons in the controls bar announced **"Variation start"** / **"Variation end"** to screen readers, contradicting the board's own "Explore" labelling. `dd1e669` removed the visible *"Exploring a variation."* / *"Variation · "* wording but missed the two `aria-label`s. |
| **File/line** | `analysis.js:3080` and `analysis.js:3086` (inside `renderControls()`), before the fix |
| **Repro** | Open `analysis.html#explore`, move any piece, inspect `#controls button[aria-label]` → `["Variation start", "Previous move", "Next move", "Variation end"]` with the middle slot rendering a plain `Explore` label. |
| **Root cause** | The Explore guard added in `dd1e669` covered the board class, the insight-panel text and the Concepts line, but `renderControls()` still hard-coded the two variation labels. |
| **Fix** | `const lineName = S.meta?.explore ? "Line" : "Variation";` and use `lineName + " start"` / `lineName + " end"`. A side line off a reviewed game keeps the variation labels. |
| **Test** | `tests/explore-ui.test.mjs` — *"the Explore controls never announce "Variation" to assistive tech, but a side line still does"* (asserts both boards). Suite 11/11. |
| **Commit** | `3dd64c6` — *Explore board: drop the remaining 'Variation' wording from its controls* |
| **Real-browser proof** | E2E check *"explore: controls say \"Line start/end\", not \"Variation\""* → PASS, `["Line start","Previous move","Next move","Line end"]` |

No other functional bug was found. The three unverified commits are otherwise correct.

---

## 1. Baseline and final verification

### 1.1 Baseline (before any edit, i.e. `dd1e669`)

| Command | Result |
|---|---|
| `npm ci` | OK (only npm audit warnings for transitive dev deps) |
| `npm test` | **287 tests · 284 pass · 0 fail · 3 skipped** (45 s) |
| `npm run lint` | **0 errors · 0 warnings · 0 notices** |
| `npm run verify:engines` | 4/4 WASM SHA-256 **OK** (`stockfish-nnue.js/.wasm`, `stockfish-19-lite-single.js/.wasm`) |
| `npm run build` | OK — Chrome ZIP SHA-256 `3a11a96145db7c073562acf2cbbfc5bcd967005f27ba3d750ae8134a1fe6db9e` |

The 3 skips are pre-existing and expected: one synthetic routing-audit test, and two
`concept-integration` tests that skip when the `research/` directory is absent.

The three previously unverified suites, run explicitly:

| Suite | Result |
|---|---|
| `node --test tests/promotion-picker.test.mjs` | **7/7** |
| `node --test tests/explore-ui.test.mjs` | **10/10** (now 11/11 with the new test) |
| `node --test tests/concept-wording.test.mjs` | **6/6** |

### 1.2 Final (after `3dd64c6`)

| Command | Result |
|---|---|
| `npm test` | **288 tests · 285 pass · 0 fail · 3 skipped** (30 s) — +1 is the new test |
| `npm run lint` | **0 errors · 0 warnings · 0 notices** |
| `npm run verify:engines` | 4/4 **OK** |
| `npm run build` | OK — Chrome `6d2db437df05c670764f287af8d177f6c1d11b2ecec5c996b08b3104a8a13535`, Firefox `2e731ac09e7c617e6c2c82bbc07610a58ca458a283b469d6c2ce96f4158d8197` |
| `npm run test:browsers` | Chrome engine legs **pass** (real engine + completed review for `nnue` and `sf19lite`); Firefox leg fails `ENOENT` (no Firefox installed) |

No test was weakened, skipped, or deleted to make anything pass. The only test change is
the added assertion above.

---

## 2. Real-browser end-to-end (packaged extension)

Driver: `playwright-core` + `chromium.launchPersistentContext` against the **packaged**
build (`web-ext-artifacts/release-0.2.0-FbVqUd/chrome-0.2.0-tqrOQz`, loaded with
`--load-extension`), Brave as the Chromium binary, a normal Chrome user agent
(Lichess/extension APIs reject `HeadlessChrome`), fresh profile per run.

**Result: 35/35 checks passed, 10 screenshots.**
Screenshots: `web-ext-artifacts/report-screenshots/`

| # | Check | Result | Screenshot |
|---|---|---|---|
| 1 | Explore board loads | **PASS** | |
| 2 | Explore board starts full colour (no `.analysis`) | **PASS** | |
| 3 | Board stays full colour after free-play moves | **PASS** | |
| 4 | Coach box says *"Analysis board. Move any piece to explore."* | **PASS** | |
| 5 | Concepts line says *"Explore board · White's Nf3"* | **PASS** | |
| 6 | No "variation" wording in visible text | **PASS** | `01-explore-after-moves.png` |
| 7 | Explore controls say "Line start/end", not "Variation" **(new)** | **PASS** | |
| 8 | Promotion picker opens on a click capture-promotion | **PASS** | |
| 9 | Four options in Q, N, R, B order | **PASS** | `02-promo-picker-click.png` |
| 10 | Underpromotion plays the right SAN (`gxh8=N`) | **PASS** | `03-promo-underpromotion-knight.png` |
| 11 | Picker closes after the pick | **PASS** | |
| 12 | Keyboard `R` picks a rook promotion (`g8=R`) | **PASS** | |
| 13 | `Escape` closes the picker | **PASS** | |
| 14 | `Escape` cancels the move (no `gxh8` in the list) | **PASS** | |
| 15 | Click outside (dimmed board) closes without moving | **PASS** | |
| 16 | Right-click closes without moving | **PASS** | |
| 17 | Picker opens on a drag promotion | **PASS** | `04-promo-picker-drag.png` |
| 18 | Drag + queen plays `g8=Q` | **PASS** | |
| 19 | Flipped board → panel grows from the bottom | **PASS** | `05-promo-picker-flipped.png` |
| 20 | Flipped board promotion plays (`gxh8=N`) | **PASS** | |
| 21 | Picker opens for a **Black** promotion | **PASS** | `06-promo-picker-black.png` |
| 22 | Black underpromotion plays `gxh1=N` | **PASS** | |
| 23 | Real analyzed game: analysis completes (Practice enabled) | **PASS** | |
| 24 | Promotion picker opens in a real analyzed game | **PASS** | |
| 25 | Sideline board **does** get the gray `.analysis` look | **PASS** | |
| 26 | Sideline coach box still says *"Exploring a variation."* | **PASS** | |
| 27 | Concepts line uses `Variation · ` in analyzed games | **PASS** | `07-game-variation-promotion.png` |
| 28 | New line appears in the Moves list (`g8=Q`) | **PASS** | |
| 29 | Engine evaluates the sideline (score shown, `-0.14`) | **PASS** | |
| 30 | Practice: analysis completes | **PASS** | |
| 31 | Practice: reaches a solving spot (*"Nc3 is a Blunder."*) | **PASS** | |
| 32 | Practice: demo finished, solving position ready | **PASS** | |
| 33 | Practice: promotion picker opens during mistake practice | **PASS** | `08-practice-promo-picker.png` |
| 34 | Practice: underpromotion judged **fail** (still solving) | **PASS** | `09-practice-underpromotion-judged.png` |
| 35 | Practice: queen promotion judged **correct** | **PASS** | `10-practice-queen-correct.png` |

Two earlier "failures" in the in-browser pass were **test** bugs, not app bugs, and were
fixed in the driver: (a) an illegal demonstration line, (b) `analysis.html#explore` →
`analysis.html#explore` is a same-document hash navigation so the page never reloaded, and
(c) wrong selectors / demo timing. After those fixes every check passed on the first
clean run, so no app-behaviour workaround was introduced.

---

## 3. Native Stockfish 19 engine

All results below are genuine — real binaries, real process, real protocol.

### 3.1 Integrity

| Artifact | Actual SHA-256 | Pinned in | Match |
|---|---|---|---|
| `native/engine/stockfish-windows-x86-64-universal.exe` | `45bc8e4969147db9c2eb533810637994619bff0eacc81ccfd9854394901bcbd0` | `native/engine/checksums.json` | **YES** |
| `native/host/ChessReviewHost.exe` | `53da21bb583d78c32d1ac475c1c8a8bdb16b91b601728ed84d379577aa6dd768` | `native/host/checksums.json` | **YES** |

Running the bundled engine directly prints `id name Stockfish 19` and
*"Stockfish 19 by the Stockfish developers"* — it is the official SF19, not a
re-labelled 18.

### 3.2 Host protocol

`npm run test:native-host` (real Native-Messaging protocol, real helper, real engine):
**22/22 pass**.

`Install Native Engine.bat` self-test: helper **1.0.0**, engine accepted by **both** the
`id name` string and the SHA-256 pin, helper registered under `HKCU` for **Chrome, Brave
and Edge**, extension id `mdhgoffoaomghlfgckggmnfifmalomba`.

### 3.3 End-to-end through the packaged extension

| Scenario | Result |
|---|---|
| Native build selected, helper installed | **PASS** — a 6-position review finished with `engineBuild = "native19"` at the requested depth; the helper process was observed |
| `config.json` temporarily hidden (helper unavailable) | **PASS** — fell back to `engineBuild = "nnue"`, UI reported *"Stockfish 18 NNUE (fallback)"*; `config.json` restored afterwards |

**Verdict:** the native engine path is genuine, correctly hash-pinned, and falls back
cleanly to WASM (it never promotes a WASM build to `native19`, and never the reverse).

---

## 4. Step 4 — the Concepts "duplicates" report

**Claim to check:** one fact listed under several different names in the Concepts panel.

**What is already in the code.** `a192e07` (*Fix repeated concept findings and stray "0"
in lessons*) introduced `mergeAliasFindings()` in `lib/coach-insights.js:90`. One detector
observation routed to several catalog names (e.g. *Open diagonal / Diagonal control /
Long-diagonal bishop*) is listed once, with the other names shown as
*"Also matched as: …"* and their scopes merged. Regression test:
`tests/coach-insights.test.mjs:118`.

**Attempts to reproduce the symptom (all negative):**

| Attempt | Scope | Result |
|---|---|---|
| Real browser, Opera game, every move, All-concepts view | 1 full game | **0 duplicates** |
| Worker-exact pipeline scan (fast pass + all deep detectors) | 30 positions across 5 games incl. promotion and endgame | **0 duplicates** |
| This run: full pipeline, all concept groups enabled, three perspective renderings per position (`mover`, opponent, unknown player) | **66 positions** (Légal/Opera 33 + Immortal 33) = 198 rendered panels | **0 duplicate displayed-text groups** |
| This run: raw detector output, independent of presentation — same text emitted under **two different event ids** | same 66 positions | **0** |

The only "118 duplicate groups" ever seen came from a scratch normaliser that collapsed
board coordinates to `sq`, turning *"The White rook on a1 …"* and *"… on h1 …"* into the
same string. That is a false positive of the probe, not of the app.

**Outcome: no fix.** The duplicate-listing bug is already fixed; the current build does
not reproduce it in the browser or in 96 positions of the real detector pipeline. No
change was made to `lib/coach-insights.js` or the registry, because the only safe change
would be to merge findings from *different* events by text alone — which would hide
genuinely distinct observations and cannot be justified without a repro.

---

## 5. Step 5 — Explore / promotion audit

### 5.1 What was checked and found correct

| Area | Verdict |
|---|---|
| Board gray look (`paintBoard`) | Guarded by `S.analysisMode && !S.meta?.explore` — correct |
| Insight panel text (`renderReview`) | *"Analysis board. Move any piece to explore."* on Explore; *"Exploring a variation."* on a side line — correct |
| Concepts position line (`renderCoachPanel`) | *"Explore board · …"*, no `Variation · ` prefix — correct |
| Players (`renderPlayers`), stats, eval graph (`renderGraph`) | Hidden/emptied in Explore — correct |
| Controls (`renderControls`) | *"Explore"* label instead of an Exit button; **two aria-labels were wrong → fixed in `3dd64c6`** |
| Moves list (`renderMoves`) | Explore shows the free-play line, not a branch off a mainline — correct |
| `exitAnalysis` / `gotoVar` / `Home` / `End` / `Escape` | Explore rewinds to the line start and keeps the line; codified in `tests/explore-ui.test.mjs:31` — correct |
| Promotion: click, drag, keyboard Q/N/R/B, Esc, outside click, right-click cancel | Verified in the browser (E2E 8–22) |
| Promotion: flipped board, both colours, capture-promotion, stale pick after navigation | Verified in the browser and in `tests/promotion-picker.test.mjs` |
| Promotion in mistake practice (underpromotion judged) | Verified in the browser (E2E 30–35) |
| Engine/PV promotions (`playLine`) | Uses the PV's own promotion letter; never opens the picker — correct |

### 5.2 Design questions left unchanged

1. **Explore reuses `S.analysisMode` + `S.variation`.** `Escape` calls `exitAnalysis()`,
   which in Explore rewinds to `gotoVar(0)` and *stays* in analysis mode, because the
   Explore board has no mainline to return to. This is deliberate and asserted by
   `tests/explore-ui.test.mjs:31` (*"Escape only closes the panel, it does not leave
   Explore"*). Giving Explore its own state flag would touch classification badges, the
   Moves list, the engine panel and the live-eval token; not worth the churn without a
   user-visible defect.
2. **The promotion picker is a single global (`promoPicker`).** A second promotion
   replaces a pending one. Only one promotion can be pending at a time in practice, so no
   change.
3. **Click-outside cancel only covers the board.** The overlay is `position:absolute;
   inset:0` over `.board`, so a pointerdown on a board square cancels; a click on a side
   panel does not. This matches the intent (the board is dimmed, everything else is
   visible) and the E2E check *"click outside (dimmed board)"* passes. Left as designed.
4. **Right-click while the picker is open cancels the promotion** rather than drawing an
   annotation arrow. This is stated in the `0d71cbb` commit message and tested; left as
   designed.

---

## 6. PR #10 review

| Field | Value |
|---|---|
| Title | *Verify codebase health and tests* (Jules, automated) |
| State | open, `mergeable_state = "clean"` (no conflicts) |
| Base → head | `main` → `main-17908989474403906787` |
| Head commit | `1ae0761` — *"Verify codebase health, test suite, engine checksums, and lint status"* |
| Commits / files changed | **1 commit / 0 files changed** |
| Parent of head | `c5b2bad`, already an ancestor of `main` |

**Verdict: harmless no-op.** The PR adds exactly one empty commit on top of a commit that
is already in `main`; its body only reports that dependencies, tests, checksums and lint
were run. Merging it would add a second empty commit to `main`; it delivers nothing.
**Recommendation: close it** (or merge if you want the empty marker — neither changes any
file). Its claim of "257 passing" is also stale: the current suite is 288 tests.

No code was taken from, or merged into, this PR.

---

## 7. What could not be done (ranked by importance)

1. **Firefox real-browser leg.** No Firefox is installed here, so
   `npm run test:browsers` fails the Firefox phase with `ENOENT`. Extension behaviour in
   Firefox (and `web-ext lint`'s Firefox-specific checks) is therefore unverified beyond
   the linter's static pass.
2. **Chrome-branded browser run.** No Chrome is installed; all browser work used Brave
   via `CHROME_PATH`. Brave is Chromium, so extension behaviour should be identical, but
   this is not a literal Chrome run.
3. **Step 4 duplicate reproduction.** Four independent attempts (real browser + three
   pipeline scans, 96 positions total) produced no duplicate, so there is nothing to fix.
   This is a negative result, not a skipped check.
4. **A single uninterrupted 141-position duplicate sweep.** The full sweep exceeded a
   15-minute budget after 66 positions (0 duplicates). The remaining two games —
   promotion and a rook endgame — were covered by the earlier 30-position worker-exact
   scan, not by this run.
5. **Native installer on a clean machine.** The installer was verified on this machine
   with existing `HKCU` state; a from-scratch Windows install (fresh user, no prior
   registry entries) was not reproduced.
6. **Automatic extension reload after a pull.** The native registration is keyed to the
   unpacked extension id; after pulling, the extension has to be reloaded manually. Not
   automatable from the page (documented in `AGENTS.md`).

---

## 8. Commits pushed to `main`

```
3dd64c6 Explore board: drop the remaining 'Variation' wording from its controls
```

Earlier commits from this working session (already on `main` before this audit):

```
46ac994 Fix empty Recent-games rows (children were assigned, never appended)
e928d35 Add "Recent games": paste a username, pull the last 30 games
80b1a9c AGENTS.md: document the native engine, packaging allowlist, and platform gotchas
```

`main` was clean and equal to `origin/main` at `dd1e669` when the audit started; the audit
added exactly one commit (`3dd64c6`) plus this report.