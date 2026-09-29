# Knightfall

A local chess practice and analysis desk powered by native **Stockfish 19**. Play against an adjustable opponent on the board or in notation, and the engine automatically calculates and plays its reply.

## Run

Requires **Python 3.9+** on **macOS**, **Linux x86_64**, or **Linux arm64**. From a fresh checkout:

```sh
git clone https://github.com/HarryBarz/knightfall-chess-solver.git
cd knightfall-chess-solver
./setup.sh
./start.command
```

Open **http://127.0.0.1:8877**. You can also double-click `start.command` in Finder. Keep its terminal open while using the app; press Control-C to stop. If the port is occupied, run `./start.command --port 8878` and open that port instead.

Setup creates a local Python environment, downloads the pinned official Stockfish 19 release, and checks its SHA-256 before installation. The environment and downloaded engine are excluded from Git. Downloaded source and license files are kept alongside the engine in `engines/stockfish-19`. After setup, use `./start.command` to start the app again. To use another Stockfish installation, set `STOCKFISH_PATH` to its executable before starting the server.

## Play

1. On first launch and each **New game**, choose your side and **Engine strength** from 10% to 100%. The initial default is 70%; later games remember your choice. Missing or invalid saved strength also defaults to 70%. This setting controls both the opponent and suggestions for your moves. Choose **Forgiving mode** to further lower strength for both sides, then **Start game**. Cancelling keeps your current board and settings.
2. Enter your move by clicking its piece and destination, or typing SAN (`Nf3`, `O-O`) or UCI (`g1f3`).
3. With **Automatic replies** enabled, the engine plays its reply on this board at the selected strength. If you choose Black, the engine makes White's opening move.
4. Choose a thinking time from 1 second to 2 minutes. For difficult positions, give it 30–120 seconds.

Turn automatic replies off for manual analysis of either side. **Analyze position** calculates a move using your selected strength and forgiving setting for either side. Your-side suggestions do not automatically switch to full strength. **Play engine move** (or **Play best move** at full strength) applies it. **Stop analysis** cancels the search without playing a move. **Undo** takes back a completed player/engine pair in automatic mode, or one move in manual mode.

You can flip the board, import a FEN position or PGN game, copy the current FEN, and export PGN. Games and settings are saved in this browser's local storage. Imported PGN keeps repetition history; FEN only contains the current position and cannot recover earlier repetitions. The app supports standard chess.

## Screenshot import

Choose **Import**, then **Import screenshot**, to continue a local practice game from an image of an existing position. Recognition runs in your browser with a self-hosted model; the image is not uploaded to the chess server or an external service. Only the confirmed position is sent to the local chess API.

Use a clear PNG, JPEG, or WebP screenshot containing the entire flat, two-dimensional board (up to 10 MB, 16 megapixels, and 8192 pixels per side). Recognition is not guaranteed across every piece theme, overlay, crop, or image quality. Physical boards and 3D pieces are not supported. Review all 64 squares and correct any misplaced or missing pieces before continuing, even when the model reports high confidence. A valid image that cannot be recognized can still be used as a reference for manual setup.

Confirm the screenshot's orientation, whose turn it is, and which side you want to play. These are separate choices: a screenshot with Black at the bottom does not establish that Black is to move. Choose the practice strength, then continue against Stockfish from the confirmed position. Cancelling the draft does not replace your board or settings.

A screenshot cannot recover earlier moves, repetitions, exact capture history, or castling rights. Castling starts disabled unless you explicitly enable the remaining rights; home-square king and rook placement alone does not prove those rights exist. En passant and move counters can be entered separately. The default counters start a new continuation from the imported position, not a reconstruction of the original game's history. Captured-piece displays are not required: the pieces still on the board determine the position.

Screenshot import is for permitted local practice and game review, not covert assistance in live online games. Lower engine strength does not bypass another site's fair-play rules.

## Move notes

On a wide screen, the board and existing controls sit on the left, with written **Move notes** on the right. Smaller screens stack these areas. There is no second board.

Notes review completed moves: checks, captures, development, central squares, opened bishop diagonals, and attacks on opposing pieces. They compare the actual move with up to three legal alternatives, including short continuations and scores from White's perspective. These are board facts and brief engine estimates, not claims about a player's intention or proof that an apparent attack wins material.

**Live notes** follows each new move. Use the move selector or arrows to review an earlier move, or refresh to search again. Turning Live notes off pauses automatic review. Reviewing history never changes the playing board, and obsolete responses are discarded after undo, import, or a new game.

Review uses a separate Stockfish process with one thread, 32 MB hash, and a short search budget, leaving the playing engine's search lock and settings untouched. It uses the selected practice strength and forgiving setting, but a brief review may rank moves differently from a longer playing search. It does not reproduce the engine's randomized lower-strength decision. The percentage remains a difficulty setting, not measured accuracy.

## After-match lessons

Every finished game shows **Review this match**. **Review match** also opens the
recorded moves of a game in progress. Starting a new game or importing a position
retains the previous game under **Review last match**; only the latest match is
kept, in this browser. Export PGN if you want a permanent collection.

The review opens its own replay board at the starting position. Move forward or
back one turn, jump to the start or finish, select a move from the game, or use
play/pause and a playback speed. Playback waits for the explanation before moving
on. Reviewing and exploring variations never plays moves on your game board.

For each move, the lesson identifies **You** or **Solver**, describes its visible
effects and likely purpose, evaluates it, and explains a stronger alternative
when the search finds one. Both players' moves receive the same scrutiny; the
practice engine can make mistakes too. Lessons default to **full-strength
Stockfish**, independently of your in-game difficulty and forgiving settings.

Choose **2, 3, 4, 6, or 8 turns ahead** to explore the continuation. One turn is
one player's move, so four turns means two moves by each side. These are the
future moves shown after the selected move, not a claim that a player intended
exactly that many steps or that Stockfish searched only that far. Select a line
step to preview its position, then return to the played board. The projected
continuation, suggested correction, and moves actually played are presented
separately. A short line may end early at a terminal position or when the bounded
search supplies fewer moves; the review explicitly identifies a shorter preview.

Explanations use chess rules and engine variations rather than a remote language
model. They describe plausible plans, not access to either player's thoughts.
Evaluations are bounded-search estimates from White's perspective, and the
assessment accounts for which side moved. A screenshot/FEN import can only be
reviewed from the imported position onward; earlier moves cannot be reconstructed.

## After-match accuracy reports

Each finished match automatically receives an **Accuracy estimate** for White
and Black, with You/Solver labels, category totals, and a move-by-move breakdown.
Opening **Review match** or **Review last match** also scores the recorded game;
select a report move to jump to its lesson. In-progress games can be scored from
the reviewer. Imported FENs and screenshots only include moves recorded after
the import.

Reports always use a separate full-strength Stockfish search, regardless of the
playing difficulty or lesson teacher setting. Progress is shown while moves are
scored. Partial results are marked provisional, unavailable moves are not counted
as perfect, and failed work can be retried. Recent reports are saved in this
browser and can resume without replaying the game.

The categories use [Chess.com's published expected-points-loss thresholds](https://support.chess.com/en/articles/8572705-how-are-moves-classified-what-is-a-blunder-or-brilliant-etc):

| Category | Expected points lost |
| --- | --- |
| Best | 0 |
| Excellent | Greater than 0 and less than 0.02 |
| Good | 0.02 to less than 0.05 |
| Inaccuracy | 0.05 to less than 0.10 |
| Mistake | 0.10 to less than 0.20 |
| Blunder | 0.20 to 1.00 |

At a shared boundary, this implementation assigns the category that begins at
that threshold. For example, exactly 0.10 is a Mistake. Classification uses the
unrounded loss. These are fractions of an expected game point, not pawn values:
0.10 is ten percentage points of expected score.

**The score is a local estimate, not Chess.com's CAPS2.** Chess.com's published
model accounts for player rating; this app uses [Stockfish's native self-play
win/draw/loss model](https://official-stockfish.github.io/docs/stockfish-wiki/Useful-data.html).
Expected points are `(wins + draws / 2) / 1000`, from the mover's perspective.
The loss is the nonnegative difference between the strongest searched choice
and the played move, evaluated from the same position with its full history.
Immediate terminal outcomes use the chess rules. Bounded engine scores and
missing WDL results are excluded.

Method `knightfall-ep-v1` converts each loss `L` to a local 0–100 estimate with
`100 * (exp(-4 * L) - exp(-4)) / (1 - exp(-4))`, clamped to 0–100. Each side's
score is the arithmetic mean of its scored moves. This transparent curve is our
own mapping, not the unpublished CAPS2 calculation. Longer searches can change
scores and labels; matching thresholds does not guarantee matching Chess.com
results. Brilliant, Great, Book, and Miss require additional rules and are not
inferred from these six thresholds.

## Analysis arrows

Turn on **Analysis arrows** beneath the playing or review board, then choose
**White**, **Black**, or both. The master switch starts off; your switch choices
and lookahead setting are remembered in this browser. Arrows update as either
side moves and follow the replay position during a match review.

Gold arrows belong to White and blue arrows to Black. **Attacks & coordination**
shows one selected idea for each enabled side. Select another idea to explore
fork patterns, combined pressure, support, opened lines, or central control.
Solid arrows describe the current board; support arrows start with a ring.
These patterns do not by themselves prove that a capture is legal or wins
material: checks, pins, defenders and the opponent's replies still matter.

**Possible line** shows a legal Stockfish continuation up to **2, 3, 4, or 6
turns**. Each turn is one player's move. Select a turn to draw the sequence
through that point. Dashed arrows and numbered badges distinguish projected
moves from current attacks; a future arrow may begin on a currently empty
square. Hiding one side's arrows keeps its replies in the written sequence so
the plan remains understandable. Recognized gambit openings require recorded
move history; a projected material offer is described as a possibility, not
proof of sound compensation or the player's intention.

Playing-board lines use your chosen practice difficulty. Review-board lines use
the review's teacher profile, which defaults to full strength. Analysis runs in
its own bounded Stockfish process and never plays moves or spends practice
opportunities. Turning the feature off cancels its work; no arrow searches run
while it is off or both side switches are off. A short search can return fewer
turns than requested. The app explains observable patterns and conditional
lines; it cannot know what either player was thinking.

## Engine strength and evaluation

The percentage controls **difficulty**, not measured move accuracy, an Elo rating, win probability, or a promised result. A 70% opponent can win and a 90% opponent can lose. Even 100% means unrestricted search at the chosen thinking time, not perfect play. These settings are for local practice and do not make engine assistance permissible in online games or prevent fair-play enforcement.

Strength maps to Stockfish's built-in `Skill Level` using `floor((strength - 10) * 20 / 90)`: 10% selects level 0, 70% level 13, 80% level 15, 90% level 17, and 100% level 20. **Forgiving mode** caps that level at 4 for both automatic replies and move suggestions; it does not force a loss. Selecting 100% turns forgiving mode off, and enabling forgiving mode at 100% changes the setting to 90%. Stockfish can remain challenging even at low levels and can still choose the best move in individual positions.

**Extra practice inaccuracies** is optional in new-game and screenshot setup: Off, 1 target, or 2 target. It keeps the chosen strength and forgiving setting and aims to add up to that many deliberate inaccuracies for local practice. These are additional opportunities, not a cap on all mistakes: reduced-strength play can make other errors. Short games or positions without suitable choices can finish below the target. It does not simulate a human rating or establish a fair-play outcome.

An eligible extra move must lose an estimated 50-150 centipawns (0.5-1.5 pawns) relative to the top searched candidate and at least 50 centipawns relative to the ordinary choice. This is this app's definition, not a Chess.com classification. The ordinary choice must be within 25 centipawns of the top candidate, so the feature does not replace an already weak choice with a stronger move. Search depth must be at least 10 with an unbounded numeric score. Mate-scored positions and positions with immediate checkmate available are excluded from deliberate changes; the normal reduced-strength opponent can still miss tactics.

The first opportunity is eligible after six new plies, with at least twelve plies between committed opportunities. Unsuitable positions are skipped and retried later. The counter advances only when the proposed move is successfully played; previewing, stopping or failed moves do not spend it. Undo removes events from the undone branch, reload preserves them, and new games and successful imports start a fresh allowance. Imported PGN starts counting from the imported endpoint. Your-side analysis and the independent written reviews do not add or consume opportunities.

Each search resets its strength options with `UCI_LimitStrength = false`. Searches below full strength use at least four internal candidate lines for Stockfish's weaker move selection; an eligible extra-inaccuracy search uses eight. Otherwise full-strength searches use your selected number of candidate lines. The displayed candidates honor your 1-3 line setting, and the chosen move's evaluation and variation are displayed together. CPU threads and hash memory remain configurable. More candidate lines share the thinking budget and can change Stockfish's ordinary choice, so leave extras Off and keep **1 · Strongest search** when your priority is the strongest single reply. See the [official Stockfish guidance](https://official-stockfish.github.io/docs/stockfish-wiki/Stockfish-FAQ.html#optimal-settings).

Evaluations always use **White's perspective**: positive favors White, negative favors Black. A mate score identifies which side has a forced mate. After an automatic reply, the displayed analysis describes the position immediately before that reply.

This is an interface to Stockfish, not a new engine trained from scratch. Stockfish is an exceptionally strong opponent, but no claim is made that every game will be won or that this setup outperforms every Chess.com engine configuration. Results depend on hardware, time, position, and the engine/settings used for comparison. No Chess.com benchmark has been run.

## Checks

```sh
.venv/bin/python -m unittest discover -s tests -v
node scripts/browser_smoke.mjs
node scripts/screenshot_smoke.mjs
node scripts/review_smoke.mjs
node scripts/arrows_smoke.mjs
node scripts/accuracy_smoke.mjs
```

The Python suite launches a temporary server and executes the real Stockfish engine. It covers legal moves, special moves, PGN/FEN round trips, draw history, checkmate/stalemate, both colors' mate scores, candidate lines, practice strength, forgiving mode, cancellation, recovery, and independent move reviews. Extra-inaccuracy checks cover candidate bounds, mate protection, budget/history validation and real-engine selection for both colors. Browser checks cover playing, written reviews, stale responses, extra-inaccuracy counter persistence and responsive layout. They require Node.js 22+, Google Chrome on macOS, and the app running at `http://127.0.0.1:8877`; pass a different base URL as the first argument if needed. On other platforms, set `CHROME_PATH` to Chrome's executable. See `VALIDATION.md` for the executed checks.

The application binds to your computer's loopback interface. No account, API key, subscription, or internet connection is required after setup.

## Rebuild image recognition

The recognition bundle, model, and WebAssembly runtime are included under `web/vendor/screenshot/`; ordinary use does not require Node or npm. The first screenshot scan lazily loads about 14.4 MB of local assets. To rebuild them with Node.js 22+:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build:recognizer
```

Package versions are pinned in `package-lock.json`. The build preserves the accompanying licenses and writes an asset-size and SHA-256 manifest. Keep the vendor directory when copying the app to another machine.

## Components

- `server.py`: HTTP API, chess rules, game history, and persistent UCI engine.
- `coach.py`: independent, bounded Stockfish reviews and board-grounded move notes.
- `match_review.py`: independent post-match lessons, legal continuation steps, and corrections.
- `arrows.py`: current-board patterns and independent, legal projected lines for both sides.
- `accuracy.py`: full-strength WDL grading using the published expected-points categories and a documented local accuracy estimate.
- `web/accuracy.js`, `web/accuracy.css`: automatic match reports, move breakdowns, progress, and cached results.
- `web/arrows.js`, `web/arrows.css`: optional White/Black learning arrows on playing and replay boards.
- `web/review.js`, `web/review.css`: replay board, lesson navigation, and variation previews.
- `practice.py`: validated per-game opportunity budget and bounded extra-inaccuracy selection.
- `web/`: responsive browser interface, using plain HTML, CSS, and JavaScript.
- `web/vendor/screenshot/`: self-hosted recognition model, WebAssembly runtime, and licenses, loaded only for screenshot import.
- `scripts/build_screenshot_recognizer.mjs`: reproducible browser recognition bundle (Node/npm needed only to rebuild these assets).
- `scripts/install_stockfish.py`: pinned engine download and checksum verification.
- `tests/test_solver.py`: executable integration tests.

See `THIRD_PARTY_NOTICES.md` for dependency and piece-art attribution.
