#!/usr/bin/env node
// Windows-native KakaoTalk open-chat backup.
//
// This mirrors kakao_openchat_scrape.sh without requiring bash, jq, md5sum, or
// other WSL tools. It uses Windows PowerShell helpers for capture, scrolling,
// clicking comment markers, and Windows.Media.Ocr for OCR.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPathConfig } from './lib/path_config.mjs';
import { parseArgs, readJson, run, timestamp, writeJson } from './lib/cu_common.mjs';

const args = parseArgs();
const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const pathConfig = loadPathConfig();

function usage() {
  console.log(`usage:
  node scripts/kakao_openchat_windows_backup.mjs --confirm-local-backup --title ROOM [options]

Target:
  --hwnd N                    exact KakaoTalk chat window handle
  --title TEXT                KakaoTalk window title substring
  --proc NAME                 process name, default KakaoTalk
  --room-label TEXT           label stored in manifest

Capture:
  --out-dir DIR               output dir, default shots/kakao_openchat_YYYYMMDD_HHMMSS
  --max-frames N              main-chat frames, default 80
  --thread-max-frames N       per-comment thread frames, default 30
  --notches N                 wheel notches per scroll, default 7
  --to-bottom                 first scroll to newest/bottom, then scrape upward
  --no-comments               only scrape main chat

Advanced:
  --load-wait-ms N            wait after main scroll, default 650
  --thread-wait-ms N          wait after opening comment thread, default 900
  --main-fx N --main-fy N     main scroll fraction, default 0.50/0.45
  --thread-fx N --thread-fy N thread scroll fraction, default 0.72/0.55`);
}

function intArg(name, fallback, min, max) {
  const n = Number(args[name] ?? fallback);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be ${min}-${max}`);
  return n;
}

function floatArg(name, fallback, min, max) {
  const n = Number(args[name] ?? fallback);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be ${min}-${max}`);
  return n;
}

function textArg(name, fallback = '') {
  return String(args[name] ?? fallback ?? '').trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function windowsPathToLocal(path) {
  const text = String(path || '').trim();
  if (process.platform === 'win32') return text;
  return text.replace(/^([A-Za-z]):[\\/]/u, (_, drive) => `/mnt/${drive.toLowerCase()}/`).replace(/\\/g, '/');
}

function localPathToWindows(path) {
  const text = String(path || '').trim();
  if (process.platform === 'win32') return text;
  return text.replace(/^\/mnt\/([a-z])\//iu, (_, drive) => `${drive.toUpperCase()}:\\`).replace(/\//g, '\\');
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

function sha1File(file) {
  return createHash('sha1').update(readFileSync(file)).digest('hex');
}

function parseRectOutput(text) {
  const hwnd = String(text || '').match(/hwnd=(\d+)/u)?.[1] || '';
  const rectText = String(text || '').match(/rect=(-?\d+,-?\d+,-?\d+,-?\d+)/u)?.[1] || '';
  if (!hwnd || !rectText) return null;
  const [left, top, right, bottom] = rectText.split(',').map((it) => Number(it));
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  return {
    hwnd,
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    rectText,
  };
}

function psKakao(cmd, extra = []) {
  return run('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    `${pathConfig.scriptsDirWin}\\kakao_window.ps1`,
    cmd,
    ...extra.map((it) => String(it)),
  ], { cwd: repo, maxBuffer: 16 * 1024 * 1024 });
}

function psOcr(imageFile, lang = 'ko') {
  return run('powershell.exe', [
    '-NoProfile',
    '-STA',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    `${pathConfig.scriptsDirWin}\\ocr_lines.ps1`,
    localPathToWindows(imageFile),
    lang,
  ], { cwd: repo, maxBuffer: 16 * 1024 * 1024 });
}

function targetArgs({ hwnd, proc, title }) {
  if (hwnd) return ['-Hwnd', hwnd];
  const out = ['-ProcName', proc];
  if (title) out.push('-Title', title);
  return out;
}

function windowList(proc, file) {
  const result = psKakao('list', ['-ProcName', proc]);
  writeFileSync(file, result.ok ? result.stdout : '', 'utf8');
  return result.ok ? result.stdout : '';
}

function firstNewHwnd(beforeText, afterText) {
  const before = new Set([...String(beforeText || '').matchAll(/hwnd=(\d+)/gu)].map((m) => m[1]));
  for (const match of String(afterText || '').matchAll(/hwnd=(\d+)/gu)) {
    if (!before.has(match[1])) return match[1];
  }
  return '';
}

async function waitForMainWindow(hwnd) {
  for (let i = 0; i < 20; i++) {
    if (psKakao('rect', ['-Hwnd', hwnd]).ok) return true;
    await sleep(250);
  }
  return false;
}

function runThreadDetector({ ocrJson, frameIndex, windowWidth, windowHeight, outFile }) {
  const result = run(process.execPath, [
    join(repo, 'scripts', 'kakao_openchat_threads.mjs'),
    '--ocr',
    ocrJson,
    '--frame-index',
    String(frameIndex),
    '--window-width',
    String(windowWidth),
    '--window-height',
    String(windowHeight),
  ], { cwd: repo, maxBuffer: 16 * 1024 * 1024 });
  if (!result.ok) throw new Error(`comment marker detection failed: ${result.stderr || result.stdout}`);
  writeFileSync(outFile, result.stdout, 'utf8');
  return JSON.parse(result.stdout);
}

async function main() {
  if (args.help || args._[0] === 'help') {
    usage();
    return;
  }
  if (!args['confirm-local-backup']) throw new Error('KakaoTalk open-chat backup requires --confirm-local-backup');

  const proc = textArg('proc', 'KakaoTalk');
  const title = textArg('title');
  const hwndArg = textArg('hwnd');
  if (!title && !hwndArg) throw new Error('--title or --hwnd is required');

  const maxFrames = intArg('max-frames', 80, 1, 500);
  const threadMaxFrames = intArg('thread-max-frames', 30, 1, 200);
  const notches = intArg('notches', 7, 1, 20);
  const loadWaitMs = intArg('load-wait-ms', 650, 0, 10000);
  const threadWaitMs = intArg('thread-wait-ms', 900, 0, 10000);
  const mainFx = floatArg('main-fx', 0.5, 0.05, 0.95);
  const mainFy = floatArg('main-fy', 0.45, 0.05, 0.95);
  const threadFx = floatArg('thread-fx', 0.72, 0.05, 0.95);
  const threadFy = floatArg('thread-fy', 0.55, 0.05, 0.95);
  const openThreads = !args['no-comments'];
  const roomLabel = textArg('room-label', title || 'KakaoTalk open chat');

  const outArg = textArg('out-dir');
  const outDir = outArg
    ? windowsPathToLocal(outArg)
    : join(process.platform === 'win32' ? pathConfig.shotsDirWin : pathConfig.shotsDirWsl, `kakao_openchat_${timestamp()}`);
  const outDirWin = localPathToWindows(outDir);
  const framesDir = ensureDir(join(outDir, 'frames'));
  const ocrDir = ensureDir(join(outDir, 'ocr'));
  const candidatesDir = ensureDir(join(outDir, 'thread_candidates'));
  const threadsDir = ensureDir(join(outDir, 'threads'));

  const rectResult = psKakao('rect', targetArgs({ hwnd: hwndArg, proc, title }));
  if (!rectResult.ok) throw new Error(`failed to resolve KakaoTalk window: ${rectResult.stderr || rectResult.stdout}`);
  let mainRect = parseRectOutput(rectResult.stdout + rectResult.stderr);
  if (!mainRect || mainRect.width <= 0 || mainRect.height <= 0) {
    throw new Error(`failed to parse KakaoTalk window rect: ${rectResult.stdout || rectResult.stderr}`);
  }
  const mainHwnd = mainRect.hwnd;
  const startedAt = Date.now();
  console.error(`TARGET hwnd=${mainHwnd} rect=${mainRect.rectText} label=${roomLabel}`);

  const seenKeys = new Set();
  const seenPath = join(threadsDir, '.seen_comment_keys');
  writeFileSync(seenPath, '', 'utf8');
  const threadEntries = [];
  let threadCount = 0;
  let mainFrames = 0;
  let prevMainHash = '';

  async function captureOcrFrame(hwnd, png, json, updateMainRect = false) {
    const cap = psKakao('capture', ['-Hwnd', hwnd, '-OutPath', localPathToWindows(png)]);
    if (!cap.ok) {
      console.error(`WARN: capture failed for ${png}: ${cap.stderr || cap.stdout}`);
      return false;
    }
    if (updateMainRect) {
      const parsed = parseRectOutput(cap.stdout + cap.stderr);
      if (parsed) mainRect = parsed;
    }
    const ocr = psOcr(png, 'ko');
    if (!ocr.ok) {
      console.error(`WARN: OCR failed for ${png}: ${ocr.stderr || ocr.stdout}`);
      writeFileSync(json, '[]\n', 'utf8');
      return false;
    }
    writeFileSync(json, ocr.stdout || '[]\n', 'utf8');
    return true;
  }

  function writeThreadFailure(tdir, parentFrame, candidate, status, detail) {
    ensureDir(join(tdir, 'frames'));
    ensureDir(join(tdir, 'ocr'));
    writeJson(join(tdir, 'candidate.json'), candidate);
    writeFileSync(join(tdir, 'transcript.txt'), '', 'utf8');
    writeJson(join(tdir, 'thread_manifest.json'), {
      schema: 'kakao_openchat_thread.v1',
      generated_at: new Date().toISOString(),
      room_label: roomLabel,
      parent_frame: parentFrame,
      captured_frames: 0,
      status,
      detail,
      candidate,
      files: {
        transcript: 'transcript.txt',
        manifest: 'thread_manifest.json',
        candidate: 'candidate.json',
      },
    });
  }

  async function captureThread(tdir, threadHwnd, parentFrame, candidate) {
    const tFrames = ensureDir(join(tdir, 'frames'));
    const tOcr = ensureDir(join(tdir, 'ocr'));
    const started = Date.now();
    let prev = '';
    let count = 0;
    for (let j = 0; j < threadMaxFrames; j++) {
      const png = join(tFrames, `frame_${pad3(j)}.png`);
      const json = join(tOcr, `frame_${pad3(j)}.json`);
      const ok = await captureOcrFrame(threadHwnd, png, json, false);
      if (!ok) {
        rmSync(png, { force: true });
        rmSync(json, { force: true });
        break;
      }
      const hash = sha1File(png);
      if (j > 0 && hash === prev) {
        rmSync(png, { force: true });
        rmSync(json, { force: true });
        break;
      }
      prev = hash;
      count += 1;
      psKakao('scroll', ['-Hwnd', threadHwnd, '-Notches', String(notches), '-Fx', String(threadFx), '-Fy', String(threadFy)]);
      await sleep(loadWaitMs);
    }

    const stitch = run(process.execPath, [join(repo, 'scripts', 'stitch.mjs'), tOcr], { cwd: repo, maxBuffer: 16 * 1024 * 1024 });
    writeFileSync(join(tdir, 'transcript.txt'), stitch.ok ? stitch.stdout : '', 'utf8');
    writeJson(join(tdir, 'thread_manifest.json'), {
      schema: 'kakao_openchat_thread.v1',
      generated_at: new Date().toISOString(),
      room_label: roomLabel,
      thread_hwnd: Number(threadHwnd),
      parent_frame: parentFrame,
      captured_frames: count,
      status: count > 0 ? 'captured' : 'capture_failed',
      elapsed_seconds: Math.max(0, Math.round((Date.now() - started) / 1000)),
      candidate,
      files: {
        transcript: 'transcript.txt',
        manifest: 'thread_manifest.json',
        candidate: 'candidate.json',
      },
    });
    return count;
  }

  if (args['to-bottom']) {
    console.error('>> scrolling to bottom/newest...');
    let prev = '';
    const probe = join(outDir, '_bottom_probe.png');
    for (let i = 0; i < 50; i++) {
      psKakao('scroll', ['-Hwnd', mainHwnd, '-Notches', String(-notches), '-Fx', String(mainFx), '-Fy', String(mainFy)]);
      await sleep(loadWaitMs);
      const cap = psKakao('capture', ['-Hwnd', mainHwnd, '-OutPath', localPathToWindows(probe)]);
      if (!cap.ok || !existsSync(probe)) break;
      const cur = sha1File(probe);
      if (cur === prev) break;
      prev = cur;
    }
    rmSync(probe, { force: true });
  }

  for (let i = 0; i < maxFrames; i++) {
    const framePng = join(framesDir, `frame_${pad3(i)}.png`);
    const frameJson = join(ocrDir, `frame_${pad3(i)}.json`);
    console.error(`>> main frame ${i}/${maxFrames}`);
    const ok = await captureOcrFrame(mainHwnd, framePng, frameJson, true);
    if (!ok) {
      console.error(`WARN: stopping main loop after capture/OCR failure at frame ${i}`);
      break;
    }
    mainFrames += 1;

    let currentHash = sha1File(framePng);
    if (prevMainHash && currentHash === prevMainHash) {
      await sleep(loadWaitMs);
      await captureOcrFrame(mainHwnd, framePng, frameJson, true);
      currentHash = sha1File(framePng);
      if (currentHash === prevMainHash) {
        rmSync(framePng, { force: true });
        rmSync(frameJson, { force: true });
        mainFrames -= 1;
        console.error('>> main top/stable reached');
        break;
      }
    }
    prevMainHash = currentHash;

    const candFile = join(candidatesDir, `frame_${pad3(i)}.json`);
    const candDoc = runThreadDetector({
      ocrJson: frameJson,
      frameIndex: i,
      windowWidth: mainRect.width,
      windowHeight: mainRect.height,
      outFile: candFile,
    });

    if (openThreads) {
      for (const candidateRaw of candDoc.candidates || []) {
        const key = String(candidateRaw.dedupe_key || '');
        if (!key || seenKeys.has(key)) continue;
        seenKeys.add(key);
        writeFileSync(seenPath, `${[...seenKeys].join('\n')}\n`, 'utf8');

        const screenX = Math.round(mainRect.left + Number(candidateRaw.click_x || 0));
        const screenY = Math.round(mainRect.top + Number(candidateRaw.click_y || 0));
        threadCount += 1;
        const candidate = { ...candidateRaw, screen_x: screenX, screen_y: screenY };
        const tdir = join(threadsDir, `thread_${pad3(threadCount)}`);
        ensureDir(tdir);
        writeJson(join(tdir, 'candidate.json'), candidate);
        console.error(`>> open comment thread #${threadCount} at frame=${i} screen=${screenX},${screenY}`);

        const beforeFile = join(tdir, 'windows_before.txt');
        const afterFile = join(tdir, 'windows_after.txt');
        const beforeText = windowList(proc, beforeFile);
        const click = psKakao('click', ['-Hwnd', mainHwnd, '-X', String(screenX), '-Y', String(screenY)]);
        if (!click.ok) {
          writeThreadFailure(tdir, i, candidate, 'click_failed', 'failed to click comment marker');
          console.error(`WARN: comment thread #${threadCount} click failed`);
          threadEntries.push({ ...candidate, thread_index: threadCount, thread_dir: tdir, parent_frame: i, status: 'click_failed' });
          continue;
        }
        await sleep(threadWaitMs);
        const afterText = windowList(proc, afterFile);
        const threadHwnd = firstNewHwnd(beforeText, afterText);
        if (!threadHwnd) {
          writeThreadFailure(tdir, i, candidate, 'thread_window_not_found', 'no new KakaoTalk thread window appeared');
          console.error(`WARN: comment thread #${threadCount} window not found`);
          threadEntries.push({ ...candidate, thread_index: threadCount, thread_dir: tdir, parent_frame: i, status: 'thread_window_not_found' });
        } else {
          const capturedFrameCount = await captureThread(tdir, threadHwnd, i, candidate);
          threadEntries.push({
            ...candidate,
            thread_index: threadCount,
            thread_dir: tdir,
            parent_frame: i,
            status: capturedFrameCount > 0 ? 'captured' : 'capture_failed',
          });
          if (threadHwnd !== mainHwnd) psKakao('key', ['-Hwnd', threadHwnd, '-Keys', '%{F4}']);
        }
        await sleep(500);
        if (!await waitForMainWindow(mainHwnd)) {
          console.error(`WARN: main chat window did not return after comment thread #${threadCount}`);
          break;
        }
      }
    }

    psKakao('scroll', ['-Hwnd', mainHwnd, '-Notches', String(notches), '-Fx', String(mainFx), '-Fy', String(mainFy)]);
    await sleep(loadWaitMs);
  }

  const stitch = run(process.execPath, [join(repo, 'scripts', 'stitch.mjs'), ocrDir], { cwd: repo, maxBuffer: 16 * 1024 * 1024 });
  if (!stitch.ok) throw new Error(`stitch failed: ${stitch.stderr || stitch.stdout}`);
  writeFileSync(join(outDir, 'transcript.txt'), stitch.stdout, 'utf8');

  const threadManifests = readdirSync(threadsDir)
    .filter((name) => /^thread_\d+$/u.test(name))
    .map((name) => join(threadsDir, name, 'thread_manifest.json'))
    .filter((file) => existsSync(file))
    .map((file) => readJson(file, {}));
  const capturedThreads = threadManifests.filter((doc) => doc.status === 'captured').length;
  writeFileSync(
    join(threadsDir, 'thread_index.jsonl'),
    `${threadEntries.map((entry) => JSON.stringify(entry)).join('\n')}${threadEntries.length ? '\n' : ''}`,
    'utf8',
  );
  writeJson(join(threadsDir, 'thread_index.json'), {
    schema: 'kakao_openchat_thread_index.v1',
    threads: threadEntries,
  });
  writeJson(join(outDir, 'kakao_openchat_manifest.json'), {
    schema: 'kakao_openchat_scrape.v1',
    generated_at: new Date().toISOString(),
    room_label: roomLabel,
    hwnd: Number(mainHwnd),
    main_frames: mainFrames,
    comment_threads_attempted: threadCount,
    comment_threads_captured: capturedThreads,
    elapsed_seconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
    options: {
      max_frames: maxFrames,
      max_thread_frames: threadMaxFrames,
      open_threads: openThreads,
      to_bottom: Boolean(args['to-bottom']),
      windows_native: true,
    },
    files: {
      transcript: 'transcript.txt',
      frames_dir: 'frames',
      ocr_dir: 'ocr',
      thread_candidates_dir: 'thread_candidates',
      threads_dir: 'threads',
    },
    threads: threadEntries,
  });

  const structure = run(process.execPath, [join(repo, 'scripts', 'kakao_openchat_structure.mjs'), outDir, '--write'], { cwd: repo, maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write(structure.stdout || '');
  process.stderr.write(structure.stderr || '');
  if (!structure.ok) console.error('WARN: kakao_openchat_structure failed; viewer may fall back to on-demand structure');

  let messageCount = 0;
  const messagesPath = join(outDir, 'kakao_openchat_messages.json');
  if (existsSync(messagesPath)) {
    const messagesDoc = readJson(messagesPath, {});
    messageCount = Number(messagesDoc.stats?.messages || (Array.isArray(messagesDoc.messages) ? messagesDoc.messages.length : 0));
  }
  if (mainFrames <= 0 || messageCount <= 0) {
    throw new Error(`no usable KakaoTalk open-chat OCR detected (main_frames=${mainFrames}, messages=${messageCount})`);
  }

  const audit = run(process.execPath, [join(repo, 'scripts', 'kakao_openchat_audit.mjs'), outDir], { cwd: repo, maxBuffer: 16 * 1024 * 1024 });
  const auditText = audit.stdout || JSON.stringify({
    schema: 'kakao_openchat_audit.v1',
    status: 'FAIL',
    findings: [{ severity: 'fail', check: 'audit', detail: audit.stderr || 'audit failed' }],
  }, null, 2);
  writeFileSync(join(outDir, 'audit.json'), auditText.endsWith('\n') ? auditText : `${auditText}\n`, 'utf8');
  writeFileSync(join(outDir, 'kakao_openchat_audit.json'), auditText.endsWith('\n') ? auditText : `${auditText}\n`, 'utf8');
  if (audit.stdout) process.stdout.write(audit.stdout);
  if (audit.stderr) process.stderr.write(audit.stderr);
  if (!audit.ok) console.error('WARN: KakaoTalk open-chat audit reported issues; review the room in Chats.');

  console.log(`KAKAO_OPENCHAT_DIR=${outDirWin}`);
  console.log(`MAIN_FRAMES=${mainFrames}`);
  console.log(`THREADS_ATTEMPTED=${threadCount}`);
  console.log(`THREADS_CAPTURED=${capturedThreads}`);
  console.log(`MESSAGES=${messageCount}`);
  console.log(`TRANSCRIPT=${localPathToWindows(join(outDir, 'transcript.txt'))}`);
}

main().catch((err) => {
  console.error(`FAIL ${err.message}`);
  process.exit(1);
});
