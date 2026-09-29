// Ten-minute clocks with real server adjudication and native engine searches.
// Run: node scripts/clock_smoke.mjs http://127.0.0.1:8877
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const started = Date.now();
const progress = text => console.log(`[clock +${((Date.now() - started) / 1000).toFixed(1)}s] ${text}`);
const base = process.argv[2] || 'http://127.0.0.1:8877';
const profile = await mkdtemp(join(tmpdir(), 'knightfall-clock-browser-'));
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
  const until = async (expression, timeout = 25000) => {
    const deadline = Date.now() + timeout;
    do { if (await evaluate(expression)) return; await delay(75); } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for ${expression}; state=${JSON.stringify(await evaluate(`({ workspace: JSON.parse(localStorage.getItem('knightfall.workspace.v1')), status: document.querySelector('#clock-status')?.textContent, requests: window.clockRequests?.slice(-8), held: window.clockHeld?.length, page: document.body.innerText.slice(0, 1600) })`))}`);
  };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const input = (selector, value) => evaluate(`document.querySelector(${JSON.stringify(selector)}).value = ${JSON.stringify(value)}`);
  const workspace = `JSON.parse(localStorage.getItem('knightfall.workspace.v1'))`;
  const clock = async () => evaluate(`(() => { const saved = ${workspace}; return KnightfallGameClock.GameClock.restore(saved.clock, saved.initialFen, saved.moves)?.snapshot(); })()`);
  const advance = async ms => { await evaluate(`window.clockAdvance(${ms})`); await delay(200); };
  const moves = () => evaluate(`${workspace}.moves`);
  const ready = `document.querySelectorAll('#board .square').length === 64 && document.querySelector('#connection-dot')?.classList.contains('ready') && !document.querySelector('#new-game').disabled`;
  const reload = async () => {
    await evaluate('window.clockReloadPending = true');
    await call('Page.reload');
    await until(`!window.clockReloadPending && ${ready}`);
  };
  const setAuto = async enabled => {
    if (await evaluate(`document.querySelector('#auto-reply').checked !== ${enabled}`)) await click('#auto-reply');
  };
  const stopCoach = async () => {
    if (await evaluate(`document.querySelector('#coach-auto').checked`)) await click('#coach-auto');
  };
  const play = async (san, expectedPlies) => {
    await input('#move-input', san);
    await evaluate(`document.querySelector('#move-form').requestSubmit()`);
    await until(`${workspace}.moves.length === ${expectedPlies} && !document.querySelector('#new-game').disabled`);
  };
  const newGame = async () => {
    await click('#new-game');
    await until(`document.querySelector('#new-game-dialog').open`);
    await input('#game-color', 'white');
    await evaluate(`document.querySelector('#new-game-form').requestSubmit()`);
    await until(`!document.querySelector('#new-game-dialog').open && ${workspace}.moves.length === 0 && !document.querySelector('#submit-move').disabled`);
  };
  const importPgn = async pgn => {
    await click('#import');
    await click('[data-import-type="pgn"]');
    await input('#import-text', pgn);
    await evaluate(`document.querySelector('#import-form').requestSubmit()`);
    await until(`!document.querySelector('#import-dialog').open && !document.querySelector('#new-game').disabled`);
  };
  const seedRemaining = async (color, remaining) => {
    await evaluate(`sessionStorage.setItem('knightfall.clock-smoke-seed', JSON.stringify({color: ${JSON.stringify(color)}, remaining: ${remaining}}))`);
    await reload();
  };
  const capture = async name => {
    const result = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(`artifacts/${name}.png`, Buffer.from(result.data, 'base64'));
  };
  const instrumentation = `(() => {
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + Number(sessionStorage.getItem('knightfall.clock-smoke-offset') || 0);
    window.clockAdvance = ms => sessionStorage.setItem('knightfall.clock-smoke-offset', String(Number(sessionStorage.getItem('knightfall.clock-smoke-offset') || 0) + ms));
    const seed = JSON.parse(sessionStorage.getItem('knightfall.clock-smoke-seed') || 'null');
    if (seed) {
      const saved = JSON.parse(localStorage.getItem('knightfall.workspace.v1'));
      saved.clock.remaining[seed.color] = seed.remaining;
      saved.clock.running = true;
      saved.clock.flagged = null;
      saved.clock.anchor = Date.now();
      saved.clockPaused = false;
      saved.settings.auto = false;
      localStorage.setItem('knightfall.workspace.v1', JSON.stringify(saved));
      sessionStorage.removeItem('knightfall.clock-smoke-seed');
    }
    const unfinishedArchive = sessionStorage.getItem('knightfall.clock-smoke-unfinished-archive');
    if (unfinishedArchive) {
      localStorage.setItem('knightfall.last-match.v1', unfinishedArchive);
      sessionStorage.removeItem('knightfall.clock-smoke-unfinished-archive');
    }
    const original = window.fetch.bind(window);
    window.clockRequests = [];
    window.clockResponses = [];
    window.clockHold = false;
    window.clockHeld = [];
    window.clockHoldMove = false;
    window.clockMovesHeld = [];
    window.clockReviews = [];
    window.addEventListener('knightfall:review-open', event => window.clockReviews.push(structuredClone(event.detail)));
    window.fetch = async (url, options) => {
      const tracked = ['/api/analyze', '/api/stop', '/api/timeout', '/api/move'].includes(url);
      if (tracked) window.clockRequests.push({ url, body: JSON.parse(options.body) });
      const response = await original(url, options);
      if (tracked) {
        const body = await response.clone().text();
        const parsed = JSON.parse(body);
        window.clockResponses.push({ url, status: response.status, body: parsed });
        if (url === '/api/analyze' && window.clockHold && response.ok && !parsed.cancelled) {
          return new Promise(resolve => window.clockHeld.push(() => resolve(new Response(body, { status: response.status, headers: response.headers }))));
        }
        if (url === '/api/move' && window.clockHoldMove && response.ok) {
          return new Promise(resolve => window.clockMovesHeld.push(() => resolve(new Response(body, { status: response.status, headers: response.headers }))));
        }
      }
      return response;
    };
    const originalURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => {
      if (blob.type.includes('chess-pgn')) blob.text().then(text => { window.clockExportText = text; });
      return originalURL(blob);
    };
  })()`;
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: instrumentation });
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: base });
  await until(`document.querySelector('#new-game-dialog')?.open && document.querySelectorAll('#board .square').length === 64`);
  assert.match(await evaluate(`document.querySelector('#game-time-note').textContent`), /10/);
  await click('#close-new-game');
  await until(`!document.querySelector('#new-game-dialog').open`);
  assert.equal(await evaluate(`document.querySelector('#submit-move').disabled`), true, 'Cancelling initial setup must not allow an untimed game');
  assert.equal((await clock()).running, false);
  await click('#new-game');
  await until(`document.querySelector('#new-game-dialog').open`);
  await evaluate(`document.querySelector('#new-game-form').requestSubmit()`);
  await until(`!document.querySelector('#new-game-dialog').open && !document.querySelector('#submit-move').disabled`);
  assert.equal(await evaluate(`${workspace}.settings.seconds`), 3, 'New games default to three-second searches');
  assert.equal(await evaluate(`document.querySelector('[data-seconds="3"]').getAttribute('aria-pressed')`), 'true');
  await setAuto(false);
  await stopCoach();
  let current = await clock();
  assert.ok(current.remaining.white <= 600000 && current.remaining.white > 598000);
  assert.equal(current.remaining.black, 600000);
  assert.equal(current.turn, 'white');
  assert.equal(current.running, true);
  await advance(5000);
  current = await clock();
  assert.ok(current.remaining.white < 595000);
  assert.equal(current.remaining.black, 600000, 'Only the active side spends time');
  assert.match(await evaluate(`document.querySelector('#top-player-clock').textContent`), /10:00/);
  assert.equal(await evaluate(`document.querySelector('#top-player-clock').dataset.color`), 'black');
  assert.equal(await evaluate(`document.querySelector('#bottom-player-clock').dataset.color`), 'white');

  const beforeIllegal = current.remaining.white;
  await input('#move-input', 'e5');
  await evaluate(`document.querySelector('#move-form').requestSubmit()`);
  await until(`window.clockResponses.some(item => item.url === '/api/move' && item.status === 400) && !document.querySelector('#submit-move').disabled`);
  await advance(2000);
  assert.deepEqual(await moves(), []);
  current = await clock();
  assert.ok(current.remaining.white < beforeIllegal - 1900, 'An illegal move must not pause or reset its clock');
  assert.equal(current.remaining.black, 600000);
  await play('e4', 1);
  const afterWhiteMove = await clock();
  await advance(3000);
  current = await clock();
  assert.equal(current.turn, 'black');
  assert.equal(current.remaining.white, afterWhiteMove.remaining.white);
  assert.ok(current.remaining.black < 597000, 'A successful move switches the ticking side');
  progress('Ten-minute default, active-side charging, illegal move, and legal turn switch passed');

  await click('#clock-pause');
  await until(`${workspace}.clockPaused === true`);
  const paused = await clock();
  assert.equal(paused.running, false);
  assert.equal(await evaluate(`document.querySelector('#submit-move').disabled`), true);
  assert.equal(await evaluate(`document.querySelector('#analyze').disabled`), false, 'Paused practice still allows manual analysis');
  await advance(5000);
  assert.deepEqual((await clock()).remaining, paused.remaining);
  await reload();
  await stopCoach();
  assert.equal(await evaluate(`${workspace}.clockPaused`), true);
  assert.deepEqual((await clock()).remaining, paused.remaining, 'Reload preserves an explicit clock pause');
  await click('#clock-pause');
  await until(`${workspace}.clockPaused === false && !document.querySelector('#submit-move').disabled`);
  await advance(1000);
  assert.ok((await clock()).remaining.black < paused.remaining.black - 900);
  const beforeReload = await clock();
  await evaluate('window.clockAdvance(7000)');
  await reload();
  await stopCoach();
  current = await clock();
  assert.ok(current.remaining.black < beforeReload.remaining.black - 6900, 'Reload charges time elapsed from the saved wall-clock anchor');
  assert.equal(current.remaining.white, beforeReload.remaining.white);
  await click('#flip');
  assert.equal(await evaluate(`document.querySelector('#top-player-clock').dataset.color`), 'white');
  assert.equal(await evaluate(`document.querySelector('#bottom-player-clock').dataset.color`), 'black');
  await click('#flip');
  const beforeUndo = await clock();
  await click('#undo');
  await until(`${workspace}.moves.length === 0 && !document.querySelector('#submit-move').disabled`);
  current = await clock();
  assert.ok(current.remaining.white <= beforeUndo.remaining.white);
  assert.ok(current.remaining.black <= beforeUndo.remaining.black, 'Undo cannot refund either clock');
  assert.equal(current.turn, 'white');
  progress('Pause/resume, paused and running reloads, board flip, and undo passed');

  await newGame();
  current = await clock();
  assert.ok(current.remaining.white > 599000);
  assert.equal(current.remaining.black, 600000);
  await stopCoach();
  await play('e4', 1);
  await until(`window.clockRequests.some(item => item.url === '/api/analyze' && item.body.moves.length === 1)`);
  const normalRequest = await evaluate(`window.clockRequests.find(item => item.url === '/api/analyze' && item.body.moves.length === 1).body`);
  assert.equal(normalRequest.seconds, 3, 'Automatic opponent requests the selected three-second budget');
  await until(`${workspace}.moves.length === 2 && !document.querySelector('#submit-move').disabled`);
  assert.ok((await clock()).remaining.black < 598000, 'The opponent spends real clock time while its engine thinks');

  await newGame();
  await evaluate('window.clockHold = true');
  await play('e4', 1);
  await until('window.clockHeld.length === 1');
  const dialogRequest = await evaluate(`window.clockRequests.filter(item => item.url === '/api/analyze').at(-1).body`);
  const dialogRequestCount = await evaluate(`window.clockRequests.filter(item => item.url === '/api/analyze').length`);
  await click('#import');
  await until(`document.querySelector('#import-dialog').open && window.clockRequests.some(item => item.url === '/api/stop' && item.body.requestId === ${JSON.stringify(dialogRequest.requestId)})`);
  const modalPause = await clock();
  assert.equal(modalPause.running, false, 'Opening import pauses the game while stopping the pending search');
  await advance(5000);
  assert.deepEqual((await clock()).remaining, modalPause.remaining, 'Import modal does not spend either clock');
  await click('#close-import');
  await until(`!document.querySelector('#import-dialog').open && ${workspace}.clock.running`);
  assert.equal((await clock()).running, true, 'Closing import resumes the clock');
  await evaluate('window.clockHold = false; window.clockHeld.splice(0).forEach(release => release())');
  await until(`window.clockRequests.filter(item => item.url === '/api/analyze').length > ${dialogRequestCount}`);
  await until(`${workspace}.moves.length === 2 && !document.querySelector('#submit-move').disabled`);
  assert.equal((await moves())[0], 'e2e4');
  assert.equal(await evaluate(`window.clockRequests.filter(item => item.url === '/api/move' && item.body.moves.length === 1).at(-1).body.moves[0]`), 'e2e4');
  progress('Import modal freezes clocks and an early close resumes replies after search cancellation');

  await setAuto(false);
  await importPgn('1. e4 *');
  current = await clock();
  assert.equal(current.remaining.white, 600000);
  assert.ok(current.remaining.black > 599000, 'An imported position receives fresh ten-minute clocks');
  progress('New/imported games reset clocks, and a real native opponent used three seconds');

  await mkdir('artifacts', { recursive: true });
  for (const viewport of [
    { width: 1440, height: 1000, mobile: false, name: 'clock-live-desktop' },
    { width: 1280, height: 800, mobile: false, name: 'clock-live-narrow' },
    { width: 390, height: 844, mobile: true, name: 'clock-live-mobile' },
  ]) {
    await call('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile });
    await evaluate(`document.querySelector('.board-panel').scrollIntoView({ block: 'start', behavior: 'instant' })`);
    await delay(200);
    const visibility = await evaluate(`({
      fits: document.documentElement.scrollWidth <= innerWidth,
      clocks: ['top', 'bottom'].map(position => {
        const element = document.querySelector('#' + position + '-player-clock');
        const rect = element.getBoundingClientRect();
        return { color: element.dataset.color, visible: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight };
      }),
    })`);
    assert.equal(visibility.fits, true, `${viewport.name} must not overflow horizontally`);
    assert.ok(visibility.clocks.every(item => item.visible), `${viewport.name} must show both live clocks: ${JSON.stringify(visibility)}`);
    await capture(viewport.name);
  }
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate('window.scrollTo({ top: 0, behavior: "instant" })');
  progress('Captured both live clocks on desktop, narrow desktop, and mobile');

  await seedRemaining('black', 1800);
  await stopCoach();
  await evaluate('window.clockHold = true');
  await setAuto(true);
  await until(`window.clockRequests.some(item => item.url === '/api/analyze')`);
  const lowRequest = await evaluate(`window.clockRequests.find(item => item.url === '/api/analyze').body`);
  assert.ok(lowRequest.seconds >= 0.01 && lowRequest.seconds < 1.8, 'Low-time search shrinks below the remaining clock');
  await until('window.clockHeld.length === 1');
  await advance(3000);
  await until(`window.clockRequests.some(item => item.url === '/api/stop' && item.body.requestId === ${JSON.stringify(lowRequest.requestId)})`);
  await evaluate('window.clockHold = false; window.clockHeld.splice(0).forEach(release => release())');
  await until(`!document.querySelector('#match-finished').hidden && !document.querySelector('#new-game').disabled`);
  assert.deepEqual(await moves(), ['e2e4'], 'An engine response delivered after flag fall cannot commit a move');
  assert.match(await evaluate(`document.querySelector('#match-finished-result').textContent`), /1-0.*time forfeit/i);
  assert.equal(await evaluate(`document.querySelector('#match-finished-review').disabled`), false);
  assert.equal((await clock()).flagged, 'black');
  await click('#match-finished-review');
  await until(`document.querySelector('#match-review-dialog').open`);
  await click('#review-close');
  await until(`!document.querySelector('#match-review-dialog').open && !document.querySelector('#new-game').disabled`);
  progress('Low-time budget, cancelled late native response, timeout result, and after-match review passed');

  await newGame();
  await setAuto(false);
  await stopCoach();
  await play('e4', 1);
  await play('e5', 2);
  await evaluate(`(async () => {
    const saved = ${workspace};
    const response = await fetch('/api/position', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initialFen: saved.initialFen, moves: saved.moves }),
    });
    if (!response.ok) throw new Error('Unable to prepare unfinished archive fixture');
    const position = await response.json();
    const archive = {
      initialFen: position.initialFen, moves: position.moves, history: position.history, fen: position.fen,
      strength: saved.settings.strength, forgiving: saved.settings.forgiving, solver: saved.settings.solver,
      opponentStyle: saved.settings.opponentStyle, flipped: saved.settings.flipped,
      outcome: null, reviewStrength: 100,
    };
    sessionStorage.setItem('knightfall.clock-smoke-unfinished-archive', JSON.stringify(archive));
  })()`);
  await seedRemaining('white', 1800);
  await stopCoach();
  const unfinishedArchive = await evaluate(`JSON.parse(localStorage.getItem('knightfall.last-match.v1'))`);
  assert.equal(unfinishedArchive.outcome, null, 'Start with an archived unfinished copy of the same game');
  assert.deepEqual(unfinishedArchive.moves, ['e2e4', 'e7e5']);
  await evaluate('window.clockHoldMove = true');
  await input('#move-input', 'Nf3');
  await evaluate(`document.querySelector('#move-form').requestSubmit()`);
  await until('window.clockMovesHeld.length === 1');
  const delayedMove = await evaluate(`window.clockResponses.filter(item => item.url === '/api/move' && item.status === 200).at(-1).body`);
  assert.deepEqual(delayedMove.moves, ['e2e4', 'e7e5', 'g1f3'], 'The held response contains an actual server-validated legal move');
  await advance(3000);
  await until(`window.clockResponses.some(item => item.url === '/api/timeout' && item.status === 200)`);
  await evaluate('window.clockHoldMove = false; window.clockMovesHeld.splice(0).forEach(release => release())');
  await until(`!document.querySelector('#match-finished').hidden && !document.querySelector('#new-game').disabled`);
  assert.deepEqual(await moves(), ['e2e4', 'e7e5'], 'A legal move response arriving after flag fall cannot update the board');
  const savedAfterDelayedMove = await evaluate(`({ workspace: ${workspace}, last: JSON.parse(localStorage.getItem('knightfall.last-match.v1')) })`);
  assert.deepEqual(savedAfterDelayedMove.workspace.clock.moves, ['e2e4', 'e7e5']);
  assert.equal(savedAfterDelayedMove.workspace.clock.ply, 2);
  assert.equal(savedAfterDelayedMove.workspace.clock.flagged, 'white');
  assert.deepEqual(savedAfterDelayedMove.last.moves, ['e2e4', 'e7e5']);
  assert.deepEqual(savedAfterDelayedMove.last.history.map(move => move.uci), ['e2e4', 'e7e5']);
  assert.equal(savedAfterDelayedMove.last.outcome?.result, '0-1', 'Flag fall replaces the matching unfinished archive with the final outcome');
  assert.equal(savedAfterDelayedMove.last.outcome.reason, 'time forfeit');
  assert.match(await evaluate(`document.querySelector('#match-finished-result').textContent`), /0-1.*time forfeit/i);
  await click('#match-finished-review');
  await until(`document.querySelector('#match-review-dialog').open && window.clockReviews.length > 0`);
  const timedReview = await evaluate('window.clockReviews.at(-1)');
  assert.deepEqual(timedReview.moves, ['e2e4', 'e7e5']);
  assert.deepEqual(timedReview.history.map(move => move.uci), ['e2e4', 'e7e5']);
  assert.equal(timedReview.outcome.result, '0-1');
  await click('#review-close');
  await until(`!document.querySelector('#match-review-dialog').open && !document.querySelector('#new-game').disabled`);
  progress('A legal move response held across flag fall leaves board, saved clock, and review history unchanged');
  await click('#export-pgn');
  await until(`typeof window.clockExportText === 'string'`);
  const pgn = await evaluate('window.clockExportText');
  assert.match(pgn, /\[Result "0-1"\]/);
  assert.match(pgn, /\[Termination "time forfeit"\]/);
  assert.match(pgn, /\[TimeControl "600\+0"\]/);
  assert.match(pgn, /1\. e4 e5 0-1\s*$/);
  await reload();
  await until(`!document.querySelector('#match-finished').hidden`);
  assert.match(await evaluate(`document.querySelector('#match-finished-result').textContent`), /0-1.*time forfeit/i);
  assert.equal(await evaluate(`document.querySelector('#submit-move').disabled`), true);
  await capture('clock-desktop');
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await delay(200);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Clocks fit the mobile viewport');
  await capture('clock-mobile');
  assert.deepEqual(errors, [], 'No uncaught browser errors');
  await writeFile('artifacts/clock-smoke.json', JSON.stringify({ passed: true, normalSeconds: normalRequest.seconds, lowSeconds: lowRequest.seconds, importCancellationResume: true, lateMoveRejected: true, matchingUnfinishedArchiveUpdated: true, timeoutPgn: pgn, runtimeErrors: errors }, null, 2));
  progress('Timeout export/reload and desktop/mobile presentation passed');
  console.log('Clock browser smoke passed.');
} finally {
  client?.close();
  chrome.kill('SIGTERM');
}
