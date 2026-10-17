# Learn with Chess Review — objective and progress

## Implementation tracker

Completed the initial fully usable learning release on 2026-10-14. This file travels with the repository so development can continue on another computer. Study progress stays local to the browser; this tracker records implementation progress. Local commits are created with the maintainer as author and Codex as co-author; nothing is pushed automatically.

- [x] Stage 1: Isolated learning workspace, bottom entry beside controls and below Engine, home, navigation, return to the exact review position/orientation and paused playback.
- [x] Stage 2: 23 complete concept lessons in seven categories, 47 exercises, interactive examples and counterexamples, prerequisites, scoped validation and feedback, completion states and difficult-exercise revisits.
- [x] Stage 3: 25,000 distinct offline puzzles across twelve themes and three difficulty bands, all setup/solution moves legally replayed. Filters, mixed/theme practice, hints, retry, reveal, missed-puzzle review and 1/5/10-minute challenges. Timers exclude loading/validation/saving; unique, repeat and assisted completions remain separate.
- [x] Puzzle expansion: increased the initial 216 positions to 25,000 from Lichess's CC0 database, retaining every original record and ID for saved progress. Quality filters, position deduplication, legal replay and mate-ending checks apply. The maintenance importer preserves existing content and uses a bounded download; normal use stays offline.
- [x] Stage 4: 12 opening courses / 24 variations / 250 individually annotated half-moves. Plans, structures, common mistakes, thematic tactics, practice as either color, automatic replies, exact course-position transpositions, bookmarks and saved study progress.
- [x] Stage 5: Responsive themed boards, SVG piece preferences, keyboard/click/drag input, legal promotion choices, focus management, reduced motion and loading/empty/error/completion states. Application suite, packaged Chrome/Firefox checks and fifteen Chrome learning layout/interaction audits pass.
- [x] Presentation update: in-place learning is the default. The actual review board stays anchored while the surrounding panels morph into the shared learning UI, with a matching return transition. Visual → Learning experience retains the original separate-page option. Reduced motion skips the panel animation.
- [x] Combined the four design variants into one Visual → Learning experience selector: Morph in place, Studio Morph, Minimal morph, Board morph, and Separate page. Their distinct home layouts and transition timing share the same learning model and preserve review state. Source designs: `673aaa6`, `e7b24fe`, `ecb3c2c`, and `b5786b0`.

## Fully usable now

All published lessons, puzzles and opening courses have a complete path. No unfinished lesson pages or research-named detector variants are exposed as courses. Review scores, original game moves and the research catalog/detectors/proofs are preserved. Repeated or assisted puzzle answers do not inflate unique unaided solves. Concept recognition, exercise objectives and move quality are separate validation fields; exhausted, unavailable or unsupported proofs never become incorrect answers.

The application regression suite passes **407 tests**; all seven final content checks also pass after the instructional text review. The Chrome and Firefox smoke checks exercise both bundled engines plus real learning proof workers, opening practice as Black, hidden puzzle solutions, assisted-progress persistence and unchanged review state. `npm run test:learning-browser` checks fifteen packaged Chrome screenshots/measurements, including 320 px layouts, reduced motion, timed scoring and return to review. Engine hashes, maintained source and reachable history pass verification, and Chrome/Firefox ZIPs build locally. Packaged Firefox lint has zero errors and one existing DOM-helper warning. Repository-wide lint reports four existing research-file errors (one invalid generated JSON and three oversized evidence files), plus research/demo warnings; those research files are outside the shipped extension and are preserved.

## Content and validation limits / next optional expansion

- The 23 authored lessons cover a curated part of the large concept catalog. More advanced catalog topics still need complete instructional text, contrasting board examples and exercises with supported validators before admission. Existing provisional research is retained and is not promoted by this feature.
- The 24 opening lines teach selected important entry variations, not every branch of opening theory. Transpositions are recognized when a legal move reaches a retained position in the selected course; the offline book also supplies names. New families and deeper branches need original annotations, plans and legal replay checks.
- Puzzle solutions/themes come from Lichess's Stockfish puzzle pipeline. We verify admission, legal setup/continuation replay and advertised mate endings; we do not claim independent reproduction of the original 40-meganode searches. Any legal checkmate is accepted; other moves follow the supplied unique-solution convention. See `data/learning/SOURCES.md` for licensing, source-row hashes and reproducible selection.
- Local progress has no account or cross-device synchronization. This development tracker and all content/code are in Git so another computer can continue from the same repository state.

## Where to continue

- Content and course schemas: `lib/learning/content.js`
- Puzzle source records: `data/learning/puzzles.json` and `data/learning/SOURCES.md`
- Scoped validation and worker: `lib/learning/validation.js`, `lib/learning/validation-worker.js`
- Local storage and challenge clock: `lib/learning/progress.js`
- Workspace/navigation/boards: `lib/learning/workspace.js`; measured panel transitions in `lib/learning/morph.js`; review entry/lifecycle in `analysis.js`; shared styling in `styles.css`
- Regression coverage: `tests/learning-*.test.mjs`; browser audits: `scripts/learning-browser.mjs`, `scripts/browser-smoke.mjs`
- Refresh puzzles deliberately with Node 24: `node scripts/import-learning-puzzles.mjs`, then `npm test`. Do not refresh during normal startup or build.
- Reproduce packaged checks: `npm run verify:source`, `npm run verify:engines`, `npm run build`, `npm run test:browsers`, `npm run test:learning-browser`.

## Original objective (verbatim)

I want to expand Chess Review beyond reviewing games by adding a dedicated learning experience called “Learn with Chess Review.”
The current concept experience isn’t achieving what I wanted, but we’ve invested substantial work in the concept catalog, detectors, and proofs. Preserve that work and reuse the relevant parts as the foundation for interactive lessons and exercises.

1. Entry point and learning workspace
Add a “Learn with Chess Review” button at the bottom of the review layout, to the right of the backward/play/pause/forward controls and below the Engine panel.
Clicking it should open a spacious learning workspace over the existing review interface, with a polished, subtle transition. It should feel like another part of Chess Review, with enough room for a board, lesson content, and navigation.
Provide a clear “Back to review” action. Preserve the current game, selected move, board orientation, and review state so the user can return exactly where they left off.
The learning home should offer three main destinations:
- Puzzles
- Chess Concepts
- Openings
Also show useful personal progress and a “Continue learning” action for unfinished activities.

2. Chess Concepts: understand, observe, practise
Build a searchable lesson library from our existing concept catalog, organized into understandable categories such as fundamentals, tactics, mating patterns, pawn structures, positional play, defense, and endgames. Arrange lessons from introductory to advanced, with prerequisites where useful.
Use familiar chess terminology in the interface. Related detector variants should become one coherent lesson where appropriate, rather than separate lessons with technical research names.
Each lesson should include:
- A clear explanation of the concept and why it matters.
- Interactive board examples with short explanations, move navigation, and selective arrows or square highlights.
- Common mistakes and examples showing when the concept does not apply.
- Exercises where the user identifies, creates, prevents, or executes the concept.
- Helpful feedback explaining why their answer works or what they missed.
Match the exercise to the concept. A fork might require playing a move; a weak square might require selecting a square; a pawn structure might require identifying its defining features. Avoid forcing every lesson into “find the best move.”
Reuse our existing detectors and proofs to validate exercises within the exact scope they support. Check concept recognition separately from move quality and the exercise’s objective. Accept alternative valid answers when the exercise allows them. An inconclusive or unsupported validation result must not be treated as an incorrect answer.
Track lesson progress as not started, in progress, and completed, and let users revisit exercises they struggled with.

3. Puzzles: regular practice and timed challenges
Create a substantial, varied puzzle library with verified legal positions, solutions, and explanations.
Provide filters for difficulty, tactical theme, game phase, and solved/unsolved status. Allow users to practise a specific theme, play a mixed selection, or revisit previous mistakes.
Regular practice should offer hints, retries, a solution reveal, and an explanation connecting the solution to its underlying concepts. Keep engine evaluations and solution arrows hidden until appropriate.
Add three timed challenge modes:
- 1 minute
- 5 minutes
- 10 minutes
The objective is to solve as many puzzles as possible before time expires. State the rules before starting, including how mistakes, skips, and hints affect the result. Start the clock only when the first puzzle is ready, and ensure loading or validation delays do not unfairly consume time.
Afterward, show puzzles solved, mistakes, accuracy, personal best, and an option to review missed puzzles.
Persist progress locally. Distinguish unique puzzles solved, repeat completions, and assisted solutions so the totals remain meaningful.

4. Openings: learn the ideas behind the moves
Create a searchable opening library organized by opening family, variation, and playing color. Reuse our existing offline opening book where suitable, while recognizing that opening names and move sequences still need instructional content.
Each opening should provide:
- An interactive main line and selected important variations.
- Explanations of the moves, typical plans, and resulting pawn structures.
- Common mistakes and thematic tactics.
- Practice from either side, with automatic opponent replies.
- Saved study progress and optional bookmarks.
Prioritize understanding over memorization. Handle transpositions where supported, and distinguish a move outside the selected line from an objectively bad move.

5. Visual quality and interaction
Follow Chess Review’s existing typography, colors, panels, board themes, piece sets, and user preferences.
Make the experience feel premium through careful spacing, readable content, responsive boards, and consistent interaction. Use restrained animations for workspace transitions, navigation, moves, feedback, and progress updates. Respect reduced-motion preferences.
Give the board and learning content visual priority. Every visible control should work, and loading, empty, error, and completion states should receive the same care as the main screens.
6. Implementation and content quality
Build this in coherent stages, beginning with the workspace and a complete path through each destination, then expanding the libraries.
Keep lessons, puzzles, opening content, validation, and progress storage structured so we can add material without rebuilding the interface. Reuse existing chess rules, board behavior, engine infrastructure, and concept logic where appropriate.
Use original or suitably licensed content with recorded sources. Do not inflate the libraries with duplicates, unverified exercises, generic filler, or unfinished lesson pages. Report what is fully usable and what still needs content or validation.
The intended result is a learning experience where users can understand chess ideas, practise them on the board, and see their progress, all within the familiar Chess Review environment.

Please make sure to do a .md file that both saves this prompt and tracks our progress so that i can continue from other pc's in the future.
