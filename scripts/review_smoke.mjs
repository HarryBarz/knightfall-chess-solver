// Post-match review checks using Chrome's DevTools protocol and real Stockfish.
// Run against the local server: node scripts/review_smoke.mjs [http://127.0.0.1:8877]
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const base = process.argv[2] || 'http://127.0.0.1:8877';
const profile = await mkdtemp(join(tmpdir(), 'knightfall-review-browser-'));
const executable = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const chrome = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let client;
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Chrome did not start in 20 seconds')), 20000);
    let log = '';
    chrome.stderr.on('data', chunk => {
      log += chunk.toString();
      const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    chrome.on('error', error => { clearTimeout(timeout); reject(error); });
    chrome.on('exit', code => { clearTimeout(timeout); reject(new Error(`Chrome exited: ${code}; ${log.slice(-1500)}`)); });
  });
  const debugOrigin = endpoint.replace(/^ws:/, 'http:').replace(/\/devtools\/.*$/, '');
  const target = await (await fetch(`${debugOrigin}/json/new?about:blank`, { method: 'PUT' })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  client = socket;
  const pending = new Map();
  const errors = [];
  let nextId = 0;
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text + ': ' + JSON.stringify(message.params.exceptionDetails.exception));
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error' && !message.params.entry.url?.endsWith('favicon.ico')) errors.push(message.params.entry.text);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async (expression, timeout = 40000) => {
    const deadline = Date.now() + timeout;
    do { if (await evaluate(expression)) return; await delay(100); } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for ${expression}; review: ${await evaluate('document.querySelector("#match-review-dialog")?.innerText')}; failures: ${JSON.stringify(await evaluate('window.reviewFailures || []'))}`);
  };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const input = (selector, value) => evaluate(`document.querySelector(${JSON.stringify(selector)}).value = ${JSON.stringify(value)}`);
  const select = async (selector, value) => {
    await input(selector, value);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change', { bubbles: true }))`);
  };
  const key = async key => {
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key });
  };
  const ready = 'document.querySelector("#match-review-dialog").open && document.querySelector("#match-review-dialog").getAttribute("aria-busy") === "false" && !document.querySelector("#review-content").hidden && document.querySelector("#review-error").hidden';
  const currentPly = 'Number(document.querySelector("#review-move").value)';
  const boardFen = 'document.querySelector("#review-board").dataset.fen';
  // Clock bookkeeping can change when review pauses/resumes a live game.
  const livePosition = `JSON.stringify({
    workspace: (({ clock, ...game }) => game)(JSON.parse(localStorage.getItem('knightfall.workspace.v1'))),
    history: document.querySelector('#history').textContent,
    squares: Array.from(document.querySelectorAll('#board .square'), square => square.getAttribute('aria-label')),
  })`;
  const workspace = 'JSON.parse(localStorage.getItem("knightfall.workspace.v1"))';
  const waitPly = async ply => {
    await until(`${currentPly} === ${ply} && ${ply ? ready : 'document.querySelector("#review-board").dataset.ply === "0"'}`);
    assert.equal(await evaluate('document.querySelector("#review-board").dataset.ply'), String(ply));
  };
  const positionAt = ply => evaluate(`(async () => {
    const saved = ${workspace};
    const response = await fetch('/api/position', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initialFen: saved.initialFen, moves: saved.moves.slice(0, ${ply}) }),
    });
    if (!response.ok) throw new Error('Position request failed: ' + response.status);
    return response.json();
  })()`);
  const screenshot = async name => {
    const result = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(`artifacts/${name}.png`, Buffer.from(result.data, 'base64'));
  };
  const reload = async () => {
    await evaluate('window.reviewReloadPending = true');
    await call('Page.reload');
    await until('!window.reviewReloadPending && document.querySelectorAll("#board .square").length === 64 && document.querySelector("#connection-dot")?.classList.contains("ready") && !document.querySelector("#new-game").disabled');
  };
  const recordReviews = () => evaluate(`(() => {
    const originalFetch = window.fetch.bind(window);
    window.reviewRequests = [];
    window.reviewResponses = [];
    window.reviewFailures = [];
    window.reviewHeld = [];
    window.reviewHold = false;
    window.reviewFailOnce = false;
    window.fetch = async (url, options) => {
      if (url !== '/api/review') return originalFetch(url, options);
      const request = JSON.parse(options.body);
      window.reviewRequests.push(request);
      if (window.reviewFailOnce) {
        window.reviewFailOnce = false;
        throw new TypeError('Intentional offline review check');
      }
      const response = await originalFetch(url, options);
      const body = await response.clone().text();
      const result = JSON.parse(body);
      window.reviewResponses.push(result);
      if (!response.ok) window.reviewFailures.push({ status: response.status, body: result });
      // Decouple an already received response from abort, reproducing a genuinely late completion.
      if (window.reviewHold) {
        const delayed = new Response(body, { status: response.status, headers: response.headers });
        return new Promise(resolve => window.reviewHeld.push(() => resolve(delayed)));
      }
      return response;
    };
  })()`);

  await call('Runtime.enable');
  await call('Log.enable');
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: base });
  await until('document.querySelector("#new-game-dialog")?.open && document.querySelectorAll("#board .square").length === 64');
  await evaluate('document.querySelector("#new-game-form").requestSubmit()');
  await until('!document.querySelector("#new-game-dialog").open && !document.querySelector("#submit-move").disabled');
  assert.equal(await evaluate(`${workspace}.settings.strength`), 70, 'Review must not silently increase the selected difficulty');
  assert.equal(await evaluate('document.querySelector("#review-match").disabled'), true, 'An empty game has no played moves to review');
  await evaluate('for (const id of ["auto-reply", "coach-auto"]) { const input = document.getElementById(id); if (input.checked) input.click(); }');
  await click('#import');
  await click('[data-import-type="pgn"]');
  await input('#import-text', '1. f3 e5 2. g4 Qh4# 0-1');
  await evaluate('document.querySelector("#import-form").requestSubmit()');
  await until('!document.querySelector("#import-dialog").open && document.querySelectorAll(".history-move").length === 4 && !document.querySelector("#match-finished").hidden');
  assert.equal(await evaluate('document.querySelector("#game-result").textContent.toLowerCase().includes("checkmate")'), true);
  assert.equal(await evaluate('document.querySelector("#match-review-dialog").open'), false, 'The review offer must not interrupt the finished board with an automatic modal');
  assert.equal(await evaluate('document.querySelector("#match-finished-review").disabled'), false);
  assert.ok(await evaluate('localStorage.getItem("knightfall.last-match.v1")'), 'A finished match must be retained');
  await reload();
  await until('!document.querySelector("#match-finished").hidden && !document.querySelector("#match-finished-review").disabled');
  assert.equal(await evaluate('document.querySelector("#match-review-dialog").open'), false);
  await recordReviews();
  const liveBefore = await evaluate(livePosition);
  const start = await positionAt(0);
  const first = await positionAt(1);
  const second = await positionAt(2);
  const third = await positionAt(3);
  const terminal = await positionAt(4);
  await click('#match-finished-review');
  await until('document.querySelector("#match-review-dialog").open && document.querySelectorAll("#review-board [data-square]").length === 64');
  await waitPly(0);
  assert.equal(await evaluate(boardFen), start.fen, 'Review starts at the real initial position');
  assert.equal(await evaluate('document.querySelector("#review-first").disabled && document.querySelector("#review-prev").disabled'), true);
  assert.deepEqual(await evaluate('Array.from(document.querySelector("#review-lookahead").options, option => option.value)'), ['2', '3', '4', '6', '8']);
  assert.equal(await evaluate('document.querySelector("#review-strength").value'), 'full');
  assert.equal(await evaluate('window.reviewRequests.length'), 0, 'The starting position has no played move to analyze');

  await click('#review-next');
  await waitPly(1);
  assert.equal(await evaluate(boardFen), first.fen);
  assert.match(await evaluate('document.querySelector("#review-owner").textContent'), /you/i);
  assert.ok((await evaluate('document.querySelector("#review-summary").textContent')).length > 30, 'Played move needs a readable explanation');
  assert.ok((await evaluate('document.querySelector("#review-plan").textContent')).length > 30, 'Review must explain the projected plan');
  const firstRequest = await evaluate('window.reviewRequests.at(-1)');
  assert.deepEqual(firstRequest.moves, ['f2f3', 'e7e5', 'g2g4', 'd8h4'], 'Review includes the full match to distinguish projections from actual play');
  assert.equal(firstRequest.ply, 1);
  assert.equal(firstRequest.strength, 100);
  assert.equal(firstRequest.forgiving, false);
  assert.equal(firstRequest.lookahead, 4);
  const firstReview = await evaluate('window.reviewResponses.find(result => result.ply === 1 && result.lookahead === 4 && result.strength === 100)');
  assert.equal(firstReview.positionFen, first.fen, 'Review response must correspond to the exact selected position');
  assert.ok(firstReview.reasons.length > 0, 'Review must contain concrete reasons for the move');
  assert.ok(firstReview.continuation.length > 0 && firstReview.continuation.length <= 4);

  // Preview actual history and a Stockfish continuation without touching the live game.
  await until('document.querySelector("#review-actual [data-review-line][data-step]")');
  await click('#review-actual [data-review-line][data-step="0"]');
  assert.equal(await evaluate('document.querySelector("#review-board").dataset.preview'), 'actual');
  assert.equal(await evaluate(boardFen), second.fen, 'Actual-next-move preview must replay the legal match position');
  await click('#review-return');
  assert.equal(await evaluate(boardFen), first.fen);
  await until('document.querySelector("#review-continuation [data-review-line][data-step]")');
  await click('#review-continuation [data-review-line][data-step="0"]');
  assert.equal(await evaluate('document.querySelector("#review-board").dataset.preview'), 'projection');
  assert.equal(await evaluate(boardFen), firstReview.continuation[0].fen, 'Projected board must match the legal continuation returned by the engine');
  assert.notEqual(await evaluate(boardFen), first.fen, 'Projected move preview changes only the review board');
  assert.ok((await evaluate('document.querySelector("#review-preview-description").textContent')).length > 10);
  await click('#review-return');
  assert.equal(await evaluate(boardFen), first.fen);
  assert.equal(await evaluate(livePosition), liveBefore, 'Line previews must not modify saved moves, live board, or history');

  await click('#review-next');
  await waitPly(2);
  assert.equal(await evaluate(boardFen), second.fen);
  assert.match(await evaluate('document.querySelector("#review-owner").textContent'), /solver/i);
  await click('#review-prev');
  await waitPly(1);
  await select('#review-move', '3');
  await waitPly(3);
  assert.equal(await evaluate(boardFen), third.fen);
  assert.match(await evaluate('document.querySelector("#review-owner").textContent'), /you/i);
  assert.ok((await evaluate('document.querySelector("#review-assessment").textContent')).length > 30, 'The losing human move needs an assessment');
  assert.ok((await evaluate('document.querySelector("#review-correction").textContent')).length > 30, 'The losing human move needs a correction');
  const shortPreviewNote = await evaluate('document.querySelector("#review-continuation-note").textContent');
  assert.match(shortPreviewNote, /shorter.*4-turn horizon/i, 'A one-reply mating line must explain why it stops before the requested horizon');
  assert.match(shortPreviewNote, /1 legal future turn\./);
  assert.equal(await evaluate('document.querySelector("#review-continuation-note").checkVisibility()'), true, 'The short-preview explanation must be visible');
  assert.doesNotMatch(await evaluate('document.querySelector("#review-content").textContent'), /1 future half-moves/, 'Single-turn plans must use singular grammar');
  const losingMoveReview = await evaluate('window.reviewResponses.find(result => result.ply === 3 && result.lookahead === 4 && result.strength === 100)');
  assert.ok(losingMoveReview.correction?.continuation.length, 'The mate-enabling human move should have a playable correction');
  await click('#review-correction [data-review-line][data-step="0"]');
  assert.equal(await evaluate('document.querySelector("#review-board").dataset.preview'), 'correction');
  assert.equal(await evaluate(boardFen), losingMoveReview.correction.continuation[0].fen, 'Correction preview must start from the position before the mistake');
  await click('#review-return');
  assert.equal(await evaluate(boardFen), third.fen);
  await mkdir('artifacts', { recursive: true });
  await screenshot('match-review-desktop');
  await click('#review-last');
  await waitPly(4);
  assert.equal(await evaluate(boardFen), terminal.fen);
  assert.match(await evaluate('document.querySelector("#review-owner").textContent'), /solver/i);
  assert.match(await evaluate('document.querySelector("#review-content").textContent'), /mate/i);
  assert.equal(await evaluate('document.querySelector("#review-next").disabled && document.querySelector("#review-last").disabled'), true);
  await click('#review-first');
  await waitPly(0);
  await key('ArrowRight');
  await waitPly(1);
  await key('End');
  await waitPly(4);
  await key('Home');
  await waitPly(0);

  await select('#review-speed', '2');
  await click('#review-play');
  await until(`${currentPly} >= 1`);
  await click('#review-play');
  const pausedPly = await evaluate(currentPly);
  await delay(2300);
  assert.equal(await evaluate(currentPly), pausedPly, 'Pause stops automatic navigation');
  await select('#review-move', '1');
  await waitPly(1);
  for (const lookahead of ['2', '3']) {
    await select('#review-lookahead', lookahead);
    await until(`${ready} && window.reviewRequests.at(-1).lookahead === ${lookahead}`);
    assert.equal(await evaluate('window.reviewRequests.at(-1).strength'), 100, 'Changing lookahead preserves the full-strength reviewer profile');
    const projectedCount = await evaluate(`window.reviewResponses.filter(result => result.ply === 1 && result.lookahead === ${lookahead}).at(-1).continuation.length`);
    assert.ok(projectedCount > 0 && projectedCount <= Number(lookahead), 'Requested horizon bounds the legal projected line');
  }

  // Failure/retry uses a single transport error; all successful analyses still come from Stockfish.
  await evaluate('window.reviewFailOnce = true');
  await select('#review-lookahead', '8');
  await until('!document.querySelector("#review-error").hidden && !document.querySelector("#review-retry").disabled');
  assert.ok((await evaluate('document.querySelector("#review-error").textContent')).length > 10);
  await click('#review-retry');
  await until(`${ready} && window.reviewRequests.at(-1).lookahead === 8`);
  assert.equal(await evaluate(boardFen), first.fen);

  // Reviewer profiles are independent of the selected playing difficulty.
  await select('#review-strength', 'match');
  await until(`${ready} && window.reviewRequests.at(-1).strength === 70`);
  assert.equal(await evaluate(livePosition), liveBefore, 'Review strength must not change playing strength or live state');
  await select('#review-strength', 'full');
  await until(ready);
  assert.equal(await evaluate(livePosition), liveBefore, 'Returning to full review strength must preserve the live game');

  // Hold a completed, real response across close/reopen to exercise stale request suppression.
  await evaluate('window.reviewHold = true');
  await select('#review-lookahead', '6');
  await until('window.reviewHeld.length === 1');
  await click('#review-close');
  await until('!document.querySelector("#match-review-dialog").open && !document.querySelector("#new-game").disabled');
  await click('#review-match');
  await waitPly(0);
  await evaluate('window.reviewHold = false; window.reviewHeld.splice(0).forEach(release => release())');
  await delay(400);
  assert.equal(await evaluate(currentPly), 0, 'A late response cannot move a reopened review away from its starting position');
  assert.equal(await evaluate(boardFen), start.fen);
  assert.equal(await evaluate('document.querySelector("#review-content").hidden'), true, 'A late response cannot show notes for an unselected move');
  await select('#review-move', '3');
  await waitPly(3);

  for (const [width, height, name] of [[390, 844, 'match-review-mobile'], [320, 568, 'match-review-narrow']]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
    await delay(200);
    assert.equal(await evaluate(`(() => {
      const dialog = document.querySelector('#match-review-dialog');
      const rect = dialog.getBoundingClientRect();
      const board = document.querySelector('#review-board').getBoundingClientRect();
      return rect.left >= -1 && rect.right <= innerWidth + 1 && rect.top >= -1 && rect.bottom <= innerHeight + 1
        && dialog.scrollWidth <= dialog.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth
        && board.width <= dialog.clientWidth;
    })()`), true, `Review must fit ${width}px without horizontal overflow`);
    await evaluate('document.querySelector("#review-next").scrollIntoView({ block: "nearest" })');
    assert.equal(await evaluate('document.querySelector("#review-next").getBoundingClientRect().bottom <= innerHeight'), true, 'Navigation remains reachable on mobile');
    await screenshot(name);
    await evaluate('document.querySelector("#review-plan").scrollIntoView({ block: "center" })');
    assert.equal(await evaluate('document.querySelector("#review-plan").getBoundingClientRect().left >= 0 && document.querySelector("#review-plan").getBoundingClientRect().right <= innerWidth'), true, 'Detailed review text must remain readable on mobile');
    await screenshot(`${name}-notes`);
  }
  await click('#review-close');
  await until('!document.querySelector("#match-review-dialog").open && !document.querySelector("#new-game").disabled');
  assert.equal(await evaluate(livePosition), liveBefore, 'Review must preserve the complete live game through close/reopen and all controls');

  // Starting another game preserves an entry point to the completed match.
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await click('#new-game');
  await until('document.querySelector("#new-game-dialog").open');
  await evaluate('document.querySelector("#new-game-form").requestSubmit()');
  await until(`!document.querySelector('#new-game-dialog').open && ${workspace}.moves.length === 0 && !document.querySelector('#new-game').disabled`);
  assert.equal(await evaluate('document.querySelector("#review-match").disabled'), true);
  assert.equal(await evaluate('document.querySelector("#review-last-match").hidden || document.querySelector("#review-last-match").disabled'), false, 'Completed match remains reviewable after starting the next game');
  await reload();
  await until('!document.querySelector("#review-last-match").hidden && !document.querySelector("#review-last-match").disabled');
  const newGameBefore = await evaluate(livePosition);
  await click('#review-last-match');
  await waitPly(0);
  await click('#review-last');
  await waitPly(4);
  assert.equal(await evaluate(boardFen), terminal.fen, 'Retained match reopens the completed game after a new game and reload');
  await click('#review-close');
  assert.equal(await evaluate(livePosition), newGameBefore, 'Reviewing a retained match cannot restore its position over the new live game');
  assert.deepEqual(errors, [], 'Review must not emit runtime or CSP errors');
  console.log('PASS: finished-game review offer, reload persistence, retained match, start-to-finish replay, You/Solver labels, detailed move plans and corrections, actual/projected move previews, 2/3/4/6/8-step choices, full-strength review default, optional match-strength review isolation, first/prev/next/last and keyboard navigation, autoplay/pause, offline retry, stale response suppression, unchanged live board/storage, and 390/320px layouts. Successful analyses used the running server and real Stockfish.');
  console.log('Screenshots: artifacts/match-review-desktop.png, artifacts/match-review-mobile.png, artifacts/match-review-mobile-notes.png, artifacts/match-review-narrow.png, artifacts/match-review-narrow-notes.png');
} finally {
  client?.close();
  chrome.kill('SIGTERM');
}
