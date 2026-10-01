#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPathConfig } from './lib/path_config.mjs';
import * as web from './lib/web_helpers.mjs';

// 사용: node chrome_cdp_runner.mjs <실행 요청.json> [<사용자 요청.json>]
// 실행 요청은 cu_web.ps1이 만들고(포트·고정 탭·증거 경로), 사용자 요청은 node scripts/cu.mjs가 만든다(글자·옵션).
const reqPath = process.argv[2];
if (!reqPath) {
  console.log(JSON.stringify({ ok: false, error: '요청 파일이 없습니다.' }));
  process.exit(2);
}

function readRequest(file) {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/u, ''));
}

function definedOnly(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

const runtimeSpec = readRequest(reqPath);
const userSpec = process.argv[3] ? readRequest(process.argv[3]) : {};
const spec = { ...userSpec, ...definedOnly(runtimeSpec), options: { ...(userSpec.options || {}), ...(runtimeSpec.options || {}) } };
const {
  action,
  port = 9224,
  url = null,
  selector = null,
  text = null,
  value = null,
  out = null,
  targetId = null,
  profile = 'default',
} = spec;
const options = spec.options || {};
const timeout = Number(options.timeout || spec.timeout || 15000);
const pathConfig = loadPathConfig();
const stateDir = spec.stateDir || pathConfig.stateDirWin;
const shotsDir = spec.shotsDir || pathConfig.shotsDirWin;
const A1 = String(spec.arg1 ?? text ?? selector ?? out ?? '');
const A2 = String(spec.arg2 ?? value ?? '');

// 화면이나 데이터를 바꿀 수 있는 명령. 대상 탭이 분명해야 하고, 실행 결과를 done / not_done / unknown으로 남긴다.
const WRITE_ACTIONS = new Set(['click', 'clicktext', 'type', 'setvalue', 'keys', 'select', 'pick', 'check', 'uncheck', 'upload', 'press', 'download', 'script']);
const STOPPABLE = new Set([...WRITE_ACTIONS, 'goto', 'reload', 'eval', 'identify', 'hover', 'scroll', 'window', 'fetch', 'net']);
const EVIDENCE_ACTIONS = new Set([...WRITE_ACTIONS, 'goto', 'reload', 'identify', 'window', 'scroll', 'hover', 'dismiss', 'handoff']);
// 확인창을 취소했으면 실패로 보는 명령(이동 중 beforeunload 취소 포함).
const FAIL_ON_DISMISSED = new Set([...WRITE_ACTIONS, 'goto', 'reload', 'dismiss']);
// 라벨 글자(--label)로 입력 칸을 지정할 수 있는 명령.
const LABEL_ACTIONS = new Set(['type', 'setvalue', 'keys', 'select', 'pick', 'check', 'uncheck', 'upload', 'click', 'hover', 'press']);

function emit(result) {
  console.log(JSON.stringify(result));
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/gu, '').replace(/\..*$/u, '').replace('T', '_');
}

function playwrightEntry(root) {
  if (!root) return [];
  const entry = String(root).trim();
  if (!entry) return [];
  if (/\.(?:mjs|js)$/iu.test(entry)) return [entry];
  return [join(entry, 'index.mjs'), join(entry, 'index.js')];
}

async function importPlaywright(file) {
  if (!file || !existsSync(file)) return null;
  try { return await import(pathToFileURL(file).href); } catch { return null; }
}

async function loadPlaywright() {
  try { return await import('playwright-core'); } catch {}

  const runtimeRoot = join(pathConfig.stateDirWin, 'browser-runtime');
  const candidates = [
    ...playwrightEntry(process.env.CU_PLAYWRIGHT_CORE_PATH),
    join(runtimeRoot, 'node_modules', 'playwright-core', 'index.mjs'),
    join(runtimeRoot, 'node_modules', 'playwright-core', 'index.js'),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'claude-cdp', 'node_modules', 'playwright-core', 'index.mjs') : '',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'claude-cdp', 'node_modules', 'playwright-core', 'index.js') : '',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const loaded = await importPlaywright(candidate);
    if (loaded) return loaded;
  }

  mkdirSync(runtimeRoot, { recursive: true });
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const installed = spawnSync(npm, [
    'install',
    '--prefix', runtimeRoot,
    '--no-save',
    '--no-audit',
    '--no-fund',
    'playwright-core@1.60.0',
  ], { encoding: 'utf8', timeout: 180000, windowsHide: true, shell: process.platform === 'win32' });
  if (installed.status !== 0) {
    throw new Error(`Playwright 실행 도구 자동 준비 실패: ${installed.stderr || installed.stdout || `exit ${installed.status}`}`);
  }
  for (const candidate of playwrightEntry(join(runtimeRoot, 'node_modules', 'playwright-core'))) {
    const loaded = await importPlaywright(candidate);
    if (loaded) return loaded;
  }
  throw new Error('Playwright 실행 도구를 준비했지만 불러오지 못했습니다.');
}

function outputPath(file, fallback) {
  const candidate = String(file || fallback || '').trim();
  return isAbsolute(candidate) ? candidate : resolve(candidate);
}

async function screenshot(page, file, extra = {}) {
  const target = outputPath(file, join(shotsDir, 'web_last.png'));
  return web.screenshot(page, target, { fullPage: Boolean(extra.fullPage), selector: extra.selector || null, scope: extra.scope || null, front: !options.noFront });
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// --dry-run 계획: 무엇을 누르거나 입력할지, 덮였는지, 모호한지만 확인한다.
async function planOnly(scope, page, target) {
  const plan = { dryRun: true, action };
  if (action === 'clicktext' || (action === 'hover' && options.text) || (action === 'net' && options.clicktext) || (action === 'download' && options.clicktext)) {
    const query = action === 'clicktext' ? A1 : (options.text || options.clicktext);
    const found = await web.findByText(scope, query, { exact: Boolean(options.exact), contains: Boolean(options.contains), within: options.within || null, limit: 20 });
    const pick = web.pickTextCandidate(found, { nth: Number(options.nth || 0), first: Boolean(options.first), query: found.query });
    const cover = await web.hitCovered(scope, pick.hit);
    const { hit, ...shown } = pick;
    return { ...plan, target: shown, of: found.total, covered: cover.covered ? cover.by : false };
  }
  const selector = action === 'net' || action === 'download' ? options.click : target;
  if (['click', 'hover', 'press', 'type', 'setvalue', 'keys', 'select', 'pick', 'check', 'uncheck', 'upload', 'net', 'download'].includes(action) && selector && !(action === 'upload' && (options.chooser || options.chooserText))) {
    const locator = scope.locator(selector);
    const count = await locator.count();
    plan.target = { selector, count, visible: count ? await locator.first().isVisible() : false };
    if (count) {
      const field = await locator.first().evaluate((el) => ({ tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '', disabled: Boolean(el.disabled), checked: typeof el.checked === 'boolean' ? el.checked : undefined, valueLength: typeof el.value === 'string' ? el.value.length : undefined, options: el.tagName === 'SELECT' ? [...el.options].slice(0, 30).map((option) => option.textContent.trim()) : undefined }));
      Object.assign(plan.target, field);
      const cover = await web.selectorCovered(scope, selector);
      plan.covered = cover.covered ? cover.by : false;
    }
  }
  if (action === 'upload') {
    const chooserMode = Boolean(options.chooser || options.chooserText);
    const files = Array.isArray(options.files) && options.files.length ? options.files : (chooserMode ? [A1, A2] : [A2]).filter(Boolean);
    plan.files = web.describeLocalFiles(files);
  }
  if (action === 'fetch') plan.request = { method: String(options.method || 'GET').toUpperCase(), url: A1, body: options.body === undefined ? undefined : JSON.stringify(options.body).slice(0, 500) };
  if (action === 'dismiss') plan.modals = await web.visibleModals(scope);
  return plan;
}

async function pageTargetId(context, page) {
  const session = await context.newCDPSession(page);
  try {
    const info = await session.send('Target.getTargetInfo');
    return String(info?.targetInfo?.targetId || '');
  } finally {
    await session.detach().catch(() => {});
  }
}

// 탭 주소는 쿼리를 빼고 비교한다. 로그인 화면 주소는 돌아갈 주소를 쿼리에 담기 때문에
// 단순 부분 일치로 고르면 로그인 탭을 작업 탭으로 오인한다. 쿼리까지 지정한 힌트만 전체 주소와 비교한다.
function tabMatches(pageUrl, hint) {
  const wanted = String(hint || '').trim();
  if (!wanted) return false;
  const raw = String(pageUrl || '');
  if (/[?#]/u.test(wanted)) return raw.includes(wanted);
  let hostPath = raw.toLowerCase();
  try {
    const parsed = new URL(raw);
    hostPath = `${parsed.host}${parsed.pathname}`.toLowerCase();
  } catch {}
  const bare = wanted.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, '').toLowerCase();
  return hostPath.includes(bare);
}

function isBlankish(pageUrl) {
  return /^(?:about:blank|chrome:\/\/(?:newtab|new-tab-page)\/?|chrome-search:\/\/)/iu.test(String(pageUrl || ''));
}

function withoutQuery(raw) {
  return String(raw || '').replace(/[?#].*$/u, '').slice(0, 300);
}

function domainAllowed(pageUrl, domains) {
  let host = '';
  try { host = new URL(pageUrl).hostname.toLowerCase(); } catch { return false; }
  return domains.some((domain) => {
    const item = String(domain || '').toLowerCase().replace(/^\*\./u, '');
    return item && (host === item || host.endsWith(`.${item}`));
  });
}

function clip(valueToClip, file) {
  let json = '';
  try { json = JSON.stringify(valueToClip); } catch { return { result: String(valueToClip).slice(0, 4000), note: 'JSON으로 바꿀 수 없는 결과라 글자로 줄였습니다.' }; }
  if (json === undefined) return { result: null };
  if (json.length <= 200000) return { result: valueToClip };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, json, 'utf8');
  return { result: null, resultFile: file, resultChars: json.length, preview: json.slice(0, 4000) };
}

function writeArtifact(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8');
  return file;
}

function readValueOption() {
  if (options.valueFile) {
    const file = String(options.valueFile);
    if (!existsSync(file)) throw new Error(`입력값 파일이 없습니다: ${file}`);
    return readFileSync(file, 'utf8').replace(/^﻿/u, '');
  }
  return A2;
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// --- 실행 보호: 중지 파일, 포트별 쓰기 잠금, 중복 실행 방지 기록 ---

function stopRequested() {
  return existsSync(join(stateDir, 'STOP'));
}

function processAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function acquireWriteLock() {
  const dir = join(stateDir, 'locks');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `cdp-${port}.lock`);
  const body = JSON.stringify({ pid: process.pid, action, profile, at: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      writeFileSync(fd, body);
      closeSync(fd);
      return () => { try { unlinkSync(file); } catch {} };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let holder = {};
      try { holder = JSON.parse(readFileSync(file, 'utf8')); } catch {}
      if (holder.pid && processAlive(holder.pid) && Number(holder.pid) !== process.pid) {
        const busy = new Error(`같은 Chrome(연결 ${port})에서 다른 쓰기 작업이 진행 중입니다(pid ${holder.pid}, ${holder.action}). 끝난 뒤 다시 실행하세요.`);
        busy.code = 'busy';
        throw busy;
      }
      try { unlinkSync(file); } catch {}
    }
  }
  throw new Error(`쓰기 잠금을 얻지 못했습니다: ${file}`);
}

function idempotencyFile() {
  return join(stateDir, 'web_idempotency.jsonl');
}

function priorIdempotent(key) {
  const file = idempotencyFile();
  if (!existsSync(file)) return null;
  let found = null;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.key === key) found = entry;
    } catch {}
  }
  return found;
}

function recordIdempotent(key, outcome, extra) {
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(idempotencyFile(), `${JSON.stringify({ key, outcome, action, profile, at: new Date().toISOString(), ...extra })}\n`, 'utf8');
}

function audit(entry) {
  try {
    mkdirSync(stateDir, { recursive: true });
    const file = join(stateDir, 'web_audit.jsonl');
    if (existsSync(file) && statSync(file).size > 5 * 1024 * 1024) renameSync(file, `${file}.1`);
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), profile, port: Number(port), action, ...entry })}\n`, 'utf8');
  } catch {}
}

// --- CDP 직접 확인(Playwright 없이): 포트가 열려 있는 것과 실제 응답하는 것은 다르다 ---

async function httpJson(target, ms = 3000) {
  const response = await fetch(target, { signal: AbortSignal.timeout(ms) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function cdpCall(wsUrl, method, params = {}, ms = 6000) {
  if (typeof WebSocket !== 'function') return Promise.reject(new Error('이 Node.js에는 WebSocket이 없습니다. Node 22 이상이 필요합니다.'));
  return new Promise((resolveCall, reject) => {
    let settled = false;
    const socket = new WebSocket(wsUrl);
    const finish = (fn, item) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      fn(item);
    };
    const timer = setTimeout(() => finish(reject, new Error(`응답 없음 ${ms}ms`)), ms);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id !== 1) return;
      if (message.error) finish(reject, new Error(message.error.message || 'CDP 오류'));
      else finish(resolveCall, message.result);
    });
    socket.addEventListener('error', () => finish(reject, new Error('WebSocket 연결 실패')));
  });
}

async function probeBrowser() {
  const started = Date.now();
  const version = await httpJson(`http://127.0.0.1:${port}/json/version`);
  const ua = String(version['User-Agent'] || '');
  await cdpCall(version.webSocketDebuggerUrl, 'Browser.getVersion', {}, 8000);
  return {
    alive: true,
    latencyMs: Date.now() - started,
    browser: version.Browser,
    windowsChrome: /Windows NT/u.test(ua) && !/HeadlessChrome/u.test(ua),
  };
}

async function healthCheck() {
  const browserState = await probeBrowser();
  const targets = (await httpJson(`http://127.0.0.1:${port}/json/list`)).filter((item) => item.type === 'page');
  const tabs = [];
  const queue = [...targets];
  async function worker() {
    while (queue.length) {
      const target = queue.shift();
      const started = Date.now();
      const entry = { id: target.id, title: String(target.title || '').slice(0, 80), url: withoutQuery(target.url) };
      try {
        if (!target.webSocketDebuggerUrl) throw new Error('다른 디버거가 이 탭을 점유했습니다.');
        await cdpCall(target.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: '1', returnByValue: true }, Number(options.tabTimeoutMs || 6000));
        entry.ok = true;
      } catch (error) {
        entry.ok = false;
        entry.error = String(error?.message || error).slice(0, 120);
      }
      entry.ms = Date.now() - started;
      tabs.push(entry);
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, targets.length || 1) }, worker));
  const hung = tabs.filter((tab) => !tab.ok);
  const closed = [];
  if (options.closeHung && hung.length) {
    for (const tab of hung) {
      let done = false;
      for (const method of ['PUT', 'GET']) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/close/${tab.id}`, { method, signal: AbortSignal.timeout(3000) });
          if (response.ok) { done = true; break; }
        } catch {}
      }
      closed.push({ id: tab.id, url: tab.url, closed: done });
    }
  }
  return { ...browserState, tabs: tabs.length, hung: hung.length, hungTabs: hung, closed };
}

// --- 실행 ---

let browser;
let releaseLock = null;
let phase = 'prepare';
const dialogLog = [];
const writeLog = [];
const popupLog = [];
const isWrite = WRITE_ACTIONS.has(action) || action === 'dismiss'
  || (action === 'net' && Boolean(options.click || options.clicktext))
  || (action === 'fetch' && !['GET', 'HEAD'].includes(String(options.method || 'GET').toUpperCase()));
// --dry-run: 대상을 찾고 덮임·모호함까지 확인하지만 실제로 누르거나 입력하지 않는다.
const dryRun = Boolean(options.dryRun);
const actsForReal = isWrite && !dryRun;

// CDP 연결이 node를 붙잡아 좀비가 되지 않도록 전체 시간 상한을 둔다.
const watchdogMs = Number(options.watchdogMs || (action === 'script'
  ? Math.max(Number(options.scriptTimeout || 180000) + 60000, 240000)
  : (action === 'handoff' ? Number(options.timeout || 600000) + 60000 : 300000)));
const watchdog = setTimeout(() => {
  emit({ ok: false, code: 'watchdog', error: `작업이 ${watchdogMs}ms 안에 끝나지 않아 연결을 끊습니다.`, ...(actsForReal ? { outcome: phase === 'prepare' ? 'not_done' : 'unknown' } : {}) });
  process.exit(1);
}, watchdogMs);
watchdog.unref();

// connectOverCDP는 모든 탭에 붙는다. 다른 CDP 사용자가 확인창을 먼저 닫으면 생기는 오류로 죽지 않게 그 경우만 무시한다.
process.on('unhandledRejection', (reason) => {
  const message = String(reason?.message || reason);
  if (/Page\.handleJavaScriptDialog|No dialog is showing/iu.test(message)) return;
  emit({ ok: false, error: `처리되지 않은 오류: ${message.slice(0, 600)}`, outcome: actsForReal ? (phase === 'prepare' ? 'not_done' : 'unknown') : undefined });
  process.exit(1);
});

// ping/health는 Playwright 없이 CDP에 직접 묻는다. WebSocket을 닫는 중 process.exit을 부르면
// Windows Node가 UV_HANDLE_CLOSING 단언으로 죽으므로(종료 코드 9) exitCode만 정하고 자연 종료한다.
async function runProbe() {
  try {
    if (process.platform !== 'win32') throw new Error('이 러너는 Windows Node에서 실행해야 합니다.');
    if (action === 'ping') {
      const state = await probeBrowser();
      emit({ ok: true, port: Number(port), profile, ...state });
      audit({ ok: true });
      return;
    }
    const state = await healthCheck();
    const healthy = state.hung === 0 || state.closed.length > 0;
    emit({ ok: healthy, port: Number(port), profile, ...state });
    audit({ ok: state.hung === 0, hung: state.hung });
    if (!healthy) process.exitCode = 1;
  } catch (error) {
    emit({ ok: false, port: Number(port), profile, alive: false, error: String(error?.message || error).slice(0, 400) });
    process.exitCode = 1;
  }
}

async function runMain() {
  try {
    if (process.platform !== 'win32') throw new Error('이 러너는 Windows Node에서 실행해야 합니다.');
    if (!action) throw new Error('작업 이름이 없습니다.');
    if (STOPPABLE.has(action) && stopRequested()) {
      const stopped = new Error('중지 파일(state\\STOP)이 있어 조작 명령을 거부합니다. 재개하려면 cu resume을 실행하세요.');
      stopped.code = 'stopped';
      throw stopped;
    }

    if (actsForReal && options.idemKey) {
      const prior = priorIdempotent(String(options.idemKey));
      if (prior && ['done', 'unknown'].includes(prior.outcome) && !options.repeat) {
        const duplicate = new Error(`같은 작업 키(${options.idemKey})가 이미 ${prior.outcome === 'done' ? '실행됐습니다' : '실행됐을 수 있습니다(결과 불명)'}(${prior.at}). 결과를 먼저 확인하세요. 정말 다시 하려면 --repeat를 붙입니다.`);
        duplicate.code = 'duplicate';
        throw duplicate;
      }
    }
    if (actsForReal) releaseLock = acquireWriteLock();

    const playwright = await loadPlaywright();
    const chromium = playwright.chromium || playwright.default?.chromium;
    if (!chromium) throw new Error('Playwright Chromium 연결 기능을 찾지 못했습니다.');

    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: Number(options.connectTimeout || 10000) });
    } catch (error) {
      throw new Error(`Chrome 연결 실패(${port}): ${String(error?.message || error).slice(0, 300)}. 멈춘 탭이 연결을 막을 수 있습니다. health --close-hung으로 확인하세요.`);
    }
    const context = browser.contexts()[0];
    if (!context) throw new Error('Chrome 기본 프로필 컨텍스트를 찾지 못했습니다.');
    const livePages = () => context.pages().filter((page) => !page.url().startsWith('devtools://'));
    const pages = livePages();
    const pageEntries = [];
    for (const candidate of pages) {
      let candidateTargetId = '';
      try { candidateTargetId = await pageTargetId(context, candidate); } catch {}
      pageEntries.push({ page: candidate, targetId: candidateTargetId });
    }
    let selectedEntry = targetId ? pageEntries.find((entry) => entry.targetId === targetId) : null;
    if (targetId && !selectedEntry && action !== 'goto' && action !== 'pages') {
      throw new Error('이전에 선택한 Chrome 탭이 닫혔습니다. pages 또는 goto로 대상을 다시 선택하세요.');
    }
    if (selectedEntry && url && action !== 'goto' && !tabMatches(selectedEntry.page.url(), url)) {
      throw new Error(`선택한 Chrome 탭의 주소가 요청과 다릅니다: ${url}`);
    }
    const matchingPages = url ? pages.filter((candidate) => tabMatches(candidate.url(), url)) : [];
    if (!selectedEntry && url && action !== 'goto' && action !== 'pages' && matchingPages.length > 1) {
      throw new Error(`요청한 주소에 일치하는 탭이 여러 개입니다. 더 구체적인 주소를 지정하세요: ${url}`);
    }
    let page = selectedEntry?.page || (action === 'goto' && !options.newTab ? matchingPages.at(-1) : matchingPages[0]) || null;
    if (!page && url && action !== 'goto' && action !== 'pages') {
      throw new Error(`요청한 주소가 열린 탭을 찾지 못했습니다: ${url}`);
    }
    if ((action === 'goto' || action === 'script') && options.newTab) page = await context.newPage();
    if (!page && action === 'goto') page = await context.newPage();
    // 주소를 받아 자기 탭을 여는 명령은 기준 탭만 있으면 된다.
    if (!page && ['capture', 'pageaudit'].includes(action) && A1) page = pages.find((candidate) => !isBlankish(candidate.url())) || pages[0] || await context.newPage();
    if (!page && action !== 'pages') {
      // 주소도 고정 탭도 없을 때는 열린 작업 탭이 하나뿐일 때만 그 탭을 쓴다. 여러 개면 임의로 고르지 않는다.
      const real = pages.filter((candidate) => !isBlankish(candidate.url()));
      if (real.length === 1) page = real[0];
      else if (real.length === 0) page = pages.at(-1) || await context.newPage();
      else {
        const list = real.slice(0, 8).map((candidate) => withoutQuery(candidate.url())).join(' | ');
        const ambiguous = new Error(`대상 탭이 정해지지 않았습니다. --url로 주소 일부를 지정하세요. 열린 탭: ${list}`);
        ambiguous.code = 'no_target';
        throw ambiguous;
      }
    }

    let scope = page;
    if (page && options.frame === 'auto') {
      const probe = ['clicktext', 'find', 'hover'].includes(action) ? { text: A1 || options.text } : (A1 ? { selector: A1 } : null);
      scope = probe ? await web.findFrameWith(page, probe) : page;
    } else if (page && options.frame && options.frame !== 'all') {
      scope = await web.resolveFrame(page, options.frame);
    }
    // --label: 화면 라벨 글자로 입력 칸을 찾아 선택자 대신 쓴다.
    let target = A1;
    let labelHit = null;
    if (page && options.label && LABEL_ACTIONS.has(action)) {
      labelHit = await web.fieldByLabel(scope, options.label, { exact: Boolean(options.exact), nth: Number(options.nth || 0) });
      target = labelHit.selector;
    }
    const dialogs = page ? web.installDialogPolicy(context, page, options.confirmDialog ? `expect:${options.confirmDialog}` : (options.dialog || 'dismiss'), dialogLog) : null;
    const writes = page && actsForReal ? web.watchWriteRequests(page, writeLog) : null;
    const popups = page && actsForReal ? web.watchPopups(page, popupLog) : null;
    // 쓰기 전 상태: 주소·열린 모달. 짧게 떴다 사라지는 토스트는 감시기로 잡는다.
    let before = null;
    if (page && actsForReal && action !== 'script') {
      before = { url: page.url(), modals: (await web.visibleModals(scope).catch(() => [])).map((item) => item.text) };
      await web.startToastWatch(scope);
    }
    let result = {};
    let evidence = null;
    let verified;
    const planning = dryRun && isWrite && action !== 'script';
    if (planning) result = await planOnly(scope, page, target);

    if (!planning) switch (action) {
      case 'pages': {
        const list = [];
        for (const entry of pageEntries) {
          let title = '';
          try { title = await entry.page.title(); } catch {}
          list.push({ url: entry.page.url().slice(0, 240), title: String(title || '').slice(0, 120), ...(targetId && entry.targetId === targetId ? { pinned: true } : {}) });
        }
        result = { count: list.length, pages: list };
        break;
      }
      case 'goto': {
        const target = A1 || url;
        if (!target) throw new Error('이동할 주소가 없습니다.');
        phase = 'acting';
        await page.goto(target, { timeout: Math.max(timeout, 30000), waitUntil: options.waitUntil || 'domcontentloaded' });
        if (options.waitText) await web.waitText(page, options.waitText, { timeout });
        const session = await web.sessionState(page).catch(() => null);
        result = { url: page.url(), title: await page.title().catch(() => ''), ...(session ? { loginWall: session.status === 'LOGIN_WALL' } : {}) };
        break;
      }
      case 'reload': {
        phase = 'acting';
        await page.reload({ timeout: Math.max(timeout, 30000), waitUntil: options.waitUntil || 'domcontentloaded' });
        result = { url: page.url() };
        break;
      }
      case 'read': {
        const maxChars = Number(options.maxChars || 12000);
        if (options.frame === 'all') {
          const parts = [];
          for (const frame of page.frames()) {
            try {
              const frameText = await frame.evaluate(() => document.body?.innerText || '');
              if (frameText.trim()) parts.push({ frame: frame.url().slice(0, 160), text: frameText.slice(0, maxChars) });
            } catch {}
          }
          result = { url: page.url(), title: await page.title().catch(() => ''), frames: parts };
        } else {
          const bodyText = options.selector
            ? await scope.locator(options.selector).first().innerText({ timeout })
            : await scope.evaluate(() => document.body?.innerText || '');
          result = { url: page.url(), title: await page.title().catch(() => ''), text: bodyText.slice(0, maxChars), chars: bodyText.length };
        }
        break;
      }
      case 'find': {
        const found = await web.findByText(scope, A1, { exact: Boolean(options.exact), contains: Boolean(options.contains), within: options.within || null, includeHidden: Boolean(options.includeHidden), limit: Number(options.limit || 20) });
        result = { query: found.query, count: found.total, sample: found.candidates.map(({ hit, ...rest }) => rest) };
        break;
      }
      case 'click': {
        phase = 'acting';
        result = await web.clickSelector(scope, target, { double: Boolean(options.double), force: Boolean(options.force), timeout });
        result.url = page.url();
        break;
      }
      case 'clicktext': {
        const clickOptions = { exact: Boolean(options.exact), contains: Boolean(options.contains), within: options.within || null, nth: Number(options.nth || 0), first: Boolean(options.first), double: Boolean(options.double), force: Boolean(options.force), timeout };
        phase = 'acting';
        result = await web.clickText(scope, A1, clickOptions);
        result.url = page.url();
        break;
      }
      case 'type':
      case 'setvalue':
      case 'keys': {
        const mode = action === 'setvalue' ? 'native' : (action === 'keys' ? 'keys' : (options.mode || 'fill'));
        const typed = options.label && !options.valueFile && !A2 ? A1 : readValueOption();
        phase = 'acting';
        result = await web.setValue(scope, target, typed, { mode, timeout, requireEmpty: Boolean(options.requireEmpty), counter: options.counter || null, allowSecret: Boolean(options.allowSecret), numeric: Boolean(options.numeric) });
        result.typed = options.label ? `label:${options.label}` : A1;
        verified = result.verified;
        break;
      }
      case 'select': {
        phase = 'acting';
        result = await web.selectExact(scope, target, options.label && !A2 ? A1 : readValueOption(), { timeout });
        verified = result.verified;
        break;
      }
      case 'pick': {
        const byText = Boolean(options.triggerText);
        const option = byText || options.label ? A1 : readValueOption();
        phase = 'acting';
        result = await web.pickOption(scope, { trigger: byText ? null : target, triggerText: options.triggerText || null, option, timeout, via: options.via || 'click' });
        verified = result.verified ?? undefined;
        break;
      }
      case 'check':
      case 'uncheck': {
        phase = 'acting';
        const state = await web.setChecked(scope, target, action === 'check', { timeout });
        result = { checked: options.label ? `label:${options.label}` : A1, state: state.checked, verified: state.verified };
        verified = state.verified;
        break;
      }
      case 'upload': {
        const chooserMode = Boolean(options.chooser || options.chooserText);
        const files = Array.isArray(options.files) && options.files.length
          ? options.files
          : ((chooserMode || options.label) ? [A1, A2, ...(options.rest || [])] : [A2, ...(options.rest || [])]).filter(Boolean);
        web.describeLocalFiles(files);
        phase = 'acting';
        const uploaded = await web.uploadFiles(scope, chooserMode
          ? { chooserSelector: options.chooser || null, chooserText: options.chooserText || null, files, timeout: Math.max(timeout, 30000) }
          : { selector: target, files, timeout: Math.max(timeout, 30000) });
        result = { uploaded: chooserMode ? (options.chooser || options.chooserText) : (options.label ? `label:${options.label}` : A1), ...uploaded };
        verified = uploaded.verified ?? undefined;
        break;
      }
      case 'press': {
        if (!A1) throw new Error('누를 키가 없습니다. 예: Enter, Escape, Control+A');
        phase = 'acting';
        const pressTarget = options.label ? target : options.selector;
        if (pressTarget) await scope.locator(pressTarget).first().press(A1, { timeout });
        else await page.keyboard.press(A1);
        result = { pressed: A1, url: page.url() };
        break;
      }
      case 'hover': {
        result = await web.hover(scope, { selector: options.text ? null : target, text: options.text || null, nth: Number(options.nth || 0), first: Boolean(options.first), timeout });
        break;
      }
      case 'scroll': {
        const direction = (A1 || 'down').toLowerCase();
        if (direction === 'bottom' || options.untilText) {
          result = await web.scrollUntil(scope, { container: options.selector || null, stepPx: Number(options.px || 800), maxSteps: Number(options.maxSteps || 30), untilText: options.untilText || null, wheel: Boolean(options.wheel) });
        } else {
          const delta = direction === 'top' ? 'top' : (direction === 'up' ? -Number(options.px || 800) : Number(options.px || 800));
          if (options.wheel && delta !== 'top') {
            await page.mouse.wheel(0, delta);
            await web.sleep(400);
          }
          result = await scope.evaluate(({ container, delta, wheel }) => {
            const el = container ? document.querySelector(container) : (document.scrollingElement || document.documentElement);
            if (!el) return { error: 'container_not_found' };
            if (delta === 'top') el.scrollTop = 0;
            else if (!wheel) el.scrollTop += delta;
            return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
          }, { container: options.selector || null, delta, wheel: Boolean(options.wheel) });
          if (result.error) throw new Error(`스크롤 영역을 찾지 못했습니다: ${options.selector}`);
        }
        break;
      }
      case 'eval': {
        result = { result: await scope.evaluate((code) => globalThis.eval(code), A1 || '') };
        break;
      }
      case 'assert': {
        const query = web.parseTextQuery(A1);
        const bodyText = await scope.evaluate(() => document.body?.innerText || '');
        const flat = bodyText.replace(/\s+/gu, ' ');
        const ok = query.source ? new RegExp(query.source, query.flags).test(flat) : (bodyText.includes(A1) || flat.includes(query.text));
        result = { verified: ok, want: A1, url: page.url() };
        if (!ok) process.exitCode = 1;
        break;
      }
      case 'waittext': {
        result = { appeared: A1, ...(await web.waitText(scope, A1, { timeout, gone: Boolean(options.gone) })) };
        break;
      }
      case 'waitsel': {
        if (options.count !== undefined) {
          const wanted = Number(options.count);
          const count = await web.waitFor(async () => {
            const now = await scope.locator(A1).count();
            return now >= wanted ? now : 0;
          }, { timeout, message: `선택자 개수가 ${wanted}개가 되지 않았습니다: ${A1}` });
          result = { selector: A1, count };
        } else {
          await scope.locator(A1).first().waitFor({ state: options.state || 'visible', timeout });
          result = { selector: A1, state: options.state || 'visible' };
        }
        break;
      }
      case 'waiturl': {
        await page.waitForURL((current) => tabMatches(current.href, A1), { timeout });
        result = { url: page.url() };
        break;
      }
      case 'validate': {
        result = await web.validateForm(scope, A1 || '');
        if (!result.ok) process.exitCode = 1;
        break;
      }
      case 'frames': {
        result = { url: page.url(), frames: web.listFrames(page) };
        break;
      }
      case 'inspect': {
        const file = options.out ? outputPath(options.out) : join(shotsDir, 'web', `inspect_${stamp()}.json`);
        if (options.aria) {
          const snap = await web.ariaSnapshot(scope, { within: options.within || A1 || null, maxChars: Number(options.maxChars || 60000) });
          writeArtifact(file.replace(/\.json$/u, '.yaml'), snap.snapshot);
          result = { url: page.url(), aria: true, chars: snap.chars, truncated: snap.truncated, file: file.replace(/\.json$/u, '.yaml'), snapshot: snap.snapshot.slice(0, Number(options.printChars || 15000)) };
        } else if (options.frame === 'all') {
          const frames = [];
          for (const [index, frame] of page.frames().entries()) {
            try {
              const data = await web.inspectPage(frame, { within: options.within || A1 || null, limit: Number(options.limit || 80) });
              if (!data.error) frames.push({ index, frameUrl: frame.url().slice(0, 200), ...data });
            } catch (error) {
              frames.push({ index, frameUrl: frame.url().slice(0, 200), error: String(error?.message || error).slice(0, 120) });
            }
          }
          writeArtifact(file, frames);
          result = { url: page.url(), file, frames };
        } else {
          const data = await web.inspectPage(scope, { within: options.within || A1 || null, limit: Number(options.limit || 150), includeHidden: Boolean(options.includeHidden) });
          if (data.error) throw new Error(`범위 선택자를 찾지 못했습니다: ${options.within || A1}`);
          writeArtifact(file, data);
          result = { file, ...data, modals: await web.visibleModals(scope).catch(() => []) };
        }
        break;
      }
      case 'modals': {
        result = { url: page.url(), modals: await web.visibleModals(scope) };
        break;
      }
      case 'session': {
        result = await web.sessionState(scope, { identity: A1 || options.identity || null });
        if (options.require && result.status !== options.require) process.exitCode = 1;
        break;
      }
      case 'table': {
        const rows = await web.readTable(scope, A1 || 'table', { maxRows: Number(options.maxRows || 2000) });
        const file = options.out ? outputPath(options.out) : '';
        if (file) {
          const csv = rows.map((row) => row.map((cell) => (/[",\n]/u.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell)).join(',')).join('\n');
          writeArtifact(file, file.toLowerCase().endsWith('.json') ? rows : `﻿${csv}\n`);
        }
        result = { selector: A1 || 'table', rows: rows.length, data: rows.slice(0, Number(options.limit || 200)), ...(file ? { file } : {}) };
        break;
      }
      case 'net': {
        const match = A1 || options.match || '';
        let during = null;
        if (options.click) during = () => web.clickSelector(scope, options.click, { timeout });
        else if (options.clicktext) during = () => web.clickText(scope, options.clicktext, { exact: Boolean(options.exact), nth: Number(options.nth || 0), first: Boolean(options.first), timeout });
        else if (options.reload) during = () => page.reload({ timeout: Math.max(timeout, 30000), waitUntil: 'domcontentloaded' });
        if (during) phase = 'acting';
        const seconds = Number(options.seconds ?? (during ? 3 : 10));
        const entries = await web.captureResponses(page, { match, during, durationMs: seconds * 1000, max: Number(options.max || 50), bodies: Boolean(options.bodies), stopAfter: options.untilFirst ? 1 : 0 });
        const file = options.out ? outputPath(options.out) : join(shotsDir, 'web', `net_${stamp()}.json`);
        writeArtifact(file, entries);
        result = { match, seconds, count: entries.length, file, responses: web.summarizeResponses(entries) };
        break;
      }
      case 'fetch': {
        const method = String(options.method || 'GET').toUpperCase();
        if (!['GET', 'HEAD'].includes(method) && !options.write) {
          throw new Error('GET이 아닌 요청은 데이터를 바꿀 수 있습니다. 사용자가 요청한 변경이면 --write를 붙여 다시 실행하세요.');
        }
        if (isWrite) phase = 'acting';
        const response = await web.fetchInPage(scope, A1, { method, body: options.body, headers: options.headers || {}, timeout: Math.max(timeout, 30000) });
        const file = options.out ? outputPath(options.out) : join(shotsDir, 'web', `fetch_${stamp()}.json`);
        writeArtifact(file, response);
        const payload = response.json !== null ? JSON.stringify(response.json) : (response.text || '');
        const maxChars = Number(options.maxChars || 20000);
        const { json, text: bodyText, ok: httpOk, ...meta } = response;
        result = { ...meta, httpOk, file, ...(payload.length <= maxChars ? (json !== null ? { json } : { text: bodyText }) : { preview: payload.slice(0, maxChars), truncated: true }) };
        if (!response.ok || response.loginSuspected) process.exitCode = 1;
        break;
      }
      case 'download': {
        const target = options.out ? { file: outputPath(options.out) } : { dir: join(shotsDir, 'downloads') };
        let saved;
        phase = 'acting';
        if (options.click || options.clicktext) {
          const trigger = options.click
            ? () => web.clickSelector(scope, options.click, { timeout })
            : () => web.clickText(scope, options.clicktext, { exact: Boolean(options.exact), nth: Number(options.nth || 0), first: Boolean(options.first), timeout });
          saved = await web.downloadVia(page, trigger, target, { timeout: Math.max(timeout, 60000) });
        } else if (A1) {
          const holder = await context.newPage();
          try {
            saved = await web.downloadVia(holder, () => holder.goto(A1, { timeout: Math.max(timeout, 60000) }).catch(() => {}), target, { timeout: Math.max(timeout, 60000) });
          } finally {
            await holder.close().catch(() => {});
          }
        } else {
          throw new Error('다운로드 주소나 --click / --clicktext 대상이 필요합니다.');
        }
        result = saved;
        verified = saved.kind !== 'html';
        break;
      }
      case 'window': {
        const state = await web.normalizeWindow(page, { maximize: A1 === 'maximize' });
        if (!state.ok) throw new Error(`Chrome 창 상태를 바꾸지 못했습니다: ${state.error}`);
        const { ok: windowOk, ...windowState } = state;
        result = windowState;
        break;
      }
      case 'identify': {
        await page.evaluate((label) => {
          document.getElementById('computer-use-cdp-identity')?.remove();
          const badge = document.createElement('div');
          badge.id = 'computer-use-cdp-identity';
          badge.textContent = label;
          Object.assign(badge.style, {
            position: 'fixed', top: '12px', right: '12px', zIndex: '2147483647',
            padding: '10px 14px', background: '#106b4f', color: '#fff',
            border: '2px solid #fff', borderRadius: '6px', font: '600 14px sans-serif',
            boxShadow: '0 4px 16px rgba(0,0,0,.3)',
          });
          document.documentElement.appendChild(badge);
        }, A1 || `Computer-Use 자동화 Chrome · ${profile} · 연결 ${port}`);
        result = { identified: true, url: page.url() };
        break;
      }
      case 'shot': {
        evidence = await screenshot(page, A1 || out, { fullPage: Boolean(options.full), selector: options.selector || null, scope });
        result = { file: evidence, url: page.url() };
        break;
      }
      case 'script': {
        if (!A1) throw new Error('실행할 스크립트 파일 경로가 없습니다.');
        const scriptPath = isAbsolute(A1) ? A1 : resolve(A1);
        if (!existsSync(scriptPath)) throw new Error(`스크립트 파일이 없습니다: ${scriptPath}`);
        const sha256 = createHash('sha256').update(readFileSync(scriptPath)).digest('hex');
        const mod = await import(`${pathToFileURL(scriptPath).href}?v=${sha256.slice(0, 12)}`);
        const meta = mod.meta || {};
        const run = typeof mod.default === 'function' ? mod.default : (typeof mod.run === 'function' ? mod.run : null);
        if (!run) throw new Error('스크립트는 export default async function ({ page, helpers, args }) 형태여야 합니다.');
        // 쓰기 여부 선언: export const mode = 'read' 또는 meta.writes = false. 선언이 없으면 쓰기로 본다.
        const declaredWrites = mod.mode ? mod.mode !== 'read' : meta.writes !== false;
        if (dryRun) {
          if (!(meta.supportsDryRun || mod.supportsDryRun)) throw new Error('이 스크립트는 dry-run을 지원한다고 선언하지 않았습니다(meta.supportsDryRun = true). dry-run 없이 실행하려면 --write가 필요합니다.');
        } else if (declaredWrites && !options.write) {
          throw new Error('이 스크립트는 화면이나 데이터를 바꿀 수 있습니다(쓰기 선언). 사용자가 요청한 변경이면 --write를 붙여 다시 실행하세요. 읽기만 한다면 export const mode = \'read\'를 선언하세요.');
        }
        const allowed = Array.isArray(meta.allowedDomains) && meta.allowedDomains.length ? meta.allowedDomains : (Array.isArray(options.allowedDomains) ? options.allowedDomains : null);
        if (allowed && !isBlankish(page.url()) && !domainAllowed(page.url(), allowed)) {
          throw new Error(`스크립트 허용 도메인 밖의 탭입니다: ${withoutQuery(page.url())} (허용: ${allowed.join(', ')})`);
        }
        const logs = [];
        const shotPages = [];
        for (const key of ['__shotPage', '__shotPath', '__noShot', '__fullPage']) globalThis[key] = undefined;
        const scriptContext = {
          browser,
          context,
          ctx: context,
          page,
          frame: scope,
          pages: livePages(),
          args: Array.isArray(options.args) ? options.args.map(String) : [],
          params: options.params || {},
          dryRun,
          helpers: web.helpers,
          h: web.helpers,
          log: (...parts) => { logs.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ').slice(0, 500)); },
          evidence: (shotTarget) => { if (shotTarget) shotPages.push(shotTarget); },
        };
        phase = dryRun ? 'prepare' : 'acting';
        const scriptTimeout = Number(options.scriptTimeout || meta.timeoutMs || 180000);
        let returned;
        try {
          returned = await withTimeout(Promise.resolve(run(scriptContext)), scriptTimeout, `스크립트가 ${scriptTimeout}ms 안에 끝나지 않았습니다.`);
        } finally {
          // 예전 스니펫 호환: __shotPage / __shotPath / __fullPage / __noShot
          const shotPage = shotPages.at(-1) || globalThis.__shotPage || page;
          if (globalThis.__noShot) options.noShot = true;
          if (!options.noShot && shotPage && !shotPage.isClosed?.()) {
            const shotFile = globalThis.__shotPath ? outputPath(globalThis.__shotPath) : spec.evidenceOut;
            evidence = await screenshot(shotPage, shotFile, { fullPage: Boolean(globalThis.__fullPage || options.full) }).catch(() => null);
          }
          if (options.newTab && !options.keepTab && !page.isClosed()) await page.close({ runBeforeUnload: false }).catch(() => {});
        }
        const finalPage = shotPages.at(-1) || globalThis.__shotPage || page;
        const finalUrl = finalPage && !finalPage.isClosed?.() ? finalPage.url() : (page.isClosed() ? '' : page.url());
        result = {
          script: basename(scriptPath),
          sha256,
          writes: declaredWrites,
          ...(dryRun ? { dryRun: true } : {}),
          ...clip(returned, join(shotsDir, 'web', `script_${stamp()}.json`)),
          logs: logs.slice(-50),
          url: withoutQuery(finalUrl),
        };
        if (returned && typeof returned === 'object' && returned.ok === false) process.exitCode = 1;
        if (allowed && finalUrl && !isBlankish(finalUrl) && !domainAllowed(finalUrl, allowed)) {
          result.domainViolation = withoutQuery(finalUrl);
          process.exitCode = 1;
        }
        break;
      }
      case 'handoff': {
        // 로그인·MFA·CAPTCHA는 사람이 이 창에서 직접 한다. 자동화는 창을 앞에 띄우고 끝날 때까지 기다린다.
        const reason = A1 || options.reason || '로그인·인증을 이 창에서 직접 완료해 주세요';
        const limit = Number(options.timeout || 600000);
        await web.normalizeWindow(page);
        await page.bringToFront();
        const banner = () => page.evaluate((label) => {
          if (document.getElementById('computer-use-handoff')) return;
          const box = document.createElement('div');
          box.id = 'computer-use-handoff';
          box.textContent = `사람 확인 필요 · ${label}`;
          Object.assign(box.style, {
            position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)', zIndex: '2147483647',
            padding: '12px 18px', background: '#b54708', color: '#fff', border: '2px solid #fff', borderRadius: '8px',
            font: '600 15px sans-serif', boxShadow: '0 6px 20px rgba(0,0,0,.35)', pointerEvents: 'none',
          });
          document.documentElement.appendChild(box);
        }, reason).catch(() => {});
        const started = Date.now();
        let state = null;
        for (;;) {
          await banner();
          state = await web.sessionState(page, { identity: options.identity || null }).catch(() => null);
          const urlOk = options.untilUrl ? tabMatches(page.url(), options.untilUrl) : true;
          const textOk = options.untilText ? await page.evaluate((wanted) => (document.body?.innerText || '').includes(wanted), options.untilText).catch(() => false) : true;
          const sessionOk = options.identity ? state?.status === 'LOGGED_IN' : Boolean(state && state.status !== 'LOGIN_WALL');
          if (urlOk && textOk && sessionOk) break;
          if (Date.now() - started > limit) {
            const late = new Error(`사람 확인을 ${Math.round(limit / 1000)}초 동안 기다렸지만 끝나지 않았습니다. 창에서 완료한 뒤 다시 실행하세요.`);
            late.code = 'handoff_timeout';
            throw late;
          }
          await web.sleep(3000);
        }
        await page.evaluate(() => document.getElementById('computer-use-handoff')?.remove()).catch(() => {});
        result = { handedOff: true, waitedMs: Date.now() - started, status: state?.status || null, url: withoutQuery(page.url()) };
        break;
      }
      case 'dismiss': {
        phase = 'acting';
        result = await web.dismissTopModal(scope);
        if (!result.dismissed) process.exitCode = 1;
        break;
      }
      case 'collect': {
        if (!A1) throw new Error('수집할 항목 선택자가 필요합니다. 예: collect ".item" --field 이름=.title --key @data-id');
        const fields = {};
        for (const pair of [].concat(options.field || [])) {
          const at = String(pair).indexOf('=');
          if (at <= 0) throw new Error(`--field는 이름=선택자[@속성] 형식이어야 합니다: ${pair}`);
          fields[String(pair).slice(0, at)] = String(pair).slice(at + 1);
        }
        const data = await web.collectWhileScrolling(scope, { item: A1, fields, key: options.key || null, container: options.selector || null, stepPx: Number(options.px || 700), maxSteps: Number(options.maxSteps || 40), waitMs: Number(options.waitMs || 700), max: Number(options.max || 5000), wheel: Boolean(options.wheel) });
        const file = options.out ? outputPath(options.out) : join(shotsDir, 'web', `collect_${stamp()}.json`);
        if (file.toLowerCase().endsWith('.csv')) {
          const keys = [...new Set(data.items.flatMap((row) => Object.keys(row)))];
          const cell = (item) => { const text = String(item ?? ''); return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text; };
          writeArtifact(file, `\uFEFF${[keys.join(','), ...data.items.map((row) => keys.map((key) => cell(row[key])).join(','))].join('\n')}\n`);
        } else {
          writeArtifact(file, data.items);
        }
        result = { item: A1, count: data.count, steps: data.steps, reachedEnd: data.reachedEnd, truncated: data.truncated, file, sample: data.items.slice(0, Number(options.limit || 20)) };
        if (!data.reachedEnd && !data.truncated) result.warning = '목록 끝에 닿기 전에 단계 상한에 걸렸습니다. --max-steps를 늘리세요.';
        break;
      }
      case 'capture': {
        // 사람이 보는 탭을 건드리지 않게 새 탭에서 폭별 전체 화면을 찍고 manifest를 남긴다.
        const targetUrl = A1 || page.url();
        const widths = String(options.widths || '1280').split(',').map((item) => Number(item.trim())).filter((item) => item >= 200 && item <= 4000);
        if (!widths.length) throw new Error('--widths는 200~4000 사이 숫자 목록이어야 합니다. 예: --widths 390,1280');
        const dpr = Number(options.dpr || 1);
        const dir = options.out ? outputPath(options.out) : join(shotsDir, 'web', `capture_${stamp()}`);
        mkdirSync(dir, { recursive: true });
        const shotPage = await context.newPage();
        const session = await context.newCDPSession(shotPage);
        const shots = [];
        try {
          for (const width of widths) {
            const height = Number(options.height || 900);
            await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: width < 600 });
            await shotPage.goto(targetUrl, { timeout: Math.max(timeout, 45000), waitUntil: options.waitUntil || 'load' });
            if (options.waitText) await web.waitText(shotPage, options.waitText, { timeout });
            await shotPage.waitForTimeout(Number(options.settleMs ?? 800));
            const meta = await web.primeForCapture(shotPage, { hideFixed: Boolean(options.hideFixed) });
            const file = join(dir, `w${width}${dpr !== 1 ? `@${dpr}x` : ''}.png`);
            await shotPage.screenshot({ path: file, fullPage: !options.viewportOnly, animations: 'disabled', timeout: 90000 });
            const check = await web.auditPage(shotPage, { checks: ['images', 'overflow'] });
            shots.push({ width, dpr, file, cssHeight: meta.cssHeight, landedUrl: withoutQuery(meta.url), sha256: sha256File(file), problems: check.failures.map((item) => `${item.check}:${item.count}`) });
          }
        } finally {
          await session.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
          await session.detach().catch(() => {});
          if (!options.keepTab) await shotPage.close().catch(() => {});
        }
        writeArtifact(join(dir, 'manifest.json'), { schema: 'computer-use.web-capture.v1', url: withoutQuery(targetUrl), capturedAt: new Date().toISOString(), shots });
        result = { dir, manifest: join(dir, 'manifest.json'), shots };
        break;
      }
      case 'pageaudit': {
        const checks = String(options.checks || 'images,overflow,tiny-text,console,requests').split(',').map((item) => item.trim()).filter(Boolean);
        let auditTarget = page;
        let auditContext = null;
        const consoleErrors = [];
        const failedRequests = [];
        const own = Boolean(A1 || options.isolated || options.reload);
        if (own) {
          // 새 탭(--isolated면 로그인 없는 별도 창)에서 다시 열며 콘솔 오류와 실패한 요청을 모은다.
          auditContext = options.isolated ? await browser.newContext() : context;
          auditTarget = await auditContext.newPage();
          auditTarget.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200)); });
          auditTarget.on('requestfailed', (request) => failedRequests.push({ url: withoutQuery(request.url()), error: request.failure()?.errorText || '' }));
          auditTarget.on('response', (response) => { if (response.status() >= 400) failedRequests.push({ url: withoutQuery(response.url()), status: response.status() }); });
          if (options.width) await auditTarget.setViewportSize({ width: Number(options.width), height: 900 });
          await auditTarget.goto(A1 || page.url(), { timeout: Math.max(timeout, 45000), waitUntil: 'load' });
          await auditTarget.waitForTimeout(800);
          await web.primeForCapture(auditTarget);
        }
        const report = await web.auditPage(auditTarget, { checks, minFontPx: Number(options.minFont || 11) });
        if (checks.includes('console') && consoleErrors.length) report.failures.push({ check: 'console', count: consoleErrors.length, sample: consoleErrors.slice(0, 10) });
        if (checks.includes('requests') && failedRequests.length) report.failures.push({ check: 'requests', count: failedRequests.length, sample: failedRequests.slice(0, 10) });
        if (own) {
          await auditTarget.close().catch(() => {});
          if (options.isolated) await auditContext.close().catch(() => {});
        }
        result = { url: withoutQuery(A1 || page.url()), status: report.failures.length ? 'FAIL' : 'PASS', checks, failures: report.failures, ...(own ? {} : { note: '콘솔 오류와 실패한 요청은 주소를 주거나 --reload를 붙일 때만 모읍니다.' }) };
        if (report.failures.length) process.exitCode = 1;
        break;
      }
      default:
        throw new Error(`지원하지 않는 브라우저 작업입니다: ${action}`);
    }

    // 쓰기 뒤에는 늦게 뜨는 확인창·요청·모달·토스트를 잡을 시간을 둔 뒤 관찰한다.
    let observed = null;
    let modalAction = null;
    if (actsForReal && page && !page.isClosed() && action !== 'script') {
      phase = 'after';
      await page.waitForTimeout(Number(options.settleMs ?? 700)).catch(() => {});
      if (options.modalConfirm) {
        // 화면 안 확인 모달은 문구가 기대와 맞을 때만 그 모달 안의 버튼을 누른다.
        const rule = new RegExp(options.modalConfirm, 'u');
        const shown = await web.visibleModals(scope).catch(() => []);
        const match = shown.find((item) => rule.test(item.text));
        if (match) {
          const pressed = await web.clickText(scope, options.modalButton || '확인', { exact: true, within: `[data-cu-modal="${match.index}"]`, timeout });
          modalAction = { confirmed: true, modal: match.text.slice(0, 160), button: pressed.clicked.label };
          await page.waitForTimeout(Number(options.settleMs ?? 700)).catch(() => {});
        } else {
          modalAction = { confirmed: false, reason: shown.length ? 'unexpected_modal' : 'no_modal', modals: shown.map((item) => item.text.slice(0, 160)) };
          process.exitCode = 1;
        }
      }
      const signals = await web.pageSignals(scope).catch(() => ({ alerts: [], errors: [] }));
      const toasts = await web.stopToastWatch(scope);
      const modalsAfter = (await web.visibleModals(scope).catch(() => [])).map((item) => item.text);
      observed = {
        urlChanged: before ? withoutQuery(before.url) !== withoutQuery(page.url()) : false,
        newModals: modalsAfter.filter((text) => !before?.modals.includes(text)).map((text) => text.slice(0, 200)),
        toasts,
        alerts: signals.alerts,
        errors: signals.errors,
      };
    }
    const expectations = {};
    if (options.expect) {
      try {
        await web.waitText(scope, options.expect, { timeout: Number(options.expectTimeout || timeout) });
        expectations.expect = true;
      } catch {
        expectations.expect = false;
      }
    }
    if (options.expectGone) {
      try {
        await web.waitText(scope, options.expectGone, { timeout: Number(options.expectTimeout || timeout), gone: true });
        expectations.expectGone = true;
      } catch {
        expectations.expectGone = false;
      }
    }
    if (options.expectUrl) {
      try {
        await page.waitForURL((current) => tabMatches(current.href, options.expectUrl), { timeout: Number(options.expectTimeout || timeout) });
        expectations.expectUrl = true;
      } catch {
        expectations.expectUrl = false;
      }
    }
    const expectationKeys = Object.keys(expectations);
    const expectationsMet = expectationKeys.every((key) => expectations[key]);
    if (expectationKeys.length && !expectationsMet) process.exitCode = 1;

    let evidenceLatest = null;
    if (page && EVIDENCE_ACTIONS.has(action) && !evidence && !options.noShot && !page.isClosed()) {
      evidence = await screenshot(page, spec.evidenceOut, { fullPage: Boolean(options.full) }).catch(() => null);
      // 같은 web_last.png를 여러 작업이 덮어쓰므로 작업마다 고유한 증거 파일도 남긴다.
      if (evidence) {
        const unique = join(shotsDir, 'web', 'evidence', `${stamp()}_${profile}_${action}.png`);
        try {
          mkdirSync(dirname(unique), { recursive: true });
          copyFileSync(evidence, unique);
          evidenceLatest = evidence;
          evidence = unique;
        } catch {}
      }
    }
    dialogs?.dispose();
    writes?.dispose();
    popups?.dispose();

    const refused = web.dismissedDecisions(dialogLog);
    if (FAIL_ON_DISMISSED.has(action) && refused.length) process.exitCode = 1;
    let outcome;
    let hint;
    if (isWrite) {
      if (dryRun) outcome = 'not_done';
      else if (refused.length && !writeLog.length) outcome = 'not_done';
      else if (refused.length || (expectationKeys.length && !expectationsMet) || verified === false || (modalAction && !modalAction.confirmed)) outcome = 'unknown';
      else if (observed?.newModals.length && !modalAction) {
        outcome = 'unknown';
        hint = '작업 뒤 새 모달이 떴습니다. 확인 단계가 남았을 수 있습니다. 내용을 보고 --modal-confirm "문구"로 다시 하거나 dismiss로 닫으세요.';
      } else outcome = 'done';
      if (outcome === 'unknown' && verified === false && !expectationKeys.length && !refused.length) process.exitCode = 1;
    }
    if (actsForReal && options.idemKey) recordIdempotent(String(options.idemKey), outcome, { url: withoutQuery(page?.url()) });

    const selectedTargetId = action === 'pages' || !page || page.isClosed() ? '' : await pageTargetId(context, page).catch(() => '');
    const ok = process.exitCode !== 1;
    const report = {
      port: Number(port),
      ...(profile !== 'default' ? { profile } : {}),
      ...result,
      ...(selectedTargetId ? { targetId: selectedTargetId, targetUrl: page.url() } : {}),
      ...(evidence ? { evidence } : {}),
      ...(evidenceLatest ? { evidenceLatest } : {}),
      ...(options.frame ? { frame: options.frame } : {}),
      ...(labelHit ? { label: options.label } : {}),
      ...(observed ? { observed } : {}),
      ...(modalAction ? { modal: modalAction } : {}),
      ...(hint ? { hint } : {}),
      ...(dialogLog.length ? { dialogs: dialogLog } : {}),
      ...(refused.length ? { error: `확인창을 ${refused.length}건 취소했습니다("${refused[0].message.slice(0, 80)}"). 의도한 변경이면 --confirm-dialog "문구"로 그 확인창만 수락해 다시 실행하세요.`, code: 'dialog_dismissed' } : {}),
      ...(writeLog.length ? { writeRequests: writeLog.slice(0, 20) } : {}),
      ...(popupLog.length ? { popups: popupLog.map(({ page: popupPage, ...rest }) => rest) } : {}),
      ...(expectationKeys.length ? { expectations } : {}),
      ...(outcome ? { outcome } : {}),
    };
    // 결과 안의 ok(예: 폼 검사)가 실행 판정을 덮지 않도록 마지막에 맞춘다. 실패는 데이터 키 없이 끝난다.
    const finalReport = { ok, ...report };
    finalReport.ok = ok;
    emit(finalReport);
    audit({ ok, outcome, target: withoutQuery(page?.url()), evidence, code: report.code, idemKey: options.idemKey || undefined, script: result.sha256 || undefined, dialogs: dialogLog.length || undefined, writeRequests: writeLog.length || undefined });
  } catch (error) {
    // 대상 찾기·모호함·덮임·중복 같은 실패는 실제 조작 전에 멈춘 것이다.
    const beforeAction = ['ambiguous', 'covered', 'not_found', 'disabled', 'not_empty', 'no_target', 'duplicate', 'busy', 'stopped', 'file_missing', 'secret_field'].includes(error?.code);
    const outcome = isWrite ? ((dryRun || phase === 'prepare' || beforeAction) ? 'not_done' : 'unknown') : undefined;
    if (actsForReal && options.idemKey && outcome === 'unknown') recordIdempotent(String(options.idemKey), outcome, { error: String(error?.message || error).slice(0, 200) });
    const report = {
      ok: false,
      error: String(error?.message || error).slice(0, 1200),
      ...(error?.code && typeof error.code === 'string' ? { code: error.code } : {}),
      ...(error?.candidates ? { candidates: error.candidates.map(({ hit, ...rest }) => rest) } : {}),
      ...(error?.coveredBy ? { coveredBy: error.coveredBy } : {}),
      ...(action === 'script' && error?.stack ? { stack: String(error.stack).split('\n').slice(0, 12).join('\n') } : {}),
      ...(outcome ? { outcome } : {}),
      ...(dialogLog.length ? { dialogs: dialogLog } : {}),
      ...(writeLog.length ? { writeRequests: writeLog.slice(0, 20) } : {}),
    };
    emit(report);
    audit({ ok: false, outcome, code: report.code, error: report.error.slice(0, 200) });
    process.exitCode = 1;
  } finally {
    if (releaseLock) releaseLock();
    if (browser) await browser.close().catch(() => {});
  }
}

if (action === 'ping' || action === 'health') await runProbe();
else await runMain();
