#!/usr/bin/env node
// computer-use 통합 명령. AI 에이전트가 Windows PowerShell·cmd·Git Bash·WSL 어디서나 같은 명령으로
// 웹(보이는 Windows Chrome)과 모든 데스크톱 앱(UIA·창 핸들·화면 인식)을 보고 조작하고 검증한다.
// 결과는 한 줄 JSON이다. 실패는 ok:false와 이유를 돌려주고 0이 아닌 종료 코드로 끝난다.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPathConfig, wslPathToWindows } from './lib/path_config.mjs';

const scriptsDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const config = loadPathConfig();
const isWin = process.platform === 'win32';
const stateLocal = isWin ? config.stateDirWin : config.stateDirWsl;
const stateWin = config.stateDirWin;

const BOOLEAN_FLAGS = new Set([
  'exact', 'contains', 'first', 'double', 'force', 'full', 'aria', 'gone', 'new-tab', 'keep-tab', 'write', 'repeat', 'wheel',
  'close-hung', 'include-hidden', 'require-empty', 'no-shot', 'no-front', 'reload', 'all', 'restore', 'relative', 'right',
  'no-autostart', 'json', 'screen', 'help', 'show-query', 'raw', 'dry-run', 'allow-secret', 'numeric', 'bodies',
  'until-first', 'hide-fixed', 'viewport-only', 'isolated', 'no-ocr',
]);
const REPEATABLE = new Set(['header', 'arg', 'param', 'allowed-domain', 'title', 'file', 'field']);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (item === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (!item.startsWith('--') || item === '--') {
      positional.push(item);
      continue;
    }
    let name = item.slice(2);
    let value;
    const eq = name.indexOf('=');
    if (eq >= 0) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    } else if (BOOLEAN_FLAGS.has(name)) {
      value = true;
    } else {
      value = argv[index + 1];
      if (value === undefined) throw usageError(`--${name}에 값이 필요합니다.`);
      index++;
    }
    if (REPEATABLE.has(name)) (flags[name] ||= []).push(value);
    else flags[name] = value;
  }
  return { positional, flags };
}

function usageError(message) {
  const error = new Error(message);
  error.code = 'usage';
  return error;
}

function print(value) {
  console.log(JSON.stringify(value));
}

function fail(error, extra = {}) {
  print({ ok: false, error: String(error?.message || error), ...(error?.code ? { code: error.code } : {}), ...extra });
  return error?.code === 'usage' ? 2 : 1;
}

function toWinPath(file) {
  const value = String(file || '').trim();
  if (!value) return '';
  if (/^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\')) return value;
  const absolute = isAbsolute(value) ? value : resolve(process.cwd(), value);
  return isWin ? absolute : wslPathToWindows(absolute);
}

function scriptPathWin(name) {
  return isWin ? join(scriptsDir, name) : `${config.scriptsDirWin}\\${name}`;
}

function tempFile(prefix, content, ext = 'json') {
  const dir = join(stateLocal, 'tmp');
  mkdirSync(dir, { recursive: true });
  const name = `${prefix}_${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.${ext}`;
  const local = join(dir, name);
  writeFileSync(local, content, 'utf8');
  return { local, win: isWin ? local : `${stateWin}\\tmp\\${name}`, cleanup: () => rmSync(local, { force: true }) };
}

function powershell(script, args, { sta = true, timeout = 180000 } = {}) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    ...(sta ? ['-STA'] : []),
    '-ExecutionPolicy', 'Bypass',
    '-File', scriptPathWin(script),
    ...args.map((item) => String(item)),
  ], { encoding: 'utf8', timeout, maxBuffer: 128 * 1024 * 1024, windowsHide: true });
  if (result.error && result.error.code === 'ENOENT') {
    throw new Error('powershell.exe를 찾지 못했습니다. Windows 또는 Windows에 연결된 WSL에서 실행하세요.');
  }
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout || '').replace(/\r/gu, ''),
    stderr: String(result.stderr || '').replace(/\r/gu, ''),
  };
}

function lastJson(text) {
  const lines = String(text || '').trim().split('\n').filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    try { return JSON.parse(lines[index]); } catch {}
  }
  return null;
}

function passthrough(result) {
  if (result.stdout) process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
  if (result.stderr.trim()) process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
  return result.status;
}

function runNode(script, args) {
  const result = spawnSync(process.execPath, [join(scriptsDir, script), ...args], { stdio: 'inherit', cwd: repoRoot });
  return result.status ?? 1;
}

function stopFile() {
  return join(stateLocal, 'STOP');
}

function setStatus(text) {
  try {
    mkdirSync(stateLocal, { recursive: true });
    writeFileSync(join(stateLocal, 'status.txt'), String(text).slice(0, 200), 'utf8');
  } catch {}
}

function refuseIfStopped() {
  if (existsSync(stopFile())) {
    const error = new Error('중지 파일(state\\STOP)이 있어 조작 명령을 거부합니다. 재개하려면 node scripts/cu.mjs resume');
    error.code = 'stopped';
    throw error;
  }
}

function camel(name) {
  return name.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
}

// ---------------------------------------------------------------------------
// 웹
// ---------------------------------------------------------------------------

const WEB_WRITE = new Set(['goto', 'reload', 'click', 'clicktext', 'type', 'setvalue', 'keys', 'select', 'pick', 'check', 'uncheck', 'upload', 'download', 'press', 'hover', 'scroll', 'identify', 'window', 'eval', 'script', 'dismiss']);
const WEB_PATH_OPTIONS = new Set(['out', 'value-file', 'body-file']);
const WEB_OPTION_SKIP = new Set(['url', 'profile', 'profile-dir', 'port', 'no-autostart', 'header', 'arg', 'param', 'allowed-domain', 'file', 'body', 'body-file', 'args', 'params', 'timeout-ms']);

function parseJsonOrText(value) {
  try { return JSON.parse(value); } catch { return value; }
}

function buildWebRequest(action, positional, flags) {
  let arg1 = positional[0] ?? '';
  let arg2 = positional[1] ?? '';
  let rest = positional.slice(2);
  const options = {};
  for (const [name, value] of Object.entries(flags)) {
    if (WEB_OPTION_SKIP.has(name)) continue;
    options[camel(name)] = WEB_PATH_OPTIONS.has(name) ? toWinPath(value) : value;
  }
  for (const key of ['nth', 'timeout', 'px', 'maxSteps', 'seconds', 'limit', 'max', 'maxChars', 'settleMs', 'expectTimeout', 'scriptTimeout', 'printChars', 'tabTimeoutMs', 'connectTimeout', 'maxRows', 'count', 'dpr', 'height', 'width', 'waitMs', 'minFont', 'watchdogMs']) {
    if (options[key] !== undefined) options[key] = Number(options[key]);
  }
  if (flags.header) {
    options.headers = {};
    for (const header of flags.header) {
      const at = header.indexOf(':');
      if (at <= 0) throw usageError(`--header는 "이름: 값" 형식이어야 합니다: ${header}`);
      options.headers[header.slice(0, at).trim()] = header.slice(at + 1).trim();
    }
  }
  if (flags.body !== undefined) options.body = parseJsonOrText(flags.body);
  if (flags['body-file']) options.body = parseJsonOrText(readFileSync(flags['body-file'], 'utf8'));
  if (flags['allowed-domain']) options.allowedDomains = flags['allowed-domain'];
  if (flags.args) options.args = JSON.parse(flags.args);
  if (flags.arg) options.args = [...(options.args || []), ...flags.arg];
  if (flags.params) options.params = JSON.parse(flags.params);
  if (flags.param) {
    options.params = { ...(options.params || {}) };
    for (const pair of flags.param) {
      const at = pair.indexOf('=');
      if (at <= 0) throw usageError(`--param은 이름=값 형식이어야 합니다: ${pair}`);
      options.params[pair.slice(0, at)] = pair.slice(at + 1);
    }
  }
  // 창 쪽 Node가 읽는 파일 경로는 Windows 경로로 바꾼다.
  if (action === 'upload') {
    const chooserMode = Boolean(flags.chooser || flags['chooser-text']);
    // 선택자 없이(파일 선택 창·라벨로) 고르면 위치 인자는 모두 파일이다.
    const filesOnly = chooserMode || Boolean(flags.label);
    const files = filesOnly ? [arg1, arg2, ...rest] : [arg2, ...rest];
    const extra = flags.file || [];
    const converted = [...files, ...extra].filter(Boolean).map(toWinPath);
    options.files = converted;
    if (filesOnly) { arg1 = ''; arg2 = ''; } else { arg2 = converted[0] || ''; }
    rest = [];
  } else if (action === 'script') {
    arg1 = toWinPath(arg1);
    if (rest.length || arg2) options.args = [...(options.args || []), ...[arg2, ...rest].filter((item) => item !== '')];
    arg2 = '';
    rest = [];
  } else if (action === 'shot' && arg1) {
    arg1 = toWinPath(arg1);
  }
  if (rest.length) options.rest = rest;
  const request = { action, arg1, arg2, options };
  if (flags.url) request.url = flags.url;
  if (flags.profile) request.profile = flags.profile;
  if (flags['profile-dir']) request.profileDir = flags['profile-dir'];
  return request;
}

function runWeb(positional, flags) {
  const action = positional[0] || 'pages';
  const rest = positional.slice(1);
  if (action === 'profile') {
    const sub = rest[0] || 'list';
    if (sub === 'list') return passthrough(powershell('chrome_profiles.ps1', ['-Action', 'list', ...(flags['show-query'] ? ['-ShowQuery'] : [])]));
    if (!['add', 'remove'].includes(sub) || !rest[1]) throw usageError('사용: web profile add 이름 [--dir 폴더] [--port N] [--note 메모] | web profile remove 이름');
    const args = ['-Action', sub, '-Name', rest[1]];
    if (flags.dir) args.push('-Dir', flags.dir);
    if (flags.port) args.push('-Port', flags.port);
    if (flags.note) args.push('-Note', flags.note);
    return passthrough(powershell('chrome_profiles.ps1', args));
  }
  if (action === 'profiles') return passthrough(powershell('chrome_profiles.ps1', ['-Action', 'list', ...(flags['show-query'] ? ['-ShowQuery'] : [])]));
  if (WEB_WRITE.has(action)) refuseIfStopped();
  const request = buildWebRequest(action, rest, flags);
  const file = tempFile('web_req', JSON.stringify(request));
  try {
    setStatus(`web ${action}${flags.url ? ` @${flags.url}` : ''}`);
    const args = ['-Action', action, '-RequestFile', file.win, '-Port', String(flags.port || config.chromeCdpPort)];
    if (flags['no-autostart'] || process.env.CU_CHROME_CDP_AUTOSTART === '0') args.push('-NoAutoStart');
    const timeoutMs = Number(flags['timeout-ms'] || (action === 'script' ? 900000 : 300000));
    return passthrough(powershell('cu_web.ps1', args, { timeout: timeoutMs }));
  } finally {
    file.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 데스크톱
// ---------------------------------------------------------------------------

function parseTarget(token) {
  const value = String(token || '').trim();
  if (!value) throw usageError('대상이 필요합니다. 예: title:메모장, proc:notepad, pid:1234, hwnd:5678');
  const match = value.match(/^(proc|title|pid|hwnd):(.*)$/su);
  if (match) return { kind: match[1], value: match[2] };
  return { kind: 'proc', value };
}

function listWindows({ all = false } = {}) {
  const result = powershell('win32.ps1', ['-Cmd', 'list', ...(all ? ['-All'] : [])]);
  const parsed = lastJson(result.stdout);
  if (!parsed?.ok) throw new Error(`창 목록을 읽지 못했습니다: ${result.stderr || result.stdout}`.slice(0, 600));
  return parsed.windows;
}

function compact(window) {
  return { hwnd: window.hwnd, proc: window.proc, pid: window.pid, title: String(window.title || '').slice(0, 80), minimized: window.minimized };
}

// 대상 창을 하나로 고른다. 제목은 정확히 같은 창을 먼저 보고, 여러 개면 임의로 고르지 않는다.
function resolveWindow(token, flags = {}) {
  const target = parseTarget(token);
  const windows = listWindows({ all: target.kind === 'hwnd' || Boolean(flags.all) });
  let hits = [];
  if (target.kind === 'hwnd') {
    hits = windows.filter((window) => window.hwnd === Number(target.value));
    if (!hits.length) return { hwnd: Number(target.value), title: '', proc: '', pid: 0 };
  } else if (target.kind === 'pid') {
    hits = windows.filter((window) => window.pid === Number(target.value));
  } else if (target.kind === 'proc') {
    let regex;
    try { regex = new RegExp(target.value, 'iu'); } catch { throw usageError(`프로세스 정규식이 잘못됐습니다: ${target.value}`); }
    hits = windows.filter((window) => regex.test(window.proc));
  } else {
    hits = windows.filter((window) => window.title === target.value);
    if (!hits.length) {
      let regex = null;
      try { regex = new RegExp(target.value, 'u'); } catch {}
      hits = windows.filter((window) => (regex ? regex.test(window.title) : window.title.includes(target.value)));
    }
  }
  if (!hits.length) {
    const error = new Error(`대상 창을 찾지 못했습니다: ${token}. windows 명령으로 목록을 확인하세요.`);
    error.code = 'not_found';
    throw error;
  }
  const index = Number(flags.index || 0);
  if (index > 0) {
    if (!hits[index - 1]) throw Object.assign(new Error(`${index}번째 창이 없습니다(후보 ${hits.length}개).`), { code: 'not_found' });
    return hits[index - 1];
  }
  if (hits.length > 1 && !flags.first) {
    const error = new Error(`대상 창이 ${hits.length}개입니다. title:정확한제목 또는 hwnd:번호로 하나를 지정하거나 --index N을 쓰세요.`);
    error.code = 'ambiguous';
    error.candidates = hits.slice(0, 10).map(compact);
    throw error;
  }
  return hits[0];
}

function win32(args, options) {
  const result = powershell('win32.ps1', args, options);
  const parsed = lastJson(result.stdout);
  return { ...result, parsed };
}

function emitWin32(result) {
  if (result.parsed) print(result.parsed);
  else if (result.stdout.trim()) process.stdout.write(`${result.stdout.trim()}\n`);
  if (result.stderr.trim()) process.stderr.write(`${result.stderr.trim()}\n`);
  return result.status;
}

function captureWindow(window, out, flags = {}) {
  const file = out ? toWinPath(out) : `${config.shotsDirWin}\\window_${Date.now()}.png`;
  return win32(['-Cmd', 'capture', '-Hwnd', window.hwnd, '-Out', file, ...(flags.restore ? ['-Restore'] : [])]);
}

function ocrImage(fileWin, lang = 'ko') {
  const result = powershell('ocr_lines.ps1', [fileWin, lang]);
  let lines = null;
  try { lines = JSON.parse(result.stdout.trim().split('\n').filter(Boolean).at(-1) || '[]'); } catch {}
  if (!Array.isArray(lines)) throw new Error(`글자 인식에 실패했습니다: ${(result.stderr || result.stdout).slice(0, 400)}`);
  return lines;
}

function squash(text) {
  return String(text || '').replace(/\s+/gu, '');
}

// 한국어 OCR은 글자 사이에 공백을 넣는 일이 많아 공백을 빼고 비교한다. /정규식/도 받는다.
function ocrMatches(lines, query) {
  const raw = String(query || '');
  const regex = raw.match(/^\/(.+)\/([a-z]*)$/su);
  const compiled = regex ? new RegExp(regex[1], regex[2].replace(/g/gu, '')) : null;
  const wanted = squash(raw);
  const exact = [];
  const partial = [];
  for (const line of lines) {
    if (compiled) {
      if (compiled.test(line.text) || compiled.test(squash(line.text))) partial.push(line);
    } else if (squash(line.text) === wanted) exact.push(line);
    else if (squash(line.text).includes(wanted)) partial.push(line);
  }
  const hits = exact.length ? exact : partial;
  return hits.sort((a, b) => (Math.abs(a.y - b.y) > 8 ? a.y - b.y : a.x - b.x));
}

function locateText(window, text, flags) {
  const shot = captureWindow(window, '', flags);
  if (!shot.parsed?.file) throw new Error(`창 캡처 실패: ${JSON.stringify(shot.parsed || shot.stdout).slice(0, 300)}`);
  if (shot.parsed.ok === false && shot.parsed.code === 'minimized') throw Object.assign(new Error(shot.parsed.error), { code: 'minimized' });
  const lines = ocrImage(shot.parsed.file);
  const hits = ocrMatches(lines, text);
  return { shot: shot.parsed, lines, hits };
}

function pickHit(hits, text, flags) {
  if (!hits.length) throw Object.assign(new Error(`화면에서 글자를 찾지 못했습니다: ${text}`), { code: 'not_found' });
  const index = Number(flags.index || 0);
  if (index > 0) {
    if (!hits[index - 1]) throw Object.assign(new Error(`${index}번째 글자가 없습니다(후보 ${hits.length}개): ${text}`), { code: 'not_found' });
    return hits[index - 1];
  }
  if (hits.length > 1 && !flags.first) {
    const error = new Error(`글자가 화면에 ${hits.length}곳 있습니다. --index N으로 고르세요(위→아래, 왼쪽→오른쪽 순서).`);
    error.code = 'ambiguous';
    error.candidates = hits.slice(0, 10).map((line, at) => ({ index: at + 1, text: line.text, x: line.x, y: line.y }));
    throw error;
  }
  return hits[0];
}

function uia(cmd, window, extra = []) {
  return powershell('uia.ps1', [cmd, '-Hwnd', window.hwnd, ...extra]);
}

function queryFile(query) {
  return tempFile('uia_query', String(query ?? ''), 'txt');
}

function runDesktop(command, positional, flags) {
  switch (command) {
    case 'windows': {
      const windows = listWindows({ all: Boolean(flags.all) }).filter((window) => {
        if (flags.title && !new RegExp(flags.title, 'u').test(window.title)) return false;
        if (flags.proc && !new RegExp(flags.proc, 'iu').test(window.proc)) return false;
        return true;
      });
      print({ ok: true, count: windows.length, windows });
      return 0;
    }
    case 'fg':
    case 'foreground':
      return emitWin32(win32(['-Cmd', 'foreground']));
    case 'front': {
      refuseIfStopped();
      const window = resolveWindow(positional[0], flags);
      setStatus(`front ${window.title}`);
      return emitWin32(win32(['-Cmd', 'front', '-Hwnd', window.hwnd, ...(flags.force ? ['-Force'] : [])]));
    }
    case 'show': {
      refuseIfStopped();
      const window = resolveWindow(positional[0], { ...flags, all: true });
      return emitWin32(win32(['-Cmd', 'show', '-Hwnd', window.hwnd, '-State', positional[1] || 'restore']));
    }
    case 'children':
      return emitWin32(win32(['-Cmd', 'children', '-Hwnd', resolveWindow(positional[0], flags).hwnd]));
    case 'gettext':
      return emitWin32(win32(['-Cmd', 'gettext', '-Hwnd', resolveWindow(positional[0], flags).hwnd]));
    case 'vscroll': {
      refuseIfStopped();
      const window = resolveWindow(positional[0], flags);
      return emitWin32(win32(['-Cmd', 'vscroll', '-Hwnd', window.hwnd, '-Pos', positional[1] || 'bottom', '-Count', flags.count || 1]));
    }
    case 'see': {
      const window = resolveWindow(positional[0], flags);
      if (!flags.screen) return emitWin32(captureWindow(window, positional[1], flags));
      // 하드웨어 가속 창은 PrintWindow가 검게 나올 수 있다. 앞으로 가져와 화면 영역을 캡처한다.
      const front = win32(['-Cmd', 'front', '-Hwnd', window.hwnd]);
      if (!front.parsed?.ok) return emitWin32(front);
      const [left, top, right, bottom] = front.parsed.window.rect;
      const file = positional[1] ? toWinPath(positional[1]) : `${config.shotsDirWin}\\screen_window_${Date.now()}.png`;
      const result = powershell('capture_region.ps1', ['-X', left, '-Y', top, '-W', right - left, '-H', bottom - top, file], { sta: false });
      print({ ok: result.status === 0, file, rect: [left, top, right, bottom], mode: 'screen' });
      return result.status;
    }
    case 'screen': {
      const file = positional[0] ? toWinPath(positional[0]) : `${config.shotsDirWin}\\screen_${Date.now()}.png`;
      const result = powershell('capture_screen.ps1', [file], { sta: false });
      const match = result.stdout.match(/ORIGIN=(-?\d+),(-?\d+) SIZE=(\d+)x(\d+) FILE=(.+)/u);
      if (result.status !== 0 || !match) return fail(new Error(`화면 캡처 실패: ${(result.stderr || result.stdout).slice(0, 300)}`));
      print({ ok: true, file: match[5].trim(), origin: [Number(match[1]), Number(match[2])], size: [Number(match[3]), Number(match[4])] });
      return 0;
    }
    case 'ocr': {
      if (!positional[0]) throw usageError('사용: ocr <이미지 파일> [--match 글자|/정규식/] [--lang ko]');
      const lines = ocrImage(toWinPath(positional[0]), flags.lang || 'ko');
      const hits = flags.match ? ocrMatches(lines, flags.match) : lines;
      print({ ok: true, count: hits.length, lines: hits });
      return 0;
    }
    case 'tree':
    case 'read': {
      const window = resolveWindow(positional[0], flags);
      const extra = [];
      if (flags.depth) extra.push('-Depth', flags.depth);
      if (flags.view) extra.push('-View', flags.view);
      const result = uia(command, window, extra);
      if (flags.json) {
        print({ ok: result.status === 0, window: compact(window), lines: result.stdout.split('\n').filter(Boolean) });
        return result.status;
      }
      return passthrough(result);
    }
    case 'find':
    case 'assert':
    case 'invoke':
    case 'toggle':
    case 'focus':
    case 'settext': {
      if (command !== 'find' && command !== 'assert') refuseIfStopped();
      const window = resolveWindow(positional[0], flags);
      const query = queryFile(positional[1] ?? '');
      const files = [query];
      try {
        const extra = ['-QueryFile', query.win, '-By', flags.by || 'name'];
        if (flags.index) extra.push('-Index', Math.max(0, Number(flags.index) - 1));
        if (command === 'assert') {
          const expected = tempFile('uia_expected', String(positional[2] ?? ''), 'txt');
          files.push(expected);
          extra.push('-ExpectedFile', expected.win);
        }
        if (command === 'settext') {
          const text = flags['text-file'] ? { win: toWinPath(flags['text-file']) } : tempFile('uia_text', String(positional[2] ?? ''), 'txt');
          if (text.cleanup) files.push(text);
          extra.push('-TextFile', text.win);
        }
        setStatus(`${command} ${window.title}`);
        return passthrough(uia(command, window, extra));
      } finally {
        for (const file of files) file.cleanup?.();
      }
    }
    case 'click': {
      refuseIfStopped();
      const window = resolveWindow(positional[0], flags);
      const query = queryFile(positional[1] ?? '');
      try {
        setStatus(`click ${positional[1]} @ ${window.title}`);
        const result = uia('invoke', window, ['-QueryFile', query.win, '-By', flags.by || 'name', ...(flags.index ? ['-Index', Math.max(0, Number(flags.index) - 1)] : [])]);
        const line = result.stdout.trim().split('\n').at(-1) || '';
        if (/^OK /u.test(line)) {
          print({ ok: true, method: 'uia', detail: line });
          return 0;
        }
        const need = line.match(/^NEEDCLICK .* cx=(-?\d+) cy=(-?\d+)/u);
        if (need) {
          const clicked = win32(['-Cmd', 'click', '-Hwnd', window.hwnd, '-X', need[1], '-Y', need[2], ...(flags.double ? ['-Double'] : []), ...(flags.force ? ['-Force'] : [])]);
          if (clicked.parsed) clicked.parsed.method = 'uia-rect-mouse';
          return emitWin32(clicked);
        }
        if (/^NO MATCH/u.test(line) && !flags['no-ocr']) {
          const located = locateText(window, positional[1], flags);
          const hit = pickHit(located.hits, positional[1], flags);
          const [left, top] = located.shot.rect;
          const clicked = win32(['-Cmd', 'click', '-Hwnd', window.hwnd, '-X', left + hit.x + Math.round(hit.w / 2), '-Y', top + hit.y + Math.round(hit.h / 2), ...(flags.double ? ['-Double'] : []), ...(flags.force ? ['-Force'] : [])]);
          if (clicked.parsed) Object.assign(clicked.parsed, { method: 'ocr', text: hit.text });
          return emitWin32(clicked);
        }
        print({ ok: false, error: line || result.stderr.trim() || 'UIA 실행 실패', method: 'uia' });
        return 1;
      } finally {
        query.cleanup();
      }
    }
    case 'clicktext':
    case 'clickrel': {
      refuseIfStopped();
      const window = resolveWindow(positional[0], flags);
      const text = positional[1];
      if (!text) throw usageError(`사용: ${command} <대상> <글자>${command === 'clickrel' ? ' <dx> <dy>' : ''} [--index N] [--double]`);
      const located = locateText(window, text, flags);
      const hit = pickHit(located.hits, text, flags);
      const [left, top] = located.shot.rect;
      const dx = command === 'clickrel' ? Number(positional[2] || 0) : 0;
      const dy = command === 'clickrel' ? Number(positional[3] || 0) : 0;
      setStatus(`${command} ${text} @ ${window.title}`);
      const clicked = win32(['-Cmd', 'click', '-Hwnd', window.hwnd, '-X', left + hit.x + Math.round(hit.w / 2) + dx, '-Y', top + hit.y + Math.round(hit.h / 2) + dy, ...(flags.double ? ['-Double'] : []), ...(flags.force ? ['-Force'] : [])]);
      if (clicked.parsed) Object.assign(clicked.parsed, { method: 'ocr', text: hit.text, matches: located.hits.length });
      return emitWin32(clicked);
    }
    case 'vassert': {
      const window = resolveWindow(positional[0], flags);
      const located = locateText(window, positional[1], flags);
      const ok = located.hits.length > 0;
      print({ ok, verified: ok, want: positional[1], found: located.hits.slice(0, 5).map((line) => line.text), screenshot: located.shot.file });
      return ok ? 0 : 1;
    }
    case 'type': {
      refuseIfStopped();
      const window = resolveWindow(positional[0], flags);
      const text = flags['text-file'] ? { win: toWinPath(flags['text-file']) } : tempFile('type', String(positional[1] ?? ''), 'txt');
      try {
        setStatus(`type @ ${window.title}`);
        return emitWin32(win32(['-Cmd', 'type', '-Hwnd', window.hwnd, '-TextFile', text.win, ...(flags.force ? ['-Force'] : [])]));
      } finally {
        text.cleanup?.();
      }
    }
    case 'key': {
      refuseIfStopped();
      const window = resolveWindow(positional[0], flags);
      if (!positional[1]) throw usageError('사용: key <대상> <키>  예: "{ENTER}" "^a" "%{F4}"');
      setStatus(`key ${positional[1]} @ ${window.title}`);
      return emitWin32(win32(['-Cmd', 'key', '-Hwnd', window.hwnd, '-Keys', positional[1], ...(flags.force ? ['-Force'] : [])]));
    }
    case 'scroll': {
      refuseIfStopped();
      const window = resolveWindow(positional[0], flags);
      return emitWin32(win32(['-Cmd', 'wheel', '-Hwnd', window.hwnd, '-Dir', positional[1] || 'down', '-Count', positional[2] || 3, ...(flags.force ? ['-Force'] : [])]));
    }
    case 'wait': {
      const timeoutMs = Number(flags.timeout || 30000);
      const interval = Number(flags.interval || 1500);
      const deadline = Date.now() + timeoutMs;
      let last = null;
      for (;;) {
        try {
          const window = resolveWindow(positional[0], flags);
          if (!flags.text) {
            print({ ok: true, appeared: compact(window) });
            return 0;
          }
          const located = locateText(window, flags.text, flags);
          const present = located.hits.length > 0;
          if (present !== Boolean(flags.gone)) {
            print({ ok: true, window: compact(window), text: flags.text, gone: Boolean(flags.gone) });
            return 0;
          }
        } catch (error) {
          last = error;
          if (error.code === 'ambiguous') return fail(error, { candidates: error.candidates });
        }
        if (Date.now() >= deadline) return fail(new Error(`기다린 조건이 ${timeoutMs}ms 안에 맞지 않았습니다${last ? `: ${last.message}` : ''}`), { code: 'timeout' });
        spawnSync(process.execPath, ['-e', `setTimeout(()=>{}, ${interval})`]);
      }
    }
    case 'snapshot': {
      const titles = flags.title || [];
      if (!titles.length && !flags['titles-file']) throw usageError('사용: snapshot --title 창제목 [--title 다른제목] [--out 폴더] [--keep-days 14]');
      const list = flags['titles-file'] ? { win: toWinPath(flags['titles-file']) } : tempFile('snapshot_titles', titles.join('\n'), 'txt');
      try {
        const args = ['-Cmd', 'snapshot', '-TitlePatternFile', list.win];
        if (flags.out) args.push('-OutDir', toWinPath(flags.out));
        if (flags['keep-days']) args.push('-KeepDays', flags['keep-days']);
        return emitWin32(win32(args));
      } finally {
        list.cleanup?.();
      }
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------

function usage() {
  console.log(`computer-use 통합 명령 (AI 에이전트용, 결과는 JSON 한 줄)

  node scripts/cu.mjs <명령> [인자] [--옵션]

점검
  check | doctor                       패키지·Windows 연결·앱 준비 상태
  stop | resume | status               조작 중지 장치(state\\STOP)

웹 (보이는 Windows Chrome, 계정별 전용 프로필, --url 주소일부로 탭 지정)
  web pages|ping|health [--close-hung]|profiles
  web goto URL [--new-tab] | reload | read [--selector S] [--frame F|all] | frames | inspect [--aria] [--frame all]
  web find|clicktext 글자 [--exact|--contains] [--nth N] [--within S] [--frame F|auto] [--force]
  web click 선택자 | type|setvalue|keys 선택자 값 [--require-empty] [--counter S] [--numeric] | select 선택자 값
  web type 값 --label 화면라벨 (선택자 대신 라벨 글자로 칸 지정) | pick 선택자 항목 [--via keyboard]
  web check|uncheck 선택자 | upload 선택자 파일... | upload --chooser-text 글자 파일... | download [URL] --click S|--clicktext T [--out F]
  web press 키 | hover 선택자 | scroll down|up|bottom|top [--selector S] [--until-text T]
  web waittext 글자 [--gone] | waitsel 선택자 | waiturl 주소일부 | assert 글자 | validate 제출선택자
  web modals | dismiss | session [계정글자] | handoff "사람이 할 일" [--identity 계정글자] [--until-url 주소] [--timeout ms]
  web table [선택자] [--out F.csv] | collect 항목선택자 --field 이름=선택자[@속성] --key @data-id [--selector 스크롤영역]
  web net 주소일부 [--seconds N] [--clicktext T] [--until-first] [--bodies] | waitsel 선택자 [--count N]
  web capture URL --widths 390,1280 [--dpr 2] [--hide-fixed] | pageaudit [URL] [--isolated] [--checks images,overflow,...]
  web fetch /api/... [--method POST --body JSON --write] | eval JS | identify [글자] | window [maximize] | shot [파일] [--full]
  web script 파일.mjs [인자...] [--write]   스니펫: export default async ({ page, helpers, args }) => 결과
  web profile add 이름 [--dir 폴더] [--port N] | web profile remove 이름 | unpin ;  모든 웹 명령에 --profile 이름
  쓰기 공통: --dry-run | --dialog dismiss|accept | --confirm-dialog 문구 | --modal-confirm 문구 [--modal-button 확인]
            --expect 글자 | --expect-gone 글자 | --expect-url 주소 | --idem-key 키 [--repeat]
  browser login-check|scrape|run|audit ...   JSON 레시피 워크플로

데스크톱 (모든 Windows 앱. 대상: title:제목 | proc:이름 | pid:번호 | hwnd:번호)
  windows [--title 정규식] [--proc 정규식] [--all] | fg | front 대상 [--force] | show 대상 restore|minimize|maximize
  see 대상 [파일.png] [--screen] [--restore] | screen [파일.png] | ocr 이미지 [--match 글자]
  tree|read 대상 [--json] | find 대상 정규식 [--by name|autoid|type] | assert 대상 정규식 기대정규식
  click 대상 정규식 (UIA 실행 → UIA 좌표 → 글자 인식) | invoke|toggle|focus 대상 정규식 | settext 대상 정규식 글자
  clicktext 대상 글자 [--index N] [--double] | clickrel 대상 글자 dx dy | vassert 대상 글자
  type 대상 글자 | key 대상 "{ENTER}" | scroll 대상 up|down [칸] | wait 대상 [--text 글자] [--gone] [--timeout ms]
  children 대상 | gettext hwnd:번호 | vscroll hwnd:번호 bottom|top|pageup|pagedown [--count N]
  snapshot --title 제목 [--title 제목2] [--out 폴더] [--keep-days 14]   (예약 실행용, 포커스 없음)

  여러 창·여러 글자가 일치하면 임의로 고르지 않고 후보를 돌려준다(--index N 또는 더 정확한 대상 지정).`);
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] || 'help';
  const { positional, flags } = parseArgs(argv.slice(1));
  if (command === 'help' || command === '--help' || command === '-h' || flags.help) {
    usage();
    return 0;
  }
  switch (command) {
    case 'check':
      return runNode('ai_project_check.mjs', argv.slice(1));
    case 'doctor':
      return runNode('doctor.mjs', argv.slice(1));
    case 'browser':
      return runNode('browser_workflow.mjs', argv.slice(1));
    case 'web':
      return runWeb(positional, flags);
    case 'stop':
      mkdirSync(stateLocal, { recursive: true });
      writeFileSync(stopFile(), new Date().toISOString(), 'utf8');
      print({ ok: true, stopped: true, file: stopFile() });
      return 0;
    case 'resume':
      rmSync(stopFile(), { force: true });
      print({ ok: true, stopped: false });
      return 0;
    case 'status': {
      let status = '';
      try { status = readFileSync(join(stateLocal, 'status.txt'), 'utf8'); } catch {}
      print({ ok: true, stopped: existsSync(stopFile()), lastStatus: status, stateDir: stateLocal });
      return 0;
    }
    default: {
      const code = runDesktop(command, positional, flags);
      if (code === null) throw usageError(`알 수 없는 명령입니다: ${command}. node scripts/cu.mjs help`);
      return code;
    }
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  process.exitCode = fail(error, error?.candidates ? { candidates: error.candidates } : {});
}
