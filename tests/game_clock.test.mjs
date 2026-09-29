import test from "node:test";
import assert from "node:assert/strict";
import clockModule from "../web/game-clock.js";

const { GameClock, INITIAL_MS, VERSION } = clockModule;
const FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const BLACK_FEN = FEN.replace(" w ", " b ");
const E4 = ["e2e4"];
const E4E5 = [...E4, "e7e5"];
const clone = (value) => JSON.parse(JSON.stringify(value));

function fixture(fen = FEN, moves = []) {
  let now = 1000;
  return {
    clock: new GameClock(fen, moves, { now: () => now }),
    now: () => now,
    advance: (ms) => { now += ms; },
  };
}

test("new game has two paused ten-minute clocks and charges only the active color", () => {
  const { clock, advance } = fixture();
  assert.equal(INITIAL_MS, 600000);
  assert.equal(clock.running, false);
  advance(15000);
  assert.deepEqual(clock.snapshot().remaining, { white: 600000, black: 600000 });
  clock.start();
  advance(3250);
  assert.equal(clock.commit(E4), true);
  assert.equal(clock.turn, "black");
  advance(2000);
  assert.deepEqual(clock.snapshot().remaining, { white: 596750, black: 598000 });
  assert.equal(clock.commit(E4E5), true);
  assert.equal(clock.turn, "white");
  assert.equal(clock.remaining("b"), 598000);
});

test("imported endpoints get fresh clocks and derive turn from initial FEN and ply", () => {
  const { clock, advance } = fixture(BLACK_FEN, ["e7e5"]);
  assert.equal(clock.turn, "white");
  assert.equal(clock.snapshot().basePly, 1);
  clock.resume();
  advance(3000);
  assert.equal(clock.remaining("white"), 597000);
  assert.equal(clock.remaining("black"), 600000);
  const fresh = new GameClock(FEN, E4E5);
  assert.deepEqual(fresh.snapshot().remaining, { white: 600000, black: 600000 });
  assert.equal(fresh.snapshot().history.length, 1);
});

test("sparse ticks and page reload charge elapsed wall time without interval drift", () => {
  const { clock, advance, now } = fixture();
  clock.start();
  advance(100);
  clock.settle();
  advance(101);
  clock.settle();
  advance(99);
  const saved = clone(clock.serialize());
  advance(62000);
  const restored = GameClock.restore(saved, FEN, [], { now });
  assert.ok(restored);
  assert.equal(restored.remaining("white"), 537700);
  assert.equal(restored.running, true);
  advance(2000);
  assert.equal(restored.commit(E4), true);
  assert.equal(restored.remaining("white"), 535700);
});

test("paused review time and paused reload do not charge either clock", () => {
  const { clock, advance, now } = fixture();
  clock.start();
  advance(3000);
  clock.pause();
  const saved = clone(clock.serialize());
  advance(120000);
  const restored = GameClock.restore(saved, FEN, [], { now });
  assert.equal(restored.running, false);
  assert.equal(restored.remaining("white"), 597000);
  restored.resume();
  advance(1000);
  assert.equal(restored.remaining("white"), 596000);
});

test("expiration flags only the active side once and rejects moves arriving too late", () => {
  const { clock, advance } = fixture(BLACK_FEN);
  clock.start();
  advance(600001);
  assert.equal(clock.commit(["e7e5"]), false);
  assert.equal(clock.flagged, "black");
  assert.equal(clock.ply, 0);
  assert.equal(clock.running, false);
  assert.deepEqual(clock.snapshot().remaining, { white: 600000, black: 0 });
  advance(1000000);
  clock.resume();
  assert.equal(clock.running, false);
  assert.equal(clock.flagged, "black");
  assert.equal(clock.remaining("white"), 600000);
});

test("restoring an elapsed running clock or a saved flag preserves timeout", () => {
  const { clock, advance, now } = fixture();
  clock.start();
  const saved = clock.serialize();
  advance(700000);
  const expired = GameClock.restore(saved, FEN, [], { now });
  assert.equal(expired.flagged, "white");
  const roundTrip = GameClock.restore(expired.serialize(), FEN, [], { now });
  assert.equal(roundTrip.flagged, "white");
  assert.equal(roundTrip.running, false);
});

test("failed moves keep charging and cannot change the side to move or its history", () => {
  const { clock, advance } = fixture();
  clock.start();
  advance(1000);
  assert.equal(clock.commit(["z1z9"]), false);
  assert.equal(clock.commit(E4E5), false);
  advance(2000);
  assert.equal(clock.turn, "white");
  assert.equal(clock.running, true);
  assert.equal(clock.ply, 0);
  assert.equal(clock.remaining("white"), 597000);
  assert.equal(clock.commit(E4), true);
  assert.equal(clock.commit(["d2d4", "e7e5"]), false);
});

test("undo restores the earlier turn without refunding time and discards abandoned branches", () => {
  const { clock, advance, now } = fixture();
  clock.start();
  advance(3000);
  clock.commit(E4);
  advance(4000);
  clock.commit(E4E5);
  advance(5000);
  assert.equal(clock.undo(E4), true);
  assert.equal(clock.turn, "black");
  assert.deepEqual(clock.snapshot().remaining, { white: 592000, black: 596000 });
  advance(1000);
  assert.equal(clock.commit([...E4, "c7c5"]), true);
  assert.equal(clock.undo(E4E5), false);
  assert.equal(clock.undo(E4), true);
  assert.equal(clock.remaining("black"), 595000);
  assert.equal(clock.snapshot().history.length, 2);
  assert.ok(GameClock.restore(clock.serialize(), FEN, E4, { now }));
});

test("undo past an import baseline keeps spent time and rebases unknown clock history", () => {
  const { clock, advance, now } = fixture(FEN, E4E5);
  clock.start();
  advance(5000);
  assert.equal(clock.undo(E4), true);
  assert.equal(clock.turn, "black");
  assert.equal(clock.snapshot().basePly, 1);
  assert.deepEqual(clock.snapshot().remaining, { white: 595000, black: 600000 });
  advance(2000);
  assert.equal(clock.undo([]), true);
  assert.deepEqual(clock.snapshot().remaining, { white: 595000, black: 598000 });
  assert.equal(clock.snapshot().basePly, 0);
  assert.ok(GameClock.restore(clock.serialize(), FEN, [], { now }));
});

test("backwards time neither refunds nor double-counts elapsed time", () => {
  const { clock } = fixture();
  clock.start(1000);
  assert.equal(clock.remaining("white", 5000), 596000);
  assert.equal(clock.remaining("white", 3000), 596000);
  assert.equal(clock.remaining("white", 6000), 595000);
  clock.pause(4000);
  clock.resume(5000);
  assert.equal(clock.remaining("white", 7000), 594000);
});

test("saved state must match the exact game, valid history, balances, and clock anchor", () => {
  const { clock, advance, now } = fixture();
  clock.start();
  advance(3000);
  clock.commit(E4);
  advance(2000);
  const saved = clock.serialize();
  assert.ok(GameClock.restore(saved, FEN, E4, { now }));
  assert.equal(GameClock.restore(saved, BLACK_FEN, E4, { now }), null);
  assert.equal(GameClock.restore(saved, FEN, ["d2d4"], { now }), null);
  const corruptions = [
    (s) => { s.version = VERSION + 1; },
    (s) => { s.remaining.white = 600001; },
    (s) => { s.remaining.black = -1; },
    (s) => { s.remaining.white = Infinity; },
    (s) => { s.anchor = now() + 1; },
    (s) => { s.anchor = NaN; },
    (s) => { s.turn = "white"; },
    (s) => { s.running = "yes"; },
    (s) => { s.flagged = "black"; },
    (s) => { s.flagged = undefined; },
    (s) => { s.remaining.black = 0; },
    (s) => { s.basePly = 2; },
    (s) => { s.ply = 2; },
    (s) => { s.history.pop(); },
    (s) => { s.history[1].ply = 0; },
    (s) => { s.history[1].remaining.white = 594000; },
    (s) => { s.history[0].remaining.white = 595000; },
  ];
  for (const corrupt of corruptions) {
    const broken = clone(saved);
    corrupt(broken);
    assert.equal(GameClock.restore(broken, FEN, E4, { now }), null, corrupt.toString());
  }
});

test("snapshots and caller move arrays cannot mutate the clock", () => {
  const { clock } = fixture();
  const moves = E4.slice();
  clock.commit(moves);
  moves[0] = "d2d4";
  const saved = clock.snapshot();
  saved.moves[0] = "d2d4";
  saved.remaining.white = 0;
  saved.history[0].remaining.white = 0;
  assert.deepEqual(clock.snapshot().moves, E4);
  assert.equal(clock.remaining("white"), 600000);
  assert.equal(clock.snapshot().history[0].remaining.white, 600000);
});

test("constructor can restore supplied state and rejects invalid setup", () => {
  const { clock, advance, now } = fixture();
  clock.start();
  advance(1000);
  const saved = clock.serialize();
  advance(1000);
  const restored = new GameClock(FEN, [], { now, saved });
  assert.equal(restored.remaining("white"), 598000);
  assert.equal(restored.running, true);
  assert.throws(() => new GameClock("not a FEN"), TypeError);
  assert.throws(() => new GameClock(FEN, ["e2e2"]), TypeError);
  assert.throws(() => clock.settle(NaN), TypeError);
  assert.throws(() => clock.remaining("purple"), TypeError);
});
