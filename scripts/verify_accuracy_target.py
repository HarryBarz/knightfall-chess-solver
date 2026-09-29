#!/usr/bin/env python3
"""Measure real target-mode moves with the independent production reviewer.

This is a bounded native-engine benchmark, not an Elo or accuracy guarantee.
Games reaching the ply limit remain unfinished and their scores are labelled
prefix estimates. The reported scores are computed by web/accuracy-math.js.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import chess
import chess.engine
import chess.pgn

from accuracy import AccuracyService
from server import StockfishService


def opening(san):
    board = chess.Board()
    for move in san.split():
        board.push_san(move)
    return board


def fixtures():
    mate = chess.Board("7k/5Q2/6K1/8/8/8/8/8 w - - 0 1")
    forced = chess.Board("8/8/8/8/8/8/2k5/Kr6 w - - 0 1")
    return [
        ("Initial position, White", chess.Board(), None),
        ("After e4, Black", opening("e4"), None),
        ("Italian opening, White", opening("e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6"), None),
        ("Ruy Lopez, Black", opening("e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1"), None),
        ("Queen fork opportunity, Black", opening("e4 e5 Nf3 Nc6 Bc4 Nd4 Nxe5"), None),
        ("Immediate mate, White", mate, "mate"),
        ("Immediate mate, Black", mate.mirror(), "mate"),
        ("Only legal move, White", forced, "forced"),
        ("Only legal move, Black", forced.mirror(), "forced"),
    ]


def aggregate(rows, initial_turn):
    code = (
        "const fs=require('node:fs');"
        "const math=require(process.argv[1]);"
        "const input=JSON.parse(fs.readFileSync(0,'utf8'));"
        "process.stdout.write(JSON.stringify(math.aggregateAccuracy(input.rows,input.initialTurn)));"
    )
    completed = subprocess.run(
        ["node", "-e", code, str(ROOT / "web" / "accuracy-math.js")],
        input=json.dumps({"rows": rows, "initialTurn": initial_turn}),
        text=True, capture_output=True, check=True,
    )
    return json.loads(completed.stdout)


def request(service, board, ident, seconds, start_ply, events):
    result = service.analyze({
        "initialFen": board.root().fen(), "moves": [move.uci() for move in board.move_stack],
        "requestId": ident, "seconds": seconds, "threads": 1, "hashMb": 32,
        "multiPv": 1, "strength": 67, "forgiving": False,
        "accuracyTarget": {"enabled": True, "startPly": start_ply, "events": events},
    })
    if result.get("cancelled") or not result.get("bestMove"):
        raise RuntimeError(f"No live target move returned: {result}")
    metadata = result.get("accuracyTarget")
    if not isinstance(metadata, dict) or metadata.get("enabled") is not True:
        raise RuntimeError("Production service did not enable accuracy-target mode.")
    worker = service._get_engine()
    if worker.protocol.config.get("Skill Level") != 20 or worker.protocol.config.get("UCI_LimitStrength") is not False:
        raise RuntimeError("Target candidate analysis did not run at full strength.")
    move = chess.Move.from_uci(result["bestMove"])
    if move not in board.legal_moves:
        raise RuntimeError("Target policy selected an illegal move.")
    event = metadata.get("event")
    if event is not None and (event.get("ply") != len(board.move_stack) or event.get("move") != move.uci()):
        raise RuntimeError("Proposed policy event does not match the committed move.")
    return move, result


def save(path, report):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(report, indent=2) + "\n")
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=int, default=1)
    parser.add_argument("--games", type=int, choices=(0, 1, 2), default=2)
    parser.add_argument("--max-plies", type=int, default=40)
    parser.add_argument("--opponent-seconds", type=float, default=.08)
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts" / "accuracy-target-check.json")
    args = parser.parse_args()
    if not 1 <= args.seconds <= 120 or not 2 <= args.max_plies <= 200 or not .01 <= args.opponent_seconds <= 10:
        parser.error("Use seconds in 1..120, max-plies in 2..200, opponent-seconds in .01..10.")

    service = StockfishService()
    engine_path = service.engine_path()
    if not engine_path:
        parser.error("Install Stockfish before running the native benchmark.")
    judge = AccuracyService(engine_path)
    opponent = None
    report = {
        "timestampUtc": datetime.now(timezone.utc).isoformat(),
        "environment": {"platform": platform.platform(), "python": platform.python_version(),
                        "chess": chess.__version__, "enginePath": engine_path,
                        "engineSha256": hashlib.sha256(Path(engine_path).read_bytes()).hexdigest()},
        "settings": {"targetRange": [85, 90], "seconds": args.seconds, "threads": 1, "hashMb": 32,
                     "opponentSkill": 6, "opponentSeconds": args.opponent_seconds,
                     "maxPlies": args.max_plies, "games": args.games},
        "method": "Production StockfishService selects and commits actual legal moves. A separate "
                  "AccuracyService independently scores those moves at its normal full-strength budget. "
                  "Game scores use unmodified web/accuracy-math.js, including both sides' position "
                  "evaluations. Cutoff games are unfinished prefixes. This small sample cannot "
                  "establish a guaranteed accuracy range, Elo, or win rate.",
        "fixtures": [], "games": [],
    }
    started = time.monotonic()
    try:
        worker = service._get_engine()
        report["environment"]["engine"] = worker.id
        for index, (name, board, invariant) in enumerate(fixtures()):
            if not board.is_valid() or board.is_game_over(claim_draw=False):
                raise RuntimeError(f"Invalid benchmark fixture: {name}")
            if invariant == "forced" and board.legal_moves.count() != 1:
                raise RuntimeError(f"Fixture should have one legal move: {name}")
            before = board.fen()
            worker.configure({"Clear Hash": None})
            move, selected = request(service, board, f"target-fixture-{index}", args.seconds,
                                     len(board.move_stack), [])
            san = board.san(move)
            board.push(move)
            if invariant == "mate" and not board.is_checkmate():
                raise RuntimeError(f"Target policy bypassed an immediate mate: {name}")
            reviewed = judge.review(board, f"target-fixture-review-{index}", len(board.move_stack))
            if not reviewed.get("scored"):
                raise RuntimeError(f"Independent fixture review unavailable: {reviewed}")
            row = {"name": name, "beforeFen": before, "selectedSan": san,
                   "selection": selected, "independentReview": reviewed}
            report["fixtures"].append(row)
            save(args.output, report)
            print(json.dumps({"fixture": name, "move": san,
                              "policy": selected["accuracyTarget"],
                              "reviewAccuracy": reviewed["moveAccuracy"],
                              "classification": reviewed["classification"]}), flush=True)

        if args.games:
            opponent = chess.engine.SimpleEngine.popen_uci(engine_path)
            opponent.configure({"Threads": 1, "Hash": 32, "Skill Level": 6, "UCI_LimitStrength": False})
        for game_index in range(args.games):
            board = chess.Board()
            target_color = chess.WHITE if game_index == 0 else chess.BLACK
            color_name = "white" if target_color else "black"
            events, selections = [], []
            while not board.is_game_over(claim_draw=False) and len(board.move_stack) < args.max_plies:
                ply = len(board.move_stack)
                if board.turn == target_color:
                    move, selected = request(service, board, f"target-game-{game_index}-{ply}",
                                             args.seconds, 0, events)
                    selections.append({"ply": ply, "selection": selected})
                    event = selected["accuracyTarget"].get("event")
                    if event is not None:
                        events.append(event)
                else:
                    move = opponent.play(board, chess.engine.Limit(time=args.opponent_seconds)).move
                    if move not in board.legal_moves:
                        raise RuntimeError("Benchmark opponent returned an illegal move.")
                board.push(move)
                print(json.dumps({"game": game_index + 1, "targetColor": color_name,
                                  "ply": len(board.move_stack), "move": move.uci()}), flush=True)
            outcome = board.outcome(claim_draw=False)
            game = {"targetColor": color_name, "complete": outcome is not None,
                    "result": outcome.result() if outcome else "*", "plies": len(board.move_stack),
                    "scoreScope": "complete game" if outcome else "unfinished game prefix",
                    "pgn": str(chess.pgn.Game.from_board(board)), "events": events,
                    "selections": selections, "reviewRows": []}
            report["games"].append(game)
            save(args.output, report)
            for ply in range(1, len(board.move_stack) + 1):
                row = judge.review(board, f"target-game-review-{game_index}-{ply}", ply)
                if not row.get("scored"):
                    raise RuntimeError(f"Independent game review unavailable at ply {ply}: {row}")
                game["reviewRows"].append(row)
                save(args.output, report)
                print(json.dumps({"gameReview": game_index + 1, "ply": ply,
                                  "moveAccuracy": row["moveAccuracy"]}), flush=True)
            game["independentReport"] = aggregate(game["reviewRows"], "white")
            game["targetSideAccuracy"] = game["independentReport"]["sides"][color_name]["score"]
            save(args.output, report)
            print(json.dumps({"game": game_index + 1, "targetColor": color_name,
                              "scoreScope": game["scoreScope"], "result": game["result"],
                              "targetSideAccuracy": game["targetSideAccuracy"]}), flush=True)
    finally:
        service.close()
        judge.close()
        if opponent is not None:
            opponent.quit()
        report["elapsedSeconds"] = round(time.monotonic() - started, 3)
        save(args.output, report)
    print(f"Evidence: {args.output}", flush=True)


if __name__ == "__main__":
    main()
