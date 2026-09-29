// Practice target UI and committed-move accounting using Chrome CDP.
// Uses native Stockfish first, then deterministic proposals with real move validation.
// Run: node scripts/target_accuracy_smoke.mjs [http://127.0.0.1:8877]
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const base = process.argv[2] || 'http://127.0.0.1:8877';
const profile = await mkdtemp(join(tmpdir(), 'knightfall-target-browser-'));
const executable = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const chrome = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const started = Date.now();
const progress = message => console.log(`[target +${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
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
  const pending = new Map(), errors = [];
  let nextId = 0;
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
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
  const workspace = 'JSON.parse(localStorage.getItem("knightfall.workspace.v1"))';
  const ready = '!document.querySelector("#submit-move").disabled && document.querySelector("#stop").hidden';
  const until = async (expression, timeout = 30000) => {
    const deadline = Date.now() + timeout;
    do { if (await evaluate(expression)) return; await delay(100); } while (Date.now() < deadline);
    throw new Error(`Timed out: ${expression}; state: ${JSON.stringify(await evaluate(`({ saved: ${workspace}, message: document.querySelector('#message')?.textContent, requests: window.targetRequests, responses: window.targetResponses })`))}`);
  };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const input = (selector, value) => evaluate(`document.querySelector(${JSON.stringify(selector)}).value = ${JSON.stringify(value)}`);
  const select = async (selector, value) => {
    await input(selector, value);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change', { bubbles: true }))`);
  };
  const reload = async () => {
    await evaluate('window.targetReloadPending = true');
    await call('Page.reload');
    await until(`!window.targetReloadPending && document.querySelectorAll('#board .square').length === 64 && document.querySelector('#connection-dot')?.classList.contains('ready') && ${ready}`);
  };
  const move = async (san, plies) => {
    await input('#move-input', san);
    await evaluate('document.querySelector("#move-form").requestSubmit()');
    await until(`${workspace}.moves.length === ${plies} && ${ready}`);
  };
  const preview = async () => {
    await click('#analyze');
    await until(`!document.querySelector('#play-best').hidden && !document.querySelector('#play-best').disabled && ${ready}`);
  };
  const startGame = async () => {
    await evaluate('document.querySelector("#new-game-form").requestSubmit()');
    await until(`!document.querySelector('#new-game-dialog').open && ${ready}`);
  };

  await call('Runtime.enable');
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const originalFetch = window.fetch.bind(window);
    window.targetRequests = []; window.targetResponses = []; window.targetHeld = [];
    window.targetMock = false; window.targetHold = false; window.targetFailMove = false;
    window.fetch = async (url, options) => {
      if (url === '/api/move' && window.targetFailMove) {
        window.targetFailMove = false;
        throw new Error('Intentional move failure');
      }
      if (url !== '/api/analyze') return originalFetch(url, options);
      const body = JSON.parse(options.body);
      window.targetRequests.push(body);
      let response;
      if (window.targetMock) {
        const position = await (await originalFetch('/api/position', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
        const move = position.legalMoves[0];
        const event = body.accuracyTarget ? { ply: body.moves.length, move: move.uci, before: 60, after: 57, accuracy: window.KnightfallAccuracyMath.moveAccuracy(60, 57) } : null;
        response = new Response(JSON.stringify({ requestId: body.requestId, positionFen: position.fen, bestMove: move.uci, bestSan: move.san,
          strength: body.strength, forgiving: body.forgiving, skillLevel: body.accuracyTarget ? 20 : 12, score: { cp: 0, mate: null }, depth: 14, nodes: 1000, timeMs: 20, lines: [],
          accuracyTarget: event ? { enabled: true, lower: 85, upper: 90, estimatedAccuracy: event.accuracy, event, reason: 'target-choice' } : null,
          practice: { target: body.practice?.target || 0, deliberate: false, event: null } }), { headers: { 'Content-Type': 'application/json' } });
      } else response = await originalFetch(url, options);
      window.targetResponses.push(await response.clone().json());
      if (window.targetHold) return new Promise(resolve => window.targetHeld.push(() => resolve(response)));
      return response;
    };
  })()` });
  await call('Page.navigate', { url: base });
  await until('document.querySelector("#new-game-dialog")?.open && document.querySelectorAll("#board .square").length === 64');
  assert.equal(await evaluate('document.querySelector("#game-opponent-style").value'), 'target-85-90');
  assert.equal(await evaluate('document.querySelector("#game-inaccuracies").disabled'), true);
  await select('#game-opponent-style', 'classic');
  assert.equal(await evaluate('document.querySelector("#game-inaccuracies").disabled'), false);
  await input('#game-inaccuracies', '2');
  await select('#game-opponent-style', 'target-85-90');
  assert.equal(await evaluate('document.querySelector("#game-inaccuracies").value'), '2', 'Target mode preserves the classic extra-error preference');
  await input('#game-strength', '67');
  await evaluate('document.querySelector("#game-strength").dispatchEvent(new Event("input", { bubbles: true }))');
  await startGame();
  await click('#coach-auto');
  assert.equal(await evaluate(`${workspace}.settings.opponentStyle`), 'target-85-90');
  assert.equal(await evaluate('document.querySelector("#practice-summary").textContent'), 'Opponent target: 85–90% local accuracy');
  assert.equal(await evaluate('document.querySelector("#practice-inaccuracies-status").hidden'), true);
  assert.match(await evaluate('document.querySelector("#practice-opponent-note").textContent'), /outside this range/);
  progress('Default mode and classic option checked; testing native requests');
  await preview();
  const ownRequest = await evaluate('window.targetRequests.at(-1)');
  assert.equal(ownRequest.strength, 67);
  assert.equal(Object.hasOwn(ownRequest, 'accuracyTarget'), false);
  assert.equal(Object.hasOwn(ownRequest, 'practice'), false);
  assert.equal(await evaluate(`${workspace}.accuracyTarget.events.length`), 0);
  await move('e4', 2);
  const nativeRequest = await evaluate('window.targetRequests.at(-1)');
  const nativeResponse = await evaluate('window.targetResponses.at(-1)');
  assert.deepEqual(nativeRequest.accuracyTarget, { enabled: true, startPly: 0, events: [] });
  assert.equal(nativeRequest.practice.target, 0);
  assert.deepEqual(nativeRequest.practice.events, []);
  assert.equal(nativeResponse.skillLevel, 20);
  assert.equal(nativeResponse.accuracyTarget?.enabled, true);
  assert.ok(nativeResponse.accuracyTarget.event, 'Native search must produce a valid committed-move event');
  assert.deepEqual(await evaluate(`${workspace}.accuracyTarget.events`), [nativeResponse.accuracyTarget.event]);
  const nativeLedger = await evaluate(`${workspace}.accuracyTarget`);
  await reload();
  assert.deepEqual(await evaluate(`${workspace}.accuracyTarget`), nativeLedger, 'Reload restores only actual committed target moves');
  assert.equal(await evaluate(`${workspace}.settings.extraInaccuracies`), 2);
  progress('Native auto-reply and restored ledger checked; testing transactional edge cases');

  await click('#auto-reply');
  await evaluate('window.targetMock = true');
  await move('Nf3', 3);
  await preview();
  assert.equal(await evaluate(`${workspace}.accuracyTarget.events.length`), 1, 'Previewing must not count as playing');
  assert.deepEqual(await evaluate('window.targetRequests.at(-1).accuracyTarget.events'), nativeLedger.events);
  await evaluate('window.targetFailMove = true');
  await click('#play-best');
  await until(`${ready} && document.querySelector('#message').classList.contains('error')`);
  assert.equal(await evaluate(`${workspace}.moves.length`), 3);
  assert.equal(await evaluate(`${workspace}.accuracyTarget.events.length`), 1, 'Failed move must not commit target history');
  await click('#play-best');
  await until(`${workspace}.moves.length === 4 && ${ready}`);
  assert.equal(await evaluate(`${workspace}.accuracyTarget.events.length`), 2);
  await click('#undo');
  await until(`${workspace}.moves.length === 3 && ${ready}`);
  assert.equal(await evaluate(`${workspace}.accuracyTarget.events.length`), 1, 'Undo prunes the exact reverted move');
  await evaluate('window.targetHold = true');
  await click('#analyze');
  await until('window.targetHeld.length === 1');
  await click('#stop');
  await evaluate('window.targetHold = false; window.targetHeld.splice(0).forEach(release => release())');
  await until(ready);
  assert.equal(await evaluate(`${workspace}.accuracyTarget.events.length`), 1, 'Late cancelled response cannot commit history');
  assert.equal(await evaluate(`${workspace}.moves.length`), 3);
  await preview();
  await click('#play-best');
  await until(`${workspace}.moves.length === 4 && ${ready}`);
  await click('#auto-reply');
  await click('#undo');
  await until(`${workspace}.moves.length === 2 && ${ready}`);
  assert.equal(await evaluate(`${workspace}.accuracyTarget.events.length`), 1, 'Undo pair retains earlier committed moves');
  await click('#undo');
  await until(`${workspace}.moves.length === 0 && ${ready}`);
  assert.equal(await evaluate(`${workspace}.accuracyTarget.events.length`), 0);
  await click('#auto-reply');

  await click('#import');
  await click('[data-import-type="pgn"]');
  await input('#import-text', '1. e4 e5 2. Nf3 Nc6 *');
  await evaluate('document.querySelector("#import-form").requestSubmit()');
  await until(`!document.querySelector('#import-dialog').open && ${workspace}.moves.length === 4 && ${ready}`);
  assert.deepEqual(await evaluate(`({ startPly: ${workspace}.accuracyTarget.startPly, events: ${workspace}.accuracyTarget.events })`), { startPly: 4, events: [] });
  await move('Bb5', 5);
  await preview();
  await click('#play-best');
  await until(`${workspace}.accuracyTarget.events.length === 1 && ${ready}`);
  await click('#solver-white');
  assert.equal(await evaluate(`${workspace}.accuracyTarget.events.length`), 0, 'Switching opponent color resets its forecast');
  assert.equal(await evaluate(`${workspace}.accuracyTarget.startPly`), 6);
  await click('#solver-black');
  await evaluate(`(() => { const saved = ${workspace}; delete saved.settings.opponentStyle; localStorage.setItem('knightfall.workspace.v1', JSON.stringify(saved)); })()`);
  await reload();
  assert.equal(await evaluate(`${workspace}.settings.opponentStyle`), 'target-85-90', 'Legacy settings use the new default');
  progress('Preview/failure/cancellation/undo/import/side change checked');

  await click('#import');
  await click('#open-screenshot');
  await until('document.querySelector("#screenshot-dialog").open');
  assert.equal(await evaluate('document.querySelector("#screenshot-opponent-style").value'), 'target-85-90');
  assert.equal(await evaluate('document.querySelector("#screenshot-inaccuracies").disabled'), true);
  assert.equal(await evaluate('document.querySelector("#screenshot-inaccuracies").value'), '2');
  await select('#screenshot-opponent-style', 'classic');
  assert.equal(await evaluate('document.querySelector("#screenshot-inaccuracies").disabled'), false);
  await click('#screenshot-cancel');
  await until(`!document.querySelector('#screenshot-dialog').open && ${ready}`);
  assert.equal(await evaluate(`${workspace}.settings.opponentStyle`), 'target-85-90', 'Cancelling screenshot options preserves current mode');
  await click('#new-game');
  await until('document.querySelector("#new-game-dialog").open');
  await select('#game-opponent-style', 'classic');
  await startGame();
  assert.equal(await evaluate(`${workspace}.settings.opponentStyle`), 'classic');
  await reload();
  assert.equal(await evaluate(`${workspace}.settings.opponentStyle`), 'classic');
  await evaluate('window.targetMock = true');
  await move('e4', 2);
  assert.equal(Object.hasOwn(await evaluate('window.targetRequests.at(-1)'), 'accuracyTarget'), false, 'Classic opponent does not request targeting');
  assert.equal(await evaluate('window.targetRequests.at(-1).practice.target'), 2);
  await click('#new-game');
  await until('document.querySelector("#new-game-dialog").open');
  await select('#game-opponent-style', 'target-85-90');
  await select('#game-color', 'white');
  await input('#game-strength', '100');
  await evaluate('document.querySelector("#game-strength").dispatchEvent(new Event("input", { bubbles: true }))');
  await startGame();
  assert.equal(await evaluate(`${workspace}.accuracyTarget.events.length`), 0);
  await move('e4', 2);
  assert.equal(await evaluate('document.querySelector("#best-move-label").textContent'), 'ENGINE MOVE', 'A target move is not presented as best at suggestion strength 100');
  assert.equal(await evaluate('document.querySelector("#play-best").textContent'), 'Play engine move');
  const snapshot = await evaluate(`${workspace}`);
  await evaluate(`(() => { const saved = ${workspace}; saved.accuracyTarget.events[0].accuracy += .01; localStorage.setItem('knightfall.workspace.v1', JSON.stringify(saved)); })()`);
  await reload();
  assert.equal(await evaluate(`${workspace}.accuracyTarget.events.length`), 0, 'Inconsistent stored accuracy must be rejected');
  assert.equal(await evaluate(`${workspace}.accuracyTarget.startPly`), 2);
  await mkdir('artifacts', { recursive: true });
  const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile('artifacts/target-accuracy-desktop.png', Buffer.from(screenshot.data, 'base64'));
  await writeFile('artifacts/target-accuracy-browser.json', JSON.stringify({ nativeRequest, nativeResponse, finalCommittedExample: snapshot }, null, 2));
  assert.deepEqual(errors, [], 'Browser should not raise uncaught exceptions');
  progress('PASS: default/classic modes, native target request and auto-commit, own recommendations, persistence, failed/unapplied/cancelled moves, undo, import, side reset, screenshot controls, malformed restore, and labels');
} finally {
  client?.close();
  chrome.kill('SIGTERM');
}
