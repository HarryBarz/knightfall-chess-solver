"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = "knightfall.workspace.v1";
  const files = "abcdefgh";
  const symbols = { wK: "♔", wQ: "♕", wR: "♖", wB: "♗", wN: "♘", wP: "♙", bK: "♚", bQ: "♛", bR: "♜", bB: "♝", bN: "♞", bP: "♟" };
  const names = { K: "king", Q: "queen", R: "rook", B: "bishop", N: "knight", P: "pawn" };
  const saved = readSaved();
  const settings = {
    solver: saved?.settings?.solver === "white" ? "white" : "black",
    auto: saved?.settings?.auto !== false,
    seconds: [1, 5, 15, 30, 60, 120].includes(saved?.settings?.seconds) ? saved.settings.seconds : 5,
    threads: validInteger(saved?.settings?.threads, 1, 512, 1),
    hashMb: validInteger(saved?.settings?.hashMb, 16, 65536, 128),
    multiPv: validInteger(saved?.settings?.multiPv, 1, 3, 1),
    flipped: saved?.settings?.flipped === true,
  };
  let state = null;
  let health = null;
  let busy = true;
  let selected = null;
  let focusSquare = "e2";
  let analysis = null;
  let activeSearch = null;
  let stoppingSearch = null;
  let operation = 0;
  let searchSerial = 0;
  let autoPaused = false;
  let importType = "fen";
  let promotionChoices = [];
  let messageTimer;
  let statusOverride = "";

  function readSaved() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      return value && typeof value === "object" ? value : null;
    } catch { return null; }
  }

  function save() {
    if (!state) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ initialFen: state.initialFen, moves: state.moves, settings }));
    } catch { /* Private browsing and full storage must not interrupt a game. */ }
  }

  function validInteger(value, min, max, fallback) {
    return Number.isInteger(Number(value)) && value !== null && value !== "" && Number(value) >= min && Number(value) <= max ? Number(value) : fallback;
  }

  function context() {
    return { initialFen: state.initialFen, moves: [...state.moves] };
  }

  async function api(path, body) {
    const options = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    let response;
    try { response = await fetch(path, options); }
    catch { throw new Error("Cannot reach the local server. Check that Knightfall is still running, then try again."); }
    let result;
    try { result = await response.json(); }
    catch { throw new Error(`The local server returned an unexpected response (${response.status}).`); }
    if (!response.ok || result.error) throw new Error(result.error || `Request failed (${response.status}).`);
    return result;
  }

  function notify(message, error = false, persistent = false) {
    clearTimeout(messageTimer);
    $("message").textContent = message;
    $("message").classList.toggle("error", error);
    $("message").hidden = !message;
    $("message").setAttribute("role", error ? "alert" : "status");
    if (message && !persistent) messageTimer = setTimeout(() => { $("message").hidden = true; }, error ? 12000 : 5000);
  }

  function available() { return health?.engineAvailable === true; }
  function interactive() { return Boolean(state && !busy && !activeSearch && !stoppingSearch && !state.outcome); }
  function resultApplicable() { return Boolean(analysis?.bestMove && !analysis.applied && state && analysis.positionFen === state.fen); }

  function render() {
    renderBoard();
    renderPlayers();
    renderHistory();
    renderAnalysis();
    renderControls();
  }

  function renderBoard() {
    const board = $("board");
    const hadBoardFocus = board.contains(document.activeElement);
    const oldFocus = document.activeElement?.dataset?.square;
    const legalTargets = new Set(selected && state ? state.legalMoves.filter((move) => move.from === selected).map((move) => move.to) : []);
    const lastMove = state?.moves?.at(-1);
    const best = resultApplicable() ? analysis.bestMove : null;
    const squares = [];
    const displayFiles = settings.flipped ? [...files].reverse() : [...files];
    const displayRanks = settings.flipped ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
    for (const [row, rank] of displayRanks.entries()) {
      for (const [col, file] of displayFiles.entries()) {
        const square = `${file}${rank}`;
        const piece = state?.pieces?.[square];
        const button = document.createElement("button");
        button.type = "button";
        button.className = "square";
        button.dataset.square = square;
        button.tabIndex = square === focusSquare ? 0 : -1;
        button.classList.toggle("dark", (files.indexOf(file) + rank) % 2 === 1);
        button.classList.toggle("has-piece", Boolean(piece));
        button.classList.toggle("selected", selected === square);
        button.classList.toggle("legal", legalTargets.has(square));
        button.classList.toggle("last-move", Boolean(lastMove && (lastMove.slice(0, 2) === square || lastMove.slice(2, 4) === square)));
        button.classList.toggle("best-square", Boolean(best && (best.slice(0, 2) === square || best.slice(2, 4) === square)));
        button.classList.toggle("in-check", Boolean(state?.check && piece === (state.turn === "white" ? "wK" : "bK")));
        button.setAttribute("aria-label", `${square}${piece ? `, ${piece[0] === "w" ? "white" : "black"} ${names[piece[1]]}` : ", empty"}${legalTargets.has(square) ? ", legal destination" : ""}${selected === square ? ", selected" : ""}`);
        button.setAttribute("aria-pressed", String(selected === square));
        button.setAttribute("aria-disabled", String(!interactive()));
        if (piece) {
          const img = document.createElement("img");
          img.src = `/api/pieces/${piece}.svg`;
          img.alt = "";
          img.draggable = false;
          img.addEventListener("error", () => {
            img.hidden = true;
            const fallback = document.createElement("span");
            fallback.className = "piece-fallback";
            fallback.textContent = symbols[piece];
            fallback.setAttribute("aria-hidden", "true");
            button.append(fallback);
          }, { once: true });
          button.append(img);
        }
        if (col === 0) button.append(coordinate(String(rank), "rank-coordinate"));
        if (row === 7) button.append(coordinate(file, "file-coordinate"));
        squares.push(button);
      }
    }
    board.replaceChildren(...squares);
    board.setAttribute("aria-busy", String(busy || Boolean(activeSearch) || Boolean(stoppingSearch)));
    if (hadBoardFocus) board.querySelector(`[data-square="${oldFocus || focusSquare}"]`)?.focus({ preventScroll: true });
  }

  function coordinate(text, className) {
    const span = document.createElement("span");
    span.className = `coordinate ${className}`;
    span.textContent = text;
    span.setAttribute("aria-hidden", "true");
    return span;
  }

  function renderPlayers() {
    const top = settings.flipped ? "white" : "black";
    const bottom = top === "white" ? "black" : "white";
    for (const [position, color] of [["top", top], ["bottom", bottom]]) {
      const isSolver = color === settings.solver;
      $(`${position}-player-name`).textContent = isSolver ? "Your engine" : "Your opponent";
      $(`${position}-player-detail`).textContent = `${capitalize(color)} · ${isSolver ? "Stockfish" : "Enter their moves"}`;
      $(`${position}-player-icon`).textContent = color === "white" ? "♔" : "♚";
      $(`${position}-player-icon`).classList.toggle("light-icon", color === "white");
    }
    $("top-player-badge").textContent = top === settings.solver ? "ENGINE" : "OPPONENT";
    $("turn-badge").textContent = !state ? "Loading position" : state.outcome ? state.outcome.result : activeSearch ? "Engine thinking…" : `${capitalize(state.turn)} to move${state.check ? " · Check" : ""}`;
  }

  function renderHistory() {
    const history = $("history");
    if (!state?.history?.length) {
      const empty = document.createElement("p");
      empty.className = "history-empty";
      empty.textContent = "Every good game starts with a first move.";
      history.replaceChildren(empty);
    } else {
      const rows = new Map();
      for (const [index, move] of state.history.entries()) {
        let row = rows.get(move.moveNumber);
        if (!row) {
          row = document.createElement("div");
          row.className = "history-row";
          for (const text of [`${move.moveNumber}.`, "…", "…"]) {
            const span = document.createElement("span");
            span.textContent = text;
            row.append(span);
          }
          rows.set(move.moveNumber, row);
        }
        const cell = row.children[move.turn === "white" ? 1 : 2];
        cell.classList.add("history-move");
        cell.textContent = move.san;
        cell.classList.toggle("latest", index === state.history.length - 1);
      }
      history.replaceChildren(...rows.values());
      history.scrollTop = history.scrollHeight;
    }
    const count = state?.history?.length || 0;
    $("move-count").textContent = `${count} ${count === 1 ? "ply" : "plies"}`;
    const result = state?.outcome;
    $("game-result").hidden = !result && !state?.claimableDraw;
    $("game-result").textContent = result ? `${result.result} · ${humanize(result.reason)}${result.winner ? ` · ${capitalize(result.winner)} wins` : ""}` : state?.claimableDraw ? `Draw may be claimed: ${humanize(state.claimableDraw)}.` : "";
  }

  function formatScore(score) {
    if (score?.mate !== null && score?.mate !== undefined) {
      if (score.mate === 0) return "Mate";
      return `${score.mate < 0 ? "−" : "+"}M${Math.abs(score.mate)}`;
    }
    if (score?.cp !== null && score?.cp !== undefined) {
      const value = score.cp / 100;
      return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(2)}`;
    }
    return "—";
  }

  function scoreDescription(score) {
    if (score?.mate !== null && score?.mate !== undefined) return score.mate === 0 ? "Checkmate in the analyzed position." : `${score.mate > 0 ? "White" : "Black"} has a forced mate in ${Math.abs(score.mate)}.`;
    if (score?.cp === null || score?.cp === undefined) return "No evaluation available.";
    if (Math.abs(score.cp) < 30) return "The position is approximately equal.";
    return `${score.cp > 0 ? "White" : "Black"} has the advantage.`;
  }

  function renderAnalysis() {
    const running = Boolean(activeSearch);
    $("thinking-dot").className = `status-dot${running ? " thinking" : available() ? " ready" : " error"}`;
    $("analysis-status").textContent = running ? activeSearch.autoPlay ? "Finding your reply" : "Reading the position" : statusOverride || (state?.outcome ? "Game complete" : !health ? "Getting ready" : !available() ? "Engine unavailable" : analysis ? "Analysis complete" : "Ready when you are");
    $("elapsed").hidden = !running;
    $("score").textContent = formatScore(analysis?.score);
    $("best-move").textContent = analysis?.bestSan || "—";
    $("depth").textContent = analysis?.depth ? String(analysis.depth) : "—";
    $("nodes").textContent = analysis?.nodes ? compactNumber(analysis.nodes) : "—";
    $("analysis-time").textContent = analysis?.timeMs !== undefined ? `${(analysis.timeMs / 1000).toFixed(1)}s` : "—";
    const isOld = Boolean(analysis && state && analysis.positionFen !== state.fen);
    const caption = analysis ? `${scoreDescription(analysis.score)}${isOld ? " Evaluation before the engine’s reply." : ""}` : state?.outcome ? humanize(state.outcome.reason) : "Play the first move to start the conversation.";
    $("analysis-caption").textContent = caption;
    const cp = analysis?.score?.cp;
    const mate = analysis?.score?.mate;
    let percent = typeof cp === "number" ? 50 + 46 * Math.tanh(cp / 550) : typeof mate === "number" ? mate > 0 ? 98 : mate < 0 ? 2 : 50 : 50;
    if (settings.flipped) percent = 100 - percent;
    $("evaluation-fill").style.height = `${percent}%`;
    $("evaluation-fill").style.background = settings.flipped ? "#2d3730" : "#fffdf1";
    $("evaluation-rail").style.background = settings.flipped ? "#fffdf1" : "#2d3730";
    $("evaluation-rail").setAttribute("aria-label", analysis ? `${formatScore(analysis.score)}, from White’s perspective. ${scoreDescription(analysis.score)}${isOld ? " Before the engine’s reply." : ""}` : "No engine evaluation yet");
    const variations = $("variations");
    variations.replaceChildren();
    variations.hidden = !analysis?.lines?.length;
    for (const line of analysis?.lines || []) {
      const row = document.createElement("div");
      row.className = "variation";
      const score = document.createElement("span");
      score.className = "variation-score";
      score.textContent = formatScore(line.score);
      const moves = document.createElement("span");
      moves.className = "variation-moves";
      moves.textContent = formatVariation(line.pv || [], analysis.positionFen);
      row.append(score, moves);
      variations.append(row);
    }
  }

  function renderControls() {
    const running = Boolean(activeSearch);
    $("move-input").disabled = !interactive();
    $("submit-move").disabled = !interactive();
    $("undo").disabled = busy || !state?.moves?.length;
    $("new-game").disabled = busy;
    $("import").disabled = busy;
    $("copy-fen").disabled = !state;
    $("export-pgn").disabled = !state;
    $("analyze").hidden = running;
    $("analyze").disabled = busy || Boolean(stoppingSearch) || !state || Boolean(state.outcome) || !available();
    $("stop").hidden = !running && !stoppingSearch;
    $("stop").disabled = Boolean(stoppingSearch);
    $("stop").textContent = stoppingSearch ? "Stopping…" : "Stop analysis";
    $("play-best").hidden = !resultApplicable() || running;
    $("play-best").disabled = !interactive();
    $("auto-reply").checked = settings.auto;
    $("auto-reply").disabled = busy;
    for (const color of ["white", "black"]) {
      $(`solver-${color}`).classList.toggle("active", settings.solver === color);
      $(`solver-${color}`).setAttribute("aria-pressed", String(settings.solver === color));
      $(`solver-${color}`).disabled = busy;
    }
    for (const button of document.querySelectorAll("[data-seconds]")) {
      const active = Number(button.dataset.seconds) === settings.seconds;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
      button.disabled = running;
    }
    $("time-description").textContent = `${settings.seconds} sec / move`;
    $("threads").value = settings.threads;
    $("hash").value = settings.hashMb;
    $("multipv").value = settings.multiPv;
    for (const id of ["threads", "hash", "multipv"]) $(id).disabled = running;
  }

  function formatVariation(pv, fen) {
    const fields = (fen || "").split(" ");
    let number = Number(fields[5]) || 1;
    let white = fields[1] !== "b";
    const result = [];
    for (const [index, san] of pv.slice(0, 10).entries()) {
      if (white) result.push(`${number}.`);
      else if (index === 0) result.push(`${number}…`);
      result.push(san);
      if (!white) number++;
      white = !white;
    }
    if (pv.length > 10) result.push("…");
    return result.join(" ");
  }

  function compactNumber(value) {
    return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
  }
  function capitalize(value) { return value ? value[0].toUpperCase() + value.slice(1) : ""; }
  function humanize(value) { return capitalize(String(value || "").toLowerCase().replaceAll("_", " ")); }

  async function cancelSearch() {
    const old = activeSearch;
    activeSearch = null;
    if (!old) { if (stoppingSearch) await stoppingSearch; return; }
    clearInterval(old.timer);
    const promise = api("/api/stop", { requestId: old.id })
      .catch((error) => notify(error.message, true))
      .then(async () => {
        // The stop endpoint requests cancellation. The search response marks
        // completion and releases the engine for the next request.
        try { await old.pending; } catch { /* The cancelled search owns its error. */ }
      })
      .finally(() => {
        if (stoppingSearch === promise) stoppingSearch = null;
        render();
      });
    stoppingSearch = promise;
    render();
    await promise;
  }

  async function transition(fetchPosition, { auto = true, preserveAnalysis = false } = {}) {
    if (busy) return false;
    busy = true;
    const ticket = ++operation;
    selected = null;
    $("promotion-dialog").close();
    renderControls();
    try {
      await cancelSearch();
      const next = await fetchPosition();
      if (ticket !== operation) return false;
      state = next;
      statusOverride = "";
      autoPaused = !auto;
      if (!preserveAnalysis) analysis = null;
      save();
      return true;
    } catch (error) {
      if (ticket === operation) notify(error.message, true);
      return false;
    } finally {
      if (ticket === operation) {
        busy = false;
        render();
        if (auto) maybeAutomaticallyReply();
      }
    }
  }

  async function makeMove(move, { engine = false } = {}) {
    if (!state || busy || (!engine && activeSearch)) return false;
    const position = context();
    const previous = analysis;
    if (engine && previous) previous.applied = true;
    const success = await transition(() => api("/api/move", { ...position, move }), { preserveAnalysis: engine });
    if (!success && previous) {
      previous.applied = false;
      render();
    }
    if (success) $("move-input").value = "";
    return success;
  }

  function maybeAutomaticallyReply() {
    if (state && available() && !busy && !activeSearch && !stoppingSearch && !autoPaused && settings.auto && state.turn === settings.solver && !state.outcome) {
      void analyzePosition(true);
    }
  }

  async function analyzePosition(autoPlay) {
    if (!state || busy || activeSearch || stoppingSearch || state.outcome || !available()) return;
    autoPaused = false;
    statusOverride = "";
    selected = null;
    const id = `knightfall-${Date.now()}-${++searchSerial}`;
    const fen = state.fen;
    const ticket = operation;
    const start = performance.now();
    const search = { id, fen, autoPlay, timer: null };
    activeSearch = search;
    $("elapsed").textContent = "0.0s";
    search.timer = setInterval(() => {
      if (activeSearch !== search) return;
      const seconds = (performance.now() - start) / 1000;
      $("elapsed").textContent = `${seconds.toFixed(1)}s / ${settings.seconds}s`;
    }, 100);
    render();
    try {
      search.pending = api("/api/analyze", { ...context(), seconds: settings.seconds, threads: settings.threads, hashMb: settings.hashMb, multiPv: settings.multiPv, requestId: id });
      const response = await search.pending;
      if (activeSearch !== search || ticket !== operation || state.fen !== fen || response.requestId !== id || response.positionFen !== fen) return;
      clearInterval(search.timer);
      activeSearch = null;
      if (response.cancelled) {
        autoPaused = true;
        statusOverride = "Analysis stopped";
        render();
        return;
      }
      analysis = { ...response, applied: false };
      if (autoPlay && settings.auto && state.turn === settings.solver && response.bestMove) {
        render();
        await makeMove(response.bestMove, { engine: true });
      } else render();
    } catch (error) {
      if (activeSearch !== search) return;
      clearInterval(search.timer);
      activeSearch = null;
      autoPaused = true;
      statusOverride = "Analysis interrupted";
      notify(error.message, true);
      render();
    }
  }

  function onSquare(square) {
    if (!interactive()) return;
    focusSquare = square;
    const possible = selected ? state.legalMoves.filter((move) => move.from === selected && move.to === square) : [];
    if (possible.length === 1) {
      selected = null;
      void makeMove(possible[0].uci);
      return;
    }
    if (possible.length > 1) {
      openPromotion(possible);
      return;
    }
    const isOwnPiece = state.pieces[square]?.[0] === state.turn[0];
    selected = isOwnPiece && square !== selected ? square : null;
    renderBoard();
  }

  function openPromotion(choices) {
    promotionChoices = choices;
    const fragment = document.createDocumentFragment();
    for (const promotion of ["q", "r", "b", "n"]) {
      const choice = choices.find((move) => move.promotion === promotion);
      if (!choice) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "promotion-option";
      button.dataset.promotion = promotion;
      const img = document.createElement("img");
      img.src = `/api/pieces/${state.turn[0]}${promotion.toUpperCase()}.svg`;
      img.alt = "";
      const label = document.createElement("span");
      label.textContent = capitalize(names[promotion.toUpperCase()]);
      button.append(img, label);
      fragment.append(button);
    }
    $("promotion-options").replaceChildren(fragment);
    $("promotion-dialog").showModal();
  }

  $("board").addEventListener("click", (event) => {
    const square = event.target.closest("[data-square]");
    if (square) onSquare(square.dataset.square);
  });

  $("board").addEventListener("keydown", (event) => {
    const source = event.target.closest("[data-square]");
    if (!source) return;
    if (event.key === "Escape") { selected = null; renderBoard(); return; }
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    let file = files.indexOf(source.dataset.square[0]);
    let rank = Number(source.dataset.square[1]);
    const direction = settings.flipped ? -1 : 1;
    if (event.key === "ArrowUp") rank += direction;
    if (event.key === "ArrowDown") rank -= direction;
    if (event.key === "ArrowRight") file += direction;
    if (event.key === "ArrowLeft") file -= direction;
    if (event.key === "Home") file = settings.flipped ? 7 : 0;
    if (event.key === "End") file = settings.flipped ? 0 : 7;
    if (file < 0 || file > 7 || rank < 1 || rank > 8) return;
    focusSquare = `${files[file]}${rank}`;
    source.tabIndex = -1;
    const target = $("board").querySelector(`[data-square="${focusSquare}"]`);
    target.tabIndex = 0;
    target.focus({ preventScroll: true });
  });

  $("move-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const move = $("move-input").value.trim();
    if (move && interactive()) void makeMove(move);
  });

  $("promotion-options").addEventListener("click", (event) => {
    const promotion = event.target.closest("[data-promotion]")?.dataset.promotion;
    const choice = promotionChoices.find((move) => move.promotion === promotion);
    if (!choice) return;
    $("promotion-dialog").close();
    selected = null;
    void makeMove(choice.uci);
  });
  $("close-promotion").addEventListener("click", () => $("promotion-dialog").close());

  $("analyze").addEventListener("click", () => {
    const autoPlay = settings.auto && state.turn === settings.solver;
    void analyzePosition(autoPlay);
  });
  $("play-best").addEventListener("click", () => {
    if (resultApplicable() && interactive()) void makeMove(analysis.bestMove, { engine: true });
  });
  $("stop").addEventListener("click", async () => {
    autoPaused = true;
    statusOverride = "Analysis stopped · ready to resume";
    await cancelSearch();
    render();
  });
  $("new-game").addEventListener("click", () => {
    void transition(() => api("/api/position", { moves: [] }));
  });
  $("undo").addEventListener("click", () => {
    if (!state?.moves.length || busy) return;
    const previous = context();
    const last = state.history.at(-1);
    const pair = settings.auto && last?.turn === settings.solver && previous.moves.length >= 2;
    previous.moves.splice(-Math.min(pair ? 2 : 1, previous.moves.length));
    void transition(() => api("/api/position", previous), { auto: false });
  });
  $("flip").addEventListener("click", () => {
    settings.flipped = !settings.flipped;
    save();
    renderBoard();
    renderPlayers();
    renderAnalysis();
  });

  for (const color of ["white", "black"]) {
    $(`solver-${color}`).addEventListener("click", async () => {
      if (busy || settings.solver === color) return;
      settings.solver = color;
      autoPaused = false;
      statusOverride = "";
      save();
      await cancelSearch();
      render();
      maybeAutomaticallyReply();
    });
  }
  $("auto-reply").addEventListener("change", async (event) => {
    settings.auto = event.target.checked;
    autoPaused = false;
    statusOverride = "";
    save();
    await cancelSearch();
    render();
    maybeAutomaticallyReply();
  });
  for (const button of document.querySelectorAll("[data-seconds]")) {
    button.addEventListener("click", () => {
      if (activeSearch) return;
      settings.seconds = Number(button.dataset.seconds);
      save();
      renderControls();
    });
  }
  for (const [id, key, min, defaultMax] of [["threads", "threads", 1, 16], ["hash", "hashMb", 16, 2048], ["multipv", "multiPv", 1, 3]]) {
    $(id).addEventListener("change", () => {
      const max = Number($(id).max) || defaultMax;
      const candidate = Number($(id).value);
      if (!Number.isInteger(candidate) || candidate < min || candidate > max) {
        notify(`Choose ${id === "threads" ? "CPU threads" : id === "hash" ? "hash memory" : "candidate lines"} between ${min} and ${max}.`, true);
      } else settings[key] = candidate;
      save();
      renderControls();
    });
  }

  $("import").addEventListener("click", () => {
    $("import-error").hidden = true;
    $("import-dialog").showModal();
    $("import-text").focus();
  });
  $("close-import").addEventListener("click", () => $("import-dialog").close());
  for (const button of document.querySelectorAll("[data-import-type]")) {
    button.addEventListener("click", () => {
      importType = button.dataset.importType;
      for (const option of document.querySelectorAll("[data-import-type]")) {
        option.classList.toggle("active", option === button);
        option.setAttribute("aria-pressed", String(option === button));
      }
      $("import-text").placeholder = `Paste your ${importType.toUpperCase()} here…`;
      $("import-error").hidden = true;
    });
  }
  $("import-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const value = $("import-text").value.trim();
    if (!value) return;
    $("submit-import").disabled = true;
    $("import-error").hidden = true;
    const success = await transition(async () => {
      try { return await api("/api/import", { [importType]: value }); }
      catch (error) {
        $("import-error").textContent = error.message;
        $("import-error").hidden = false;
        throw error;
      }
    });
    $("submit-import").disabled = false;
    if (success) { $("import-dialog").close(); $("import-text").value = ""; }
  });

  $("copy-fen").addEventListener("click", async () => {
    if (!state) return;
    try {
      await copyText(state.fen);
      notify("Position copied as FEN.");
    } catch { notify("Could not access the clipboard. Use Export PGN to save your game.", true); }
  });
  async function copyText(text) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
    const field = document.createElement("textarea");
    field.value = text;
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    const copied = document.execCommand("copy");
    field.remove();
    if (!copied) throw new Error("Copy failed");
  }
  $("export-pgn").addEventListener("click", () => {
    if (!state) return;
    const blob = new Blob([state.pgn], { type: "application/x-chess-pgn;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `knightfall-${new Date().toISOString().slice(0, 10)}.pgn`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify("Game exported as PGN.");
  });

  async function initialize() {
    render();
    const restore = saved && Array.isArray(saved.moves) && typeof saved.initialFen === "string" ? { initialFen: saved.initialFen, moves: saved.moves } : { moves: [] };
    const results = await Promise.allSettled([api("/api/health"), api("/api/position", restore)]);
    if (results[0].status === "fulfilled") {
      health = results[0].value;
      $("connection-dot").className = `status-dot ${available() ? "ready" : "error"}`;
      $("connection-label").textContent = available() ? "Local engine · Connected" : "Local server · Engine unavailable";
      $("engine-tag").textContent = health.engineName || "STOCKFISH";
      $("engine-tag").title = health.engineName || "Stockfish";
      $("threads").max = health.maxThreads || 16;
      $("hash").max = health.maxHashMb || 2048;
      settings.threads = validInteger(saved?.settings?.threads, 1, Number($("threads").max), health.defaultThreads || 1);
      settings.hashMb = validInteger(saved?.settings?.hashMb, 16, Number($("hash").max), health.defaultHashMb || 128);
      if (!available()) notify("Stockfish is not available. Install it and restart the local server to enable engine analysis. You can still set up positions and enter legal moves.", true, true);
    } else {
      $("connection-dot").className = "status-dot error";
      $("connection-label").textContent = "Local server unavailable";
      notify(results[0].reason.message, true, true);
    }
    if (results[1].status === "fulfilled") state = results[1].value;
    else {
      try {
        state = await api("/api/position", { moves: [] });
        notify("The saved game could not be restored. A fresh board is ready.", true);
      } catch (error) { notify(error.message, true, true); }
    }
    busy = false;
    save();
    render();
    maybeAutomaticallyReply();
  }

  void initialize();
})();
