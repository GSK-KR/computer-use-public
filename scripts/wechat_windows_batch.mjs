#!/usr/bin/env node
// Windows-native WeChat visible-list backup.
//
// Captures the visible WeChat chat list, clicks detected rows, and reuses
// wechat_windows_backup.mjs for each selected room. It never types or reads the
// private WeChat database.
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
  node scripts/wechat_windows_batch.mjs --confirm-local-backup [options]

Options:
  --proc NAME              WeChat process name (default: Weixin)
  --hwnd N                 exact WeChat main window handle
  --pages N                max visible-list pages to scan (default: 1, --all-visible default: 80)
  --room-limit N           max rooms to back up (default: 5, --all-visible default: 200)
  --max-visible-rooms N    max candidates per page (default: 20)
  --max-frames N           frames per room backup (default: 120)
  --room-retries N         retry failed room backup attempts (default: 1)
  --list-crop auto|WxH+X+Y left list region in window pixels (default: auto)
  --ocr-lang LANG          Windows OCR language hint (default: zh-Hans)
  --out-dir DIR            output directory (default: shots\\wechat_batch_windows_*)
  --direct-chat-auto       use room title as 1:1 incoming speaker hint
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
  let listW = Math.floor(width * 0.29);
  listW = Math.max(420, Math.min(620, listW));
  const listY = Math.floor(height * 0.07);
  const listH = Math.max(200, height - listY - 40);
  return parseRegion(`${listW}x${listH}+0+${listY}`, 'list-crop');
}

function headerRegion(width, height, listRegion) {
  const headerX = Math.min(width - 240, Math.max(0, listRegion.x + listRegion.width));
  const headerW = Math.max(240, width - headerX - 80);
  const headerH = Math.max(80, Math.min(140, Math.floor(height * 0.12)));
  return parseRegion(`${headerW}x${headerH}+${Math.max(0, headerX)}+0`, 'header-region');
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
  if (result.stderr) process.stderr.write(result.stderr);
  if (!result.ok) {
    const detail = result.stderr || result.stdout || result.error?.message || `exit ${result.status}`;
    throw new Error(`${label} 실패: ${detail}`);
  }
  return result;
}

function psWechat(cmd, extraArgs = []) {
  const commandArgs = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    `${pathConfig.scriptsDirWin}\\wechat_window.ps1`,
    cmd,
    '-ProcName',
    proc,
    ...extraArgs,
  ];
  if (hwnd) commandArgs.push('-Hwnd', hwnd);
  return runChecked(`WeChat ${cmd}`, 'powershell.exe', commandArgs);
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

function writeManifest(file, manifest) {
  manifest.updated_at = new Date().toISOString();
  writeJson(file, manifest);
}

function attentionRooms(manifest) {
  return (manifest.rooms || []).filter((room) => {
    const status = String(room.audit_status || room.scrape_status || '').toLowerCase();
    return status && !['pass', 'skipped_non_chat', 'skipped_duplicate_title'].includes(status);
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
  if (text.includes('selected room title was already processed')) return '이미 처리한 방입니다';
  if (text.includes('no usable message pane')) return '대화 화면을 확인하지 못했습니다';
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

if (!args['confirm-local-backup']) throw new Error('위챗 목록 백업에는 --confirm-local-backup 확인이 필요합니다');
if (process.platform !== 'win32') throw new Error('wechat_windows_batch.mjs는 Windows Node.js에서 실행해야 합니다');

const proc = textArg('proc', 'Weixin');
const hwnd = textArg('hwnd');
const allVisible = boolArg('all-visible') || boolArg('full-list') || boolArg('scan-all');
const pages = intArg('pages', allVisible ? 80 : 1, 1, 200);
const roomLimit = intArg('room-limit', allVisible ? 200 : 5, 1, 500);
const maxVisibleRooms = intArg('max-visible-rooms', 20, 1, 200);
const maxFrames = intArg('max-frames', 120, 1, 800);
const roomRetries = intArg('room-retries', 1, 0, 5);
const roomWaitMs = intArg('room-wait-ms', 900, 100, 10000);
const pageWaitMs = intArg('page-wait-ms', 700, 100, 10000);
const resetScrolls = intArg('reset-scrolls', allVisible ? 10 : 0, 0, 40);
const stopAfterDuplicatePages = intArg('stop-after-duplicate-pages', allVisible ? 2 : 200, 1, 20);
const listCropArg = textArg('list-crop', 'auto');
const ocrLang = textArg('ocr-lang', 'zh-Hans');
const directChatAuto = boolArg('direct-chat-auto');
const dryRun = boolArg('dry-run');
const outDirWin = textArg('out-dir') || join(pathConfig.shotsDirWin, `wechat_batch_windows_${timestamp()}`);
const outDir = windowsPathToLocal(outDirWin);
const pagesDir = join(outDir, 'pages');
const roomsDir = join(outDir, 'rooms');
mkdirSync(pagesDir, { recursive: true });
mkdirSync(roomsDir, { recursive: true });

const startedAt = Date.now();
const manifestPath = join(outDir, 'wechat_batch_manifest.json');
const manifest = {
  schema: 'wechat_batch.v1',
  tool: 'wechat_windows_batch.mjs',
  created_at: new Date().toISOString(),
  updated_at: null,
  target: { proc, hwnd: hwnd || null },
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
    direct_chat_auto: directChatAuto,
    all_visible: allVisible,
    stop_after_duplicate_pages: stopAfterDuplicatePages,
    dry_run: dryRun,
  },
  pages: [],
  rooms: [],
  list_complete: false,
  stats: {
    detected_candidates: 0,
    unique_candidates: 0,
    processed_rooms: 0,
    skipped_duplicate_labels: 0,
    skipped_duplicate_titles: 0,
    pass: 0,
    review: 0,
    retried_rooms: 0,
    retry_attempts: 0,
    skipped_non_chat: 0,
    skipped_duplicate_title: 0,
    fail_or_missing: 0,
    list_complete: false,
  },
  privacy: {
    scope: allVisible ? '사용자가 열어 둔 위챗 창의 왼쪽 채팅 목록 전체 순회' : '사용자가 열어 둔 위챗 창의 보이는 채팅 목록',
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
let resetDone = false;

function resetListToTop(size, listRegion) {
  if (!allVisible || boolArg('no-reset-to-top')) return;
  console.log('  목록 시작 위치를 위쪽으로 맞춥니다...');
  const scrollX = Math.floor(listRegion.x + listRegion.width * 0.48);
  const scrollY = Math.floor(listRegion.y + listRegion.height * 0.52);
  for (let i = 0; i < resetScrolls; i++) {
    psWechat('scroll', ['-X', String(scrollX), '-Y', String(scrollY), '-Notches', '8']);
    sleepMs(120);
  }
  sleepMs(pageWaitMs);
}

console.log(dryRun ? '위챗 목록 확인을 시작합니다.' : '위챗 목록 백업을 시작합니다.');
console.log(`  대상: ${proc}${hwnd ? ` hwnd=${hwnd}` : ''}`);
console.log(`  저장 위치: ${outDirWin}`);
console.log(`  범위: ${allVisible ? '왼쪽 목록 끝까지 자동 순회' : '현재 보이는 목록 기준'}`);
console.log(`  페이지 상한: ${pages}, 방 개수 상한: ${roomLimit}, 방별 캡처 수: ${maxFrames}`);
console.log(`  방 실패 재시도: ${roomRetries}회`);
if (dryRun) console.log('  목록 확인: 방을 클릭하지 않고 후보만 표시합니다.');

for (let page = 1; page <= pages; page++) {
  const pageNo = String(page).padStart(3, '0');
  const pagePng = join(pagesDir, `page_${pageNo}.png`);
  const pageJson = join(pagesDir, `page_${pageNo}.json`);
  const candidatesJson = join(pagesDir, `page_${pageNo}_rooms.json`);

  console.log(`\n[${page}/${pages}] 위챗 목록 화면을 읽는 중입니다...`);
  psWechat('capture', ['-OutPath', localPathToWindows(pagePng)]);
  const size = pngSize(pagePng) || { width: 2048, height: 1392 };
  const listRegion = listCropArg === 'auto' ? autoListRegion(size.width, size.height) : parseRegion(listCropArg, 'list-crop');
  if (!resetDone) {
    resetDone = true;
    resetListToTop(size, listRegion);
    if (allVisible && !boolArg('no-reset-to-top')) {
      psWechat('capture', ['-OutPath', localPathToWindows(pagePng)]);
    }
  }

  ocrImage(pagePng, pageJson, ocrLang);
  const candidates = nodeJson('위챗 목록 후보 추출', 'wechat_rooms_from_ocr.mjs', [
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
      console.log('  후보를 찾지 못했습니다. 위챗 왼쪽 채팅 목록이 보이게 한 뒤 다시 목록 확인을 누르세요.');
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
      console.log(`\n[방 ${processed}/${roomLimit}] ${listLabel || '(제목 없음)'} 선택 중...`);
      psWechat('click', ['-X', String(clickX), '-Y', String(clickY)]);
      sleepMs(roomWaitMs);

      const selectedPng = join(pagesDir, `room_${index}_selected.png`);
      const selectedJson = join(pagesDir, `room_${index}_selected.json`);
      const titleJson = join(pagesDir, `room_${index}_title.json`);
      let titleLabel = listLabel;
      try {
        psWechat('capture', ['-OutPath', localPathToWindows(selectedPng)]);
        ocrImage(selectedPng, selectedJson, ocrLang);
        const titleRegion = headerRegion(size.width, size.height, listRegion);
        const titleDoc = nodeJson('위챗 방 제목 추출', 'wechat_title_from_ocr.mjs', [
          '--json',
          selectedJson,
          '--region',
          titleRegion.spec,
          '--absolute-coords',
        ]);
        writeJson(titleJson, titleDoc);
        if (String(titleDoc.title || '').trim()) titleLabel = String(titleDoc.title).trim();
      } catch (err) {
        console.error(`  제목 추정은 건너뜁니다: ${err.message}`);
      }

      const titleKey = normalizedKey(titleLabel);
      const roomDir = join(roomsDir, `${index}_${sanitizeFileName(titleLabel || listLabel || 'wechat_room')}`);
      if (titleKey && seenTitles.has(titleKey)) {
        manifest.stats.skipped_duplicate_titles += 1;
        manifest.stats.skipped_duplicate_title += 1;
        manifest.rooms.push({
          page,
          index: processed,
          label: titleLabel,
          list_label: listLabel,
          click: { x: clickX, y: clickY },
          backup_attempts: 0,
          retried: false,
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
        join(repo, 'scripts', 'wechat_windows_backup.mjs'),
        '--confirm-local-backup',
        '--proc',
        proc,
        '--max-frames',
        String(maxFrames),
        '--room-label',
        titleLabel || listLabel,
        '--out-dir',
        localPathToWindows(roomDir),
      ];
      if (hwnd) backupArgs.push('--hwnd', hwnd);
      if (directChatAuto) backupArgs.push('--incoming-speaker', 'auto');

      let scrapeStatus = 'ok';
      let auditStatus = 'missing';
      let skipReason = null;
      const logPath = `${roomDir}.log`;
      const startedRoom = Date.now();
      const { result: backup, attempts: backupAttempts } = runBackupWithRetries(backupArgs, logPath, titleLabel || listLabel || '위챗 방', roomRetries);
      const retried = backupAttempts > 1;
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

      const auditPath = join(roomDir, 'wechat_audit.json');
      const messagesPath = join(roomDir, 'wechat_messages.json');
      const audit = existsSync(auditPath) ? readJson(auditPath, {}) : {};
      const messages = existsSync(messagesPath) ? readJson(messagesPath, {}) : {};
      if (audit.status) auditStatus = audit.status;
      const auditMessages = Number(audit.metrics?.messages?.structured ?? messages.stats?.messages ?? 0);
      const auditRawLines = Number(audit.metrics?.ocr?.raw_lines ?? messages.stats?.raw_ocr_lines ?? 0);
      const auditFrames = Number(audit.metrics?.frames?.captured ?? messages.stats?.frames ?? 0);
      if (auditStatus === 'fail' && auditFrames <= 2 && ((auditMessages <= 1 && auditRawLines <= 1) || (auditMessages === 0 && auditRawLines <= 5))) {
        scrapeStatus = 'skipped';
        auditStatus = 'skipped_non_chat';
        skipReason = 'no usable message pane; likely service panel, blank pane, or non-chat row';
      }

      manifest.rooms.push({
        page,
        index: processed,
        label: titleLabel,
        list_label: listLabel,
        click: { x: clickX, y: clickY },
        backup_attempts: backupAttempts,
        retried,
        scrape_status: scrapeStatus,
        audit_status: auditStatus,
        skip_reason: skipReason,
        room_dir: localPathToWindows(roomDir),
        messages: auditMessages,
        frames: auditFrames,
        elapsed_s: Math.round((Date.now() - startedRoom) / 100) / 10,
      });
      manifest.stats.processed_rooms = processed;
      manifest.stats.pass = manifest.rooms.filter((it) => it.audit_status === 'pass').length;
      manifest.stats.review = manifest.rooms.filter((it) => it.audit_status === 'review').length;
      manifest.stats.skipped_non_chat = manifest.rooms.filter((it) => it.audit_status === 'skipped_non_chat').length;
      manifest.stats.fail_or_missing = manifest.rooms.filter((it) => !['pass', 'review', 'skipped_non_chat', 'skipped_duplicate_title'].includes(it.audit_status)).length;
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
    const scrollX = Math.floor(size.width * 0.13);
    const scrollY = Math.floor(size.height / 2);
    console.log('  다음 목록 페이지로 이동합니다...');
    psWechat('scroll', ['-X', String(scrollX), '-Y', String(scrollY), '-Notches', '-6']);
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

console.log(dryRun ? '\n위챗 목록 확인이 끝났습니다.' : '\n위챗 목록 백업이 끝났습니다.');
if (stopReason) console.log(`중지 이유: ${stopReason}`);
console.log(`BATCH_DIR=${outDirWin}`);
console.log(`BATCH_MANIFEST=${localPathToWindows(manifestPath)}`);
if (dryRun) {
  console.log(`후보 요약: ${manifest.stats.unique_candidates || manifest.stats.detected_candidates}개`);
  console.log(`고급 정보: CANDIDATES=${manifest.stats.unique_candidates || manifest.stats.detected_candidates}`);
  console.log('후보가 맞으면 웹 화면에서 목록 백업을 누르세요. 후보가 이상하면 위챗 창의 왼쪽 채팅 목록을 보이게 한 뒤 목록 확인을 다시 누르세요.');
} else {
  console.log(`백업 요약: 처리 ${manifest.stats.processed_rooms}개, 정상 ${manifest.stats.pass}개, 확인 필요 ${manifest.stats.review}개, 실패 ${manifest.stats.fail_or_missing}개`);
  printAttentionRooms(manifest);
  if (manifest.stats.retried_rooms) console.log(`재시도 요약: ${manifest.stats.retried_rooms}개 방에서 ${manifest.stats.retry_attempts}회 다시 시도했습니다.`);
  console.log(`고급 정보: ROOMS=${manifest.stats.processed_rooms} PASS=${manifest.stats.pass} REVIEW=${manifest.stats.review} FAIL_OR_MISSING=${manifest.stats.fail_or_missing} RETRIED=${manifest.stats.retried_rooms} RETRY_ATTEMPTS=${manifest.stats.retry_attempts}`);
}
