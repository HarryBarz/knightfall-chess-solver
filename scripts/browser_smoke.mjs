// End-to-end checks using Chrome's DevTools protocol; no npm dependencies.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const base = process.argv[2] || 'http://127.0.0.1:8877';
const profile = await mkdtemp(join(tmpdir(), 'knightfall-browser-'));
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
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
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
  const until = async (expression, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    do { if (await evaluate(expression)) return; await delay(100); } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for ${expression}; API failures: ${JSON.stringify(await evaluate('window.analysisFailures || []'))}; page: ${await evaluate('document.body.innerText.slice(0,2500)')}`);
  };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const reload = async () => {
    await evaluate('window.smokeReloadPending = true');
    await call('Page.reload');
    await until('!window.smokeReloadPending && document.querySelectorAll("#board .square").length === 64 && document.querySelector("#connection-dot")?.classList.contains("ready") && !document.querySelector("#new-game").disabled');
  };
  const setInput = (selector, value) => evaluate(`document.querySelector(${JSON.stringify(selector)}).value = ${JSON.stringify(value)}`);
  const setStrength = async value => {
    await setInput('#game-strength', value);
    await evaluate('document.querySelector("#game-strength").dispatchEvent(new Event("input", { bubbles: true }))');
  };
  const startGame = async () => {
    await evaluate('document.querySelector("#new-game-form").requestSubmit()');
    await until('!document.querySelector("#new-game-dialog").open && !document.querySelector("#submit-move").disabled');
  };
  const historyCount = 'document.querySelectorAll(".history-row").length';
  const savedSettings = 'JSON.parse(localStorage.getItem("knightfall.workspace.v1")).settings';
  const coachReady = '!document.querySelector("#coach-content").hidden && document.querySelector("#coach-panel").getAttribute("aria-busy") === "false"';
  const mainPosition = `JSON.stringify({
    saved: JSON.parse(localStorage.getItem('knightfall.workspace.v1')),
    history: document.querySelector('#history').textContent,
    squares: Array.from(document.querySelectorAll('#board .square'), square => square.getAttribute('aria-label')),
  })`;
  const recordAnalysis = () => evaluate(`(() => {
    const originalFetch = window.fetch.bind(window);
    window.analysisRequests = [];
    window.analysisFailures = [];
    window.coachRequests = [];
    window.heldCoachResponses = [];
    window.holdCoachResponses = false;
    window.fetch = (url, options) => {
      if (url === '/api/analyze') window.analysisRequests.push(JSON.parse(options.body));
      if (url === '/api/explain') window.coachRequests.push(JSON.parse(options.body));
      return originalFetch(url, options).then(response => {
        if (!response.ok) response.clone().json().then(body => window.analysisFailures.push({ url, status: response.status, body }));
        if (url === '/api/explain' && window.holdCoachResponses) {
          return new Promise(resolve => window.heldCoachResponses.push(() => resolve(response)));
        }
        return response;
      });
    };
  })()`);
  const assertOwnSideRecommendation = async (color, strength, forgiving) => {
    const before = await evaluate(mainPosition);
    const requestCount = await evaluate('window.analysisRequests.length');
    assert.equal(await evaluate(`${savedSettings}.solver`), color === 'white' ? 'black' : 'white');
    await click('#analyze');
    await until(`window.analysisRequests.length === ${requestCount + 1} && !document.querySelector('#play-best').hidden && !document.querySelector('#play-best').disabled && document.querySelector('#stop').hidden`);
    const request = await evaluate('window.analysisRequests.at(-1)');
    assert.equal(request.strength, strength, `${color} recommendations must use the selected strength`);
    assert.equal(request.forgiving, forgiving, `${color} recommendations must use the selected forgiving mode`);
    assert.equal(Object.hasOwn(request, 'practice'), false, 'Own-side suggestions must not request extra opponent mistakes');
    assert.equal(await evaluate('document.querySelector("#best-move-label").textContent'), 'ENGINE MOVE');
    assert.equal(await evaluate('document.querySelector("#play-best").textContent'), 'Play engine move');
    assert.equal(await evaluate(mainPosition), before, 'Previewing an own-side recommendation must preserve the board and saved game');
  };
  await call('Runtime.enable');
  await call('Log.enable');
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: base });
  await until('document.querySelectorAll("#board .square").length === 64 && document.querySelector("#new-game-dialog")?.open');
  assert.equal(await evaluate('document.querySelector("#game-strength").value'), '70');
  assert.equal(await evaluate('document.querySelector("#game-forgiving").checked'), false);
  assert.equal(await evaluate('document.querySelector("#game-color").value'), 'white');
  await setInput('#game-opponent-style', 'classic');
  await evaluate('document.querySelector("#game-opponent-style").dispatchEvent(new Event("change", { bubbles: true }))');
  await mkdir('artifacts', { recursive: true });
  const setupScreenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile('artifacts/new-game-desktop.png', Buffer.from(setupScreenshot.data, 'base64'));
  await recordAnalysis();
  await startGame();
  assert.equal(await evaluate('document.querySelectorAll("#board img").length'), 32);
  await click('[data-seconds="1"]');
  await assertOwnSideRecommendation('white', 70, false);
  await setInput('#move-input', 'e4');
  await evaluate('document.querySelector("#move-form").requestSubmit()');
  await until('document.querySelector("#history").textContent.includes("e4") && !document.querySelector("#stop").hidden');
  await until('!document.querySelector("#submit-move").disabled && document.querySelector("#best-move").textContent !== "—"');
  assert.equal(await evaluate(historyCount), 1);
  assert.equal(await evaluate('document.querySelectorAll(".history-row .history-move").length'), 2);
  assert.equal(await evaluate('window.analysisRequests.at(-1).strength'), 70);
  assert.equal(await evaluate('window.analysisRequests.at(-1).forgiving'), false);
  await until(coachReady);
  assert.equal(await evaluate('document.querySelector("#coach-auto").checked'), true);
  assert.equal(await evaluate('window.coachRequests.at(-1).strength'), 70);
  assert.equal(await evaluate('window.coachRequests.at(-1).forgiving'), false);
  assert.equal(await evaluate('window.coachRequests.at(-1).moves.length'), 2);
  assert.equal(await evaluate('document.querySelector("#coach-move").value'), '2');
  assert.equal(await evaluate('document.querySelector("#coach-summary").textContent.length > 0 && document.querySelectorAll("#coach-reasons li").length > 0'), true, 'Automatic move review should provide written reasons');
  assert.equal(await evaluate('document.querySelectorAll("#board").length === 1 && document.querySelectorAll("#coach-panel .square, #coach-panel .board, #coach-panel canvas").length === 0'), true, 'Coach should contain written notes and no second board');
  assert.equal(await evaluate(`(() => {
    const board = document.querySelector('.board-panel').getBoundingClientRect();
    const coach = document.querySelector('#coach-panel').getBoundingClientRect();
    const tools = document.querySelector('.sidebar').getBoundingClientRect();
    return coach.left >= board.right && tools.right <= coach.left && Math.abs(coach.top - board.top) < 100;
  })()`), true, 'Desktop should place existing board/tools on the left and move review on the right');
  const beforeReviewSelection = await evaluate(mainPosition);
  await setInput('#coach-move', '1');
  await evaluate('document.querySelector("#coach-move").dispatchEvent(new Event("change", { bubbles: true }))');
  await until(`${coachReady} && document.querySelector('#coach-title').textContent.includes('e4')`);
  assert.equal(await evaluate(mainPosition), beforeReviewSelection, 'Reviewing an older move must preserve the current board, history, and saved FEN');
  assert.equal(await evaluate('window.coachRequests.some(request => request.moves.length === 1 && request.moves[0] === "e2e4")'), true, 'Earlier move review can reuse its cached request');
  assert.equal(await evaluate('document.querySelector("#coach-prev").disabled'), true);
  await click('#coach-next');
  await until(`${coachReady} && document.querySelector('#coach-move').value === '2'`);
  await click('#coach-auto');
  assert.equal(await evaluate('document.querySelector("#coach-status").textContent'), 'Auto review paused');
  await click('#coach-prev');
  await until(`${coachReady} && document.querySelector('#coach-move').value === '1'`);
  await click('#coach-auto');
  await until(`${coachReady} && document.querySelector('#coach-move').value === '2'`);
  const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile('artifacts/desktop.png', Buffer.from(screenshot.data, 'base64'));
  const moveFormBounds = await evaluate('({ bottom: document.querySelector("#move-form").getBoundingClientRect().bottom, height: innerHeight })');
  assert.ok(moveFormBounds.bottom <= moveFormBounds.height, `Board and move input should fit a 900px desktop viewport: ${JSON.stringify(moveFormBounds)}`);
  for (const [width, height] of [[1280, 800], [1920, 1080]]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await delay(150);
    assert.equal(await evaluate(`(() => {
      const play = document.querySelector('.play-workspace').getBoundingClientRect();
      const coach = document.querySelector('#coach-panel').getBoundingClientRect();
      return document.documentElement.scrollWidth <= innerWidth
        && coach.left >= play.right && coach.right <= innerWidth
        && document.querySelector('#coach-panel').scrollWidth <= document.querySelector('#coach-panel').clientWidth;
    })()`), true, `Workspace and written move review must fit ${width}x${height}`);
    const landscape = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(`artifacts/desktop-${width}.png`, Buffer.from(landscape.data, 'base64'));
  }
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const beforeCancel = await evaluate('localStorage.getItem("knightfall.workspace.v1")');
  await click('#new-game');
  await until('document.querySelector("#new-game-dialog").open');
  await setStrength(40);
  await click('#game-forgiving');
  await setInput('#game-color', 'black');
  await click('#close-new-game');
  await until('!document.querySelector("#new-game-dialog").open');
  assert.equal(await evaluate('localStorage.getItem("knightfall.workspace.v1")'), beforeCancel, 'Cancelling setup must preserve the game and settings');
  assert.equal(await evaluate('document.querySelectorAll(".history-move").length'), 2);
  await evaluate('window.holdCoachResponses = true');
  await click('#coach-refresh');
  await until('window.heldCoachResponses.length === 1');
  await click('#undo');
  await until(`${historyCount} === 0 && !document.querySelector('#submit-move').disabled`);
  await evaluate('window.holdCoachResponses = false; window.heldCoachResponses.splice(0).forEach(release => release())');
  await until('document.querySelector("#coach-panel").getAttribute("aria-busy") === "false"');
  assert.equal(await evaluate('document.querySelector("#coach-content").hidden && document.querySelector("#coach-move").value === "0"'), true, 'A late review response must not restore notes after undo');
  await click('[data-square="d2"]');
  assert.equal(await evaluate('document.querySelector("[data-square=d4]").classList.contains("legal")'), true);
  await click('[data-square="d4"]');
  await until('document.querySelectorAll(".history-move").length === 2 && !document.querySelector("#submit-move").disabled');
  await click('#flip');
  assert.equal(await evaluate('document.querySelector("#board .square").dataset.square'), 'h1');
  await click('#flip');
  await click('#undo');
  await until(`${historyCount} === 0 && !document.querySelector('#submit-move').disabled`);
  await click('#new-game');
  await until('document.querySelector("#new-game-dialog").open');
  await setStrength(90);
  await click('#game-forgiving');
  await setInput('#game-color', 'black');
  await startGame();
  await until(`${historyCount} === 1 && !document.querySelector('#submit-move').disabled`);
  assert.equal(await evaluate('window.analysisRequests.at(-1).strength'), 90);
  assert.equal(await evaluate('window.analysisRequests.at(-1).forgiving'), true);
  assert.equal(await evaluate(`${savedSettings}.solver`), 'white');
  await until(coachReady);
  assert.equal(await evaluate('window.coachRequests.at(-1).strength'), 90);
  assert.equal(await evaluate('window.coachRequests.at(-1).forgiving'), true);
  assert.equal(await evaluate('document.querySelector("#coach-strength").textContent.includes("90%") && document.querySelector("#coach-strength").textContent.includes("Forgiving")'), true);
  await reload();
  await until(`${historyCount} === 1 && !document.querySelector('#submit-move').disabled`);
  await recordAnalysis();
  assert.equal(await evaluate('document.querySelector("#new-game-dialog").open'), false, 'Restoring a game must not prompt again');
  assert.equal(await evaluate(`${savedSettings}.strength`), 90);
  assert.equal(await evaluate(`${savedSettings}.forgiving`), true);
  assert.equal(await evaluate('document.querySelector("#practice-summary").textContent.includes("90%")'), true);
  await assertOwnSideRecommendation('black', 90, true);
  await until(coachReady);
  await evaluate('window.holdCoachResponses = true');
  await click('#coach-refresh');
  await until('window.heldCoachResponses.length === 1');
  await click('#new-game');
  await until('document.querySelector("#new-game-dialog").open');
  await setStrength(100);
  assert.equal(await evaluate('document.querySelector("#game-forgiving").checked'), false, 'Maximum strength must clear forgiving mode');
  await click('#game-forgiving');
  assert.equal(await evaluate('document.querySelector("#game-strength").value'), '90', 'Forgiving mode must select a reduced strength');
  await setStrength(100);
  await setInput('#game-color', 'white');
  await startGame();
  await until(`${historyCount} === 0 && !document.querySelector('#submit-move').disabled`);
  await evaluate('window.holdCoachResponses = false; window.heldCoachResponses.splice(0).forEach(release => release())');
  await until('document.querySelector("#coach-panel").getAttribute("aria-busy") === "false"');
  assert.equal(await evaluate('document.querySelector("#coach-content").hidden && document.querySelector("#coach-move").value === "0"'), true, 'A late review response must not enter a new game');
  assert.equal(await evaluate(`${savedSettings}.strength`), 100);
  assert.equal(await evaluate(`${savedSettings}.forgiving`), false);
  await click('[data-seconds="30"]');
  await click('#analyze');
  await until('!document.querySelector("#stop").hidden');
  await click('#stop');
  await until('document.querySelector("#stop").hidden && !document.querySelector("#analyze").disabled');
  assert.equal(await evaluate(historyCount), 0, 'A cancelled search must not play a move');
  await click('#analyze');
  await until('!document.querySelector("#stop").hidden');
  await click('#new-game');
  await until('document.querySelector("#new-game-dialog").open');
  await until('document.querySelector("#stop").hidden && !document.querySelector("#analyze").disabled');
  assert.equal(await evaluate(historyCount), 0, 'New game must discard the old analysis');
  await setStrength(70);
  await click('#game-forgiving');
  await startGame();
  await click('#import');
  await setInput('#import-text', '7k/8/5KQ1/8/8/8/8/8 w - - 0 1');
  await evaluate('document.querySelector("#import-form").requestSubmit()');
  await until('!document.querySelector("#import-dialog").open && document.querySelectorAll("#board img").length === 3');
  await click('[data-seconds="1"]');
  await assertOwnSideRecommendation('white', 70, true);
  await click('#new-game');
  await until('document.querySelector("#new-game-dialog").open');
  await setStrength(100);
  await startGame();
  await click('#import');
  await setInput('#import-text', '7k/8/5KQ1/8/8/8/8/8 w - - 0 1');
  await evaluate('document.querySelector("#import-form").requestSubmit()');
  await until('!document.querySelector("#import-dialog").open && document.querySelectorAll("#board img").length === 3');
  await click('#analyze');
  await until('!document.querySelector("#play-best").hidden && !document.querySelector("#play-best").disabled');
  assert.equal(await evaluate('window.analysisRequests.at(-1).strength'), 100, 'Full-strength recommendations require selecting full strength');
  assert.equal(await evaluate('window.analysisRequests.at(-1).forgiving'), false);
  assert.equal(await evaluate('document.querySelector("#best-move-label").textContent'), 'BEST MOVE');
  await click('#play-best');
  await until('document.querySelector("#game-result").textContent.toLowerCase().includes("checkmate")');
  await until(`${coachReady} && document.querySelector('#coach-status').textContent.includes('Checkmate')`);
  await reload();
  await until('document.querySelector("#game-result")?.textContent.toLowerCase().includes("checkmate")');
  await until(coachReady);
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await delay(250);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'Mobile layout must not overflow horizontally');
  assert.equal(await evaluate(`(() => {
    const panel = document.querySelector('#coach-panel').getBoundingClientRect();
    return panel.left >= 0 && panel.right <= innerWidth && document.querySelector('#coach-panel').scrollWidth <= document.querySelector('#coach-panel').clientWidth;
  })()`), true, 'Written move review must fit the mobile viewport');
  const mobile = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile('artifacts/mobile.png', Buffer.from(mobile.data, 'base64'));
  await click('#new-game');
  await until('document.querySelector("#new-game-dialog").open');
  assert.equal(await evaluate(`(() => {
    const dialog = document.querySelector('#new-game-dialog').getBoundingClientRect();
    const submit = document.querySelector('#start-game').getBoundingClientRect();
    return dialog.left >= 0 && dialog.right <= innerWidth && dialog.top >= 0 && dialog.bottom <= innerHeight && submit.bottom <= dialog.bottom;
  })()`), true, 'New-game dialog and submit button must fit the mobile viewport');
  const mobileSetup = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile('artifacts/new-game-mobile.png', Buffer.from(mobileSetup.data, 'base64'));
  await call('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 1, mobile: true });
  await delay(250);
  assert.equal(await evaluate(`(() => {
    const dialog = document.querySelector('#new-game-dialog');
    const bounds = dialog.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight && dialog.scrollWidth <= dialog.clientWidth;
  })()`), true, 'New-game dialog must fit a narrow mobile viewport without horizontal overflow');
  await evaluate('document.querySelector("#start-game").scrollIntoView({ block: "nearest" })');
  assert.equal(await evaluate('document.querySelector("#start-game").getBoundingClientRect().bottom <= innerHeight'), true, 'Start button must remain reachable on narrow mobile');
  const narrowSetup = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile('artifacts/new-game-narrow.png', Buffer.from(narrowSetup.data, 'base64'));
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await click('#close-new-game');
  await click('#import');
  await setInput('#import-text', '7k/P7/8/8/8/8/8/7K w - - 0 1');
  await evaluate('document.querySelector("#import-form").requestSubmit()');
  await until('!document.querySelector("#import-dialog").open && !document.querySelector("#submit-move").disabled');
  await click('[data-square="a7"]');
  await click('[data-square="a8"]');
  await until('document.querySelector("#promotion-dialog").open');
  await click('[data-promotion="n"]');
  await until('document.querySelector("[data-square=a8]").getAttribute("aria-label").includes("white knight")');
  await click('#import');
  await click('[data-import-type="pgn"]');
  await setInput('#import-text', '1. e4 e5 2. Nf3 Nc6 *');
  await evaluate('document.querySelector("#import-form").requestSubmit()');
  await until('!document.querySelector("#import-dialog").open && document.querySelectorAll(".history-move").length === 4');
  await until(coachReady);
  assert.equal(await evaluate('document.querySelectorAll("#coach-move option").length'), 4);
  assert.equal(await evaluate('document.querySelector("#coach-move").value'), '4');
  await evaluate(`(() => {
    const saved = JSON.parse(localStorage.getItem('knightfall.workspace.v1'));
    saved.settings.strength = 150;
    saved.settings.forgiving = true;
    localStorage.setItem('knightfall.workspace.v1', JSON.stringify(saved));
  })()`);
  await reload();
  await until('document.querySelectorAll(".history-move").length === 4 && !document.querySelector("#submit-move").disabled');
  assert.equal(await evaluate(`${savedSettings}.strength`), 70, 'Invalid saved strength must return to the default difficulty, not full strength');
  assert.equal(await evaluate(`${savedSettings}.forgiving`), false, 'Invalid saved strength must clear the old forgiving setting');
  await recordAnalysis();
  await assertOwnSideRecommendation('white', 70, false);
  await evaluate(`(() => {
    const saved = JSON.parse(localStorage.getItem('knightfall.workspace.v1'));
    delete saved.settings.strength;
    localStorage.setItem('knightfall.workspace.v1', JSON.stringify(saved));
  })()`);
  await reload();
  assert.equal(await evaluate(`${savedSettings}.strength`), 70, 'Legacy saved games without a strength setting must use the default difficulty');

  // Keep real position/move validation while making deliberate engine proposals deterministic.
  const savedWorkspace = 'JSON.parse(localStorage.getItem("knightfall.workspace.v1"))';
  const installPracticeEngine = () => evaluate(`(() => {
    const originalFetch = window.fetch.bind(window);
    window.practiceRequests = [];
    window.practiceHeldResponses = [];
    window.practiceHold = false;
    window.practiceFailMove = false;
    window.fetch = async (url, options) => {
      if (url === '/api/move' && window.practiceFailMove) {
        window.practiceFailMove = false;
        throw new Error('Intentional move failure');
      }
      if (url !== '/api/analyze') return originalFetch(url, options);
      const body = JSON.parse(options.body);
      window.practiceRequests.push(body);
      const position = await (await originalFetch('/api/position', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
      const move = position.legalMoves.find(item => item.uci === 'g8f6') || position.legalMoves[0];
      const event = body.practice ? { ply: body.moves.length, move: move.uci, lossCp: 80 } : null;
      const response = new Response(JSON.stringify({
        requestId: body.requestId, positionFen: position.fen, bestMove: move.uci, bestSan: move.san,
        strength: body.strength, score: { cp: 0 }, depth: 12, nodes: 1000, timeMs: 20, lines: [],
        practice: { target: body.practice?.target || 0, used: body.practice?.events.length || 0, deliberate: Boolean(event), lossCp: event?.lossCp ?? null, event },
      }), { headers: { 'Content-Type': 'application/json' } });
      if (window.practiceHold) return new Promise(resolve => window.practiceHeldResponses.push(() => resolve(response)));
      return response;
    };
  })()`);
  const practicePreview = async () => {
    await click('#analyze');
    await until('!document.querySelector("#play-best").hidden && !document.querySelector("#play-best").disabled && document.querySelector("#stop").hidden');
  };
  await click('#new-game');
  await until('document.querySelector("#new-game-dialog").open');
  assert.equal(await evaluate('document.querySelector("#game-inaccuracies").value'), '0', 'Existing settings default to no extra mistakes');
  await setStrength(70);
  await setInput('#game-inaccuracies', '2');
  await setInput('#game-color', 'white');
  await startGame();
  await click('#auto-reply');
  await click('#coach-auto');
  assert.equal(await evaluate(`${savedSettings}.strength`), 70, 'Extra mistakes must preserve the chosen difficulty');
  assert.equal(await evaluate(`${savedSettings}.extraInaccuracies`), 2);
  assert.equal(await evaluate(`${savedWorkspace}.practice.startPly`), 0);
  await installPracticeEngine();
  for (const [index, move] of ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4'].entries()) {
    await setInput('#move-input', move);
    await evaluate('document.querySelector("#move-form").requestSubmit()');
    await until(`${savedWorkspace}.moves.length === ${index + 1} && !document.querySelector('#submit-move').disabled`);
  }
  await practicePreview();
  assert.equal(await evaluate('window.practiceRequests.at(-1).strength'), 70);
  assert.deepEqual(await evaluate('window.practiceRequests.at(-1).practice'), { target: 2, startPly: 0, events: [] });
  assert.equal(await evaluate(`${savedWorkspace}.practice.events.length`), 0, 'Preview must not consume an extra mistake');
  await evaluate('window.practiceFailMove = true');
  await click('#play-best');
  await until('!document.querySelector("#play-best").disabled && document.querySelector("#message").classList.contains("error")');
  assert.equal(await evaluate(`${savedWorkspace}.moves.length`), 7);
  assert.equal(await evaluate(`${savedWorkspace}.practice.events.length`), 0, 'A failed move must not consume an extra mistake');
  await click('#play-best');
  await until(`${savedWorkspace}.moves.length === 8 && !document.querySelector('#submit-move').disabled`);
  assert.deepEqual(await evaluate(`${savedWorkspace}.practice.events`), [{ ply: 7, move: 'g8f6', lossCp: 80 }]);
  assert.equal(await evaluate('document.querySelector("#practice-inaccuracies-status").textContent'), 'Extra inaccuracies: 1/2 target');
  await click('#play-best');
  assert.equal(await evaluate(`${savedWorkspace}.practice.events.length`), 1, 'An applied result must not count twice');
  const committedPractice = await evaluate('localStorage.getItem("knightfall.workspace.v1")');
  await reload();
  await until(`${savedWorkspace}.moves.length === 8 && !document.querySelector('#submit-move').disabled`);
  assert.equal(await evaluate(`${savedWorkspace}.practice.events.length`), 1, 'Reload must restore consumed allowance');
  await evaluate(`(() => {
    const saved = ${savedWorkspace};
    saved.practice.events[0].ply = '7';
    localStorage.setItem('knightfall.workspace.v1', JSON.stringify(saved));
  })()`);
  await reload();
  await until('!document.querySelector("#submit-move").disabled');
  assert.equal(await evaluate(`${savedWorkspace}.practice.events.length`), 0, 'Malformed saved events must be rejected');
  assert.equal(await evaluate(`${savedWorkspace}.practice.startPly`), 8, 'Malformed ledgers restart from the restored position');
  await evaluate(`localStorage.setItem('knightfall.workspace.v1', ${JSON.stringify(committedPractice)})`);
  await reload();
  await until(`${savedWorkspace}.practice.events.length === 1 && !document.querySelector('#submit-move').disabled`);
  await installPracticeEngine();
  await click('#solver-white');
  assert.equal(await evaluate(`${savedWorkspace}.practice.events.length`), 1, 'Changing sides must preserve the consumed allowance');
  await click('#undo');
  await until(`${savedWorkspace}.moves.length === 7 && !document.querySelector('#submit-move').disabled`);
  assert.equal(await evaluate(`${savedWorkspace}.practice.events.length`), 0, 'Undoing a deliberate move must restore its allowance');
  await practicePreview();
  assert.equal(await evaluate('Object.hasOwn(window.practiceRequests.at(-1), "practice")'), false, 'Human-side analysis must never request extra mistakes');
  assert.equal(await evaluate('window.practiceRequests.at(-1).strength'), 70, 'Changing engine sides must preserve the chosen recommendation strength');
  assert.equal(await evaluate('window.practiceRequests.at(-1).forgiving'), false);
  assert.equal(await evaluate('document.querySelector("#best-move-label").textContent'), 'ENGINE MOVE');
  await click('#solver-black');
  await evaluate('window.practiceHold = true');
  await click('#analyze');
  await until('window.practiceHeldResponses.length === 1');
  await click('#stop');
  await evaluate('window.practiceHold = false; window.practiceHeldResponses.splice(0).forEach(release => release())');
  await until('document.querySelector("#stop").hidden && !document.querySelector("#analyze").disabled');
  assert.equal(await evaluate(`${savedWorkspace}.practice.events.length`), 0, 'Cancelled analysis must not consume the allowance');
  await practicePreview();
  await click('#play-best');
  await until(`${savedWorkspace}.practice.events.length === 1 && !document.querySelector('#submit-move').disabled`);
  await click('#import');
  await click('[data-import-type="pgn"]');
  await setInput('#import-text', '1. e4 e5 2. Nf3 Nc6 *');
  await evaluate('document.querySelector("#import-form").requestSubmit()');
  await until('!document.querySelector("#import-dialog").open && !document.querySelector("#submit-move").disabled');
  assert.equal(await evaluate(`${savedSettings}.extraInaccuracies`), 2, 'PGN imports preserve the selected target');
  assert.deepEqual(await evaluate(`({ startPly: ${savedWorkspace}.practice.startPly, events: ${savedWorkspace}.practice.events })`), { startPly: 4, events: [] }, 'PGN import starts a new budget even with the same initial FEN');
  await click('#import');
  await click('#open-screenshot');
  await until('document.querySelector("#screenshot-dialog").open');
  assert.equal(await evaluate('document.querySelector("#screenshot-inaccuracies").value'), '2', 'Screenshot setup must inherit the chosen target');
  await setInput('#screenshot-inaccuracies', '1');
  await click('#screenshot-cancel');
  await until('!document.querySelector("#screenshot-dialog").open && !document.querySelector("#new-game").disabled');
  assert.equal(await evaluate(`${savedSettings}.extraInaccuracies`), 2, 'Cancelled screenshot setup must preserve the current target');
  await click('#new-game');
  await until('document.querySelector("#new-game-dialog").open');
  await setStrength(100);
  await setInput('#game-inaccuracies', '1');
  await startGame();
  await click('#auto-reply');
  assert.equal(await evaluate(`${savedWorkspace}.practice.events.length`), 0, 'New game clears old events');
  assert.equal(await evaluate(`${savedWorkspace}.practice.startPly`), 0);
  for (const [index, move] of ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4'].entries()) {
    await setInput('#move-input', move);
    await evaluate('document.querySelector("#move-form").requestSubmit()');
    await until(`${savedWorkspace}.moves.length === ${index + 1} && !document.querySelector('#submit-move').disabled`);
  }
  await practicePreview();
  assert.equal(await evaluate('document.querySelector("#best-move-label").textContent'), 'ENGINE MOVE', 'A deliberate move must not be labelled best at full strength');
  assert.equal(await evaluate('document.querySelector("#play-best").textContent'), 'Play engine move');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'The extra-inaccuracy counter must fit mobile');
  assert.deepEqual(errors, [], 'Browser console should have no runtime/CSP errors');
  console.log('PASS: new-game setup/cancel, practice strength/forgiving configuration, reduced White/Black own-side recommendations and labels, restored recommendation settings, full-strength option, settings persistence, board clicks, automatic black reply, undo pair, flip, automatic white opening, cancellation/restart, stale-result prevention, FEN/PGN import, underpromotion, forced mate at selected full strength, reload persistence, written coach notes, manual review without board mutation, coach strength profiles, late review suppression after undo/new game, single-board desktop and mobile layout, extra-inaccuracy setup/preview/commit/failure/cancellation/undo/reload/side switch/import reset and full-strength deliberate-move labels.');
  console.log('Screenshots: artifacts/desktop.png, artifacts/desktop-1280.png, artifacts/desktop-1920.png, artifacts/mobile.png, artifacts/new-game-desktop.png, artifacts/new-game-mobile.png, artifacts/new-game-narrow.png');
} finally {
  client?.close();
  chrome.kill('SIGTERM');
}
