"use strict";

// The public numerical formulas are documented at https://lichess.org/page/accuracy
// and https://github.com/lichess-org/lila/blob/master/modules/analyse/src/main/AccuracyPercent.scala.
// Knightfall supplies its own best-versus-played evaluations and handles missing
// windows explicitly; these results do not reproduce an online site's analysis.
(() => {
  const METHOD_VERSION = "knightfall-accuracy-v2";
  const STORE_KEY = "knightfall.accuracy.v2";
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const percentage = (value) => Number.isFinite(value) && value >= 0 && value <= 100;

  function classifyMove(loss, isBest) {
    if (!Number.isFinite(loss) || loss < 0 || loss > 1 || typeof isBest !== "boolean") return null;
    if (isBest) return "Best";
    return loss < .02 ? "Excellent" : loss < .05 ? "Good" : loss < .10 ? "Inaccuracy" : loss < .20 ? "Mistake" : "Blunder";
  }

  function moveAccuracy(before, after) {
    if (!percentage(before) || !percentage(after)) return null;
    if (before <= after) return 100;
    return clamp(103.1668100711649 * Math.exp(-.04354415386753951 * (before - after)) - 3.166924740191411 + 1, 0, 100);
  }

  function validMetrics(row) {
    if (!row || row.methodVersion !== METHOD_VERSION || row.scored !== true || typeof row.isBest !== "boolean"
      || !Number.isFinite(row.expectedPointsLoss) || row.expectedPointsLoss < 0 || row.expectedPointsLoss > 1
      || !percentage(row.winPercentBefore) || !percentage(row.winPercentAfter) || !percentage(row.moveAccuracy)) return false;
    if (row.isBest && (row.expectedPointsLoss !== 0 || row.winPercentBefore !== row.winPercentAfter || row.moveAccuracy !== 100)) return false;
    return row.classification === classifyMove(row.expectedPointsLoss, row.isBest)
      && Math.abs(row.moveAccuracy - moveAccuracy(row.winPercentBefore, row.winPercentAfter)) <= .06;
  }

  function aggregateAccuracy(rows, initialTurn = "white") {
    if (!Array.isArray(rows)) throw new TypeError("Accuracy rows must be an array.");
    if (initialTurn !== "white" && initialTurn !== "black") throw new TypeError("Initial turn must be White or Black.");
    rows = Array.from(rows);
    const colorAt = (index) => index % 2 ? (initialTurn === "white" ? "black" : "white") : initialTurn;
    const valid = Array.from(rows, (row, index) => Boolean(row?.scored === true && row.move?.color === colorAt(index)
      && percentage(row.winPercentBefore) && percentage(row.winPercentAfter) && percentage(row.moveAccuracy)));
    const whitePercent = (value, color) => color === "white" ? value : 100 - value;
    const probabilities = [valid[0] ? whitePercent(rows[0].winPercentBefore, colorAt(0)) : null,
      ...Array.from(rows, (row, index) => valid[index] ? whitePercent(row.winPercentAfter, colorAt(index)) : null)];
    const windowSize = clamp(Math.floor(rows.length / 10), 2, 8);
    const fallback = [];
    const weights = Array.from(rows, (_, index) => {
      // Repeating the first full window aligns the initial moves with the
      // later sliding windows, without using truncated windows at either end.
      const start = Math.max(0, index - windowSize + 2);
      const window = probabilities.slice(start, start + windowSize);
      if (window.length !== windowSize || !window.every(percentage)) {
        fallback[index] = true;
        return .5;
      }
      fallback[index] = false;
      const mean = window.reduce((sum, value) => sum + value, 0) / window.length;
      const variance = window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / window.length;
      return clamp(Math.sqrt(variance), .5, 12);
    });
    const scored = valid.filter(Boolean).length;
    const complete = rows.length > 0 && scored === rows.length;
    const sides = {};
    for (const color of ["white", "black"]) {
      let total = 0, count = 0, weightedSum = 0, weightSum = 0, reciprocalSum = 0;
      let provisional = !complete;
      rows.forEach((row, index) => {
        if (colorAt(index) !== color) return;
        total++;
        if (!valid[index]) return;
        count++;
        weightedSum += row.moveAccuracy * weights[index];
        weightSum += weights[index];
        reciprocalSum += 1 / Math.max(1, row.moveAccuracy);
        provisional ||= fallback[index];
      });
      const weightedMean = count ? weightedSum / weightSum : null;
      const harmonicMean = count ? count / reciprocalSum : null;
      sides[color] = { score: count ? clamp((weightedMean + harmonicMean) / 2, 0, 100) : null, scored: count, total,
        weightedMean, harmonicMean, provisional };
    }
    return { methodVersion: METHOD_VERSION, windowSize, probabilities, weights, scored, total: rows.length, complete, sides };
  }

  const api = Object.freeze({ METHOD_VERSION, STORE_KEY, classifyMove, moveAccuracy, validMetrics, aggregateAccuracy });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalThis.KnightfallAccuracyMath = api;
})();
