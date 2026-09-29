"""End-to-end checks against the HTTP server and the real local chess engine.

Run with: .venv/bin/python -m unittest discover -s tests -v
"""

from __future__ import annotations

import concurrent.futures
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import uuid

import chess


ROOT = Path(__file__).resolve().parents[1]


class SolverAPITest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        cls.base_url = f"http://127.0.0.1:{port}"
        cls.server_log = tempfile.TemporaryFile(mode="w+")
        cls.server = subprocess.Popen(
            [sys.executable, "server.py", "--port", str(port)],
            cwd=ROOT,
            stdout=cls.server_log,
            stderr=subprocess.STDOUT,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
        )
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if cls.server.poll() is not None:
                break
            try:
                with urllib.request.urlopen(cls.base_url + "/api/health", timeout=1) as response:
                    cls.health = json.load(response)
                return
            except (OSError, ValueError):
                time.sleep(0.05)
        cls.server.terminate()
        cls.server.wait(timeout=5)
        cls.server_log.seek(0)
        log = cls.server_log.read()
        cls.server_log.close()
        raise RuntimeError(f"Server did not become ready:\n{log}")

    @classmethod
    def tearDownClass(cls):
        # Let server.py close its native engine process before it exits.
        cls.server.send_signal(signal.SIGINT)
        try:
            cls.server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.server.kill()
            cls.server.wait(timeout=5)
        cls.server_log.close()

    def request(self, path, payload=None, *, raw=None, timeout=15):
        data = raw if raw is not None else json.dumps(payload).encode()
        request = urllib.request.Request(
            self.base_url + path,
            data=data,
            headers={"Content-Type": "application/json"},
        )
        try:
            response = urllib.request.urlopen(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            self.assertIn("application/json", response.headers.get("Content-Type", ""))
            return response.status, json.load(response)

    def post(self, path, payload, **kwargs):
        status, body = self.request(path, payload, **kwargs)
        self.assertEqual(status, 200, body)
        self.assertNotIn("error", body)
        return body

    def position(self, moves=None, initial_fen=None):
        payload = {"moves": moves or []}
        if initial_fen is not None:
            payload["initialFen"] = initial_fen
        return self.post("/api/position", payload)

    def analyze(self, initial_fen=None, moves=None, **options):
        payload = {
            "moves": moves or [],
            "seconds": 1,
            "threads": 1,
            "hashMb": 16,
            "multiPv": 1,
            "requestId": str(uuid.uuid4()),
        }
        if initial_fen is not None:
            payload["initialFen"] = initial_fen
        payload.update(options)
        return self.post("/api/analyze", payload, timeout=40)

    def explain(self, moves=None, initial_fen=None, **options):
        payload = {"moves": moves or [], "requestId": str(uuid.uuid4()), "strength": 70}
        if initial_fen is not None:
            payload["initialFen"] = initial_fen
        payload.update(options)
        return self.post("/api/explain", payload, timeout=15)

    def assert_explanation_line_legal(self, line, before):
        self.assertTrue(line["uciPv"], line)
        self.assertEqual(len(line["pv"]), len(line["uciPv"]))
        replay = before.copy()
        for uci, san in zip(line["uciPv"], line["pv"]):
            move = chess.Move.from_uci(uci)
            self.assertIn(move, replay.legal_moves, line)
            self.assertEqual(replay.san(move), san)
            replay.push(move)
        self.assertEqual(set(line["score"]), {"cp", "mate"})
        self.assertTrue(line["score"]["cp"] is not None or line["score"]["mate"] is not None)

    def assert_position_matches(self, result, board):
        self.assertEqual(result["fen"], board.fen())
        self.assertEqual(result["turn"], "white" if board.turn else "black")
        self.assertEqual(result["check"], board.is_check())
        self.assertEqual(
            {move["uci"] for move in result["legalMoves"]},
            {move.uci() for move in board.legal_moves},
        )
        for move in result["legalMoves"]:
            parsed = chess.Move.from_uci(move["uci"])
            self.assertEqual(move["from"], chess.square_name(parsed.from_square))
            self.assertEqual(move["to"], chess.square_name(parsed.to_square))
            self.assertEqual(move["san"], board.san(parsed))

    def test_health_and_starting_position(self):
        self.assertTrue(self.health["engineAvailable"], self.health)
        self.assertTrue(self.health["engineName"], self.health)
        position = self.position()
        self.assert_position_matches(position, chess.Board())
        self.assertEqual(len(position["legalMoves"]), 20)
        self.assertEqual(position["pieces"]["a1"], "wR")
        self.assertEqual(position["pieces"]["e8"], "bK")
        self.assertEqual(position["moves"], [])
        self.assertEqual(position["history"], [])
        self.assertIsNone(position["outcome"])
        self.assertIsNone(position["claimableDraw"])

    def test_local_screenshot_runtime_csp(self):
        with urllib.request.urlopen(self.base_url + "/", timeout=5) as response:
            directives = {
                parts[0]: parts[1:]
                for directive in response.headers["Content-Security-Policy"].split(";")
                if (parts := directive.split())
            }
            self.assertEqual(response.status, 200)
            self.assertEqual(set(directives["script-src"]), {"'self'", "'wasm-unsafe-eval'"})
            self.assertEqual(directives["connect-src"], ["'self'"])
            self.assertIn("blob:", directives["img-src"])
            self.assertNotIn("'unsafe-eval'", directives["script-src"])

    def test_reviewed_screenshot_position_metadata(self):
        placement = "2kr1bnr/ppp1pppp/2n5/q7/3P2b1/2N2N2/PPP1BPPP/R1BQ1RK1"
        for turn in ["w", "b"]:
            with self.subTest(turn=turn):
                fen = f"{placement} {turn} - - 3 8"
                imported = self.post("/api/import", {"fen": fen})
                self.assert_position_matches(imported, chess.Board(fen))
                self.assertEqual(imported["initialFen"], fen)
                self.assertEqual(imported["moves"], [])
                self.assertEqual(imported["history"], [])
                self.assertEqual(len(imported["pieces"]), 30)
                self.assertEqual(chess.Board(imported["fen"]).castling_rights, 0)
                self.assertIsNone(chess.Board(imported["fen"]).ep_square)
        for fen in [
            f"{placement} w K - 3 8",
            f"{placement} w - e6 3 8",
            "2kr1bnr/ppp1pppp/2n5/q7/3P2b1/2N2N2/PPP1BPPP/R1BQ1R2 w - - 3 8",
        ]:
            with self.subTest(invalid_review=fen):
                status, error = self.request("/api/import", {"fen": fen})
                self.assertEqual(status, 400)
                self.assertIn("error", error)

    def test_legal_san_and_uci_moves_and_history(self):
        result = self.post("/api/move", {"moves": [], "move": "e4"})
        result = self.post("/api/move", {"moves": result["moves"], "move": "e7e5"})
        result = self.post("/api/move", {"moves": result["moves"], "move": "Nf3"})
        board = chess.Board()
        for move in ["e4", "e5", "Nf3"]:
            board.push_san(move)
        self.assert_position_matches(result, board)
        self.assertEqual(result["moves"], ["e2e4", "e7e5", "g1f3"])
        self.assertEqual([move["san"] for move in result["history"]], ["e4", "e5", "Nf3"])
        self.assertEqual([move["turn"] for move in result["history"]], ["white", "black", "white"])
        self.assertEqual([move["moveNumber"] for move in result["history"]], [1, 1, 2])

    def test_illegal_move_does_not_change_position(self):
        moves = ["e2e4"]
        before = self.position(moves)
        status, result = self.request("/api/move", {"moves": moves, "move": "e2e3"})
        self.assertGreaterEqual(status, 400)
        self.assertTrue(result["error"])
        after = self.position(moves)
        self.assertEqual(after["fen"], before["fen"])
        self.assertEqual(after["moves"], before["moves"])

    def test_castling_moves_both_pieces_and_revokes_rights(self):
        fen = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"
        result = self.post("/api/move", {"initialFen": fen, "moves": [], "move": "O-O"})
        board = chess.Board(fen)
        board.push_san("O-O")
        self.assert_position_matches(result, board)
        self.assertEqual(result["pieces"]["g1"], "wK")
        self.assertEqual(result["pieces"]["f1"], "wR")
        self.assertNotIn("h1", result["pieces"])
        self.assertFalse(chess.Board(result["fen"]).has_kingside_castling_rights(chess.WHITE))
        self.assertFalse(chess.Board(result["fen"]).has_queenside_castling_rights(chess.WHITE))

    def test_en_passant_removes_the_captured_pawn(self):
        moves = ["e2e4", "a7a6", "e4e5", "d7d5"]
        result = self.post("/api/move", {"moves": moves, "move": "exd6"})
        board = chess.Board()
        for move in moves + ["e5d6"]:
            board.push_uci(move)
        self.assert_position_matches(result, board)
        self.assertEqual(result["pieces"]["d6"], "wP")
        self.assertNotIn("d5", result["pieces"])

    def test_underpromotion_preserves_the_selected_piece(self):
        fen = "8/P6k/8/8/8/8/8/7K w - - 0 1"
        position = self.position(initial_fen=fen)
        promotions = {move["promotion"] for move in position["legalMoves"] if move["from"] == "a7"}
        self.assertEqual(promotions, {"q", "r", "b", "n"})
        result = self.post("/api/move", {"initialFen": fen, "moves": [], "move": "a7a8n"})
        self.assertEqual(result["pieces"]["a8"], "wN")
        self.assertEqual(result["moves"], ["a7a8n"])
        self.assertEqual(result["outcome"]["result"], "1/2-1/2")

    def test_fen_and_pgn_import_round_trip(self):
        fen = "r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 7 23"
        imported = self.post("/api/import", {"fen": fen})
        self.assert_position_matches(imported, chess.Board(fen))
        self.assertEqual(imported["initialFen"], fen)
        played = self.post("/api/move", {"initialFen": fen, "moves": [], "move": "O-O-O"})
        reimported = self.post("/api/import", {"pgn": played["pgn"]})
        self.assertEqual(reimported["initialFen"], fen)
        self.assertEqual(reimported["fen"], played["fen"])
        self.assertEqual(reimported["moves"], played["moves"])
        self.assertEqual(reimported["history"][0]["moveNumber"], 23)
        pgn = '[Event "Import check"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *'
        imported = self.post("/api/import", {"pgn": pgn})
        self.assertEqual(imported["moves"], ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6"])
        self.assertEqual(self.post("/api/import", {"pgn": imported["pgn"]})["fen"], imported["fen"])

    def test_checkmate_and_stalemate_are_distinguished(self):
        mate = self.position(["f2f3", "e7e5", "g2g4", "d8h4"])
        self.assertTrue(mate["check"])
        self.assertEqual(mate["legalMoves"], [])
        self.assertEqual(mate["outcome"]["result"], "0-1")
        self.assertEqual(mate["outcome"]["winner"], "black")
        self.assertIn("checkmate", mate["outcome"]["reason"].lower())
        stale = self.position(initial_fen="7k/5Q2/6K1/8/8/8/8/8 b - - 0 1")
        self.assertFalse(stale["check"])
        self.assertEqual(stale["legalMoves"], [])
        self.assertEqual(stale["outcome"]["result"], "1/2-1/2")
        self.assertIn("stalemate", stale["outcome"]["reason"].lower())

    def test_repetition_history_keeps_claims_separate_from_automatic_draws(self):
        cycle = ["g1f3", "g8f6", "f3g1", "f6g8"]
        threefold = self.position(cycle * 2)
        self.assertIsNone(threefold["outcome"])
        self.assertTrue(threefold["claimableDraw"])
        self.assertIn("threefold", threefold["claimableDraw"].lower())
        fivefold = self.position(cycle * 4)
        self.assertEqual(fivefold["outcome"]["result"], "1/2-1/2")
        self.assertIn("fivefold", fivefold["outcome"]["reason"].lower())
        self.assertEqual(len(fivefold["moves"]), 16)

    def test_malformed_requests_return_json_errors(self):
        cases = [
            ("/api/position", None, b"{bad json"),
            ("/api/position", [], None),
            ("/api/position", {"moves": "e2e4"}, None),
            ("/api/position", {"moves": ["e2e9"]}, None),
            ("/api/move", {"moves": [], "move": "this is not a move"}, None),
            ("/api/import", {"fen": "not a FEN"}, None),
            ("/api/import", {"fen": "8/8/8/8/8/8/8/8 w - - 0 1"}, None),
        ]
        for path, payload, raw in cases:
            with self.subTest(path=path, payload=payload, raw=raw):
                status, body = self.request(path, payload, raw=raw)
                self.assertGreaterEqual(status, 400)
                self.assertLess(status, 500)
                self.assertIsInstance(body["error"], str)
                self.assertTrue(body["error"])

    def test_real_engine_finds_mate_for_both_colors_with_white_scores(self):
        white_board = chess.Board("7k/8/5KQ1/8/8/8/8/8 w - - 0 1")
        for board, expected_mate in [(white_board, 1), (white_board.mirror(), -1)]:
            with self.subTest(turn="white" if board.turn else "black"):
                analysis = self.analyze(board.fen())
                self.assertEqual(analysis["positionFen"], board.fen())
                best = chess.Move.from_uci(analysis["bestMove"])
                self.assertIn(best, board.legal_moves)
                self.assertEqual(analysis["bestSan"], board.san(best))
                self.assertEqual(analysis["score"]["mate"], expected_mate)
                self.assertIsNone(analysis["score"]["cp"])
                self.assertFalse(analysis["cancelled"])
                board.push(best)
                self.assertTrue(board.is_checkmate(), analysis)

    def test_real_engine_returns_legal_multipv_and_search_metrics(self):
        analysis = self.analyze(moves=["e2e4"], multiPv=3)
        board = chess.Board()
        board.push_uci("e2e4")
        self.assertIn(chess.Move.from_uci(analysis["bestMove"]), board.legal_moves)
        self.assertEqual(analysis["bestSan"], board.san(chess.Move.from_uci(analysis["bestMove"])))
        self.assertEqual(analysis["positionFen"], board.fen())
        self.assertEqual(len(analysis["lines"]), 3)
        self.assertEqual(len({line["move"] for line in analysis["lines"]}), 3)
        self.assertIsInstance(analysis["score"]["cp"], int)
        self.assertIsNone(analysis["score"]["mate"])
        self.assertGreater(analysis["depth"], 0)
        self.assertGreater(analysis["nodes"], 0)
        self.assertGreater(analysis["nps"], 0)
        self.assertGreater(analysis["timeMs"], 0)
        for line in analysis["lines"]:
            pv_board = board.copy()
            self.assertIn(chess.Move.from_uci(line["move"]), pv_board.legal_moves)
            self.assertEqual(line["san"], pv_board.san(chess.Move.from_uci(line["move"])))
            self.assertTrue(line["pv"])
            for san in line["pv"]:
                pv_board.push_san(san)

    def test_practice_strength_produces_legal_replies_for_both_colors(self):
        for strength in [10, 70, 90]:
            for board in [chess.Board(), chess.Board().mirror()]:
                with self.subTest(strength=strength, turn=board.turn):
                    result = self.analyze(board.fen(), strength=strength)
                    move = chess.Move.from_uci(result["bestMove"])
                    self.assertIn(move, board.legal_moves)
                    self.assertEqual(result["bestSan"], board.san(move))
                    self.assertEqual(result["strength"], strength)
                    self.assertFalse(result["forgiving"])
                    self.assertEqual(result["skillLevel"], (strength - 10) * 20 // 90)
                    selected = next((line for line in result["lines"] if line["move"] == result["bestMove"]), None)
                    if selected is not None:
                        self.assertEqual(result["score"], selected["score"])
                    else:
                        self.assertEqual(result["score"], {"cp": None, "mate": None})

    def test_full_strength_analysis_recovers_after_forgiving_practice(self):
        practice = self.analyze(strength=70, forgiving=True)
        self.assertEqual(practice["strength"], 70)
        self.assertTrue(practice["forgiving"])
        self.assertEqual(practice["skillLevel"], 4)
        self.assertIn(chess.Move.from_uci(practice["bestMove"]), chess.Board().legal_moves)
        for board in [chess.Board("7k/8/5KQ1/8/8/8/8/8 w - - 0 1"), chess.Board("7k/8/5KQ1/8/8/8/8/8 w - - 0 1").mirror()]:
            with self.subTest(turn=board.turn):
                result = self.analyze(board.fen(), strength=100)
                self.assertEqual(result["strength"], 100)
                self.assertFalse(result["forgiving"])
                self.assertEqual(result["skillLevel"], 20)
                board.push_uci(result["bestMove"])
                self.assertTrue(board.is_checkmate(), result)

    def test_practice_settings_reject_invalid_values(self):
        cases = [
            {"strength": 9}, {"strength": 101}, {"strength": 70.5},
            {"strength": True}, {"strength": "70"}, {"strength": None},
            {"forgiving": "true"}, {"forgiving": 1}, {"forgiving": None},
            {"strength": 100, "forgiving": True},
        ]
        for settings in cases:
            with self.subTest(settings=settings):
                status, body = self.request("/api/analyze", {
                    "moves": [], "seconds": 1, "threads": 1, "hashMb": 16,
                    "requestId": str(uuid.uuid4()), **settings,
                })
                self.assertEqual(status, 400, body)
                self.assertTrue(body["error"])

    def test_extra_practice_opportunity_real_engine_and_committed_budget(self):
        original = chess.Board()
        for san in "d4 c6 a3 d5 h3 Nf6 Nf3 Ne4 Nc3 Nd7 e3 f5 Bd3 e5 dxe5 g6 Bxe4".split():
            original.push_san(san)
        mirrored = original.root().mirror()
        for move in original.move_stack:
            mirrored.push(chess.Move(chess.square_mirror(move.from_square), chess.square_mirror(move.to_square)))
        for board in [original, mirrored]:
            with self.subTest(turn=board.turn):
                moves = [move.uci() for move in board.move_stack]
                options = {"target": 1, "startPly": 0, "events": []}
                result = self.analyze(board.root().fen(), moves, strength=100, practice=options)
                plan = result["practice"]
                self.assertTrue(plan["deliberate"], result)
                self.assertEqual(plan["used"], 0, "Preview must not spend the budget")
                self.assertGreaterEqual(plan["lossCp"], 50)
                self.assertLessEqual(plan["lossCp"], 150)
                self.assertEqual(plan["event"], {"ply": len(moves), "move": result["bestMove"], "lossCp": plan["lossCp"]})
                self.assertEqual(result["lines"][0]["move"], result["bestMove"])
                self.assertEqual(result["score"], result["lines"][0]["score"])
                committed = self.post("/api/move", {"initialFen": board.root().fen(), "moves": moves, "move": result["bestMove"]})
                exhausted = self.analyze(board.root().fen(), committed["moves"], strength=70, practice={**options, "events": [plan["event"]]})
                self.assertEqual(exhausted["strength"], 70)
                self.assertEqual(exhausted["skillLevel"], 13)
                self.assertEqual(exhausted["practice"]["used"], 1)
                self.assertFalse(exhausted["practice"]["deliberate"])
                self.assertIsNone(exhausted["practice"]["event"])

    def test_extra_practice_validation_and_precancellation(self):
        for practice in [None, True, [], {"target": True}, {"target": 3}, {"startPly": 1},
                         {"target": 1, "events": [{"ply": 0, "move": "e2e4", "lossCp": 75}]}]:
            with self.subTest(practice=practice):
                status, body = self.request("/api/analyze", {"moves": [], "requestId": str(uuid.uuid4()), "practice": practice})
                self.assertEqual(status, 400, body)
        ident = str(uuid.uuid4())
        self.post("/api/stop", {"requestId": ident})
        cancelled = self.analyze(requestId=ident, strength=70, practice={"target": 2})
        self.assertTrue(cancelled["cancelled"])
        self.assertEqual(cancelled["practice"], {"target": 2, "used": 0, "deliberate": False, "lossCp": None, "event": None})

    def test_stop_cancels_only_the_requested_search_and_engine_recovers(self):
        request_id = str(uuid.uuid4())
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(self.analyze, seconds=30, requestId=request_id, strength=70, forgiving=True)
            time.sleep(0.5)
            self.assertFalse(pending.done(), "Long analysis unexpectedly finished before cancellation")
            self.post("/api/stop", {"requestId": "another-search"})
            time.sleep(0.1)
            self.assertFalse(pending.done(), "A different request ID cancelled the search")
            self.post("/api/stop", {"requestId": request_id})
            cancelled = pending.result(timeout=8)
        self.assertEqual(cancelled["requestId"], request_id)
        self.assertTrue(cancelled["cancelled"], cancelled)
        self.assertEqual(cancelled["strength"], 70)
        self.assertTrue(cancelled["forgiving"])
        recovered = self.analyze(moves=["d2d4"])
        board = chess.Board()
        board.push_uci("d2d4")
        self.assertFalse(recovered["cancelled"])
        self.assertEqual(recovered["strength"], 100)
        self.assertEqual(recovered["skillLevel"], 20)
        self.assertIn(chess.Move.from_uci(recovered["bestMove"]), board.legal_moves)

    def test_explanation_evaluates_actual_move_and_legal_alternatives(self):
        moves = ["e2e4", "e7e5", "a2a3"]
        before = chess.Board()
        for uci in moves[:-1]:
            before.push_uci(uci)
        actual = chess.Move.from_uci(moves[-1])
        after = before.copy()
        after.push(actual)
        request_id = str(uuid.uuid4())
        result = self.explain(moves, requestId=request_id)
        self.assertEqual(result["requestId"], request_id)
        self.assertFalse(result["cancelled"], result)
        self.assertEqual(result["initialFen"], chess.STARTING_FEN)
        self.assertEqual(result["beforeFen"], before.fen())
        self.assertEqual(result["afterFen"], after.fen())
        self.assertEqual(result["positionFen"], after.fen())
        self.assertEqual(result["moves"], moves)
        self.assertEqual(result["ply"], 3)
        self.assertEqual(result["move"], {
            "uci": "a2a3", "san": "a3", "color": "white",
            "from": "a2", "to": "a3", "piece": "pawn",
        })
        self.assertTrue(result["summary"])
        self.assertTrue(result["reasons"])
        self.assertTrue(all(isinstance(reason, str) and reason for reason in result["reasons"]))
        self.assertTrue(result["assessment"])
        self.assert_explanation_line_legal(result["played"], before)
        self.assertEqual(result["played"]["uciPv"][0], moves[-1])
        self.assertGreater(len(result["alternatives"]), 0)
        self.assertEqual(len({line["move"] for line in result["alternatives"]}), len(result["alternatives"]))
        for line in result["alternatives"]:
            self.assert_explanation_line_legal(line, before)
            self.assertEqual(line["move"], line["uciPv"][0])
            self.assertEqual(line["san"], line["pv"][0])
            self.assertNotEqual(line["move"], moves[-1])
            self.assertTrue(line["reason"])
        self.assertEqual(self.position(moves)["fen"], after.fen(), "Review must not change the game")

    def test_explanation_facts_match_rules_for_both_colors(self):
        cases = [
            ("7k/8/8/8/8/8/R7/K7 w - - 0 1", "a2h2", ("check",)),
            ("7k/8/8/3q4/3R4/8/8/K7 w - - 0 1", "d4d5", ("captur", "queen")),
            ("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "e1g1", ("castl", "rook")),
            ("8/P6k/8/8/8/8/8/7K w - - 0 1", "a7a8n", ("promot", "knight")),
            ("7k/8/8/3pP3/8/8/8/K7 w - d6 0 1", "e5d6", ("en passant", "pawn")),
        ]
        for fen, uci, expected_facts in cases:
            original = chess.Board(fen)
            original_move = chess.Move.from_uci(uci)
            mirrored_move = chess.Move(
                chess.square_mirror(original_move.from_square),
                chess.square_mirror(original_move.to_square),
                promotion=original_move.promotion,
            )
            for before, move in [(original, original_move), (original.mirror(), mirrored_move)]:
                with self.subTest(fen=before.fen(), move=move.uci()):
                    self.assertIn(move, before.legal_moves)
                    after = before.copy()
                    after.push(move)
                    result = self.explain([move.uci()], before.fen())
                    self.assertEqual(result["move"]["color"], "white" if before.turn else "black")
                    self.assertEqual(result["move"]["san"], before.san(move))
                    self.assertEqual(result["afterFen"], after.fen())
                    description = " ".join([result["summary"], *result["reasons"]]).lower()
                    for fact in expected_facts:
                        self.assertIn(fact, description)
                    self.assert_explanation_line_legal(result["played"], before)
                    self.assertEqual(result["played"]["uciPv"][0], move.uci())

    def test_explanation_quiet_opening_does_not_invent_forced_wins(self):
        result = self.explain(["e2e4"])
        description = " ".join([result["summary"], *result["reasons"], result["assessment"]]).lower()
        self.assertNotIn("forced win", description)
        self.assertNotIn("wins material", description)
        self.assertNotIn("checkmate", description)
        self.assertIsNone(result["played"]["score"]["mate"])

    def test_explanation_distinguishes_pinned_piece_geometry_from_legal_capture(self):
        before = chess.Board("k3r3/8/8/8/5q2/6N1/8/4K3 w - - 0 1")
        move = chess.Move.from_uci("g3e2")
        self.assertTrue(before.is_check())
        self.assertIn(move, before.legal_moves)
        after = before.copy()
        after.push(move)
        self.assertTrue(after.is_pinned(chess.WHITE, chess.E2))
        self.assertIn(chess.F4, after.attacks(chess.E2))
        white_reply = after.copy()
        white_reply.turn = chess.WHITE
        self.assertNotIn(chess.Move.from_uci("e2f4"), white_reply.legal_moves)
        result = self.explain([move.uci()], before.fen(), strength=30)
        description = " ".join(result["reasons"]).lower()
        self.assertIn("pinned", description)
        self.assertIn("geometric", description)
        self.assertIn("queen on f4", description)
        self.assert_explanation_line_legal(result["played"], before)
        self.assertEqual(result["played"]["uciPv"][0], move.uci())
        self.assertIn("highest evaluation among the reviewed candidates", result["assessment"])
        self.assertIn("Reduced strength can choose a different move", result["assessment"])

    def test_explanation_strength_profile_and_validation(self):
        for strength, forgiving, skill in [(10, False, 0), (70, True, 4), (90, False, 17), (100, False, 20)]:
            with self.subTest(strength=strength, forgiving=forgiving):
                result = self.explain(["e2e4"], strength=strength, forgiving=forgiving)
                self.assertEqual(result["strength"], strength)
                self.assertEqual(result["forgiving"], forgiving)
                self.assertEqual(result["skillLevel"], skill)
                self.assertEqual(result["played"]["uciPv"][0], "e2e4")
        for invalid in [{"strength": 9}, {"strength": 101}, {"strength": True},
                        {"strength": "70"}, {"forgiving": "true"}, {"strength": 100, "forgiving": True}]:
            with self.subTest(invalid=invalid):
                status, body = self.request("/api/explain", {"moves": ["e2e4"], **invalid})
                self.assertEqual(status, 400, body)
                self.assertTrue(body["error"])

    def test_explanation_empty_history_and_actual_checkmate_both_colors(self):
        for fen in [chess.STARTING_FEN, "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1"]:
            empty = self.explain(initial_fen=fen)
            self.assertIsNone(empty["move"])
            self.assertIsNone(empty["played"])
            self.assertEqual(empty["reasons"], [])
            self.assertEqual(empty["alternatives"], [])
            self.assertFalse(empty["cancelled"])
        white = chess.Board("7k/8/5KQ1/8/8/8/8/8 w - - 0 1")
        for before, uci, expected_mate in [(white, "g6g7", 1), (white.mirror(), "g3g2", -1)]:
            with self.subTest(turn=before.turn):
                after = before.copy()
                after.push_uci(uci)
                self.assertTrue(after.is_checkmate())
                result = self.explain([uci], before.fen(), strength=100)
                self.assertEqual(result["afterFen"], after.fen())
                self.assertEqual(result["played"]["score"], {"cp": None, "mate": expected_mate})
                self.assertIn("checkmate", " ".join([result["summary"], *result["reasons"]]).lower())
                self.assertEqual(result["played"]["uciPv"][0], uci)

    def test_explanation_cancellation_before_arrival_and_overlapping_requests(self):
        cancelled_id = str(uuid.uuid4())
        self.post("/api/explain/stop", {"requestId": cancelled_id})
        cancelled = self.explain(["e2e4"], requestId=cancelled_id)
        self.assertTrue(cancelled["cancelled"], cancelled)
        first_id, second_id = str(uuid.uuid4()), str(uuid.uuid4())
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(self.explain, ["e2e4"], requestId=first_id)
            time.sleep(0.08)
            second = executor.submit(self.explain, ["d2d4"], requestId=second_id)
            first_result, second_result = first.result(timeout=8), second.result(timeout=8)
        self.assertEqual(first_result["requestId"], first_id)
        self.assertTrue(first_result["cancelled"], first_result)
        self.assertEqual(second_result["requestId"], second_id)
        self.assertFalse(second_result["cancelled"], second_result)
        self.assertEqual(second_result["move"]["uci"], "d2d4")

    def test_pre_cancelled_late_review_does_not_interrupt_newer_review(self):
        stale_id, current_id = str(uuid.uuid4()), str(uuid.uuid4())
        self.post("/api/explain/stop", {"requestId": stale_id})
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            current = executor.submit(self.explain, ["e2e4"], requestId=current_id)
            time.sleep(0.08)
            stale = self.explain(["d2d4"], requestId=stale_id)
            self.assertTrue(stale["cancelled"], stale)
            result = current.result(timeout=8)
        self.assertEqual(result["requestId"], current_id)
        self.assertFalse(result["cancelled"], result)
        self.assertEqual(result["move"]["uci"], "e2e4")

    def test_analysis_arrows_match_the_position_and_keep_playing_strength(self):
        moves = ["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6"]
        position = self.position(moves)
        payload = {"moves": moves, "requestId": str(uuid.uuid4()),
                   "lookahead": 3, "strength": 70, "forgiving": False}
        result = self.post("/api/arrows", payload)
        self.assertEqual(result["positionFen"], position["fen"])
        self.assertEqual(result["moves"], moves)
        self.assertEqual(result["strength"], 70)
        self.assertFalse(result["cancelled"])
        self.assertTrue(result["ideas"])
        self.assertLessEqual(len(result["line"]), 3)
        board = chess.Board(position["fen"])
        for step in result["line"]:
            self.assertEqual(step["beforeFen"], board.fen())
            board.push_uci(step["move"])
            self.assertEqual(step["fen"], board.fen())
        for changes in ({"lookahead": 5}, {"lookahead": 7}, {"lookahead": True},
                        {"strength": 9}, {"forgiving": "false"}, {"strength": 100, "forgiving": True}):
            with self.subTest(changes=changes):
                status, body = self.request("/api/arrows", {**payload, **changes})
                self.assertEqual(status, 400, body)
        ident = str(uuid.uuid4())
        self.post("/api/arrows/stop", {"requestId": ident})
        cancelled = self.post("/api/arrows", {**payload, "requestId": ident})
        self.assertTrue(cancelled["cancelled"])
        self.assertEqual(self.position(moves)["fen"], position["fen"])

    def test_arrow_stop_does_not_cancel_playing_search(self):
        ident = str(uuid.uuid4())
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            playing = executor.submit(self.analyze, seconds=30, requestId=ident)
            try:
                time.sleep(0.2)
                result = self.post("/api/arrows", {"moves": ["e2e4"], "requestId": ident,
                    "strength": 70, "lookahead": 2})
                self.assertFalse(result["cancelled"])
                self.post("/api/arrows/stop", {"requestId": ident})
                self.assertFalse(playing.done(), "Arrow searches must not replace or cancel playing analysis")
            finally:
                self.post("/api/stop", {"requestId": ident})
                self.assertTrue(playing.result(timeout=10)["cancelled"])

    def test_match_review_replays_history_and_validates_selection(self):
        moves = ["f2f3", "e7e5", "g2g4", "d8h4"]
        position = self.position(moves)
        replay = chess.Board()
        for item in position["history"]:
            self.assertEqual(item["beforeFen"], replay.fen())
            replay.push_uci(item["uci"])
            self.assertEqual(item["afterFen"], replay.fen())
        payload = {"moves": moves, "requestId": str(uuid.uuid4()), "ply": 3,
                   "lookahead": 4, "strength": 100, "forgiving": False}
        review = self.post("/api/review", payload)
        self.assertEqual(review["moves"], moves)
        self.assertEqual(review["ply"], 3)
        self.assertEqual(review["afterFen"], position["history"][2]["afterFen"])
        self.assertEqual(review["move"]["uci"], "g2g4")
        self.assertEqual(review["strength"], 100)
        self.assertFalse(review["forgiving"])
        self.assertTrue(review["plan"])
        self.assertEqual(review["actualContinuation"][0]["move"], "d8h4")
        self.assertEqual(review["actualContinuation"][0]["fen"], position["fen"])
        for changes in ({"moves": []}, {"ply": 0}, {"ply": 5}, {"ply": True},
                        {"lookahead": 5}, {"lookahead": 9}, {"lookahead": False},
                        {"strength": 101}, {"forgiving": True}, {"forgiving": "false"}):
            with self.subTest(changes=changes):
                status, body = self.request("/api/review", {**payload, **changes})
                self.assertEqual(status, 400, body)
        cancelled_id = str(uuid.uuid4())
        self.post("/api/review/stop", {"requestId": cancelled_id})
        stopped = self.post("/api/review", {**payload, "requestId": cancelled_id})
        self.assertTrue(stopped["cancelled"])
        self.assertEqual(stopped["requestId"], cancelled_id)

    def test_match_review_is_independent_of_playing_and_live_notes(self):
        ident = str(uuid.uuid4())
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
            playing = executor.submit(self.analyze, seconds=30, requestId=ident)
            try:
                time.sleep(0.2)
                notes = executor.submit(self.explain, ["e2e4"], requestId=ident)
                review = self.post("/api/review", {"moves": ["e2e4", "e7e5"],
                    "ply": 1, "lookahead": 3, "strength": 100, "requestId": ident})
                self.assertFalse(review["cancelled"])
                self.assertFalse(notes.result(timeout=10)["cancelled"])
                self.assertFalse(playing.done(), "Post-match review must not replace playing analysis")
                self.post("/api/review/stop", {"requestId": ident})
                self.assertFalse(playing.done(), "Post-match cancellation must not stop playing analysis")
            finally:
                self.post("/api/stop", {"requestId": ident})
                self.assertTrue(playing.result(timeout=10)["cancelled"])

    def test_explanation_and_main_analysis_do_not_cross_cancel(self):
        request_id = str(uuid.uuid4())
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            main_search = executor.submit(self.analyze, seconds=30, requestId=request_id)
            try:
                time.sleep(0.2)
                review = self.explain(["e2e4"], requestId=request_id)
                self.assertFalse(review["cancelled"], review)
                self.assertFalse(main_search.done(), "Coach search must not replace main analysis")
                self.post("/api/explain/stop", {"requestId": request_id})
                time.sleep(0.05)
                self.assertFalse(main_search.done(), "Coach stop must not cancel main analysis")
                coach_id = str(uuid.uuid4())
                pending_review = executor.submit(self.explain, ["d2d4"], requestId=coach_id)
                time.sleep(0.08)
                self.post("/api/stop", {"requestId": coach_id})
                review = pending_review.result(timeout=8)
                self.assertFalse(review["cancelled"], "Main stop must not cancel coach review")
            finally:
                self.post("/api/stop", {"requestId": request_id})
                self.assertTrue(main_search.result(timeout=8)["cancelled"])


if __name__ == "__main__":
    unittest.main()
