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

test("new game has two paused fifteen-minute clocks and charges only the active color", () => {
  const { clock, advance } = fixture();
  assert.equal(INITIAL_MS, 900000);
  assert.equal(clock.running, false);
  advance(15000);
  assert.deepEqual(clock.snapshot().remaining, { white: 900000, black: 900000 });
  clock.start();
  advance(3250);
  assert.equal(clock.commit(E4), true);
  assert.equal(clock.turn, "black");
  advance(2000);
  assert.deepEqual(clock.snapshot().remaining, { white: 896750, black: 898000 });
  assert.equal(clock.commit(E4E5), true);
  assert.equal(clock.turn, "white");
  assert.equal(clock.remaining("b"), 898000);
});

test("imported endpoints get fresh clocks and derive turn from initial FEN and ply", () => {
  const { clock, advance } = fixture(BLACK_FEN, ["e7e5"]);
  assert.equal(clock.turn, "white");
  assert.equal(clock.snapshot().basePly, 1);
  clock.resume();
  advance(3000);
  assert.equal(clock.remaining("white"), 897000);
  assert.equal(clock.remaining("black"), 900000);
  const fresh = new GameClock(FEN, E4E5);
  assert.deepEqual(fresh.snapshot().remaining, { white: 900000, black: 900000 });
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
  assert.equal(restored.remaining("white"), 837700);
  assert.equal(restored.running, true);
  advance(2000);
  assert.equal(restored.commit(E4), true);
  assert.equal(restored.remaining("white"), 835700);
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
  assert.equal(restored.remaining("white"), 897000);
  restored.resume();
  advance(1000);
  assert.equal(restored.remaining("white"), 896000);
});

test("expiration flags only the active side once and rejects moves arriving too late", () => {
  const { clock, advance } = fixture(BLACK_FEN);
  clock.start();
  advance(900001);
  assert.equal(clock.commit(["e7e5"]), false);
  assert.equal(clock.flagged, "black");
  assert.equal(clock.ply, 0);
  assert.equal(clock.running, false);
  assert.deepEqual(clock.snapshot().remaining, { white: 900000, black: 0 });
  advance(1000000);
  clock.resume();
  assert.equal(clock.running, false);
  assert.equal(clock.flagged, "black");
  assert.equal(clock.remaining("white"), 900000);
});

test("restoring an elapsed running clock or a saved flag preserves timeout", () => {
  const { clock, advance, now } = fixture();
  clock.start();
  const saved = clock.serialize();
  advance(1000000);
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
  assert.equal(clock.remaining("white"), 897000);
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
  assert.deepEqual(clock.snapshot().remaining, { white: 892000, black: 896000 });
  advance(1000);
  assert.equal(clock.commit([...E4, "c7c5"]), true);
  assert.equal(clock.undo(E4E5), false);
  assert.equal(clock.undo(E4), true);
  assert.equal(clock.remaining("black"), 895000);
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
  assert.deepEqual(clock.snapshot().remaining, { white: 895000, black: 900000 });
  advance(2000);
  assert.equal(clock.undo([]), true);
  assert.deepEqual(clock.snapshot().remaining, { white: 895000, black: 898000 });
  assert.equal(clock.snapshot().basePly, 0);
  assert.ok(GameClock.restore(clock.serialize(), FEN, [], { now }));
});

test("backwards time neither refunds nor double-counts elapsed time", () => {
  const { clock } = fixture();
  clock.start(1000);
  assert.equal(clock.remaining("white", 5000), 896000);
  assert.equal(clock.remaining("white", 3000), 896000);
  assert.equal(clock.remaining("white", 6000), 895000);
  clock.pause(4000);
  clock.resume(5000);
  assert.equal(clock.remaining("white", 7000), 894000);
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
    (s) => { s.remaining.white = 900001; },
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
    (s) => { s.history[1].remaining.white = 894000; },
    (s) => { s.history[0].remaining.white = 895000; },
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
  assert.equal(clock.remaining("white"), 900000);
  assert.equal(clock.snapshot().history[0].remaining.white, 900000);
});

test("constructor can restore supplied state and rejects invalid setup", () => {
  const { clock, advance, now } = fixture();
  clock.start();
  advance(1000);
  const saved = clock.serialize();
  advance(1000);
  const restored = new GameClock(FEN, [], { now, saved });
  assert.equal(restored.remaining("white"), 898000);
  assert.equal(restored.running, true);
  assert.throws(() => new GameClock("not a FEN"), TypeError);
  assert.throws(() => new GameClock(FEN, ["e2e2"]), TypeError);
  assert.throws(() => clock.settle(NaN), TypeError);
  assert.throws(() => clock.remaining("purple"), TypeError);
});

function legacyClock(running = true) {
  return {
    version: 1, initialFen: FEN, moves: E4.slice(), basePly: 0, ply: 1,
    remaining: { white: 597000, black: 598000 }, turn: "black", running,
    flagged: null, anchor: 10000,
    history: [
      { ply: 0, remaining: { white: 600000, black: 600000 } },
      { ply: 1, remaining: { white: 597000, black: 600000 } },
    ],
  };
}

test("saved ten-minute games gain five minutes once while preserving elapsed time and pauses", () => {
  for (const running of [true, false]) {
    const saved = legacyClock(running);
    const original = clone(saved);
    const restored = GameClock.restore(saved, FEN, E4, { now: () => 11000 });
    assert.ok(restored);
    assert.equal(restored.running, running);
    assert.deepEqual(restored.snapshot().remaining, { white: 897000, black: running ? 897000 : 898000 });
    assert.equal(restored.snapshot().version, 2);
    assert.deepEqual(restored.snapshot().history[0].remaining, { white: 900000, black: 900000 });
    assert.deepEqual(saved, original, "Migration must not mutate stored input");
    const reloaded = GameClock.restore(restored.serialize(), FEN, E4, { now: () => 12000 });
    assert.deepEqual(reloaded.snapshot().remaining, { white: 897000, black: running ? 896000 : 898000 });
    assert.equal(reloaded.undo([]), true);
    assert.deepEqual(reloaded.snapshot().remaining, { white: 897000, black: running ? 896000 : 898000 });
  }
});

test("legacy time forfeits remain finished and invalid legacy balances are rejected", () => {
  const saved = legacyClock(false);
  saved.flagged = "black";
  saved.remaining.black = 0;
  const restored = GameClock.restore(saved, FEN, E4, { now: () => 12000 });
  assert.ok(restored);
  assert.equal(restored.flagged, "black");
  assert.equal(restored.resume().running, false);
  assert.equal(restored.commit(E4E5), false);
  assert.equal(GameClock.restore(restored.serialize(), FEN, E4, { now: () => 13000 }).flagged, "black");
  const invalid = legacyClock();
  invalid.history[0].remaining.white = 600001;
  assert.equal(GameClock.restore(invalid, FEN, E4, { now: () => 11000 }), null);
});
