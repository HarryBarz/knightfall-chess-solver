import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import math from '../web/accuracy-math.js';

const { METHOD_VERSION, STORE_KEY, classifyMove, moveAccuracy, validMetrics, aggregateAccuracy } = math;

function close(actual, expected, message = '') {
  assert.ok(Number.isFinite(actual), `${message}: expected a finite number, got ${actual}`);
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} differs from ${expected}`);
}

// Aggregation deliberately accepts a smaller numeric contract than cache validation.
function row(color, before = 50, after = 50, accuracy = 100) {
  return { scored: true, move: { color }, winPercentBefore: before, winPercentAfter: after, moveAccuracy: accuracy };
}

function metricRow(overrides = {}) {
  return {
    ...row('white', 50, 45, 80.81529992041436),
    methodVersion: METHOD_VERSION,
    isBest: false,
    expectedPointsLoss: .05,
    classification: 'Inaccuracy',
    ...overrides,
  };
}

function rowsFromWhiteProbabilities(probabilities, initialTurn = 'white', accuracies = []) {
  return probabilities.slice(1).map((after, index) => {
    const color = index % 2 === 0 ? initialTurn : initialTurn === 'white' ? 'black' : 'white';
    const fromWhite = (percent) => color === 'white' ? percent : 100 - percent;
    return row(color, fromWhite(probabilities[index]), fromWhite(after), accuracies[index] ?? 100);
  });
}

test('the method and cache namespace cannot reuse the previous accuracy model', () => {
  assert.equal(METHOD_VERSION, 'knightfall-accuracy-v2');
  assert.equal(STORE_KEY, 'knightfall.accuracy.v2');
  assert.notEqual(METHOD_VERSION, 'knightfall-ep-v1');
  assert.notEqual(STORE_KEY, 'knightfall.accuracy.v1');
});

test('Best requires identified best-move status; expected-points bands retain exact boundaries', () => {
  assert.equal(classifyMove(0, true), 'Best');
  assert.equal(classifyMove(0, false), 'Excellent');
  for (const unconfirmed of [undefined, null, 1, 'true']) {
    assert.notEqual(classifyMove(0, unconfirmed), 'Best');
  }
  for (const [loss, expected] of [
    [.019999, 'Excellent'], [.02, 'Good'], [.049999, 'Good'],
    [.05, 'Inaccuracy'], [.099999, 'Inaccuracy'], [.10, 'Mistake'],
    [.199999, 'Mistake'], [.20, 'Blunder'], [1, 'Blunder'],
  ]) assert.equal(classifyMove(loss, false), expected, `loss ${loss}`);
});

test('move accuracy uses win-percent changes and bounded Lichess curve values', () => {
  for (const [before, after, expected] of [
    [50, 49, 96.60397651008962],
    [50, 45, 80.81529992041436],
    [50, 40, 64.57982845372067],
    [90, 50, 15.909002002130045],
    [100, 0, 0],
    [100, 99.99, 100],
    [50, 50, 100],
    [20, 80, 100],
    [0, 0, 100],
    [100, 100, 100],
  ]) close(moveAccuracy(before, after), expected, `${before} -> ${after}`);
});

test('invalid win percentages remain unavailable instead of being coerced or clamped', () => {
  for (const invalid of [null, undefined, NaN, Infinity, -Infinity, -1, 101, '50', '', true, false, {}, []]) {
    assert.equal(moveAccuracy(invalid, 50), null, `invalid before ${String(invalid)}`);
    assert.equal(moveAccuracy(50, invalid), null, `invalid after ${String(invalid)}`);
  }
});

test('cache metric validation binds categories, percentages, formula and model version', () => {
  assert.equal(validMetrics(metricRow()), true);
  assert.equal(validMetrics(metricRow({ moveAccuracy: 80.81529992041436 + .05 })), true);
  assert.equal(validMetrics(metricRow({ moveAccuracy: 80.81529992041436 + .07 })), false);
  assert.equal(validMetrics(metricRow({ methodVersion: 'knightfall-ep-v1' })), false);
  assert.equal(validMetrics(metricRow({ methodVersion: undefined })), false);
  assert.equal(validMetrics(metricRow({ classification: 'Best' })), false);
  assert.equal(validMetrics(metricRow({ classification: 'Best', isBest: true })), false);
  assert.equal(validMetrics(metricRow({ classification: 'Good' })), false);
  assert.equal(validMetrics(metricRow({ expectedPointsLoss: 0, classification: 'Excellent' })), true);
  assert.equal(validMetrics(metricRow({ expectedPointsLoss: 0, classification: 'Best' })), false);
  assert.equal(validMetrics(metricRow({
    expectedPointsLoss: 0, classification: 'Best', isBest: true, winPercentAfter: 50, moveAccuracy: 100,
  })), true);
  assert.equal(validMetrics(metricRow({ isBest: undefined })), false);
  assert.equal(validMetrics(metricRow({ isBest: 1 })), false);
  assert.equal(validMetrics(metricRow({ scored: false })), false);
  assert.equal(validMetrics(metricRow({ scored: 1 })), false);
  assert.equal(validMetrics(null), false);
  assert.equal(validMetrics(undefined), false);
});

test('cache metric validation rejects missing, nonnumeric and out-of-range values', () => {
  for (const key of ['winPercentBefore', 'winPercentAfter', 'moveAccuracy']) {
    for (const value of [null, undefined, NaN, Infinity, -Infinity, -1, 101, '50', true]) {
      assert.equal(validMetrics(metricRow({ [key]: value })), false, `${key}: ${String(value)}`);
    }
  }
  for (const value of [null, undefined, NaN, Infinity, -Infinity, -.01, 1.01, '0.05', false]) {
    assert.equal(validMetrics(metricRow({ expectedPointsLoss: value })), false, `EP loss: ${String(value)}`);
  }
});

test('an empty game has no invented side scores or probabilities', () => {
  const result = aggregateAccuracy([]);
  assert.equal(result.methodVersion, METHOD_VERSION);
  assert.equal(result.windowSize, 2);
  assert.equal(result.scored, 0);
  assert.equal(result.total, 0);
  assert.equal(result.complete, false);
  assert.deepEqual(result.weights, []);
  assert.ok(result.probabilities.every((value) => value === null));
  for (const side of Object.values(result.sides)) {
    assert.equal(side.score, null);
    assert.equal(side.weightedMean, null);
    assert.equal(side.harmonicMean, null);
    assert.equal(side.scored, 0);
    assert.equal(side.total, 0);
    assert.equal(side.provisional, true);
  }
});

test('pending and explicitly unscored moves count toward coverage but cannot become perfect moves', () => {
  const result = aggregateAccuracy([
    null,
    { ...row('black'), scored: false },
    { scored: false, move: { color: 'white' }, moveAccuracy: null, winPercentBefore: null, winPercentAfter: null },
    null,
  ]);
  assert.equal(result.total, 4);
  assert.equal(result.scored, 0);
  assert.equal(result.complete, false);
  assert.deepEqual(result.probabilities, [null, null, null, null, null]);
  assert.deepEqual(result.weights, [.5, .5, .5, .5]);
  for (const side of Object.values(result.sides)) {
    assert.equal(side.score, null);
    assert.equal(side.scored, 0);
    assert.equal(side.total, 2);
    assert.equal(side.provisional, true);
  }
});

test('holes in a pending move array retain side totals and match explicit missing rows', () => {
  const sparse = Array(3);
  sparse[1] = row('black', 50, 40, 80);
  assert.deepEqual(aggregateAccuracy(sparse), aggregateAccuracy([null, sparse[1], null]));
});

test('one scored move gives its mover a score and leaves the unplayed side empty', () => {
  const result = aggregateAccuracy([row('white', 50, 45, 80)]);
  assert.equal(result.complete, true);
  assert.equal(result.scored, 1);
  assert.equal(result.total, 1);
  assert.deepEqual(result.probabilities, [50, 45]);
  assert.deepEqual(result.weights, [2.5]);
  assert.deepEqual(result.sides.white, {
    score: 80, scored: 1, total: 1, weightedMean: 80, harmonicMean: 80, provisional: false,
  });
  assert.equal(result.sides.black.score, null);
  assert.equal(result.sides.black.scored, 0);
  assert.equal(result.sides.black.total, 0);
});

test('an imported Black-to-move position uses parity from the initial turn', () => {
  const result = aggregateAccuracy([row('black', 30, 20, 72), row('white', 80, 78, 96)], 'black');
  assert.deepEqual(result.probabilities, [70, 80, 78]);
  assert.deepEqual(result.weights, [5, 1]);
  close(result.sides.black.score, 72);
  close(result.sides.white.score, 96);
  assert.equal(result.sides.black.total, 1);
  assert.equal(result.sides.white.total, 1);
  assert.equal(result.complete, true);
});

test('color mirroring preserves move weights and swaps side estimates', () => {
  const rows = rowsFromWhiteProbabilities([50, 60, 40, 90, 80], 'white', [100, 80, 0, 60]);
  const normal = aggregateAccuracy(rows);
  const mirrored = aggregateAccuracy(rows.map((value) => ({
    ...value, move: { color: value.move.color === 'white' ? 'black' : 'white' },
  })), 'black');
  assert.deepEqual(mirrored.probabilities, normal.probabilities.map((value) => 100 - value));
  assert.deepEqual(mirrored.weights, normal.weights);
  assert.deepEqual(mirrored.sides.white, normal.sides.black);
  assert.deepEqual(mirrored.sides.black, normal.sides.white);
  assert.equal(mirrored.complete, normal.complete);
});

test('flat games use the minimum weight and keep perfect play at 100', () => {
  const result = aggregateAccuracy(rowsFromWhiteProbabilities(Array(41).fill(50)));
  assert.equal(result.windowSize, 4);
  assert.equal(result.complete, true);
  assert.equal(result.scored, 40);
  assert.deepEqual(result.weights, Array(40).fill(.5));
  for (const side of Object.values(result.sides)) {
    close(side.score, 100);
    close(side.weightedMean, 100);
    close(side.harmonicMean, 100);
    assert.equal(side.scored, 20);
  }
});

test('volatility weights use the entire position stream in White perspective', () => {
  const result = aggregateAccuracy(rowsFromWhiteProbabilities([50, 60, 40, 90, 80], 'white', [100, 80, 0, 60]));
  assert.deepEqual(result.probabilities, [50, 60, 40, 90, 80]);
  assert.deepEqual(result.weights, [5, 10, 12, 5]);
  close(result.sides.white.weightedMean, 500 / 17);
  close(result.sides.white.harmonicMean, 2 / 1.01);
  close(result.sides.white.score, 15.695981362842165);
  close(result.sides.black.weightedMean, 1100 / 15);
  close(result.sides.black.harmonicMean, 480 / 7);
  close(result.sides.black.score, 70.95238095238095);
});

test('volatility uses population deviation, the overlapping early window, and bounded window sizes', () => {
  const result = aggregateAccuracy(rowsFromWhiteProbabilities([42, 48, 60, ...Array(28).fill(66)]));
  assert.equal(result.total, 30);
  assert.equal(result.windowSize, 3);
  close(result.weights[0], 7.483314773547883);
  close(result.weights[1], 7.483314773547883);
  close(result.weights[2], 7.483314773547883);
  close(result.weights[3], Math.sqrt(8));
  assert.deepEqual(result.weights.slice(4), Array(26).fill(.5));
  for (const [moves, expectedWindow] of [[1, 2], [19, 2], [29, 2], [30, 3], [79, 7], [80, 8], [120, 8]]) {
    assert.equal(aggregateAccuracy(rowsFromWhiteProbabilities(Array(moves + 1).fill(50))).windowSize, expectedWindow);
  }
});

test('zero-accuracy moves remain zero in the weighted mean and use the explicit harmonic floor', () => {
  const result = aggregateAccuracy([row('white', 50, 0, 0), row('black', 100, 0, 0)]);
  for (const side of Object.values(result.sides)) {
    assert.equal(side.weightedMean, 0);
    assert.equal(side.harmonicMean, 1);
    assert.equal(side.score, .5);
    assert.equal(side.scored, 1);
  }
});

test('harmonic averaging limits dilution of a severe error by many perfect moves', () => {
  const rows = rowsFromWhiteProbabilities(Array(21).fill(50));
  rows[0].moveAccuracy = 0;
  const result = aggregateAccuracy(rows);
  close(result.sides.white.weightedMean, 90);
  close(result.sides.white.harmonicMean, 10 / 1.09);
  close(result.sides.white.score, 49.58715596330275);
  close(result.sides.black.score, 100);
  assert.ok(result.sides.white.score < 50, 'the side score must not silently return to the old arithmetic average');
});

test('missing moves retain their places in the position stream and use fallback weights', () => {
  const result = aggregateAccuracy([row('white', 50, 60, 95), null, row('white', 80, 90, 85)]);
  assert.deepEqual(result.probabilities, [50, 60, null, 90]);
  assert.deepEqual(result.weights, [5, .5, .5]);
  assert.equal(result.scored, 2);
  assert.equal(result.total, 3);
  assert.equal(result.complete, false);
  assert.equal(result.sides.white.scored, 2);
  assert.equal(result.sides.white.total, 2);
  assert.equal(result.sides.black.scored, 0);
  assert.equal(result.sides.black.total, 1);
  assert.equal(result.sides.white.provisional, true, 'the other side’s missing move also makes volatility provisional');
  assert.equal(result.sides.black.provisional, true);
  close(result.sides.white.weightedMean, (95 * 5 + 85 * .5) / 5.5);

  const firstMissing = aggregateAccuracy([null, row('black', 40, 35, 90)]);
  assert.deepEqual(firstMissing.probabilities, [null, null, 65]);
  assert.deepEqual(firstMissing.weights, [.5, .5]);
});

test('invalid numeric rows and wrong-color rows are excluded without shifting move parity', () => {
  const invalidRows = [
    { ...row('white'), scored: false },
    { ...row('white'), scored: 1 },
    row('black'),
    { ...row('white'), move: null },
  ];
  for (const key of ['winPercentBefore', 'winPercentAfter', 'moveAccuracy']) {
    for (const value of [null, undefined, NaN, Infinity, -Infinity, -1, 101, '50', true]) {
      invalidRows.push({ ...row('white'), [key]: value });
    }
  }
  for (const invalid of invalidRows) {
    const result = aggregateAccuracy([invalid, row('black', 40, 30, 80)]);
    assert.equal(result.scored, 1, JSON.stringify(invalid));
    assert.equal(result.total, 2);
    assert.equal(result.complete, false);
    assert.equal(result.sides.white.score, null);
    assert.equal(result.sides.white.total, 1);
    close(result.sides.black.score, 80);
    assert.deepEqual(result.probabilities, [null, null, 70]);
    assert.deepEqual(result.weights, [.5, .5]);
  }
});

test('aggregation is pure and leaves caller-owned rows and arrays unchanged', () => {
  const rows = Object.freeze([
    Object.freeze({ ...row('white', 50, 45, 80), move: Object.freeze({ color: 'white' }) }),
    null,
  ]);
  const before = JSON.stringify(rows);
  const first = aggregateAccuracy(rows);
  const second = aggregateAccuracy(rows);
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(rows), before);
});

test('the same pure module is available in a browser without CommonJS or the DOM', async () => {
  const source = await readFile(new URL('../web/accuracy-math.js', import.meta.url), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename: 'accuracy-math.js' });
  const browser = context.KnightfallAccuracyMath;
  assert.ok(browser, 'browser global KnightfallAccuracyMath');
  assert.equal(browser.METHOD_VERSION, METHOD_VERSION);
  assert.equal(browser.STORE_KEY, STORE_KEY);
  for (const name of ['classifyMove', 'moveAccuracy', 'validMetrics', 'aggregateAccuracy']) {
    assert.equal(typeof browser[name], 'function', name);
  }
  close(browser.moveAccuracy(50, 45), 80.81529992041436);
  const rows = [row('white', 50, 40, 65), row('black', 60, 55, 80)];
  assert.deepEqual(JSON.parse(JSON.stringify(browser.aggregateAccuracy(rows))), aggregateAccuracy(rows));
});
