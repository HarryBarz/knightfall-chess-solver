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

    def test_stop_cancels_only_the_requested_search_and_engine_recovers(self):
        request_id = str(uuid.uuid4())
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(self.analyze, seconds=30, requestId=request_id)
            time.sleep(0.5)
            self.assertFalse(pending.done(), "Long analysis unexpectedly finished before cancellation")
            self.post("/api/stop", {"requestId": "another-search"})
            time.sleep(0.1)
            self.assertFalse(pending.done(), "A different request ID cancelled the search")
            self.post("/api/stop", {"requestId": request_id})
            cancelled = pending.result(timeout=8)
        self.assertEqual(cancelled["requestId"], request_id)
        self.assertTrue(cancelled["cancelled"], cancelled)
        recovered = self.analyze(moves=["d2d4"])
        board = chess.Board()
        board.push_uci("d2d4")
        self.assertFalse(recovered["cancelled"])
        self.assertIn(chess.Move.from_uci(recovered["bestMove"]), board.legal_moves)


if __name__ == "__main__":
    unittest.main()
