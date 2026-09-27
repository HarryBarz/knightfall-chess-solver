# Executed validation

Date: 2026-09-27. Environment: macOS arm64, Python 3.9, Node.js 24.16.0, native official Stockfish 19 universal release, headless Google Chrome.

## Engine provenance

Downloaded `stockfish-macos-universal.tar.gz` from the official `sf_19` GitHub release. Verified SHA-256:

```text
a1f0e3bcc5a6927a11fe6fc8e54a779754645f3c2bae2cf13420fd1957adaa77
```

The engine identified itself at runtime as **Stockfish 19**. A one-second search after `1. e4`, with 8 threads, 256 MB hash, and MultiPV 1 returned legal reply `e7e5` (`e5`), depth 24, and 6,866,716 searched nodes. These are observations from one run, not repeatable strength benchmarks; multithreaded searches can vary.

## API integration

Executed:

```sh
PYTHONPYCACHEPREFIX=/private/tmp/knightfall-pycache .venv/bin/python -m unittest discover -s tests -v
```

**13 tests passed in 7.353 seconds**, executing the real engine and an actual temporary HTTP server. Covered legal SAN/UCI moves, illegal-move handling, castling, en passant, underpromotion, FEN/PGN round trips, checkmate, stalemate, threefold claims, automatic fivefold draws, forced mates for both colors, evaluation orientation, MultiPV legal continuations, cancellation, and recovery.

## Browser integration

Executed against the running local app:

```sh
node scripts/browser_smoke.mjs
```

**Passed**: automatic Black reply, automatic White opening, board clicks and legal move targets, undo pair, flip, search cancellation/restart, new-game stale-result prevention, FEN/PGN import, underpromotion dialog, forced mate, reload persistence, and mobile layout. No unexpected runtime or CSP errors were observed.

Desktop check: 1440×900, entire board and move-entry form visible in the viewport. Mobile check: 390×844, no horizontal overflow. Screenshots saved to `artifacts/desktop.png` and `artifacts/mobile.png` and visually inspected.

## Limits

No comparison match against Chess.com was executed. The project uses full-strength Stockfish; it does not establish a new engine-strength record or guarantee a win in every position or game. Cloud hosting, website automation, and chess variants are outside this implementation.
