(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const dialog = $("screenshot-dialog");
  if (!dialog) return;

  const names = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
  const files = "abcdefgh";
  const maxBytes = 10 * 1024 * 1024;
  let host = null;
  let generation = 0;
  let file = null;
  let imageUrl = null;
  let pieces = Array(64).fill("");
  let confidences = Array(64).fill(0);
  let selectedPiece = "";
  let recognizing = false;
  let submitting = false;
  let hasPosition = false;
  let loaded = false;
  let recognitionTail = Promise.resolve();

  const pieceName = (piece) => piece ? `${piece === piece.toUpperCase() ? "White" : "Black"} ${names[piece.toLowerCase()]}` : "Empty";
  const pieceAsset = (piece) => `/api/pieces/${piece === piece.toUpperCase() ? "w" : "b"}${piece.toUpperCase()}.svg`;
  const squareName = (index) => `${files[index % 8]}${Math.floor(index / 8) + 1}`;

  function error(message = "") {
    $("screenshot-error").textContent = message;
    $("screenshot-error").hidden = !message;
  }

  function readPlacement(placement) {
    if (typeof placement !== "string") throw new Error("The board could not be read. Try another screenshot or set it up manually.");
    const rows = placement.split("/");
    if (rows.length !== 8) throw new Error("Recognition returned an incomplete board.");
    const result = Array(64).fill("");
    rows.forEach((row, rowIndex) => {
      let column = 0;
      for (const character of row) {
        if (/^[1-8]$/.test(character)) column += Number(character);
        else if (/^[pnbrqkPNBRQK]$/.test(character) && column < 8) result[(7 - rowIndex) * 8 + column++] = character;
        else throw new Error("Recognition returned an invalid piece placement.");
      }
      if (column !== 8) throw new Error("Recognition returned an incomplete rank.");
    });
    return result;
  }

  function placement() {
    const rows = [];
    for (let rank = 7; rank >= 0; rank--) {
      let row = "", empty = 0;
      for (let column = 0; column < 8; column++) {
        const piece = pieces[rank * 8 + column];
        if (!piece) empty++;
        else {
          if (empty) row += empty;
          row += piece;
          empty = 0;
        }
      }
      rows.push(row + (empty || ""));
    }
    return rows.join("/");
  }

  function updateCastling() {
    for (const [right, kingSquare, king, rookSquare, rook] of [
      ["K", 4, "K", 7, "R"], ["Q", 4, "K", 0, "R"],
      ["k", 60, "k", 63, "r"], ["q", 60, "k", 56, "r"],
    ]) {
      const input = $(`screenshot-castling-${right}`);
      input.disabled = submitting || pieces[kingSquare] !== king || pieces[rookSquare] !== rook;
      if (pieces[kingSquare] !== king || pieces[rookSquare] !== rook) input.checked = false;
    }
  }

  function updateControls() {
    $("screenshot-confirm").disabled = !hasPosition || recognizing || submitting;
    $("screenshot-confirm").firstChild.textContent = submitting ? "Loading position " : "Continue position ";
    $("screenshot-file").disabled = submitting;
    $("close-screenshot").disabled = submitting;
    $("screenshot-cancel").disabled = submitting;
    $("screenshot-retry").disabled = recognizing || submitting || !file;
    $("screenshot-manual").disabled = recognizing || submitting;
    for (const input of $("screenshot-review").querySelectorAll("input, select, button")) input.disabled = submitting;
    $("screenshot-forgiving").disabled = submitting || Number($("screenshot-strength").value) === 100;
    updateCastling();
  }

  function updateStrength() {
    $("screenshot-strength-value").value = `${$("screenshot-strength").value}%`;
    if (Number($("screenshot-strength").value) === 100) $("screenshot-forgiving").checked = false;
    updateControls();
  }

  function renderBoard(focusSquare = null) {
    const fragment = document.createDocumentFragment();
    const blackBottom = $("screenshot-bottom").value === "black";
    const order = [];
    for (let rank = 7; rank >= 0; rank--) for (let column = 0; column < 8; column++) order.push(rank * 8 + column);
    if (blackBottom) order.reverse();
    for (const index of order) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `screenshot-square${(Math.floor(index / 8) + index % 8) % 2 ? "" : " dark"}${confidences[index] < .7 ? " uncertain" : ""}`;
      button.dataset.square = squareName(index);
      button.dataset.piece = pieces[index];
      button.tabIndex = (focusSquare ? squareName(index) === focusSquare : index === order[0]) ? 0 : -1;
      button.setAttribute("aria-label", `${squareName(index)}: ${pieceName(pieces[index])}${confidences[index] < .7 ? ", check recognition" : ""}`);
      button.title = `${squareName(index)}: ${pieceName(pieces[index])}`;
      button.disabled = submitting;
      if (pieces[index]) {
        const img = document.createElement("img");
        img.src = pieceAsset(pieces[index]);
        img.alt = "";
        img.draggable = false;
        button.append(img);
      }
      const coordinate = document.createElement("span");
      coordinate.className = "screenshot-coordinate";
      coordinate.textContent = squareName(index);
      coordinate.setAttribute("aria-hidden", "true");
      button.append(coordinate);
      button.addEventListener("click", () => {
        pieces[index] = selectedPiece;
        confidences[index] = 1;
        invalidateReview();
        renderBoard(squareName(index));
      });
      button.addEventListener("keydown", (event) => {
        const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -8, ArrowDown: 8 }[event.key];
        if (delta === undefined) return;
        event.preventDefault();
        const current = order.indexOf(index), target = current + delta;
        if (target >= 0 && target < 64 && (Math.abs(delta) === 8 || Math.floor(current / 8) === Math.floor(target / 8))) {
          const next = $("screenshot-board").querySelector(`[data-square="${squareName(order[target])}"]`);
          button.tabIndex = -1;
          next.tabIndex = 0;
          next.focus();
        }
      });
      fragment.append(button);
    }
    $("screenshot-board").replaceChildren(fragment);
    const uncertain = confidences.filter(value => value < .7).length;
    $("screenshot-uncertain").textContent = uncertain ? `${uncertain} to check` : "";
    const inventory = document.createDocumentFragment();
    for (const color of ["White", "Black"]) {
      const own = pieces.filter(piece => piece && (piece === piece.toUpperCase()) === (color === "White"));
      const div = document.createElement("div");
      const heading = document.createElement("strong");
      heading.textContent = `${color}: ${own.length} on board`;
      div.append(heading, ["k", "q", "r", "b", "n", "p"].map(type => `${type.toUpperCase()} ${own.filter(piece => piece.toLowerCase() === type).length}`).join("  "));
      inventory.append(div);
    }
    $("screenshot-inventory").replaceChildren(inventory);
    updateCastling();
    if (focusSquare) $("screenshot-board").querySelector(`[data-square="${focusSquare}"]`)?.focus();
  }

  function invalidateReview() {
    $("screenshot-reviewed").checked = false;
    error();
  }

  function selectPiece(piece) {
    selectedPiece = piece;
    for (const button of $("screenshot-palette").children) button.setAttribute("aria-pressed", String(button.dataset.piece === piece));
  }

  for (const piece of "KQRBNPkqrbnp ") {
    const value = piece.trim();
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.piece = value;
    button.className = `screenshot-piece${value ? "" : " eraser"}`;
    button.title = value ? pieceName(value) : "Erase piece";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(!value));
    if (value) {
      const img = document.createElement("img");
      img.src = pieceAsset(value);
      img.alt = "";
      img.draggable = false;
      button.append(img);
    } else button.textContent = "\u232b";
    button.addEventListener("click", () => selectPiece(value));
    $("screenshot-palette").append(button);
  }

  for (const rank of [3, 6]) for (const column of files) {
    const option = document.createElement("option");
    option.value = option.textContent = `${column}${rank}`;
    $("screenshot-ep").append(option);
  }

  function releaseImage() {
    $("screenshot-preview").removeAttribute("src");
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = null;
  }

  async function checkImage(selectedFile) {
    if (!["image/png", "image/jpeg", "image/webp"].includes(selectedFile.type)) throw new Error("Choose a PNG, JPEG, or WebP screenshot.");
    if (!selectedFile.size || selectedFile.size > maxBytes) throw new Error("The screenshot must be smaller than 10 MB.");
    let bitmap;
    try { bitmap = await createImageBitmap(selectedFile); }
    catch { throw new Error("This file is not a readable image. Choose another screenshot."); }
    const { width, height } = bitmap;
    bitmap.close();
    if (width < 80 || height < 80 || width > 8192 || height > 8192 || width * height > 16000000) {
      throw new Error("Choose a screenshot between 80 and 8192 pixels per side, up to 16 megapixels.");
    }
  }

  async function recognize(selectedFile) {
    const current = ++generation;
    recognizing = true;
    hasPosition = false;
    releaseImage();
    $("screenshot-review").hidden = true;
    $("screenshot-recovery").hidden = true;
    $("screenshot-status").textContent = "Reading the board on this device...";
    error();
    updateControls();
    try {
      await checkImage(selectedFile);
      if (current !== generation || !dialog.open) return;
      imageUrl = URL.createObjectURL(selectedFile);
      $("screenshot-preview").src = imageUrl;
      if (!window.KnightfallRecognition?.recognize) throw new Error("The board reader is unavailable. Retry or set up the position manually.");
      // The local model has one mutable inference context; superseded scans finish before another starts.
      const pending = recognitionTail.then(() => {
        if (current !== generation || !dialog.open) return null;
        return window.KnightfallRecognition.recognize(selectedFile);
      });
      recognitionTail = pending.catch(() => {});
      const result = await pending;
      if (current !== generation || !dialog.open) return;
      if (!result) throw new Error("No complete chess board was found. Try a clearer screenshot or set up the position manually.");
      pieces = readPlacement(result.placement);
      confidences = Array.from({ length: 64 }, (_, index) => {
        const value = Number(result.confidences?.[index]);
        return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
      });
      $("screenshot-bottom").value = "white";
      $("screenshot-turn").value = "";
      $("screenshot-side").value = "";
      for (const right of "KQkq") $(`screenshot-castling-${right}`).checked = false;
      $("screenshot-ep").value = "-";
      $("screenshot-halfmove").value = "0";
      $("screenshot-fullmove").value = "1";
      hasPosition = true;
      invalidateReview();
      renderBoard();
      $("screenshot-review").hidden = false;
      $("screenshot-status").textContent = result.reliable && result.plausible
        ? "Board recognized. Position awaiting your confirmation."
        : "Recognition uncertain. Position awaiting your review.";
    } catch (failure) {
      if (current !== generation || !dialog.open) return;
      error(failure.message || "The screenshot could not be read.");
      $("screenshot-status").textContent = "Position not imported.";
      $("screenshot-recovery").hidden = !imageUrl;
    } finally {
      if (current === generation) {
        recognizing = false;
        updateControls();
      }
    }
  }

  $("screenshot-file").addEventListener("change", () => {
    const selectedFile = $("screenshot-file").files?.[0];
    if (!selectedFile) return;
    file = selectedFile;
    recognize(file);
  });
  $("screenshot-retry").addEventListener("click", () => { if (file) recognize(file); });
  $("screenshot-manual").addEventListener("click", () => {
    generation++;
    recognizing = false;
    hasPosition = true;
    pieces = Array(64).fill("");
    confidences = Array(64).fill(1);
    $("screenshot-bottom").value = "white";
    $("screenshot-turn").value = "";
    $("screenshot-side").value = "";
    for (const right of "KQkq") $(`screenshot-castling-${right}`).checked = false;
    $("screenshot-ep").value = "-";
    $("screenshot-halfmove").value = "0";
    $("screenshot-fullmove").value = "1";
    $("screenshot-review").hidden = false;
    $("screenshot-recovery").hidden = true;
    $("screenshot-status").textContent = "Manual position awaiting your confirmation.";
    invalidateReview();
    renderBoard();
    updateControls();
  });
  $("screenshot-bottom").addEventListener("change", () => {
    pieces.reverse();
    confidences.reverse();
    for (const right of "KQkq") $(`screenshot-castling-${right}`).checked = false;
    $("screenshot-ep").value = "-";
    invalidateReview();
    renderBoard();
  });
  for (const input of $("screenshot-review").querySelectorAll("input, select")) {
    if (input.id !== "screenshot-reviewed") input.addEventListener("change", invalidateReview);
  }
  $("screenshot-strength").addEventListener("input", updateStrength);
  const close = () => { if (!submitting) dialog.close("cancelled"); };
  $("close-screenshot").addEventListener("click", close);
  $("screenshot-cancel").addEventListener("click", close);
  dialog.addEventListener("cancel", event => { if (submitting) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    generation++;
    recognizing = false;
    releaseImage();
    file = null;
    const callback = host?.onClose;
    host = null;
    callback?.({ loaded });
  });

  $("screenshot-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting || recognizing || !hasPosition) return;
    if (!$("screenshot-form").reportValidity()) return;
    const rights = [..."KQkq"].filter(right => $(`screenshot-castling-${right}`).checked && !$(`screenshot-castling-${right}`).disabled).join("") || "-";
    const fen = `${placement()} ${$("screenshot-turn").value === "white" ? "w" : "b"} ${rights} ${$("screenshot-ep").value} ${Number($("screenshot-halfmove").value)} ${Number($("screenshot-fullmove").value)}`;
    submitting = true;
    error();
    updateControls();
    try {
      if (typeof host?.onConfirm !== "function") throw new Error("The position importer is unavailable. Close this dialog and try again.");
      await host.onConfirm({ fen, userSide: $("screenshot-side").value, strength: Number($("screenshot-strength").value), forgiving: $("screenshot-forgiving").checked, extraInaccuracies: Number($("screenshot-inaccuracies").value) });
      loaded = true;
      dialog.close("loaded");
    } catch (failure) {
      error(failure.message || "This position could not be imported. Check the board and position details.");
      $("screenshot-error").scrollIntoView({ block: "nearest" });
    } finally {
      submitting = false;
      updateControls();
    }
  });

  window.KnightfallScreenshot = {
    open(options = {}) {
      if (dialog.open) return false;
      host = options;
      generation++;
      loaded = false;
      submitting = false;
      recognizing = false;
      hasPosition = false;
      file = null;
      pieces = Array(64).fill("");
      confidences = Array(64).fill(0);
      releaseImage();
      $("screenshot-form").reset();
      $("screenshot-file").value = "";
      $("screenshot-strength").value = String(Math.min(100, Math.max(10, Math.round(Number(options.strength) || 70))));
      $("screenshot-forgiving").checked = Boolean(options.forgiving);
      $("screenshot-inaccuracies").value = String([0, 1, 2].includes(options.extraInaccuracies) ? options.extraInaccuracies : 0);
      $("screenshot-review").hidden = true;
      $("screenshot-recovery").hidden = true;
      $("screenshot-status").textContent = "No screenshot selected.";
      error();
      selectPiece("");
      updateStrength();
      dialog.returnValue = "";
      dialog.showModal();
      dialog.scrollTop = 0;
      return true;
    },
    isOpen: () => dialog.open,
  };
})();
