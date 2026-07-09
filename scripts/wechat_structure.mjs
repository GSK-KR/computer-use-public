#!/usr/bin/env node
// Build speaker-aware WeChat OCR artifacts from per-frame Tesseract JSON.
//
// This is layout-based, not a private WeChat API: it infers incoming names from
// visible sender-name lines above left-side bubbles and marks right-side bubbles
// as "Me". Unknowns are explicit so reviewers know what needs screenshot checks.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  charLen,
  cleanOcrText,
  cleanSpeakerName,
  isPlausibleSpeakerName,
  looksAttachmentOrMediaCard,
  looksGroupRoomLabel,
} from './wechat_speaker_rules.mjs';

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const cur = process.argv[i];
  if (cur.startsWith('--') && cur.includes('=')) {
    const [key, ...rest] = cur.slice(2).split('=');
    args.set(key, rest.join('='));
  } else if (cur.startsWith('--')) {
    args.set(cur.slice(2), process.argv[++i]);
  }
}

const dir = args.get('dir');
if (!dir) {
  console.error('usage: node wechat_structure.mjs --dir <tess_json_dir> --manifest <manifest.json> --out-json <out.json> --out-md <out.md> [--crop WxH+X+Y]');
  process.exit(2);
}

const manifestPath = args.get('manifest');
const outJson = args.get('out-json');
const outMd = args.get('out-md');
const crop = args.get('crop') || '1450x1040+600+140';
const cropMatch = crop.match(/^(\d+)x(\d+)\+/);
const cropWidth = cropMatch ? Number(cropMatch[1]) : 1450;
const cropHeight = cropMatch ? Number(cropMatch[2]) : 1040;
const edgeGuardPx = Math.max(0, Number(args.get('edge-guard-px') || 0) || 0);

let manifest = {};
if (manifestPath) {
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    manifest = {};
  }
}

const files = readdirSync(dir).filter((file) => /^frame_\d+\.json$/.test(file)).sort().reverse();
const norm = (text) => String(text || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

function lev(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

function sim(a, b) {
  const max = Math.max(a.length, b.length);
  return max ? 1 - lev(a, b) / max : 1;
}

function isDuplicateText(a, b) {
  if (!a || !b) return false;
  const min = Math.min(a.length, b.length);
  if (min >= 8 && (a.includes(b) || b.includes(a))) return true;
  return sim(a, b) >= 0.86;
}

function frameNumber(frame) {
  const m = String(frame || '').match(/frame_(\d+)\.json$/);
  return m ? Number(m[1]) : null;
}

function isScrollOverlapDuplicate(a, b) {
  if (!isDuplicateText(a.key, b.key)) return false;
  const af = frameNumber(a.frame);
  const bf = frameNumber(b.frame);
  if (af === null || bf === null) return false;
  if (af === bf) return false;
  if (Math.abs(af - bf) > 4) return false;
  return true;
}

const dateMarkerRe = /^(20\d{2}[./-]\d{1,2}[./-]\d{1,2}|[01]?\d[./-][0-3]?\d|今天|昨天|前天|星期[一二三四五六日天]|周[一二三四五六日天]|오전|오후|오늘|어제|월요일|화요일|수요일|목요일|금요일|토요일|일요일)/u;
const exactDateMarkerRe = /^(?:(?:20\d{2}[./-]\d{1,2}[./-]\d{1,2}|[01]?\d[./-][0-3]?\d)(?:\s+(?:上午|下午|晚上|早上|凌晨|오전|오후)?\s*\d{1,2}:\d{2})?|(?:今天|昨天|前天|星期[一二三四五六日天]|周[一二三四五六日天]|오늘|어제|월요일|화요일|수요일|목요일|금요일|토요일|일요일)(?:\s+(?:上午|下午|晚上|早上|凌晨|오전|오후)?\s*\d{1,2}:\d{2})?|(?:上午|下午|晚上|早上|凌晨|오전|오후)?\s*\d{1,2}:\d{2})$/u;
const timeRe = /(上午|下午|晚上|早上|凌晨|오전|오후)?\s*\d{1,2}:\d{2}/u;
const dateishRe = /(\d{1,4}[./-]\d{1,2}|\d{1,2}:\d{2}|上午|下午|晚上|早上|凌晨|오전|오후)/u;
const chromeRe = [
  /환영합니다/u,
  /메시지 입력/u,
  /Q 9/u,
  /오픈[재채]팅방/u,
  /发送/u,
  /按住说话/u,
  /表情/u,
  /微\s*信\s*电\s*脑\s*版/u,
  /Other user is not your friend/iu,
];

function isKnownSpeaker(speaker) {
  return speaker && speaker !== 'Unknown';
}

const incomingSpeakerHint = cleanSpeakerName(manifest.speaker_hints?.incoming_speaker || manifest.incoming_speaker || '');
const incomingSpeakerHintSource = manifest.speaker_hints?.incoming_speaker_mode === 'room-label-auto'
  ? 'auto-room-label-incoming-speaker'
  : 'hint-incoming-speaker';
const roomLabel = cleanSpeakerName(manifest.room_label || '');

const autoRoomLabelIncoming = incomingSpeakerHintSource === 'auto-room-label-incoming-speaker' && incomingSpeakerHint;
const directAutoIncoming = Boolean(autoRoomLabelIncoming && !looksGroupRoomLabel(roomLabel || incomingSpeakerHint));
const effectiveIncomingSpeakerHint = autoRoomLabelIncoming
  ? (directAutoIncoming ? incomingSpeakerHint : '')
  : incomingSpeakerHint;
const effectiveIncomingSpeakerHintSource = autoRoomLabelIncoming
  ? 'auto-room-label-incoming-speaker'
  : incomingSpeakerHintSource;

function looksDateMarker(line) {
  const text = line.text.trim();
  if (/^\d+(?:\.\d+)?[KMG]$/i.test(text)) return false;
  const centeredOrWide = isCentered(line) || (line.w > cropWidth * 0.35 && line.x < cropWidth * 0.20);
  if (exactDateMarkerRe.test(text) && charLen(text) <= 24) return centeredOrWide;
  if (dateMarkerRe.test(text)) return isCentered(line) && charLen(text) <= 24;
  if (timeRe.test(text) && charLen(text) <= 16 && centeredOrWide) return true;
  return false;
}

function isCentered(line) {
  const center = line.x + line.w / 2;
  return center > cropWidth * 0.32 && center < cropWidth * 0.68;
}

function isChrome(line, frameFreq, chromeFreq) {
  const text = line.text.trim();
  const key = norm(text);
  if (!key) return true;
  if (/^\d+\s+new message(?:\(s\))?$/iu.test(text)) return true;
  if (chromeRe.some((re) => re.test(text))) return true;
  if ((frameFreq.get(key) || 0) >= chromeFreq) return true;
  if (/^[\d口十㉭OCO€Ⅲ:.,\s]+$/u.test(text) && text.length > 3) return true;
  return false;
}

function isInEdgeGuard(line) {
  if (!edgeGuardPx) return false;
  if (line.y < edgeGuardPx) return true;
  if ((line.y + line.h) > cropHeight - edgeGuardPx) return true;
  return false;
}

function isSenderCandidate(line, next) {
  if (!next) return false;
  const text = cleanSpeakerName(line.text);
  const n = charLen(text);
  if (n < 1 || n > 32) return false;
  if (/^[A-Za-z]{1,2}$/.test(text)) return false;
  if (line.x <= 8) return false;
  if (/^\d+(?:\.\d+)?[KMG]$/i.test(text)) return false;
  if (/^[\p{P}\p{S}\p{Number}\s]+$/u.test(text)) return false;
  if ((line.conf ?? 100) < 60 && !/[\p{Script=Han}\p{Script=Hangul}A-Za-z]/u.test(text)) return false;
  if (looksDateMarker(line)) return false;
  if (dateishRe.test(text)) return false;
  if (/^@/.test(text)) return false;
  if (chromeRe.some((re) => re.test(text))) return false;
  if (!isPlausibleSpeakerName(text)) return false;
  const chars = [...text];
  const digits = chars.filter((ch) => /\p{Number}/u.test(ch)).length;
  if (digits > 0 && digits / Math.max(chars.length, 1) > 0.50) return false;
  if (/[:：]/u.test(text) && n > 3) return false;
  if (/https?:\/\//i.test(text)) return false;
  if (/[。.!?？！]$/.test(text) && n > 6) return false;
  if (line.x > cropWidth * 0.50) return false;
  if (next.x > cropWidth * 0.72) return false;
  if (next.x > cropWidth * 0.50) return false;
  if (looksDateMarker(next)) return false;

  const gap = next.y - (line.y + line.h);
  if (gap < -4 || gap > 70) return false;
  if (next.x < line.x - 28) return false;
  if (Math.abs(next.x - line.x) > 330 && next.x > cropWidth * 0.35) return false;
  return true;
}

function textCharProfile(text) {
  const chars = [...String(text || '').replace(/\s+/g, '')];
  const useful = chars.filter((ch) => /[\p{Script=Han}\p{Script=Hangul}A-Za-z0-9]/u.test(ch)).length;
  const cjkHangul = chars.filter((ch) => /[\p{Script=Han}\p{Script=Hangul}]/u.test(ch)).length;
  const symbols = chars.filter((ch) => /[\p{P}\p{S}]/u.test(ch)).length;
  return {
    length: chars.length,
    useful,
    cjkHangul,
    symbols,
    usefulRatio: chars.length ? useful / chars.length : 0,
  };
}

function looksLowConfidenceJunk(msg) {
  const text = cleanOcrText(msg.text);
  const conf = msg.conf ?? 100;
  const profile = textCharProfile(text);
  if (!text) return true;
  if (looksAttachmentOrMediaCard(text)) return false;
  if (conf < 45 && profile.cjkHangul === 0 && profile.usefulRatio < 0.58) return true;
  if (conf < 55 && profile.length <= 4 && profile.cjkHangul === 0 && !/[A-Za-z]{2,}/.test(text)) return true;
  if (conf < 55 && /^[A-Za-z0-9\s«»<>()/\\.,._=—\-|]+$/u.test(text) && profile.usefulRatio < 0.72) return true;
  if (conf < 55 && /(?:[=—_]{3,}|[口回四]{1,}|[^\p{L}\p{N}\s]{4,})/u.test(text) && profile.cjkHangul === 0) return true;
  return false;
}

function classifyMessage(msg) {
  if (looksAttachmentOrMediaCard(msg.text)) {
    return {
      kind: 'attachment_or_media_card',
      requires_screenshot_review: true,
      quality_note: 'non-text or attachment-like WeChat card; OCR is metadata only',
    };
  }
  if (looksLowConfidenceJunk(msg)) {
    return {
      kind: 'ocr_artifact',
      requires_screenshot_review: true,
      quality_note: 'dropped low-confidence OCR artifact',
    };
  }
  return {
    kind: 'text',
    requires_screenshot_review: (msg.conf !== null && msg.conf < 55),
    quality_note: null,
  };
}

function avgConf(lines) {
  const confs = lines.map((line) => Number(line.conf)).filter(Number.isFinite);
  if (!confs.length) return null;
  return Math.round(confs.reduce((sum, conf) => sum + conf, 0) / confs.length);
}

const parsed = [];
const frameFreq = new Map();
let rawLineCount = 0;
for (const file of files) {
  let arr;
  try {
    arr = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  } catch {
    continue;
  }
  if (!Array.isArray(arr)) continue;
  arr = arr
    .filter((line) => line && typeof line.text === 'string')
    .map((line) => ({
      text: cleanOcrText(line.text),
      x: Number(line.x) || 0,
      y: Number(line.y) || 0,
      w: Number(line.w) || 0,
      h: Number(line.h) || 0,
      conf: Number.isFinite(Number(line.conf)) ? Number(line.conf) : null,
      min_conf: Number.isFinite(Number(line.min_conf)) ? Number(line.min_conf) : null,
      words: Number.isFinite(Number(line.words)) ? Number(line.words) : null,
      frame: file,
    }))
    .filter((line) => line.text)
    .filter((line) => !isInEdgeGuard(line))
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));
  rawLineCount += arr.length;
  parsed.push(arr);
  const inFrame = new Set(arr.map((line) => norm(line.text)).filter((key) => key.length >= 2));
  for (const key of inFrame) frameFreq.set(key, (frameFreq.get(key) || 0) + 1);
}

const chromeFreq = Math.max(4, Math.ceil(parsed.length * 0.5));
const candidates = [];
const markers = [];

for (const frameLines of parsed) {
  const lines = frameLines.filter((line) => !isChrome(line, new Map(), Number.POSITIVE_INFINITY));
  let currentSpeaker = null;
  let currentMarker = null;
  let last = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1];

    if (looksDateMarker(line)) {
      currentMarker = line.text;
      currentSpeaker = null;
      last = null;
      markers.push({ text: line.text, frame: line.frame, x: line.x, y: line.y });
      continue;
    }

    if (!directAutoIncoming && isSenderCandidate(line, next)) {
      currentSpeaker = cleanSpeakerName(line.text);
      last = null;
      continue;
    }

    const side = line.x > cropWidth * 0.55 ? 'outgoing' : 'incoming';
    const speaker = side === 'outgoing' ? 'Me' : (currentSpeaker || effectiveIncomingSpeakerHint || 'Unknown');

    const canAppend = last &&
      last.side === side &&
      last.speaker === speaker &&
      line.y - last.lastY <= 48 &&
      Math.abs(line.x - last.lastX) <= 150;

    if (canAppend) {
      last.text += `\n${line.text}`;
      last.lines.push(line);
      last.lastY = line.y;
      last.lastX = line.x;
      last.conf = avgConf(last.lines);
    } else {
      last = {
        id: null,
        room: manifest.room_label || '',
        context_marker: currentMarker,
        speaker: cleanSpeakerName(speaker),
        speaker_source: side === 'outgoing' ? 'layout-right-side' : (currentSpeaker ? 'visible-name-above-bubble' : (effectiveIncomingSpeakerHint ? effectiveIncomingSpeakerHintSource : 'unknown-left-side')),
        side,
        text: line.text,
        translation_ko: null,
        frame_first: line.frame,
        frame_last: line.frame,
        x: line.x,
        y: line.y,
        w: line.w,
        h: line.h,
        conf: avgConf([line]),
        lines: [line],
        lastY: line.y,
        lastX: line.x,
      };
      candidates.push(last);
    }
  }
}

const deduped = [];
const seen = [];
const dedupWindow = 90;
for (const msg of candidates) {
  const key = norm(msg.text);
  if (key.length < 1) continue;
  let duplicateIndex = -1;
  for (let i = seen.length - 1; i >= 0 && i >= seen.length - dedupWindow; i--) {
    if (isScrollOverlapDuplicate({ key, frame: msg.frame_first }, seen[i])) {
      duplicateIndex = seen[i].index;
      break;
    }
  }
  if (duplicateIndex >= 0) {
    const existing = deduped[duplicateIndex];
    existing.frame_last = msg.frame_last;
    if (!isKnownSpeaker(existing.speaker) && isKnownSpeaker(msg.speaker)) {
      existing.speaker = msg.speaker;
      existing.speaker_source = msg.speaker_source;
      existing.side = msg.side;
    }
    if ((existing.conf ?? -1) < (msg.conf ?? -1)) existing.conf = msg.conf;
    if (msg.text.length > existing.text.length && sim(norm(msg.text), norm(existing.text)) >= 0.92) {
      existing.text = msg.text;
    }
    continue;
  }
  const clean = { ...msg };
  delete clean.lines;
  delete clean.lastY;
  delete clean.lastX;
  clean.id = deduped.length + 1;
  deduped.push(clean);
  seen.push({ key, frame: clean.frame_first, index: deduped.length - 1 });
}

let knownSpeakerKeys = new Set(deduped.filter((msg) => isKnownSpeaker(msg.speaker)).map((msg) => norm(msg.speaker)));
function isArtifactMessage(msg, classification) {
  const text = cleanOcrText(msg.text);
  const key = norm(cleanSpeakerName(text));
  const len = charLen(text);
  if (!text) return true;
  if (classification.kind === 'ocr_artifact') return true;
  if (msg.speaker === 'Unknown' && knownSpeakerKeys.has(key)) return true;
  if ((msg.conf ?? 100) < 75 && classification.kind === 'text' && /^[A-Za-z0-9\s«»<>()/\\.,._-]{1,14}$/u.test(text)) return true;
  if ((msg.y ?? 9999) < 35 && len < 20) return true;
  return false;
}

const filtered = [];
const droppedArtifacts = [];
for (const msg of deduped) {
  const classification = classifyMessage(msg);
  if (isArtifactMessage(msg, classification)) {
    droppedArtifacts.push({
      frame_first: msg.frame_first,
      speaker: msg.speaker,
      side: msg.side,
      conf: msg.conf,
      reason: classification.quality_note || 'layout artifact',
    });
    continue;
  }
  const clean = { ...msg, id: filtered.length + 1 };
  clean.kind = classification.kind;
  clean.requires_screenshot_review = classification.requires_screenshot_review;
  clean.quality_note = classification.quality_note;
  filtered.push(clean);
}

for (const msg of filtered) {
  if (msg.speaker_source === 'visible-name-above-bubble' && !isPlausibleSpeakerName(msg.speaker)) {
    msg.speaker = 'Unknown';
    msg.speaker_source = 'invalid-visible-name-candidate';
    msg.requires_screenshot_review = true;
    msg.quality_note = 'visible name candidate looked like message text, not a reliable sender name';
  }
}

const hasVisibleSenderNames = filtered.some((msg) => msg.speaker_source === 'visible-name-above-bubble');
if (autoRoomLabelIncoming && !directAutoIncoming && hasVisibleSenderNames) {
  for (const msg of filtered) {
    if (msg.speaker_source === 'auto-room-label-incoming-speaker') {
      msg.speaker = 'Unknown';
      msg.speaker_source = 'unknown-left-side';
      msg.requires_screenshot_review = true;
      msg.quality_note = 'auto incoming-speaker hint suppressed because visible group sender names were detected';
    }
  }
}

const speakerCounts = {};
const lowConfidence = [];
const lowConfidenceText = [];
const nonTextIds = [];
for (const msg of filtered) {
  speakerCounts[msg.speaker] = (speakerCounts[msg.speaker] || 0) + 1;
  if (msg.kind !== 'text') nonTextIds.push(msg.id);
  if (msg.conf !== null && msg.conf < 55 && msg.kind === 'text') {
    lowConfidence.push(msg.id);
    lowConfidenceText.push(msg.id);
  }
}

const output = {
  schema: 'wechat_messages.v1',
  generated_at: new Date().toISOString(),
  room: manifest.room_label || '',
  manifest,
  crop: { spec: crop, width: cropWidth, height: cropHeight },
  edge_guard_px: edgeGuardPx,
  stats: {
    frames: parsed.length,
    raw_ocr_lines: rawLineCount,
    messages: filtered.length,
    speakers: speakerCounts,
    unknown_speaker_messages: speakerCounts.Unknown || 0,
    low_confidence_message_ids: lowConfidence,
    low_confidence_text_message_ids: lowConfidenceText,
    non_text_message_ids: nonTextIds,
    ocr_artifacts_dropped: droppedArtifacts.length,
    date_markers: [...new Set(markers.map((marker) => marker.text))],
  },
  notes: [
    'Speaker names are inferred from visible WeChat layout, not from a private API.',
    directAutoIncoming
      ? 'This room looked like a one-to-one chat, so left-side messages without visible names were labeled with the room name.'
      : 'Group-like room titles do not use the room name as a speaker; left-side messages without visible names remain Unknown.',
    'Unknown speaker and low-confidence text messages should be checked against screenshots before relying on names, amounts, IDs, or dates.',
    'Attachment/media-card entries are metadata OCR only; open the original WeChat media/file for content.',
  ],
  messages: filtered,
};

if (outJson) writeFileSync(outJson, `${JSON.stringify(output, null, 2)}\n`);

function escCell(text) {
  return String(text ?? '').replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|');
}

if (outMd) {
  const lines = [];
  lines.push('# WeChat OCR export');
  lines.push('');
  lines.push(`- Room: ${manifest.room_label || '(not labeled)'}`);
  lines.push(`- Generated: ${output.generated_at}`);
  lines.push(`- Frames: ${output.stats.frames}`);
  lines.push(`- OCR lines: ${output.stats.raw_ocr_lines}`);
  lines.push(`- Messages: ${output.stats.messages}`);
  lines.push(`- Unknown-speaker messages: ${output.stats.unknown_speaker_messages}`);
  if (manifest.timings) {
    lines.push(`- Total elapsed: ${manifest.timings.total_elapsed_s}s`);
    lines.push(`- Capture/OCR/stitch/structure: ${manifest.timings.capture_elapsed_s}s / ${manifest.timings.ocr_elapsed_s}s / ${manifest.timings.stitch_elapsed_s}s / ${manifest.timings.structure_elapsed_s}s`);
  }
  lines.push('');
  lines.push('## Speakers');
  lines.push('');
  lines.push('| Speaker | Messages |');
  lines.push('|---|---:|');
  for (const [speaker, count] of Object.entries(speakerCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${escCell(speaker)} | ${count} |`);
  }
  lines.push('');
  lines.push('## Messages');
  lines.push('');
  lines.push('| # | Kind | Context | Speaker | Source | Conf | Original |');
  lines.push('|---:|---|---|---|---|---:|---|');
  for (const msg of filtered) {
    lines.push(`| ${msg.id} | ${escCell(msg.kind || 'text')} | ${escCell(msg.context_marker || '')} | ${escCell(msg.speaker)} | ${escCell(msg.speaker_source)} | ${msg.conf ?? ''} | ${escCell(msg.text)} |`);
  }
  lines.push('');
  lines.push('## Caveats');
  lines.push('');
  for (const note of output.notes) lines.push(`- ${note}`);
  writeFileSync(outMd, `${lines.join('\n')}\n`);
}

if (!outJson && !outMd) {
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}
