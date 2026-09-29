// Learning-arrow integration checks using Chrome CDP and the running Stockfish server.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const base = process.argv[2] || 'http://127.0.0.1:8877';
const profile = await mkdtemp(join(tmpdir(), 'knightfall-arrows-browser-'));
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
    throw new Error(`Timed out waiting for ${expression}; arrow state: ${JSON.stringify(await evaluate(`({ status: document.querySelector('#arrows-status')?.textContent, reviewStatus: document.querySelector('#review-arrows-status')?.textContent, error: document.querySelector('#arrows-error')?.textContent, requests: window.arrowRequests?.slice(-3), responses: window.arrowResponses?.slice(-3).map(result => ({ requestId: result.requestId, positionFen: result.positionFen, lookahead: result.lookahead, cancelled: result.cancelled, error: result.error, ideas: result.ideas?.length })) })`))}`);
  };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const setInput = (selector, value) => evaluate(`document.querySelector(${JSON.stringify(selector)}).value = ${JSON.stringify(value)}`);
  const select = async (selector, value) => {
    await setInput(selector, value);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change', { bubbles: true }))`);
  };
  const workspace = 'JSON.parse(localStorage.getItem("knightfall.workspace.v1"))';
  const savedGame = `JSON.stringify({ saved: (({ clock, ...game }) => game)(${workspace}), squares: Array.from(document.querySelectorAll('#board .square'), square => square.getAttribute('aria-label')), history: document.querySelector('#history').textContent })`;
  const currentFen = async () => evaluate(`(async () => {
    const saved = ${workspace};
    return (await (await fetch('/api/position', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ initialFen: saved.initialFen, moves: saved.moves }) })).json()).fen;
  })()`);
  const screenshot = async name => {
    const result = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(`artifacts/${name}.png`, Buffer.from(result.data, 'base64'));
  };
  const mouseClick = async selector => {
    const point = await evaluate(`(() => {
      const target = document.querySelector(${JSON.stringify(selector)});
      target.scrollIntoView({ block: 'center' });
      const bounds = target.getBoundingClientRect();
      return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    })()`);
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  const importPosition = async (text, kind = 'fen') => {
    await click('#import');
    await click(`[data-import-type="${kind}"]`);
    await setInput('#import-text', text);
    await evaluate('document.querySelector("#import-form").requestSubmit()');
    await until('!document.querySelector("#import-dialog").open && !document.querySelector("#submit-move").disabled');
  };
  const recordRequests = () => evaluate(`(() => {
    const original = window.fetch.bind(window);
    window.arrowRequests = [];
    window.arrowResponses = [];
    window.arrowStops = [];
    window.arrowHeld = [];
    window.arrowHold = false;
    window.arrowFailOnce = false;
    window.fetch = async (url, options) => {
      if (url === '/api/arrows/stop') window.arrowStops.push(JSON.parse(options.body));
      if (url !== '/api/arrows') return original(url, options);
      const request = JSON.parse(options.body);
      window.arrowRequests.push(request);
      if (window.arrowFailOnce) { window.arrowFailOnce = false; throw new TypeError('Intentional arrow transport failure'); }
      const response = await original(url, options);
      const body = await response.clone().text();
      const result = JSON.parse(body);
      window.arrowResponses.push(result);
      if (window.arrowHold && response.ok && !result.cancelled) {
        const delayed = new Response(body, { status: response.status, headers: response.headers });
        return new Promise(resolve => window.arrowHeld.push(() => resolve(delayed)));
      }
      return response;
    };
  })()`);
  const arrows = (prefix = '') => `document.querySelectorAll('#${prefix}arrows-overlay [data-from][data-to]')`;
  const arrowCount = (prefix = '') => `${arrows(prefix)}.length`;
  const visibleFen = (prefix = '') => `document.querySelector('#${prefix}arrows-overlay').dataset.fen`;
  const ready = async (fen, prefix = '') => until(`${visibleFen(prefix)} === ${JSON.stringify(fen)} && document.querySelector('#${prefix}arrows-status').textContent.startsWith('Ready') && document.querySelector('#${prefix}arrows-error-box').hidden`);
  const enable = async (enabled, prefix = '') => {
    if (await evaluate(`document.querySelector('#${prefix}arrows-enabled').checked`) !== enabled) await click(`#${prefix}arrows-enabled`);
  };
  const colors = async (white, black, prefix = '') => {
    for (const [color, enabled] of [['white', white], ['black', black]]) {
      if (await evaluate(`document.querySelector('#${prefix}arrows-${color}').getAttribute('aria-pressed') === 'true'`) !== enabled) await click(`#${prefix}arrows-${color}`);
    }
  };
  const geometry = async (prefix = '') => {
    const result = await evaluate(`(() => {
      const svg = document.querySelector('#${prefix}arrows-overlay');
      const board = document.querySelector('#${prefix ? 'review-' : ''}board');
      const arrow = svg.querySelector('[data-from][data-to]');
      if (!arrow) return { error: 'No arrow to inspect' };
      const path = arrow.querySelector('path');
      if (!path) return { error: 'No SVG path geometry' };
      const from = board.querySelector('[data-square="' + arrow.dataset.from + '"]').getBoundingClientRect();
      const to = board.querySelector('[data-square="' + arrow.dataset.to + '"]').getBoundingClientRect();
      const first = path.getPointAtLength(0), last = path.getPointAtLength(path.getTotalLength());
      const source = new DOMPoint(first.x, first.y).matrixTransform(svg.getScreenCTM());
      const destination = new DOMPoint(last.x, last.y).matrixTransform(svg.getScreenCTM());
      const bounds = board.getBoundingClientRect(), overlay = svg.getBoundingClientRect();
      const fromX = from.x + from.width / 2, fromY = from.y + from.height / 2, toX = to.x + to.width / 2, toY = to.y + to.height / 2;
      const distance = Math.hypot(toX - fromX, toY - fromY), ux = (toX - fromX) / distance, uy = (toY - fromY) / distance, scale = overlay.width / 800;
      // Paths stop short of the centres to leave space for the source ring and arrowhead.
      return { from: arrow.dataset.from, to: arrow.dataset.to, sourceError: Math.hypot(source.x - fromX - ux * 13 * scale, source.y - fromY - uy * 13 * scale), destinationError: Math.hypot(destination.x - toX + ux * 21 * scale, destination.y - toY + uy * 21 * scale), widthError: Math.abs(bounds.width - overlay.width), leftError: Math.abs(bounds.left - overlay.left), pointerEvents: getComputedStyle(svg).pointerEvents, viewBox: svg.getAttribute('viewBox') };
    })()`);
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.ok(result.sourceError < 1.5 && result.destinationError < 1.5 && result.widthError < 1.5 && result.leftError < 1.5, `Arrow endpoints must match actual board-square centres: ${JSON.stringify(result)}`);
    assert.equal(result.pointerEvents, 'none', 'Arrow overlay must allow board input through');
    assert.equal(result.viewBox, '0 0 800 800');
  };

  await call('Runtime.enable');
  await call('Log.enable');
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: base });
  await until('document.querySelector("#new-game-dialog")?.open && document.querySelectorAll("#board .square").length === 64');
  await evaluate('document.querySelector("#new-game-form").requestSubmit()');
  await until('!document.querySelector("#new-game-dialog").open && !document.querySelector("#submit-move").disabled');
  await evaluate('for (const id of ["auto-reply", "coach-auto"]) { const control = document.getElementById(id); if (control.checked) control.click(); }');
  await until('document.querySelector("#arrows-enabled") && document.querySelector("#arrows-overlay")');
  await recordRequests();
  assert.equal(await evaluate('document.querySelector("#arrows-enabled").checked'), false, 'Learning arrows start off');
  await select('#arrows-lookahead', '4');
  const pressureFen = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3';
  await importPosition(pressureFen);
  await delay(200);
  assert.equal(await evaluate('window.arrowRequests.length'), 0, 'Off means no arrow engine requests');
  assert.equal(await evaluate(arrowCount()), 0, 'Off means no board arrows');
  const initialGame = await evaluate(savedGame);
  await enable(true);
  await colors(true, true);
  await ready(pressureFen);
  assert.equal(await evaluate('window.arrowRequests.at(-1).strength'), 70, 'Live arrow projections respect playing difficulty');
  const pressureResponse = await evaluate(`window.arrowResponses.find(result => result.positionFen === ${JSON.stringify(pressureFen)} && !result.cancelled)`);
  const pressureArrows = pressureResponse.ideas.flatMap(idea => idea.arrows);
  assert.ok(pressureArrows.some(arrow => arrow.from === 'c4' && arrow.to === 'f7' && arrow.color === 'white'), 'Bishop c4 pressure on f7 must be represented');
  assert.ok(pressureArrows.some(arrow => arrow.from === 'h5' && arrow.to === 'f7' && arrow.color === 'white'), 'Queen h5 pressure on f7 must be represented');
  await click('#arrows-ideas [data-idea="coordination-white-53"]');
  assert.equal(await evaluate(`Array.from(${arrows()}).some(arrow => arrow.dataset.from === 'c4' && arrow.dataset.to === 'f7') && Array.from(${arrows()}).some(arrow => arrow.dataset.from === 'h5' && arrow.dataset.to === 'f7')`), true, 'Selecting the coordination idea renders both converging arrows');
  assert.deepEqual(await evaluate(`Array.from(new Set(Array.from(${arrows()}, arrow => arrow.dataset.color))).sort()`), ['black', 'white'], 'Both-color mode should display a plan for each side');
  await geometry();
  await colors(true, false);
  await until(`${arrowCount()} > 0`);
  assert.equal(await evaluate(`Array.from(${arrows()}, arrow => arrow.dataset.color).every(color => color === 'white')`), true, 'White filter includes only White arrow sources');
  await colors(false, true);
  await until(`${arrowCount()} > 0`);
  assert.equal(await evaluate(`Array.from(${arrows()}, arrow => arrow.dataset.color).every(color => color === 'black')`), true, 'Black filter includes only Black arrow sources');
  await colors(false, false);
  const bothOffRequests = await evaluate('window.arrowRequests.length');
  await delay(300);
  assert.equal(await evaluate(arrowCount()), 0, 'Both colors off clears all arrows');
  assert.equal(await evaluate('window.arrowRequests.length'), bothOffRequests, 'Both colors off does not request analysis');
  await colors(true, true);
  await ready(pressureFen);
  assert.equal(await evaluate(savedGame), initialGame, 'Arrow controls do not alter the match or saved playing settings');
  await click('#flip');
  await ready(pressureFen);
  await geometry();
  await click('#flip');
  await geometry();
  await mkdir('artifacts', { recursive: true });
  await evaluate('document.querySelector("#board").scrollIntoView({ block: "center" })');
  await screenshot('arrows-desktop');
  await evaluate('document.querySelector("#arrows-mode").scrollIntoView({ block: "center" })');
  await screenshot('arrows-controls-desktop');

  // Real mouse input crosses the SVG overlay and plays a legal move.
  await mouseClick('#board [data-square="a7"]');
  await mouseClick('#board [data-square="a6"]');
  await until(`${workspace}.moves.length === 1 && !document.querySelector('#submit-move').disabled`);
  assert.equal(await evaluate(`${workspace}.moves[0]`), 'a7a6', 'SVG overlay must not intercept board interaction');
  let fen = await currentFen();
  await ready(fen);
  const playedGame = await evaluate(savedGame);

  // Show only a legal engine branch; each returned turn is independently replayed by the server.
  await click('#arrows-mode-line');
  for (const horizon of ['3', '4']) {
    await select('#arrows-lookahead', horizon);
    await ready(fen);
    await until(`window.arrowResponses.some(result => result.positionFen === ${JSON.stringify(fen)} && result.lookahead === ${horizon} && !result.cancelled)`);
    const branch = await evaluate(`window.arrowResponses.filter(result => result.positionFen === ${JSON.stringify(fen)} && result.lookahead === ${horizon} && !result.cancelled).at(-1)`);
    assert.ok(branch.line.length > 0 && branch.line.length <= Number(horizon));
    await click(`#arrows-line button[data-step="${branch.line.length}"]`);
    assert.equal(await evaluate(arrowCount()), branch.line.length, 'Selecting a future turn draws each legal step through that turn');
    let precedingFen = fen;
    for (const step of branch.line) {
      assert.equal(step.beforeFen, precedingFen);
      const replay = await evaluate(`(async () => { const response = await fetch('/api/position', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ initialFen:${JSON.stringify(precedingFen)}, moves:[${JSON.stringify(step.move || step.uci)}] }) }); return response.json(); })()`);
      assert.equal(replay.fen, step.fen, 'Every preview step must be a legal move from its preceding board');
      precedingFen = step.fen;
    }
  }
  assert.equal(await evaluate(savedGame), playedGame, 'Inspecting engine branches is read only');
  await click('#arrows-mode-ideas');

  // Real response held across Undo must never repaint the abandoned board.
  await evaluate('window.arrowHold = true');
  await select('#arrows-lookahead', '6');
  await until('window.arrowHeld.length === 1');
  const obsoleteFen = fen;
  await click('#undo');
  await until(`${workspace}.moves.length === 0 && !document.querySelector('#submit-move').disabled`);
  await evaluate('window.arrowHold = false; window.arrowHeld.splice(0).forEach(release => release())');
  fen = await currentFen();
  await ready(fen);
  assert.notEqual(await evaluate(visibleFen()), obsoleteFen, 'A late undone position cannot return to the overlay');

  // A network error must expose recovery without changing board state.
  await evaluate('window.arrowFailOnce = true');
  await select('#arrows-lookahead', '2');
  await until('!document.querySelector("#arrows-error-box").hidden');
  await click('#arrows-retry');
  await ready(fen);
  assert.ok(await evaluate('document.querySelector("#arrows-error-box").hidden'));

  // Master off cancels an active request and ignores even an already received response.
  await evaluate('window.arrowHold = true');
  await select('#arrows-lookahead', '3');
  await until('window.arrowHeld.length === 1');
  const stoppedRequest = await evaluate('window.arrowRequests.at(-1).requestId');
  await enable(false);
  await until(`${arrowCount()} === 0`);
  await until(`window.arrowStops.some(request => request.requestId === ${JSON.stringify(stoppedRequest)})`);
  await evaluate('window.arrowHold = false; window.arrowHeld.splice(0).forEach(release => release())');
  await delay(250);
  assert.equal(await evaluate(arrowCount()), 0, 'Off remains off when a stale result arrives');
  await enable(true);
  await ready(fen);

  // The same stale-response guarantee applies to imports and new-game resets.
  await evaluate('window.arrowHold = true');
  await mouseClick('#board [data-square="a7"]');
  await mouseClick('#board [data-square="a5"]');
  await until('window.arrowHeld.length === 1');
  await importPosition('1. e4 e5 2. Nf3 Nc6 *', 'pgn');
  await evaluate('window.arrowHold = false; window.arrowHeld.splice(0).forEach(release => release())');
  fen = await currentFen();
  await ready(fen);
  assert.notEqual(fen, pressureFen);
  const beforeReview = await evaluate(savedGame);

  // Review arrows follow the displayed replay or projected board at teacher strength.
  await click('#review-match');
  await until('document.querySelector("#match-review-dialog").open && document.querySelector("#review-arrows-enabled")');
  await enable(true, 'review-');
  await colors(true, true, 'review-');
  await click('#review-arrows-mode-line');
  let replayFen = await evaluate('document.querySelector("#review-board").dataset.fen');
  await ready(replayFen, 'review-');
  await until('window.arrowRequests.at(-1).strength === 100');
  await click('#review-next');
  await until('document.querySelector("#review-move").value === "1" && !document.querySelector("#review-content").hidden');
  replayFen = await evaluate('document.querySelector("#review-board").dataset.fen');
  await ready(replayFen, 'review-');
  await geometry('review-');
  await select('#review-arrows-lookahead', '3');
  await until(`window.arrowRequests.at(-1).strength === 100 && window.arrowRequests.at(-1).lookahead === 3`);
  await ready(replayFen, 'review-');
  await click('#review-continuation [data-review-line][data-step="0"]');
  await until('document.querySelector("#review-board").dataset.preview === "projection"');
  const previewFen = await evaluate('document.querySelector("#review-board").dataset.fen');
  await ready(previewFen, 'review-');
  assert.equal(await evaluate(visibleFen('review-')), previewFen, 'Review arrows analyze the visible branch position');
  await click('#review-return');
  await ready(replayFen, 'review-');
  await evaluate('document.querySelector("#review-arrows-enabled").scrollIntoView({ block: "center" })');
  await screenshot('arrows-review');
  await evaluate('document.querySelector("#review-arrows-notes").scrollIntoView({ block: "end" })');
  assert.equal(await evaluate(`(() => { const notes = document.querySelector('#review-arrows-notes').getBoundingClientRect(); const dialog = document.querySelector('#match-review-dialog').getBoundingClientRect(); return notes.bottom <= dialog.bottom && notes.top >= dialog.top; })()`), true, 'Expanded review arrow explanations are reachable by scrolling');
  await screenshot('arrows-review-notes');
  await click('#review-close');
  await until('!document.querySelector("#match-review-dialog").open && !document.querySelector("#new-game").disabled');
  await ready(fen);
  assert.equal(await evaluate(savedGame), beforeReview, 'Review arrows never change the live game');

  // Responsive SVG coordinates, controls, and persisted preferences.
  for (const [width, height] of [[390, 844], [320, 568]]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
    await evaluate('document.querySelector("#board").scrollIntoView({ block: "center" })');
    await delay(100);
    await geometry();
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `Arrow controls fit ${width}px`);
    await screenshot(width === 390 ? 'arrows-mobile' : 'arrows-narrow');
    await evaluate('document.querySelector("#arrows-mode").scrollIntoView({ block: "center" })');
    await screenshot(width === 390 ? 'arrows-controls-mobile' : 'arrows-controls-narrow');
  }
  await colors(true, false);
  await select('#arrows-lookahead', '4');
  await ready(fen);
  const preference = await evaluate('localStorage.getItem("knightfall.arrows.v1")');
  assert.ok(preference, 'Learning-arrow preference is saved independently');
  await evaluate('window.arrowsReloadPending = true');
  await call('Page.reload');
  await until('!window.arrowsReloadPending && document.querySelector("#arrows-enabled")?.checked && !document.querySelector("#new-game").disabled');
  await ready(fen);
  assert.equal(await evaluate('localStorage.getItem("knightfall.arrows.v1")'), preference);
  assert.equal(await evaluate('document.querySelector("#arrows-white").getAttribute("aria-pressed")'), 'true');
  assert.equal(await evaluate('document.querySelector("#arrows-black").getAttribute("aria-pressed")'), 'false');
  assert.equal(await evaluate('document.querySelector("#arrows-lookahead").value'), '4');
  await recordRequests();
  await evaluate('window.arrowHold = true');
  await select('#arrows-lookahead', '6');
  await until('window.arrowHeld.length === 1');
  await click('#new-game');
  await until('document.querySelector("#new-game-dialog").open');
  await evaluate('document.querySelector("#new-game-form").requestSubmit()');
  await until('!document.querySelector("#new-game-dialog").open && !document.querySelector("#submit-move").disabled');
  await evaluate('window.arrowHold = false; window.arrowHeld.splice(0).forEach(release => release())');
  const freshFen = await currentFen();
  await ready(freshFen);
  assert.notEqual(freshFen, fen);
  await enable(false);
  assert.equal(await evaluate(arrowCount()), 0);
  assert.deepEqual(errors, [], 'Learning arrows must not emit browser runtime or CSP errors');
  console.log('PASS: opt-in learning arrows, White/Black/both filters, no work when disabled, pressure on f7, accurate normal/flipped/mobile SVG geometry, real mouse click-through, legal 3/4-turn Stockfish branches, playing/review strength separation, read-only controls, persisted preferences, cancellation and stale undo/import/new-game suppression, review and projection contexts, offline retry, and 390/320px layouts.');
  console.log('Screenshots: artifacts/arrows-desktop.png, artifacts/arrows-mobile.png, artifacts/arrows-narrow.png, artifacts/arrows-review.png');
} finally {
  client?.close();
  chrome.kill('SIGTERM');
}
