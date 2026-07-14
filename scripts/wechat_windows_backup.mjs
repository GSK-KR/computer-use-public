#!/usr/bin/env node
// Windows-native WeChat current-room backup.
//
// This path intentionally uses only Windows Node + PowerShell helpers:
// scrape_capture.ps1 -> ocr_lines.ps1 -> stitch.mjs -> wechat_structure.mjs.
// It does not read WeChat private databases or send messages.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPathConfig } from './lib/path_config.mjs';
import { parseArgs, run, timestamp, writeJson } from './lib/cu_common.mjs';

const args = parseArgs();
const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const pathConfig = loadPathConfig();
const stateDirLocal = process.platform === 'win32' ? pathConfig.stateDirWin : pathConfig.stateDirWsl;
const shotsDirLocal = process.platform === 'win32' ? pathConfig.shotsDirWin : pathConfig.shotsDirWsl;
const stopFile = join(stateDirLocal, 'STOP');

function usage() {
  console.log(`usage:
  node scripts/wechat_windows_backup.mjs --confirm-local-backup [--room-label NAME] [--incoming-speaker NAME|auto] [--max-frames N] [--hwnd N] [--to-bottom]`);
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

function isoNow() {
  return new Date().toISOString();
}

function countTranscriptLines(text) {
  return String(text || '').split(/\r?\n/u).filter((line) => line.trim()).length;
}

function updateManifestQuality(manifestPath, messagesPath, frameCount) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const messagesDoc = JSON.parse(readFileSync(messagesPath, 'utf8'));
  const stats = messagesDoc.stats || {};
  const unknown = Number(stats.unknown_speaker_messages || 0);
  const low = Array.isArray(stats.low_confidence_text_message_ids)
    ? stats.low_confidence_text_message_ids.length
    : (Array.isArray(stats.low_confidence_message_ids) ? stats.low_confidence_message_ids.length : 0);
  const nonText = Array.isArray(stats.non_text_message_ids) ? stats.non_text_message_ids.length : 0;
  const maxFrames = Number(manifest.capture?.max_frames || 0);
  const hitMax = maxFrames > 0 && frameCount >= maxFrames;
  const topReached = typeof manifest.capture?.top_reached === 'boolean' ? manifest.capture.top_reached : null;
  const bottomReached = typeof manifest.capture?.bottom_reached === 'boolean' ? manifest.capture.bottom_reached : null;
  const notes = [
    hitMax ? 'capture stopped at max_frames; full history is not proven' : '',
    topReached === false && !hitMax ? 'capture ended without proving the oldest message was reached' : '',
    manifest.capture?.to_bottom && bottomReached === false ? 'capture did not prove the newest message was reached before scrolling upward' : '',
    unknown > 0 ? 'some messages have unknown speaker; verify against screenshots' : '',
    low > 0 ? 'some text messages have low OCR confidence; verify text manually' : '',
    nonText > 0 ? 'some entries are attachment/media cards; verify original WeChat files or media' : '',
  ].filter(Boolean);
  manifest.quality = {
    status: notes.length ? 'review' : 'pass',
    stopped_at_max_frames: hitMax,
    top_reached: topReached,
    bottom_reached: bottomReached,
    unknown_speaker_messages: unknown,
    low_confidence_text_messages: low,
    non_text_messages: nonText,
    translation_failed: false,
    notes,
  };
  writeJson(manifestPath, manifest);
  return manifest;
}

async function main() {
  if (args.help || args._[0] === 'help') {
    usage();
    return;
  }
  if (!args['confirm-local-backup']) throw new Error('WeChat backup requires --confirm-local-backup');
  if (existsSync(stopFile)) {
    console.log('STOPPED: state\\STOP present. Clear it to resume.');
    process.exitCode = 9;
    return;
  }

  const maxFrames = intArg('max-frames', 120, 1, 800);
  const notches = intArg('notches', 3, 1, 20);
  const roomLabel = textArg('room-label');
  let incomingSpeaker = textArg('incoming-speaker');
  const ocrLang = textArg('ocr-lang', 'zh-Hans');
  const proc = textArg('proc', 'Weixin');
  const hwnd = textArg('hwnd');
  const outDirWin = textArg('out-dir') || join(pathConfig.shotsDirWin, `wechat_windows_${timestamp()}`);
  mkdirSync(outDirWin, { recursive: true });
  let incomingSpeakerMode = incomingSpeaker ? 'hint-incoming-speaker' : null;
  if (incomingSpeaker === 'auto') {
    if (!roomLabel) throw new Error('--incoming-speaker auto requires --room-label');
    incomingSpeaker = roomLabel;
    incomingSpeakerMode = 'room-label-auto';
  }

  const captureArgs = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    `${pathConfig.scriptsDirWin}\\scrape_capture.ps1`,
    proc,
    '-MaxFrames',
    String(maxFrames),
    '-Notches',
    String(notches),
    '-OutDir',
    outDirWin,
  ];
  if (hwnd) captureArgs.push('-Hwnd', hwnd);
  if (args['to-bottom']) captureArgs.push('-ToBottom');

  const startedAt = Date.now();
  console.error('>> 위챗 화면을 캡처하는 중입니다...');
  const capture = run('powershell.exe', captureArgs, { cwd: repo });
  process.stderr.write(capture.stderr || '');
  process.stdout.write(capture.stdout || '');
  if (!capture.ok) throw new Error(`WeChat capture failed: ${capture.stderr || capture.stdout}`);
  const captureText = capture.stdout + capture.stderr;
  const dirWin = captureText.match(/DIR=(.+)$/m)?.[1]?.trim() || outDirWin;
  const topMatch = captureText.match(/\bTOP_REACHED=(True|False)\b/iu);
  const bottomMatch = captureText.match(/\bBOTTOM_REACHED=(True|False)\b/iu);
  const captureTopReached = topMatch ? topMatch[1].toLowerCase() === 'true' : null;
  const captureBottomReached = bottomMatch ? bottomMatch[1].toLowerCase() === 'true' : null;
  const captureStopReason = captureText.match(/\bSTOP_REASON=([^\s]+)/u)?.[1] || null;
  const dir = windowsPathToLocal(dirWin);
  const frames = readdirSync(dir).filter((file) => /^frame_\d+\.png$/u.test(file)).sort();
  if (!frames.length) throw new Error(`no frame_*.png captured in ${dir}`);

  const firstSize = pngSize(join(dir, frames[0])) || { width: 0, height: 0 };
  const crop = `${firstSize.width || 1}x${firstSize.height || 1}+0+0`;
  const tessDir = join(dir, 'tess_json');
  mkdirSync(tessDir, { recursive: true });

  console.error(`>> 화면 글자를 읽는 중입니다. 캡처 ${frames.length}장`);
  for (const frame of frames) {
    const framePath = join(dir, frame);
    const ocr = run('powershell.exe', [
      '-NoProfile',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      `${pathConfig.scriptsDirWin}\\ocr_lines.ps1`,
      localPathToWindows(framePath),
      ocrLang,
    ], { cwd: repo });
    if (!ocr.ok) throw new Error(`Windows OCR failed for ${frame}: ${ocr.stderr || ocr.stdout}`);
    writeFileSync(join(tessDir, frame.replace(/\.png$/u, '.json')), ocr.stdout || '[]\n', 'utf8');
  }

  const stitch = run(process.execPath, [join(repo, 'scripts', 'stitch.mjs'), tessDir], { cwd: repo });
  if (!stitch.ok) throw new Error(`stitch failed: ${stitch.stderr || stitch.stdout}`);
  writeFileSync(join(dir, 'wechat_tess_transcript_raw.txt'), stitch.stdout, 'utf8');
  writeFileSync(join(dir, 'transcript.txt'), stitch.stdout, 'utf8');

  const manifestPath = join(dir, 'wechat_scrape_manifest.json');
  const lineCount = countTranscriptLines(stitch.stdout);
  const manifest = {
    tool: 'wechat_windows_backup.mjs',
    created_at: isoNow(),
    room_label: roomLabel,
    target: { proc, hwnd: hwnd || null },
    speaker_hints: {
      incoming_speaker: incomingSpeaker || null,
      incoming_speaker_mode: incomingSpeakerMode,
      note: 'Use incoming_speaker only for one-to-one chats where left-side messages have no visible sender name.',
    },
    capture: {
      frame_count: frames.length,
      max_frames: maxFrames,
      notches,
      load_wait_ms: null,
      settle_ms: null,
      edge_guard_px: 0,
      bottom_guard_px: 0,
      input_guard_px: 0,
      input_recrop_count: 0,
      to_bottom: Boolean(args['to-bottom']),
      stop_reason: captureStopReason,
      top_reached: captureTopReached,
      bottom_reached: captureBottomReached,
    },
    ocr: {
      engine: 'windows_ocr',
      crop,
      langs: ocrLang,
      psm: null,
      min_conf: 0,
    },
    output: {
      dir_wsl: process.platform === 'win32' ? null : dir,
      dir_win: dirWin,
      transcript: 'transcript.txt',
      raw_transcript: 'wechat_tess_transcript_raw.txt',
      line_count: lineCount,
      messages_json: 'wechat_messages.json',
      messages_markdown: 'wechat_messages.md',
      translated_report_ko: null,
    },
    timings: {
      total_elapsed_s: null,
    },
    privacy: {
      scope: 'single user-opened WeChat room/window',
      storage: 'local shots directory',
      network_upload: false,
      cloud_translation_requested: false,
    },
    translation_provider: null,
  };
  writeJson(manifestPath, manifest);

  const messagesJson = join(dir, 'wechat_messages.json');
  const messagesMd = join(dir, 'wechat_messages.md');
  const structure = run(process.execPath, [
    join(repo, 'scripts', 'wechat_structure.mjs'),
    '--dir',
    tessDir,
    '--manifest',
    manifestPath,
    '--out-json',
    messagesJson,
    '--out-md',
    messagesMd,
    '--crop',
    crop,
    '--edge-guard-px',
    '0',
  ], { cwd: repo });
  process.stdout.write(structure.stdout || '');
  process.stderr.write(structure.stderr || '');
  if (!structure.ok) throw new Error('WeChat structure failed');

  const messages = JSON.parse(readFileSync(messagesJson, 'utf8'));
  if (Number(messages.stats?.messages || 0) === 0 || Number(messages.stats?.raw_ocr_lines || 0) < 2) {
    throw new Error(`no usable WeChat message OCR detected (messages=${messages.stats?.messages || 0}, raw_ocr_lines=${messages.stats?.raw_ocr_lines || 0})`);
  }

  const finalManifest = updateManifestQuality(manifestPath, messagesJson, frames.length);
  finalManifest.timings.total_elapsed_s = Math.round((Date.now() - startedAt) / 100) / 10;
  writeJson(manifestPath, finalManifest);

  const audit = run(process.execPath, [join(repo, 'scripts', 'wechat_audit.mjs'), '--dir', dir, '--json'], { cwd: repo });
  if (audit.stdout) writeFileSync(join(dir, 'wechat_audit.json'), audit.stdout, 'utf8');
  if (audit.stdout) process.stdout.write(audit.stdout);
  if (audit.stderr) process.stderr.write(audit.stderr);
  if (!audit.ok) throw new Error('WeChat audit failed');

  console.log(`WECHAT_DIR=${dirWin}`);
  console.log(`WECHAT_MESSAGES=${localPathToWindows(messagesJson)}`);
}

main().catch((err) => {
  console.error(`FAIL ${err.message}`);
  process.exit(1);
});
