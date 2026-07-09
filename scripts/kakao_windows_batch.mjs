#!/usr/bin/env node
// Windows-native KakaoTalk visible-list backup.
//
// Captures the KakaoTalk left chat list, scrolls through it when requested,
// opens detected rooms, and reuses kakao_regular_chat.mjs for each room. It
// does not read or decrypt private KakaoTalk database files.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPathConfig } from './lib/path_config.mjs';
import { parseArgs, readJson, run, sanitizeFileName, timestamp, writeJson } from './lib/cu_common.mjs';

const args = parseArgs();
const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const pathConfig = loadPathConfig();

function usage() {
  console.log(`usage:
  node scripts/kakao_windows_batch.mjs --confirm-local-backup [options]

Options:
  --proc NAME              KakaoTalk process name (default: KakaoTalk)
  --hwnd N                 exact KakaoTalk main window handle
  --main-title TITLE       main window title hint (default: 카카오톡)
  --pages N                max visible-list pages to scan (default: 1, --all-visible default: 80)
  --room-limit N           max rooms to back up (default: 5, --all-visible default: 200)
  --max-visible-rooms N    max candidates per page (default: 30)
  --max-frames N           frames per room backup (default: 120)
  --room-retries N         retry failed room open/backup attempts (default: 1)
  --list-crop auto|WxH+X+Y left list region in window pixels (default: auto)
  --ocr-lang LANG          Windows OCR language hint (default: ko)
  --out-dir DIR            output directory (default: shots\\kakao_batch_windows_*)
  --all-visible            keep scrolling the left list until no new rooms appear
  --stop-after-duplicate-pages N
                           stop --all-visible after N pages with no new room (default: 2)
  --dry-run                only show detected list candidates; do not click rooms`);
}

function windowsPathToLocal(path) {
  const text = String(path || '').trim();
  if (process.platform === 'win32') return text;
  return text.replace(/^([A-Za-z]):/u, (_, drive) => `/mnt/${drive.toLowerCase()}`).replace(/\\/g, '/');
}

function localPathToWindows(path) {
  const text = String(path || '').trim();
  if (process.platform === 'win32') return text;
  return text.replace(/^\/mnt\/([a-z])\//iu, (_, drive) => `${drive.toUpperCase()}:\\`).replace(/\//g, '\\');
}

function pngSize(file) {
  const buf = readFileSync(file);
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function intArg(name, fallback, min, max) {
  const n = Number(args[name] || fallback);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be ${min}-${max}`);
  return n;
}

function textArg(name, fallback = '') {
  return String(args[name] || fallback || '').trim();
}

function boolArg(name) {
  return Boolean(args[name] && args[name] !== 'false');
}

function parseRegion(spec, label = 'region') {
  const match = String(spec || '').match(/^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/u);
  if (!match) throw new Error(`invalid ${label}: ${spec}`);
  return {
    spec: String(spec),
    width: Number(match[1]),
    height: Number(match[2]),
    x: Number(match[3]),
    y: Number(match[4]),
  };
}

function autoListRegion(width, height) {
  const listW = Math.max(320, Math.min(width, Math.floor(width * 0.98)));
  const listY = Math.max(64, Math.floor(height * 0.08));
  const listH = Math.max(220, height - listY - 44);
  return parseRegion(`${listW}x${listH}+0+${listY}`, 'list-crop');
}

function sleepMs(ms) {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, Math.max(0, Number(ms) || 0));
}

function normalizedKey(text) {
  return String(text || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

function runChecked(label, cmd, commandArgs, options = {}) {
  const result = run(cmd, commandArgs, { cwd: repo, ...options });
  if (result.stderr) process.stderr.write(result.stderr || '');
  if (!result.ok) {
    const detail = result.stderr || result.stdout || result.error?.message || `exit ${result.status}`;
    throw new Error(`${label} 실패: ${detail}`);
  }
  return result;
}

function psKakao(cmd, extraArgs = [], { allowFail = false } = {}) {
  const commandArgs = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    `${pathConfig.scriptsDirWin}\\kakao_window.ps1`,
    cmd,
    ...extraArgs,
  ];
  const result = run('powershell.exe', commandArgs, { cwd: repo });
  if (result.stderr) process.stderr.write(result.stderr || '');
  if (!result.ok && !allowFail) {
    const detail = result.stderr || result.stdout || result.error?.message || `exit ${result.status}`;
    throw new Error(`KakaoTalk ${cmd} 실패: ${detail}`);
  }
  return result;
}

function ocrImage(imageLocal, jsonLocal, lang) {
  const ocr = runChecked('Windows OCR', 'powershell.exe', [
    '-NoProfile',
    '-STA',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    `${pathConfig.scriptsDirWin}\\ocr_lines.ps1`,
    localPathToWindows(imageLocal),
    lang,
  ]);
  writeFileSync(jsonLocal, ocr.stdout || '[]\n', 'utf8');
}

function nodeJson(label, script, scriptArgs) {
  const result = runChecked(label, process.execPath, [join(repo, 'scripts', script), ...scriptArgs]);
  try {
    return JSON.parse(result.stdout || '{}');
  } catch (err) {
    throw new Error(`${label} JSON 파싱 실패: ${err.message}`);
  }
}

function parseRect(text) {
  const match = String(text || '').match(/rect=([-\d]+),([-\d]+),([-\d]+),([-\d]+)/u);
  if (!match) return null;
  const left = Number(match[1]);
  const top = Number(match[2]);
  const right = Number(match[3]);
  const bottom = Number(match[4]);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function parseHwnd(text) {
  return String(text || '').match(/hwnd=(\d+)/u)?.[1] || '';
}

function captureMain(outPath) {
  const common = ['-OutPath', localPathToWindows(outPath)];
  if (hwnd) common.push('-Hwnd', hwnd);
  else {
    common.push('-ProcName', proc);
    if (mainTitle) common.push('-Title', mainTitle);
  }
  let capture = psKakao('capture', common, { allowFail: !hwnd && mainTitle === '카카오톡' });
  if (!capture.ok && !hwnd && mainTitle === '카카오톡') {
    capture = psKakao('capture', ['-ProcName', proc, '-OutPath', localPathToWindows(outPath)]);
  }
  const text = `${capture.stdout || ''}\n${capture.stderr || ''}`;
  const parsedHwnd = parseHwnd(text);
  const rect = parseRect(text);
  if (!parsedHwnd || !rect) throw new Error(`KakaoTalk main window geometry not found: ${text.trim()}`);
  mainHwnd = parsedHwnd;
  mainRect = rect;
  return { hwnd: parsedHwnd, rect };
}

function listKakaoWindows() {
  const list = psKakao('list', ['-ProcName', proc], { allowFail: true });
  if (!list.ok) return [];
  return String(list.stdout || '').split(/\r?\n/u).map((line) => {
    const hwndValue = line.match(/hwnd=(\d+)/u)?.[1] || '';
    const title = line.match(/\btitle=(.*)$/u)?.[1]?.trim() || '';
    const rect = parseRect(line);
    return hwndValue ? { hwnd: hwndValue, title, rect } : null;
  }).filter(Boolean);
}

function isMainKakaoWindow(win) {
  const title = String(win?.title || '').trim();
  return !title || title === '카카오톡' || title === 'KakaoTalk';
}

function titleMatchesLabel(title, label) {
  const titleKey = normalizedKey(title);
  const labelKey = normalizedKey(label);
  if (!titleKey || !labelKey) return false;
  return titleKey === labelKey || titleKey.includes(labelKey) || labelKey.includes(titleKey);
}

function resolveOpenedChatWindow(beforeWindows, afterWindows, label) {
  const beforeHwnds = new Set(beforeWindows.map((win) => String(win.hwnd)));
  const chatWindows = afterWindows.filter((win) => !isMainKakaoWindow(win));
  const newChats = chatWindows.filter((win) => !beforeHwnds.has(String(win.hwnd)));
  const newMatch = newChats.find((win) => titleMatchesLabel(win.title, label));
  if (newMatch) return { window: newMatch, method: 'new_title_match' };
  if (newChats.length === 1) return { window: newChats[0], method: 'new_window' };
  if (newChats.length > 1) {
    const newest = [...newChats].sort((a, b) => Number(BigInt(b.hwnd) - BigInt(a.hwnd)))[0];
    return { window: newest, method: 'new_window_latest' };
  }
  const existingMatch = chatWindows.find((win) => titleMatchesLabel(win.title, label));
  if (existingMatch) return { window: existingMatch, method: 'existing_title_match' };
  return { window: null, method: 'not_found' };
}

function scrollList(notches, size, listRegion) {
  const fx = Math.max(0.05, Math.min(0.95, (listRegion.x + listRegion.width * 0.48) / Math.max(1, size.width)));
  const fy = Math.max(0.08, Math.min(0.94, (listRegion.y + listRegion.height * 0.52) / Math.max(1, size.height)));
  psKakao('scroll', ['-Hwnd', mainHwnd, '-Fx', fx.toFixed(3), '-Fy', fy.toFixed(3), '-Notches', String(notches)]);
}

function resetListToTop(size, listRegion) {
  if (!allVisible || boolArg('no-reset-to-top')) return;
  console.log('  목록 시작 위치를 위쪽으로 맞춥니다...');
  for (let i = 0; i < resetScrolls; i++) {
    scrollList(8, size, listRegion);
    sleepMs(120);
  }
  sleepMs(pageWaitMs);
}

function writeManifest(file, manifest) {
  manifest.updated_at = new Date().toISOString();
  writeJson(file, manifest);
}

function attentionRooms(manifest) {
  return (manifest.rooms || []).filter((room) => {
    const status = String(room.audit_status || room.scrape_status || '').toLowerCase();
    return status && !['pass', 'skipped_duplicate_title'].includes(status);
  });
}

function attentionStatusLabel(status) {
  const key = String(status || '').toLowerCase();
  if (key === 'review') return '확인 필요';
  if (key === 'open_failed') return '방 열기 실패';
  if (['fail', 'failed', 'missing'].includes(key)) return '백업 실패';
  if (key.startsWith('skipped')) return '건너뜀';
  return '확인 필요';
}

function attentionReasonLabel(reason) {
  const text = String(reason || '').trim();
  if (!text) return '';
  if (text.includes('opened KakaoTalk chat window was not found')) return '채팅창을 찾지 못했습니다';
  if (text.includes('selected room title was already processed')) return '이미 처리한 방입니다';
  if (!/[가-힣]/u.test(text) && /[A-Za-z]/u.test(text)) return '자세한 내용은 진행 기록을 확인하세요';
  return text;
}

function printAttentionRooms(manifest) {
  const rooms = attentionRooms(manifest);
  if (!rooms.length) return;
  console.log(`확인 필요 방: ${rooms.length}개`);
  rooms.slice(0, 20).forEach((room, index) => {
    const label = String(room.label || room.list_label || `방 ${room.index || index + 1}`).replace(/\s+/gu, ' ').trim();
    const status = attentionStatusLabel(room.audit_status || room.scrape_status);
    const reasonText = attentionReasonLabel(room.skip_reason);
    const reason = reasonText ? `, ${reasonText}` : '';
    console.log(`  ${index + 1}. ${label} (${status}${reason})`);
  });
  if (rooms.length > 20) console.log(`  ... ${rooms.length - 20}개 더 있습니다. 진행 기록 또는 백업 폴더의 상세 기록을 확인하세요.`);
  console.log('저장된 결과를 먼저 보고, 빠진 방은 같은 백업 다시 실행 또는 진행 기록에서 확인하세요.');
}

function runBackupWithRetries(backupArgs, logPath, label, retries) {
  const maxAttempts = retries + 1;
  let last = null;
  let combinedLog = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) console.log(`  다시 시도합니다 (${attempt}/${maxAttempts}): ${label}`);
    const result = run(process.execPath, backupArgs, { cwd: repo });
    last = result;
    combinedLog += `${combinedLog ? '\n' : ''}--- 백업 시도 ${attempt}/${maxAttempts} ---\n${result.stdout || ''}${result.stderr || ''}`;
    writeFileSync(logPath, combinedLog, 'utf8');
    if (result.ok) return { result, attempts: attempt };
  }
  return { result: last, attempts: maxAttempts };
}

if (args.help || args._[0] === 'help') {
  usage();
  process.exit(0);
}

if (!args['confirm-local-backup']) throw new Error('카카오톡 목록 백업에는 --confirm-local-backup 확인이 필요합니다');
if (process.platform !== 'win32') throw new Error('kakao_windows_batch.mjs는 Windows Node.js에서 실행해야 합니다');

const proc = textArg('proc', 'KakaoTalk');
const hwnd = textArg('hwnd');
const mainTitle = textArg('main-title', '카카오톡');
const allVisible = boolArg('all-visible') || boolArg('full-list') || boolArg('scan-all');
const pages = intArg('pages', allVisible ? 80 : 1, 1, 200);
const roomLimit = intArg('room-limit', allVisible ? 200 : 5, 1, 500);
const maxVisibleRooms = intArg('max-visible-rooms', 30, 1, 200);
const maxFrames = intArg('max-frames', 120, 1, 500);
const roomRetries = intArg('room-retries', 1, 0, 5);
const roomWaitMs = intArg('room-wait-ms', 1200, 100, 10000);
const pageWaitMs = intArg('page-wait-ms', 700, 100, 10000);
const resetScrolls = intArg('reset-scrolls', allVisible ? 10 : 0, 0, 40);
const stopAfterDuplicatePages = intArg('stop-after-duplicate-pages', allVisible ? 2 : 200, 1, 20);
const listCropArg = textArg('list-crop', 'auto');
const ocrLang = textArg('ocr-lang', 'ko');
const dryRun = boolArg('dry-run');
const toBottom = !boolArg('no-to-bottom') && args['to-bottom'] !== 'false';
const outDirWin = textArg('out-dir') || join(pathConfig.shotsDirWin, `kakao_batch_windows_${timestamp()}`);
const outDir = windowsPathToLocal(outDirWin);
const pagesDir = join(outDir, 'pages');
const roomsDir = join(outDir, 'rooms');
mkdirSync(pagesDir, { recursive: true });
mkdirSync(roomsDir, { recursive: true });

let mainHwnd = hwnd;
let mainRect = null;
const startedAt = Date.now();
const manifestPath = join(outDir, 'kakao_batch_manifest.json');
const manifest = {
  schema: 'kakao_batch.v1',
  tool: 'kakao_windows_batch.mjs',
  created_at: new Date().toISOString(),
  updated_at: null,
  target: { proc, hwnd: hwnd || null, main_title: mainTitle || null },
  output_dir: outDirWin,
  options: {
    windows_native: true,
    pages,
    room_limit: roomLimit,
    max_visible_rooms: maxVisibleRooms,
    max_frames: maxFrames,
    room_retries: roomRetries,
    list_crop: listCropArg,
    ocr_lang: ocrLang,
    all_visible: allVisible,
    stop_after_duplicate_pages: stopAfterDuplicatePages,
    dry_run: dryRun,
    to_bottom: toBottom,
  },
  pages: [],
  rooms: [],
  list_complete: false,
  stats: {
    detected_candidates: 0,
    unique_candidates: 0,
    processed_rooms: 0,
    opened_rooms: 0,
    open_failed: 0,
    skipped_duplicate_labels: 0,
    skipped_duplicate_titles: 0,
    retried_rooms: 0,
    retry_attempts: 0,
    pass: 0,
    review: 0,
    fail_or_missing: 0,
    list_complete: false,
  },
  privacy: {
    scope: allVisible ? '사용자가 열어 둔 카카오톡 창의 왼쪽 채팅 목록 전체 순회' : '사용자가 열어 둔 카카오톡 창의 보이는 채팅 목록',
    storage: 'local shots directory',
    network_upload: false,
    cloud_translation_requested: false,
  },
  timings: { total_elapsed_s: null },
};
writeManifest(manifestPath, manifest);

const seenLabels = new Set();
const seenTitles = new Set();
const seenCandidateLabels = new Set();
let processed = 0;
let duplicatePages = 0;
let stopReason = null;

console.log(dryRun ? '카카오톡 목록 확인을 시작합니다.' : '카카오톡 목록 백업을 시작합니다.');
console.log(`  대상: ${proc}${hwnd ? ` hwnd=${hwnd}` : ''}`);
console.log(`  저장 위치: ${outDirWin}`);
console.log(`  범위: ${allVisible ? '왼쪽 목록 끝까지 자동 순회' : '현재 보이는 목록 기준'}`);
console.log(`  페이지 상한: ${pages}, 방 개수 상한: ${roomLimit}, 방별 캡처 수: ${maxFrames}`);
console.log(`  방 실패 재시도: ${roomRetries}회`);
if (dryRun) console.log('  목록 확인: 방을 클릭하지 않고 후보만 표시합니다.');

let resetDone = false;
for (let page = 1; page <= pages; page++) {
  const pageNo = String(page).padStart(3, '0');
  const pagePng = join(pagesDir, `page_${pageNo}.png`);
  const pageJson = join(pagesDir, `page_${pageNo}.json`);
  const candidatesJson = join(pagesDir, `page_${pageNo}_rooms.json`);

  console.log(`\n[${page}/${pages}] 카카오톡 목록 화면을 읽는 중입니다...`);
  captureMain(pagePng);
  const size = pngSize(pagePng) || { width: mainRect?.width || 420, height: mainRect?.height || 860 };
  const listRegion = listCropArg === 'auto' ? autoListRegion(size.width, size.height) : parseRegion(listCropArg, 'list-crop');
  if (!resetDone) {
    resetDone = true;
    resetListToTop(size, listRegion);
    if (allVisible && !boolArg('no-reset-to-top')) {
      captureMain(pagePng);
    }
  }

  ocrImage(pagePng, pageJson, ocrLang);
  const candidates = nodeJson('카카오톡 목록 후보 추출', 'kakao_rooms_from_ocr.mjs', [
    '--json',
    pageJson,
    '--crop',
    listRegion.spec,
    '--absolute-coords',
    '--max-rooms',
    String(maxVisibleRooms),
  ]);
  writeJson(candidatesJson, candidates);
  const rooms = Array.isArray(candidates.rooms) ? candidates.rooms : [];
  const uniqueStart = seenCandidateLabels.size;
  const newRooms = [];
  for (const room of rooms) {
    const key = normalizedKey(room?.label || '');
    if (!key || seenCandidateLabels.has(key)) continue;
    seenCandidateLabels.add(key);
    newRooms.push(room);
  }
  const candidateStart = allVisible ? uniqueStart : manifest.stats.detected_candidates;
  manifest.stats.detected_candidates += rooms.length;
  manifest.stats.unique_candidates = seenCandidateLabels.size;
  if (allVisible) {
    duplicatePages = newRooms.length ? 0 : duplicatePages + 1;
  }
  manifest.pages.push({
    page,
    screenshot: localPathToWindows(pagePng),
    ocr_json: localPathToWindows(pageJson),
    candidates_json: localPathToWindows(candidatesJson),
    list_crop: listRegion.spec,
    candidates: rooms.length,
    new_candidates: newRooms.length,
    duplicate_page_count: duplicatePages,
  });
  writeManifest(manifestPath, manifest);
  console.log(`  후보 ${rooms.length}개를 찾았습니다. 새 후보 ${newRooms.length}개, 누적 후보 ${manifest.stats.unique_candidates}개. crop=${listRegion.spec}`);

  if (dryRun) {
    if (!rooms.length) {
      console.log('  후보를 찾지 못했습니다. 카카오톡 왼쪽 채팅 목록이 보이게 한 뒤 다시 목록 확인을 누르세요.');
    } else {
      console.log('  후보 목록:');
      const shownRooms = allVisible ? newRooms : rooms;
      shownRooms.forEach((room, index) => {
        console.log(`  ${String(candidateStart + index + 1).padStart(2, ' ')}. ${room.label || '(제목 없음)'}`);
      });
      if (allVisible && !shownRooms.length) console.log('  새 후보가 없습니다. 목록 끝에 가까워졌는지 확인합니다.');
      console.log('  후보가 맞으면 웹 화면에서 목록 백업을 누르세요.');
    }
  } else {
    for (const room of rooms) {
      if (processed >= roomLimit) break;
      const listLabel = String(room.label || '').trim();
      const labelKey = normalizedKey(listLabel);
      if (!labelKey || seenLabels.has(labelKey)) {
        manifest.stats.skipped_duplicate_labels += 1;
        continue;
      }
      seenLabels.add(labelKey);

      processed += 1;
      const index = String(processed).padStart(3, '0');
      const clickX = Number(room.click_x || 0);
      const clickY = Number(room.click_y || 0);
      const absX = Math.round((mainRect?.left || 0) + clickX);
      const absY = Math.round((mainRect?.top || 0) + clickY);
      console.log(`\n[방 ${processed}/${roomLimit}] ${listLabel || '(제목 없음)'} 선택 중...`);
      let opened = { window: null, method: 'not_found' };
      let openAttempts = 0;
      for (let attempt = 1; attempt <= roomRetries + 1; attempt++) {
        if (attempt > 1) console.log(`  방 열기를 다시 시도합니다 (${attempt}/${roomRetries + 1}): ${listLabel || '(제목 없음)'}`);
        const beforeWindows = listKakaoWindows();
        for (let i = 0; i < 2; i++) {
          psKakao('click', ['-Hwnd', mainHwnd, '-X', String(absX), '-Y', String(absY)]);
          sleepMs(160);
        }
        sleepMs(roomWaitMs);
        const afterWindows = listKakaoWindows();
        opened = resolveOpenedChatWindow(beforeWindows, afterWindows, listLabel);
        openAttempts = attempt;
        if (opened.window?.hwnd) break;
      }
      const roomHadRetry = openAttempts > 1;
      manifest.stats.retry_attempts += Math.max(0, openAttempts - 1);
      const roomDir = join(roomsDir, `${index}_${sanitizeFileName(listLabel || 'kakao_room')}`);

      if (!opened.window?.hwnd) {
        if (roomHadRetry) manifest.stats.retried_rooms += 1;
        manifest.stats.open_failed += 1;
        manifest.rooms.push({
          page,
          index: processed,
          label: listLabel,
          click: { x: clickX, y: clickY, screen_x: absX, screen_y: absY },
          open_attempts: openAttempts,
          scrape_status: 'failed',
          audit_status: 'open_failed',
          skip_reason: 'opened KakaoTalk chat window was not found',
          room_dir: localPathToWindows(roomDir),
        });
        manifest.stats.processed_rooms = processed;
        manifest.stats.fail_or_missing = manifest.rooms.filter((it) => !['pass', 'review'].includes(String(it.audit_status || '').toLowerCase())).length;
        writeManifest(manifestPath, manifest);
        console.error('  채팅창을 확인하지 못해 이 방은 건너뜁니다. 카카오톡 왼쪽 목록이 보이고 방을 더블클릭하면 새 채팅창이 열리는지 확인하세요.');
        continue;
      }

      manifest.stats.opened_rooms += 1;
      const titleLabel = String(opened.window.title || listLabel || 'KakaoTalk chat').trim();
      const titleKey = normalizedKey(titleLabel);
      if (titleKey && seenTitles.has(titleKey)) {
        if (roomHadRetry) manifest.stats.retried_rooms += 1;
        manifest.stats.skipped_duplicate_titles += 1;
        manifest.rooms.push({
          page,
          index: processed,
          label: titleLabel,
          list_label: listLabel,
          hwnd: opened.window.hwnd,
          open_method: opened.method,
          click: { x: clickX, y: clickY, screen_x: absX, screen_y: absY },
          open_attempts: openAttempts,
          retried: roomHadRetry,
          scrape_status: 'skipped',
          audit_status: 'skipped_duplicate_title',
          skip_reason: 'selected room title was already processed',
          room_dir: localPathToWindows(roomDir),
        });
        writeManifest(manifestPath, manifest);
        console.log(`  이미 처리한 방이라 건너뜁니다: ${titleLabel}`);
        continue;
      }
      if (titleKey) seenTitles.add(titleKey);

      const backupArgs = [
        join(repo, 'scripts', 'kakao_regular_chat.mjs'),
        'chat',
        '--confirm-local-backup',
        '--hwnd',
        opened.window.hwnd,
        '--room-label',
        titleLabel || listLabel,
        '--max-frames',
        String(maxFrames),
        '--out-dir',
        localPathToWindows(roomDir),
      ];
      if (toBottom) backupArgs.push('--to-bottom');

      let scrapeStatus = 'ok';
      let auditStatus = 'missing';
      const logPath = `${roomDir}.log`;
      const startedRoom = Date.now();
      const { result: backup, attempts: backupAttempts } = runBackupWithRetries(backupArgs, logPath, titleLabel || listLabel || '카카오톡 방', roomRetries);
      const retried = roomHadRetry || backupAttempts > 1;
      manifest.stats.retry_attempts += Math.max(0, backupAttempts - 1);
      if (retried) manifest.stats.retried_rooms += 1;
      if (!backup.ok) {
        scrapeStatus = 'failed';
        auditStatus = 'failed';
        console.error(`  백업 실패: ${backup.stderr || backup.stdout || `exit ${backup.status}`}`);
      } else {
        process.stdout.write(backup.stdout || '');
        process.stderr.write(backup.stderr || '');
      }

      const auditPath = join(roomDir, 'kakao_regular_audit.json');
      const messagesPath = join(roomDir, 'kakao_messages.json');
      const audit = existsSync(auditPath) ? readJson(auditPath, {}) : {};
      const messages = existsSync(messagesPath) ? readJson(messagesPath, {}) : {};
      if (audit.status) auditStatus = String(audit.status).toLowerCase();
      const auditMessages = Number(audit.counts?.messages ?? messages.stats?.messages ?? 0);
      const auditFrames = Number(audit.counts?.frames ?? messages.stats?.frames ?? 0);
      manifest.rooms.push({
        page,
        index: processed,
        label: titleLabel,
        list_label: listLabel,
        hwnd: opened.window.hwnd,
        open_method: opened.method,
        click: { x: clickX, y: clickY, screen_x: absX, screen_y: absY },
        open_attempts: openAttempts,
        backup_attempts: backupAttempts,
        retried,
        scrape_status: scrapeStatus,
        audit_status: auditStatus,
        room_dir: localPathToWindows(roomDir),
        messages: auditMessages,
        frames: auditFrames,
        elapsed_s: Math.round((Date.now() - startedRoom) / 100) / 10,
      });
      manifest.stats.processed_rooms = processed;
      manifest.stats.pass = manifest.rooms.filter((it) => String(it.audit_status || '').toLowerCase() === 'pass').length;
      manifest.stats.review = manifest.rooms.filter((it) => String(it.audit_status || '').toLowerCase() === 'review').length;
      manifest.stats.fail_or_missing = manifest.rooms.filter((it) => !['pass', 'review', 'skipped_duplicate_title'].includes(String(it.audit_status || '').toLowerCase())).length;
      writeManifest(manifestPath, manifest);
      console.log(`  완료: ${titleLabel || listLabel} (${auditStatus})`);
    }
  }

  if (processed >= roomLimit) {
    stopReason = '방 개수 상한에 도달해 멈췄습니다. 모든 방을 확인하지 못했을 수 있습니다. 백업 화면의 상한 늘려 전체 목록 다시 확인을 눌러 후보 확인부터 다시 시작하세요.';
    break;
  }
  if (allVisible && duplicatePages >= stopAfterDuplicatePages) {
    stopReason = '새 방이 더 이상 나오지 않아 목록 순회를 멈췄습니다.';
    break;
  }
  if (page < pages) {
    console.log('  다음 목록 페이지로 이동합니다...');
    scrollList(-6, size, listRegion);
    sleepMs(pageWaitMs);
  } else if (page >= pages) {
    stopReason = '페이지 상한에 도달해 멈췄습니다. 모든 방을 확인하지 못했을 수 있습니다. 백업 화면의 상한 늘려 전체 목록 다시 확인을 눌러 후보 확인부터 다시 시작하세요.';
  }
}

manifest.timings.total_elapsed_s = Math.round((Date.now() - startedAt) / 100) / 10;
manifest.stop_reason = stopReason;
manifest.list_complete = allVisible && stopReason === '새 방이 더 이상 나오지 않아 목록 순회를 멈췄습니다.';
manifest.list_end_status = manifest.list_complete ? 'complete' : (allVisible ? 'not_proven_complete' : 'visible_page_only');
manifest.stats.attention_rooms = attentionRooms(manifest).length;
manifest.stats.list_complete = manifest.list_complete;
writeManifest(manifestPath, manifest);

console.log(dryRun ? '\n카카오톡 목록 확인이 끝났습니다.' : '\n카카오톡 목록 백업이 끝났습니다.');
if (stopReason) console.log(`중지 이유: ${stopReason}`);
console.log(`BATCH_DIR=${outDirWin}`);
console.log(`BATCH_MANIFEST=${localPathToWindows(manifestPath)}`);
if (dryRun) {
  console.log(`후보 요약: ${manifest.stats.unique_candidates || manifest.stats.detected_candidates}개`);
  console.log(`고급 정보: CANDIDATES=${manifest.stats.unique_candidates || manifest.stats.detected_candidates}`);
  console.log('후보가 맞으면 웹 화면에서 목록 백업을 누르세요. 후보가 이상하면 카카오톡 창의 왼쪽 채팅 목록을 보이게 한 뒤 목록 확인을 다시 누르세요.');
} else {
  console.log(`백업 요약: 처리 ${manifest.stats.processed_rooms}개, 정상 ${manifest.stats.pass}개, 확인 필요 ${manifest.stats.review}개, 실패 ${manifest.stats.fail_or_missing}개`);
  printAttentionRooms(manifest);
  if (manifest.stats.retried_rooms) console.log(`재시도 요약: ${manifest.stats.retried_rooms}개 방에서 ${manifest.stats.retry_attempts}회 다시 시도했습니다.`);
  console.log(`고급 정보: ROOMS=${manifest.stats.processed_rooms} PASS=${manifest.stats.pass} REVIEW=${manifest.stats.review} FAIL_OR_MISSING=${manifest.stats.fail_or_missing} RETRIED=${manifest.stats.retried_rooms} RETRY_ATTEMPTS=${manifest.stats.retry_attempts}`);
}
