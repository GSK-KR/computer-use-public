#!/usr/bin/env node
// Audit a Kakao open-chat scrape directory without printing chat contents.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir || !existsSync(dir)) {
  console.error('usage: node scripts/kakao_openchat_audit.mjs <kakao_openchat_dir>');
  process.exit(2);
}

const findings = [];
const info = {};

function add(severity, check, detail) {
  findings.push({ severity, check, detail });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fileSize(path) {
  try { return statSync(path).size; } catch { return 0; }
}

function pngInfo(path) {
  if (!existsSync(path)) return null;
  const b = readFileSync(path);
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length };
}

function listMatching(subdir, re) {
  const full = join(dir, subdir);
  if (!existsSync(full)) return [];
  return readdirSync(full).filter((name) => re.test(name)).sort();
}

const manifestPath = join(dir, 'kakao_openchat_manifest.json');
if (!existsSync(manifestPath)) {
  add('fail', 'manifest', 'missing kakao_openchat_manifest.json');
} else {
  info.manifest = readJson(manifestPath);
}

const manifest = info.manifest || {};
const mainFrames = Number(manifest.main_frames || 0);
const attempted = Number(manifest.comment_threads_attempted ?? manifest.comment_threads_captured ?? 0);
const captured = Number(manifest.comment_threads_captured || 0);

if (manifest.schema !== 'kakao_openchat_scrape.v1') add('fail', 'manifest.schema', `unexpected schema ${manifest.schema}`);
if (mainFrames <= 0) add('fail', 'main_frames', `main_frames is ${mainFrames}`);
if (captured > attempted) add('fail', 'thread counts', `captured ${captured} exceeds attempted ${attempted}`);

const mainPngs = listMatching('frames', /^frame_\d+\.png$/);
const mainOcrs = listMatching('ocr', /^frame_\d+\.json$/);
const candFiles = listMatching('thread_candidates', /^frame_\d+\.json$/);
if (mainPngs.length !== mainFrames) add('fail', 'main frame files', `manifest=${mainFrames} files=${mainPngs.length}`);
if (mainOcrs.length !== mainFrames) add('fail', 'main OCR files', `manifest=${mainFrames} files=${mainOcrs.length}`);
if (candFiles.length !== mainFrames) add('fail', 'candidate files', `manifest=${mainFrames} files=${candFiles.length}`);

let candidateTotal = 0;
const uniqueKeys = new Set();
let clickCoordBad = 0;
const frameSizes = new Map();

for (const f of mainPngs) {
  const p = join(dir, 'frames', f);
  const meta = pngInfo(p);
  if (!meta) add('fail', 'main PNG', `${f} is missing or not a PNG`);
  else if (meta.width < 200 || meta.height < 300 || meta.bytes < 1000) add('fail', 'main PNG size', `${f} looks invalid ${JSON.stringify(meta)}`);
  else frameSizes.set(f.replace('.png', ''), meta);
}

for (const f of mainOcrs) {
  const p = join(dir, 'ocr', f);
  let arr = [];
  try { arr = readJson(p); } catch (err) { add('fail', 'main OCR parse', `${f}: ${err.message}`); continue; }
  if (!Array.isArray(arr)) add('fail', 'main OCR shape', `${f} is not an array`);
  else if (arr.length < 5) add('review', 'main OCR sparse', `${f} has only ${arr.length} lines`);
}

for (const f of candFiles) {
  const p = join(dir, 'thread_candidates', f);
  let doc;
  try { doc = readJson(p); } catch (err) { add('fail', 'candidate parse', `${f}: ${err.message}`); continue; }
  if (doc.schema !== 'kakao_openchat_thread_candidates.v1') add('fail', 'candidate schema', `${f} unexpected schema ${doc.schema}`);
  const candidates = Array.isArray(doc.candidates) ? doc.candidates : [];
  candidateTotal += candidates.length;
  const size = frameSizes.get(f.replace('.json', ''));
  for (const c of candidates) {
    if (!c.dedupe_key) add('fail', 'candidate dedupe', `${f} has candidate without dedupe_key`);
    else uniqueKeys.add(c.dedupe_key);
    if (size) {
      const x = Number(c.click_x);
      const y = Number(c.click_y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= size.width || y >= size.height) {
        clickCoordBad += 1;
      }
    }
  }
}
if (clickCoordBad) add('fail', 'candidate click bounds', `${clickCoordBad} click targets outside frame`);
if (attempted > uniqueKeys.size) add('fail', 'dedupe accounting', `attempted ${attempted} exceeds unique candidate keys ${uniqueKeys.size}`);
if (candidateTotal > uniqueKeys.size && attempted !== uniqueKeys.size) {
  add('review', 'dedupe accounting', `candidate_total=${candidateTotal}, unique=${uniqueKeys.size}, attempted=${attempted}`);
}

const seenPath = join(dir, 'threads', '.seen_comment_keys');
if (existsSync(seenPath)) {
  const seen = readFileSync(seenPath, 'utf8').split(/\n/).filter(Boolean);
  if (seen.length !== attempted) add('fail', 'seen key count', `seen=${seen.length}, attempted=${attempted}`);
  if (new Set(seen).size !== seen.length) add('fail', 'seen key uniqueness', 'duplicate keys in .seen_comment_keys');
} else if (attempted > 0) {
  add('fail', 'seen keys', 'missing .seen_comment_keys');
}

const threadRoot = join(dir, 'threads');
const threadDirs = existsSync(threadRoot)
  ? readdirSync(threadRoot).filter((name) => /^thread_\d+$/.test(name)).sort()
  : [];
if (threadDirs.length !== attempted) add('fail', 'thread dir count', `dirs=${threadDirs.length}, attempted=${attempted}`);

let capturedActual = 0;
let threadFrames = 0;
let emptyThreadTranscripts = 0;
let sameHwndThreads = 0;
let windowTraceBad = 0;
let missingThreadUi = 0;

for (const name of threadDirs) {
  const tdir = join(threadRoot, name);
  const manifestFile = join(tdir, 'thread_manifest.json');
  const candidateFile = join(tdir, 'candidate.json');
  const transcriptFile = join(tdir, 'transcript.txt');
  if (!existsSync(candidateFile)) add('fail', 'thread candidate', `${name} missing candidate.json`);
  if (!existsSync(manifestFile)) { add('fail', 'thread manifest', `${name} missing thread_manifest.json`); continue; }
  let tm;
  try { tm = readJson(manifestFile); } catch (err) { add('fail', 'thread manifest parse', `${name}: ${err.message}`); continue; }
  if (tm.status === 'captured') capturedActual += 1;
  else add('fail', 'thread status', `${name} status=${tm.status}`);
  const frames = listMatching(`threads/${name}/frames`, /^frame_\d+\.png$/);
  const ocrs = listMatching(`threads/${name}/ocr`, /^frame_\d+\.json$/);
  threadFrames += frames.length;
  if (Number(tm.captured_frames || 0) !== frames.length) add('fail', 'thread frame count', `${name} manifest=${tm.captured_frames} files=${frames.length}`);
  if (ocrs.length !== frames.length) add('fail', 'thread OCR count', `${name} frames=${frames.length} ocr=${ocrs.length}`);
  const threadTexts = [];
  for (const ocr of ocrs) {
    try {
      const arr = readJson(join(tdir, 'ocr', ocr));
      if (Array.isArray(arr)) {
        for (const item of arr) threadTexts.push(String(item?.text || ''));
      }
    } catch {
      // Parse errors are reported by the OCR count/file checks elsewhere.
    }
  }
  if (!/(댓글|답글|대댓글|댓글\s*메시지\s*입력|채팅방에\s*함께\s*보내기)/u.test(threadTexts.join(' '))) {
    missingThreadUi += 1;
  }
  for (const frame of frames) {
    const meta = pngInfo(join(tdir, 'frames', frame));
    if (!meta) add('fail', 'thread PNG', `${name}/${frame} invalid`);
    else if (meta.width < 200 || meta.height < 300 || meta.bytes < 1000) add('fail', 'thread PNG size', `${name}/${frame} looks invalid ${JSON.stringify(meta)}`);
  }
  if (!existsSync(transcriptFile) || fileSize(transcriptFile) === 0) emptyThreadTranscripts += 1;
  if (Number(tm.thread_hwnd) === Number(manifest.hwnd)) sameHwndThreads += 1;
  const before = join(tdir, 'windows_before.txt');
  const after = join(tdir, 'windows_after.txt');
  if (!existsSync(before) || !existsSync(after)) {
    windowTraceBad += 1;
  } else if (tm.thread_hwnd) {
    const beforeText = readFileSync(before, 'utf8');
    const afterText = readFileSync(after, 'utf8');
    if (beforeText.includes(`hwnd=${tm.thread_hwnd}`) || !afterText.includes(`hwnd=${tm.thread_hwnd}`)) windowTraceBad += 1;
  }
}
if (capturedActual !== captured) add('fail', 'captured count', `manifest=${captured}, actual=${capturedActual}`);
if (emptyThreadTranscripts) add('review', 'thread transcript empty', `${emptyThreadTranscripts} captured threads have empty transcript.txt`);
if (missingThreadUi) add('fail', 'thread UI evidence', `${missingThreadUi} captured threads do not contain comment-thread UI text in OCR`);
if (sameHwndThreads) add('review', 'thread hwnd', `${sameHwndThreads} threads used main chat hwnd; Kakao comments normally open a new top-level window`);
if (windowTraceBad) add('review', 'thread window trace', `${windowTraceBad} thread window before/after traces are missing or inconsistent`);

const mainTranscript = join(dir, 'transcript.txt');
if (!existsSync(mainTranscript) || fileSize(mainTranscript) === 0) add('fail', 'main transcript', 'transcript.txt is missing or empty');

const failCount = findings.filter((f) => f.severity === 'fail').length;
const reviewCount = findings.filter((f) => f.severity === 'review').length;
const status = failCount ? 'FAIL' : reviewCount ? 'REVIEW' : 'PASS';

const result = {
  schema: 'kakao_openchat_audit.v1',
  status,
  summary: {
    main_frames: mainFrames,
    main_frame_files: mainPngs.length,
    candidate_total: candidateTotal,
    candidate_unique_keys: uniqueKeys.size,
    comment_threads_attempted: attempted,
    comment_threads_captured_manifest: captured,
    comment_threads_captured_actual: capturedActual,
    thread_dirs: threadDirs.length,
    thread_frame_files: threadFrames,
  },
  findings,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(status === 'FAIL' ? 1 : 0);
