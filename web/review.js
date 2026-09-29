"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const dialog = document.createElement("dialog");
  dialog.id = "match-review-dialog";
  dialog.setAttribute("aria-labelledby", "review-heading");
  dialog.innerHTML = `
    <header class="review-heading">
      <div><p class="eyebrow">THE GAME, EXPLAINED</p><h2 id="review-heading">Match review</h2><p id="review-match-description"></p></div>
      <button id="review-close" type="button" class="review-close" aria-label="Close match review" autofocus>×</button>
    </header>
    <div id="review-accuracy-report-host" hidden></div>
    <div class="review-layout">
      <section class="review-replay" aria-label="Replay board and controls">
        <div class="review-board-heading"><span id="review-board-label">Starting position</span><button id="review-flip" type="button">Flip board</button></div>
        <div id="review-board" class="review-board" role="img" aria-label="Match review board"></div>
        <div id="review-preview" class="review-preview" hidden><p id="review-preview-description"></p><button id="review-return" type="button">Return to played position</button></div>
        <nav class="review-navigation" aria-label="Move navigation">
          <button id="review-first" type="button" aria-label="Go to starting position" title="Starting position">|‹</button>
          <button id="review-prev" type="button" aria-label="Previous move" title="Previous move">‹</button>
          <button id="review-play" type="button" aria-label="Play review" aria-pressed="false">▶ Play review</button>
          <button id="review-next" type="button" aria-label="Next move" title="Next move">›</button>
          <button id="review-last" type="button" aria-label="Go to last move" title="Last move">›|</button>
        </nav>
        <div class="review-playback-settings"><label for="review-move">Position<select id="review-move"></select></label><label for="review-speed">Reading time<select id="review-speed"><option value="2">2 seconds</option><option value="4" selected>4 seconds</option><option value="8">8 seconds</option></select></label></div>
        <p class="review-playback-help">Replay waits for each explanation, then gives you time to read. Use ← and → to move at your own pace.</p>
        <div class="review-move-list-heading"><h3>Moves played</h3><span id="review-progress"></span></div>
        <div id="review-move-list" class="review-move-list" aria-label="All played moves"></div>
      </section>
      <section class="review-notes" aria-label="Move explanations">
        <div class="review-analysis-settings"><label for="review-lookahead">Look ahead<select id="review-lookahead"><option value="2">2 turns</option><option value="3">3 turns</option><option value="4" selected>4 turns</option><option value="6">6 turns</option><option value="8">8 turns</option></select></label><label for="review-strength">Review teacher<select id="review-strength"><option value="match">Match strength</option><option value="full">Full-strength teacher</option></select></label></div>
        <p id="review-profile" class="review-profile"></p>
        <p class="review-method">Plans explain what a move supports, not anyone’s private thoughts. Each step is one side’s turn, not the engine’s search depth. Projected lines can change if either side chooses another move.</p>
        <p id="review-status" class="review-status" role="status" aria-live="polite"></p>
        <div id="review-error-box" class="review-error-box" hidden><p id="review-error" role="alert"></p><button id="review-retry" type="button" class="button button-outline">Retry this move</button></div>
        <div id="review-overview" class="review-overview"><p class="eyebrow">START AT THE BEGINNING</p><h3 id="review-overview-title">Every move, with a reason.</h3><p id="review-overview-text"></p><div class="review-overview-guide"><p><strong>Understand the solver.</strong> Follow its move, likely plan, and the next few turns it could be working toward.</p><p><strong>Learn from your moves.</strong> See what your move achieved, what it risked, and a useful correction when one is available.</p><p><strong>Explore the possibilities.</strong> Click any continuation step to preview its board, then return to the match.</p></div><button id="review-begin" type="button" class="button button-primary">Review the first move <span aria-hidden="true">→</span></button></div>
        <article id="review-content" hidden>
          <div class="review-move-heading"><span id="review-owner" class="review-owner"></span><span id="review-verdict" class="review-verdict"></span></div>
          <p id="review-accuracy-detail" class="review-profile" hidden></p>
          <h3 id="review-title"></h3><p id="review-summary" class="review-summary"></p>
          <section class="review-detail"><h4>What the move changes</h4><ul id="review-reasons"></ul></section>
          <section class="review-detail review-plan-box"><h4>Likely plan</h4><p id="review-plan"></p></section>
          <section class="review-detail"><h4>Assessment & correction</h4><p id="review-assessment"></p><p id="review-verdict-detail"></p></section>
          <section class="review-detail"><h4 id="review-continuation-title">Possible next turns</h4><p id="review-continuation-note" class="review-section-help">An engine projection from the played position. Click a step to explore it.</p><div id="review-continuation" class="review-line"></div></section>
          <section id="review-correction-section" class="review-detail" hidden><h4>A useful alternative</h4><p id="review-correction-description"></p><div id="review-correction" class="review-line"></div></section>
          <section class="review-detail"><h4>What actually happened next</h4><p class="review-section-help">The recorded match, separate from the engine’s projection.</p><div id="review-actual" class="review-line"></div></section>
        </article>
      </section>
    </div>`;
  document.body.append(dialog);

  const notes = new Map();
  const session = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const pieceNames = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
  let snapshot = null;
  let ply = 0;
  let generation = 0;
  let serial = 0;
  let active = null;
  let pending = null;
  let error = "";
  let playing = false;
  let playTimer = null;
  let preview = null;
  let flipped = false;
  let opener = null;
  let boardKey = "";
  let contentKey = "";
  let historyController = null;
  let accuracyRows = [];

  function el(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  }

  function profile() {
    return $("review-strength").value === "full" ? { strength: 100, forgiving: false }
      : { strength: Number(snapshot?.strength) || 70, forgiving: Boolean(snapshot?.forgiving) };
  }

  function key() {
    return snapshot && ply ? JSON.stringify([snapshot.initialFen, snapshot.moves, ply, Number($("review-lookahead").value), profile()]) : "";
  }

  function owner(color) { return color === snapshot.solver ? "Solver" : "You"; }

  function moveLabel(index) {
    if (!index) return "Starting position";
    const move = snapshot.history[index - 1];
    return move ? `${move.moveNumber}${move.turn === "black" ? "..." : "."} ${move.san}` : `${index}. ${snapshot.moves[index - 1]}`;
  }

  function selectedFen() {
    if (!ply) return snapshot.initialFen;
    return notes.get(key())?.afterFen || snapshot.history[ply - 1]?.afterFen
      || (ply === snapshot.moves.length ? snapshot.fen : "");
  }

  function renderBoard() {
    const fen = preview?.step.fen || selectedFen();
    const move = preview?.step.move || preview?.step.uci || snapshot.moves[ply - 1] || "";
    const nextKey = JSON.stringify([fen, move, flipped, ply, preview?.kind, preview?.index]);
    if (nextKey === boardKey) return;
    boardKey = nextKey;
    const board = $("review-board");
    board.dataset.fen = fen;
    board.dataset.ply = String(ply);
    board.dataset.preview = preview?.kind || "";
    const pieces = new Map();
    if (fen) {
      for (const [rankIndex, row] of fen.split(" ")[0].split("/").entries()) {
        let file = 0;
        for (const value of row) {
          if (/^[1-8]$/.test(value)) file += Number(value);
          else pieces.set(`${"abcdefgh"[file++]}${8 - rankIndex}`, value);
        }
      }
    }
    const fragment = document.createDocumentFragment();
    const ranks = flipped ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
    const files = (flipped ? "hgfedcba" : "abcdefgh").split("");
    for (const [row, rank] of ranks.entries()) for (const [column, file] of files.entries()) {
      const squareName = `${file}${rank}`;
      const piece = pieces.get(squareName);
      const square = el("div", `review-square${("abcdefgh".indexOf(file) + rank) % 2 ? " dark" : ""}`);
      square.dataset.square = squareName;
      square.dataset.piece = piece ? `${piece === piece.toUpperCase() ? "w" : "b"}${piece.toUpperCase()}` : "";
      square.classList.toggle("last-move", squareName === move.slice(0, 2) || squareName === move.slice(2, 4));
      square.title = `${squareName}: ${piece ? `${piece === piece.toUpperCase() ? "White" : "Black"} ${pieceNames[piece.toLowerCase()]}` : "empty"}`;
      if (piece) {
        const img = document.createElement("img");
        img.src = `/api/pieces/${square.dataset.piece}.svg`;
        img.alt = square.title;
        img.draggable = false;
        square.append(img);
      }
      if (column === 0) square.append(el("span", "review-rank", String(rank)));
      if (row === 7) square.append(el("span", "review-file", file));
      fragment.append(square);
    }
    board.replaceChildren(fragment);
    const label = preview ? `${preview.kind === "projection" ? "Projected" : preview.kind === "correction" ? "Alternative" : "Recorded"} step ${preview.index + 1}: ${preview.step.san || move}` : moveLabel(ply);
    $("review-board-label").textContent = fen ? label : "Preparing replay position…";
    board.setAttribute("aria-label", `${label}. ${flipped ? "Black" : "White"} at the bottom.${fen ? ` Board position: ${fen.split(" ")[0]}` : " Board is loading."}`);
    $("review-preview").hidden = !preview;
    $("review-preview-description").textContent = preview ? `${label}. ${preview.step.summary || (preview.kind === "actual" ? "This move was played in your match." : "This position belongs to a possible continuation.")}` : "";
  }

  function stepLabel(step) {
    const parts = (step.beforeFen || "").split(" ");
    const color = step.color || (parts[1] === "b" ? "black" : "white");
    const number = parts[5] ? `${parts[5]}${color === "black" ? "..." : "."} ` : "";
    return `${number}${step.san || step.move || step.uci || "Move"}`;
  }

  function renderLine(id, steps, kind, emptyText) {
    const container = $(id);
    if (!steps?.length) { container.replaceChildren(el("p", "review-line-empty", emptyText)); return; }
    const rows = steps.map((step, index) => {
      const row = el("div", "review-line-step");
      const button = el("button", "review-step-button");
      button.type = "button";
      button.dataset.reviewLine = kind;
      button.dataset.step = String(index);
      button.disabled = !step.fen;
      button.setAttribute("aria-pressed", "false");
      button.append(el("span", "review-step-number", String(index + 1)), el("strong", "", stepLabel(step)), el("span", "review-step-owner", owner(step.color || (step.beforeFen?.split(" ")[1] === "b" ? "black" : "white"))));
      button.addEventListener("click", () => {
        pause();
        preview = { kind, index, step };
        render();
      });
      row.append(button);
      if (step.summary && !step.reasons?.length) row.append(el("p", "review-step-summary", step.summary));
      if (step.reasons?.length) {
        const reasons = el("ul", "review-step-reasons");
        reasons.append(...step.reasons.map((reason) => el("li", "", reason)));
        row.append(reasons);
      }
      return row;
    });
    container.replaceChildren(...rows);
  }

  function renderNote(note) {
    const nextKey = key();
    if (contentKey === nextKey) return;
    contentKey = nextKey;
    const color = note.move?.color || snapshot.history[ply - 1]?.turn || "white";
    $("review-owner").textContent = `${owner(color)} · ${color === "white" ? "White" : "Black"}`;
    $("review-owner").dataset.owner = owner(color).toLowerCase();
    $("review-title").textContent = moveLabel(ply);
    const summary = note.summary || `${owner(color)} played ${note.move?.san || snapshot.moves[ply - 1]}.`;
    const leadingReason = note.reasons?.[0];
    $("review-summary").textContent = leadingReason && !summary.includes(leadingReason) ? `${summary} ${leadingReason}` : summary;
    $("review-reasons").replaceChildren(...(note.reasons || []).map((reason) => el("li", "", reason)));
    $("review-plan").textContent = note.plan || "Follow the continuation below to see what this move could be preparing. The position may support several plans.";
    $("review-assessment").textContent = note.assessment || "The engine compares this move with other choices from the same position.";
    $("review-verdict").textContent = note.verdict?.label || "Move reviewed";
    $("review-verdict-detail").textContent = note.verdict?.detail || "";
    $("review-verdict-detail").hidden = !note.verdict?.detail || Boolean(note.assessment?.includes(note.verdict.detail));
    $("review-continuation-title").textContent = `Looking ahead · up to ${$("review-lookahead").value} turns`;
    $("review-continuation-note").textContent = `${note.continuationNote || "An engine projection from the played position."} Click a step to explore it.`;
    renderLine("review-continuation", note.continuation, "projection", "No further continuation is available from this position. The game may have ended.");
    $("review-correction-section").hidden = !note.correction;
    $("review-correction-description").textContent = note.correction ? `${note.correction.san || note.correction.move}: ${note.correction.explanation || "Compare this alternative with the move played."} This line starts from before the played move.` : "";
    renderLine("review-correction", note.correction?.continuation, "correction", "No alternative continuation available.");
    renderLine("review-actual", note.actualContinuation, "actual", ply === snapshot.moves.length ? "This is the final recorded move of the match." : "No recorded continuation available.");
  }

  function render() {
    if (!snapshot || !dialog.open) return;
    const count = snapshot.moves.length;
    const note = notes.get(key());
    const loading = Boolean(ply && !note && !error && ((active?.key === key() && !active.cancelled) || pending?.key === key()));
    dialog.setAttribute("aria-busy", String(loading));
    dialog.dataset.ply = String(ply);
    $("review-move").value = String(ply);
    $("review-first").disabled = ply === 0;
    $("review-prev").disabled = ply === 0;
    $("review-next").disabled = ply >= count;
    $("review-last").disabled = ply >= count;
    $("review-play").disabled = !count || (ply === count && !playing) || Boolean(error);
    $("review-play").textContent = playing ? "Ⅱ Pause review" : "▶ Play review";
    $("review-play").setAttribute("aria-label", playing ? "Pause review" : "Play review");
    $("review-play").setAttribute("aria-pressed", String(playing));
    $("review-begin").hidden = !count;
    $("review-progress").textContent = `${ply} / ${count} turns`;
    $("review-error-box").hidden = !error;
    $("review-error").hidden = !error;
    $("review-error").textContent = error;
    $("review-content").hidden = !ply || !note;
    $("review-overview").hidden = ply > 0;
    $("review-status").textContent = error ? "Review could not finish" : !ply ? (count ? "Ready to explore your match" : "No moves have been recorded yet")
      : loading ? `Reviewing ${moveLabel(ply)}…` : note ? (playing ? "Review ready · Playing" : "Review ready") : "Preparing the selected move…";
    const settings = profile();
    $("review-profile").textContent = `${settings.strength}% review strength${settings.forgiving ? " · Forgiving" : ""}. These review settings do not change how your match is played.`;
    for (const button of $("review-move-list").querySelectorAll("button")) {
      const selected = Number(button.dataset.reviewPly) === ply;
      button.classList.toggle("selected", selected);
      if (selected) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
    }
    if (note && ply) {
      renderNote(note);
      const grade = accuracyRows.find((row) => row?.ply === ply && row.scored);
      $("review-verdict").textContent = grade ? `${grade.classification} · accuracy` : note.verdict?.label || "Move reviewed";
      $("review-accuracy-detail").hidden = !grade;
      $("review-accuracy-detail").textContent = grade ? `Full-strength accuracy report: ${grade.expectedPointsLoss.toFixed(3)} expected points lost. Local estimate using Chess.com’s published category thresholds.` : "";
    }
    for (const button of dialog.querySelectorAll("[data-review-line]")) {
      button.setAttribute("aria-pressed", String(Boolean(preview && button.dataset.reviewLine === preview.kind && Number(button.dataset.step) === preview.index)));
    }
    renderBoard();
    publishReviewPosition();
    schedulePlayback();
  }

  function publishReviewPosition() {
    if (!snapshot || !dialog.open) return;
    const fen = preview?.step.fen || selectedFen();
    window.dispatchEvent(new CustomEvent("knightfall:review-position", { detail: {
      active: true, ready: Boolean(fen), fen, flipped, ...profile(),
      initialFen: preview ? fen : snapshot.initialFen,
      moves: preview ? [] : snapshot.moves.slice(0, ply),
      history: preview ? [] : snapshot.history.slice(0, ply),
    } }));
  }

  function stopTimer() { clearTimeout(playTimer); playTimer = null; }
  function pause() { playing = false; stopTimer(); }

  function schedulePlayback() {
    if (!playing || playTimer || !dialog.open || document.hidden || error || preview) return;
    if (ply >= snapshot.moves.length) { pause(); return; }
    if (ply && !notes.has(key())) return;
    playTimer = setTimeout(() => {
      playTimer = null;
      if (playing && dialog.open && !document.hidden) select(ply + 1, true);
    }, Number($("review-speed").value) * 1000);
  }

  function cancelActive() {
    if (!active || active.cancelled) return;
    const job = active;
    job.cancelled = true;
    job.controller.abort();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    job.stopped = fetch("/api/review/stop", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: job.requestId }), signal: controller.signal,
    }).catch(() => {}).finally(() => clearTimeout(timeout));
  }

  function cancelWork() { pending = null; cancelActive(); }

  function isCurrent(job) { return dialog.open && generation === job.generation && job.key === key(); }

  function matches(job, result) {
    return isCurrent(job) && !job.cancelled && result.requestId === job.requestId
      && result.initialFen === job.initialFen && JSON.stringify(result.moves) === JSON.stringify(job.moves)
      && result.ply === job.ply && result.lookahead === job.lookahead
      && result.strength === job.strength && result.forgiving === job.forgiving
      && (!snapshot.history[job.ply - 1]?.afterFen || result.afterFen === snapshot.history[job.ply - 1].afterFen);
  }

  async function pump() {
    if (active || !pending) return;
    const job = pending;
    pending = null;
    active = job;
    render();
    const timeout = setTimeout(() => { job.timedOut = true; cancelActive(); }, 40000);
    try {
      const response = await fetch("/api/review", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initialFen: job.initialFen, moves: job.moves, ply: job.ply, lookahead: job.lookahead, requestId: job.requestId, strength: job.strength, forgiving: job.forgiving }),
        signal: job.controller.signal,
      });
      let result;
      try { result = await response.json(); }
      catch { throw new Error("The server returned an unreadable review. Try this move again."); }
      if (!response.ok || result.error) throw new Error(result.error || `Review failed (${response.status}).`);
      if (result.cancelled) {
        if (isCurrent(job) && !job.cancelled) throw new Error("The review was interrupted. Try this move again.");
        return;
      }
      if (matches(job, result)) {
        notes.delete(job.key);
        notes.set(job.key, result);
        if (notes.size > 240) notes.delete(notes.keys().next().value);
        error = "";
        contentKey = "";
      } else if (isCurrent(job) && !job.cancelled) throw new Error("The review did not match the selected move. Try again.");
    } catch (failure) {
      if (isCurrent(job) && (!job.cancelled || job.timedOut)) {
        pause();
        error = job.timedOut ? "This move review took too long. Try again."
          : failure instanceof TypeError ? "Cannot reach the review server. Check that the local app is running, then retry."
            : failure.message || "This move could not be reviewed. Try again.";
      }
    } finally {
      clearTimeout(timeout);
      if (job.stopped) await job.stopped;
      if (active === job) active = null;
      render();
      void pump();
    }
  }

  function requestNote(force = false) {
    error = "";
    const currentKey = key();
    if (!currentKey || (!force && notes.has(currentKey))) {
      cancelWork();
      render();
      return;
    }
    if (!force && ((active?.key === currentKey && !active.cancelled && active.generation === generation) || pending?.key === currentKey)) { render(); return; }
    if (force) { notes.delete(currentKey); contentKey = ""; }
    pending = {
      key: currentKey, requestId: `review-${session}-${++serial}`, generation,
      initialFen: snapshot.initialFen, moves: [...snapshot.moves], ply,
      lookahead: Number($("review-lookahead").value), ...profile(), controller: new AbortController(), cancelled: false,
    };
    cancelActive();
    render();
    void pump();
  }

  function select(index, automatic = false) {
    if (!snapshot || !dialog.open) return;
    if (!automatic) pause();
    stopTimer();
    ply = Math.max(0, Math.min(snapshot.moves.length, Number(index) || 0));
    if (ply === snapshot.moves.length) pause();
    preview = null;
    requestNote();
    const selected = $("review-move-list").querySelector(`[data-review-ply="${ply}"]`);
    if (selected) $("review-move-list").scrollTop = Math.max(0, selected.offsetTop - $("review-move-list").offsetTop - 30);
  }

  function buildHistory() {
    const options = [el("option", "", "Starting position")];
    options[0].value = "0";
    const buttons = [];
    for (let index = 1; index <= snapshot.moves.length; index++) {
      const option = el("option", "", `${moveLabel(index)} · ${owner(snapshot.history[index - 1]?.turn || "white")}`);
      option.value = String(index);
      options.push(option);
      const button = el("button", "", moveLabel(index));
      button.type = "button";
      button.dataset.reviewPly = String(index);
      button.title = `${owner(snapshot.history[index - 1]?.turn || "white")}: ${moveLabel(index)}`;
      button.addEventListener("click", () => select(index));
      buttons.push(button);
    }
    $("review-move").replaceChildren(...options);
    $("review-move-list").replaceChildren(...(buttons.length ? buttons : [el("p", "", "Your recorded moves will appear here.")]));
  }

  async function restoreHistory(epoch) {
    if (!snapshot.moves.length || snapshot.history.length === snapshot.moves.length && snapshot.history.every((move) => move.afterFen)) return;
    const controller = new AbortController();
    historyController = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch("/api/position", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initialFen: snapshot.initialFen, moves: snapshot.moves }), signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok || result.error) throw new Error(result.error || "Could not restore the recorded positions.");
      if (epoch !== generation || !dialog.open) return;
      if (result.initialFen !== snapshot.initialFen || JSON.stringify(result.moves) !== JSON.stringify(snapshot.moves)) throw new Error("The restored positions did not match this match.");
      snapshot.history = result.history;
      window.dispatchEvent(new CustomEvent("knightfall:accuracy-review", { detail: { active: true, match: structuredClone(snapshot) } }));
      buildHistory();
      render();
    } catch {
      // Each move review also supplies the authoritative position; navigation can still proceed.
    } finally {
      clearTimeout(timeout);
      if (historyController === controller) historyController = null;
    }
  }

  function open(detail) {
    if (!detail || typeof detail.initialFen !== "string" || !Array.isArray(detail.moves)) {
      window.dispatchEvent(new CustomEvent("knightfall:review-close"));
      return;
    }
    cancelWork();
    historyController?.abort();
    pause();
    generation++;
    if (!dialog.open) opener = document.activeElement;
    snapshot = JSON.parse(JSON.stringify(detail));
    accuracyRows = [];
    snapshot.history = Array.isArray(snapshot.history) ? snapshot.history : [];
    snapshot.solver = snapshot.solver === "white" ? "white" : "black";
    flipped = Boolean(snapshot.flipped);
    ply = 0;
    preview = null;
    error = "";
    boardKey = "";
    contentKey = "";
    $("review-strength").value = snapshot.reviewStrength === 100 || snapshot.reviewStrength === "full" ? "full" : "match";
    $("review-strength").querySelector('[value="match"]').textContent = `Match strength · ${Number(snapshot.strength) || 70}%`;
    const result = snapshot.outcome ? `${snapshot.outcome.result || "Match finished"}${snapshot.outcome.reason ? ` · ${snapshot.outcome.reason}` : ""}` : "Match in progress";
    $("review-match-description").textContent = `${result} · ${snapshot.moves.length} recorded turns · You played ${snapshot.solver === "white" ? "Black" : "White"}`;
    $("review-overview-title").textContent = snapshot.moves.length ? "Every move, with a reason." : "Your starting position.";
    $("review-overview-text").textContent = snapshot.moves.length ? "Begin with the first move, jump to a turning point, or play through the match. Both sides get the same careful explanation."
      : "There are no recorded moves to replay yet. If you imported a position or screenshot, earlier moves are not included. Play from this position, then return to review your match.";
    buildHistory();
    if (!dialog.open) dialog.showModal();
    window.dispatchEvent(new CustomEvent("knightfall:accuracy-review", { detail: { active: true, match: structuredClone(snapshot) } }));
    render();
    $("review-close").focus();
    void restoreHistory(generation);
  }

  $("review-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    generation++;
    pause();
    cancelWork();
    historyController?.abort();
    preview = null;
    window.dispatchEvent(new CustomEvent("knightfall:accuracy-review", { detail: { active: false } }));
    window.dispatchEvent(new CustomEvent("knightfall:review-position", { detail: { active: false } }));
    window.dispatchEvent(new CustomEvent("knightfall:review-close"));
    if (opener?.isConnected && !opener.disabled) opener.focus();
  });
  $("review-first").addEventListener("click", () => select(0));
  $("review-prev").addEventListener("click", () => select(ply - 1));
  $("review-next").addEventListener("click", () => select(ply + 1));
  $("review-last").addEventListener("click", () => select(snapshot.moves.length));
  $("review-begin").addEventListener("click", () => select(1));
  $("review-move").addEventListener("change", (event) => select(event.target.value));
  $("review-play").addEventListener("click", () => {
    if (playing) pause();
    else {
      playing = true;
      preview = null;
      if (!ply) { select(1, true); return; }
      if (!notes.has(key())) requestNote();
    }
    render();
  });
  $("review-speed").addEventListener("change", () => { stopTimer(); render(); });
  for (const id of ["review-lookahead", "review-strength"]) $(id).addEventListener("change", () => { pause(); preview = null; requestNote(); });
  $("review-retry").addEventListener("click", () => requestNote(true));
  $("review-return").addEventListener("click", () => { preview = null; render(); });
  $("review-flip").addEventListener("click", () => { flipped = !flipped; renderBoard(); publishReviewPosition(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) { pause(); render(); } });
  dialog.addEventListener("keydown", (event) => {
    if (event.altKey || event.metaKey || event.ctrlKey || event.target.matches("select, input, textarea")) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      select(ply + (event.key === "ArrowLeft" ? -1 : 1));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      select(event.key === "Home" ? 0 : snapshot.moves.length);
    }
  });
  window.addEventListener("knightfall:review-open", (event) => open(event.detail));
  window.addEventListener("knightfall:accuracy-select", (event) => {
    const index = event.detail?.ply;
    if (dialog.open && snapshot && Number.isInteger(index) && index >= 1 && index <= snapshot.moves.length) {
      select(index);
      dialog.querySelector(".review-layout").scrollIntoView({ block: "start", behavior: "smooth" });
    }
  });
  window.addEventListener("knightfall:accuracy-results", (event) => {
    const report = event.detail;
    if (!dialog.open || !snapshot || !report || report.initialFen !== snapshot.initialFen || JSON.stringify(report.moves) !== JSON.stringify(snapshot.moves) || !Array.isArray(report.rows)) return;
    accuracyRows = report.rows.filter((row) => row && row.move?.uci === snapshot.moves[row.ply - 1] && Number.isFinite(row.expectedPointsLoss));
    render();
  });
})();
