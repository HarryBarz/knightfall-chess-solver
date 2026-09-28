#!/usr/bin/env python3
"""Compare the production practice settings using a separate full-strength judge."""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import logging
from pathlib import Path
import platform
import statistics
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import chess
import chess.engine
from server import StockfishService


POSITIONS = [
    ("Initial position", ""),
    ("After e4", "e4"),
    ("Italian opening", "e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6"),
    ("Sicilian opening", "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6"),
    ("Queen's gambit", "d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 Nbd7"),
    ("Ruy Lopez, Black to move", "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1"),
]
PROFILES = [("100%", 100, False), ("90%", 90, False), ("70%", 70, False),
            ("10%", 10, False), ("70% forgiving", 70, True)]


class OptionLog(logging.Handler):
    def __init__(self):
        super().__init__()
        self.commands = []

    def emit(self, record):
        message = record.getMessage()
        if "setoption name Skill Level" in message or "setoption name UCI_LimitStrength" in message:
            self.commands.append(message)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--seconds", type=int, default=1)
    parser.add_argument("--judge-nodes", type=int, default=1_000_000)
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/strength-check.json")
    args = parser.parse_args()
    if args.repeats < 1 or not 1 <= args.seconds <= 120 or args.judge_nodes < 1:
        parser.error("Choose positive repeats/judge-nodes and seconds in 1..120.")

    service = StockfishService()
    path = service.engine_path()
    if not path:
        parser.error("Install Stockfish before running this comparison.")
    log = OptionLog()
    logger = logging.getLogger("chess.engine")
    logger.setLevel(logging.DEBUG)
    logger.addHandler(log)
    report = {
        "timestampUtc": datetime.now(timezone.utc).isoformat(),
        "environment": {"platform": platform.platform(), "python": platform.python_version(),
                        "chess": chess.__version__, "enginePath": path,
                        "engineSha256": hashlib.sha256(Path(path).read_bytes()).hexdigest()},
        "settings": {"repeats": args.repeats, "seconds": args.seconds, "threads": 1,
                     "hashMb": 16, "judgeNodes": args.judge_nodes},
        "method": "Production StockfishService.analyze; hash cleared per search; profiles rotated per repeat. "
                  "A separate skill-20 engine ranks every distinct selected move in a common MultiPV "
                  "search with a fixed total node budget. Gaps are relative to the highest-scoring "
                  "observed candidate, from the side-to-move perspective. Mate scores map to +/-100000. "
                  "This small stochastic sample does not calibrate accuracy, Elo, or win rate.",
        "positions": [],
    }
    judge = None
    try:
        worker = service._get_engine()
        judge = chess.engine.SimpleEngine.popen_uci(path)
        judge.configure({"Threads": 1, "Hash": 16, "Skill Level": 20, "UCI_LimitStrength": False})
        report["environment"]["engine"] = worker.id
        for position_index, (name, san) in enumerate(POSITIONS):
            board = chess.Board()
            for move in san.split():
                board.push_san(move)
            position = {"name": name, "fen": board.fen(), "samples": []}
            for repeat in range(args.repeats):
                offset = (position_index + repeat) % len(PROFILES)
                for label, strength, forgiving in PROFILES[offset:] + PROFILES[:offset]:
                    worker.configure({"Clear Hash": None})
                    first_command = len(log.commands)
                    result = service.analyze({
                        "initialFen": board.fen(), "moves": [], "seconds": args.seconds,
                        "threads": 1, "hashMb": 16, "multiPv": 1,
                        "requestId": f"strength-check-{position_index}-{repeat}-{label}",
                        "strength": strength, "forgiving": forgiving,
                    })
                    move = chess.Move.from_uci(result["bestMove"])
                    if move not in board.legal_moves:
                        raise RuntimeError(f"Illegal production reply: {result}")
                    actual_skill = worker.protocol.config["Skill Level"]
                    actual_limit = worker.protocol.config["UCI_LimitStrength"]
                    expected_skill = (strength - 10) * 20 // 90
                    if forgiving:
                        expected_skill = min(expected_skill, 4)
                    if actual_skill != expected_skill or actual_limit is not False:
                        raise RuntimeError("Strength configuration did not reach the UCI protocol.")
                    position["samples"].append({
                        "profile": label, "repeat": repeat + 1, "move": move.uci(),
                        "san": board.san(move), "skillLevel": actual_skill,
                        "limitStrength": actual_limit, "depth": result["depth"],
                        "nodes": result["nodes"], "timeMs": result["timeMs"],
                        "uciCommands": log.commands[first_command:],
                    })
            candidates = sorted({sample["move"] for sample in position["samples"]})
            judge.configure({"Clear Hash": None})
            infos = judge.analyse(board, chess.engine.Limit(nodes=args.judge_nodes),
                                  multipv=len(candidates), root_moves=[chess.Move.from_uci(move) for move in candidates])
            scores = {}
            for info in infos:
                move = info["pv"][0].uci()
                scores[move] = {"cp": info["score"].pov(board.turn).score(mate_score=100_000),
                                "depth": info.get("depth", 0)}
            if set(scores) != set(candidates):
                raise RuntimeError("The judge did not evaluate every selected move.")
            reference = max(score["cp"] for score in scores.values())
            for sample in position["samples"]:
                sample["judgeCp"] = scores[sample["move"]]["cp"]
                sample["gapCp"] = reference - sample["judgeCp"]
            position["judge"] = {"candidates": scores, "referenceCp": reference,
                                 "actualNodes": max(info.get("nodes", 0) for info in infos)}
            report["positions"].append(position)
            gaps = {label: round(statistics.mean(s["gapCp"] for s in position["samples"] if s["profile"] == label), 1)
                    for label, _, _ in PROFILES}
            print(json.dumps({"position": name, "meanGapCp": gaps}), flush=True)
    finally:
        service.close()
        if judge is not None:
            judge.quit()
        logger.removeHandler(log)

    samples = [sample for position in report["positions"] for sample in position["samples"]]
    report["summary"] = {}
    for label, _, _ in PROFILES:
        selected = [sample for sample in samples if sample["profile"] == label]
        report["summary"][label] = {
            "samples": len(selected),
            "meanGapCp": round(statistics.mean(sample["gapCp"] for sample in selected), 2),
            "medianGapCp": statistics.median(sample["gapCp"] for sample in selected),
            "movesAtLeast20CpBelowReference": sum(sample["gapCp"] >= 20 for sample in selected),
            "skillLevels": dict(Counter(sample["skillLevel"] for sample in selected)),
        }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report["summary"], indent=2), flush=True)
    print(f"Evidence: {args.output}", flush=True)


if __name__ == "__main__":
    main()
