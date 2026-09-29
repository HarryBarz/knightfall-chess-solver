"""Accuracy-target selection changes moves, with bounded quality and real history."""

import copy
import math
import unittest

import chess
import chess.engine

from accuracy import _move_accuracy
from target_accuracy import AccuracyTarget, estimate, MAX_LOSS_CP, MIN_MOVE_ACCURACY


def position(*moves):
    board = chess.Board()
    for move in moves:
        board.push_san(move)
    return board


def info(board, san, cp=None, mate=None, **extra):
    score = chess.engine.Cp(cp) if cp is not None else chess.engine.Mate(mate)
    return {"pv": [board.parse_san(san)], "score": chess.engine.PovScore(score, board.turn), "depth": 15, **extra}


def event(ply, move, before=55, after=53):
    return {"ply": ply, "move": move, "before": before, "after": after, "accuracy": _move_accuracy(before, after)}


class AccuracyTargetTest(unittest.TestCase):
    def target(self, board, events=None, start=0):
        return AccuracyTarget.from_request({"accuracyTarget": {"enabled": True, "startPly": start, "events": events or []}}, board)

    def test_default_is_inactive_and_missing_history_is_not_a_score(self):
        board = position()
        target = AccuracyTarget.from_request({}, board)
        self.assertFalse(target.enabled)
        self.assertEqual(target.choose(board, [], None), (None, target.payload()))
        self.assertIsNone(target.payload()["estimatedAccuracy"])

    def test_selects_actual_weaker_move_toward_band_for_both_colors(self):
        for board, strongest, moderate, poor in [(position(), "e4", "d3", "a3"), (position("e4"), "e5", "d6", "a6")]:
            with self.subTest(color=board.turn):
                lines = [info(board, strongest, 40), info(board, moderate, 5), info(board, poor, -160)]
                snapshot = copy.deepcopy(lines)
                chosen, result = self.target(board).choose(board, lines, lines[0]["pv"][0])
                self.assertEqual(chosen["pv"][0], board.parse_san(moderate))
                self.assertEqual(result["event"]["move"], chosen["pv"][0].uci())
                self.assertGreaterEqual(result["estimatedAccuracy"], 85)
                self.assertLessEqual(result["estimatedAccuracy"], 90)
                self.assertEqual(lines, snapshot)

    def test_validation_requires_real_committed_moves_of_current_side(self):
        board = position("e4", "e5")
        valid = event(0, "e2e4")
        self.assertEqual(self.target(board, [valid]).events[0], valid)
        for invalid in [event(1, "e7e5"), event(0, "d2d4"), {**valid, "ply": True},
                        {**valid, "ply": 2}, {**valid, "before": math.nan}, {**valid, "after": True},
                        {**valid, "after": 56}, {**valid, "accuracy": 99}, {**valid, "before": 101}]:
            with self.subTest(event=invalid), self.assertRaises(ValueError):
                self.target(board, [invalid])
        with self.assertRaises(ValueError):
            self.target(board, [valid, valid])
        with self.assertRaises(ValueError):
            self.target(board, [valid], start=1)
        for value in [None, [], "yes", {"enabled": 1}, {"enabled": True, "startPly": True}, {"events": {}}]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                AccuracyTarget.from_request({"accuracyTarget": value}, board)

    def test_imported_black_start_and_color_mirroring(self):
        board = chess.Board(chess.STARTING_FEN.replace(" w ", " b "))
        board.push_san("e5")
        board.push_san("e4")
        record = event(0, "e7e5")
        self.assertEqual(self.target(board, [record]).color, chess.BLACK)
        self.assertAlmostEqual(estimate([record], 0, chess.WHITE), estimate([record], 0, chess.BLACK))

    def test_forecast_uses_actual_accuracy_and_does_not_clip_to_target(self):
        self.assertIsNone(estimate([], 0, chess.WHITE))
        self.assertEqual(estimate([event(0, "e2e4", 50, 50)], 0, chess.WHITE), 100)
        weak = event(0, "e2e4", 80, 50)
        self.assertLess(estimate([weak], 0, chess.WHITE), 40)
        self.assertAlmostEqual(estimate([weak], 0, chess.WHITE), weak["accuracy"])

    def test_force_and_mates_keep_winning_or_only_move(self):
        mate = chess.Board("7k/5Q2/6K1/8/8/8/8/8 w - - 0 1")
        lines = [info(mate, "Qg7#", mate=1), info(mate, "Qe7", 900)]
        chosen, result = self.target(mate).choose(mate, lines, lines[0]["pv"][0])
        self.assertEqual(chosen["pv"][0], mate.parse_san("Qg7#"))
        self.assertEqual(result["event"]["accuracy"], 100)
        self.assertEqual(result["reason"], "immediate-mate")
        board = position()
        lines = [info(board, "e4", mate=3), info(board, "d4", 400)]
        chosen, result = self.target(board).choose(board, lines, lines[0]["pv"][0])
        self.assertIs(chosen, lines[0])
        self.assertEqual(result["reason"], "mate-line")
        forced = chess.Board("8/8/8/8/8/8/2k5/Kr6 w - - 0 1")
        move = next(iter(forced.legal_moves))
        lines = [info(forced, forced.san(move), -500)]
        chosen, result = self.target(forced).choose(forced, lines, move)
        self.assertEqual(chosen["pv"][0], move)
        self.assertEqual(result["reason"], "forced-move")

    def test_saturated_wins_do_not_require_pointless_giveaways(self):
        board = position()
        lines = [info(board, "e4", 1500), info(board, "d4", 1350), info(board, "h3", 900)]
        chosen, result = self.target(board).choose(board, lines, lines[0]["pv"][0])
        self.assertIs(chosen, lines[0])
        self.assertEqual(result["reason"], "no-suitable-alternative")
        self.assertEqual(result["estimatedAccuracy"], 100)

    def test_long_perfect_prefix_cannot_demand_large_error_or_allow_mate(self):
        board = position("e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5")
        history = [event(0, "e2e4", 50, 50), event(2, "g1f3", 50, 50), event(4, "f1c4", 50, 50)]
        lines = [info(board, "d3", 50), info(board, "a3", 0), info(board, "b3", -151), info(board, "h3", mate=-2)]
        chosen, result = self.target(board, history).choose(board, lines, lines[0]["pv"][0])
        self.assertIn(chosen, lines[:2])
        self.assertGreaterEqual(result["event"]["accuracy"], MIN_MOVE_ACCURACY)
        self.assertLessEqual(50 - chosen["score"].pov(board.turn).score(), MAX_LOSS_CP)
        self.assertEqual(len(history), 3, "Selection never commits its own proposal")

    def test_unreliable_reference_cannot_fabricate_event_or_deliberate_error(self):
        board = position()
        for extras in [{"lowerbound": True}, {"upperbound": True}, {"depth": 7}]:
            lines = [info(board, "e4", 40, **extras), info(board, "d3", 5)]
            chosen, result = self.target(board).choose(board, lines, lines[0]["pv"][0])
            self.assertIsNone(chosen)
            self.assertIsNone(result["event"])
        lines = [info(board, "e4", 20), info(board, "d3", 30)]
        chosen, result = self.target(board).choose(board, lines, lines[0]["pv"][0])
        self.assertIsNone(chosen)
        self.assertEqual(result["reason"], "inconsistent-analysis")


if __name__ == "__main__":
    unittest.main()
