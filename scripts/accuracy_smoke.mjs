// Post-match accuracy checks using Chrome CDP and real native Stockfish responses.
// Run: node scripts/accuracy_smoke.mjs http://127.0.0.1:8881
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import accuracyMath from '../web/accuracy-math.js';

const started = Date.now();
const progress = message => console.log(`[accuracy +${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
progress('Launching Chrome');
const base = process.argv[2] || 'http://127.0.0.1:8877';
const profile = await mkdtemp(join(tmpdir(), 'knightfall-accuracy-browser-'));
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
  const until = async (expression, timeout = 45000) => {
    const deadline = Date.now() + timeout;
    do { if (await evaluate(expression)) return; await delay(100); } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for ${expression}; report state: ${JSON.stringify(await evaluate(`({ live: document.querySelector('#accuracy-report')?.dataset, review: document.querySelector('#review-accuracy-report')?.dataset, liveStatus: document.querySelector('#accuracy-status')?.textContent, reviewStatus: document.querySelector('#review-accuracy-status')?.textContent, error: document.querySelector('#accuracy-error')?.textContent, reviewError: document.querySelector('#review-accuracy-error')?.textContent, requests: window.accuracyRequests?.slice(-3), responses: window.accuracyResponses?.slice(-3).map(result => ({ ply: result.ply, classification: result.classification, scored: result.scored, cancelled: result.cancelled, error: result.error })), held: window.accuracyHeld?.length })`))}`);
  };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const setInput = (selector, value) => evaluate(`document.querySelector(${JSON.stringify(selector)}).value = ${JSON.stringify(value)}`);
  const select = async (selector, value) => {
    await setInput(selector, value);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change', { bubbles: true }))`);
  };
  const workspace = 'JSON.parse(localStorage.getItem("knightfall.workspace.v1"))';
  const savedGame = `JSON.stringify({ saved: ${workspace}, squares: Array.from(document.querySelectorAll('#board .square'), square => square.getAttribute('aria-label')), history: document.querySelector('#history').textContent })`;
  const reportId = (prefix = '') => `#${prefix}accuracy-report`;
  const complete = (prefix = '') => `document.querySelector('${reportId(prefix)}')?.dataset.status === 'complete'`;
  const waitComplete = async (prefix = '') => until(complete(prefix));
  const visibleLiveReport = `(() => { const panel = document.querySelector('#accuracy-report'); return !!panel && panel.getClientRects().length > 0; })()`;
  const capture = async name => {
    const result = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(`artifacts/${name}.png`, Buffer.from(result.data, 'base64'));
  };
  const importPgn = async text => {
    await click('#import');
    await click('[data-import-type="pgn"]');
    await setInput('#import-text', text);
    await evaluate('document.querySelector("#import-form").requestSubmit()');
    await until('!document.querySelector("#import-dialog").open && !document.querySelector("#new-game").disabled');
  };
  const closeReview = async () => {
    await click('#review-close');
    await until('!document.querySelector("#match-review-dialog").open && !document.querySelector("#new-game").disabled');
  };
  const releaseResponses = () => evaluate('window.accuracyHold = false; window.accuracyHeld.splice(0).forEach(release => release())');
  const readReport = (prefix = '') => evaluate(`(() => {
    const panel = document.querySelector('${reportId(prefix)}');
    return {
      status: panel.dataset.status, model: panel.dataset.model, gameKey: panel.dataset.gameKey,
      text: panel.textContent, links: Array.from(panel.querySelectorAll('a[href]'), link => link.href),
      rows: Array.from(panel.querySelectorAll('[data-accuracy-ply]'), row => ({ ply: Number(row.dataset.accuracyPly), category: row.dataset.category, color: row.dataset.color, accuracy: Number(row.dataset.moveAccuracy), winPercentBefore: Number(row.dataset.winPercentBefore), winPercentAfter: Number(row.dataset.winPercentAfter) })),
      sides: Array.from(panel.querySelectorAll('[data-accuracy-color]'), side => ({ color: side.dataset.accuracyColor, score: Number(side.dataset.score) })),
      counts: Array.from(panel.querySelectorAll('[data-category-count][data-color]'), count => ({ category: count.dataset.categoryCount, color: count.dataset.color, count: Number(count.dataset.count) })),
    };
  })()`);
  const categories = ['Best', 'Excellent', 'Good', 'Inaccuracy', 'Mistake', 'Blunder'];
  const validateReport = (report, expectedPlies, results = []) => {
    assert.equal(report.status, 'complete');
    assert.equal(report.model, accuracyMath.METHOD_VERSION);
    assert.ok(report.gameKey);
    assert.equal(report.rows.length, expectedPlies, 'A complete report grades every recorded turn once');
    assert.deepEqual(report.rows.map(row => row.ply).sort((a, b) => a - b), Array.from({ length: expectedPlies }, (_, index) => index + 1));
    for (const row of report.rows) {
      assert.ok(categories.some(category => category.toLowerCase() === row.category.toLowerCase()), `Unknown classification ${row.category}`);
      assert.ok(Number.isFinite(row.accuracy) && row.accuracy >= 0 && row.accuracy <= 100, 'Per-move accuracy stays in 0–100');
      const response = results.find(result => result.ply === row.ply && result.scored && !result.cancelled);
      if (response) {
        assert.equal(row.category.toLowerCase(), response.classification.toLowerCase(), 'The visible category matches the actual engine result');
        assert.equal(row.color, response.move.color);
        assert.ok(Math.abs(row.accuracy - response.moveAccuracy) <= 1, 'Displayed move accuracy only differs by formatting');
      }
    }
    for (const color of ['white', 'black']) {
      const side = report.sides.find(item => item.color === color);
      assert.ok(side && Number.isFinite(side.score) && side.score >= 0 && side.score <= 100, `${color} needs a finite estimated score`);
      const expectedScore = accuracyMath.aggregateAccuracy(report.rows.map(row => ({ ...row, scored: true,
        move: { color: row.color }, moveAccuracy: row.accuracy })), report.rows[0].color).sides[color].score;
      assert.ok(Math.abs(side.score - expectedScore) < .000001, 'Each side combines weighted and harmonic means');
      let total = 0;
      for (const category of categories) {
        const count = report.counts.find(item => item.color === color && item.category.toLowerCase() === category.toLowerCase());
        assert.ok(count, `Missing ${color} ${category} count`);
        const expected = report.rows.filter(row => row.color === color && row.category.toLowerCase() === category.toLowerCase()).length;
        assert.equal(count.count, expected, 'Summary category counts agree with individual move grades');
        total += count.count;
      }
      assert.equal(total, report.rows.filter(row => row.color === color).length);
    }
    assert.match(report.text, /estimate/i, 'Scores must be labeled as estimates');
    assert.match(report.text, /Lichess-style local estimate/);
    assert.match(report.text, /Not Chess.com CAPS2/);
    assert.ok(report.links.some(link => /^https:\/\/(?:[^/]+\.)?chess\.com\//.test(link)), 'Category reference links to the documented Chess.com source');
  };

  // Install before navigation so reload checks also count requests during initialization.
  const instrumentation = `(() => {
    const original = window.fetch.bind(window);
    window.accuracyRequests = [];
    window.accuracyResponses = [];
    window.accuracyStops = [];
    window.otherStops = [];
    window.accuracyHeld = [];
    window.accuracyHold = false;
    window.accuracyFailOnce = false;
    window.reviewRequests = [];
    window.fetch = async (url, options) => {
      if (url === '/api/accuracy/stop') window.accuracyStops.push(JSON.parse(options.body));
      if (['/api/stop', '/api/explain/stop', '/api/review/stop', '/api/arrows/stop'].includes(url)) window.otherStops.push({ url, body: JSON.parse(options.body) });
      if (url === '/api/review') window.reviewRequests.push(JSON.parse(options.body));
      if (url !== '/api/accuracy') return original(url, options);
      const request = JSON.parse(options.body);
      window.accuracyRequests.push(request);
      if (window.accuracyFailOnce) {
        window.accuracyFailOnce = false;
        throw new TypeError('Intentional accuracy transport failure');
      }
      const response = await original(url, options);
      const body = await response.clone().text();
      const result = JSON.parse(body);
      window.accuracyResponses.push(result);
      if (window.accuracyHold && response.ok && !result.cancelled) {
        const delayed = new Response(body, { status: response.status, headers: response.headers });
        return new Promise(resolve => window.accuracyHeld.push(() => resolve(delayed)));
      }
      return response;
    };
  })()`;
  await call('Runtime.enable');
  await call('Log.enable');
  await call('Page.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: instrumentation });
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: base });
  await until('document.querySelector("#new-game-dialog")?.open && document.querySelectorAll("#board .square").length === 64');
  await evaluate('document.querySelector("#new-game-form").requestSubmit()');
  await until('!document.querySelector("#new-game-dialog").open && !document.querySelector("#submit-move").disabled');
  await evaluate('for (const id of ["auto-reply", "coach-auto"]) { const control = document.getElementById(id); if (control.checked) control.click(); }');
  assert.equal(await evaluate(`${workspace}.settings.strength`), 70);
  assert.equal(await evaluate('window.accuracyRequests.length'), 0, 'A new game does not trigger post-match accuracy work');
  progress('Loaded 70% game; checking unfinished and automatic finished-game behavior');
  await importPgn('1. f3 e5 2. g4 *');
  await delay(300);
  assert.equal(await evaluate('window.accuracyRequests.length'), 0, 'An unfinished live game must not run the accuracy report');
  assert.equal(await evaluate(visibleLiveReport), false);

  await evaluate('window.accuracyHold = true');
  await setInput('#move-input', 'Qh4#');
  await evaluate('document.querySelector("#move-form").requestSubmit()');
  await until('window.accuracyHeld.length === 1 && !document.querySelector("#match-finished").hidden');
  assert.equal(await evaluate(visibleLiveReport), true, 'Finishing the game automatically shows the report');
  assert.equal(await evaluate(complete()), false, 'A response held before grading finishes cannot produce a complete report');
  assert.equal(await evaluate('document.querySelector("#accuracy-report").dataset.status'), 'loading');
  const partialRows = await evaluate('Array.from(document.querySelectorAll("#accuracy-report [data-accuracy-ply]")).filter(row => !["Pending", "Unscored"].includes(row.dataset.category)).length');
  assert.ok(partialRows < 4, 'Progress distinguishes pending turns from graded turns');
  const fullMoves = ['f2f3', 'e7e5', 'g2g4', 'd8h4'];
  const finishedGame = await evaluate(savedGame);
  await releaseResponses();
  await waitComplete();
  const results = await evaluate('window.accuracyResponses.filter(result => result.scored && !result.cancelled)');
  assert.equal(results.length, 4, 'Four-turn match receives four native scored results');
  assert.deepEqual(results.map(result => result.ply).sort(), [1, 2, 3, 4]);
  for (const result of results) {
    assert.deepEqual(result.moves, fullMoves);
    assert.equal(result.strength, 100);
    assert.equal(result.forgiving, false);
    assert.equal(result.skillLevel, 20);
    assert.equal(result.methodVersion, accuracyMath.METHOD_VERSION);
    assert.ok(result.depth > 0 || result.ply === 4, 'Scored results carry search evidence');
  }
  const finishedReport = await readReport();
  validateReport(finishedReport, 4, results);
  assert.equal(finishedReport.rows.find(row => row.ply === 3).category.toLowerCase(), 'blunder', 'g4 allowing forced mate is a blunder');
  assert.equal(finishedReport.rows.find(row => row.ply === 4).category.toLowerCase(), 'best', 'The mating solver move is best');
  assert.equal(await evaluate(savedGame), finishedGame, 'Automatic scoring is read only');
  assert.equal(await evaluate(`${workspace}.settings.strength`), 70, 'Full-strength scoring leaves playing difficulty unchanged');
  progress('Finished report has all 4 grades, matching category counts, and full-strength evidence');

  await mkdir('artifacts', { recursive: true });
  await evaluate('document.querySelector("#accuracy-report").scrollIntoView({ block: "start" })');
  await capture('accuracy-desktop');
  const persisted = await evaluate('Object.keys(localStorage).filter(key => key.includes("accuracy")).map(key => ({ key, value: localStorage.getItem(key) }))');
  assert.ok(persisted.some(item => item.key === accuracyMath.STORE_KEY && item.value.includes(accuracyMath.METHOD_VERSION)), 'Cached reports are identified by their scoring method version');
  await evaluate('window.accuracyReloadPending = true');
  await call('Page.reload');
  await until(`!window.accuracyReloadPending && ${complete()} && !document.querySelector('#new-game').disabled`);
  await delay(300);
  assert.equal(await evaluate('window.accuracyRequests.length'), 0, 'Reload reuses a complete report without recomputing engine scores');
  await evaluate('if (document.querySelector("#coach-auto").checked) document.querySelector("#coach-auto").click()');
  assert.deepEqual((await readReport()).rows, finishedReport.rows);
  progress('Reload persisted the complete report without any accuracy requests');

  await click('#review-match');
  await until('document.querySelector("#match-review-dialog").open');
  await waitComplete('review-');
  validateReport(await readReport('review-'), 4, results);
  await evaluate(`(() => { const row = document.querySelector('#review-accuracy-report [data-accuracy-ply="3"]'); (row.querySelector('button') || row).click(); })()`);
  await until('document.querySelector("#review-move").value === "3" && !document.querySelector("#review-content").hidden');
  assert.match(await evaluate('document.querySelector("#review-verdict").textContent'), /blunder/i, 'The replay lesson uses the full-strength report classification');
  assert.equal(await evaluate(savedGame), finishedGame, 'Clicking a report row navigates review without changing the live game');
  await select('#review-strength', 'match');
  await until('window.reviewRequests.some(request => request.strength === 70 && request.ply === 3) && !document.querySelector("#review-content").hidden && document.querySelector("#review-error").hidden');
  validateReport(await readReport('review-'), 4, results);
  assert.match(await evaluate('document.querySelector("#review-verdict").textContent'), /blunder/i, 'Changing the teacher cannot replace the report classification with a conflicting grade');
  assert.equal(await evaluate('window.accuracyRequests.length'), 0, 'Changing move-review teacher strength does not regrade accuracy at reduced strength');
  await select('#review-strength', 'full');
  await until('!document.querySelector("#review-content").hidden && document.querySelector("#review-error").hidden');
  await evaluate('document.querySelector("#review-accuracy-report").scrollIntoView({ block: "start" })');
  await capture('accuracy-review');
  await closeReview();
  progress('Review rows navigate the replay; teacher settings preserve the full-strength report');

  // A different unfinished match is analyzed only after opening its review.
  await importPgn('1. e4 e5 2. Nf3 *');
  const partialGame = await evaluate(savedGame);
  const beforePartial = await evaluate('window.accuracyRequests.length');
  await delay(300);
  assert.equal(await evaluate('window.accuracyRequests.length'), beforePartial);
  assert.equal(await evaluate(visibleLiveReport), false);
  await evaluate('window.accuracyFailOnce = true');
  await click('#review-match');
  await until('document.querySelector("#match-review-dialog").open && !document.querySelector("#review-accuracy-error-box").hidden');
  assert.equal(await evaluate(complete('review-')), false, 'An error cannot masquerade as a completed report');
  assert.ok((await evaluate('document.querySelector("#review-accuracy-error").textContent')).length > 10);

  // Start a native play search directly while retrying the separate accuracy worker.
  await evaluate(`(() => {
    const saved = ${workspace};
    window.accuracyConcurrentPlay = fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initialFen: saved.initialFen, moves: saved.moves, requestId: 'accuracy-smoke-independent-play', strength: 70, forgiving: false, seconds: 1, threads: 1, hashMb: 32, multiPv: 1 }) }).then(async response => { const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Concurrent play search failed'); return result; });
  })()`);
  const otherStopsBefore = await evaluate('window.otherStops.length');
  await click('#review-accuracy-retry');
  await waitComplete('review-');
  const simultaneousPlay = await evaluate('window.accuracyConcurrentPlay');
  assert.equal(simultaneousPlay.cancelled, false, 'Accuracy searches must not cancel a separate live-play search');
  assert.ok(simultaneousPlay.bestMove);
  assert.equal(simultaneousPlay.strength, 70);
  assert.equal(await evaluate('window.otherStops.length'), otherStopsBefore, 'Accuracy retry sends no stop commands to other engine services');
  const partialResults = await evaluate('window.accuracyResponses.filter(result => result.moves?.length === 3 && result.scored && !result.cancelled)');
  validateReport(await readReport('review-'), 3, partialResults);
  assert.ok(partialResults.every(result => result.strength === 100 && result.forgiving === false));
  assert.equal(await evaluate(savedGame), partialGame);
  await closeReview();
  progress('Unfinished-match review recovered from an error; native play and full-strength scoring ran independently');

  // Retained completed matches must still open their own report over a newer live game.
  await click('#review-last-match');
  await until('document.querySelector("#match-review-dialog").open');
  await waitComplete('review-');
  assert.equal((await readReport('review-')).gameKey, finishedReport.gameKey);
  validateReport(await readReport('review-'), 4, results);
  await closeReview();
  assert.equal(await evaluate(savedGame), partialGame);
  progress('Retained match report remains separate from the current unfinished game');

  // Each race holds a successful native result before the client receives it.
  for (const scenario of [
    { name: 'undo', pgn: '1. g4 e5 2. f3 Qh4# 0-1' },
    { name: 'import', pgn: '1. f4 e5 2. g4 Qh4# 0-1' },
    { name: 'new-game', pgn: '1. g4 e6 2. f3 Qh4# 0-1' },
  ]) {
    progress(`Holding a real score across ${scenario.name}`);
    await evaluate('window.accuracyHold = true');
    await importPgn(scenario.pgn);
    await until('window.accuracyHeld.length === 1');
    const staleId = await evaluate('window.accuracyRequests.at(-1).requestId');
    const pendingCount = await evaluate('window.accuracyRequests.length');
    if (scenario.name === 'undo') {
      await click('#undo');
      await until(`${workspace}.moves.length === 3 && !document.querySelector('#submit-move').disabled`);
    } else if (scenario.name === 'import') await importPgn('1. d4 d5 *');
    else {
      await click('#new-game');
      await until('document.querySelector("#new-game-dialog").open');
      await evaluate('document.querySelector("#new-game-form").requestSubmit()');
      await until(`!document.querySelector('#new-game-dialog').open && ${workspace}.moves.length === 0 && !document.querySelector('#submit-move').disabled`);
    }
    const replacement = await evaluate(savedGame);
    await until(`window.accuracyStops.some(request => request.requestId === ${JSON.stringify(staleId)})`);
    await releaseResponses();
    await delay(400);
    assert.equal(await evaluate(savedGame), replacement, `Late ${scenario.name} score cannot alter the replacement game`);
    assert.equal(await evaluate(visibleLiveReport), false, `Late ${scenario.name} score cannot revive the abandoned live report`);
    assert.equal(await evaluate('window.accuracyRequests.length'), pendingCount, `After ${scenario.name}, unfinished live play must not continue the abandoned report`);
  }
  progress('Undo, import, and new-game stale responses were cancelled and ignored');

  await importPgn('1. f3 e5 2. g4 Qh4# 0-1');
  await waitComplete();
  for (const [width, height] of [[390, 844], [320, 568]]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
    await evaluate('document.querySelector("#accuracy-report").scrollIntoView({ block: "start" })');
    await delay(100);
    assert.equal(await evaluate(`(() => {
      const report = document.querySelector('#accuracy-report');
      const bounds = report.getBoundingClientRect();
      return document.documentElement.scrollWidth <= innerWidth && bounds.left >= -1 && bounds.right <= innerWidth + 1 && report.scrollWidth <= report.clientWidth + 1;
    })()`), true, `Completed report fits ${width}px without horizontal overflow`);
    await capture(width === 390 ? 'accuracy-mobile' : 'accuracy-narrow');
    await click('#review-match');
    await until('document.querySelector("#match-review-dialog").open');
    await waitComplete('review-');
    await evaluate('document.querySelector("#review-accuracy-report").scrollIntoView({ block: "start" })');
    assert.equal(await evaluate(`(() => {
      const dialog = document.querySelector('#match-review-dialog');
      return dialog.scrollWidth <= dialog.clientWidth + 1 && dialog.getBoundingClientRect().right <= innerWidth + 1;
    })()`), true, `Review report fits ${width}px without horizontal overflow`);
    await capture(width === 390 ? 'accuracy-review-mobile' : 'accuracy-review-narrow');
    await closeReview();
  }
  await evaluate(`(() => {
    const legacy = JSON.parse(localStorage.getItem('knightfall.accuracy.v2'));
    legacy.methodVersion = 'knightfall-ep-v1';
    for (const game of legacy.games) for (const row of game.rows) if (row) row.methodVersion = legacy.methodVersion;
    localStorage.setItem('knightfall.accuracy.v1', JSON.stringify(legacy));
    localStorage.removeItem('knightfall.accuracy.v2');
    window.accuracyReloadPending = true;
  })()`);
  await call('Page.reload');
  await until(`!window.accuracyReloadPending && ${complete()} && !document.querySelector('#new-game').disabled`);
  assert.equal(await evaluate('window.accuracyRequests.length'), 4, 'Old v1 reports must be recomputed, never reused as new estimates');
  validateReport(await readReport(), 4, await evaluate('window.accuracyResponses'));
  progress('Legacy v1 report was invalidated and all moves were recomputed with v2');
  assert.deepEqual(errors, [], 'Accuracy reports must not emit browser runtime or CSP errors');
  progress('PASS: automatic finished-match scores, native full-strength grading, categories and totals, provisional progress, persistent cache, review navigation and teacher isolation, unfinished/retained review, error retry, engine isolation, stale-response cancellation, and 390/320px layouts');
  console.log('Screenshots: artifacts/accuracy-desktop.png, artifacts/accuracy-review.png, artifacts/accuracy-mobile.png, artifacts/accuracy-narrow.png, artifacts/accuracy-review-mobile.png, artifacts/accuracy-review-narrow.png');
} finally {
  client?.close();
  chrome.kill('SIGTERM');
}
