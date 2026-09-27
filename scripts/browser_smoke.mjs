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
    throw new Error(`Timed out waiting for ${expression}; page: ${await evaluate('document.body.innerText.slice(0,2500)')}`);
  };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const setInput = (selector, value) => evaluate(`document.querySelector(${JSON.stringify(selector)}).value = ${JSON.stringify(value)}`);
  const historyCount = 'document.querySelectorAll(".history-row").length';
  await call('Runtime.enable');
  await call('Log.enable');
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: base });
  await until('document.querySelectorAll("#board .square").length === 64 && !document.querySelector("#submit-move").disabled');
  assert.equal(await evaluate('document.querySelectorAll("#board img").length'), 32);
  await click('[data-seconds="1"]');
  await setInput('#move-input', 'e4');
  await evaluate('document.querySelector("#move-form").requestSubmit()');
  await until('document.querySelector("#history").textContent.includes("e4") && !document.querySelector("#stop").hidden');
  await until('!document.querySelector("#submit-move").disabled && document.querySelector("#best-move").textContent !== "—"');
  assert.equal(await evaluate(historyCount), 1);
  assert.equal(await evaluate('document.querySelectorAll(".history-row .history-move").length'), 2);
  assert.equal(await evaluate('document.querySelector("#move-form").getBoundingClientRect().bottom <= innerHeight'), true, 'Board and move input should fit a 900px desktop viewport');
  await mkdir('artifacts', { recursive: true });
  const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile('artifacts/desktop.png', Buffer.from(screenshot.data, 'base64'));
  await click('#undo');
  await until(`${historyCount} === 0 && !document.querySelector('#submit-move').disabled`);
  await click('[data-square="d2"]');
  assert.equal(await evaluate('document.querySelector("[data-square=d4]").classList.contains("legal")'), true);
  await click('[data-square="d4"]');
  await until('document.querySelectorAll(".history-move").length === 2 && !document.querySelector("#submit-move").disabled');
  await click('#flip');
  assert.equal(await evaluate('document.querySelector("#board .square").dataset.square'), 'h1');
  await click('#flip');
  await click('#undo');
  await until(`${historyCount} === 0 && !document.querySelector('#submit-move').disabled`);
  await click('#solver-white');
  await until(`${historyCount} === 1 && !document.querySelector('#submit-move').disabled`);
  await click('#auto-reply');
  await click('#new-game');
  await until(`${historyCount} === 0 && !document.querySelector('#submit-move').disabled`);
  await click('[data-seconds="30"]');
  await click('#analyze');
  await until('!document.querySelector("#stop").hidden');
  await click('#stop');
  await until('document.querySelector("#stop").hidden && !document.querySelector("#analyze").disabled');
  assert.equal(await evaluate(historyCount), 0, 'A cancelled search must not play a move');
  await click('#analyze');
  await until('!document.querySelector("#stop").hidden');
  await click('#new-game');
  await until('document.querySelector("#stop").hidden && !document.querySelector("#analyze").disabled');
  assert.equal(await evaluate(historyCount), 0, 'New game must discard the old analysis');
  await click('#import');
  await setInput('#import-text', '7k/8/5KQ1/8/8/8/8/8 w - - 0 1');
  await evaluate('document.querySelector("#import-form").requestSubmit()');
  await until('!document.querySelector("#import-dialog").open && document.querySelectorAll("#board img").length === 3');
  await click('[data-seconds="1"]');
  await click('#analyze');
  await until('!document.querySelector("#play-best").hidden && !document.querySelector("#play-best").disabled');
  await click('#play-best');
  await until('document.querySelector("#game-result").textContent.toLowerCase().includes("checkmate")');
  await call('Page.reload');
  await until('document.querySelector("#game-result")?.textContent.toLowerCase().includes("checkmate")');
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await delay(250);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'Mobile layout must not overflow horizontally');
  const mobile = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile('artifacts/mobile.png', Buffer.from(mobile.data, 'base64'));
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
  assert.deepEqual(errors, [], 'Browser console should have no runtime/CSP errors');
  console.log('PASS: board clicks, automatic black reply, undo pair, flip, automatic white opening, cancellation/restart, stale-result prevention, FEN/PGN import, underpromotion, forced mate, reload persistence, mobile layout.');
  console.log('Screenshots: artifacts/desktop.png and artifacts/mobile.png');
} finally {
  client?.close();
  chrome.kill('SIGTERM');
}
