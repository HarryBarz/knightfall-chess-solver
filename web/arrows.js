"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const storageKey = "knightfall.arrows.v1";
  const session = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const NS = "http://www.w3.org/2000/svg";
  const palette = { white: "#ffdb70", black: "#7dd8ff" };
  const cache = new Map();
  const views = new Map();
  let prefs = { enabled: false, white: true, black: true, lookahead: 3 };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (saved) prefs = { enabled: saved.enabled === true, white: saved.white !== false, black: saved.black !== false,
      lookahead: [2, 3, 4, 6].includes(saved.lookahead) ? saved.lookahead : 3 };
  } catch { /* An unavailable store must not prevent play. */ }
  let live = null;
  let review = null;
  let reviewActive = false;
  let active = null;
  let pending = null;
  let timer = null;
  let timerKey = "";
  let serial = 0;
  let error = "";
  let errorKey = "";
  let lastContext = "";

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svg(tag, attributes = {}) {
    const node = document.createElementNS(NS, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    return node;
  }

  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify(prefs)); } catch { /* Preferences still work for this session. */ }
  }

  function current() { return reviewActive ? review : live; }
  function contextName() { return reviewActive ? "review" : "live"; }
  function colorName(color) { return color === "black" ? "Black" : "White"; }
  function enabledColor(color) { return color === "white" ? prefs.white : color === "black" ? prefs.black : false; }
  function keyOf(position) {
    return position?.fen && position?.initialFen ? JSON.stringify([position.initialFen, position.moves || [], position.fen,
      Number(position.strength) || 70, Boolean(position.forgiving), prefs.lookahead]) : "";
  }
  function key() { return keyOf(current()); }
  function canRequest() {
    const position = current();
    return Boolean(prefs.enabled && (prefs.white || prefs.black) && position?.fen && position?.initialFen
      && position.ready !== false && !position.suspended && !document.hidden);
  }

  function createView(name, board, host) {
    if (!board || !host || views.has(name)) return;
    const prefix = name === "review" ? "review-arrows" : "arrows";
    let wrap = board.parentElement;
    if (wrap.id !== "board-canvas" && !wrap.classList.contains("arrow-board-wrap")) {
      wrap = el("div", "arrow-board-wrap");
      board.before(wrap);
      wrap.append(board);
    }
    wrap.classList.add("arrow-board-wrap");
    const overlay = svg("svg", { viewBox: "0 0 800 800", preserveAspectRatio: "none", "aria-hidden": "true", class: "analysis-arrow-overlay" });
    overlay.id = `${prefix}-overlay`;
    overlay.setAttribute("hidden", "");
    wrap.append(overlay);
    const panel = el("section", "arrows-panel");
    panel.setAttribute("aria-label", "Analysis arrows and possible plans");
    panel.innerHTML = `
      <div class="arrows-heading"><label class="arrows-master" for="${prefix}-enabled"><span><strong>Analysis arrows</strong><small>See attacks and possible plans</small></span><span class="switch"><input id="${prefix}-enabled" type="checkbox"><span class="switch-track"></span></span></label></div>
      <div id="${prefix}-settings" class="arrows-settings" hidden>
        <div class="arrows-colors" role="group" aria-label="Show arrows for each side"><button id="${prefix}-white" type="button" class="arrows-color" data-color="white" aria-pressed="true"><span aria-hidden="true"></span>White</button><button id="${prefix}-black" type="button" class="arrows-color" data-color="black" aria-pressed="true"><span aria-hidden="true"></span>Black</button></div>
        <label class="arrows-horizon" for="${prefix}-lookahead">Look ahead<select id="${prefix}-lookahead"><option value="2">2 turns</option><option value="3">3 turns</option><option value="4">4 turns</option><option value="6">6 turns</option></select></label>
      </div>
      <p id="${prefix}-status" class="arrows-status" role="status" aria-live="polite"></p>
      <div id="${prefix}-body" hidden>
        <div id="${prefix}-mode" class="arrows-mode" role="group" aria-label="Arrow explanation mode"><button id="${prefix}-mode-ideas" type="button" aria-pressed="true">Attacks & coordination</button><button id="${prefix}-mode-line" type="button" aria-pressed="false">Possible line</button></div>
        <p id="${prefix}-profile" class="arrows-profile"></p>
        <div id="${prefix}-ideas" class="arrows-ideas" aria-label="Choose a plan to see its arrows"></div>
        <article id="${prefix}-detail" class="arrows-detail" hidden><p id="${prefix}-kind" class="arrows-kind"></p><h3 id="${prefix}-title"></h3><p id="${prefix}-explanation"></p><p id="${prefix}-arrow-note" class="arrows-arrow-note"></p><div id="${prefix}-other-idea" class="arrows-other-idea" hidden></div></article>
        <div id="${prefix}-line" class="arrows-line" hidden></div>
        <p id="${prefix}-empty" class="arrows-empty" hidden></p>
        <p class="arrows-legend"><span><i class="arrows-solid" aria-hidden="true"></i>Current attack / support</span><span><i class="arrows-dashed" aria-hidden="true"></i>Numbered = projected turn</span></p>
        <p class="arrows-method">These are possible plans, not a player’s private intent. Each turn is one side’s move; the line depends on both sides’ replies.</p>
        <div id="${prefix}-notes" class="arrows-notes"></div>
      </div>
      <div id="${prefix}-error-box" class="arrows-error-box" hidden><p id="${prefix}-error"></p><button id="${prefix}-retry" type="button">Retry arrows</button></div>`;
    host.append(panel);
    const view = { name, prefix, board, overlay, panel, mode: "ideas", selectedId: "", selectedIds: { white: "", black: "" }, lineStep: 0, ideaThrough: null, key: "", contentKey: "" };
    views.set(name, view);
    $(`${prefix}-enabled`).addEventListener("change", (event) => {
      prefs.enabled = event.target.checked;
      if (prefs.enabled) { error = ""; errorKey = ""; }
      save(); schedule();
    });
    for (const color of ["white", "black"]) $(`${prefix}-${color}`).addEventListener("click", () => {
      prefs[color] = !prefs[color]; save(); schedule();
    });
    $(`${prefix}-lookahead`).addEventListener("change", (event) => { prefs.lookahead = Number(event.target.value); save(); schedule(); });
    for (const mode of ["ideas", "line"]) $(`${prefix}-mode-${mode}`).addEventListener("click", () => {
      view.mode = mode; view.contentKey = ""; render();
    });
    $(`${prefix}-retry`).addEventListener("click", () => { cache.delete(key()); error = ""; errorKey = ""; schedule(); });
  }

  function ensureViews() {
    let liveHost = $("analysis-arrows-host");
    if (!liveHost && $("board")) {
      liveHost = el("div");
      liveHost.id = "analysis-arrows-host";
      (document.querySelector(".board-footnote") || $("board").parentElement).after(liveHost);
    }
    createView("live", $("board"), liveHost);
    let reviewHost = $("review-analysis-arrows-host");
    if (!reviewHost && $("review-board")) {
      reviewHost = el("div");
      reviewHost.id = "review-analysis-arrows-host";
      (document.querySelector(".review-playback-help") || $("review-board")).after(reviewHost);
    }
    createView("review", $("review-board"), reviewHost);
  }

  function validArrow(arrow) {
    return /^[a-h][1-8]$/.test(arrow?.from) && /^[a-h][1-8]$/.test(arrow?.to) && arrow.from !== arrow.to;
  }

  function center(square, flipped) {
    const file = "abcdefgh".indexOf(square[0]);
    const rank = Number(square[1]) - 1;
    return flipped ? [(7 - file) * 100 + 50, rank * 100 + 50] : [file * 100 + 50, (7 - rank) * 100 + 50];
  }

  function draw(view, arrows, position) {
    const overlay = view.overlay;
    overlay.replaceChildren();
    const visible = arrows.filter((arrow) => validArrow(arrow) && enabledColor(arrow.color)).slice(0, 6);
    overlay.toggleAttribute("hidden", !visible.length);
    overlay.dataset.positionFen = position?.fen || "";
    overlay.dataset.fen = position?.fen || "";
    overlay.dataset.flipped = String(Boolean(position?.flipped));
    if (!visible.length) return;
    const defs = svg("defs");
    for (const color of ["white", "black"]) {
      const marker = svg("marker", { id: `${view.prefix}-head-${color}`, markerWidth: 3, markerHeight: 3, refX: 2.4, refY: 1.5, orient: "auto", markerUnits: "strokeWidth" });
      marker.append(svg("path", { d: "M0,0 L3,1.5 L0,3 Z", fill: palette[color], stroke: "#171b1d", "stroke-width": 0.12 }));
      defs.append(marker);
    }
    overlay.append(defs);
    const labels = [];
    visible.forEach((arrow) => {
      const [x1, y1] = center(arrow.from, position.flipped);
      const [x2, y2] = center(arrow.to, position.flipped);
      const length = Math.hypot(x2 - x1, y2 - y1);
      const ux = (x2 - x1) / length, uy = (y2 - y1) / length;
      const projected = arrow.kind === "plan" || Number.isFinite(arrow.step);
      const path = `M ${x1 + ux * 13} ${y1 + uy * 13} L ${x2 - ux * 21} ${y2 - uy * 21}`;
      const group = svg("g", { class: `analysis-arrow ${projected ? "analysis-arrow-plan" : "analysis-arrow-current"}`, "data-from": arrow.from,
        "data-to": arrow.to, "data-arrow-from": arrow.from, "data-arrow-to": arrow.to, "data-color": arrow.color, "data-kind": arrow.kind || "attack", "data-step": arrow.step || "",
        "data-start-x": x1, "data-start-y": y1, "data-end-x": x2, "data-end-y": y2 });
      const attributes = { d: path, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" };
      if (projected) attributes["stroke-dasharray"] = "18 12";
      group.append(svg("path", { ...attributes, stroke: "#17201ecc", "stroke-width": 15 }));
      group.append(svg("path", { ...attributes, stroke: palette[arrow.color], "stroke-width": 9, "marker-end": `url(#${view.prefix}-head-${arrow.color})` }));
      group.append(svg("circle", { cx: x1, cy: y1, r: arrow.kind === "support" ? 11 : 7, fill: arrow.kind === "support" ? "#202724" : palette[arrow.color], stroke: palette[arrow.color], "stroke-width": 4 }));
      overlay.append(group);
      if (projected && arrow.step) {
        const badge = svg("g", { class: "analysis-arrow-step" });
        // Put labels by the start so repeated destinations remain distinguishable.
        const bx = x1 + ux * Math.min(47, length * .45), by = y1 + uy * Math.min(47, length * .45);
        badge.append(svg("circle", { cx: bx, cy: by, r: 17, fill: "#202724", stroke: palette[arrow.color], "stroke-width": 3 }));
        const text = svg("text", { x: bx, y: by + 1, fill: palette[arrow.color], "text-anchor": "middle", "dominant-baseline": "central", "font-size": 22, "font-weight": 750 });
        text.textContent = String(arrow.step);
        badge.append(text);
        labels.push(badge);
      }
    });
    overlay.append(...labels);
  }

  function stepsFor(result, idea, view) {
    // A side's plan still depends on the opponent's intervening replies.
    return view.mode === "line" || idea?.kind === "plan" ? (result.line || []) : (idea?.steps || []);
  }

  function stepArrow(step, index) {
    const move = step.move || step.uci || "";
    return { from: move.slice(0, 2), to: move.slice(2, 4), color: step.color || (step.beforeFen?.split(" ")[1] === "b" ? "black" : "white"), kind: "plan", step: step.ply || index + 1, beforeFen: step.beforeFen };
  }

  function renderContent(view, result, position) {
    const prefix = view.prefix;
    const candidates = (result.ideas || []).filter((idea) => enabledColor(idea.color));
    for (const color of ["white", "black"]) {
      if (!enabledColor(color)) continue;
      if (!candidates.some((idea) => idea.id === view.selectedIds[color] && idea.color === color)) {
        const currentIdea = candidates.find((idea) => idea.color === color && (idea.arrows || []).some((arrow) =>
          validArrow(arrow) && arrow.kind !== "plan" && !Number.isFinite(arrow.step)));
        view.selectedIds[color] = (currentIdea || candidates.find((idea) => idea.color === color))?.id || "";
      }
    }
    const selectedIdeas = ["white", "black"].filter(enabledColor).map((color) => candidates.find((idea) => idea.id === view.selectedIds[color])).filter(Boolean);
    if (!selectedIdeas.some((idea) => idea.id === view.selectedId)) view.selectedId = selectedIdeas[0]?.id || "";
    const idea = candidates.find((item) => item.id === view.selectedId);
    const steps = stepsFor(result, idea, view);
    view.lineStep = Math.max(0, Math.min(view.lineStep, steps.length - 1));
    const contentKey = JSON.stringify([keyOf(position), view.mode, view.selectedId, view.selectedIds, view.lineStep, view.ideaThrough, prefs.white, prefs.black]);
    const lineMode = view.mode === "line";
    let arrows = [];
    if (lineMode) arrows = steps.slice(0, view.lineStep + 1).map(stepArrow);
    else arrows = selectedIdeas.flatMap((item) => (item.arrows || []).filter((arrow) => enabledColor(arrow.color || item.color)
      && (view.ideaThrough === null || !arrow.step || arrow.step <= view.ideaThrough)).slice(0, selectedIdeas.length > 1 ? 3 : 6).map((arrow) => ({ ...arrow, color: arrow.color || item.color })));
    draw(view, arrows, position);
    if (view.contentKey === contentKey) return;
    view.contentKey = contentKey;
    for (const mode of ["ideas", "line"]) $(`${prefix}-mode-${mode}`).setAttribute("aria-pressed", String(view.mode === mode));
    const strength = Number(position.strength) || 70;
    $(`${prefix}-profile`).textContent = `${view.name === "review" ? "Review" : "Playing"} profile · ${strength}% strength${position.forgiving ? " · Forgiving" : ""}. White: gold arrows · Black: blue arrows.`;
    $(`${prefix}-ideas`).hidden = lineMode;
    $(`${prefix}-ideas`).replaceChildren(...candidates.map((item) => {
      const button = el("button", "arrows-idea");
      button.type = "button";
      button.dataset.idea = item.id;
      button.dataset.color = item.color;
      button.setAttribute("aria-pressed", String(item.id === view.selectedIds[item.color]));
      button.append(el("span", "arrows-idea-side", colorName(item.color)), el("span", "", item.title || "Possible plan"));
      button.addEventListener("click", () => { view.selectedId = item.id; view.selectedIds[item.color] = item.id; view.lineStep = 0; view.ideaThrough = null; view.contentKey = ""; render(); });
      return button;
    }));
    $(`${prefix}-detail`).hidden = !lineMode && !idea;
    $(`${prefix}-kind`).textContent = lineMode ? "A POSSIBLE CONTINUATION" : `${colorName(idea?.color)} · ${idea?.kind || "plan"}`;
    $(`${prefix}-title`).textContent = lineMode ? `Looking ahead · up to ${prefs.lookahead} turns` : (idea?.title || "");
    $(`${prefix}-explanation`).textContent = lineMode ? "Follow the numbered turns in order. Select a turn to draw the line up to that point. Future arrows can start on squares that are empty now because an earlier projected move puts a piece there." : (idea?.explanation || "");
    const otherIdea = !lineMode ? selectedIdeas.find((item) => item.id !== idea?.id) : null;
    const otherPanel = $(`${prefix}-other-idea`);
    otherPanel.hidden = !otherIdea;
    otherPanel.replaceChildren(...(otherIdea ? [el("strong", "", `Also on the board · ${otherIdea.title}`), el("p", "", otherIdea.explanation || "")] : []));
    const projected = arrows.some((arrow) => arrow.kind === "plan" || Number.isFinite(arrow.step));
    const count = selectedIdeas.reduce((sum, item) => sum + (item.arrows || []).length, 0);
    $(`${prefix}-arrow-note`).textContent = projected ? "Dashed arrows are conditional future moves, not attacks that already exist on this board."
      : count > arrows.length ? "Showing the main arrows for each selected idea to keep the board readable. Support arrows start with a ring." : "Solid arrows show the selected ideas on the current board. Support arrows start with a ring.";
    $(`${prefix}-arrow-note`).hidden = !arrows.length;
    const line = $(`${prefix}-line`);
    line.hidden = !steps.length;
    line.replaceChildren(...steps.map((step, index) => {
      const color = step.color || (step.beforeFen?.split(" ")[1] === "b" ? "black" : "white");
      const row = el("div", "arrows-line-row");
      const button = el("button", "arrows-line-step");
      button.type = "button";
      const stepNumber = step.ply || index + 1;
      button.dataset.step = String(stepNumber);
      button.dataset.color = color;
      button.setAttribute("aria-pressed", String(lineMode ? index === view.lineStep : stepNumber === view.ideaThrough));
      button.setAttribute("aria-label", `Show projected line through turn ${stepNumber}: ${colorName(color)} ${step.san || step.move || step.uci || "move"}`);
      button.append(el("span", "arrows-step-number", String(stepNumber)), el("strong", "", step.san || step.move || step.uci || "Move"), el("span", "arrows-step-side", `${colorName(color)}${enabledColor(color) ? "" : " · arrow hidden"}`));
      button.addEventListener("click", () => {
        if (!lineMode) {
          view.ideaThrough = stepNumber;
        } else view.lineStep = index;
        view.contentKey = "";
        render();
      });
      row.append(button);
      const explanation = step.explanation || step.summary || "";
      if (explanation) row.append(el("p", "", explanation));
      if (step.reasons?.length && !explanation) row.append(el("p", "", step.reasons.join(" ")));
      return row;
    }));
    $(`${prefix}-empty`).hidden = lineMode ? Boolean(steps.length) : Boolean(candidates.length);
    $(`${prefix}-empty`).textContent = lineMode ? "No further projected turns are available from this position. The game may have ended."
      : "No highlighted attack or coordinated plan for the selected side in this position. Try Possible line, or show the other side.";
    const notes = Array.isArray(result.notes) ? result.notes : result.notes ? [result.notes] : [];
    $(`${prefix}-notes`).replaceChildren(...notes.filter((note) => typeof note === "string").map((note) => el("p", "", note)));
  }

  function render() {
    ensureViews();
    for (const view of views.values()) {
      const prefix = view.prefix;
      const isActive = view.name === contextName();
      const position = isActive ? current() : null;
      const currentKey = keyOf(position);
      const result = currentKey ? cache.get(currentKey) : null;
      const loading = Boolean(isActive && ((active?.key === currentKey && !active.cancelled) || pending?.key === currentKey || timer));
      const failure = isActive && errorKey === currentKey ? error : "";
      $(`${prefix}-enabled`).checked = prefs.enabled;
      for (const color of ["white", "black"]) $(`${prefix}-${color}`).setAttribute("aria-pressed", String(prefs[color]));
      $(`${prefix}-lookahead`).value = String(prefs.lookahead);
      $(`${prefix}-settings`).hidden = !prefs.enabled;
      const show = Boolean(isActive && prefs.enabled && (prefs.white || prefs.black) && result && position.ready !== false);
      $(`${prefix}-body`).hidden = !show;
      $(`${prefix}-error-box`).hidden = !prefs.enabled || !prefs.white && !prefs.black || !failure;
      $(`${prefix}-error`).textContent = failure;
      view.panel.setAttribute("aria-busy", String(prefs.enabled && loading));
      let status = "Off · Turn on to explore both sides’ ideas.";
      if (prefs.enabled) {
        if (!isActive) status = reviewActive ? "Following the match review board." : "Open a match to explore its positions.";
        else if (!prefs.white && !prefs.black) status = "Choose White, Black, or both to show arrows.";
        else if (!position?.fen || position.ready === false) status = "Waiting for a ready board and engine.";
        else if (failure) status = "Arrows could not finish.";
        else if (result) status = "Ready · Choose an idea or follow a possible line.";
        else if (position.suspended) status = "Waiting for the current move or analysis to finish…";
        else if (loading) status = "Finding attacks and possible plans…";
        else status = "Preparing this position…";
      }
      $(`${prefix}-status`).textContent = status;
      if (view.key !== currentKey) { view.key = currentKey; view.contentKey = ""; view.selectedId = ""; view.selectedIds = { white: "", black: "" }; view.lineStep = 0; view.ideaThrough = null; }
      if (show) renderContent(view, result, position);
      else { view.overlay.replaceChildren(); view.overlay.setAttribute("hidden", ""); view.contentKey = ""; }
    }
  }

  function cancelActive() {
    if (!active || active.cancelled) return;
    const job = active;
    job.cancelled = true;
    job.controller.abort();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    job.stopped = fetch("/api/arrows/stop", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: job.requestId }), signal: controller.signal }).catch(() => {}).finally(() => clearTimeout(timeout));
  }

  function isCurrent(job) { return job.key === key() && job.context === contextName() && canRequest(); }

  function matches(job, result) {
    return !job.cancelled && isCurrent(job) && result.requestId === job.requestId && result.initialFen === job.initialFen
      && JSON.stringify(result.moves) === JSON.stringify(job.moves) && result.positionFen === job.fen
      && result.strength === job.strength && result.forgiving === job.forgiving && result.lookahead === job.lookahead;
  }

  async function pump() {
    if (active || !pending) return;
    const job = pending;
    pending = null;
    if (!isCurrent(job)) { render(); return; }
    active = job;
    render();
    const timeout = setTimeout(() => { job.timedOut = true; cancelActive(); }, 40000);
    try {
      const response = await fetch("/api/arrows", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initialFen: job.initialFen, moves: job.moves, requestId: job.requestId, strength: job.strength, forgiving: job.forgiving, lookahead: job.lookahead }), signal: job.controller.signal });
      let result;
      try { result = await response.json(); } catch { throw new Error("The arrow analysis was unreadable. Please retry."); }
      if (!response.ok || result.error) throw new Error(result.error || `Arrow analysis failed (${response.status}).`);
      if (result.cancelled) {
        if (!job.cancelled && isCurrent(job)) throw new Error("Arrow analysis was interrupted. Please retry.");
        return;
      }
      if (matches(job, result)) {
        cache.delete(job.key); cache.set(job.key, result);
        if (cache.size > 100) cache.delete(cache.keys().next().value);
        error = ""; errorKey = "";
        for (const view of views.values()) view.contentKey = "";
      } else if (!job.cancelled && isCurrent(job)) throw new Error("The analysis did not match this board position. Please retry.");
    } catch (failure) {
      if (isCurrent(job) && (!job.cancelled || job.timedOut)) {
        errorKey = job.key;
        error = job.timedOut ? "This position took too long to analyze. Please retry."
          : failure instanceof TypeError ? "Cannot reach the server. Check that the local solver is running, then retry." : failure.message || "Arrow analysis could not finish. Please retry.";
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
    const currentKey = key();
    const context = contextName();
    if (timer && timerKey === `${context}:${currentKey}` && canRequest() && !cache.has(currentKey)) { render(); return; }
    clearTimeout(timer); timer = null; timerKey = "";
    if (`${context}:${currentKey}` !== lastContext) {
      lastContext = `${context}:${currentKey}`;
      error = ""; errorKey = "";
    }
    if (!canRequest() || cache.has(currentKey)) {
      pending = null; cancelActive(); render(); return;
    }
    if (active?.key === currentKey && active.context === context && !active.cancelled || pending?.key === currentKey && pending.context === context) { render(); return; }
    pending = null;
    cancelActive();
    if (error && errorKey === currentKey) { render(); return; }
    timerKey = `${context}:${currentKey}`;
    timer = setTimeout(() => {
      timer = null; timerKey = "";
      if (!canRequest() || currentKey !== key() || context !== contextName()) { render(); return; }
      const position = current();
      pending = { key: currentKey, context, requestId: `arrows-${session}-${++serial}`, initialFen: position.initialFen, moves: [...(position.moves || [])],
        fen: position.fen, strength: Number(position.strength) || 70, forgiving: Boolean(position.forgiving), lookahead: prefs.lookahead,
        controller: new AbortController(), cancelled: false };
      render(); void pump();
    }, 180);
    render();
  }

  window.addEventListener("knightfall:position", (event) => { live = event.detail; schedule(); });
  window.addEventListener("knightfall:review-position", (event) => {
    reviewActive = event.detail?.active === true;
    review = reviewActive ? event.detail : null;
    schedule();
  });
  document.addEventListener("visibilitychange", schedule);
  window.addEventListener("storage", (event) => {
    if (event.key !== storageKey) return;
    try {
      const saved = JSON.parse(event.newValue || "null");
      if (!saved) return;
      prefs = { enabled: saved.enabled === true, white: saved.white !== false, black: saved.black !== false,
        lookahead: [2, 3, 4, 6].includes(saved.lookahead) ? saved.lookahead : 3 };
      schedule();
    } catch { /* Ignore invalid preferences from another tab. */ }
  });
  ensureViews();
  render();
})();
