// Real screenshot recognition and import checks using Chrome's DevTools protocol.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const base = process.argv[2] || 'http://127.0.0.1:8877';
const profile = await mkdtemp(join(tmpdir(), 'knightfall-screenshot-'));
const executable = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const chrome = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const middleFen = '2kr1bnr/ppp1pppp/2n5/q7/3P2b1/2N2N2/PPP1BPPP/R1BQ1RK1 w - - 3 8';
const endingFen = '6k1/5ppp/2p5/3p4/3P4/2P2N2/5PPP/4R1K1 b - - 4 30';
const savedExpression = 'JSON.parse(localStorage.getItem("knightfall.workspace.v1"))';
const ready = '!document.querySelector("#submit-move").disabled';
const reviewReady = '!document.querySelector("#screenshot-review").hidden && document.querySelectorAll("#screenshot-board [data-square]").length === 64';
const report = { fixtures: [], checks: [] };
let client;

function placementMap(placement) {
  const squares = {};
  placement.split('/').forEach((rank, row) => {
    let file = 0;
    for (const character of rank) {
      if (/\d/.test(character)) {
        for (let count = 0; count < Number(character); count++) squares[`${'abcdefgh'[file++]}${8 - row}`] = '';
      } else squares[`${'abcdefgh'[file++]}${8 - row}`] = character;
    }
    assert.equal(file, 8, `Invalid fixture rank: ${rank}`);
  });
  assert.equal(Object.keys(squares).length, 64);
  return squares;
}

function rotatePlacement(placement) {
  const source = placementMap(placement);
  const target = {};
  for (const [square, piece] of Object.entries(source)) {
    target[`${'hgfedcba'['abcdefgh'.indexOf(square[0])]}${9 - Number(square[1])}`] = piece;
  }
  return target;
}

try {
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    const timeout = setTimeout(() => reject(new Error('Chrome did not start in 20 seconds')), 20000);
    let log = '';
    chrome.stderr.on('data', chunk => {
      log += chunk.toString();
      const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); resolveEndpoint(match[1]); }
    });
    chrome.on('error', error => { clearTimeout(timeout); reject(error); });
    chrome.on('exit', code => { clearTimeout(timeout); reject(new Error(`Chrome exited: ${code}; ${log.slice(-1500)}`)); });
  });
  const debugOrigin = endpoint.replace(/^ws:/, 'http:').replace(/\/devtools\/.*$/, '');
  const target = await (await fetch(`${debugOrigin}/json/new?about:blank`, { method: 'PUT' })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => { socket.addEventListener('open', resolveOpen, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  client = socket;
  const pending = new Map();
  const errors = [];
  const requests = [];
  let nextId = 0;
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      const { resolveResult, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolveResult(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text + ': ' + JSON.stringify(message.params.exceptionDetails.exception));
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error' && !message.params.entry.url?.endsWith('favicon.ico')) {
      const entry = message.params.entry;
      const expectedInvalidReview = entry.url === `${base}/api/import` && entry.text.includes('400');
      if (!expectedInvalidReview) errors.push(entry.text);
    }
    if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request);
  });
  const call = (method, params = {}) => new Promise((resolveResult, reject) => {
    const id = ++nextId;
    pending.set(id, { resolveResult, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async (expression, timeout = 25000) => {
    const deadline = Date.now() + timeout;
    do { if (await evaluate(expression)) return; await delay(100); } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for ${expression}; screenshot state: ${await evaluate('JSON.stringify({ status: document.querySelector("#screenshot-status")?.textContent, error: document.querySelector("#screenshot-error")?.textContent, calls: window.recognitionCalls })')}`);
  };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const setInput = (selector, value) => evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const setChecked = async (selector, value) => {
    if (await evaluate(`document.querySelector(${JSON.stringify(selector)}).checked`) !== value) await click(selector);
  };
  const snapshot = () => evaluate(`JSON.stringify({ saved: ${savedExpression}, squares: Array.from(document.querySelectorAll('#board .square'), square => square.getAttribute('aria-label')), history: document.querySelector('#history').textContent })`);
  const screenshot = async path => {
    const result = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(path, Buffer.from(result.data, 'base64'));
  };
  const selectFile = async path => {
    const root = await call('DOM.getDocument');
    const input = await call('DOM.querySelector', { nodeId: root.root.nodeId, selector: '#screenshot-file' });
    await call('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [resolve(path)] });
  };
  const selectDecodedFile = async path => {
    const previous = await evaluate('document.querySelector("#screenshot-preview").getAttribute("src")');
    await selectFile(path);
    await until(`(() => { const source = document.querySelector('#screenshot-preview').getAttribute('src'); return source?.startsWith('blob:') && source !== ${JSON.stringify(previous)}; })()`);
  };
  const openScreenshot = async () => {
    await until('!document.querySelector("#import").disabled && !document.querySelector("#screenshot-dialog").open');
    await click('#import');
    await click('#open-screenshot');
    await until('document.querySelector("#screenshot-dialog").open');
  };
  const importText = async (text, type = 'fen') => {
    await click('#import');
    await click(`[data-import-type="${type}"]`);
    await setInput('#import-text', text);
    await evaluate('document.querySelector("#import-form").requestSubmit()');
    await until(`!document.querySelector('#import-dialog').open && ${ready}`);
  };
  const reviewSquares = () => evaluate(`Object.fromEntries(Array.from(document.querySelectorAll('#screenshot-board [data-square]'), square => [square.dataset.square, square.dataset.piece || '']))`);
  const paint = async (square, piece) => {
    await click(`#screenshot-dialog [data-piece="${piece}"]:not([data-square])`);
    await click(`#screenshot-board [data-square="${square}"]`);
  };
  const confirm = () => evaluate('document.querySelector("#screenshot-confirm").form.requestSubmit()');
  const recognizeFixture = async (path, expected, label) => {
    const calls = await evaluate('window.recognitionCalls.length');
    await selectFile(path);
    await until(`window.recognitionCalls.length > ${calls} && window.recognitionCalls[${calls}].settled`, 90000);
    const result = await evaluate(`window.recognitionCalls[${calls}]`);
    assert.equal(result.error, undefined, `${label}: real recognition must complete`);
    assert.ok(result.result?.placement, `${label}: real model must detect the board`);
    const actual = placementMap(result.result.placement);
    const mismatches = Object.keys(expected).filter(square => actual[square] !== expected[square]);
    report.fixtures.push({ label, elapsedMs: result.elapsedMs, placement: result.result.placement, meanConfidence: result.result.meanConfidence, minConfidence: result.result.minConfidence, mismatches });
    await writeFile('artifacts/screenshot-recognition-results.json', JSON.stringify(report, null, 2));
    assert.deepEqual(mismatches, [], `${label}: all 64 recognized squares must match the rendered fixture`);
    await until(reviewReady);
  };

  await mkdir('artifacts', { recursive: true });
  await call('Runtime.enable');
  await call('Log.enable');
  await call('Page.enable');
  await call('Network.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: base });
  await until('document.querySelector("#new-game-dialog")?.open && window.KnightfallRecognition && window.KnightfallScreenshot');
  await evaluate('document.querySelector("#new-game-form").requestSubmit()');
  await until(`!document.querySelector('#new-game-dialog').open && ${ready}`);
  await setChecked('#auto-reply', false);
  await setChecked('#coach-auto', false);
  await click('[data-seconds="1"]');
  await evaluate(`(() => {
    const recognize = window.KnightfallRecognition.recognize;
    window.recognitionCalls = [];
    window.heldRecognitions = [];
    window.holdRecognition = false;
    window.KnightfallRecognition = { ...window.KnightfallRecognition, recognize: async function (...args) {
      const entry = { settled: false };
      const start = performance.now();
      window.recognitionCalls.push(entry);
      try {
        if (window.failNextRecognition) {
          window.failNextRecognition = false;
          throw new Error('Recognition unavailable (deterministic fallback test).');
        }
        const result = await recognize.apply(this, args);
        entry.result = result;
        entry.elapsedMs = performance.now() - start;
        entry.settled = true;
        if (window.holdRecognition) return await new Promise(resolve => window.heldRecognitions.push(() => resolve(result)));
        return result;
      } catch (error) { entry.error = error.message; entry.settled = true; throw error; }
    } };
  })()`);

  // Fixtures are real screenshots of the app's board, not synthetic model outputs.
  for (const [label, fen, flipped] of [['middlegame', middleFen, false], ['flipped-endgame', endingFen, true]]) {
    await importText(fen);
    if (await evaluate(`${savedExpression}.settings.flipped`) !== flipped) await click('#flip');
    await until('Array.from(document.querySelectorAll("#board img")).every(image => image.complete && image.naturalWidth > 0)');
    const bounds = await evaluate('(() => { const bounds = document.querySelector("#board").getBoundingClientRect(); return { x: bounds.x + scrollX, y: bounds.y + scrollY, width: bounds.width, height: bounds.height, scale: 1 }; })()');
    const captured = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: bounds });
    await writeFile(`artifacts/screenshot-fixture-${label}.png`, Buffer.from(captured.data, 'base64'));
    if (label === 'middlegame') await screenshot('artifacts/screenshot-fixture-full-page.png');
  }
  await importText('1. e4 d5 2. exd5 Qxd5 *', 'pgn');
  assert.equal(await evaluate(`${savedExpression}.moves.length`), 4, 'Existing PGN import must work before screenshot import');
  const beforeReview = await snapshot();
  await openScreenshot();
  await recognizeFixture('artifacts/screenshot-fixture-full-page.png', placementMap(middleFen.split(' ')[0]), 'Full game page with heading and sidebar around the middlegame board');
  assert.deepEqual(await reviewSquares(), placementMap(middleFen.split(' ')[0]), 'Board detection within a complete game-page screenshot must preserve exact square placement');
  assert.equal(await snapshot(), beforeReview, 'Recognizing a full-page screenshot must not change the current game');
  await recognizeFixture('artifacts/screenshot-fixture-middlegame.png', placementMap(middleFen.split(' ')[0]), 'White-bottom captured-piece middlegame');
  assert.deepEqual(await reviewSquares(), placementMap(middleFen.split(' ')[0]));
  assert.equal(await evaluate('document.querySelector("#screenshot-turn").value'), '', 'A screenshot does not establish whose turn it is');
  assert.equal(await evaluate('document.querySelector("#screenshot-side").value'), '', 'The user must choose their own side separately');
  assert.equal(await evaluate('Array.from(document.querySelectorAll("[id^=screenshot-castling-]")).some(input => input.checked)'), false, 'Castling rights must not be invented from piece placement');
  assert.equal(await evaluate('document.querySelector("#screenshot-ep").value'), '-', 'En passant must default to unavailable');
  await confirm();
  assert.equal(await snapshot(), beforeReview, 'Unconfirmed review must not alter the main game');
  await paint('e2', 'N');
  assert.equal((await reviewSquares()).e2, 'N', 'A reviewed square can be corrected');
  await paint('e2', 'B');
  await setInput('#screenshot-turn', 'white');
  await setInput('#screenshot-side', 'white');
  await setInput('#screenshot-strength', '40');
  await setInput('#screenshot-inaccuracies', '2');
  await setInput('#screenshot-halfmove', '3');
  await setInput('#screenshot-fullmove', '8');
  await setChecked('#screenshot-reviewed', true);
  await paint('g1', '');
  await setChecked('#screenshot-reviewed', true);
  await confirm();
  await until('!document.querySelector("#screenshot-error").hidden');
  assert.equal(await evaluate('document.querySelector("#screenshot-dialog").open'), true, 'An invalid review stays open for correction');
  assert.equal(await snapshot(), beforeReview, 'Invalid piece placement must preserve board, history, and settings');
  await paint('g1', 'K');
  await setChecked('#screenshot-reviewed', true);
  await screenshot('artifacts/screenshot-review-desktop.png');
  await confirm();
  await until(`!document.querySelector('#screenshot-dialog').open && ${ready}`);
  let saved = await evaluate(savedExpression);
  assert.equal(saved.initialFen, middleFen);
  assert.deepEqual(saved.moves, []);
  assert.equal(saved.settings.solver, 'black');
  assert.equal(saved.settings.strength, 40);
  assert.equal(saved.settings.extraInaccuracies, 2, 'Screenshot confirmation must persist the selected extra-inaccuracy target');
  assert.deepEqual(saved.practice.events, [], 'A screenshot import must start with no consumed extra mistakes');
  assert.equal(saved.practice.startPly, 0);
  assert.equal(saved.settings.flipped, false);
  assert.equal(saved.settings.auto, true);
  assert.equal(await evaluate('document.querySelectorAll(".history-move").length'), 0, 'Unknown prior moves must not be invented');
  report.checks.push('Real screenshot recognition, review correction, explicit turn/side, conservative metadata, invalid-position rollback, atomic settings/history replacement');

  const position = await (await fetch(`${base}/api/position`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initialFen: middleFen, moves: [] }) })).json();
  assert.ok(position.legalMoves.length > 0);
  await setInput('#move-input', position.legalMoves[0].san);
  await evaluate('document.querySelector("#move-form").requestSubmit()');
  await until(`${savedExpression}.moves.length === 2 && ${ready}`, 25000);
  saved = await evaluate(savedExpression);
  const continuedResponse = await fetch(`${base}/api/position`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initialFen: saved.initialFen, moves: saved.moves }) });
  assert.equal(continuedResponse.status, 200, 'The engine reply must be legal from the imported position');
  const continued = await continuedResponse.json();
  assert.equal(continued.moves.length, 2);
  assert.equal(saved.initialFen, middleFen);
  assert.ok(requests.some(request => request.url.endsWith('/api/analyze') && JSON.parse(request.postData).strength === 40), 'Automatic reply must use the imported strength');
  report.checks.push('Actual Stockfish reply after a legal human move from imported middlegame');

  await openScreenshot();
  await recognizeFixture('artifacts/screenshot-fixture-flipped-endgame.png', rotatePlacement(endingFen.split(' ')[0]), 'Black-bottom sparse captured-piece endgame');
  await setInput('#screenshot-bottom', 'black');
  assert.deepEqual(await reviewSquares(), placementMap(endingFen.split(' ')[0]), 'Black-bottom correction must restore canonical square coordinates');
  await setInput('#screenshot-turn', 'black');
  await setInput('#screenshot-side', 'white');
  await setInput('#screenshot-halfmove', '4');
  await setInput('#screenshot-fullmove', '30');
  await setChecked('#screenshot-reviewed', true);
  await confirm();
  await until(`!document.querySelector('#screenshot-dialog').open && ${savedExpression}.moves.length === 1 && ${ready}`, 25000);
  saved = await evaluate(savedExpression);
  assert.equal(saved.initialFen, endingFen);
  assert.equal(saved.settings.solver, 'black');
  assert.equal(saved.settings.flipped, false, 'Screenshot orientation and the chosen playing side are independent');
  const immediateResponse = await fetch(`${base}/api/position`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initialFen: saved.initialFen, moves: saved.moves }) });
  assert.equal(immediateResponse.status, 200);
  report.checks.push('Black-bottom recognition, orientation correction, independent side-to-move/user-side, immediate legal engine reply');

  const beforeCancel = await snapshot();
  await evaluate('window.holdRecognition = true');
  await openScreenshot();
  await selectFile('artifacts/screenshot-fixture-middlegame.png');
  await until('window.heldRecognitions.length === 1', 90000);
  await click('#screenshot-cancel');
  await until('!document.querySelector("#screenshot-dialog").open');
  await evaluate('window.holdRecognition = false; window.heldRecognitions.splice(0).forEach(release => release())');
  await delay(300);
  assert.equal(await snapshot(), beforeCancel, 'Late recognition after cancel must not change the main game');
  await openScreenshot();
  assert.equal(await evaluate('document.querySelector("#screenshot-review").hidden'), true, 'A cancelled recognition must not populate a later dialog session');
  await click('#screenshot-cancel');

  await evaluate('window.holdRecognition = true');
  await openScreenshot();
  await selectDecodedFile('artifacts/screenshot-fixture-middlegame.png');
  await until('window.heldRecognitions.length === 1', 90000);
  const queuedStart = await evaluate('window.recognitionCalls.length');
  await selectDecodedFile('artifacts/screenshot-fixture-flipped-endgame.png');
  assert.equal(await evaluate('window.recognitionCalls.length'), queuedStart, 'A replacement image must wait for the active model context');
  await selectDecodedFile('artifacts/screenshot-fixture-middlegame.png');
  assert.equal(await evaluate('window.recognitionCalls.length'), queuedStart, 'Further replacements must remain queued');
  await evaluate('window.holdRecognition = false; window.heldRecognitions.splice(0).forEach(release => release())');
  await until(`${reviewReady} && window.recognitionCalls.length === ${queuedStart + 1} && window.recognitionCalls.at(-1).settled`, 90000);
  assert.deepEqual(await reviewSquares(), placementMap(middleFen.split(' ')[0]), 'Only the newest queued upload may populate the review');
  assert.equal(await evaluate('document.querySelector("#screenshot-error").hidden'), true, 'Queued image replacements must not produce model-busy errors');
  assert.equal(await snapshot(), beforeCancel, 'Recognizing replacement files must preserve the main game');
  await click('#screenshot-cancel');

  await evaluate('window.holdRecognition = true');
  await openScreenshot();
  await selectDecodedFile('artifacts/screenshot-fixture-flipped-endgame.png');
  await until('window.heldRecognitions.length === 1', 90000);
  const reopenedStart = await evaluate('window.recognitionCalls.length');
  await click('#screenshot-cancel');
  await openScreenshot();
  await selectDecodedFile('artifacts/screenshot-fixture-middlegame.png');
  assert.equal(await evaluate('window.recognitionCalls.length'), reopenedStart, 'Closing and reopening must not run a second scan against the occupied model context');
  assert.equal(await evaluate('document.querySelector("#screenshot-review").hidden'), true, 'A reopened session must not expose a cancelled scan');
  await evaluate('window.holdRecognition = false; window.heldRecognitions.splice(0).forEach(release => release())');
  await until(`${reviewReady} && window.recognitionCalls.length === ${reopenedStart + 1} && window.recognitionCalls.at(-1).settled`, 90000);
  assert.deepEqual(await reviewSquares(), placementMap(middleFen.split(' ')[0]), 'A reopened session must display only its own screenshot');
  assert.equal(await evaluate('document.querySelector("#screenshot-error").hidden'), true);
  assert.equal(await snapshot(), beforeCancel, 'Late work from a closed session must not change the game');
  await click('#screenshot-cancel');
  report.checks.push('Serialized model access, superseded queued-file suppression, and close/reopen during active recognition');

  await openScreenshot();
  await writeFile('artifacts/screenshot-invalid.png', 'This is not an image.');
  await selectFile('artifacts/screenshot-invalid.png');
  await until('!document.querySelector("#screenshot-error").hidden');
  assert.equal(await snapshot(), beforeCancel, 'An unreadable image must not affect the game');
  await evaluate('window.failNextRecognition = true');
  await selectFile('artifacts/screenshot-fixture-middlegame.png');
  await until('!document.querySelector("#screenshot-error").hidden && !document.querySelector("#screenshot-recovery").hidden');
  await click('#screenshot-manual');
  await until(reviewReady);
  for (const [width, height, mobile] of [[1440, 900, false], [390, 844, true], [320, 568, true]]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await delay(150);
    assert.equal(await evaluate(`(() => {
      const dialog = document.querySelector('#screenshot-dialog');
      const bounds = dialog.getBoundingClientRect();
      const board = document.querySelector('#screenshot-board').getBoundingClientRect();
      const inaccuracies = document.querySelector('#screenshot-inaccuracies').getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= innerWidth + 1 && bounds.top >= 0 && bounds.bottom <= innerHeight + 1
        && dialog.scrollWidth <= dialog.clientWidth + 1 && board.width > 100 && Math.abs(board.width - board.height) <= 1
        && inaccuracies.left >= bounds.left && inaccuracies.right <= bounds.right;
    })()`), true, `Screenshot review must fit ${width}x${height} without horizontal overflow or board distortion`);
    await evaluate('document.querySelector("#screenshot-confirm").scrollIntoView({ block: "nearest" })');
    assert.equal(await evaluate('document.querySelector("#screenshot-confirm").getBoundingClientRect().bottom <= innerHeight + 1'), true, 'Confirmation must remain reachable');
    await screenshot(`artifacts/screenshot-review-${width}.png`);
  }
  await click('#screenshot-cancel');
  assert.equal(await snapshot(), beforeCancel, 'Cancelling manual review must preserve the game');
  report.checks.push('Deterministic delayed recognition cancellation and session isolation; unreadable-image rejection; injected recognition-failure manual recovery; desktop, 390px, and 320px review layout');

  await setChecked('#auto-reply', false);
  await importText('1. d4 d5 2. c4 e6 *', 'pgn');
  assert.equal(await evaluate(`${savedExpression}.moves.length`), 4);
  await importText(middleFen);
  assert.equal(await evaluate(`${savedExpression}.initialFen`), middleFen);
  assert.deepEqual(await evaluate(`${savedExpression}.moves`), []);
  const externalRequests = requests.filter(request => /^https?:/.test(request.url) && !request.url.startsWith(base + '/'));
  assert.deepEqual(externalRequests.map(request => request.url), [], 'Recognition assets and screenshot processing must remain local');
  assert.deepEqual(errors, [], 'Browser console must have no runtime or CSP errors');
  report.checks.push('FEN and PGN import remain functional; no external recognition requests or runtime/CSP errors');
  await writeFile('artifacts/screenshot-recognition-results.json', JSON.stringify(report, null, 2));
  console.log(`PASS: ${report.checks.join('; ')}.`);
  console.log('Evidence: artifacts/screenshot-recognition-results.json, screenshot-fixture-*.png, screenshot-review-*.png');
} finally {
  client?.close();
  chrome.kill('SIGTERM');
}
