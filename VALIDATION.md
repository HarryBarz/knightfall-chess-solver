# Executed validation

Date: 2026-09-27. Environment: macOS arm64, Python 3.9, Node.js 24.16.0, native official Stockfish 19 universal release, headless Google Chrome.

## Opponent targeting 85–90% local accuracy (2026-09-29)

Executed with native Stockfish 19, including independently reviewed actual move
choices, rather than assigning an accuracy score from the difficulty slider:

```sh
env PYTHONPYCACHEPREFIX=/private/tmp/knightfall-pycache .venv/bin/python -m unittest discover -s tests -v
env PYTHONPYCACHEPREFIX=/private/tmp/knightfall-pycache .venv/bin/python scripts/verify_accuracy_target.py --games 2 --max-plies 40 --output artifacts/accuracy-target-games.json
node scripts/target_accuracy_smoke.mjs http://127.0.0.1:8877
node scripts/browser_smoke.mjs http://127.0.0.1:8877
node scripts/accuracy_smoke.mjs http://127.0.0.1:8877
node scripts/screenshot_smoke.mjs http://127.0.0.1:8877
```

All **122 Python tests passed in 48.647s**. New deterministic and HTTP coverage
checks actual weaker-move selection for both colors, true committed-history
validation, imported Black starts, unscored/invalid input, forecast values
outside the target, a lower bound on move quality, maximum pawn loss, forced
replies, immediate mates, saturated positions, insufficient/bounded analysis,
cancellation without a proposed event, and resetting Classic search strength
after a full-reference target search.

The reproducible native benchmark passed nine fixed-position checks. Four
ordinary opening choices were independently graded **86.08, 87.58, 91.17, and
81.47** in the initial fixture pass; the tactical position with no suitable
weaker choice, the two immediate mates, and the two forced replies stayed at
100. This deliberately demonstrates both target tracking and its limits.
Fixture scores can vary between bounded native searches.

Two games were played from the normal starting position, one with the target
opponent as each color. Target searches used 1 second, one thread, 32 MB hash,
and the production candidate policy. The other side used native skill 6 at
0.08 seconds. Every recorded move was independently regraded by the production
AccuracyService; whole-prefix totals used the unchanged browser v2 aggregator.

| Target side | Recorded plies | Controller forecast | Independent local report |
| --- | ---: | ---: | ---: |
| White | 40 | 90.98 | 90.29 |
| Black | 40 | 88.13 | 85.50 |

Both games were **unfinished** at the cap. These are prefix scores, not final
game outcomes, an Elo calibration, a win-rate measurement, or a guaranteed
85–90 range. The small sample shows that the policy can select actual moves
near the target while retaining sensible strong replies; it does not promise
human-like play. Artifact `artifacts/accuracy-target-games.json` records the
engine hash, settings, PGNs, selections, committed events, and all independent
review rows. This benchmark completed in **114.096s**.

The new target browser suite passed in **13.9s**: default target/Classic
selection, native own-turn suggestion and opponent reply routing, actual event
commitment, reload, preview-only analysis, failed moves, cancellation, undo,
import and side resets, screenshot controls, invalid saved history, and
strength-100 labels. Native selections are used first; deterministic proposals
then exercise edge cases through real server position/move validation. The
existing Classic gameplay suite, independent accuracy-report suite, and full
screenshot-recognition/import suite also passed. The target desktop capture was visually inspected. The local app was
restarted with the new default mode; the reviewer was not changed.

## Accuracy inflation correction, method v2 (2026-09-29)

A supplied 48-ply PGN and Chess.com summary exposed a limitation not caught by
the original implementation tests. The screenshot reports White **76.5** and
Black **94.2**. Replaying every move through native Stockfish reproduced the
inflated local scores:

| Calculation | White | Black |
| --- | ---: | ---: |
| Original v1, 0.45s best / 0.40s played searches | 91.83 | 98.23 |
| Original v1, 2s best / 1.78s played searches | 91.96 | 97.65 |
| New v2, 0.45s best / 0.40s played searches | 77.82 | 97.76 |
| Supplied Chess.com summary | 76.5 | 94.2 |

Both original runs gave the last **17 White moves** and **18 Black moves** 100:
native self-play expected points had saturated at 0 and 1. An arithmetic mean
then diluted the earlier errors. Zero expected-points loss also incorrectly
implied Best, and a nonterminal WDL expectation of 1 replaced the engine's
preferred root move as if it were a proven checkmate. The longer searches did
not resolve those structural issues.

V2 preserves the best searched evaluation, distinguishes rounded WDL ties from
proven terminal ties, and uses the published Lichess-style numeric formulas and
weighted/harmonic aggregation documented in README. Full-strength native WDL
still supplies the Chess.com category thresholds. This is an explicit hybrid
local estimate, not either website's exact metric. No coefficient was fitted
to this game. Black's remaining discrepancy is not resolved, and one game does
not establish calibration. The bounded search can change scores between runs.
The published CP ceiling still permits some weaker moves in decided positions
to receive 100 numerically; they no longer automatically receive Best.

Executed checks:

```sh
env PYTHONPYCACHEPREFIX=/private/tmp/knightfall-pycache .venv/bin/python -m unittest discover -s tests -v
node --test tests/accuracy_math.test.mjs
node scripts/accuracy_smoke.mjs http://127.0.0.1:8877
git diff --check
```

All **111 Python tests passed in 45.682s**, including regression tests that
first failed on the recorded saturated-WDL patterns. **21 Node tests passed**
for the public numeric curves, window alignment, weighting, harmonic averaging,
color mirroring, Black-start imports, sparse/unavailable evaluations, method
version validation, and browser loading. The native Chrome report suite passed
in **15.1s**, verifying both numeric side totals, category counts, replay badges,
full-strength isolation, cancellation/retry, valid v2 cache reuse, and mandatory
recalculation of a legacy v1 report. Desktop and mobile report captures were
generated; the mobile layout was visually inspected. An initial sandboxed
Python run could not bind its temporary HTTP server; the complete suite above
was rerun successfully with the required local-server permission.

Local diagnostic traces are in ignored `artifacts/accuracy-comparison-*.json`;
the supplied PGN and its full move trace are not added to the repository. The
v2 side totals were checked using the production JavaScript aggregator against
an independent Python calculation over the same 48 scored rows.

## Original after-match accuracy estimates, method v1 (2026-09-29)

The following records the original implementation checks, superseded by the
scoring correction and comparison above.

Executed with native Stockfish 19 and headless Chrome on macOS:

```sh
.venv/bin/python -m unittest discover -s tests -v
node scripts/accuracy_smoke.mjs http://127.0.0.1:8882
node scripts/browser_smoke.mjs http://127.0.0.1:8881
node scripts/review_smoke.mjs http://127.0.0.1:8881
node scripts/arrows_smoke.mjs http://127.0.0.1:8881
```

The complete Python suite passed **107 tests in 45.669 seconds**, including 18
new accuracy tests and three HTTP integration checks. These execute threshold
boundaries without rounding, both mover perspectives, the local curve's bounds,
coherent native WDL provenance, rejection of bounded/missing scores, exact mate
and draw outcomes, fivefold history, the 75-move rule, forced replies, immutable
input, full-strength configuration, pre-cancellation, interrupted searches,
latest-request handling, and separation from playing and lesson engines. The
API stays at full strength even when the request includes reduced practice
settings. Missing native scores stay unscored rather than becoming 100.

All four browser suites passed. The new report suite completed a real Fool's
Mate game and verified automatic reports for both players, category counts,
arithmetic score means, provisional progress, cached reload without recomputing,
move-to-lesson navigation and category badges, full-strength scoring independent
of the lesson teacher, unfinished and retained match reports, error retry,
concurrent playing analysis, and stale-result suppression after undo/import/new
game. Successful grading uses the real server and Stockfish; only errors and
response timing are injected. Desktop, 390px, and 320px report/review captures
were visually inspected (`artifacts/accuracy-*.png`). An initial browser run
caught a hidden report host; that integration issue was fixed before the passing
run. JavaScript syntax and `git diff --check` passed.

These checks establish the local method's behavior, not CAPS2 equivalence. The
category ranges were checked against Chess.com's public documentation; native
Stockfish WDL and the documented local score curve differ from Chess.com's
rating-aware model and accuracy aggregation. No Chess.com score-matching claim
or benchmark is made.

## Optional analysis arrows (2026-09-29)

Executed with native Stockfish 19 and headless Chrome on macOS:

```sh
.venv/bin/python -m unittest discover -s tests -v
node scripts/browser_smoke.mjs http://127.0.0.1:8882
node scripts/screenshot_smoke.mjs http://127.0.0.1:8882
node scripts/review_smoke.mjs http://127.0.0.1:8882
node scripts/arrows_smoke.mjs http://127.0.0.1:8882
```

The complete Python suite passed **86 tests in 41.642 seconds**. This includes
23 new arrow tests and two new HTTP integration checks. The tests execute
absolute pins, both-color forks, coordinated pressure on f7, support and central
control, opened rook lines including en passant, underpromotion, castling,
terminal positions, named gambit history, and qualified material offers. Legal
continuations retain the actual turn and selected engine move; unrelated top
variations cannot be attached to a lower-strength choice. API checks validate
settings, preserve history and board state, and cancel arrow searches without
cancelling the separate playing search. Native searches also exercise both
strength-limited plans and mate positions.

All three existing browser suites passed, covering play and persistence,
screenshot recognition/import, and full post-match replay. These checks also
verify the board wrapper preserves existing click targets and desktop/mobile
layout. JavaScript syntax and `git diff --check` passed.

The dedicated arrow browser suite passed using real server and Stockfish
responses. It checks the default-off state, no searches when disabled,
independent White/Black filters, simultaneous ideas, coordinated bishop/queen
pressure on f7, normal/flipped/mobile SVG alignment, and real mouse moves through
the transparent overlay. Every projected step is replayed through the chess API
to verify its legality and FEN. The suite also covers selected-strength live
analysis versus full-strength review, replay and variation-preview contexts,
unchanged live board/storage, saved preferences, offline retry, and delayed
responses across master-off, undo, import, and new game. Only errors and response
timing are injected; successful chess results come from Stockfish.
Desktop, 390px, and 320px board/control captures and expanded review explanations
were visually inspected (`artifacts/arrows-*.png`). The final rerun also verifies
the expanded review notes remain reachable by scrolling. The local server was
restarted on port 8877; its health endpoint and a native 70% arrow request passed.

## Post-match reviewer (2026-09-29)

The new reviewer was exercised with native Stockfish 19 and headless Chrome on
macOS. Commands:

```sh
.venv/bin/python -m unittest discover -s tests -v
node scripts/review_smoke.mjs http://127.0.0.1:8881
node scripts/browser_smoke.mjs http://127.0.0.1:8882
node scripts/screenshot_smoke.mjs http://127.0.0.1:8882
```

The 14 new review tests cover mover-relative scores and mate ordering, legal
annotated continuations, retained full history, imported roots, immutable input
boards, cancellation/recovery, recaptures, piece maneuvers and passed pawns. Real
Stockfish searches reviewed errors by both colours and terminal mate. A concrete
Fool's Mate comparison verifies that after `e3`, the same queen check can be
answered by `Ke2` or `g3`; this establishes legal replies, not a guaranteed result.
Two new HTTP integration tests verify request validation, before/after history
FENs, full-strength review and separation from the playing and live-note engines.

The dedicated reviewer browser suite passed with a completed Fool's Mate game.
It checks the persistent end-of-match offer, the retained match after new game
and reload, initial-to-final replay, You/Solver identification, detailed plans and
corrections, actual/projected/correction board previews, legal API FEN agreement,
all five horizon choices, full-strength review independent of the playing profile,
keyboard navigation, playback/pause, error retry, and late-result suppression
after closing and reopening. Preview/navigation left the live board and saved
workspace unchanged. Only delay/error injection used test responses; successful
analyses used the actual server and Stockfish. Desktop, 390px and 320px captures
were visually inspected, including scrolled explanations. Evidence is saved in
`artifacts/match-review-*.png`. Existing browser and screenshot suites also passed.

An initial review assertion incorrectly assumed that every nonterminal search
returns the complete requested preview length. Native execution returned a
shorter legal PV. The check now enforces legal, bounded previews, and the UI
explicitly explains when the search supplies fewer turns. The horizon controls
the maximum displayed continuation; it does not fabricate missing moves.

The final combined run executed 61 tests: all new review checks passed, while
the pre-existing one-second extra-practice fixture once returned an ordinary
move instead of finding an eligible deliberate inaccuracy. The exact focused
rerun below passed (1 test, 4.283 seconds):

```sh
PYTHONPATH=tests .venv/bin/python -m unittest test_solver.SolverAPITest.test_extra_practice_opportunity_real_engine_and_committed_budget -v
```

This fixture is sensitive to the timed engine search; the production feature
intentionally skips unsuitable opportunities. No practice-selection behavior was
changed for the reviewer. Earlier existing-suite execution also passed all 47
tests, and the separate post-match suite passed before the combined run.

## Selected-strength suggestions (2026-09-29)

Executed with native Stockfish and headless Chrome on macOS:

```sh
node scripts/browser_smoke.mjs http://127.0.0.1:8881
node scripts/screenshot_smoke.mjs http://127.0.0.1:8881
```

Both passed. The browser suite verified White-side suggestions at 70%, Black-side
suggestions at 90% with forgiving mode after reload, and imported White-side
suggestions at 70% with forgiving mode. Requests retained the selected settings,
results displayed `ENGINE MOVE`, and previews preserved the board and saved game.
Own-side suggestions did not request the opponent's extra-inaccuracy budget.
Missing and invalid saved strength defaulted to 70%; selecting 100% explicitly
still produced the full-strength label and completed the forced-mate regression.
The existing playing, notes, cancellation, persistence, budget and layout checks
also passed. Screenshot checks executed the real recognition model and legal
Stockfish replies. Desktop and narrow-mobile new-game captures were visually
inspected. JavaScript syntax and `git diff --check` passed.

This supersedes the earlier full-strength own-side behavior recorded below.
Reduced strength can still select the best move in individual positions; these
checks verify settings and behavior, not a measured accuracy percentage.

## Engine provenance

Downloaded `stockfish-macos-universal.tar.gz` from the official `sf_19` GitHub release. Verified SHA-256:

```text
a1f0e3bcc5a6927a11fe6fc8e54a779754645f3c2bae2cf13420fd1957adaa77
```

The engine identified itself at runtime as **Stockfish 19**. A one-second search after `1. e4`, with 8 threads, 256 MB hash, and MultiPV 1 returned legal reply `e7e5` (`e5`), depth 24, and 6,866,716 searched nodes. These are observations from one run, not repeatable strength benchmarks; multithreaded searches can vary.

## API integration

Executed:

```sh
env PYTHONPYCACHEPREFIX=/private/tmp/knightfall-pycache .venv/bin/python -m unittest discover -s tests -v
```

**27 tests passed in 21.686 seconds**, executing the real engine and an actual temporary HTTP server. Covered legal SAN/UCI moves, illegal-move handling, castling, en passant, underpromotion, FEN/PGN round trips, checkmate, stalemate, threefold claims, automatic fivefold draws, forced mates for both colors, evaluation orientation, MultiPV legal continuations, cancellation, and recovery. Practice checks executed strengths 10, 70, and 90 for both colors, forgiving mode, selected-move score consistency, return to full-strength forced mates, rejection of malformed practice settings, and cancellation/recovery after a weakened search. Screenshot-related checks covered the local WebAssembly CSP and explicit imported turn/counters/rights, including rejection of invalid positions. Localhost binding required execution outside the filesystem sandbox.

Move-review tests verified actual-move evaluation even outside the initial candidates, legal played/alternative continuations, factual notes for both colors, castling/en passant/promotion/checkmate, empty histories, strength validation, and a pinned knight whose geometric attack is not a legal capture. Concurrent requests verified that coaching does not interrupt playing analysis, the two stop endpoints do not cross-cancel, newer reviews supersede older reviews, and an already-cancelled request arriving late cannot cancel a newer review.

## Additional practice inaccuracies

The latest run, `.venv/bin/python -m unittest discover -s tests -v`, passed
**45 tests in 25.732 seconds**. This includes all prior API checks, 16 deterministic
selection/budget tests, and two additional API test methods. Localhost binding
required execution outside the sandbox.

Real Stockfish searches selected a bounded deliberate alternative in a fixed
position and its color-mirrored counterpart. Returned move, SAN, principal
variation, evaluation and proposed event agreed; preview left the used count at
zero. Applying the move and supplying its committed event exhausted a one-event
allowance, while a subsequent 70% request retained Skill Level 13. Malformed
plans returned HTTP 400, and a pre-cancelled request proposed no event.

Deterministic tests executed both score perspectives, inclusive 50/150 cp bounds,
minimum depth, uncertain/bound scores, unreliable top candidates, already-weak
baseline choices, legal immediate-mate protection, mate-score exclusion, stable
selection, initial eligibility, spacing, committed-history validation and budget
exhaustion. These tests establish the local selection rule, not a guarantee that
every game receives one or two opportunities or any external accuracy label.

`node scripts/browser_smoke.mjs http://127.0.0.1:8880` passed the existing browser
regressions and new budget-lifecycle cases. Deterministic analysis responses were
used only for the new counter cases; position and move validation remained real.
The checks covered preview without consumption, failed move/retry, one-time
commit, reload, malformed saved-event rejection, side changes, undo, user-side
exclusion, cancellation, same-root PGN import reset, screenshot cancellation,
new-game reset and accurate labels for deliberate moves at 100% strength.
Reload checks wait for the new document's board and connection initialization.
Desktop and mobile new-game screenshots were visually inspected.

`node scripts/screenshot_smoke.mjs http://127.0.0.1:8880` also passed with the
real local recognition model and real Stockfish replies. A confirmed screenshot
import preserved target 2 and created an empty allowance at startPly 0. The new
select fit the desktop, 390px and 320px review layouts. Existing recognition,
correction, cancellation, queue and import regression checks remained passing.

## Practice-strength comparison

Executed on 2026-09-27:

```sh
.venv/bin/python scripts/verify_strength.py
```

Completed 90 production `StockfishService.analyze` searches: six fixed opening positions, five profiles, three repetitions per profile/position. Every search used one second, one CPU thread, and 16 MB hash; hash was cleared and profile order rotated. All selected moves were legal. UCI protocol configuration confirmed the requested skill levels and disabled `UCI_LimitStrength` on all 90 searches. This used separate engine processes without interrupting the running app.

A separate unrestricted Stockfish process assessed the distinct selected moves in each position with a common MultiPV search and a one-million-node budget. The metric below is the average score shortfall from the best observed candidate under that judge, measured in centipawns from the side-to-move perspective. It is not an accuracy percentage, calibrated rating, or comparison against the objectively best legal move.

| Setting | Actual skill level | Samples | Mean shortfall (cp; lower is better) |
| --- | --- | --- | --- |
| 100% | 20 | 18 | 0.67 |
| 90% | 17 | 18 | 1.61 |
| 70% | 13 | 18 | 5.56 |
| 10% | 0 | 18 | 8.28 |
| 70% forgiving | 4 | 18 | 12.39 |

This run demonstrated weaker average move selection at reduced settings. The differences were small, and settings did not rank in order in every individual position. Eighteen moves per profile across only six opening positions is a limited, correlated sample; it does not establish statistical significance, whole-game strength, win rate, or any precise mapping from percentages to accuracy. Stockfish's weakening is randomized, so later runs may differ.

Raw FENs, selected moves, judge evaluations, node counts, UCI option commands/configuration, environment, and engine checksum are recorded in `artifacts/strength-check.json`. The script permits rerunning the same experiment. At the time of this run, the app applied practice strength only on the engine's turn; the 2026-09-29 update above extends the selected strength to suggestions for either side.

## Browser integration

Executed against the running local app:

```sh
node scripts/browser_smoke.mjs http://127.0.0.1:8879
```

**Passed**: first-launch and new-game prompt, cancellation without changing the current game/settings, 70% automatic Black reply, 90% forgiving automatic White opening, persisted practice settings, 100% selection, full-strength human-side analysis, invalid saved-setting normalization, board clicks and legal move targets, undo pair, flip, search cancellation/restart, new-game stale-result prevention, FEN/PGN import, underpromotion dialog, forced mate, reload persistence, and mobile layout. Written-note checks covered automatic review, selected strength/forgiving payloads, previous/next navigation, paused review, cached notes, and historical review without changing the saved position or board. Held late responses were released after undo and a new game to confirm obsolete notes stayed hidden. The panel contains no second board. No unexpected runtime or CSP errors were observed. The latest browser run used an isolated server on port 8879 without interrupting the existing servers.

Desktop checks: 1440×900, 1280×800, and 1920×1080, with the existing board/tools left of the written-review panel and no horizontal overflow. At 1440×900 the board and move-entry form fit inside the viewport. Mobile checks: 390×844 and 320×568, with no horizontal overflow; the new-game dialog and its start button fit both mobile viewports. Screenshots saved to `artifacts/desktop.png`, `artifacts/desktop-1280.png`, `artifacts/desktop-1920.png`, `artifacts/mobile.png`, `artifacts/new-game-desktop.png`, `artifacts/new-game-mobile.png`, and `artifacts/new-game-narrow.png`. All three desktop workspace screenshots and the mobile workspace screenshot were visually inspected.

## Screenshot recognition

Executed with the actual self-hosted Fenshot 0.1.4 model and ONNX Runtime Web 1.26.0 in headless Chrome:

```sh
node scripts/screenshot_smoke.mjs http://127.0.0.1:8879
```

**Passed**. Three screenshots were captured from the running app: a full game page with surrounding controls, a cropped middlegame with captures, and a Black-bottom sparse endgame. All **192 square comparisons** matched their known piece placements before manual correction. These are three images of two positions using the app's native Cburnett pieces, not a representative accuracy benchmark for other websites or themes.

The same run verified required turn/player-side choices, orientation correction, no inferred castling rights, square corrections, invalid-position rollback, confirmation, atomic settings/history replacement, and actual legal Stockfish replies after import. Real recognition results were deliberately held to test cancellation, rapid file replacement, queue serialization, and close/reopen behavior. An injected recognition failure tested the manual recovery UI separately from the real-model recognition assertions. Unreadable files were rejected without replacing the current game. Existing FEN/PGN imports still worked.

Desktop and 390px/320px mobile checks confirmed a square editor board, no horizontal dialog overflow, and reachable confirmation controls. Desktop and mobile captures were visually inspected. Network monitoring observed only local HTTP requests, with no external recognition calls or runtime/CSP errors. Fixtures, per-square comparison outcomes, confidence values, and captures are in `artifacts/screenshot-recognition-results.json`, `artifacts/screenshot-fixture-*.png`, and `artifacts/screenshot-review-*.png`.

The recognition asset build and JavaScript syntax checks passed. All seven vendored assets matched the recorded sizes and SHA-256 hashes in `web/vendor/screenshot/manifest.json`; dependency versions and npm integrity records are pinned in `package-lock.json`.

## Limits

No playing-strength matchup against Chess.com was executed. The supplied-game accuracy comparison is recorded above. Practice strength maps to Stockfish skill levels; it is not a measured accuracy score or calibrated win rate. Forgiving mode lowers strength without forcing a loss, and 100% enables unrestricted strength at the requested search time without promising perfect play. These settings do not prevent online fair-play enforcement. Cloud hosting, website automation, and chess variants are outside this implementation.

Move notes are structured board facts and brief Stockfish estimates, not a natural-language reasoning model or an account of a player's intention. Review applies the chosen practice profile but ranks candidate evaluations; it does not reproduce randomized weaker move selection. Separate engine processes avoid sharing the playing search lock but still consume resources on the same computer.

No user-supplied or Chess.com-theme screenshot has been tested yet. Image confidence is not a calibrated accuracy percentage, and every detected position requires review. A screenshot cannot restore prior move history, repetitions, exact capture history, castling rights, or reliable move counters; users must supply missing metadata. Physical-board photographs and 3D piece styles are not supported. Browser runtime verification covered Chrome on macOS, not every browser/device.
