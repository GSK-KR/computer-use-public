#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { extname, join, resolve, sep, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JobRunner, defaultJobCatalog } from './lib/job_runner.mjs';
import { formatDoctor, redactPath, runDoctor } from './lib/doctor.mjs';
import { loadPathConfig } from './lib/path_config.mjs';

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const rootDir = resolve(scriptDir, '..');
const pathConfig = loadPathConfig();
const stateDirLocal = process.platform === 'win32' ? pathConfig.stateDirWin : pathConfig.stateDirWsl;
const runsDirLocal = process.platform === 'win32' ? pathConfig.runsDirWin : pathConfig.runsDirWsl;

const options = {
  host: process.env.CU_CONSOLE_HOST || '127.0.0.1',
  port: Number(process.env.CU_CONSOLE_PORT || pathConfig.defaultConsolePort || 8766),
  staticDir: resolve(process.env.CU_CONSOLE_STATIC_DIR || join(rootDir, 'web', 'console')),
};

for (let i = 2; i < process.argv.length; i++) {
  const cur = process.argv[i];
  if (cur === '--host') options.host = process.argv[++i];
  else if (cur.startsWith('--host=')) options.host = cur.slice('--host='.length);
  else if (cur === '--port') options.port = Number(process.argv[++i]);
  else if (cur.startsWith('--port=')) options.port = Number(cur.slice('--port='.length));
  else if (cur === '--static-dir') options.staticDir = resolve(process.argv[++i]);
  else if (cur.startsWith('--static-dir=')) options.staticDir = resolve(cur.slice('--static-dir='.length));
  else if (cur === '-h' || cur === '--help') {
    console.log('usage: node scripts/computer_use_console_server.mjs [--host 127.0.0.1] [--port 8766]');
    process.exit(0);
  } else {
    console.error(`알 수 없는 실행 옵션입니다: ${cur}`);
    process.exit(2);
  }
}

if (options.host !== '127.0.0.1' && options.host !== 'localhost') {
  console.error('백업 화면은 이 컴퓨터 전용 주소만 사용할 수 있습니다. host는 127.0.0.1 또는 localhost로 설정하세요.');
  process.exit(2);
}
if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
  console.error('웹 주소 포트가 올바르지 않습니다.');
  process.exit(2);
}

mkdirSync(stateDirLocal, { recursive: true });
mkdirSync(runsDirLocal, { recursive: true });

const tokenFile = join(stateDirLocal, 'console_token');
const tokenRequired = process.env.CU_CONSOLE_REQUIRE_TOKEN === '1';
const token = process.env.CU_CONSOLE_TOKEN || (tokenRequired ? readOrCreateToken(tokenFile) : '');
const redactConfigPaths = process.env.CU_CONSOLE_REDACT_CONFIG_PATHS === '1' || process.env.CU_CONSOLE_REDACT_PATHS === '1';
const instanceHashFiles = [
  'scripts/agent_runner.mjs',
  'scripts/computer_use_console_server.mjs',
  'scripts/chat_artifact_viewer_server.mjs',
  'scripts/discord_capture.mjs',
  'scripts/lib/job_runner.mjs',
  'scripts/lib/doctor.mjs',
  'scripts/lib/path_config.mjs',
  'web/console/index.html',
  'web/console/app.js',
  'web/console/styles.css',
  'web/chat-viewer/index.html',
  'web/chat-viewer/app.js',
  'web/chat-viewer/styles.css',
];
const catalog = defaultJobCatalog(pathConfig);
if (process.env.CU_CONSOLE_SELFTEST === '1') {
  catalog.selftest = {
    pass: {
      risk: ['read'],
      description: 'Test-only pass job',
      build: () => ({ command: [process.execPath, '-e', 'console.log("console selftest pass")'], cwd: rootDir }),
    },
    slow: {
      risk: ['foreground'],
      foreground: true,
      description: 'Test-only slow foreground job',
      build: () => ({ command: [process.execPath, '-e', 'let i=0; setInterval(()=>console.log("console tick " + (++i)), 100)'], cwd: rootDir }),
    },
  };
}
const runner = new JobRunner({ pathConfig, catalog });
const instanceRootHash = packageInstanceHash(rootDir);
const chatViewer = {
  port: 0,
  process: null,
  starting: null,
};
const publicJobArtifactFiles = new Set(['manifest.json', 'stdout.log', 'stderr.log', 'events.jsonl']);

function packageInstanceHash(root) {
  const summary = instanceHashFiles.map((file) => {
    const full = join(root, file);
    try {
      const fileHash = createHash('sha256').update(readFileSync(full)).digest('hex');
      return `${file}:${fileHash}`;
    } catch {
      return `${file}:missing`;
    }
  }).join('\n');
  return createHash('sha256').update(summary).digest('hex').slice(0, 16);
}

function readOrCreateToken(file) {
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const value = randomBytes(32).toString('hex');
  writeFileSync(file, `${value}\n`, { encoding: 'utf8', mode: 0o600 });
  return value;
}

function localHostAllowed(req) {
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

function localPeerAllowed(req) {
  const addr = String(req.socket.remoteAddress || '');
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('::ffff:127.');
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') && /^https?:$/u.test(parsed.protocol);
  } catch {
    return false;
  }
}

function firstHeader(value) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function cookieValue(req, name) {
  const cookie = firstHeader(req.headers.cookie);
  for (const part of String(cookie || '').split(';')) {
    const [rawKey, ...rest] = part.trim().split('=');
    if (rawKey !== name) continue;
    try {
      return decodeURIComponent(rest.join('='));
    } catch {
      return rest.join('=');
    }
  }
  return '';
}

function sameToken(supplied) {
  if (!token) return false;
  if (!supplied) return false;
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(token);
  return a.length === b.length && createHash('sha256').update(a).digest('hex') === createHash('sha256').update(b).digest('hex');
}

function tokenAllowed(req, url) {
  if (!tokenRequired) return true;
  const supplied = firstHeader(req.headers['x-cu-token']) || url.searchParams.get('token') || cookieValue(req, 'cu_token') || '';
  return sameToken(supplied);
}

function authCookie() {
  return `cu_token=${encodeURIComponent(token)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict`;
}

function optionalAuthCookieHeader() {
  return token ? { 'set-cookie': authCookie() } : {};
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { error: message, ...extra });
}

function artifactContentType(file) {
  if (/\.json$/u.test(file)) return 'application/json; charset=utf-8';
  if (/\.jsonl$/u.test(file)) return 'application/x-ndjson; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

function safeAttachmentName(jobId, file) {
  const cleanJob = String(jobId || 'job').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 120) || 'job';
  const cleanFile = String(file || 'artifact').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80) || 'artifact';
  return `computer-use-${cleanJob}-${cleanFile}`;
}

function publicJobError(err) {
  const code = err?.code || '';
  if (code === 'BAD_PARAMS') return err.message || '입력값을 확인하세요.';
  if (code === 'CONFIRMATION_REQUIRED') return '화면을 조작하는 작업입니다. 확인 후 다시 시작하세요.';
  if (code === 'FOREGROUND_BUSY') return '다른 화면 사용 작업이 끝난 뒤 다시 시작하세요.';
  if (code === 'MISSING_WSL' || code === 'MISSING_WSL_TOOL') {
    return '이 선택 기능은 고급 실행 환경이 필요합니다. 기본 카카오톡/위챗 백업은 기본 버튼으로 먼저 진행하세요.';
  }
  if (code === 'UNKNOWN_JOB' || code === 'BAD_JOB_NAME') return '요청한 작업을 찾지 못했습니다. 화면을 새로고침한 뒤 다시 시도하세요.';
  if (code === 'NOT_FOUND') return '요청한 진행 기록을 찾지 못했습니다. 진행 기록을 새로고침하세요.';
  if (code === 'BAD_COMMAND') return '작업을 시작하지 못했습니다. 준비 확인을 실행한 뒤 다시 시도하세요.';
  if (code === 'BAD_ARTIFACT_PATH' || code === 'PATH_TRAVERSAL') return '요청한 기록 파일을 열 수 없습니다.';
  return '작업을 시작하지 못했습니다. 준비 확인과 진행 기록을 확인하세요.';
}

function handleAuth(req, res, url) {
  if (req.method !== 'GET') {
    sendError(res, 405, '이 요청 방식은 사용할 수 없습니다.');
    return;
  }
  const localShortcut = url.pathname === '/auth/local';
  const supplied = url.searchParams.get('token') || cookieValue(req, 'cu_token') || '';
  if (tokenRequired && !localShortcut && !sameToken(supplied)) {
    sendError(res, 401, '백업 화면을 다시 열어 주세요');
    return;
  }
  if (localShortcut && !localPeerAllowed(req)) {
    sendError(res, 403, '이 컴퓨터에서 연 백업 화면만 사용할 수 있습니다');
    return;
  }
  const next = url.searchParams.get('next') || '/';
  const location = next.startsWith('/') && !next.startsWith('//') ? next : '/';
  res.writeHead(302, {
    location,
    ...optionalAuthCookieHeader(),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end();
}

function redirectCleanLocalTokenUrl(req, res, url) {
  if (!url.searchParams.has('token') || req.method !== 'GET') return false;
  if (url.pathname === '/auth' || url.pathname === '/auth/local') return false;
  const supplied = url.searchParams.get('token') || '';
  const clean = new URLSearchParams(url.searchParams);
  clean.delete('token');
  const query = clean.toString();
  const validStrictToken = tokenRequired && sameToken(supplied);
  res.writeHead(302, {
    location: `${url.pathname}${query ? `?${query}` : ''}`,
    ...(validStrictToken ? optionalAuthCookieHeader() : {}),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end();
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function publicConfig() {
  const configPath = (value) => (redactConfigPaths ? redactPath(value) : value);
  const payload = {
    schema: 'computer-use.console-config.v1',
    pathsRedacted: redactConfigPaths,
    paths: {
      repoRootWsl: configPath(pathConfig.repoRootWsl),
      repoRootWin: configPath(pathConfig.repoRootWin),
      mirrorRootWsl: configPath(pathConfig.mirrorRootWsl),
      mirrorRootWin: configPath(pathConfig.mirrorRootWin),
      shotsDirWsl: configPath(pathConfig.shotsDirWsl),
      shotsDirWin: configPath(pathConfig.shotsDirWin),
      stateDirWsl: configPath(pathConfig.stateDirWsl),
      stateDirWin: configPath(pathConfig.stateDirWin),
      runsDirWsl: configPath(pathConfig.runsDirWsl),
      runsDirWin: configPath(pathConfig.runsDirWin),
      wechatDbWsl: configPath(pathConfig.wechatDbWsl),
      wechatDbWin: configPath(pathConfig.wechatDbWin),
    },
    defaultConsolePort: pathConfig.defaultConsolePort,
    chromeCdpPort: pathConfig.chromeCdpPort,
  };
  if (catalog.agent) payload.agentProvider = pathConfig.agentProvider;
  return payload;
}

function configError(message, code = 'BAD_CONFIG') {
  const err = new Error(message);
  err.code = code;
  err.publicMessage = message;
  return err;
}

function normalizeWindowsBackupFolder(value) {
  let text = String(value ?? '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  if (!text) throw configError('백업 저장 폴더를 입력하세요.');
  if (/\r|\n/u.test(text)) throw configError('백업 저장 폴더는 한 줄로 입력하세요.');
  if (/<user>|\$HOME/iu.test(text)) {
    throw configError('화면에 보이는 <user>나 $HOME 표시는 안내용입니다. 실제 Windows 폴더 경로를 입력하세요.');
  }
  const match = text.match(/^([A-Za-z]):[\\/](.+)$/u);
  if (!match) {
    throw configError('C:\\Users\\내이름\\Documents\\Computer-Use-Backups 또는 D:\\KakaoBackups처럼 드라이브 문자로 시작하는 Windows 폴더 경로를 입력하세요.');
  }
  const drive = match[1].toUpperCase();
  const rest = match[2].replace(/[\\/]+/g, '\\').replace(/\\+$/u, '');
  if (!rest) throw configError('드라이브만 입력하지 말고 백업을 저장할 폴더까지 입력하세요.');
  if (/[:<>"|?*]/u.test(rest)) throw configError('Windows 폴더 이름에 사용할 수 없는 문자가 있습니다.');
  if (rest.split('\\').some((part) => part === '.' || part === '..')) {
    throw configError('.. 같은 상대 경로 대신 실제 Windows 폴더 경로를 입력하세요.');
  }
  return `${drive}:\\${rest}`;
}

function verifyWritableBackupFolder(folder) {
  if (process.platform !== 'win32') return false;
  try {
    mkdirSync(folder, { recursive: true });
    if (!statSync(folder).isDirectory()) throw new Error('not a directory');
    const marker = join(folder, `.computer-use-write-test-${process.pid}-${Date.now()}.tmp`);
    writeFileSync(marker, 'ok\n', 'utf8');
    unlinkSync(marker);
    return true;
  } catch {
    throw configError('백업 저장 폴더를 만들거나 쓸 수 없습니다. 바탕화면이나 문서처럼 내가 저장할 수 있는 폴더를 입력하세요.', 'BAD_CONFIG_PATH');
  }
}

function writeConfigPatch(patch) {
  const allowed = new Set([
    'repoRootWsl',
    'repoRootWin',
    'mirrorRootWsl',
    'shotsDir',
    'stateDir',
    'runsDir',
    'wechatDb',
    'defaultConsolePort',
    'chromeCdpPort',
    'agentProvider',
    'allowCloudOcr',
    'allowCloudTranslation',
    'sqlite3Path',
    'webCdpScript',
  ]);
  const clean = {};
  let writableChecked = false;
  for (const [key, value] of Object.entries(patch || {})) {
    if (!allowed.has(key)) continue;
    if (key === 'shotsDir') {
      const folder = normalizeWindowsBackupFolder(value);
      writableChecked = verifyWritableBackupFolder(folder);
      clean[key] = folder;
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') clean[key] = value;
  }
  const file = pathConfig.configFile || join(pathConfig.stateDirWsl, 'config.json');
  let current = {};
  try { current = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...current, ...clean }, null, 2)}\n`, 'utf8');
  return { written: Object.keys(clean), restartRequired: true, writableChecked };
}

function moduleList() {
  return Object.entries(catalog).map(([module, actions]) => ({
    module,
    actions: Object.entries(actions).map(([action, def]) => ({
      action,
      risk: def.risk || ['read'],
      requires: def.requires || [],
      foreground: Boolean(def.foreground),
      description: def.description || '',
    })),
  }));
}

function safeStaticPath(urlPath) {
  const raw = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath);
  const file = resolve(options.staticDir, raw.replace(/^\/+/u, ''));
  const rel = relative(options.staticDir, file);
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) return '';
  return file;
}

function contentType(file) {
  switch (extname(file).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.json': return 'application/json; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

function serveStatic(req, res, url) {
  let file = safeStaticPath(url.pathname);
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    if (/^\/(?:backup|agent|jobs|doctor|chats|settings)\/?$/u.test(url.pathname)) {
      file = join(options.staticDir, 'index.html');
    } else {
      sendError(res, 404, '요청한 화면을 찾지 못했습니다. 처음 화면으로 돌아가세요.');
      return;
    }
  }
  res.writeHead(200, {
    'content-type': contentType(file),
    'cache-control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=60',
    'x-content-type-options': 'nosniff',
    ...(sameToken(url.searchParams.get('token') || '') ? optionalAuthCookieHeader() : {}),
  });
  res.end(readFileSync(file));
}

function chatViewerPortCandidates() {
  const explicit = Number(process.env.CU_CHAT_VIEW_PORT || 0);
  const seeds = explicit
    ? [explicit]
    : [options.port + 1, 8766, 8767, 8768, 8769, 8770, 8771, 8772, 8773, 8774, 8775, 8776, 8777, 8778, 8779, 8780, 8781, 8782, 8783, 8784, 8785];
  return [...new Set(seeds)]
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535 && port !== options.port);
}

function chatViewerProbe(port) {
  return new Promise((resolve) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/health',
      method: 'GET',
      timeout: 900,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          if (
            res.statusCode === 200
            && data.schema === 'chat_artifact_viewer.health.v1'
            && data.instance?.rootHash === instanceRootHash
          ) {
            resolve('matching');
            return;
          }
          resolve('occupied');
        } catch {
          resolve('occupied');
        }
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (err) => {
      resolve(err?.code === 'ECONNREFUSED' ? 'free' : 'occupied');
    });
    req.end();
  });
}

async function chatViewerHealth(port) {
  return (await chatViewerProbe(port)) === 'matching';
}

async function waitForChatViewer(port, isAlive = () => true) {
  for (let i = 0; i < 60; i++) {
    if (!isAlive()) return false;
    if (await chatViewerHealth(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function ensureChatViewer() {
  if (chatViewer.port && await chatViewerHealth(chatViewer.port)) return chatViewer.port;
  if (chatViewer.starting) return chatViewer.starting;

  chatViewer.starting = (async () => {
    for (const port of chatViewerPortCandidates()) {
      if ((await chatViewerProbe(port)) === 'matching') {
        chatViewer.port = port;
        return port;
      }
    }

    const logFile = join(stateDirLocal, 'chat_viewer_proxy.log');
    for (const port of chatViewerPortCandidates()) {
      if ((await chatViewerProbe(port)) !== 'free') continue;
      let exited = false;
      const child = spawn(process.execPath, [
        join(rootDir, 'scripts', 'chat_artifact_viewer_server.mjs'),
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
      ], {
        cwd: rootDir,
        env: { ...process.env, CHAT_VIEW_PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stdout.on('data', (chunk) => appendFileSync(logFile, chunk));
      child.stderr.on('data', (chunk) => appendFileSync(logFile, chunk));
      child.on('exit', () => {
        exited = true;
        if (chatViewer.process === child) chatViewer.process = null;
      });
      if (await waitForChatViewer(port, () => !exited)) {
        chatViewer.process = child;
        chatViewer.port = port;
        return port;
      }
      child.kill('SIGTERM');
    }
    throw new Error('결과 화면을 열 로컬 주소를 준비하지 못했습니다');
  })();

  try {
    return await chatViewer.starting;
  } finally {
    chatViewer.starting = null;
  }
}

function proxyChatViewer(req, res, url, port) {
  const path = scopedChatViewerProxyPath(url);
  const headers = { ...req.headers, host: `127.0.0.1:${port}` };
  const proxyReq = httpRequest({
    hostname: '127.0.0.1',
    port,
    path,
    method: req.method,
    headers,
    timeout: 15000,
  }, (proxyRes) => {
    const responseHeaders = { ...proxyRes.headers };
    delete responseHeaders['transfer-encoding'];
    res.writeHead(proxyRes.statusCode || 502, responseHeaders);
    proxyRes.pipe(res);
  });
  proxyReq.on('timeout', () => proxyReq.destroy(new Error('chat viewer proxy timeout')));
  proxyReq.on('error', (err) => {
    if (!res.headersSent) sendError(res, 502, '결과 화면을 준비하지 못했습니다. 결과 새로고침을 누르거나 백업 폴더를 확인하세요.');
    else res.destroy();
  });
  req.pipe(proxyReq);
}

function scopedChatViewerProxyPath(url) {
  const targetPath = url.pathname.replace(/^\/chat-viewer/u, '') || '/';
  const params = new URLSearchParams(url.searchParams);
  if (/^\/api\/(?:health|rooms)$/u.test(targetPath)) {
    const platform = params.get('platform') || '';
    if (!['chat', 'kakao_wechat', 'kakao', 'wechat'].includes(platform)) params.set('platform', 'chat');
  }
  const query = params.toString();
  return `${targetPath}${query ? `?${query}` : ''}`;
}

function needsScopedChatViewerRedirect(url) {
  if (!['/chat-viewer', '/chat-viewer/', '/chat-viewer/index.html'].includes(url.pathname)) return false;
  return !url.searchParams.has('scope') && !url.searchParams.has('platforms');
}

function redirectScopedChatViewer(res, url) {
  const params = new URLSearchParams(url.searchParams);
  params.set('scope', 'chat');
  const pathname = url.pathname === '/chat-viewer' ? '/chat-viewer/' : url.pathname;
  res.writeHead(302, {
    location: `${pathname}?${params.toString()}`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end();
}

async function handleChatViewer(req, res, url) {
  if (needsScopedChatViewerRedirect(url)) {
    redirectScopedChatViewer(res, url);
    return;
  }
  if (!tokenAllowed(req, url)) {
    if (req.method === 'GET' && localPeerAllowed(req) && !url.pathname.startsWith('/chat-viewer/api/')) {
      const next = `${url.pathname}${url.search}`;
      res.writeHead(302, {
        location: `/auth/local?next=${encodeURIComponent(next)}`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end();
      return;
    }
    sendError(res, 401, '백업 화면을 다시 열어 주세요');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 405, '이 요청 방식은 사용할 수 없습니다.');
    return;
  }
  const port = await ensureChatViewer();
  proxyChatViewer(req, res, url, port);
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      schema: 'computer-use.console-health.v1',
      status: 'ready',
      host: options.host,
      port: options.port,
      tokenRequired,
      instance: {
        rootHash: instanceRootHash,
      },
      runtime: {
        platform: process.platform,
      },
    });
    return;
  }
  if (!tokenAllowed(req, url)) {
    sendError(res, 401, '백업 화면을 다시 열어 주세요');
    return;
  }

  if (url.pathname === '/api/doctor' && req.method === 'GET') {
    sendJson(res, 200, await runDoctor());
    return;
  }
  if (url.pathname === '/api/doctor.txt' && req.method === 'GET') {
    const report = await runDoctor();
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(formatDoctor(report));
    return;
  }
  if (url.pathname === '/api/config' && req.method === 'GET') {
    sendJson(res, 200, publicConfig());
    return;
  }
  if (url.pathname === '/api/config' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      sendJson(res, 200, writeConfigPatch(body));
    } catch (err) {
      sendError(res, 400, err.publicMessage || '설정을 저장하지 못했습니다. 입력값을 확인하세요.', { code: err.code || 'BAD_CONFIG' });
    }
    return;
  }
  if (url.pathname === '/api/modules' && req.method === 'GET') {
    sendJson(res, 200, { modules: moduleList() });
    return;
  }
  if (url.pathname === '/api/jobs' && req.method === 'GET') {
    sendJson(res, 200, { jobs: runner.listJobs() });
    return;
  }
  if (url.pathname === '/api/jobs' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const manifest = runner.startJob({ module: body.module, action: body.action, params: body.params || {} });
      sendJson(res, 201, { job: manifest });
    } catch (err) {
      sendError(res, err.code === 'CONFIRMATION_REQUIRED' ? 409 : 400, publicJobError(err), {
        code: err.code || 'BAD_REQUEST',
        expectedConfirmation: err.expectedConfirmation,
        risk: err.risk,
      });
    }
    return;
  }
  if (url.pathname === '/api/agent/jobs' && req.method === 'POST') {
    if (!catalog.agent) {
      sendError(res, 404, '이 패키지에는 고급 자동 실행 기능이 없습니다. 위챗 백업 또는 카카오톡 백업을 사용하세요.', { code: 'NOT_AVAILABLE' });
      return;
    }
    try {
      const body = await readBody(req);
      const mode = body.mode === 'run' ? 'run' : 'preview';
      const manifest = runner.startJob({
        module: 'agent',
        action: mode,
        params: {
          goal: body.goal,
          provider: body.provider,
          confirmation: body.confirmation,
          confirmRisk: body.confirmRisk,
        },
      });
      sendJson(res, 201, { job: manifest });
    } catch (err) {
      sendError(res, err.code === 'CONFIRMATION_REQUIRED' ? 409 : 400, publicJobError(err), {
        code: err.code || 'BAD_REQUEST',
        expectedConfirmation: err.expectedConfirmation,
        risk: err.risk,
      });
    }
    return;
  }

  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)(?:\/([^/]+))?$/u);
  if (jobMatch) {
    const id = decodeURIComponent(jobMatch[1]);
    const op = jobMatch[2] || '';
    try {
      if (!op && req.method === 'GET') {
        sendJson(res, 200, { job: runner.getJob(id) });
        return;
      }
      if (op === 'stop' && req.method === 'POST') {
        sendJson(res, 200, { job: runner.stopJob(id) });
        return;
      }
      if (op === 'rerun' && req.method === 'POST') {
        sendJson(res, 201, { job: runner.rerunJob(id) });
        return;
      }
      if (op === 'events' && req.method === 'GET') {
        streamEvents(req, res, id);
        return;
      }
      if (op === 'artifact' && req.method === 'GET') {
        const file = url.searchParams.get('file') || '';
        if (!publicJobArtifactFiles.has(file)) {
          sendError(res, 400, '요청한 기록 파일을 열 수 없습니다.', { code: 'BAD_ARTIFACT_PATH' });
          return;
        }
        const text = runner.readArtifact(id, file);
        res.writeHead(200, {
          'content-type': artifactContentType(file),
          'cache-control': 'no-store',
          'content-disposition': `attachment; filename="${safeAttachmentName(id, file)}"`,
          'x-content-type-options': 'nosniff',
        });
        res.end(text);
        return;
      }
    } catch (err) {
      sendError(res, err.code === 'NOT_FOUND' ? 404 : 400, publicJobError(err), { code: err.code || 'BAD_REQUEST' });
      return;
    }
  }

  sendError(res, 404, '요청한 기능을 찾지 못했습니다.');
}

function streamEvents(req, res, id) {
  runner.getJob(id);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-content-type-options': 'nosniff',
  });
  const send = (event) => {
    if (event.job_id !== id) return;
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  try {
    const eventsText = runner.readArtifact(id, 'events.jsonl');
    for (const line of eventsText.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      send(JSON.parse(line));
    }
  } catch {}
  const manifest = runner.getJob(id);
  if (manifest.status !== 'running' && manifest.status !== 'stopping') {
    res.end();
    return;
  }
  runner.on(`event:${id}`, send);
  req.on('close', () => runner.off(`event:${id}`, send));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${options.host}:${options.port}`}`);
  if (!localHostAllowed(req) || !originAllowed(req)) {
    sendError(res, 403, '이 컴퓨터에서 연 백업 화면만 사용할 수 있습니다.');
    return;
  }
  if (redirectCleanLocalTokenUrl(req, res, url)) return;
  try {
    if (url.pathname === '/auth' || url.pathname === '/auth/local') handleAuth(req, res, url);
    else if (url.pathname === '/chat-viewer' || url.pathname.startsWith('/chat-viewer/')) await handleChatViewer(req, res, url);
    else if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch {
    sendError(res, 500, '요청을 처리하지 못했습니다. 화면을 새로고침한 뒤 다시 시도하세요.');
  }
});

server.listen(options.port, options.host, () => {
  const baseUrl = `http://${options.host}:${server.address().port}/`;
  console.log(`카카오톡/위챗 백업 화면 주소: ${baseUrl}`);
  console.log(tokenRequired
    ? '공유/연동 실험 모드: 직접 켰을 때만 쓰는 추가 확인이 적용됩니다.'
    : '기본 로컬 모드: 같은 컴퓨터에서는 따로 입력할 내용 없이 열립니다.');
});

function stopChatViewer() {
  if (chatViewer.process) chatViewer.process.kill('SIGTERM');
}

process.once('exit', stopChatViewer);
process.once('SIGINT', () => {
  stopChatViewer();
  process.exit(130);
});
process.once('SIGTERM', () => {
  stopChatViewer();
  process.exit(143);
});
