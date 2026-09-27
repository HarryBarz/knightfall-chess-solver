# Knightfall

A local chess analysis desk powered by native **Stockfish 19**. Enter the opponent's move on the board or in notation, and the engine automatically calculates and plays its reply.

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

1. Select **Engine plays White** or **Black**. Black is the default, so you can enter White's opening move immediately.
2. Enter the opponent's move by clicking its piece and destination, or typing SAN (`Nf3`, `O-O`) or UCI (`g1f3`).
3. With **Automatic replies** enabled, the engine plays its reply on this board. Read the highlighted move and move history to see what it chose.
4. Choose a thinking time from 1 second to 2 minutes. For difficult positions, give it 30–120 seconds.

Turn automatic replies off for manual analysis of either side. **Analyze position** calculates a move, and **Play best move** applies it. **Stop analysis** cancels the search without playing a move. **Undo** takes back a completed opponent/engine pair in automatic mode, or one move in manual mode.

You can flip the board, import a FEN position or PGN game, copy the current FEN, and export PGN. Games and settings are saved in this browser's local storage. Imported PGN keeps repetition history; FEN only contains the current position and cannot recover earlier repetitions. The app supports standard chess.

## Engine strength and evaluation

Stockfish runs with `Skill Level = 20`, `UCI_LimitStrength = false`, and one candidate line by default. CPU threads and hash memory are configurable. More candidate lines share the thinking budget, so keep **1 · Strongest search** when your priority is the strongest single reply. These settings follow the [official Stockfish guidance](https://official-stockfish.github.io/docs/stockfish-wiki/Stockfish-FAQ.html#optimal-settings).

Evaluations always use **White's perspective**: positive favors White, negative favors Black. A mate score identifies which side has a forced mate. After an automatic reply, the displayed analysis describes the position immediately before that reply.

This is an interface to Stockfish, not a new engine trained from scratch. Stockfish is an exceptionally strong opponent, but no claim is made that every game will be won or that this setup outperforms every Chess.com engine configuration. Results depend on hardware, time, position, and the engine/settings used for comparison. No Chess.com benchmark has been run.

## Checks

```sh
.venv/bin/python -m unittest discover -s tests -v
node scripts/browser_smoke.mjs
```

The Python suite launches a temporary server and executes the real Stockfish engine. It covers legal moves, special moves, PGN/FEN round trips, draw history, checkmate/stalemate, both colors' mate scores, candidate lines, cancellation, and recovery. Browser checks require Node.js 22+, Google Chrome on macOS, and the app running at `http://127.0.0.1:8877`; pass a different base URL as the first argument if needed. On other platforms, set `CHROME_PATH` to Chrome's executable. See `VALIDATION.md` for the executed checks.

The application binds to your computer's loopback interface. No account, API key, subscription, or internet connection is required after setup.

## Components

- `server.py`: HTTP API, chess rules, game history, and persistent UCI engine.
- `web/`: responsive browser interface, using plain HTML, CSS, and JavaScript.
- `scripts/install_stockfish.py`: pinned engine download and checksum verification.
- `tests/test_solver.py`: executable integration tests.

See `THIRD_PARTY_NOTICES.md` for dependency and piece-art attribution.
