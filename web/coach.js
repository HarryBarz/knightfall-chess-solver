"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  if (!$("coach-panel")) return;

  const notes = new Map();
  const sessionId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let position = null;
  let selectedPly = 0;
  let active = null;
  let pending = null;
  let serial = 0;
  let error = "";
  let moveOptionsKey = "";

  function profileKey(value) {
    return JSON.stringify([value.initialFen, value.strength, value.forgiving]);
  }

  function noteKey(value, ply) {
    return JSON.stringify([profileKey(value), value.moves.slice(0, ply)]);
  }

  function currentKey() {
    return position && selectedPly ? noteKey(position, selectedPly) : "";
  }

  function moveLabel(ply) {
    const move = position?.history[ply - 1];
    if (!move) return position?.moves[ply - 1] || "Move review";
    return `${move.moveNumber}${move.turn === "black" ? "..." : "."} ${move.san}`;
  }

  function scoreText(score) {
    if (Number.isFinite(score?.mate)) {
      return score.mate === 0 ? "Checkmate" : `${score.mate < 0 ? "-" : "+"}M${Math.abs(score.mate)}`;
    }
    if (Number.isFinite(score?.cp)) {
      return `${score.cp > 0 ? "+" : ""}${(score.cp / 100).toFixed(2)}`;
    }
    return "";
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderNote(note) {
    $("coach-title").textContent = moveLabel(selectedPly);
    $("coach-summary").textContent = note.summary || "";
    $("coach-reasons").replaceChildren(...(note.reasons || []).map((reason) => element("li", "", reason)));
    $("coach-assessment").textContent = note.assessment || "";
    $("coach-assessment").hidden = !note.assessment;
    const rows = (note.alternatives || []).map((alternative) => {
      const row = element("div", "coach-alternative");
      const heading = element("div", "coach-alternative-heading");
      heading.append(element("strong", "", alternative.san || alternative.move || "Alternative"));
      const score = scoreText(alternative.score);
      if (score) {
        const evaluation = element("span", "coach-score", score);
        evaluation.setAttribute("aria-label", `Evaluation from White's perspective: ${score}`);
        evaluation.title = "Evaluation from White's perspective";
        heading.append(evaluation);
      }
      row.append(heading);
      if (alternative.reason) row.append(element("p", "", alternative.reason));
      if (alternative.pv?.length) row.append(element("p", "coach-line", alternative.pv.slice(0, 10).join(" ")));
      return row;
    });
    $("coach-alternatives").replaceChildren(...rows);
    $("coach-alternatives").hidden = rows.length === 0;
    const alternativesSection = $("coach-alternatives").closest(".coach-alternatives-section");
    if (alternativesSection) alternativesSection.hidden = rows.length === 0;
  }

  function render() {
    const count = position?.moves.length || 0;
    const key = currentKey();
    const note = notes.get(key);
    const loading = Boolean((active && !active.cancelled && active.key === key) || pending?.key === key);
    const optionsKey = JSON.stringify([position?.initialFen, position?.moves]);
    if (optionsKey !== moveOptionsKey) {
      moveOptionsKey = optionsKey;
      const options = count ? Array.from({ length: count }, (_, index) => {
        const option = element("option", "", moveLabel(index + 1));
        option.value = String(index + 1);
        return option;
      }) : [element("option", "", "No moves yet")];
      if (!count) options[0].value = "0";
      $("coach-move").replaceChildren(...options);
    }
    $("coach-move").value = String(selectedPly);
    $("coach-move").disabled = !count;
    $("coach-prev").disabled = selectedPly <= 1;
    $("coach-next").disabled = !count || selectedPly >= count;
    $("coach-refresh").disabled = !selectedPly || !position?.ready || loading;
    $("coach-panel").setAttribute("aria-busy", String(loading));
    $("coach-strength").textContent = position ? `${position.strength}% strength${position.forgiving ? " / Forgiving" : ""}` : "";
    $("coach-error").textContent = error;
    $("coach-error").hidden = !error;
    $("coach-content").hidden = !note;
    $("coach-empty").hidden = Boolean(note);
    if (note) renderNote(note);
    else $("coach-empty").textContent = !count ? "No moves yet." : loading ? `Reviewing ${moveLabel(selectedPly)}...` : "No move note yet.";

    let status = "Waiting for the position";
    if (position) {
      if (!position.ready) status = "Move review unavailable";
      else if (loading) status = `Reviewing ${moveLabel(selectedPly)}...`;
      else if (error) status = "Review could not finish";
      else if (!$("coach-auto").checked) status = "Auto review paused";
      else if (!count) status = "Ready for the first move";
      else if (note) status = note.move?.san?.endsWith("#") ? "Checkmate / Review ready" : "Review ready";
      else status = "Move review ready";
    }
    $("coach-status").textContent = status;
  }

  function cancelActive() {
    if (!active || active.cancelled) return;
    const job = active;
    job.cancelled = true;
    job.controller.abort();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    job.stopped = fetch("/api/explain/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: job.requestId }),
      signal: controller.signal,
    }).catch(() => {}).finally(() => clearTimeout(timeout));
  }

  function cancelWork() {
    pending = null;
    cancelActive();
  }

  function applicable(job, result) {
    return !job.cancelled && position && job.key === currentKey()
      && result.requestId === job.requestId && result.initialFen === job.initialFen
      && JSON.stringify(result.moves) === JSON.stringify(job.moves)
      && result.ply === job.moves.length && result.strength === job.strength
      && result.forgiving === job.forgiving
      && (selectedPly !== position.moves.length || result.positionFen === position.fen);
  }

  async function pump() {
    if (active || !pending) return;
    const job = pending;
    pending = null;
    active = job;
    render();
    const timeout = setTimeout(() => {
      job.timedOut = true;
      cancelActive();
    }, 30000);
    try {
      const response = await fetch("/api/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          initialFen: job.initialFen, moves: job.moves, requestId: job.requestId,
          strength: job.strength, forgiving: job.forgiving,
        }),
        signal: job.controller.signal,
      });
      let result;
      try { result = await response.json(); }
      catch { throw new Error("The server returned an unreadable move review."); }
      if (!response.ok || result.error) throw new Error(result.error || `Move review failed (${response.status}).`);
      if (result.cancelled) {
        if (!job.cancelled && job.key === currentKey()) throw new Error("The move review was interrupted. Try again.");
        return;
      }
      if (applicable(job, result)) {
        notes.delete(job.key);
        notes.set(job.key, result);
        if (notes.size > 160) notes.delete(notes.keys().next().value);
        error = "";
      } else if (!job.cancelled && job.key === currentKey()) {
        throw new Error("The move review did not match the selected position. Try again.");
      }
    } catch (failure) {
      if (job.key === currentKey() && (!job.cancelled || job.timedOut)) {
        error = job.timedOut ? "The move review took too long. Try again."
          : failure instanceof TypeError ? "Cannot reach the server for move review. Try again."
            : failure.message || "The move review could not finish. Try again.";
      }
    } finally {
      clearTimeout(timeout);
      // Wait for the cancellation signal before starting the next queued position.
      if (job.stopped) await job.stopped;
      if (active === job) active = null;
      render();
      void pump();
    }
  }

  function review(force = false) {
    error = "";
    const key = currentKey();
    if (!key || !position.ready) {
      cancelWork();
      render();
      return;
    }
    if (!force && notes.has(key)) {
      cancelWork();
      render();
      return;
    }
    if (!force && (active?.key === key && !active.cancelled || pending?.key === key)) return;
    pending = {
      key, requestId: `coach-${sessionId}-${++serial}`,
      initialFen: position.initialFen, moves: position.moves.slice(0, selectedPly),
      strength: position.strength, forgiving: position.forgiving,
      controller: new AbortController(), cancelled: false, stopped: null, timedOut: false,
    };
    cancelActive();
    render();
    void pump();
  }

  function selectMove(ply) {
    if (!position?.moves.length) return;
    selectedPly = Math.max(1, Math.min(position.moves.length, ply));
    review();
  }

  window.addEventListener("knightfall:position", (event) => {
    const value = event.detail;
    if (!value || !Array.isArray(value.moves) || typeof value.initialFen !== "string") return;
    const oldKey = currentKey();
    const oldPosition = position;
    position = {
      initialFen: value.initialFen, moves: [...value.moves], history: [...(value.history || [])],
      fen: value.fen, strength: value.strength, forgiving: value.forgiving === true,
      ready: value.ready === true,
    };
    const changed = !oldPosition || profileKey(oldPosition) !== profileKey(position)
      || JSON.stringify(oldPosition.moves) !== JSON.stringify(position.moves);
    if (changed) {
      if ($("coach-auto").checked || !oldPosition || oldPosition.initialFen !== position.initialFen) selectedPly = position.moves.length;
      else selectedPly = Math.min(selectedPly || position.moves.length, position.moves.length);
    }
    if (oldKey !== currentKey() || !position.ready) {
      cancelWork();
      error = "";
    }
    render();
    if ($("coach-auto").checked && position.ready && (changed || !oldPosition?.ready)) review();
  });

  $("coach-prev").setAttribute("aria-label", "Review previous move");
  $("coach-next").setAttribute("aria-label", "Review next move");
  $("coach-refresh").setAttribute("aria-label", "Refresh selected move review");
  $("coach-move").setAttribute("aria-label", "Move to review");
  $("coach-auto").setAttribute("aria-label", "Automatically review new moves");
  $("coach-prev").addEventListener("click", () => selectMove(selectedPly - 1));
  $("coach-next").addEventListener("click", () => selectMove(selectedPly + 1));
  $("coach-move").addEventListener("change", (event) => selectMove(Number(event.target.value)));
  $("coach-refresh").addEventListener("click", () => review(true));
  $("coach-auto").addEventListener("change", () => {
    error = "";
    if ($("coach-auto").checked) {
      selectedPly = position?.moves.length || 0;
      review();
    } else {
      cancelWork();
      render();
    }
  });

  render();
})();
