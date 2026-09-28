"""Deterministic checks for optional additional local practice opportunities."""

from __future__ import annotations

import unittest

import chess
import chess.engine

from practice import PracticePlan


def position(plies=6):
    board = chess.Board()
    moves = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "d3", "d6", "Nc3", "Nf6", "O-O", "O-O", "a3", "a6", "h3", "h6", "Re1", "Re8"]
    for move in moves[:plies]:
        board.push_san(move)
    return board


def line(board, san, cp, *, depth=14, perspective=None, **extras):
    side = board.turn if perspective is None else perspective
    return {"pv": [board.parse_san(san)], "score": chess.engine.PovScore(chess.engine.Cp(cp), side), "depth": depth, **extras}


class PracticePlanTest(unittest.TestCase):
    def plan(self, board, target=2, **extras):
        return PracticePlan.from_request({"practice": {"target": target, **extras}}, board)

    def test_defaults_are_off_and_have_no_side_effects(self):
        board = position()
        plan = PracticePlan.from_request({}, board)
        self.assertEqual(plan.target, 0)
        self.assertEqual(plan.used, 0)
        self.assertFalse(plan.eligible)
        self.assertEqual(plan.payload(), {"target": 0, "used": 0, "deliberate": False, "lossCp": None, "event": None})
        self.assertIsNone(plan.choose(board, [line(board, "d3", 40), line(board, "a3", -30)], board.parse_san("d3")))

    def test_validates_committed_history_and_budget(self):
        board = position(18)
        events = [{"ply": 6, "move": board.move_stack[6].uci(), "lossCp": 65}]
        plan = self.plan(board, events=events)
        self.assertEqual(plan.used, 1)
        self.assertTrue(plan.eligible)
        self.assertFalse(self.plan(board, target=1, events=events).eligible)
        self.assertEqual(plan.payload()["used"], 1)
        events[0]["lossCp"] = 150
        self.assertEqual(plan.events[0][2], 65)

    def test_initial_window_and_spacing_are_relative_to_import_root(self):
        self.assertFalse(self.plan(position(5)).eligible)
        self.assertTrue(self.plan(position(6)).eligible)
        self.assertFalse(self.plan(position(6), startPly=1).eligible)
        board = position(17)
        event = {"ply": 6, "move": board.move_stack[6].uci(), "lossCp": 50}
        self.assertFalse(self.plan(board, events=[event]).eligible)
        self.assertTrue(self.plan(position(18), events=[event]).eligible)

    def test_rejects_invalid_request_values(self):
        board = position()
        invalid = [
            None, True, [], 1,
            {"target": True}, {"target": -1}, {"target": 3}, {"target": 1.0}, {"target": "1"},
            {"target": 1, "startPly": True}, {"target": 1, "startPly": -1}, {"target": 1, "startPly": 7},
            {"target": 1, "startPly": 0.5}, {"target": 1, "events": {}}, {"target": 1, "events": [None]},
            {"target": 1, "events": [{"ply": 0, "move": "d2d4", "lossCp": 50}]},
            {"target": 1, "events": [{"ply": 6, "move": "d2d3", "lossCp": 50}]},
            {"target": 1, "events": [{"ply": True, "move": "e7e5", "lossCp": 50}]},
            {"target": 1, "events": [{"ply": 0, "move": "e2e4", "lossCp": True}]},
            {"target": 1, "events": [{"ply": 0, "move": "e2e4", "lossCp": 49}]},
            {"target": 1, "events": [{"ply": 0, "move": "e2e4", "lossCp": 151}]},
            {"target": 1, "startPly": 1, "events": [{"ply": 0, "move": "e2e4", "lossCp": 50}]},
            {"target": 0, "events": [{"ply": 0, "move": "e2e4", "lossCp": 50}]},
            {"target": 2, "events": [{"ply": 0, "move": "e2e4", "lossCp": 50}, {"ply": 0, "move": "e2e4", "lossCp": 50}]},
            {"target": 2, "events": [{"ply": 1, "move": "e7e5", "lossCp": 50}, {"ply": 0, "move": "e2e4", "lossCp": 50}]},
        ]
        for practice in invalid:
            with self.subTest(practice=practice), self.assertRaises(ValueError):
                PracticePlan.from_request({"practice": practice}, board)

    def test_chooses_smallest_bounded_loss_without_mutating_inputs(self):
        board = position()
        before = board.fen()
        baseline = board.parse_san("d3")
        infos = [line(board, "d3", 40), line(board, "a3", -80), line(board, "h3", -20), line(board, "O-O", 15)]
        plan = self.plan(board)
        chosen = plan.choose(board, infos, baseline)
        self.assertEqual(chosen["pv"][0], board.parse_san("h3"))
        self.assertEqual(chosen["practiceLossCp"], 60)
        self.assertNotIn("practiceLossCp", infos[2])
        self.assertEqual(board.fen(), before)
        self.assertEqual(len(board.move_stack), 6)
        self.assertEqual(plan.payload(chosen), {"target": 2, "used": 0, "deliberate": True, "lossCp": 60, "event": {"ply": 6, "move": "h2h3", "lossCp": 60}})
        self.assertEqual(plan.used, 0)
        self.assertEqual(plan.payload()["event"], None)

    def test_black_scores_use_movers_perspective(self):
        board = position(7)
        infos = [line(board, "d6", -40, perspective=chess.WHITE), line(board, "a6", 25, perspective=chess.WHITE)]
        chosen = self.plan(board).choose(board, infos, board.parse_san("d6"))
        self.assertEqual(chosen["pv"][0], board.parse_san("a6"))
        self.assertEqual(chosen["practiceLossCp"], 65)

    def test_tie_break_is_stable_by_uci(self):
        board = position()
        baseline = board.parse_san("d3")
        infos = [line(board, "d3", 40), line(board, "h3", -30), line(board, "a3", -30)]
        first = self.plan(board).choose(board, infos, baseline)
        second = self.plan(board).choose(board, [infos[0], *reversed(infos[1:])], baseline)
        self.assertEqual(first["pv"][0].uci(), "a2a3")
        self.assertEqual(first, second)

    def test_keeps_an_already_weakened_baseline(self):
        board = position()
        infos = [line(board, "d3", 40), line(board, "O-O", 14), line(board, "a3", -30)]
        self.assertIsNone(self.plan(board).choose(board, infos, board.parse_san("O-O")))

    def test_candidate_must_be_fifty_cp_worse_than_baseline_too(self):
        board = position()
        infos = [line(board, "d3", 40), line(board, "O-O", 15), line(board, "a3", -34)]
        self.assertIsNone(self.plan(board).choose(board, infos, board.parse_san("O-O")))
        infos[-1] = line(board, "a3", -35)
        chosen = self.plan(board).choose(board, infos, board.parse_san("O-O"))
        self.assertEqual(chosen["practiceLossCp"], 75)

    def test_only_bounded_losses_are_eligible(self):
        board = position()
        for cp, expected in [(-9, None), (-10, 50), (-110, 150), (-111, None)]:
            with self.subTest(cp=cp):
                infos = [line(board, "d3", 40), line(board, "a3", cp)]
                result = self.plan(board).choose(board, infos, board.parse_san("d3"))
                self.assertEqual(result["practiceLossCp"] if result else None, expected)

    def test_missing_shallow_bounded_or_illegal_lines_do_not_qualify(self):
        board = position()
        baseline = board.parse_san("d3")
        invalid_lines = [
            line(board, "a3", -30, depth=9),
            line(board, "a3", -30, depth=True),
            line(board, "a3", -30, lowerbound=True),
            line(board, "a3", -30, upperbound=True),
            {"pv": [chess.Move.from_uci("a1a8")], "score": chess.engine.PovScore(chess.engine.Cp(-30), board.turn), "depth": 14},
            {"pv": [], "score": chess.engine.PovScore(chess.engine.Cp(-30), board.turn), "depth": 14},
            {"pv": [board.parse_san("a3")], "depth": 14},
            {"pv": [board.parse_san("a3")], "score": chess.engine.PovScore(chess.engine.Cp(float("nan")), board.turn), "depth": 14},
        ]
        for invalid in invalid_lines:
            with self.subTest(info=invalid):
                self.assertIsNone(self.plan(board).choose(board, [line(board, "d3", 40), invalid], baseline))
        self.assertIsNone(self.plan(board).choose(board, [line(board, "a3", -30)], baseline))

    def test_cannot_replace_an_unreliable_top_line_with_a_filtered_alternative(self):
        board = position()
        baseline = board.parse_san("d3")
        for top in [
            {},
            line(board, "O-O", 100, depth=9),
            line(board, "O-O", 100, lowerbound=True),
            line(board, "O-O", 100, upperbound=True),
            {"pv": [chess.Move.from_uci("a1a8")], "score": chess.engine.PovScore(chess.engine.Cp(100), board.turn), "depth": 14},
        ]:
            with self.subTest(top=top):
                infos = [top, line(board, "d3", 40), line(board, "a3", -30)]
                self.assertIsNone(self.plan(board).choose(board, infos, baseline))

    def test_inconsistent_top_score_cannot_supply_loss_estimate(self):
        board = position()
        infos = [line(board, "d3", 40), line(board, "O-O", 50), line(board, "a3", -30)]
        self.assertIsNone(self.plan(board).choose(board, infos, board.parse_san("d3")))

    def test_mate_scores_are_never_used_as_centipawns(self):
        board = position()
        for distance in [-3, 3]:
            infos = [line(board, "d3", 40), line(board, "a3", -30)]
            infos[0]["score"] = chess.engine.PovScore(chess.engine.Mate(distance), board.turn)
            self.assertIsNone(self.plan(board).choose(board, infos, board.parse_san("d3")))

    def test_immediate_mate_is_protected_even_without_a_mate_score(self):
        board = chess.Board()
        for san in ["e4", "e5", "Bc4", "Nc6", "Qh5", "Nf6"]:
            board.push_san(san)
        plan = self.plan(board)
        self.assertTrue(plan.eligible)
        infos = [line(board, "Qf3", 500), line(board, "Qe2", 400)]
        self.assertIsNone(plan.choose(board, infos, board.parse_san("Qf3")))

    def test_changed_history_does_not_consume_or_select_an_opportunity(self):
        board = position()
        plan = self.plan(board)
        board.pop()
        self.assertIsNone(plan.choose(board, [], next(iter(board.legal_moves))))


if __name__ == "__main__":
    unittest.main()
