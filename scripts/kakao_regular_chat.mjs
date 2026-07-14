#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  asArray,
  classifyStatus,
  defaultRunDir,
  finishManifest,
  makeManifest,
  parseArgs,
  printSummary,
  readJson,
  run,
  writeJson,
  isoNow,
} from './lib/cu_common.mjs';
import { loadPathConfig } from './lib/path_config.mjs';

const args = parseArgs();
const cmd = args._[0] || 'help';
const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const pathConfig = loadPathConfig();
const stateDirLocal = process.platform === 'win32' ? pathConfig.stateDirWin : pathConfig.stateDirWsl;
const shotsDirLocal = process.platform === 'win32' ? pathConfig.shotsDirWin : pathConfig.shotsDirWsl;
const stopFile = join(stateDirLocal, 'STOP');
const cuScript = join(repo, 'scripts', 'cu');

function usage() {
  console.log(`usage:
  node scripts/kakao_regular_chat.mjs chat --title ROOM --confirm-local-backup [--max-frames N] [--to-bottom]
  node scripts/kakao_regular_chat.mjs chat-batch --confirm-local-backup [--title ROOM ...] [--open-visible REGEX]
  node scripts/kakao_regular_chat.mjs chat-audit DIR [--check]
  node scripts/kakao_regular_chat.mjs structure DIR [--room-label ROOM]`);
}

function resolveHwndByTitle(title) {
  const needle = String(title || '').trim().toLowerCase();
  if (!needle) return null;
  const windows = listKakaoChatWindows();
  const exact = windows.find((win) => String(win.title || '').trim().toLowerCase() === needle);
  const partial = windows.find((win) => String(win.title || '').trim().toLowerCase().includes(needle));
  return (exact || partial)?.hwnd || null;
}

function listKakaoWindows() {
  const res = run('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    `${pathConfig.scriptsDirWin}\\kakao_window.ps1`,
    'list',
    '-ProcName',
    'KakaoTalk',
  ], { cwd: repo });
  return res.stdout.split(/\r?\n/).map((line) => {
    if (!/^WINDOW\s+/u.test(line)) return null;
    const hwnd = line.match(/hwnd=(\d+)/)?.[1];
    const title = line.match(/\btitle=(.*)$/u)?.[1]?.trim() || '';
    const foreground = /\bforeground=True\b/iu.test(line);
    return hwnd ? { hwnd, title, foreground } : null;
  }).filter(Boolean);
}

function isMainKakaoWindow(win) {
  const title = String(win?.title || '').trim();
  return !title || title === '카카오톡' || title === 'KakaoTalk';
}

function listKakaoChatWindows() {
  return listKakaoWindows().filter((win) => !isMainKakaoWindow(win));
}

function openVisibleRoom(pattern) {
  const query = String(pattern || '').trim();
  if (!query) throw new Error('--open-visible requires an OCR-visible room-name regex');
  if (process.platform === 'win32' || args['windows-native']) return openVisibleRoomWindowsNative(query);
  const beforeWindows = listKakaoWindows();
  run('bash', [cuScript, 'wake', 'title:카카오톡'], { cwd: repo });
  const clicked = run('bash', [cuScript, 'clicktext', 'title:카카오톡', query, '--double'], { cwd: repo });
  if (!clicked.ok) {
    throw new Error(`could not open visible Kakao room /${query}/: ${clicked.stderr || clicked.stdout}`);
  }
  run('bash', ['-lc', 'sleep 1.5'], { cwd: repo });
  const beforeHwnds = new Set(beforeWindows.map((win) => String(win.hwnd)));
  const chatWindows = listKakaoChatWindows();
  const newWindows = chatWindows.filter((win) => !beforeHwnds.has(String(win.hwnd)));
  const selected = newWindows[0] || chatWindows.find((win) => win.foreground) || null;
  return {
    message: clicked.stdout.trim(),
    hwnd: selected?.hwnd || null,
    title: selected?.title || '',
    opened_new: Boolean(selected && newWindows.some((win) => String(win.hwnd) === String(selected.hwnd))),
  };
}

function openVisibleRoomWindowsNative(pattern) {
  let matcher;
  try {
    matcher = new RegExp(pattern, 'u');
  } catch (err) {
    throw new Error(`invalid room-name regex: ${err.message}`);
  }
  const tmp = join(shotsDirLocal, '_kakao_visible_room.png');
  mkdirSync(shotsDirLocal, { recursive: true });
  const capture = run('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    `${pathConfig.scriptsDirWin}\\kakao_window.ps1`,
    'capture',
    '-ProcName',
    'KakaoTalk',
    '-Title',
    '카카오톡',
    '-OutPath',
    tmp,
  ], { cwd: repo });
  if (!capture.ok) throw new Error(`could not capture KakaoTalk room list: ${capture.stderr || capture.stdout}`);
  const hwnd = (capture.stdout + capture.stderr).match(/hwnd=(\d+)/)?.[1];
  const rect = (capture.stdout + capture.stderr).match(/rect=([-\d]+),([-\d]+),([-\d]+),([-\d]+)/);
  if (!hwnd || !rect) throw new Error(`could not read KakaoTalk list window geometry: ${capture.stdout || capture.stderr}`);
  const left = Number(rect[1]);
  const top = Number(rect[2]);
  const ocr = run('powershell.exe', [
    '-NoProfile',
    '-STA',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    `${pathConfig.scriptsDirWin}\\ocr_lines.ps1`,
    tmp,
  ], { cwd: repo });
  if (!ocr.ok) throw new Error(`KakaoTalk room list OCR failed: ${ocr.stderr || ocr.stdout}`);
  let lines = [];
  try {
    lines = JSON.parse(ocr.stdout || '[]');
  } catch (err) {
    throw new Error(`KakaoTalk room list OCR returned invalid JSON: ${err.message}`);
  }
  const ocrJson = join(shotsDirLocal, '_kakao_visible_room.json');
  writeFileSync(ocrJson, `${JSON.stringify(lines, null, 2)}\n`, 'utf8');
  const width = Number(rect[3]) - left;
  const height = Number(rect[4]) - top;
  const listWidth = Math.max(320, Math.min(width, Math.floor(width * 0.98)));
  const listY = Math.max(64, Math.floor(height * 0.08));
  const listHeight = Math.max(220, height - listY - 44);
  const candidatesResult = run(process.execPath, [
    join(repo, 'scripts', 'kakao_rooms_from_ocr.mjs'),
    '--json',
    ocrJson,
    '--crop',
    `${listWidth}x${listHeight}+0+${listY}`,
    '--absolute-coords',
    '--max-rooms',
    '200',
  ], { cwd: repo });
  if (!candidatesResult.ok) throw new Error(`KakaoTalk 방 목록 분석 실패: ${candidatesResult.stderr || candidatesResult.stdout}`);
  let candidates = [];
  try {
    candidates = JSON.parse(candidatesResult.stdout || '{}').rooms || [];
  } catch (err) {
    throw new Error(`KakaoTalk 방 목록 분석 결과를 읽지 못했습니다: ${err.message}`);
  }
  const hit = candidates.find((room) => matcher.test(String(room.label || '')));
  if (!hit) throw new Error(`KakaoTalk 목록에서 /${pattern}/ 방 이름을 찾지 못했습니다`);
  const x = Math.floor(left + Number(hit.click_x || 0));
  const y = Math.floor(top + Number(hit.click_y || 0));
  const beforeWindows = listKakaoWindows();
  const click = run('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    `${pathConfig.scriptsDirWin}\\kakao_window.ps1`,
    'doubleclick',
    '-Hwnd',
    hwnd,
    '-X',
    String(x),
    '-Y',
    String(y),
  ], { cwd: repo });
  if (!click.ok) throw new Error(`KakaoTalk room double-click failed: ${click.stderr || click.stdout}`);
  run('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 1500'], { cwd: repo });
  const beforeHwnds = new Set(beforeWindows.map((win) => String(win.hwnd)));
  const chatWindows = listKakaoChatWindows();
  const newWindows = chatWindows.filter((win) => !beforeHwnds.has(String(win.hwnd)));
  const selected = newWindows.find((win) => matcher.test(String(win.title || '')))
    || (newWindows.length === 1 ? newWindows[0] : null)
    || chatWindows.find((win) => matcher.test(String(win.title || '')))
    || chatWindows.find((win) => win.foreground);
  if (!selected?.hwnd) throw new Error(`KakaoTalk 목록에서 /${pattern}/ 방을 눌렀지만 열린 채팅창을 확인하지 못했습니다`);
  return {
    message: `clicked KakaoTalk room /${pattern}/ at ${x},${y}`,
    hwnd: selected.hwnd,
    title: selected.title,
    opened_new: newWindows.some((win) => String(win.hwnd) === String(selected.hwnd)),
  };
}

function closeKakaoWindow(hwnd) {
  if (!hwnd) return;
  run('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    `${pathConfig.scriptsDirWin}\\kakao_window.ps1`,
    'key',
    '-Hwnd',
    String(hwnd),
    '-Keys',
    '%{F4}',
  ], { cwd: repo });
}

function windowsPathToWsl(path) {
  return String(path || '').replace(/^([A-Za-z]):/u, (_, drive) => `/mnt/${drive.toLowerCase()}`).replace(/\\/g, '/');
}

function localScrapeDirPath(path) {
  return process.platform === 'win32' ? String(path || '') : windowsPathToWsl(path);
}

function scrapeChatWindowsNative({ hwnd, maxFrames, toBottom, outDir }) {
  const captureArgs = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    `${pathConfig.scriptsDirWin}\\scrape_capture.ps1`,
    'KakaoTalk',
    '-Hwnd',
    String(hwnd),
    '-MaxFrames',
    String(maxFrames),
  ];
  if (toBottom) captureArgs.push('-ToBottom');
  if (outDir) captureArgs.push('-OutDir', String(outDir));
  const capture = run('powershell.exe', captureArgs, { cwd: repo });
  process.stderr.write(capture.stderr || '');
  process.stdout.write(capture.stdout || '');
  if (!capture.ok) throw new Error('scrape_capture.ps1 failed');
  const captureText = capture.stdout + capture.stderr;
  const dirWin = captureText.match(/DIR=(.+)$/m)?.[1]?.trim();
  if (!dirWin) throw new Error('capture did not report DIR=');
  const dir = localScrapeDirPath(dirWin);
  const frames = readdirSync(dir).filter((file) => /^frame_\d+\.png$/u.test(file)).sort();
  if (!frames.length) throw new Error(`no frame_*.png captured in ${dir}`);
  for (const frame of frames) {
    const png = join(dir, frame);
    const ocr = run('powershell.exe', [
      '-NoProfile',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      `${pathConfig.scriptsDirWin}\\ocr_lines.ps1`,
      process.platform === 'win32' ? png : dirWin.replace(/[\\/]?$/u, `\\${frame}`),
    ], { cwd: repo });
    if (!ocr.ok) throw new Error(`OCR failed for ${frame}: ${ocr.stderr || ocr.stdout}`);
    writeFileSync(join(dir, frame.replace(/\.png$/u, '.json')), ocr.stdout || '[]\n', 'utf8');
  }
  const stitch = run(process.execPath, [join(repo, 'scripts', 'stitch.mjs'), dir], { cwd: repo });
  if (!stitch.ok) throw new Error(`stitch failed: ${stitch.stderr || stitch.stdout}`);
  writeFileSync(join(dir, 'transcript.txt'), stitch.stdout, 'utf8');
  console.log(`TRANSCRIPT=${process.platform === 'win32' ? join(dir, 'transcript.txt') : `${dir}/transcript.txt`}  (${stitch.stdout.split(/\r?\n/u).filter(Boolean).length} lines)`);
  const topMatch = captureText.match(/\bTOP_REACHED=(True|False)\b/iu);
  const bottomMatch = captureText.match(/\bBOTTOM_REACHED=(True|False)\b/iu);
  return {
    dir,
    capture: {
      stopReason: captureText.match(/\bSTOP_REASON=([^\s]+)/u)?.[1] || null,
      topReached: topMatch ? topMatch[1].toLowerCase() === 'true' : null,
      bottomReached: bottomMatch ? bottomMatch[1].toLowerCase() === 'true' : null,
    },
  };
}

function isKakaoTimestamp(text) {
  return /^(오전|오후)\s*\d{1,2}\s*[:•·]?\s*\d{1,2}(?:\s*\d)?$/u.test(String(text || '').trim());
}

function isKakaoCommentControl(text) {
  return /^[“"']?\s*(나\s*)?댓글\s*\d+/u.test(text) || /^[\d\s]*댓글\s*\d+/u.test(text);
}

function isKakaoUiChrome(text, it = {}) {
  const y = Number(it.y || 0);
  const x = Number(it.x || 0);
  const cleaned = String(text || '').trim();
  if (!cleaned) return true;
  if (y > 1820) return true;
  if (y < 150) return true;
  if (/환영합니다[.,\s'"]*.*오픈[재채]팅방/u.test(cleaned)) return true;
  if (cleaned === '입니다.' && x < 180 && y < 280) return true;
  if (/^(메시지 입력|채팅방 서랍|검색|톡게시판|사진|앨범)$/u.test(cleaned)) return true;
  if (/^(口|十|㉭|十\s*㉭|Q\s*\d+|LDUO)$/iu.test(cleaned)) return true;
  if (/^저장\s*[•·]\s*다른 이름으로 저장$/u.test(cleaned)) return true;
  if (/^(유효기한|유효기전)\s*~/u.test(cleaned)) return true;
  if (/^(용량|용盟)?\s*\d+(?:\.\d+)?\s*(KB|MB|GB)$/iu.test(cleaned)) return true;
  if (/^\d+$/u.test(cleaned)) return true;
  if (/^91\s*€$/u.test(cleaned)) return true;
  if (isKakaoTimestamp(cleaned)) return true;
  if (isKakaoCommentControl(cleaned)) return true;
  return false;
}

function isKakaoReplyContext(text) {
  const cleaned = String(text || '').trim();
  return /(에게|에계|의에게|에개|에게\s*)\s*(댓글|댓그|답글|대글|대긋|댓긋|덧글)/u.test(cleaned) ||
    /(댓글|댓그|답글|대글|대긋|댓긋|덧글)\s*$/u.test(cleaned) && /(에게|에계|의에게|에개)/u.test(cleaned);
}

function isKakaoSenderLine(text) {
  const cleaned = String(text || '').trim();
  const sender = cleanKakaoSenderName(cleaned);
  if (sender.length < 2 || sender.length > 36) return false;
  if (isKakaoReplyContext(cleaned)) return false;
  if (/^사원-[^\s]+$/u.test(sender)) return true;
  if (/(사원|팀장|매니저|대표)$/u.test(sender)) return true;
  return false;
}

function cleanKakaoSenderName(text) {
  const cleaned = String(text || '').trim().replace(/^[+\s]+/u, '').trim();
  if (/^Br?i[Il1]{2}\s*CS\s*오선[회희]\s*사원$/iu.test(cleaned)) return 'Brill CS 오선희 사원';
  if (/^Bri[Il1]{2}\s*cs\s*오선[회희]\s*사원$/iu.test(cleaned)) return 'Brill CS 오선희 사원';
  return cleaned;
}

function normalizeKakaoLineText(text, it = {}) {
  const x = Number(it.x || 0);
  let cleaned = String(text || '').replace(/\s+/gu, ' ').trim();
  if (x < 110) cleaned = cleaned.replace(/^(?:0|O|○|ㅇ)\s+(?=\S{2,})/u, '').trim();
  return cleaned;
}

function normalizeKakaoKind(text) {
  if (/\.(xlsx?|csv|pdf|docx?|pptx?|zip)\b/iu.test(text)) return 'attachment_or_media';
  if (/^\[파일\]/u.test(text)) return 'attachment_or_media';
  if (/파일|사진|동영상|이미지/u.test(text)) return 'attachment_or_media';
  return 'text';
}

function frameNumber(file) {
  const m = String(file || '').match(/frame_(\d+)\.json$/u);
  return m ? Number(m[1]) : null;
}

function messageDedupeKey(msg) {
  return [
    msg.speaker || '',
    msg.direction || '',
    String(msg.text || '').replace(/\s+/g, ' ').trim(),
    msg.kind || 'text',
  ].join('\t');
}

function isAdjacentFrameOverlap(a, b) {
  const af = frameNumber(a?.source?.frame);
  const bf = frameNumber(b?.source?.frame);
  if (!Number.isFinite(af) || !Number.isFinite(bf) || Math.abs(af - bf) !== 1) return false;
  const ay = Number(a?.source?.bbox?.[1]);
  const by = Number(b?.source?.bbox?.[1]);
  if (!Number.isFinite(ay) || !Number.isFinite(by)) return true;
  const delta = Math.abs(ay - by);
  return delta >= 80 && delta <= 1400;
}

function bboxFromLines(lines) {
  const minX = Math.min(...lines.map((line) => Number(line.x || 0)));
  const minY = Math.min(...lines.map((line) => Number(line.y || 0)));
  const maxX = Math.max(...lines.map((line) => Number(line.x || 0) + Number(line.w || 0)));
  const maxY = Math.max(...lines.map((line) => Number(line.y || 0) + Number(line.h || 0)));
  return [minX, minY, Math.max(0, maxX - minX), Math.max(0, maxY - minY)];
}

function shouldMergeKakaoLine(group, line) {
  if (!group || !group.lines.length) return false;
  if (group.frame !== line.frame) return false;
  if (group.direction !== line.direction) return false;
  if (group.speaker !== line.speaker) return false;
  if (group.kind !== line.kind) return false;

  const prev = group.lines[group.lines.length - 1];
  const gap = Number(line.y || 0) - (Number(prev.y || 0) + Number(prev.h || 0));
  if (gap < -8 || gap > 48) return false;

  const anchorX = Number(group.lines[0].x || 0);
  const x = Number(line.x || 0);
  const leftAligned = Math.abs(x - anchorX) <= 46;
  const horizontallyOverlaps = x <= Number(prev.x || 0) + Number(prev.w || 0) + 24 &&
    Number(prev.x || 0) <= x + Number(line.w || 0) + 24;
  return leftAligned || horizontallyOverlaps;
}

function groupToKakaoMessage(group, id, roomLabel) {
  const lines = group.lines;
  const text = lines.map((line) => line.text).join('\n').trim();
  return {
    id: `kakao-${String(id).padStart(5, '0')}`,
    schema: 'chat.message.v1',
    room: roomLabel,
    speaker: group.speaker,
    speaker_confidence: group.speakerConfidence,
    direction: group.direction,
    text,
    kind: group.kind,
    timestamp_text: null,
    source: {
      frame: group.frame,
      bbox: bboxFromLines(lines),
      line_count: lines.length,
      barrier_before: Boolean(group.barrierBefore),
      line_boxes: lines.map((line) => [line.x || 0, line.y || 0, line.w || 0, line.h || 0]),
    },
    flags: group.flags,
  };
}

function possibleUnmergedKakaoFragmentPair(a, b) {
  if (!a || !b) return false;
  if (a.source?.frame !== b.source?.frame) return false;
  if (b.source?.barrier_before) return false;
  if (a.speaker !== b.speaker || a.direction !== b.direction || a.kind !== b.kind) return false;
  if (a.kind !== 'text') return false;
  const abox = a.source?.bbox || [];
  const bbox = b.source?.bbox || [];
  const ay = Number(abox[1]);
  const ah = Number(abox[3]);
  const by = Number(bbox[1]);
  const ax = Number(abox[0]);
  const bx = Number(bbox[0]);
  if (![ay, ah, by, ax, bx].every(Number.isFinite)) return false;
  const gap = by - (ay + ah);
  return gap >= -8 && gap <= 48 && Math.abs(ax - bx) <= 46;
}

function dedupeFrameOverlaps(messages) {
  const kept = [];
  const byKey = new Map();
  let removed = 0;
  for (const msg of messages) {
    const key = messageDedupeKey(msg);
    const prior = byKey.get(key) || [];
    if (prior.some((prev) => isAdjacentFrameOverlap(prev, msg))) {
      removed++;
      continue;
    }
    kept.push(msg);
    prior.push(msg);
    byKey.set(key, prior.slice(-4));
  }
  return { messages: kept, removed };
}

function structureDir(dir, roomLabel = 'KakaoTalk chat', incomingSpeaker = null, captureOptions = {}) {
  const jsonFiles = readdirSync(dir).filter((f) => /^frame_\d+\.json$/.test(f)).sort().reverse();
  const messages = [];
  let rawLines = 0;
  let filteredLines = 0;
  let senderLines = 0;
  let replyContextLines = 0;
  let linesMerged = 0;
  let multiLineMessages = 0;
  let id = 1;
  let currentIncomingSpeaker = incomingSpeaker || roomLabel || 'Unknown';
  for (const file of jsonFiles) {
    let arr = [];
    try { arr = JSON.parse(readFileSync(join(dir, file), 'utf8')); } catch { continue; }
    rawLines += Array.isArray(arr) ? arr.length : 0;
    const usable = arr
      .filter((it) => String(it.text || '').trim().length >= 2)
      .sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const maxRight = Math.max(...usable.map((it) => (it.x || 0) + (it.w || 0)), 1);
    let currentGroup = null;
    let barrierBeforeNext = true;
    const flushGroup = () => {
      if (!currentGroup || !currentGroup.lines.length) return;
      messages.push(groupToKakaoMessage(currentGroup, id++, roomLabel));
      if (currentGroup.lines.length > 1) {
        multiLineMessages++;
        linesMerged += currentGroup.lines.length - 1;
      }
      currentGroup = null;
    };
    for (const it of usable) {
      const text = normalizeKakaoLineText(it.text, it);
      if (isKakaoUiChrome(text, it)) {
        flushGroup();
        barrierBeforeNext = true;
        filteredLines++;
        continue;
      }
      if (isKakaoReplyContext(text)) {
        flushGroup();
        barrierBeforeNext = true;
        replyContextLines++;
        continue;
      }
      if (isKakaoSenderLine(text)) {
        flushGroup();
        barrierBeforeNext = true;
        currentIncomingSpeaker = cleanKakaoSenderName(text);
        senderLines++;
        continue;
      }
      const center = (it.x || 0) + (it.w || 0) / 2;
      const direction = center > maxRight * 0.58 ? 'outgoing' : 'incoming';
      const speaker = direction === 'outgoing' ? 'Me' : currentIncomingSpeaker;
      const line = {
        frame: file,
        speaker,
        speakerConfidence: direction === 'outgoing' ? 0.8 : (incomingSpeaker || roomLabel ? 0.55 : 0.1),
        direction,
        text,
        kind: normalizeKakaoKind(text),
        x: it.x || 0,
        y: it.y || 0,
        w: it.w || 0,
        h: it.h || 0,
        flags: direction === 'incoming' && !incomingSpeaker && !roomLabel ? ['speaker_unknown'] : [],
      };
      if (shouldMergeKakaoLine(currentGroup, line)) {
        currentGroup.lines.push(line);
      } else {
        flushGroup();
        currentGroup = {
          frame: file,
          speaker,
          speakerConfidence: line.speakerConfidence,
          direction,
          kind: line.kind,
          flags: line.flags,
          barrierBefore: barrierBeforeNext,
          lines: [line],
        };
        barrierBeforeNext = false;
      }
    }
    flushGroup();
  }
  const deduped = dedupeFrameOverlaps(messages);
  const finalMessages = deduped.messages.map((msg, index) => ({ ...msg, id: `kakao-${String(index + 1).padStart(5, '0')}` }));
  const finalLinesMerged = finalMessages.reduce((sum, msg) => sum + Math.max(0, Number(msg.source?.line_count || 1) - 1), 0);
  const finalMultiLineMessages = finalMessages.filter((msg) => Number(msg.source?.line_count || 1) > 1).length;
  let splitFragmentPairs = 0;
  for (let i = 1; i < finalMessages.length; i++) {
    if (possibleUnmergedKakaoFragmentPair(finalMessages[i - 1], finalMessages[i])) splitFragmentPairs++;
  }
  const stats = {
    frames: jsonFiles.length,
    raw_ocr_lines: rawLines,
    filtered_ui_lines: filteredLines,
    sender_context_lines: senderLines,
    reply_context_lines: replyContextLines,
    messages: finalMessages.length,
    duplicates_removed: deduped.removed,
    lines_merged: finalLinesMerged,
    multi_line_messages: finalMultiLineMessages,
    pre_dedupe_lines_merged: linesMerged,
    pre_dedupe_multi_line_messages: multiLineMessages,
    split_fragment_pairs: splitFragmentPairs,
    unknown_speaker_messages: finalMessages.filter((m) => m.speaker === 'Unknown').length,
    outgoing: finalMessages.filter((m) => m.direction === 'outgoing').length,
    incoming: finalMessages.filter((m) => m.direction === 'incoming').length,
  };
  const maxFrames = Number(captureOptions.maxFrames || 0);
  const hitMaxFrames = maxFrames > 0 && jsonFiles.length >= maxFrames;
  const topReached = typeof captureOptions.topReached === 'boolean' ? captureOptions.topReached : null;
  const bottomReached = typeof captureOptions.bottomReached === 'boolean' ? captureOptions.bottomReached : null;
  const qualityNotes = [
    hitMaxFrames ? 'capture stopped at max_frames; full history is not proven' : '',
    topReached === false && !hitMaxFrames ? 'capture ended without proving the oldest message was reached' : '',
    captureOptions.toBottom && bottomReached === false ? 'capture did not prove the newest message was reached before scrolling upward' : '',
  ].filter(Boolean);
  const doc = { schema: 'kakao_regular_messages.v1', room: roomLabel, stats, messages: finalMessages };
  writeJson(join(dir, 'kakao_messages.json'), doc);
  writeJson(join(dir, 'kakao_regular_manifest.json'), {
    schema: 'kakao_regular.run.v1',
    room_label: roomLabel,
    generated_at: isoNow(),
    capture: {
      frame_count: jsonFiles.length,
      max_frames: maxFrames || null,
      to_bottom: Boolean(captureOptions.toBottom),
      stopped_at_max_frames: maxFrames > 0 ? hitMaxFrames : null,
      stop_reason: captureOptions.stopReason || null,
      top_reached: topReached,
      bottom_reached: bottomReached,
    },
    quality: {
      status: stats.messages ? 'review' : 'fail',
      stopped_at_max_frames: hitMaxFrames,
      notes: qualityNotes,
    },
    stats,
  });
  return doc;
}

function audit(dir, check = false) {
  const issues = [];
  if (!existsSync(join(dir, 'kakao_regular_manifest.json'))) issues.push({ severity: 'fail', message: 'missing kakao_regular_manifest.json' });
  if (!existsSync(join(dir, 'kakao_messages.json'))) issues.push({ severity: 'fail', message: 'missing kakao_messages.json' });
  const manifest = existsSync(join(dir, 'kakao_regular_manifest.json')) ? readJson(join(dir, 'kakao_regular_manifest.json'), {}) : {};
  const frameCount = existsSync(dir) ? readdirSync(dir).filter((f) => /^frame_\d+\.png$/.test(f)).length : 0;
  const ocrCount = existsSync(dir) ? readdirSync(dir).filter((f) => /^frame_\d+\.json$/.test(f)).length : 0;
  const maxFrames = Number(manifest.capture?.max_frames || manifest.quality?.max_frames || 0);
  const hitMaxFrames = maxFrames > 0 && frameCount >= maxFrames;
  const topReached = typeof manifest.capture?.top_reached === 'boolean' ? manifest.capture.top_reached : null;
  const bottomReached = typeof manifest.capture?.bottom_reached === 'boolean' ? manifest.capture.bottom_reached : null;
  if (frameCount === 0) issues.push({ severity: 'fail', message: 'no frame PNG files' });
  if (ocrCount === 0) issues.push({ severity: 'fail', message: 'no OCR JSON files' });
  if (frameCount > 0 && frameCount < 5 && topReached !== true) issues.push({ severity: 'review', message: 'short scrape; increase --max-frames/--to-bottom before treating as complete history' });
  if (hitMaxFrames) issues.push({ severity: 'review', message: 'capture stopped at max_frames; full history is not proven' });
  if (topReached === false && !hitMaxFrames) issues.push({ severity: 'review', message: 'oldest message was not proven reached' });
  if (manifest.capture?.to_bottom && bottomReached === false) issues.push({ severity: 'review', message: 'newest message was not proven reached' });
  let messages = null;
  try { messages = readJson(join(dir, 'kakao_messages.json')); } catch {}
  if (messages && (messages.stats?.messages || 0) === 0) issues.push({ severity: 'fail', message: 'no structured messages' });
  if ((messages?.stats?.unknown_speaker_messages || 0) > 0) issues.push({ severity: 'review', message: 'unknown speaker messages present' });
  if ((messages?.stats?.speaker_room_label_fallback_messages || 0) > 0) {
    issues.push({ severity: 'review', message: `room-label fallback speaker messages present: ${messages.stats.speaker_room_label_fallback_messages}` });
  }
  if ((messages?.stats?.split_fragment_pairs || 0) > 0) issues.push({ severity: 'review', message: `possible split message fragments present: ${messages.stats.split_fragment_pairs}` });
  const noisy = (messages?.messages || []).filter((m) => (
    (m.kind || 'text') === 'text' && (
      isKakaoUiChrome(m.text, { y: 300 }) || isKakaoReplyContext(m.text) || isKakaoSenderLine(m.text)
    )
  ));
  if (noisy.length) issues.push({ severity: 'fail', message: `ui/context lines leaked into messages: ${noisy.length}` });
  const adjacentDuplicates = [];
  const byKey = new Map();
  for (const msg of messages?.messages || []) {
    const key = messageDedupeKey(msg);
    const prior = byKey.get(key) || [];
    if (prior.some((prev) => isAdjacentFrameOverlap(prev, msg))) adjacentDuplicates.push(msg.id);
    prior.push(msg);
    byKey.set(key, prior.slice(-4));
  }
  if (adjacentDuplicates.length) issues.push({ severity: 'review', message: `adjacent frame duplicate messages present: ${adjacentDuplicates.length}` });
  const status = classifyStatus(issues);
  const out = {
    schema: 'kakao_regular.audit.v1',
    audited_at: isoNow(),
    status,
    issues,
    counts: {
      frames: frameCount,
      max_frames: maxFrames || null,
      stopped_at_max_frames: maxFrames > 0 ? hitMaxFrames : null,
      top_reached: topReached,
      bottom_reached: bottomReached,
      ocr: ocrCount,
      messages: messages?.stats?.messages || 0,
      lines_merged: messages?.stats?.lines_merged || 0,
      multi_line_messages: messages?.stats?.multi_line_messages || 0,
      split_fragment_pairs: messages?.stats?.split_fragment_pairs || 0,
      speaker_room_label_fallback_messages: messages?.stats?.speaker_room_label_fallback_messages || 0,
    },
  };
  writeJson(join(dir, 'kakao_regular_audit.json'), out);
  printSummary(out);
  if (check && status !== 'PASS') process.exit(1);
}

async function scrapeChat() {
  if (!args['confirm-local-backup']) throw new Error('chat requires --confirm-local-backup');
  if (existsSync(stopFile)) {
    const outDir = resolve(args.out || join(shotsDirLocal, `kakao_regular_skip_${Date.now()}`));
    writeJson(join(outDir, 'kakao_regular_manifest.json'), { schema: 'kakao_regular.run.v1', status: 'SKIP', reason: 'STOP_SET' });
    printSummary({ status: 'SKIP', reason: 'STOP_SET', out_dir: outDir });
    return;
  }
  const title = args.title || args._[1];
  const hwnd = args.hwnd || (title ? resolveHwndByTitle(title) : null);
  if (!hwnd) throw new Error('missing or unresolved --title/--hwnd');
  const maxFrames = Number(args['max-frames'] || 40);
  let dir = null;
  let captureMeta = {};
  if (process.platform === 'win32' || args['windows-native']) {
    const scraped = scrapeChatWindowsNative({
      hwnd,
      maxFrames,
      toBottom: Boolean(args['to-bottom']),
      outDir: args.out || args['out-dir'] || '',
    });
    dir = scraped.dir;
    captureMeta = scraped.capture || {};
  } else {
    const extra = ['scripts/scrape_room.sh', 'scrape', '-Hwnd', String(hwnd), '-MaxFrames', String(maxFrames)];
    if (args['to-bottom']) extra.push('-ToBottom');
    const res = run('bash', extra, { cwd: repo });
    process.stderr.write(res.stderr || '');
    process.stdout.write(res.stdout || '');
    if (!res.ok) throw new Error('scrape_room.sh failed');
    const m = (res.stdout + res.stderr).match(/TRANSCRIPT=(.+?transcript\.txt)/);
    if (m) {
      const w = m[1].replace(/\r/g, '');
      dir = dirname(windowsPathToWsl(w));
    }
    if (!dir) throw new Error('could not resolve scrape output dir');
  }
  structureDir(dir, args['room-label'] || title || 'KakaoTalk chat', args['incoming-speaker'] || null, {
    maxFrames,
    toBottom: Boolean(args['to-bottom']),
    ...captureMeta,
  });
  audit(dir, false);
}

try {
  if (cmd === 'help' || args.help) {
    usage();
  } else if (cmd === 'chat') {
    await scrapeChat();
  } else if (cmd === 'chat-batch') {
    if (!args['confirm-local-backup']) throw new Error('chat-batch requires --confirm-local-backup');
    const openPatterns = asArray(args['open-visible'] || args['visible-room']).filter(Boolean);
    const opened = [];
    for (const pattern of openPatterns) opened.push({ pattern, ...openVisibleRoom(pattern) });
    const titles = asArray(args.title).filter(Boolean);
    const requestedTargets = opened.filter((item) => item.hwnd).map((item) => ({
      title: item.title || item.pattern,
      hwnd: item.hwnd,
      close_after: Boolean(item.opened_new),
    }));
    const availableWindows = listKakaoChatWindows();
    const windows = titles.length
      ? titles.map((title) => ({ title, hwnd: resolveHwndByTitle(title), close_after: false }))
      : (requestedTargets.length
        ? requestedTargets
        : (args['active-only'] ? [availableWindows.find((win) => win.foreground) || availableWindows[0]] : availableWindows));
    const targets = [...new Map(windows.filter((win) => win?.hwnd).map((win) => [String(win.hwnd), win])).values()];
    if (!targets.length) {
      const mainOpen = listKakaoWindows().some(isMainKakaoWindow);
      printSummary({
        schema: 'kakao_regular.batch.v1',
        status: 'FAIL',
        reason: 'NO_KAKAO_CHAT_WINDOWS',
        main_window_open: mainOpen,
        opened,
        message: 'open KakaoTalk chat windows, pass --title values, or use --open-visible REGEX for a room visible in the KakaoTalk main list',
      });
      process.exitCode = 1;
    } else {
      const results = [];
      for (const win of targets) {
        args.title = win.title;
        args.hwnd = win.hwnd;
        try {
          await scrapeChat();
          results.push({ title: win.title, hwnd: win.hwnd, status: 'attempted' });
        } finally {
          if (win.close_after) closeKakaoWindow(win.hwnd);
        }
      }
      printSummary({ schema: 'kakao_regular.batch.v1', status: 'PASS', attempted: results.length, opened, results });
    }
  } else if (cmd === 'structure') {
    const dir = args._[1] || args.dir;
    if (!dir) throw new Error('missing DIR');
    const maxFrames = Number(args['max-frames'] || 0);
    structureDir(resolve(dir), args['room-label'] || args.title || 'KakaoTalk chat', args['incoming-speaker'] || null, {
      maxFrames,
      toBottom: Boolean(args['to-bottom']),
    });
  } else if (cmd === 'chat-audit' || cmd === 'audit') {
    const dir = args._[1] || args.dir;
    if (!dir) throw new Error('missing DIR');
    audit(resolve(dir), !!args.check);
  } else {
    usage();
    process.exit(2);
  }
} catch (err) {
  console.error(`FAIL ${err.message}`);
  process.exit(1);
}
