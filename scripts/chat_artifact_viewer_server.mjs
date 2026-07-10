#!/usr/bin/env node
// Local read-only web viewer for chat backup artifacts.
//
// Binds to 127.0.0.1 by default and does not log chat message text.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadKakaoOpenchatMessages } from './lib/kakao_openchat_structure_core.mjs';
import { loadPathConfig } from './lib/path_config.mjs';

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const rootDir = resolve(scriptDir, '..');
const pathConfig = loadPathConfig();
const defaultShotsDir = process.env.CHAT_VIEW_DEFAULT_SHOTS_DIR || (
  process.platform === 'win32' ? pathConfig.shotsDirWin : pathConfig.shotsDirWsl
);
const defaultWechatDb = process.env.CHAT_VIEW_DEFAULT_WECHAT_DB || (
  process.platform === 'win32' ? pathConfig.wechatDbWin : pathConfig.wechatDbWsl
);
const discordEnabled = process.env.CHAT_VIEW_ENABLE_DISCORD === '1'
  || (process.env.CHAT_VIEW_ENABLE_DISCORD !== '0' && existsSync(join(rootDir, 'scripts', 'discord_capture.mjs')));
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
const instanceRootHash = packageInstanceHash(rootDir);

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

function normalizeConsoleUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.origin;
  } catch {
    return '';
  }
}

const options = {
  host: process.env.CHAT_VIEW_HOST || '127.0.0.1',
  port: Number(process.env.CHAT_VIEW_PORT || 8766),
  staticDir: join(rootDir, 'web', 'chat-viewer'),
  consoleUrl: normalizeConsoleUrl(process.env.CU_CONSOLE_URL || process.env.CHAT_VIEW_CONSOLE_URL || ''),
  kakaoDirs: [],
  kakaoOpenchatDirs: [],
  discordDirs: [],
  wechatDirs: [],
  wechatDbs: [],
  auto: true,
  autoDedupe: false,
  allSources: false,
};

for (let i = 2; i < process.argv.length; i++) {
  const cur = process.argv[i];
  if (cur === '--kakao') options.kakaoDirs.push(process.argv[++i]);
  else if (cur.startsWith('--kakao=')) options.kakaoDirs.push(cur.slice('--kakao='.length));
  else if (cur === '--kakao-openchat' || cur === '--openchat') options.kakaoOpenchatDirs.push(process.argv[++i]);
  else if (cur.startsWith('--kakao-openchat=')) options.kakaoOpenchatDirs.push(cur.slice('--kakao-openchat='.length));
  else if (cur.startsWith('--openchat=')) options.kakaoOpenchatDirs.push(cur.slice('--openchat='.length));
  else if (cur === '--discord') options.discordDirs.push(process.argv[++i]);
  else if (cur.startsWith('--discord=')) options.discordDirs.push(cur.slice('--discord='.length));
  else if (cur === '--wechat-dir') options.wechatDirs.push(process.argv[++i]);
  else if (cur.startsWith('--wechat-dir=')) options.wechatDirs.push(cur.slice('--wechat-dir='.length));
  else if (cur === '--wechat-db' || cur === '--wechat') options.wechatDbs.push(process.argv[++i]);
  else if (cur.startsWith('--wechat-db=')) options.wechatDbs.push(cur.slice('--wechat-db='.length));
  else if (cur.startsWith('--wechat=')) options.wechatDbs.push(cur.slice('--wechat='.length));
  else if (cur === '--source') addAutoSource(process.argv[++i]);
  else if (cur.startsWith('--source=')) addAutoSource(cur.slice('--source='.length));
  else if (cur === '--host') options.host = process.argv[++i];
  else if (cur.startsWith('--host=')) options.host = cur.slice('--host='.length);
  else if (cur === '--port') options.port = Number(process.argv[++i]);
  else if (cur.startsWith('--port=')) options.port = Number(cur.slice('--port='.length));
  else if (cur === '--console-url') options.consoleUrl = normalizeConsoleUrl(process.argv[++i]);
  else if (cur.startsWith('--console-url=')) options.consoleUrl = normalizeConsoleUrl(cur.slice('--console-url='.length));
  else if (cur === '--static-dir') options.staticDir = process.argv[++i];
  else if (cur.startsWith('--static-dir=')) options.staticDir = cur.slice('--static-dir='.length);
  else if (cur === '--no-auto') options.auto = false;
  else if (cur === '--all-sources') {
    options.allSources = true;
    options.autoDedupe = false;
  }
  else if (cur === '-h' || cur === '--help') {
    printUsage();
    process.exit(0);
  } else {
    console.error(`unknown option: ${cur}`);
    printUsage();
    process.exit(2);
  }
}

function addAutoSource(dir) {
  const source = hostReadablePath(dir);
  if (existsSync(join(source, 'kakao_messages.json'))) options.kakaoDirs.push(source);
  else if (existsSync(join(source, 'kakao_openchat_manifest.json'))) options.kakaoOpenchatDirs.push(source);
  else if (existsSync(join(source, 'wechat_messages.json'))) options.wechatDirs.push(source);
  else if (discordEnabled && existsSync(join(source, 'messages.json'))) options.discordDirs.push(source);
  else if (/\.sqlite3?$|\.db$/iu.test(String(source)) && existsSync(source)) options.wechatDbs.push(source);
  else throw new Error(`unknown artifact source: ${dir}`);
}

options.staticDir = resolve(hostReadablePath(options.staticDir));
options.kakaoDirs = options.kakaoDirs.map((dir) => resolve(hostReadablePath(dir)));
options.kakaoOpenchatDirs = options.kakaoOpenchatDirs.map((dir) => resolve(hostReadablePath(dir)));
options.discordDirs = options.discordDirs.map((dir) => resolve(hostReadablePath(dir)));
options.wechatDirs = options.wechatDirs.map((dir) => resolve(hostReadablePath(dir)));
options.wechatDbs = options.wechatDbs.map((db) => resolve(hostReadablePath(db)));

if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
  console.error('invalid --port');
  process.exit(2);
}
if (!existsSync(options.staticDir)) {
  console.error(`missing static dir: ${options.staticDir}`);
  process.exit(2);
}

let autoDiscoveryActive = false;

if (options.auto && options.kakaoDirs.length === 0 && options.kakaoOpenchatDirs.length === 0 && options.discordDirs.length === 0 && options.wechatDirs.length === 0 && options.wechatDbs.length === 0) {
  autoDiscoveryActive = true;
  applyAutoDiscovery();
}

function applyAutoDiscovery() {
  const discovered = discoverSources();
  options.kakaoDirs = discovered.kakao;
  options.kakaoOpenchatDirs = discovered.kakaoOpenchat;
  options.discordDirs = discordEnabled ? discovered.discord : [];
  options.wechatDirs = discovered.wechat;
  options.wechatDbs = discovered.wechatDbs;
  options.autoDedupe = !options.allSources;
}

function printUsage() {
  console.error(`usage:
  node scripts/chat_artifact_viewer_server.mjs --kakao DIR [--kakao-openchat DIR] [--wechat-dir DIR] [--wechat-db FILE] [--host 127.0.0.1] [--port 8766]
  node scripts/chat_artifact_viewer_server.mjs --source DIR [--source DIR ...]
  node scripts/chat_artifact_viewer_server.mjs [--auto] [--all-sources]`);
}

function safeReadJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function shortId(kind, dir) {
  return `${kind}-${createHash('sha1').update(resolve(dir)).digest('hex').slice(0, 12)}`;
}

function normalizeStatus(value) {
  const s = String(value || '').toLowerCase();
  if (s === 'pass' || s === 'review' || s === 'fail' || s === 'skip') return s;
  if (s === 'skipped') return 'skip';
  return s || 'review';
}

function mtimeMs(dir) {
  try { return statSync(dir).mtimeMs; } catch { return 0; }
}

function windowsPathToWsl(path) {
  const value = String(path || '');
  const match = value.match(/^([A-Za-z]):[\\/](.*)$/u);
  if (!match) return value.replace(/\\/g, '/');
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
}

function wslPathToWindows(path) {
  const value = String(path || '');
  const match = value.match(/^\/mnt\/([A-Za-z])\/(.*)$/u);
  if (!match) return value;
  return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, '\\')}`;
}

function hostPathCandidates(path) {
  const value = String(path || '');
  const candidates = [value];
  if (process.platform === 'win32') candidates.push(wslPathToWindows(value));
  else candidates.push(windowsPathToWsl(value));
  return [...new Set(candidates.filter(Boolean))];
}

function hostReadablePath(path) {
  for (const candidate of hostPathCandidates(path)) {
    if (existsSync(candidate)) return candidate;
  }
  return String(path || '');
}

function hostReadableDir(path) {
  for (const candidate of hostPathCandidates(path)) {
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    } catch {}
  }
  return '';
}

function existingRelativeFile(baseDir, files) {
  const dir = hostReadableDir(baseDir);
  if (!dir) return null;
  for (const file of files) {
    const full = join(dir, file);
    try {
      if (existsSync(full) && statSync(full).isFile()) return { dir, file };
    } catch {}
  }
  return null;
}

function uniqueDirs(dirs) {
  return [...new Set(dirs.filter(Boolean).map((dir) => resolve(hostReadablePath(dir))))];
}

function artifactCandidateDirs(root, maxDepth = 4) {
  const out = [];
  const stack = [{ dir: root, depth: 0 }];
  const skip = new Set(['.git', 'node_modules', 'crops', 'frames', 'tess_json', 'pages', 'llm_ocr']);
  while (stack.length) {
    const cur = stack.pop();
    out.push(cur.dir);
    if (cur.depth >= maxDepth) continue;
    let entries = [];
    try { entries = readdirSync(cur.dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || skip.has(entry.name)) continue;
      stack.push({ dir: join(cur.dir, entry.name), depth: cur.depth + 1 });
    }
  }
  return [...new Set(out)];
}

function discoverSources() {
  const kakao = [];
  const kakaoOpenchat = [];
  const discord = [];
  const wechat = [];
  const wechatDbs = [];
  const extraRoots = (process.env.CHAT_VIEW_SOURCE_ROOTS || '')
    .split(';')
    .map((root) => root.trim())
    .filter(Boolean);
  for (const rootInput of [defaultShotsDir, ...extraRoots]) {
    const root = hostReadableDir(rootInput) || hostReadablePath(rootInput);
    if (!existsSync(root)) continue;
    for (const dir of artifactCandidateDirs(root)) {
      if (existsSync(join(dir, 'kakao_messages.json'))) {
        const doc = safeReadJson(join(dir, 'kakao_messages.json'), {});
        if (doc?.schema === 'kakao_regular_messages.v1') kakao.push(dir);
      }
      if (existsSync(join(dir, 'kakao_openchat_manifest.json'))) {
        const doc = safeReadJson(join(dir, 'kakao_openchat_manifest.json'), {});
        if (doc?.schema === 'kakao_openchat_scrape.v1') kakaoOpenchat.push(dir);
      }
      if (discordEnabled && existsSync(join(dir, 'messages.json'))) {
        const doc = safeReadJson(join(dir, 'messages.json'), {});
        if (doc?.schema === 'discord.messages.v1') discord.push(dir);
      }
      if (existsSync(join(dir, 'wechat_messages.json'))) {
        const doc = safeReadJson(join(dir, 'wechat_messages.json'), {});
        if (doc?.schema === 'wechat_messages.v1') wechat.push(dir);
      }
    }
  }
  if (existsSync(defaultWechatDb)) wechatDbs.push(defaultWechatDb);
  return {
    kakao: uniqueDirs(kakao).sort((a, b) => mtimeMs(b) - mtimeMs(a)).slice(0, 20),
    kakaoOpenchat: uniqueDirs(kakaoOpenchat).sort((a, b) => mtimeMs(b) - mtimeMs(a)).slice(0, 20),
    discord: uniqueDirs(discord).sort((a, b) => mtimeMs(b) - mtimeMs(a)).slice(0, 20),
    wechat: uniqueDirs(wechat).sort((a, b) => mtimeMs(b) - mtimeMs(a)).slice(0, 20),
    wechatDbs: [...new Set(wechatDbs.map((db) => resolve(db)))],
  };
}

function loadKakaoRoom(dir) {
  const messagesDoc = safeReadJson(join(dir, 'kakao_messages.json'));
  if (!messagesDoc || messagesDoc.schema !== 'kakao_regular_messages.v1') {
    throw new Error(`not a Kakao regular artifact: ${dir}`);
  }
  const audit = safeReadJson(join(dir, 'kakao_regular_audit.json'), {});
  const manifest = safeReadJson(join(dir, 'kakao_regular_manifest.json'), {});
  const id = shortId('kakao', dir);
  const stats = messagesDoc.stats || {};
  const messages = (messagesDoc.messages || []).map((msg, index) => {
    const frame = msg.source?.frame || null;
    const flags = Array.isArray(msg.flags) ? msg.flags : [];
    return {
      id: msg.id || `${id}-m-${index + 1}`,
      platform: 'kakao',
      room_id: id,
      index,
      speaker: msg.speaker || 'Unknown',
      timestamp: msg.timestamp_text || null,
      direction: msg.direction || 'incoming',
      side: msg.direction === 'outgoing' ? 'right' : 'left',
      text: msg.text || '',
      context_text: msg.context_text || '',
      kind: msg.kind || 'text',
      confidence: msg.text_confidence ?? null,
      speaker_confidence: msg.speaker_confidence ?? null,
      flags,
      comment_count: msg.comment_count ?? null,
      frame,
      image_url: frame && existsSync(join(dir, frame)) ? `/api/file?room=${encodeURIComponent(id)}&file=${encodeURIComponent(frame)}` : null,
      source: msg.source || {},
      provider: messagesDoc.provider || messagesDoc.llm_ocr?.provider || 'unknown',
    };
  });
  return {
    id,
    platform: 'kakao',
    label: messagesDoc.room || manifest.room_label || '카카오톡',
    dir,
    status: normalizeStatus(audit.status || manifest.quality?.status || manifest.status || 'review'),
    message_count: messages.length,
    unknown_count: stats.unknown_speaker_messages || messages.filter((m) => m.speaker === 'Unknown').length,
    outgoing_count: stats.outgoing || messages.filter((m) => m.side === 'right').length,
    incoming_count: stats.incoming || messages.filter((m) => m.side !== 'right').length,
    frame_count: stats.frames || audit.counts?.frames || 0,
    ocr_count: stats.raw_ocr_lines || null,
    dedupe_count: Number(stats.duplicates_removed || 0),
    generated_at: manifest.generated_at || audit.audited_at || null,
    kakao: {
      lines_merged: Number(stats.lines_merged || audit.counts?.lines_merged || 0),
      multi_line_messages: Number(stats.multi_line_messages || audit.counts?.multi_line_messages || 0),
      split_fragment_pairs: Number(stats.split_fragment_pairs || audit.counts?.split_fragment_pairs || 0),
      speaker_room_label_fallback_messages: Number(stats.speaker_room_label_fallback_messages || audit.counts?.speaker_room_label_fallback_messages || 0),
      hit_max_frames: Boolean(audit.counts?.stopped_at_max_frames || manifest.capture?.stopped_at_max_frames),
      max_frames: Number(audit.counts?.max_frames || manifest.capture?.max_frames || 0) || null,
    },
    audit,
    manifest,
    messages_doc: messagesDoc,
    messages,
  };
}

function loadOpenchatRoom(dir) {
  const manifest = safeReadJson(join(dir, 'kakao_openchat_manifest.json'));
  if (!manifest || manifest.schema !== 'kakao_openchat_scrape.v1') {
    throw new Error(`not a Kakao openchat artifact: ${dir}`);
  }
  const audit = safeReadJson(join(dir, 'audit.json'), {});
  const id = shortId('kakao-openchat', dir);
  const messagesDoc = loadKakaoOpenchatMessages(dir);
  const stats = messagesDoc.stats || {};
  const messages = (messagesDoc.messages || []).map((msg, index) => {
    const flags = Array.isArray(msg.flags) ? msg.flags : [];
    const frameImage = msg.source?.frame_image || msg.source?.frame || null;
    return {
      id: msg.id || `${id}-m-${String(index + 1).padStart(5, '0')}`,
      platform: 'kakao_openchat',
      room_id: id,
      index,
      speaker: msg.speaker || 'Unknown',
      timestamp: msg.timestamp_text || null,
      direction: msg.direction || 'incoming',
      side: msg.direction === 'outgoing' ? 'right' : 'left',
      text: msg.text || '',
      context_text: msg.context_text || '',
      kind: msg.kind || 'text',
      confidence: msg.text_confidence ?? null,
      speaker_confidence: msg.speaker_confidence ?? null,
      flags,
      comment_count: msg.comment_count ?? null,
      thread_index: msg.thread_index ?? null,
      thread_parent_anchor: msg.thread_parent_anchor || '',
      image_url: frameImage && existsSync(join(dir, frameImage))
        ? `/api/file?room=${encodeURIComponent(id)}&file=${encodeURIComponent(frameImage)}`
        : null,
      source: msg.source || {},
      provider: messagesDoc.provider || 'unknown',
    };
  });

  return {
    id,
    platform: 'kakao_openchat',
    label: `${messagesDoc.room || manifest.room_label || '카카오톡 오픈채팅'} 댓글포함`,
    dir,
    status: normalizeStatus(audit.status || 'review'),
    message_count: messages.length,
    unknown_count: stats.unknown_speaker_messages || messages.filter((m) => m.speaker === 'Unknown').length,
    outgoing_count: stats.outgoing || messages.filter((m) => m.side === 'right').length,
    incoming_count: stats.incoming || messages.filter((m) => m.side !== 'right').length,
    frame_count: Number(manifest.main_frames || 0),
    ocr_count: stats.main_candidates ?? null,
    dedupe_count: Number(stats.duplicates_removed || 0),
    generated_at: manifest.generated_at || null,
    audit,
    manifest,
    messages_doc: messagesDoc,
    messages,
    screenshot_url: existsSync(join(dir, 'frames', 'frame_000.png'))
      ? `/api/file?room=${encodeURIComponent(id)}&file=${encodeURIComponent('frames/frame_000.png')}`
      : null,
    openchat: {
      candidate_total: audit.summary?.candidate_total ?? null,
      candidate_unique_keys: audit.summary?.candidate_unique_keys ?? null,
      threads_attempted: Number(manifest.comment_threads_attempted || 0),
      threads_captured: Number(manifest.comment_threads_captured || 0),
      thread_frame_files: audit.summary?.thread_frame_files ?? null,
      provider: messagesDoc.provider || 'unknown',
      duplicates_removed: stats.duplicates_removed ?? null,
    },
  };
}

function loadDiscordRoom(dir) {
  const messagesDoc = safeReadJson(join(dir, 'messages.json'));
  if (!messagesDoc || messagesDoc.schema !== 'discord.messages.v1') {
    throw new Error(`not a Discord artifact: ${dir}`);
  }
  const audit = safeReadJson(join(dir, 'audit.json'), {});
  const manifest = safeReadJson(join(dir, 'manifest.json'), {});
  const id = shortId('discord', dir);
  const sourceLabel = manifest.inputs?.channel_label
    || manifest.inputs?.channel
    || messagesDoc.source_target
    || messagesDoc.source_url
    || 'Discord';
  const messages = (messagesDoc.messages || []).map((msg, index) => {
    const flags = Array.isArray(msg.flags) ? msg.flags : [];
    const author = msg.author || 'Unknown';
    return {
      id: msg.id || `${id}-m-${index + 1}`,
      platform: 'discord',
      room_id: id,
      index,
      speaker: author,
      timestamp: msg.timestamp || null,
      direction: author === 'Me' ? 'outgoing' : 'incoming',
      side: author === 'Me' ? 'right' : 'left',
      text: msg.text || '',
      kind: 'text',
      confidence: flags.includes('author_inferred_from_visible_header') ? 0.72 : null,
      flags,
      mentions: msg.mentions || [],
      source: msg.source || {},
    };
  });
  return {
    id,
    platform: 'discord',
    label: `디스코드 ${sourceLabel}`,
    dir,
    status: normalizeStatus(audit.status || manifest.status || 'review'),
    message_count: messages.length,
    unknown_count: messages.filter((m) => m.speaker === 'Unknown').length,
    outgoing_count: messages.filter((m) => m.side === 'right').length,
    incoming_count: messages.filter((m) => m.side !== 'right').length,
    frame_count: existsSync(join(dir, 'screen.png')) ? 1 : 0,
    generated_at: manifest.ended_at || audit.audited_at || null,
    audit,
    manifest,
    messages,
    screenshot_url: existsSync(join(dir, 'screen.png')) ? `/api/file?room=${encodeURIComponent(id)}&file=screen.png` : null,
  };
}

function sqlString(value) {
  return `'${String(value ?? '').replaceAll("'", "''")}'`;
}

function parseSqliteJson(text) {
  const body = String(text || '').trim();
  return body ? JSON.parse(body) : [];
}

function addSqliteCandidate(candidates, seen, cmd, argv) {
  if (!cmd) return;
  const key = `${cmd}\u0000${argv.join('\u0000')}`;
  if (seen.has(key)) return;
  seen.add(key);
  candidates.push([cmd, argv]);
}

function sqliteCandidates(db, sql) {
  const candidates = [];
  const seen = new Set();
  const configured = pathConfig.sqlite3Path || process.env.SQLITE3 || '';
  const localArgs = ['-readonly', '-cmd', '.timeout 10000', '-json', db, sql];
  if (process.platform === 'win32') {
    if (configured && !configured.startsWith('/')) addSqliteCandidate(candidates, seen, configured, localArgs);
    addSqliteCandidate(candidates, seen, 'sqlite3', localArgs);

    const wslDb = windowsPathToWsl(db);
    const wslArgs = ['-readonly', '-cmd', '.timeout 10000', '-json', wslDb, sql];
    const wslBins = [configured && configured.startsWith('/') ? configured : '', 'sqlite3'];
    for (const bin of wslBins) {
      if (bin) addSqliteCandidate(candidates, seen, 'wsl.exe', ['-e', bin, ...wslArgs]);
    }
    addSqliteCandidate(candidates, seen, 'wsl.exe', [
      '-e',
      'sh',
      '-lc',
      'for c in sqlite3 "$HOME/Android/Sdk/platform-tools/sqlite3"; do if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then exec "$c" "$@"; fi; done; echo "sqlite3 not found" >&2; exit 127',
      'sqlite-wrapper',
      ...wslArgs,
    ]);
    return candidates;
  }

  addSqliteCandidate(candidates, seen, configured || 'sqlite3', localArgs);
  addSqliteCandidate(candidates, seen, 'sqlite3', localArgs);
  return candidates;
}

function runSqlite(db, sql) {
  const errors = [];
  for (const [cmd, argv] of sqliteCandidates(db, sql)) {
    const result = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.error) {
      errors.push(`${cmd}: ${result.error.message}`);
      continue;
    }
    if (result.status !== 0) {
      errors.push(`${cmd}: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
      continue;
    }
    return parseSqliteJson(result.stdout);
  }
  throw new Error(`sqlite read failed for ${db}: ${errors.join(' | ')}`);
}

function wechatRoomsSql() {
  return `
WITH msg AS (
  SELECT
    room_key,
    COUNT(*) AS message_count,
    SUM(CASE WHEN speaker = 'Unknown' THEN 1 ELSE 0 END) AS unknown_count,
    SUM(CASE WHEN side = 'outgoing' THEN 1 ELSE 0 END) AS outgoing_count,
    SUM(CASE WHEN side != 'outgoing' OR side IS NULL THEN 1 ELSE 0 END) AS incoming_count,
    SUM(CASE WHEN translation_ko IS NOT NULL AND translation_ko != '' THEN 1 ELSE 0 END) AS translated_count,
    SUM(CASE WHEN requires_screenshot_review = 1 THEN 1 ELSE 0 END) AS review_message_count,
    SUM(CASE WHEN kind != 'text' THEN 1 ELSE 0 END) AS non_text_count,
    SUM(CASE WHEN kind = 'text' AND conf IS NOT NULL AND conf < 55 THEN 1 ELSE 0 END) AS low_confidence_count
  FROM messages
  GROUP BY room_key
),
audit_rollup AS (
  SELECT
    room_key,
    CASE
      WHEN SUM(CASE WHEN audit_status = 'fail' THEN 1 ELSE 0 END) > 0 THEN 'fail'
      WHEN SUM(CASE WHEN audit_status = 'review' THEN 1 ELSE 0 END) > 0 THEN 'review'
      WHEN SUM(CASE WHEN audit_status = 'pass' THEN 1 ELSE 0 END) > 0 THEN 'pass'
      ELSE NULL
    END AS audit_status,
    MAX(frames) AS frames,
    MAX(max_frames) AS max_frames,
    MAX(elapsed_s) AS elapsed_s
  FROM room_audits
  GROUP BY room_key
)
SELECT
  r.room_key,
  r.label,
  COALESCE(audit_rollup.audit_status, r.latest_status, 'review') AS audit_status,
  r.latest_status,
  r.latest_room_dir,
  r.first_seen_at,
  r.last_seen_at,
  COALESCE(msg.message_count, 0) AS message_count,
  COALESCE(msg.unknown_count, 0) AS unknown_count,
  COALESCE(msg.outgoing_count, 0) AS outgoing_count,
  COALESCE(msg.incoming_count, 0) AS incoming_count,
  COALESCE(msg.translated_count, 0) AS translated_count,
  COALESCE(msg.message_count, 0) - COALESCE(msg.translated_count, 0) AS missing_translation_count,
  COALESCE(msg.review_message_count, 0) AS review_message_count,
  COALESCE(msg.non_text_count, 0) AS non_text_count,
  COALESCE(msg.low_confidence_count, 0) AS low_confidence_count,
  audit_rollup.frames,
  audit_rollup.max_frames,
  audit_rollup.elapsed_s
FROM rooms r
JOIN msg ON msg.room_key = r.room_key AND msg.message_count > 0
LEFT JOIN audit_rollup ON audit_rollup.room_key = r.room_key
ORDER BY r.last_seen_at DESC, msg.message_count DESC, r.label COLLATE NOCASE
LIMIT 1000;`;
}

function wechatMessagesSql(roomKey) {
  return `
WITH source_order AS (
  SELECT
    message_key,
    MIN(CASE
      WHEN source_message_id GLOB '-[0-9]*' OR source_message_id GLOB '[0-9]*'
      THEN CAST(source_message_id AS INTEGER)
      ELSE NULL
    END) AS source_order,
    MIN(batch_dir) AS batch_dir,
    MIN(room_dir) AS room_dir
  FROM message_sources
  GROUP BY message_key
)
SELECT
  m.message_key,
  source_order.source_order AS source_message_id,
  m.kind,
  m.speaker,
  m.speaker_source,
  m.side,
  m.text,
  m.translation_ko,
  m.translation_risk_note_ko,
  m.context_marker,
  m.conf,
  m.requires_screenshot_review,
  m.frame_first,
  m.frame_last,
  m.x,
  m.y,
  m.w,
  m.h,
  m.source_count,
  source_order.batch_dir,
  source_order.room_dir
FROM messages m
LEFT JOIN source_order ON source_order.message_key = m.message_key
WHERE m.room_key = ${sqlString(roomKey)}
ORDER BY
  CASE WHEN source_order.source_order IS NULL THEN 1 ELSE 0 END,
  source_order.source_order,
  m.frame_first,
  m.y,
  m.occurrence_index,
  m.message_key
LIMIT 50000;`;
}

function confidenceFromWechat(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n > 1 ? Math.round(n) / 100 : n;
}

function isTextReviewMessage(msg) {
  return (msg.kind || 'text') === 'text' &&
    msg.confidence !== null &&
    Number(msg.confidence) < 0.82;
}

function isLowConfidenceMessage(msg) {
  return (msg.kind || 'text') === 'text' &&
    msg.confidence !== null &&
    Number(msg.confidence) < 0.55;
}

function isTranslationRiskNote(note, kind = 'text') {
  return riskNoteCategory(note, kind) === 'translation';
}

function riskNoteCategory(note, kind = 'text') {
  const text = String(note || '').trim();
  if (!text) return '';
  if (kind !== 'text' && /(첨부|미디어|파일|이미지|카드|media|file|image|attachment)/iu.test(text)) return 'attachment';
  if (/(이모지|emoji|글리프|glyph|렌더|Unicode|유니코드|피부색|맥주잔|엄지|표정|손글씨)/iu.test(text)) return 'emoji';
  if (/(인용|참조|답장|quote|quoted|reply preview|미리보기)/iu.test(text)) return 'quote';
  if (/(발신자|보낸 사람|sender|speaker|이름|프로필)/iu.test(text)) return 'speaker_visual';
  if (/(OCR|저신뢰|신뢰도|불명확|흐림|흐려|첫 글자|문자.*모호|라틴|축약형|간격|apostrophe|아포스트로피)/iu.test(text)) return 'ocr_text';
  if (/(translated|translation bubble|translation overlay|source text|original text|WeChat translation|WeChat\s*번역|번역\s*(말풍선|패널|수신\s*말풍선)|번역문만|원문\s*메시지가\s*아니라|원래\s*문장)/iu.test(text)) return 'translation';
  if (/(첨부|미디어|파일|이미지|카드|media|file|image|attachment)/iu.test(text)) return 'attachment';
  if (/(스크린샷|원본|화면|말풍선|일반 채팅|일반 말풍선|방향 확인|초록)/iu.test(text)) return 'source';
  return 'source';
}

function isObsoleteSpeakerVisualRisk({ note, kind, speaker, speakerSource, side, requiresReview, confidence }) {
  if (riskNoteCategory(note, kind) !== 'speaker_visual') return false;
  if ((kind || 'text') !== 'text') return false;
  if (!speaker || speaker === 'Unknown') return false;

  const source = String(speakerSource || '');
  if (side === 'outgoing' && speaker === 'Me') return true;
  const strongAttribution = /visible-name|auto-room-label-incoming-speaker|hint-incoming-speaker|layout-right-side/u.test(source);
  if (!strongAttribution) return false;
  if (!requiresReview) return true;
  const n = Number(confidence);
  return Number.isFinite(n) && n >= 0.98;
}

function isGenericAttachmentRiskNote(note) {
  const text = String(note || '').trim();
  if (!text) return false;
  if (!/(첨부\/미디어|첨부|미디어|파일|이미지|카드|attachment|media|file|image)/iu.test(text)) return false;
  return !/(발신자|보낸 사람|sender|speaker|Unknown|불명확|미확인|흐림|흐릿|저신뢰|OCR|문자|인용|답장|quote|reply|잘려|잘림|가려|가림|일부|부분|번역|translation)/iu.test(text);
}

function hasEmojiGlyph(text) {
  return /[\p{Emoji_Presentation}\p{Extended_Pictographic}\u2600-\u27BF]/u.test(String(text || ''));
}

function isLowRiskEmojiRiskNote(note, msg) {
  if (riskNoteCategory(note, msg?.kind || 'text') !== 'emoji') return false;
  if (!hasEmojiGlyph(msg?.text)) return false;
  const confidence = confidenceFromWechat(msg?.conf);
  if (confidence !== null && Number(confidence) < 0.82) return false;
  const text = String(note || '');
  return !/(OCR|저신뢰|낮은\s*신뢰|low[-\s]?confidence|발신자|보낸 사람|sender|speaker|잘려|잘림|가려|가림|부분|일부|흐림|흐릿)/iu.test(text);
}

function isAttachmentReviewMessage({ kind, speaker, confidence, riskNote }) {
  if ((kind || 'text') === 'text') return false;
  if (!speaker || speaker === 'Unknown') return true;
  if (confidence !== null && confidence !== undefined && Number(confidence) < 0.82) return true;
  const note = String(riskNote || '').trim();
  if (!note) return false;
  return !isGenericAttachmentRiskNote(note);
}

function effectiveWechatRiskNote(msg, { kind, speaker, speakerSource, side, requiresReview } = {}) {
  const note = String(msg?.translation_risk_note_ko || '').trim();
  if (!note) return '';
  if ((kind || msg.kind || 'text') !== 'text' && isGenericAttachmentRiskNote(note)) return '';
  if ((kind || msg.kind || 'text') === 'text' && isLowRiskEmojiRiskNote(note, msg)) return '';
  if (isObsoleteSpeakerVisualRisk({
    note,
    kind: kind || msg.kind || 'text',
    speaker: speaker || msg.speaker || '',
    speakerSource: speakerSource || msg.speaker_source || '',
    side: side || msg.side || '',
    requiresReview: Boolean(requiresReview),
    confidence: confidenceFromWechat(msg?.conf),
  })) {
    return '';
  }
  return note;
}

function normalizedMessageText(msg) {
  return String(msg?.text || '').replace(/\s+/gu, ' ').trim().toLowerCase();
}

function normalizedSpeakerLabel(text) {
  return String(text || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

function isWechatTranslationOverlayRisk(note) {
  return /WeChat\s*번역\s*말풍선|번역\s*말풍선/iu.test(String(note || ''));
}

function isWechatTranslationOverlayArtifact(msg) {
  const text = String(msg?.text || '');
  const note = String(msg?.translation_risk_note_ko || '');
  return /(translated\s+by\s+wechat|wechat\s*translation|WeChat\s*번역|微信.{0,8}翻译|翻译.{0,8}微信|번역\s*(말풍선|패널|수신\s*말풍선)|원문\s*메시지가\s*아니라\s*WeChat\s*번역|번역문만\s*보)/iu.test(`${text} ${note}`);
}

function isWechatNonMessageArtifact(msg, knownSpeakerLabels) {
  if ((msg.kind || 'text') !== 'text') return false;
  if (msg.speaker !== 'Unknown') return false;
  const note = String(msg.translation_risk_note_ko || '');
  const riskCategory = riskNoteCategory(note, msg.kind);
  if (isWechatTranslationOverlayRisk(note)) return true;
  if (riskCategory === 'quote') return true;

  const speakerKey = normalizedSpeakerLabel(msg.text);
  if (speakerKey && knownSpeakerLabels.has(speakerKey) && [...String(msg.text || '')].length <= 40) return true;
  return false;
}

function frameRange(msg) {
  const first = Number(msg?.source?.frame_first ?? msg?.source?.frame ?? msg?.frame_first);
  const last = Number(msg?.source?.frame_last ?? msg?.frame_last ?? first);
  if (!Number.isFinite(first)) return null;
  return {
    first: Math.floor(first),
    last: Number.isFinite(last) ? Math.floor(last) : Math.floor(first),
  };
}

function addFrameWindow(set, range, radius = 0) {
  if (!range) return;
  for (let frame = range.first - radius; frame <= range.last + radius; frame++) {
    set.add(frame);
  }
}

function looksWechatScreenshotLikeAttachment(text) {
  const value = String(text || '');
  if (!value.trim()) return false;
  return /(\[image\]|screenshot|thumbnail|微信电脑版|WeChat|recalled a message|\.svg\b|\.png\b|\.jpe?g\b|\.webp\b|@[A-Za-z0-9_.-]+|LDUO[-\s)]|CONCHEN)/iu.test(value);
}

function isWechatEmbeddedMediaOcrArtifact(msg, embeddedMediaFrames, unknownTextClusterFrames) {
  if ((msg.kind || 'text') !== 'text') return false;
  if (msg.speaker !== 'Unknown') return false;
  const range = frameRange(msg);
  if (!range) return false;
  for (let frame = range.first; frame <= range.last; frame++) {
    if (embeddedMediaFrames.has(frame) && unknownTextClusterFrames.has(frame)) return true;
  }
  return false;
}

function isWechatKnownDuplicateOcrArtifact(msg, knownLongTexts, knownShortTextFrames) {
  if ((msg.kind || 'text') !== 'text') return false;
  if (msg.speaker !== 'Unknown') return false;
  const textKey = normalizedMessageText(msg);
  if (!textKey) return false;

  if (textKey.length >= 30 && knownLongTexts.some((known) => known.includes(textKey))) {
    return true;
  }

  const range = frameRange(msg);
  const shortKey = `${msg.side || ''}\u0000${msg.kind || 'text'}\u0000${textKey}`;
  const knownFrames = knownShortTextFrames.get(shortKey) || [];
  if (range && textKey.length < 30 && knownFrames.length) {
    for (let frame = range.first; frame <= range.last; frame++) {
      if (knownFrames.some((knownFrame) => Math.abs(knownFrame - frame) <= 2)) return true;
    }
  }
  return false;
}

function filterWechatNonMessageArtifacts(messages) {
  const knownSpeakerLabels = new Set();
  const embeddedMediaFrames = new Set();
  const unknownTextFrameCounts = new Map();
  const knownLongTexts = [];
  const knownShortTextFrames = new Map();
  for (const msg of messages) {
    if (msg.speaker && msg.speaker !== 'Unknown') {
      const key = normalizedSpeakerLabel(msg.speaker);
      if (key) knownSpeakerLabels.add(key);
    }
    if ((msg.kind || 'text') === 'text' && msg.speaker && msg.speaker !== 'Unknown') {
      const textKey = normalizedMessageText(msg);
      if (textKey.length >= 30) knownLongTexts.push(textKey);
      else if (textKey) {
        const range = frameRange(msg);
        const shortKey = `${msg.side || ''}\u0000${msg.kind || 'text'}\u0000${textKey}`;
        if (range) {
          if (!knownShortTextFrames.has(shortKey)) knownShortTextFrames.set(shortKey, []);
          for (let frame = range.first; frame <= range.last; frame++) {
            knownShortTextFrames.get(shortKey).push(frame);
          }
        }
      }
    }
    if ((msg.kind || 'text') !== 'text' && looksWechatScreenshotLikeAttachment(msg.text)) {
      addFrameWindow(embeddedMediaFrames, frameRange(msg), 2);
    }
    if ((msg.kind || 'text') === 'text' && msg.speaker === 'Unknown') {
      const range = frameRange(msg);
      if (range) {
        for (let frame = range.first; frame <= range.last; frame++) {
          unknownTextFrameCounts.set(frame, (unknownTextFrameCounts.get(frame) || 0) + 1);
        }
      }
    }
  }
  const unknownTextClusterFrames = new Set();
  for (const [frame, count] of unknownTextFrameCounts.entries()) {
    if (count >= 3) unknownTextClusterFrames.add(frame);
  }

  const kept = [];
  let hidden = 0;
  for (const msg of messages) {
    if (
      isWechatTranslationOverlayArtifact(msg) ||
      isWechatNonMessageArtifact(msg, knownSpeakerLabels) ||
      isWechatEmbeddedMediaOcrArtifact(msg, embeddedMediaFrames, unknownTextClusterFrames) ||
      isWechatKnownDuplicateOcrArtifact(msg, knownLongTexts, knownShortTextFrames)
    ) {
      hidden += 1;
      continue;
    }
    kept.push(msg);
  }
  return { messages: kept, hidden };
}

function messageFrame(msg) {
  const n = Number(msg?.source?.frame_first ?? msg?.source?.frame ?? msg?.frame_first);
  return Number.isFinite(n) ? n : null;
}

function isKnownSpeakerName(speaker) {
  return speaker && speaker !== 'Unknown';
}

function isVisualOverlapDuplicate(prev, cur) {
  const text = normalizedMessageText(cur);
  if (!text || text !== normalizedMessageText(prev)) return false;
  if ((prev.side || '') !== (cur.side || '')) return false;
  if ((prev.kind || 'text') !== (cur.kind || 'text')) return false;

  const prevFrame = messageFrame(prev);
  const curFrame = messageFrame(cur);
  if (prevFrame === null || curFrame === null) return false;
  if (Math.abs(curFrame - prevFrame) > 2) return false;
  if (curFrame === prevFrame && isKnownSpeakerName(prev.speaker) && isKnownSpeakerName(cur.speaker)) return false;

  if (prev.speaker === cur.speaker) return true;
  return prev.speaker === 'Unknown' || cur.speaker === 'Unknown';
}

function betterVisualDuplicate(prev, cur) {
  if (!isKnownSpeakerName(prev.speaker) && isKnownSpeakerName(cur.speaker)) return cur;
  if (isKnownSpeakerName(prev.speaker) && !isKnownSpeakerName(cur.speaker)) return prev;
  const prevScore = Number(prev.confidence || 0) + (prev.translation_ko ? 0.1 : 0);
  const curScore = Number(cur.confidence || 0) + (cur.translation_ko ? 0.1 : 0);
  return curScore > prevScore ? cur : prev;
}

function dedupeVisualOverlapMessages(messages) {
  const out = [];
  let removed = 0;
  for (const msg of messages) {
    const prev = out[out.length - 1];
    if (prev && isVisualOverlapDuplicate(prev, msg)) {
      out[out.length - 1] = betterVisualDuplicate(prev, msg);
      removed += 1;
      continue;
    }
    out.push(msg);
  }
  return {
    messages: out.map((msg, index) => ({ ...msg, index })),
    removed,
  };
}

function loadWechatArtifactRoom(dir) {
  const messagesDoc = safeReadJson(join(dir, 'wechat_messages.json'));
  if (!messagesDoc || messagesDoc.schema !== 'wechat_messages.v1') {
    throw new Error(`not a WeChat artifact: ${dir}`);
  }
  const manifest = safeReadJson(join(dir, 'wechat_scrape_manifest.json'), messagesDoc.manifest || {});
  const audit = safeReadJson(join(dir, 'wechat_audit.json'), {});
  const id = shortId('wechat-dir', dir);
  const rawMessages = Array.isArray(messagesDoc.messages) ? messagesDoc.messages : [];
  const messages = rawMessages.map((msg, index) => {
    const rawSide = String(msg.side || msg.direction || '').toLowerCase();
    const direction = rawSide === 'outgoing' || rawSide === 'right' ? 'outgoing' : 'incoming';
    const kind = msg.kind || 'text';
    const confidence = confidenceFromWechat(msg.conf ?? msg.confidence ?? msg.text_confidence);
    const requiresReview = Boolean(msg.requires_screenshot_review || msg.requires_review);
    const speaker = msg.speaker || 'Unknown';
    const speakerUnknown = speaker === 'Unknown' && kind === 'text';
    const textReview = requiresReview && kind === 'text' && confidence !== null && Number(confidence) < 0.82;
    const lowConfidence = kind === 'text' && confidence !== null && Number(confidence) < 0.55;
    const riskMsg = {
      ...msg,
      conf: msg.conf ?? msg.confidence ?? msg.text_confidence,
      translation_risk_note_ko: msg.translation_risk_note_ko || '',
    };
    const effectiveRiskNote = effectiveWechatRiskNote(riskMsg, {
      kind,
      speaker,
      speakerSource: msg.speaker_source,
      side: direction,
      requiresReview,
    });
    const riskCategory = riskNoteCategory(effectiveRiskNote, kind);
    const attachmentReview = isAttachmentReviewMessage({ kind, speaker, confidence, riskNote: effectiveRiskNote });
    const textRequiresReview = kind === 'text' && (
      speakerUnknown ||
      textReview ||
      Boolean(effectiveRiskNote)
    );
    const effectiveRequiresReview = requiresReview && (kind === 'text' ? textRequiresReview : attachmentReview);
    const translationRisk = riskCategory === 'translation';
    const emojiReview = riskCategory === 'emoji';
    const quoteReview = riskCategory === 'quote';
    const speakerVisualReview = riskCategory === 'speaker_visual';
    const ocrNoteReview = riskCategory === 'ocr_text';
    const sourceReview = effectiveRequiresReview &&
      kind === 'text' &&
      !speakerUnknown &&
      !textReview &&
      !translationRisk &&
      !emojiReview &&
      !quoteReview &&
      !speakerVisualReview &&
      !ocrNoteReview;
    const sourceFlags = Array.isArray(msg.flags) ? msg.flags.map(String).filter(Boolean) : [];
    const source = msg.source || {};
    const bbox = Array.isArray(source.bbox)
      ? source.bbox.map((v) => (v === null || v === undefined ? null : Number(v)))
      : [msg.x, msg.y, msg.w, msg.h].map((v) => (v === null || v === undefined ? null : Number(v)));
    const frameFirst = msg.frame_first ?? source.frame_first ?? source.frame ?? null;
    const frameLast = msg.frame_last ?? source.frame_last ?? frameFirst;
    const flags = [
      sourceReview ? 'source_review' : '',
      emojiReview ? 'emoji_review' : '',
      quoteReview ? 'quote_review' : '',
      speakerVisualReview ? 'speaker_visual_review' : '',
      ocrNoteReview ? 'ocr_note_review' : '',
      speakerUnknown ? 'speaker_unknown' : '',
      msg.speaker_source ? `speaker:${msg.speaker_source}` : '',
      kind !== 'text' ? kind : '',
      attachmentReview ? 'attachment_review' : '',
      textReview ? 'text_review' : '',
      lowConfidence ? 'low_confidence' : '',
      translationRisk ? 'translation_risk' : '',
      ...sourceFlags,
    ].filter(Boolean);
    return {
      id: String(msg.message_key || msg.id || `${id}-m-${index + 1}`),
      platform: 'wechat',
      room_id: id,
      index,
      speaker,
      timestamp: msg.context_marker || null,
      direction,
      side: direction === 'outgoing' ? 'right' : 'left',
      text: msg.text || '',
      context_text: msg.context_marker || '',
      translation_ko: msg.translation_ko || '',
      translation_risk_note_ko: effectiveRiskNote,
      kind,
      confidence,
      requires_review: effectiveRequiresReview,
      flags,
      source: {
        dir,
        frame_first: frameFirst === null || frameFirst === undefined ? null : Number(frameFirst),
        frame_last: frameLast === null || frameLast === undefined ? null : Number(frameLast),
        bbox,
      },
      provider: 'wechat-json',
    };
  });
  const nonMessageArtifacts = filterWechatNonMessageArtifacts(messages);
  const visualDedupe = dedupeVisualOverlapMessages(nonMessageArtifacts.messages);
  const visibleMessages = visualDedupe.messages;
  const screenshot = existingRelativeFile(dir, ['crops/frame_000.png', 'frames/frame_000.png', 'frame_000.png', 'frame_001.png']);
  const stats = messagesDoc.stats || {};
  const frameCount = Number(stats.frames ?? manifest.capture?.frame_count ?? 0);
  const visibleUnknown = visibleMessages.filter((m) => m.speaker === 'Unknown' && m.kind === 'text').length;
  const visibleNonTextUnknown = visibleMessages.filter((m) => m.speaker === 'Unknown' && m.kind !== 'text').length;
  const visibleReviewRequired = visibleMessages.filter((m) => m.requires_review).length;
  const visibleSourceReview = visibleMessages.filter((m) => m.flags?.includes('source_review')).length;
  const visibleTextReview = visibleMessages.filter(isTextReviewMessage).length;
  const visibleNonText = visibleMessages.filter((m) => m.kind !== 'text').length;
  const visibleNonTextReview = visibleMessages.filter((m) => m.flags?.includes('attachment_review')).length;
  const visibleLow = visibleMessages.filter(isLowConfidenceMessage).length;
  const visibleRiskNotes = visibleMessages.filter((m) => m.translation_risk_note_ko).length;
  const visibleTranslationRisk = visibleMessages.filter((m) => isTranslationRiskNote(m.translation_risk_note_ko, m.kind)).length;
  const visibleEmojiReview = visibleMessages.filter((m) => riskNoteCategory(m.translation_risk_note_ko, m.kind) === 'emoji').length;
  const visibleQuoteReview = visibleMessages.filter((m) => riskNoteCategory(m.translation_risk_note_ko, m.kind) === 'quote').length;
  const visibleSpeakerVisualReview = visibleMessages.filter((m) => riskNoteCategory(m.translation_risk_note_ko, m.kind) === 'speaker_visual').length;
  const visibleOcrNoteReview = visibleMessages.filter((m) => riskNoteCategory(m.translation_risk_note_ko, m.kind) === 'ocr_text').length;
  const visibleTranslated = visibleMessages.filter((m) => m.translation_ko).length;
  const translationExpected = Boolean(
    visibleTranslated > 0 ||
    manifest.translation_provider ||
    manifest.privacy?.cloud_translation_requested ||
    existsSync(join(dir, 'wechat_translation_ko.json'))
  );
  const missingTranslationCount = translationExpected ? visibleMessages.length - visibleTranslated : 0;
  const maxFrames = Number(manifest.capture?.max_frames || 0);
  const hitMaxFrames = maxFrames > 0 && frameCount >= maxFrames;
  const qualityReview = visibleUnknown > 0
    || visibleReviewRequired > 0
    || visibleLow > 0
    || missingTranslationCount > 0
    || hitMaxFrames;
  const status = normalizeStatus(audit.status || manifest.quality?.status || 'review');
  const effectiveStatus = status === 'fail' ? 'fail' : (qualityReview || status === 'review' ? 'review' : 'pass');
  const elapsed = audit.metrics?.timings?.total_elapsed_s ?? manifest.timings?.total_elapsed_s ?? null;
  return {
    id,
    platform: 'wechat',
    label: `위챗 ${messagesDoc.room || manifest.room_label || basename(dir) || '(방)'}`,
    dir,
    status: effectiveStatus,
    message_count: visibleMessages.length,
    unknown_count: visibleUnknown,
    unknown_non_text_count: visibleNonTextUnknown,
    outgoing_count: visibleMessages.filter((m) => m.side === 'right').length,
    incoming_count: visibleMessages.filter((m) => m.side !== 'right').length,
    frame_count: Number.isFinite(frameCount) ? frameCount : 0,
    ocr_count: Number.isFinite(Number(stats.raw_ocr_lines)) ? Number(stats.raw_ocr_lines) : null,
    dedupe_count: visualDedupe.removed,
    hidden_artifact_count: nonMessageArtifacts.hidden,
    generated_at: messagesDoc.generated_at || manifest.created_at || audit.generated_at || null,
    audit: {
      schema: 'wechat_artifact_rollup.v1',
      status: audit.status || manifest.quality?.status || effectiveStatus,
      dir,
      issues: audit.issues || [],
      translated_count: visibleTranslated,
      missing_translation_count: missingTranslationCount,
      review_message_count: visibleSourceReview,
      review_required_count: visibleReviewRequired,
      source_review_count: visibleSourceReview,
      text_review_count: visibleTextReview,
      non_text_count: visibleNonText,
      non_text_review_count: visibleNonTextReview,
      non_text_unknown_count: visibleNonTextUnknown,
      low_confidence_count: visibleLow,
      risk_note_count: visibleRiskNotes,
      translation_risk_count: visibleTranslationRisk,
      emoji_review_count: visibleEmojiReview,
      quote_review_count: visibleQuoteReview,
      speaker_visual_review_count: visibleSpeakerVisualReview,
      ocr_note_review_count: visibleOcrNoteReview,
      visual_overlap_duplicates_removed: visualDedupe.removed,
      non_message_artifacts_hidden: nonMessageArtifacts.hidden,
      hit_max_frames: hitMaxFrames,
      max_frames: maxFrames || null,
      elapsed_s: elapsed,
      seconds_per_message: elapsed && visibleMessages.length ? Math.round((Number(elapsed) / visibleMessages.length) * 100) / 100 : null,
    },
    manifest,
    messages: visibleMessages,
    messages_doc: messagesDoc,
    screenshot_url: screenshot
      ? `/api/file?room=${encodeURIComponent(id)}&file=${encodeURIComponent(screenshot.file)}`
      : null,
    wechat: {
      artifact_dir: dir,
      translated_count: visibleTranslated,
      translation_expected: translationExpected,
      missing_translation_count: missingTranslationCount,
      review_message_count: visibleSourceReview,
      review_required_count: visibleReviewRequired,
      source_review_count: visibleSourceReview,
      text_review_count: visibleTextReview,
      non_text_count: visibleNonText,
      non_text_review_count: visibleNonTextReview,
      non_text_unknown_count: visibleNonTextUnknown,
      low_confidence_count: visibleLow,
      risk_note_count: visibleRiskNotes,
      translation_risk_count: visibleTranslationRisk,
      emoji_review_count: visibleEmojiReview,
      quote_review_count: visibleQuoteReview,
      speaker_visual_review_count: visibleSpeakerVisualReview,
      ocr_note_review_count: visibleOcrNoteReview,
      visual_overlap_duplicates_removed: visualDedupe.removed,
      non_message_artifacts_hidden: nonMessageArtifacts.hidden,
      hit_max_frames: hitMaxFrames,
    },
  };
}

function loadWechatRooms(db) {
  if (!existsSync(db)) throw new Error(`missing WeChat DB: ${db}`);
  const dbId = shortId('wechat-db', db);
  const rows = runSqlite(db, wechatRoomsSql());
  return rows.map((row) => {
    const id = shortId('wechat', `${db}:${row.room_key}`);
    const roomDir = row.latest_room_dir || db;
    const messageRows = runSqlite(db, wechatMessagesSql(row.room_key));
    const messages = messageRows.map((msg, index) => {
      const direction = msg.side === 'outgoing' ? 'outgoing' : 'incoming';
      const kind = msg.kind || 'text';
      const confidence = confidenceFromWechat(msg.conf);
      const requiresReview = Boolean(Number(msg.requires_screenshot_review || 0));
      const speaker = msg.speaker || 'Unknown';
      const speakerUnknown = speaker === 'Unknown' && kind === 'text';
      const textReview = requiresReview && kind === 'text' && confidence !== null && Number(confidence) < 0.82;
      const lowConfidence = kind === 'text' && confidence !== null && Number(confidence) < 0.55;
      const effectiveRiskNote = effectiveWechatRiskNote(msg, {
        kind,
        speaker,
        speakerSource: msg.speaker_source,
        side: msg.side,
        requiresReview,
      });
      const riskCategory = riskNoteCategory(effectiveRiskNote, kind);
      const attachmentReview = isAttachmentReviewMessage({ kind, speaker, confidence, riskNote: effectiveRiskNote });
      const textRequiresReview = kind === 'text' && (
        speakerUnknown ||
        textReview ||
        Boolean(effectiveRiskNote)
      );
      const effectiveRequiresReview = requiresReview && (kind === 'text' ? textRequiresReview : attachmentReview);
      const translationRisk = riskCategory === 'translation';
      const emojiReview = riskCategory === 'emoji';
      const quoteReview = riskCategory === 'quote';
      const speakerVisualReview = riskCategory === 'speaker_visual';
      const ocrNoteReview = riskCategory === 'ocr_text';
      const sourceReview = effectiveRequiresReview &&
        kind === 'text' &&
        !speakerUnknown &&
        !textReview &&
        !translationRisk &&
        !emojiReview &&
        !quoteReview &&
        !speakerVisualReview &&
        !ocrNoteReview;
      const flags = [
        sourceReview ? 'source_review' : '',
        emojiReview ? 'emoji_review' : '',
        quoteReview ? 'quote_review' : '',
        speakerVisualReview ? 'speaker_visual_review' : '',
        ocrNoteReview ? 'ocr_note_review' : '',
        speakerUnknown ? 'speaker_unknown' : '',
        msg.speaker_source ? `speaker:${msg.speaker_source}` : '',
        kind !== 'text' ? kind : '',
        attachmentReview ? 'attachment_review' : '',
        textReview ? 'text_review' : '',
        lowConfidence ? 'low_confidence' : '',
        translationRisk ? 'translation_risk' : '',
      ].filter(Boolean);
      return {
        id: msg.message_key || `${id}-m-${index + 1}`,
        platform: 'wechat',
        room_id: id,
        index,
        speaker,
        timestamp: msg.context_marker || null,
        direction,
        side: direction === 'outgoing' ? 'right' : 'left',
        text: msg.text || '',
        context_text: msg.context_marker || '',
        translation_ko: msg.translation_ko || '',
        translation_risk_note_ko: effectiveRiskNote,
        kind,
        confidence,
        requires_review: effectiveRequiresReview,
        flags,
        source: {
          db,
          batch_dir: msg.batch_dir || '',
          room_dir: msg.room_dir || '',
          frame_first: msg.frame_first ?? null,
          frame_last: msg.frame_last ?? null,
          bbox: [msg.x, msg.y, msg.w, msg.h].map((v) => (v === null || v === undefined ? null : Number(v))),
        },
        provider: 'wechat-sqlite',
      };
    });
    const nonMessageArtifacts = filterWechatNonMessageArtifacts(messages);
    const visualDedupe = dedupeVisualOverlapMessages(nonMessageArtifacts.messages);
    const visibleMessages = visualDedupe.messages;
    const latestRoomDirRaw = row.latest_room_dir || '';
    const screenshot = existingRelativeFile(latestRoomDirRaw, ['crops/frame_000.png', 'frames/frame_000.png']);
    const latestRoomDir = screenshot?.dir || hostReadableDir(latestRoomDirRaw) || '';
    const visibleUnknown = visibleMessages.filter((m) => m.speaker === 'Unknown' && m.kind === 'text').length;
    const visibleNonTextUnknown = visibleMessages.filter((m) => m.speaker === 'Unknown' && m.kind !== 'text').length;
    const visibleReviewRequired = visibleMessages.filter((m) => m.requires_review).length;
    const visibleSourceReview = visibleMessages.filter((m) => m.flags?.includes('source_review')).length;
    const visibleTextReview = visibleMessages.filter(isTextReviewMessage).length;
    const visibleNonText = visibleMessages.filter((m) => m.kind !== 'text').length;
    const visibleNonTextReview = visibleMessages.filter((m) => m.flags?.includes('attachment_review')).length;
    const visibleLow = visibleMessages.filter(isLowConfidenceMessage).length;
    const visibleRiskNotes = visibleMessages.filter((m) => m.translation_risk_note_ko).length;
    const visibleTranslationRisk = visibleMessages.filter((m) => isTranslationRiskNote(m.translation_risk_note_ko, m.kind)).length;
    const visibleEmojiReview = visibleMessages.filter((m) => riskNoteCategory(m.translation_risk_note_ko, m.kind) === 'emoji').length;
    const visibleQuoteReview = visibleMessages.filter((m) => riskNoteCategory(m.translation_risk_note_ko, m.kind) === 'quote').length;
    const visibleSpeakerVisualReview = visibleMessages.filter((m) => riskNoteCategory(m.translation_risk_note_ko, m.kind) === 'speaker_visual').length;
    const visibleOcrNoteReview = visibleMessages.filter((m) => riskNoteCategory(m.translation_risk_note_ko, m.kind) === 'ocr_text').length;
    const visibleTranslated = visibleMessages.filter((m) => m.translation_ko).length;
    const missingTranslationCount = visibleMessages.length - visibleTranslated;
    const hitMaxFrames = Number(row.max_frames || 0) > 0 && Number(row.frames || 0) >= Number(row.max_frames || 0);
    const qualityReview = visibleUnknown > 0
      || visibleReviewRequired > 0
      || visibleLow > 0
      || missingTranslationCount > 0
      || hitMaxFrames;
    const status = normalizeStatus(row.audit_status || row.latest_status || 'review');
    const effectiveStatus = status === 'fail' ? 'fail' : (qualityReview ? 'review' : 'pass');
    return {
      id,
      platform: 'wechat',
      label: `위챗 ${row.label || '(방)'}`,
      dir: latestRoomDir || db,
      status: effectiveStatus,
      message_count: visibleMessages.length,
      unknown_count: visibleUnknown,
      unknown_non_text_count: visibleNonTextUnknown,
      outgoing_count: visibleMessages.filter((m) => m.side === 'right').length,
      incoming_count: visibleMessages.filter((m) => m.side !== 'right').length,
      frame_count: Number(row.frames || 0),
      ocr_count: null,
      dedupe_count: visualDedupe.removed,
      hidden_artifact_count: nonMessageArtifacts.hidden,
      generated_at: row.last_seen_at || row.first_seen_at || null,
      audit: {
        schema: 'wechat_db_rollup.v1',
        status: row.audit_status || row.latest_status || 'review',
        db,
        db_id: dbId,
        room_key: row.room_key,
        latest_status: row.latest_status,
        latest_room_dir: row.latest_room_dir,
        latest_room_dir_local: latestRoomDir || null,
        translated_count: visibleTranslated,
        missing_translation_count: missingTranslationCount,
        review_message_count: visibleSourceReview,
        review_required_count: visibleReviewRequired,
        source_review_count: visibleSourceReview,
        text_review_count: visibleTextReview,
        non_text_count: visibleNonText,
        non_text_review_count: visibleNonTextReview,
        non_text_unknown_count: visibleNonTextUnknown,
        low_confidence_count: visibleLow,
        risk_note_count: visibleRiskNotes,
        translation_risk_count: visibleTranslationRisk,
        emoji_review_count: visibleEmojiReview,
        quote_review_count: visibleQuoteReview,
        speaker_visual_review_count: visibleSpeakerVisualReview,
        ocr_note_review_count: visibleOcrNoteReview,
        visual_overlap_duplicates_removed: visualDedupe.removed,
        non_message_artifacts_hidden: nonMessageArtifacts.hidden,
        hit_max_frames: hitMaxFrames,
        max_frames: row.max_frames ?? null,
        elapsed_s: row.elapsed_s ?? null,
      },
      manifest: {},
      messages: visibleMessages,
      screenshot_url: screenshot
        ? `/api/file?room=${encodeURIComponent(id)}&file=${encodeURIComponent(screenshot.file)}`
        : null,
      wechat: {
        db,
        translated_count: visibleTranslated,
        missing_translation_count: missingTranslationCount,
        review_message_count: visibleSourceReview,
        review_required_count: visibleReviewRequired,
        source_review_count: visibleSourceReview,
        text_review_count: visibleTextReview,
        non_text_count: visibleNonText,
        non_text_review_count: visibleNonTextReview,
        non_text_unknown_count: visibleNonTextUnknown,
        low_confidence_count: visibleLow,
        risk_note_count: visibleRiskNotes,
        translation_risk_count: visibleTranslationRisk,
        emoji_review_count: visibleEmojiReview,
        quote_review_count: visibleQuoteReview,
        speaker_visual_review_count: visibleSpeakerVisualReview,
        ocr_note_review_count: visibleOcrNoteReview,
        visual_overlap_duplicates_removed: visualDedupe.removed,
        non_message_artifacts_hidden: nonMessageArtifacts.hidden,
        hit_max_frames: hitMaxFrames,
      },
    };
  });
}

function loadRooms() {
  const rooms = [];
  for (const dir of uniqueDirs(options.kakaoDirs)) {
    try { rooms.push(loadKakaoRoom(dir)); } catch (err) { console.error(`skip Kakao source: ${err.message}`); }
  }
  for (const dir of uniqueDirs(options.kakaoOpenchatDirs)) {
    try { rooms.push(loadOpenchatRoom(dir)); } catch (err) { console.error(`skip Kakao openchat source: ${err.message}`); }
  }
  if (discordEnabled) {
    for (const dir of uniqueDirs(options.discordDirs)) {
      try { rooms.push(loadDiscordRoom(dir)); } catch (err) { console.error(`skip Discord source: ${err.message}`); }
    }
  }
  for (const dir of uniqueDirs(options.wechatDirs)) {
    try { rooms.push(loadWechatArtifactRoom(dir)); } catch (err) { console.error(`skip WeChat source: ${err.message}`); }
  }
  for (const db of uniqueDirs(options.wechatDbs)) {
    try { rooms.push(...loadWechatRooms(db)); } catch (err) { console.error(`skip WeChat DB: ${err.message}`); }
  }
  const visibleRooms = options.autoDedupe ? dedupeAutoRooms(rooms) : rooms;
  visibleRooms.sort((a, b) => (b.generated_at || '').localeCompare(a.generated_at || '') || b.message_count - a.message_count);
  return visibleRooms;
}

function dedupeAutoRooms(rooms) {
  const buckets = new Map();
  const passthrough = [];
  for (const room of rooms) {
    if (!['kakao', 'kakao_openchat'].includes(room.platform)) {
      passthrough.push(room);
      continue;
    }
    const key = `${room.platform}\u0000${roomLabelKey(room.label)}`;
    if (!roomLabelKey(room.label)) {
      passthrough.push(room);
      continue;
    }
    const current = buckets.get(key);
    if (!current || roomQualityScore(room) > roomQualityScore(current)) buckets.set(key, room);
  }
  return [...passthrough, ...buckets.values()];
}

function roomLabelKey(label) {
  return String(label || '')
    .replace(/\s*댓글포함\s*$/u, '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase();
}

function roomQualityScore(room) {
  const status = normalizeStatus(room.status);
  const statusScore = status === 'pass' ? 4 : (status === 'review' ? 3 : (status === 'fail' ? 1 : 0));
  const messageCount = Number(room.message_count || 0);
  const unknownCount = Number(room.unknown_count || 0);
  const unknownRatio = messageCount > 0 ? unknownCount / messageCount : 1;
  const providerScore = room.messages_doc?.provider === 'codex-vision' ? 2 : 0;
  const warningCount = qualityWarnings(room).length;
  const generated = Date.parse(room.generated_at || '') || mtimeMs(room.dir || '');
  return statusScore * 1_000_000_000 +
    providerScore * 100_000_000 +
    Math.round((1 - unknownRatio) * 10_000_000) +
    Math.min(messageCount, 10000) * 1000 -
    warningCount * 500 -
    unknownCount * 100 +
    Math.floor(generated / 100000);
}

let rooms = loadRooms();
const roomMap = new Map(rooms.map((room) => [room.id, room]));

function refreshRooms() {
  if (autoDiscoveryActive) applyAutoDiscovery();
  rooms = loadRooms();
  roomMap.clear();
  for (const room of rooms) roomMap.set(room.id, room);
}

function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function sendError(res, status, message) {
  const text = String(message || '');
  const labels = new Map([
    ['not found', { code: 'RESULT_PAGE_NOT_FOUND', error: '요청한 결과 화면을 찾지 못했습니다. 결과 보기를 새로고침하거나 백업 화면으로 돌아가세요.' }],
    ['room not found', { code: 'RESULT_ROOM_NOT_FOUND', error: '요청한 백업 결과를 찾지 못했습니다. 결과 새로고침을 누르세요.' }],
    ['file not found', { code: 'RESULT_FILE_NOT_FOUND', error: '요청한 결과 파일을 열 수 없습니다. 결과 새로고침을 누르세요.' }],
    ['missing file', { code: 'RESULT_FILE_MISSING', error: '열 결과 파일이 지정되지 않았습니다. 결과 화면에서 다시 열어 주세요.' }],
    ['method not allowed', { code: 'RESULT_METHOD_NOT_ALLOWED', error: '이 요청 방식은 사용할 수 없습니다. 결과 화면에서 다시 시도하세요.' }],
    ['forbidden', { code: 'RESULT_FILE_FORBIDDEN', error: '요청한 결과 파일을 열 수 없습니다.' }],
  ]);
  sendJson(res, status, labels.get(text) || { code: 'RESULT_REQUEST_FAILED', error: '요청을 처리하지 못했습니다. 결과 화면을 새로고침한 뒤 다시 시도하세요.' });
}

function htmlAttr(value) {
  return String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/"/gu, '&quot;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}

function sendMissingStaticPage(res) {
  const consoleUrl = knownConsoleUrl();
  const consoleHref = consoleUrl ? `${consoleUrl}/chats` : '/';
  const body = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>결과 보기 다시 열기</title>
  <style>
    body { margin: 0; font-family: "Malgun Gothic", system-ui, sans-serif; background: #f6f8fb; color: #17202a; }
    main { max-width: 720px; margin: 12vh auto; padding: 32px; background: #fff; border: 1px solid #dce3ec; border-radius: 8px; box-shadow: 0 16px 40px rgba(15, 23, 42, .08); }
    h1 { margin: 0 0 12px; font-size: 24px; }
    p { margin: 10px 0; line-height: 1.7; }
    a { color: #0f766e; font-weight: 800; }
  </style>
</head>
<body>
  <main data-smoke-id="result-recovery">
    <h1>결과 보기 화면을 다시 열어 주세요</h1>
    <p>지금 주소는 오래되었거나 잘못된 결과 보기 주소입니다.</p>
    <p><a href="${htmlAttr(consoleHref)}">백업 화면의 결과 보기로 돌아가기</a>를 누르거나, 압축을 푼 폴더의 <strong>1_백업_시작.bat</strong>를 다시 실행하세요.</p>
    <p>아무 값도 입력하지 않습니다.</p>
  </main>
</body>
</html>`;
  res.writeHead(404, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function consoleUrlFromStateFile() {
  const candidates = [
    pathConfig.stateDirWsl ? join(pathConfig.stateDirWsl, 'console_url.txt') : '',
    pathConfig.stateDirWin ? join(pathConfig.stateDirWin, 'console_url.txt') : '',
  ].filter(Boolean);
  for (const file of [...new Set(candidates)]) {
    try {
      if (!existsSync(file) || !statSync(file).isFile()) continue;
      const match = readFileSync(file, 'utf8').match(/https?:\/\/[^\s<>"']+/u);
      const found = normalizeConsoleUrl(match?.[0] || '');
      if (found) return found;
    } catch {
      // Stale or unreadable address files should not break the result viewer.
    }
  }
  return '';
}

function normalizedLoopbackHost(hostname) {
  const value = String(hostname || '').toLowerCase();
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(value) ? 'loopback' : value;
}

function defaultPort(protocol) {
  return protocol === 'https:' ? 443 : 80;
}

function isCurrentViewerUrl(value) {
  try {
    const url = new URL(value);
    const urlPort = Number(url.port || defaultPort(url.protocol));
    const currentPort = Number(options.port || defaultPort(url.protocol));
    return urlPort === currentPort && normalizedLoopbackHost(url.hostname) === normalizedLoopbackHost(options.host);
  } catch {
    return false;
  }
}

function knownConsoleUrl() {
  const explicit = options.consoleUrl;
  if (explicit && !isCurrentViewerUrl(explicit)) return explicit;
  const fromState = consoleUrlFromStateFile();
  return fromState && !isCurrentViewerUrl(fromState) ? fromState : '';
}

function isConsoleScreenPath(pathname) {
  return /^\/(?:backup|agent|jobs|doctor|chats|settings)(?:\/.*)?$/u.test(pathname);
}

function sendConsoleScreenRecovery(res) {
  const body = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>백업 화면 다시 열기</title>
  <style>
    body { margin: 0; font-family: "Malgun Gothic", system-ui, sans-serif; background: #f6f8fb; color: #17202a; }
    main { max-width: 720px; margin: 12vh auto; padding: 32px; background: #fff; border: 1px solid #dce3ec; border-radius: 8px; box-shadow: 0 16px 40px rgba(15, 23, 42, .08); }
    h1 { margin: 0 0 12px; font-size: 24px; }
    p { margin: 10px 0; line-height: 1.7; }
    strong { color: #0f766e; }
  </style>
</head>
<body>
  <main>
    <h1>백업 화면을 다시 열어 주세요</h1>
    <p>지금 주소는 <strong>백업 결과 보기</strong> 주소입니다. 위챗이나 카카오톡 백업 화면 주소가 아닙니다.</p>
    <p>압축을 푼 폴더에서 <strong>1_백업_시작.bat</strong>를 다시 실행하거나, <strong>2_백업_화면.url</strong>을 더블클릭하세요.</p>
    <p>다음 실행부터는 결과 보기 주소로 백업 화면을 열어도 자동으로 올바른 화면으로 이동합니다.</p>
  </main>
</body>
</html>`;
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function recoverConsoleScreenRequest(res, url) {
  if (!isConsoleScreenPath(url.pathname)) return false;
  const consoleUrl = knownConsoleUrl();
  if (consoleUrl) {
    res.writeHead(302, {
      location: `${consoleUrl}${url.pathname}${url.search}`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end();
  } else {
    sendConsoleScreenRecovery(res);
  }
  return true;
}

function publicRoom(room) {
  return {
    id: room.id,
    platform: room.platform,
    label: room.label,
    status: room.status,
    message_count: room.message_count,
    unknown_count: room.unknown_count,
    unknown_non_text_count: room.unknown_non_text_count || room.wechat?.non_text_unknown_count || 0,
    outgoing_count: room.outgoing_count,
    incoming_count: room.incoming_count,
    frame_count: room.frame_count,
    ocr_count: room.ocr_count,
    dedupe_count: room.dedupe_count || room.openchat?.duplicates_removed || 0,
    hidden_artifact_count: room.hidden_artifact_count || room.wechat?.non_message_artifacts_hidden || 0,
    generated_at: room.generated_at,
    dir: room.dir,
    screenshot_url: room.screenshot_url || null,
    quality_warnings: qualityWarnings(room),
    elapsed_s: room.audit?.elapsed_s ?? room.manifest?.elapsed_s ?? null,
    seconds_per_message: room.audit?.seconds_per_message ?? null,
    audit: room.audit,
    kakao: room.kakao || null,
    openchat: room.openchat || null,
    wechat: room.wechat || null,
  };
}

function filterRooms(url) {
  const platform = url.searchParams.get('platform') || 'all';
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const status = url.searchParams.get('status') || '';
  return rooms.filter((room) => {
    if (platform !== 'all') {
      if (platform === 'chat' || platform === 'kakao_wechat') {
        if (!String(room.platform).startsWith('kakao') && room.platform !== 'wechat') return false;
      } else if (platform === 'kakao') {
        if (!String(room.platform).startsWith('kakao')) return false;
      } else if (platform === 'wechat') {
        if (room.platform !== 'wechat') return false;
      } else if (room.platform !== platform) {
        return false;
      }
    }
    if (status && room.status !== status) return false;
    if (q && !`${room.label} ${room.platform} ${room.status}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function filterMessages(room, url) {
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  if (!q) return room.messages;
  return room.messages.filter((msg) => `${msg.text} ${msg.context_text || ''} ${msg.translation_ko || ''} ${msg.translation_risk_note_ko || ''} ${msg.speaker} ${msg.timestamp || ''} ${(msg.flags || []).join(' ')}`.toLowerCase().includes(q));
}

function compactIssueLabel(message) {
  const text = String(message || '').trim();
  const lower = text.toLowerCase();
  if (!text) return '';
  if (lower.includes('short scrape') || lower.includes('max-frames')) return '이력 확인';
  if (lower.includes('room-label fallback speaker')) return '발신자 확인';
  if (lower.includes('unknown')) return '발신자 확인';
  if (lower.includes('low-confidence') || lower.includes('low confidence')) return '글자 확인';
  if (lower.includes('non-text') || lower.includes('attachment') || lower.includes('media')) return '첨부/미디어 확인';
  if (lower.includes('translation')) return '번역 확인';
  return text.length > 28 ? `${text.slice(0, 27)}…` : text;
}

function qualityWarnings(room) {
  const warnings = [];
  const add = (code, label, severity = 'review', detail = '') => {
    if (!label) return;
    if (warnings.some((item) => item.code === code && item.label === label)) return;
    warnings.push({ code, label, severity, detail });
  };

  for (const issue of room.audit?.issues || room.audit?.findings || []) {
    const severity = normalizeStatus(issue.severity || issue.status || 'review');
    const message = issue.message || issue.detail || issue.reason || '';
    if (room.platform === 'kakao' && /room-label fallback speaker/iu.test(message)) continue;
    add(`audit_${warnings.length + 1}`, compactIssueLabel(message), severity === 'fail' ? 'danger' : 'review', message);
  }

  if (room.unknown_count) {
    const unknownRatio = Number(room.message_count || 0) > 0 ? Number(room.unknown_count) / Number(room.message_count) : 0;
    add('speaker_unknown', `발신자 확인 ${room.unknown_count}`, unknownRatio >= 0.2 ? 'danger' : 'warn', '발신자를 원본 화면에서 확인해야 하는 메시지');
  }
  if (room.kakao?.split_fragment_pairs) {
    add('kakao_split_fragments', `말풍선 확인 ${room.kakao.split_fragment_pairs}`, 'review', '카카오톡 화면 글자 줄이 아직 같은 말풍선으로 합쳐지지 않았을 수 있음');
  }
  if (room.kakao?.speaker_room_label_fallback_messages) {
    add('kakao_speaker_fallback', `발신자 확인 ${room.kakao.speaker_room_label_fallback_messages}`, 'warn', '카카오톡 발신자명이 화면에 보이지 않아 방 이름으로 임시 표시한 메시지');
  }
  if (room.kakao?.hit_max_frames) add('history_incomplete', '이력 확인', 'review', '캡처 수 한도에 도달해 더 오래된 대화가 남았을 수 있음');
  if (room.wechat?.hit_max_frames) add('history_incomplete', '이력 확인', 'review', '캡처 수 한도에 도달해 더 오래된 대화가 남았을 수 있음');
  if (room.wechat?.source_review_count || room.wechat?.review_message_count) {
    const count = room.wechat.source_review_count || room.wechat.review_message_count;
    add('source_review', `원본 확인 ${count}`, 'review', '원본 화면에서 직접 확인하면 좋은 항목');
  }
  if (room.wechat?.text_review_count) add('text_review', `글자 확인 ${room.wechat.text_review_count}`, 'warn', '화면 글자 인식이 불확실한 메시지');
  if (room.wechat?.low_confidence_count) add('low_confidence', `글자 확인 ${room.wechat.low_confidence_count}`, 'warn', '화면 글자 인식이 매우 불확실한 메시지');
  if (room.wechat?.non_text_review_count) add('non_text_review', `첨부/미디어 확인 ${room.wechat.non_text_review_count}`, 'review', '발신자나 원본 구분이 불확실한 첨부/미디어 항목');
  if (room.wechat?.missing_translation_count) add('missing_translation', `번역 확인 ${room.wechat.missing_translation_count}`, 'warn', '한국어 번역이 저장되지 않은 메시지');

  const translationRisk = room.wechat?.translation_risk_count ?? (room.messages?.filter((msg) => isTranslationRiskNote(msg.translation_risk_note_ko, msg.kind)).length || 0);
  if (translationRisk) add('translation_risk', `번역 확인 ${translationRisk}`, 'warn', '원문과 번역을 함께 확인하면 좋은 메시지');
  if (room.wechat?.emoji_review_count) add('emoji_review', `이모지 확인 ${room.wechat.emoji_review_count}`, 'warn', '플랫폼에 따라 이모지 표시가 달라질 수 있는 메시지');
  if (room.wechat?.quote_review_count) add('quote_review', `답장/인용 확인 ${room.wechat.quote_review_count}`, 'review', '답장/인용 미리보기나 참조 텍스트가 포함된 메시지');
  if (room.wechat?.speaker_visual_review_count) add('speaker_visual_review', `발신자 확인 ${room.wechat.speaker_visual_review_count}`, 'warn', '발신자명 표시가 작거나 일부만 보여 확인이 필요한 메시지');
  if (room.wechat?.ocr_note_review_count) add('ocr_note_review', `글자 확인 ${room.wechat.ocr_note_review_count}`, 'warn', '시각적으로 모호한 글자가 있는 메시지');

  return warnings.slice(0, 20);
}

function isInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !rel.includes(`..${sep}`));
}

function mimeType(file) {
  const ext = extname(file).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.txt' || ext === '.md') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function isServedArtifactImage(file) {
  return ['.png', '.jpg', '.jpeg', '.webp'].includes(extname(file).toLowerCase());
}

function serveStatic(req, res, url) {
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = resolve(options.staticDir, `.${pathname}`);
  if (!isInside(file, options.staticDir) || !existsSync(file) || !statSync(file).isFile()) {
    sendMissingStaticPage(res);
    return;
  }
  res.writeHead(200, {
    'content-type': mimeType(file),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(readFileSync(file));
}

function serveArtifactFile(res, url) {
  const room = roomMap.get(url.searchParams.get('room') || '');
  if (!room) return sendError(res, 404, 'room not found');
  const requested = url.searchParams.get('file') || '';
  if (!requested || requested.includes('\0')) return sendError(res, 400, 'missing file');
  const file = resolve(room.dir, requested);
  if (!isInside(file, room.dir) || !existsSync(file) || !statSync(file).isFile()) {
    return sendError(res, 404, 'file not found');
  }
  if (!isServedArtifactImage(file)) {
    return sendError(res, 404, 'file not found');
  }
  res.writeHead(200, {
    'content-type': mimeType(file),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(readFileSync(file));
}

function routeApi(req, res, url) {
  if (url.pathname === '/api/refresh') {
    refreshRooms();
    return sendJson(res, 200, { ok: true, rooms: rooms.length });
  }
  if (url.pathname === '/api/health') {
    const healthRooms = url.searchParams.has('platform') || url.searchParams.has('status') || url.searchParams.has('q')
      ? filterRooms(url)
      : rooms;
    const messages = healthRooms.reduce((sum, room) => sum + room.message_count, 0);
    const unknown = healthRooms.reduce((sum, room) => sum + room.unknown_count, 0);
    const dedupe = healthRooms.reduce((sum, room) => sum + Number(room.dedupe_count || room.openchat?.duplicates_removed || 0), 0);
    const warningTotal = healthRooms.reduce((sum, room) => sum + qualityWarnings(room).length, 0);
    return sendJson(res, 200, {
      schema: 'chat_artifact_viewer.health.v1',
      instance: {
        rootHash: instanceRootHash,
      },
      runtime: {
        platform: process.platform,
      },
      capabilities: {
        kakao: true,
        wechat: true,
        discord: discordEnabled,
      },
      counts: {
        rooms: healthRooms.length,
        pass_rooms: healthRooms.filter((room) => room.status === 'pass').length,
        review_rooms: healthRooms.filter((room) => room.status === 'review').length,
        fail_rooms: healthRooms.filter((room) => room.status === 'fail').length,
        skip_rooms: healthRooms.filter((room) => room.status === 'skip').length,
        kakao_rooms: healthRooms.filter((room) => room.platform === 'kakao').length,
        kakao_openchat_rooms: healthRooms.filter((room) => room.platform === 'kakao_openchat').length,
        discord_rooms: healthRooms.filter((room) => room.platform === 'discord').length,
        wechat_rooms: healthRooms.filter((room) => room.platform === 'wechat').length,
        messages,
        unknown,
        quality_warnings: warningTotal,
        dedupe_removed: dedupe,
      },
    });
  }
  if (url.pathname === '/api/rooms') {
    return sendJson(res, 200, { rooms: filterRooms(url).map(publicRoom) });
  }
  if (url.pathname === '/api/file') {
    return serveArtifactFile(res, url);
  }

  const match = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/messages)?$/);
  if (match) {
    const room = roomMap.get(decodeURIComponent(match[1]));
    if (!room) return sendError(res, 404, 'room not found');
    if (url.pathname.endsWith('/messages')) {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 20000) || 20000, 1), 50000);
      return sendJson(res, 200, { messages: filterMessages(room, url).slice(0, limit) });
    }
    return sendJson(res, 200, { room: publicRoom(room) });
  }

  return sendError(res, 404, 'not found');
}

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    if (recoverConsoleScreenRequest(res, url)) return;
    if (url.pathname.startsWith('/api/')) routeApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (err) {
    sendError(res, 500, err?.message || String(err));
  }
});

server.listen(options.port, options.host, () => {
  const addr = server.address();
  console.log(`Chat artifact viewer listening on http://${options.host}:${addr.port}`);
  const discordText = discordEnabled ? `Discord ${options.discordDirs.length}` : 'Discord disabled';
  console.log(`Sources: Kakao ${options.kakaoDirs.length}, Kakao openchat ${options.kakaoOpenchatDirs.length}, ${discordText}, WeChat ${options.wechatDirs.length}, WeChat DB ${options.wechatDbs.length}`);
  if (options.host !== '127.0.0.1' && options.host !== 'localhost') {
    console.log('Warning: non-local bind requested; the viewer can expose private chat text.');
  }
});
