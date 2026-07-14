#!/usr/bin/env node
// Privacy-preserving audit summary for a wechat_scrape.sh output directory.
//
// This intentionally reports metrics, counts, and risk flags, not message text.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = new Map();
const flags = new Set();
for (let i = 2; i < process.argv.length; i++) {
  const cur = process.argv[i];
  if (cur.startsWith('--') && cur.includes('=')) {
    const [key, ...rest] = cur.slice(2).split('=');
    args.set(key, rest.join('='));
  } else if (cur.startsWith('--')) {
    const key = cur.slice(2);
    if (['json', 'redact-speakers', 'check'].includes(key)) {
      flags.add(key);
    } else {
      args.set(key, process.argv[++i]);
    }
  } else if (!args.has('dir')) {
    args.set('dir', cur);
  }
}

const dirArg = args.get('dir');
if (!dirArg) {
  console.error('usage: node scripts/wechat_audit.mjs --dir <wechat_output_dir> [--json] [--redact-speakers] [--check]');
  process.exit(2);
}

const dir = resolve(dirArg);
const manifestPath = args.get('manifest') || join(dir, 'wechat_scrape_manifest.json');
const messagesPath = args.get('messages') || join(dir, 'wechat_messages.json');

function readJson(path, label) {
  if (!existsSync(path)) {
    return { ok: false, error: `missing ${label}: ${path}` };
  }
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (err) {
    return { ok: false, error: `invalid ${label}: ${path}: ${err.message}` };
  }
}

const manifestRead = readJson(manifestPath, 'manifest');
const messagesRead = readJson(messagesPath, 'messages');

const issues = [];
let status = 'pass';
function addIssue(severity, message) {
  issues.push({ severity, message });
  if (severity === 'fail') status = 'fail';
  if (severity === 'review' && status === 'pass') status = 'review';
}
function plural(count, singular, pluralWord = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralWord}`;
}

if (!manifestRead.ok) addIssue('fail', manifestRead.error);
if (!messagesRead.ok) addIssue('fail', messagesRead.error);

const manifest = manifestRead.value || {};
const messagesDoc = messagesRead.value || {};
const stats = messagesDoc.stats || {};
const capture = manifest.capture || {};
const timings = manifest.timings || {};

function listMatching(base, re) {
  if (!existsSync(base)) return [];
  return readdirSync(base).filter((file) => re.test(file)).sort();
}

function readFrameLineCounts() {
  const tessDir = join(dir, 'tess_json');
  const files = listMatching(tessDir, /^frame_\d+\.json$/);
  const counts = [];
  for (const file of files) {
    try {
      const arr = JSON.parse(readFileSync(join(tessDir, file), 'utf8'));
      counts.push({ frame: file, lines: Array.isArray(arr) ? arr.length : 0 });
    } catch {
      counts.push({ frame: file, lines: 0, unreadable: true });
    }
  }
  return counts;
}

function quantile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

const framePngs = listMatching(dir, /^frame_\d+\.png$/);
const frameLineCounts = readFrameLineCounts();
const lineValues = frameLineCounts.map((entry) => entry.lines).sort((a, b) => a - b);
const zeroLineFrames = frameLineCounts.filter((entry) => entry.lines === 0).length;
const unreadableLineFrames = frameLineCounts.filter((entry) => entry.unreadable).length;

const frameCount = Number(capture.frame_count ?? stats.frames ?? framePngs.length ?? 0);
const maxFrames = Number(capture.max_frames ?? 0);
const topReached = typeof capture.top_reached === 'boolean' ? capture.top_reached : null;
const bottomReached = typeof capture.bottom_reached === 'boolean' ? capture.bottom_reached : null;
const messages = Number(stats.messages ?? 0);
const rawOcrLines = Number(stats.raw_ocr_lines ?? 0);
const unknownSpeakers = Number(stats.unknown_speaker_messages ?? 0);
const lowConfidenceIds = Array.isArray(stats.low_confidence_message_ids) ? stats.low_confidence_message_ids : [];
const lowConfidenceTextIds = Array.isArray(stats.low_confidence_text_message_ids) ? stats.low_confidence_text_message_ids : lowConfidenceIds;
const nonTextIds = Array.isArray(stats.non_text_message_ids) ? stats.non_text_message_ids : [];
const droppedArtifacts = Number(stats.ocr_artifacts_dropped ?? 0);
const dateMarkers = Array.isArray(stats.date_markers) ? stats.date_markers : [];

if (frameCount <= 0) addIssue('fail', 'no captured frames were found');
if (messages === 0 || rawOcrLines < 2) addIssue('fail', `no usable message OCR detected (messages=${messages}, raw_ocr_lines=${rawOcrLines})`);
if (maxFrames > 0 && frameCount >= maxFrames) addIssue('review', 'capture stopped at max_frames; full history is not proven');
if (topReached === false && !(maxFrames > 0 && frameCount >= maxFrames)) addIssue('review', 'oldest message was not proven reached');
if (capture.to_bottom && bottomReached === false) addIssue('review', 'newest message was not proven reached');
if (unknownSpeakers > 0) addIssue('review', `${plural(unknownSpeakers, 'message')} ${unknownSpeakers === 1 ? 'has' : 'have'} unknown speaker attribution`);
if (lowConfidenceTextIds.length > 0) addIssue('review', `${plural(lowConfidenceTextIds.length, 'text message')} ${lowConfidenceTextIds.length === 1 ? 'has' : 'have'} low OCR confidence`);
if (nonTextIds.length > 0) addIssue('review', `${plural(nonTextIds.length, 'attachment/media-card entry', 'attachment/media-card entries')} ${nonTextIds.length === 1 ? 'requires' : 'require'} original WeChat review`);
if (manifest.translation_failed === true) addIssue('review', 'translation failed or timed out');
if (unreadableLineFrames > 0) addIssue('review', `${unreadableLineFrames} OCR JSON frames could not be read`);
if (frameLineCounts.length > 0 && zeroLineFrames / frameLineCounts.length > 0.15) {
  addIssue('review', `${zeroLineFrames}/${frameLineCounts.length} OCR frames had zero lines`);
}
const suspiciousDateMarkers = dateMarkers.filter((marker) => /^\d+(?:\.\d+)?[KMG]$/i.test(String(marker || '')));
if (suspiciousDateMarkers.length > 0) {
  addIssue('review', `date markers include file-size-like text: ${suspiciousDateMarkers.join(', ')}`);
}

if (manifest.quality?.status && manifest.quality.status !== 'pass') {
  addIssue('review', `manifest quality status is ${manifest.quality.status}`);
}

const speakerCountsRaw = stats.speakers && typeof stats.speakers === 'object' ? stats.speakers : {};
const redactSpeakers = flags.has('redact-speakers');
const speakerAliases = new Map();
let speakerAliasSeq = 1;
function speakerLabel(name) {
  if (!redactSpeakers) return name;
  if (name === 'Me' || name === 'Unknown') return name;
  if (!speakerAliases.has(name)) speakerAliases.set(name, `Speaker ${speakerAliasSeq++}`);
  return speakerAliases.get(name);
}

const speakerCounts = Object.fromEntries(
  Object.entries(speakerCountsRaw)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([speakerName, count]) => [speakerLabel(speakerName), Number(count)]),
);

const speakerSourceCounts = {};
for (const msg of Array.isArray(messagesDoc.messages) ? messagesDoc.messages : []) {
  const source = msg.speaker_source || 'missing';
  speakerSourceCounts[source] = (speakerSourceCounts[source] || 0) + 1;
}

const totalElapsed = Number(timings.total_elapsed_s ?? 0);
const metrics = {
  dir,
  manifest: manifestPath,
  messages: messagesPath,
  crop: manifest.ocr?.crop || messagesDoc.crop?.spec || null,
  room_label_present: Boolean(manifest.room_label || messagesDoc.room),
  scope: manifest.privacy?.scope || null,
  cloud_translation_requested: Boolean(manifest.privacy?.cloud_translation_requested),
  network_upload: Boolean(manifest.privacy?.network_upload),
  frames: {
    captured: frameCount,
    png_files: framePngs.length,
    max_frames: maxFrames || null,
    stopped_at_max_frames: maxFrames > 0 ? frameCount >= maxFrames : null,
    top_reached: topReached,
    bottom_reached: bottomReached,
  },
  ocr: {
    raw_lines: rawOcrLines,
    transcript_lines: Number(manifest.output?.line_count ?? 0),
    frame_density: {
      frames: frameLineCounts.length,
      zero_line_frames: zeroLineFrames,
      min: quantile(lineValues, 0),
      p25: quantile(lineValues, 0.25),
      median: quantile(lineValues, 0.5),
      p75: quantile(lineValues, 0.75),
      max: quantile(lineValues, 1),
    },
  },
  messages: {
    structured: messages,
    unknown_speaker_messages: unknownSpeakers,
    low_confidence_messages: lowConfidenceTextIds.length,
    non_text_messages: nonTextIds.length,
    ocr_artifacts_dropped: droppedArtifacts,
    date_markers: dateMarkers.length,
  },
  timings: {
    total_elapsed_s: Number(timings.total_elapsed_s ?? 0),
    capture_elapsed_s: Number(timings.capture_elapsed_s ?? 0),
    ocr_elapsed_s: Number(timings.ocr_elapsed_s ?? 0),
    stitch_elapsed_s: Number(timings.stitch_elapsed_s ?? 0),
    structure_elapsed_s: Number(timings.structure_elapsed_s ?? 0),
    translation_elapsed_s: Number(timings.translation_elapsed_s ?? 0),
    seconds_per_frame: frameCount > 0 ? round2(totalElapsed / frameCount) : null,
    seconds_per_message: messages > 0 ? round2(totalElapsed / messages) : null,
  },
  speaker_counts: speakerCounts,
  speaker_source_counts: speakerSourceCounts,
};

const output = {
  schema: 'wechat_audit.v1',
  generated_at: new Date().toISOString(),
  status,
  metrics,
  issues,
};

if (flags.has('json')) {
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} else {
  const statusText = status.toUpperCase();
  console.log(`WeChat scrape audit: ${statusText}`);
  console.log(`Dir: ${dir}`);
  console.log(`Scope: ${metrics.scope || '(unknown)'}`);
  console.log(`Crop: ${metrics.crop || '(unknown)'}`);
  console.log(`Frames: ${metrics.frames.captured}/${metrics.frames.max_frames ?? 'unknown'} captured`);
  console.log(`Messages: ${metrics.messages.structured} structured, ${metrics.ocr.raw_lines} OCR lines`);
  console.log(`Attribution: ${metrics.messages.unknown_speaker_messages} unknown, ${metrics.messages.low_confidence_messages} low-confidence text`);
  console.log(`Non-text/cards: ${metrics.messages.non_text_messages} kept, ${metrics.messages.ocr_artifacts_dropped} OCR artifacts dropped`);
  console.log(`Timings: total ${metrics.timings.total_elapsed_s}s, capture ${metrics.timings.capture_elapsed_s}s, OCR ${metrics.timings.ocr_elapsed_s}s, structure ${metrics.timings.structure_elapsed_s}s`);
  console.log(`Frame OCR density: min ${metrics.ocr.frame_density.min}, p25 ${metrics.ocr.frame_density.p25}, median ${metrics.ocr.frame_density.median}, p75 ${metrics.ocr.frame_density.p75}, max ${metrics.ocr.frame_density.max}, zero ${metrics.ocr.frame_density.zero_line_frames}/${metrics.ocr.frame_density.frames}`);
  console.log('');
  console.log('Speaker sources:');
  for (const [source, count] of Object.entries(metrics.speaker_source_counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  - ${source}: ${count}`);
  }
  console.log('');
  console.log('Speakers:');
  for (const [speaker, count] of Object.entries(metrics.speaker_counts)) {
    console.log(`  - ${speaker}: ${count}`);
  }
  console.log('');
  if (issues.length) {
    console.log('Issues:');
    for (const issue of issues) console.log(`  - [${issue.severity}] ${issue.message}`);
  } else {
    console.log('Issues: none');
  }
}

if (flags.has('check') && status !== 'pass') {
  process.exit(status === 'fail' ? 2 : 1);
}
