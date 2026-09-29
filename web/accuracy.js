"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const math = globalThis.KnightfallAccuracyMath;
  const METHOD = math.METHOD_VERSION;
  const STORE = math.STORE_KEY;
  const CATEGORIES = ["Best", "Excellent", "Good", "Inaccuracy", "Mistake", "Blunder"];
  const session = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const records = new Map();
  const views = new Map();
  let live = null;
  let review = null;
  let reviewActive = false;
  let reviewSession = 0;
  let emitted = "";
  let generation = 0;
  let lastKey = "";
  let active = null;
  let serial = 0;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function validMatch(match) {
    return Boolean(match && typeof match.initialFen === "string" && match.initialFen.length <= 512
      && /^[wb]$/.test(match.initialFen.split(" ")[1]) && Array.isArray(match.moves) && match.moves.length <= 4096
      && match.moves.every((move) => typeof move === "string" && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)));
  }
  function matchKey(match) { return validMatch(match) ? JSON.stringify([METHOD, match.initialFen, match.moves]) : ""; }
  function selectedMatch() { return reviewActive ? review : live?.outcome ? live : null; }
  function selectedKey() { return matchKey(selectedMatch()); }
  function moveColor(match, ply) {
    const startsBlack = match.initialFen.split(" ")[1] === "b";
    return Boolean((ply - 1) % 2) !== startsBlack ? "black" : "white";
  }
  function validScore(score) {
    return Boolean(score && ((Number.isFinite(score.cp) && score.mate === null)
      || (score.cp === null && Number.isFinite(score.mate))));
  }

  function validRow(value, match, ply) {
    if (!value || value.methodVersion !== METHOD || value.ply !== ply || value.strength !== 100 || value.forgiving !== false
      || value.move?.uci !== match.moves[ply - 1] || value.move?.color !== moveColor(match, ply)
      || typeof value.move?.san !== "string" || !value.move.san || value.move.san.length > 32
      || typeof value.positionFen !== "string" || !value.positionFen || value.positionFen.length > 512) return false;
    const historical = match.history?.[ply - 1];
    if (historical?.afterFen && historical.afterFen !== value.positionFen) return false;
    const before = historical?.beforeFen || (ply === 1 ? match.initialFen : match.history?.[ply - 2]?.afterFen);
    if (before && value.beforeFen !== before) return false;
    if (value.scored === false) return value.moveAccuracy === null && value.expectedPointsLoss === null
      && value.classification === null && value.isBest === null && value.winPercentBefore === null && value.winPercentAfter === null
      && typeof value.unavailableReason === "string";
    return math.validMetrics(value) && validScore(value.bestScore) && validScore(value.score);
  }

  function storedRow(value) {
    return { methodVersion: METHOD, ply: value.ply, strength: 100, forgiving: false, beforeFen: value.beforeFen,
      positionFen: value.positionFen, move: { uci: value.move.uci, san: value.move.san, color: value.move.color },
      scored: value.scored, classification: value.scored ? value.classification : null,
      expectedPointsLoss: value.scored ? value.expectedPointsLoss : null, moveAccuracy: value.scored ? value.moveAccuracy : null,
      isBest: value.scored ? value.isBest : null, winPercentBefore: value.scored ? value.winPercentBefore : null,
      winPercentAfter: value.scored ? value.winPercentAfter : null,
      bestScore: value.scored ? { cp: value.bestScore.cp, mate: value.bestScore.mate } : null,
      score: value.scored ? { cp: value.score.cp, mate: value.score.mate } : null,
      unavailableReason: value.scored ? "" : value.unavailableReason.slice(0, 600) };
  }

  function newRecord(match, rows = null, updatedAt = Date.now()) {
    return { initialFen: match.initialFen, moves: [...match.moves], rows: rows || Array(match.moves.length).fill(null),
      updatedAt, error: "", paused: false, revision: 0 };
  }

  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || "null");
    if (saved?.methodVersion === METHOD && Array.isArray(saved.games)) {
      const games = saved.games.filter((game) => validMatch(game) && Array.isArray(game.rows) && game.rows.length === game.moves.length
        && Number.isFinite(game.updatedAt) && game.updatedAt > 0 && game.updatedAt <= Date.now() + 86400000)
        .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);
      for (const game of games) {
        const rows = game.rows.map((row, index) => validRow(row, game, index + 1) ? storedRow(row) : null);
        records.set(matchKey(game), newRecord(game, rows, game.updatedAt));
      }
    }
  } catch { /* Invalid or unavailable storage never supplies an accuracy score. */ }

  function persist() {
    try {
      const games = [...records.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3)
        .map(({ initialFen, moves, rows, updatedAt }) => ({ initialFen, moves, rows, updatedAt }));
      localStorage.setItem(STORE, JSON.stringify({ methodVersion: METHOD, games }));
    } catch { /* A report remains usable in memory if local storage is full. */ }
  }

  function recordFor(match) {
    const key = matchKey(match);
    if (!key) return null;
    if (!records.has(key)) {
      records.set(key, newRecord(match));
      if (records.size > 6) {
        const oldest = [...records.entries()].filter(([candidate]) => candidate !== key)
          .sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
        if (oldest) records.delete(oldest[0]);
      }
    }
    const record = records.get(key);
    // History restored after a reload adds a stronger identity check to cached rows.
    let changed = false;
    record.rows.forEach((row, index) => {
      if (row && !validRow(row, match, index + 1)) { record.rows[index] = null; changed = true; }
    });
    if (changed) { record.revision++; record.updatedAt = Date.now(); persist(); }
    return record;
  }

  function counts(record) {
    const processed = record.rows.filter(Boolean).length;
    const scored = record.rows.filter((row) => row?.scored).length;
    return { processed, scored, unavailable: processed - scored, total: record.moves.length };
  }

  function canRun() {
    const match = selectedMatch();
    if (!validMatch(match) || !match.moves.length || document.hidden || live?.ready === false || !reviewActive && live?.suspended) return false;
    const record = recordFor(match);
    return Boolean(record && !record.error && !record.paused && record.rows.some((row) => row === null));
  }

  function makeView(name, host) {
    if (!host || views.has(name)) return;
    const prefix = name === "review" ? "review-accuracy" : "accuracy";
    const panel = element("section", "accuracy-report");
    panel.id = `${prefix}-report`;
    panel.hidden = true;
    panel.setAttribute("aria-labelledby", `${prefix}-heading`);
    panel.dataset.model = METHOD;
    panel.innerHTML = `
      <div class="accuracy-heading"><div><p class="accuracy-eyebrow">THE MATCH IN NUMBERS</p><h2 id="${prefix}-heading">Accuracy estimate</h2></div><span class="accuracy-model-badge">Local · full strength</span></div>
      <p id="${prefix}-method-label" class="accuracy-coverage"><strong>Lichess-style local estimate · Not Chess.com CAPS2</strong></p>
      <p class="accuracy-coverage">Accuracy numbers follow Lichess-style formulas. Move labels use Stockfish expected-point loss; Best means the engine’s chosen move. These two measures can differ.</p>
      <p id="${prefix}-status" class="accuracy-status" role="status" aria-live="polite"></p>
      <div class="accuracy-progress-row"><progress id="${prefix}-progress" max="1" value="0" aria-label="Moves processed for accuracy"></progress><span id="${prefix}-progress-label"></span><button id="${prefix}-pause" type="button" class="accuracy-text-button">Pause</button></div>
      <div class="accuracy-sides">${["white", "black"].map((color) => `
        <article id="${prefix}-${color}" class="accuracy-side" data-accuracy-color="${color}">
          <div class="accuracy-side-heading"><h3>${color === "white" ? "White" : "Black"} <span id="${prefix}-${color}-owner"></span></h3><span id="${prefix}-${color}-sample" class="accuracy-sample"></span></div>
          <div class="accuracy-score-row"><strong id="${prefix}-${color}-score" class="accuracy-score">—</strong><span>/ 100<br><span id="${prefix}-${color}-qualifier">Accuracy estimate</span></span></div>
          <dl class="accuracy-counts">${CATEGORIES.map((category) => `<div data-category-row="${category}"><dt><i class="accuracy-category-dot accuracy-category-${category.toLowerCase()}" aria-hidden="true"></i>${category}</dt><dd data-category-count="${category}" data-color="${color}" data-count="0">0</dd></div>`).join("")}</dl>
        </article>`).join("")}</div>
      <p id="${prefix}-coverage" class="accuracy-coverage"></p>
      <div id="${prefix}-error-box" class="accuracy-error-box" hidden><p id="${prefix}-error"></p><button id="${prefix}-retry" type="button">Retry remaining moves</button></div>
      <details class="accuracy-move-details"><summary>Every move <span id="${prefix}-moves-label"></span></summary><p class="accuracy-moves-help">${name === "review" ? "Select a move to read its lesson on the replay board. " : "Open Match review to explore a move’s explanation. "}EP loss is the drop in expected points, shown in percentage points.</p><div class="accuracy-move-columns" aria-hidden="true"><span>Move</span><span>Classification</span><span>EP loss</span></div><div id="${prefix}-moves" class="accuracy-moves" aria-label="Move classifications"></div></details>
      <details class="accuracy-method"><summary>How this estimate is calculated</summary><div>
        <p>This report uses full-strength Stockfish independently of your playing difficulty and review teacher. It uses public <a href="https://lichess.org/page/accuracy" target="_blank" rel="noopener noreferrer">Lichess accuracy formulas</a> with our own best-versus-played search results. It does not reproduce either site’s analysis or accuracy score.</p>
        <p>The numerical accuracy model converts the mover’s centipawn evaluation to <code>Win% = 100 / (1 + exp(−0.00368208 × cp))</code>, with cp capped at ±1000 and mate scores mapped to the signed cap. This is a model of winning chances, not a measured personal probability.</p>
        <p>For each move, let <code>D = max(0, Win% before − Win% after)</code>. Accuracy is <code>clamp(103.1668100711649 × exp(−0.04354415386753951 × D) − 3.166924740191411 + 1, 0, 100)</code>, or 100 when winning chances do not decrease. The +1 allowance is part of the <a href="https://github.com/lichess-org/lila/blob/master/modules/analyse/src/main/AccuracyPercent.scala" target="_blank" rel="noopener noreferrer">current public calculation</a>.</p>
        <p>The game score combines two averages for each side: <code>score = (volatility-weighted mean + harmonic mean) / 2</code>. This gives a serious error more influence than a simple move average. Harmonic mean is <code>n / sum(1 / max(1, move accuracy))</code>.</p>
        <p>Volatility comes from the initial position and every subsequent position, expressed as White’s Win%. For <code>N</code> recorded turns, the window length is <code>w = clamp(floor(N / 10), 2, 8)</code>. For turn index <code>i</code> starting at zero, take the full window beginning at <code>max(0, i − w + 2)</code>. The move’s weight is the window’s population standard deviation, limited to 0.5–12. Initial turns share the first full window.</p>
        <p>Move classifications use a separate input: native Stockfish WDL expected points = win probability + half the draw probability. Expected-point loss compares the best and played moves, floored at zero. We use the numerical loss bands from <a href="https://support.chess.com/en/articles/8572705-how-are-moves-classified-what-is-a-blunder-or-brilliant-etc" target="_blank" rel="noopener noreferrer">Chess.com’s published classifications</a>, while Best requires the actual engine choice:</p>
        <dl class="accuracy-thresholds"><div><dt>Best</dt><dd>Engine’s chosen move</dd></div><div><dt>Excellent</dt><dd>Other move: 0 to below 0.02</dd></div><div><dt>Good</dt><dd>0.02 to below 0.05</dd></div><div><dt>Inaccuracy</dt><dd>0.05 to below 0.10</dd></div><div><dt>Mistake</dt><dd>0.10 to below 0.20</dd></div><div><dt>Blunder</dt><dd>0.20 or more</dd></div></dl>
        <p>Stockfish WDL describes engine self-play, unlike Chess.com’s rating-based expected-points model. An Excellent label can coexist with a lower numerical move accuracy because those measures use different probability models.</p>
        <p>Short searches and engine versions can change both measures. Missing moves remain unscored; their evaluations are never invented or joined across gaps. Scored moves whose volatility window is incomplete receive the minimum weight of 0.5, and the entire report stays provisional until every move is scored. Imported positions only include the moves recorded here.</p>
        <p class="accuracy-method-version">Method: ${METHOD}</p>
      </div></details>`;
    host.append(panel);
    views.set(name, { prefix, panel, host, rendered: "" });
    $(`${prefix}-pause`).addEventListener("click", () => {
      const match = name === "review" ? review : live;
      const record = recordFor(match);
      if (!record) return;
      record.paused = !record.paused;
      if (record.paused) cancelActive();
      schedule();
    });
    $(`${prefix}-retry`).addEventListener("click", () => {
      const match = name === "review" ? review : live;
      const record = recordFor(match);
      if (!record) return;
      record.rows = record.rows.map((row) => row?.scored ? row : null);
      record.error = ""; record.paused = false; record.revision++; record.updatedAt = Date.now();
      persist(); schedule();
    });
  }

  function ensureViews() {
    let host = $("accuracy-report-host");
    if (!host && $("match-finished")) {
      host = element("div"); host.id = "accuracy-report-host"; $("match-finished").after(host);
    }
    makeView("live", host);
    let reviewHost = $("review-accuracy-report-host");
    if (!reviewHost && document.querySelector("#match-review-dialog .review-heading")) {
      reviewHost = element("div"); reviewHost.id = "review-accuracy-report-host";
      document.querySelector("#match-review-dialog .review-heading").after(reviewHost);
    }
    makeView("review", reviewHost);
  }

  function moveLabel(match, index, row) {
    const color = moveColor(match, index + 1);
    const rootNumber = Number(match.initialFen.split(" ")[5]) || 1;
    const number = rootNumber + Math.floor((index + (match.initialFen.split(" ")[1] === "b" ? 1 : 0)) / 2);
    const san = row?.move.san || match.history?.[index]?.san || match.moves[index];
    return `${number}${color === "black" ? "..." : "."} ${san}`;
  }

  function renderRows(view, match, record) {
    const signature = JSON.stringify([matchKey(match), record.revision, match.history?.map((move) => move.san)]);
    if (view.rendered === signature) return;
    view.rendered = signature;
    const list = $(`${view.prefix}-moves`);
    const focusedPly = list.contains(document.activeElement) ? document.activeElement.dataset.accuracyPly : "";
    list.replaceChildren(...record.rows.map((row, index) => {
      const color = moveColor(match, index + 1);
      const item = element(view.prefix === "review-accuracy" ? "button" : "div", "accuracy-move-row");
      if (item.tagName === "BUTTON") {
        item.type = "button";
        item.setAttribute("aria-label", `Review ${moveLabel(match, index, row)}, ${row?.classification || (row ? "unscored" : "waiting for analysis")}`);
        item.addEventListener("click", () => window.dispatchEvent(new CustomEvent("knightfall:accuracy-select", { detail: { ply: index + 1 } })));
      }
      item.dataset.accuracyPly = String(index + 1);
      item.dataset.ply = String(index + 1);
      item.dataset.color = color;
      item.dataset.category = row?.classification || (row ? "Unscored" : "Pending");
      item.dataset.moveAccuracy = row?.scored ? String(row.moveAccuracy) : "";
      item.dataset.winPercentBefore = row?.scored ? String(row.winPercentBefore) : "";
      item.dataset.winPercentAfter = row?.scored ? String(row.winPercentAfter) : "";
      item.dataset.isBest = row?.scored ? String(row.isBest) : "";
      item.append(element("strong", "accuracy-move-san", moveLabel(match, index, row)),
        element("span", `accuracy-category accuracy-category-${row?.classification?.toLowerCase() || "pending"}`, row?.classification || (row ? "Unscored" : "Waiting…")),
        element("span", "accuracy-move-loss", row?.scored ? `${(row.expectedPointsLoss * 100).toFixed(1)} pp` : "—"));
      if (row?.scored) item.title = `${color === "white" ? "White" : "Black"} · Move accuracy estimate ${row.moveAccuracy.toFixed(1)} / 100 · Expected-points loss ${row.expectedPointsLoss}`;
      else if (row) item.title = row.unavailableReason;
      return item;
    }));
    if (focusedPly) list.querySelector(`[data-accuracy-ply="${focusedPly}"]`)?.focus({ preventScroll: true });
  }

  function renderView(name, view) {
    const match = name === "review" ? reviewActive ? review : null : live?.outcome ? live : null;
    const key = matchKey(match);
    const record = recordFor(match);
    view.panel.hidden = !key;
    view.host.hidden = !key;
    if (!record) return;
    const prefix = view.prefix;
    const { processed, scored, unavailable, total } = counts(record);
    const aggregation = math.aggregateAccuracy(record.rows, match.initialFen.split(" ")[1] === "b" ? "black" : "white");
    const complete = total > 0 && scored === total;
    const waiting = selectedKey() !== key || document.hidden || live?.ready === false || !reviewActive && live?.suspended;
    const status = !total ? "empty" : complete ? "complete" : record.error ? "error" : processed === total ? "incomplete"
      : record.paused || waiting ? "paused" : "loading";
    view.panel.dataset.status = status;
    view.panel.dataset.gameKey = key;
    view.panel.dataset.scored = String(scored);
    view.panel.dataset.processed = String(processed);
    view.panel.dataset.total = String(total);
    view.panel.setAttribute("aria-busy", String(status === "loading"));
    let message;
    if (!total) message = "No recorded moves to score. Play from this position to build an accuracy report.";
    else if (complete) message = `Report complete · ${total} moves analyzed at full strength.`;
    else if (record.error) message = "Analysis stopped. Your completed move scores are saved; retry to continue.";
    else if (processed === total) message = `Partial report · ${unavailable} ${unavailable === 1 ? "move is" : "moves are"} unscored because a reliable evaluation was unavailable.`;
    else if (record.paused) message = `Paused · ${processed} of ${total} moves processed. Resume whenever you are ready.`;
    else if (waiting) message = live?.ready === false ? "Waiting for Stockfish. Saved results remain available." : "Report saved · Analysis resumes when this match is active.";
    else message = `Analyzing move ${Math.min(processed + 1, total)} of ${total} · Scores below are provisional.`;
    $(`${prefix}-status`).textContent = message;
    $(`${prefix}-progress`).max = Math.max(1, total);
    $(`${prefix}-progress`).value = processed;
    $(`${prefix}-progress-label`).textContent = `${processed} / ${total}`;
    const pause = $(`${prefix}-pause`);
    pause.hidden = !total || processed === total || Boolean(record.error);
    pause.disabled = selectedKey() !== key;
    pause.textContent = record.paused ? "Resume" : "Pause";
    pause.setAttribute("aria-label", `${record.paused ? "Resume" : "Pause"} accuracy analysis`);
    for (const color of ["white", "black"]) {
      const rows = record.rows.filter((row) => row?.scored && row.move.color === color);
      const side = aggregation.sides[color];
      const expected = side.total;
      const score = side.score;
      const card = $(`${prefix}-${color}`);
      card.dataset.score = score === null ? "" : String(score);
      card.dataset.scored = String(rows.length);
      card.dataset.weightedMean = side.weightedMean === null ? "" : String(side.weightedMean);
      card.dataset.harmonicMean = side.harmonicMean === null ? "" : String(side.harmonicMean);
      $(`${prefix}-${color}-score`).textContent = score === null ? "—" : score.toFixed(1);
      $(`${prefix}-${color}-owner`).textContent = match.solver === color ? "Solver" : "You";
      $(`${prefix}-${color}-sample`).textContent = `${rows.length} / ${expected} moves scored`;
      $(`${prefix}-${color}-qualifier`).textContent = !rows.length ? "No scored moves" : side.provisional ? "Provisional estimate" : "Accuracy estimate";
      for (const category of CATEGORIES) {
        const count = rows.filter((row) => row.classification === category).length;
        const cell = card.querySelector(`[data-category-count="${category}"]`);
        cell.dataset.count = String(count); cell.textContent = String(count);
      }
    }
    $(`${prefix}-coverage`).textContent = complete ? "Both sides use the same full-strength reference. Scores combine volatility-weighted and harmonic averages, independent of your playing difficulty."
      : !total ? "An imported board alone cannot reveal the accuracy of earlier moves."
      : `${scored} scored · ${unavailable} unscored · ${total - processed} waiting. Scores and classifications are provisional until analysis finishes.`;
    $(`${prefix}-error-box`).hidden = !record.error && !(processed === total && unavailable);
    $(`${prefix}-error`).textContent = record.error || `${unavailable} ${unavailable === 1 ? "move could" : "moves could"} not be scored. Retry those moves to finish the report.`;
    $(`${prefix}-retry`).textContent = record.error ? "Retry remaining moves" : "Retry unscored moves";
    $(`${prefix}-retry`).disabled = selectedKey() !== key;
    $(`${prefix}-moves-label`).textContent = `· ${scored} classified / ${total}`;
    renderRows(view, match, record);
  }

  function emitReviewRows() {
    if (!reviewActive || !validMatch(review)) { emitted = ""; return; }
    const record = recordFor(review);
    const signature = `${reviewSession}:${matchKey(review)}:${record.revision}`;
    if (signature === emitted) return;
    emitted = signature;
    window.dispatchEvent(new CustomEvent("knightfall:accuracy-results", { detail: {
      initialFen: review.initialFen, moves: [...review.moves], methodVersion: METHOD,
      rows: record.rows.map((row) => row ? { ...row, move: { ...row.move } } : null),
    } }));
  }

  function render() {
    ensureViews();
    for (const [name, view] of views) renderView(name, view);
    emitReviewRows();
  }

  function cancelActive() {
    if (!active || active.cancelled) return;
    const job = active;
    job.cancelled = true;
    job.controller.abort();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    job.stopped = fetch("/api/accuracy/stop", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: job.requestId }), signal: controller.signal }).catch(() => {}).finally(() => clearTimeout(timeout));
  }

  function isCurrent(job) { return job.generation === generation && job.key === selectedKey(); }

  async function pump() {
    if (active || !canRun()) return;
    const match = selectedMatch();
    const record = recordFor(match);
    const ply = record.rows.findIndex((row) => row === null) + 1;
    if (!ply) return;
    const job = { key: selectedKey(), generation, ply, initialFen: match.initialFen, moves: [...match.moves],
      requestId: `accuracy-${session}-${++serial}`, controller: new AbortController(), cancelled: false };
    active = job;
    render();
    const timeout = setTimeout(() => { job.timedOut = true; cancelActive(); }, 45000);
    try {
      const response = await fetch("/api/accuracy", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initialFen: job.initialFen, moves: job.moves, ply: job.ply, requestId: job.requestId }), signal: job.controller.signal });
      let result;
      try { result = await response.json(); } catch { throw new Error("The accuracy response could not be read. Retry this move."); }
      if (!response.ok || result.error) throw new Error(result.error || `Accuracy analysis failed (${response.status}).`);
      if (result.cancelled) {
        if (isCurrent(job) && !job.cancelled) throw new Error("Accuracy analysis was interrupted. Retry to resume.");
        return;
      }
      if (!isCurrent(job) || job.cancelled) return;
      if (result.requestId !== job.requestId || result.initialFen !== job.initialFen || JSON.stringify(result.moves) !== JSON.stringify(job.moves)
        || !validRow(result, selectedMatch(), job.ply)) throw new Error("The accuracy result did not match this move or scoring method. Retry to resume.");
      record.rows[job.ply - 1] = storedRow(result);
      record.revision++; record.updatedAt = Date.now(); record.error = "";
      persist();
    } catch (failure) {
      if (isCurrent(job) && (!job.cancelled || job.timedOut)) {
        record.error = job.timedOut ? "This move took too long to score. Retry to resume from the saved report."
          : failure instanceof TypeError ? "Cannot reach the accuracy server. Check that the local solver is running, then retry."
            : failure.message || "This move could not be scored. Retry to resume.";
      }
    } finally {
      clearTimeout(timeout);
      if (job.stopped) await job.stopped;
      if (active === job) active = null;
      render();
      void pump();
    }
  }

  function schedule() {
    const key = selectedKey();
    if (key !== lastKey) { generation++; lastKey = key; cancelActive(); }
    if (!canRun()) cancelActive();
    render();
    void pump();
  }

  window.addEventListener("knightfall:position", (event) => { live = event.detail; schedule(); });
  window.addEventListener("knightfall:accuracy-review", (event) => {
    const next = event.detail;
    if (next?.active === true && validMatch(next.match)) {
      if (!reviewActive || matchKey(next.match) !== matchKey(review)) reviewSession++;
      review = next.match; reviewActive = true;
    } else { review = null; reviewActive = false; }
    schedule();
  });
  document.addEventListener("visibilitychange", schedule);
  ensureViews();
  render();
})();
