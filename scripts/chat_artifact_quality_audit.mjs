#!/usr/bin/env node
// Redacted adversarial audit for the unified chat artifact viewer.
//
// It reads the viewer API, not raw app data, and never prints message text.
// Use this after starting `cu chat-view` to decide whether the visible archive
// is safe to rely on or still needs OCR/translation/manual review.

import { writeFileSync } from 'node:fs';

const options = {
  url: process.env.CHAT_VIEW_URL || 'http://127.0.0.1:8766',
  json: false,
  check: false,
  redactLabels: false,
  outJson: '',
  outMd: '',
  expectPlatforms: new Map(),
  maxUnknownRatio: 0,
};

for (let i = 2; i < process.argv.length; i++) {
  const cur = process.argv[i];
  if (cur === '--url') options.url = process.argv[++i];
  else if (cur.startsWith('--url=')) options.url = cur.slice('--url='.length);
  else if (cur === '--json') options.json = true;
  else if (cur === '--check') options.check = true;
  else if (cur === '--redact-labels') options.redactLabels = true;
  else if (cur === '--out-json') options.outJson = process.argv[++i];
  else if (cur.startsWith('--out-json=')) options.outJson = cur.slice('--out-json='.length);
  else if (cur === '--out-md') options.outMd = process.argv[++i];
  else if (cur.startsWith('--out-md=')) options.outMd = cur.slice('--out-md='.length);
  else if (cur === '--expect-platform') addExpectedPlatform(process.argv[++i]);
  else if (cur.startsWith('--expect-platform=')) addExpectedPlatform(cur.slice('--expect-platform='.length));
  else if (cur === '--max-unknown-ratio') options.maxUnknownRatio = Number(process.argv[++i]);
  else if (cur.startsWith('--max-unknown-ratio=')) options.maxUnknownRatio = Number(cur.slice('--max-unknown-ratio='.length));
  else if (cur === '-h' || cur === '--help') {
    usage();
    process.exit(0);
  } else {
    console.error(`unknown option: ${cur}`);
    usage();
    process.exit(2);
  }
}

function usage() {
  console.error(`usage:
  node scripts/chat_artifact_quality_audit.mjs [--url http://127.0.0.1:8766] [--json] [--check]
    [--expect-platform kakao:1] [--expect-platform wechat:1]
    [--max-unknown-ratio 0.05] [--redact-labels] [--out-json FILE] [--out-md FILE]`);
}

function addExpectedPlatform(spec) {
  const [name, countText = '1'] = String(spec || '').split(':');
  const count = Number(countText);
  if (!name || !Number.isFinite(count) || count < 0) {
    console.error(`invalid --expect-platform value: ${spec}`);
    process.exit(2);
  }
  options.expectPlatforms.set(name, count);
}

function baseUrl() {
  return String(options.url || '').replace(/\/+$/u, '');
}

async function getJson(path) {
  const res = await fetch(`${baseUrl()}${path}`, { cache: 'no-store' });
  let body;
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status} ${path}`);
  return body;
}

function n(value) {
  return Number(value || 0);
}

function ratio(part, total) {
  return n(total) > 0 ? n(part) / n(total) : 0;
}

function issue(issues, severity, code, count, message, extra = {}) {
  if (n(count) <= 0) return;
  issues.push({ severity, code, count: n(count), message, ...extra });
}

function label(room, index = 0) {
  if (!options.redactLabels) return room.label || '(unnamed)';
  return `${room.platform || 'room'}#${index + 1}`;
}

function normalizedTextKey(msg) {
  return String(msg.text || '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

function duplicateFindings(messages) {
  let adjacentExact = 0;
  let emptyText = 0;
  let outgoingUnknown = 0;
  let outgoingNonMe = 0;
  let incomingMe = 0;
  const seen = new Set();
  let globalExact = 0;
  let prev = null;

  for (const msg of messages) {
    const side = msg.side || (msg.direction === 'outgoing' ? 'right' : 'left');
    const speaker = msg.speaker || 'Unknown';
    const kind = msg.kind || 'text';
    const keyText = normalizedTextKey(msg);
    if (kind === 'text' && !keyText) emptyText += 1;
    if (side === 'right' && speaker === 'Unknown') outgoingUnknown += 1;
    if (side === 'right' && speaker !== 'Me') outgoingNonMe += 1;
    if (side !== 'right' && speaker === 'Me') incomingMe += 1;

    const key = `${speaker}\t${side}\t${kind}\t${keyText}`;
    if (keyText && seen.has(key)) globalExact += 1;
    if (keyText) seen.add(key);
    if (prev && prev === key && keyText) adjacentExact += 1;
    prev = key;
  }

  return { adjacentExact, globalExact, emptyText, outgoingUnknown, outgoingNonMe, incomingMe };
}

function roomWarnings(room) {
  return (room.quality_warnings || []).map((warning) => warning.label || warning.code).filter(Boolean);
}

function markdown(output) {
  const lines = [];
  lines.push(`# Chat Artifact Quality Audit`);
  lines.push('');
  lines.push(`- Status: ${output.status.toUpperCase()}`);
  lines.push(`- URL: ${output.url}`);
  lines.push(`- Generated: ${output.generated_at}`);
  lines.push(`- Rooms/messages: ${output.counts.rooms}/${output.counts.messages}`);
  lines.push(`- Unknown speakers: ${output.counts.unknown}`);
  lines.push(`- Quality warnings: ${output.counts.quality_warnings}`);
  lines.push('');
  lines.push(`## Issues`);
  if (!output.issues.length) {
    lines.push('');
    lines.push('None.');
  } else {
    lines.push('');
    lines.push('| Severity | Code | Count | Detail |');
    lines.push('| --- | --- | ---: | --- |');
    for (const item of output.issues) {
      lines.push(`| ${item.severity} | ${item.code} | ${item.count} | ${escapeCell(item.message)} |`);
    }
  }
  lines.push('');
  lines.push(`## Top Review Rooms`);
  if (!output.top_review_rooms.length) {
    lines.push('');
    lines.push('None.');
  } else {
    lines.push('');
    lines.push('| Platform | Room | Messages | Unknown | Status | Warnings |');
    lines.push('| --- | --- | ---: | ---: | --- | --- |');
    for (const room of output.top_review_rooms) {
      lines.push(`| ${escapeCell(room.platform)} | ${escapeCell(room.label)} | ${room.message_count} | ${room.unknown_count} | ${room.status} | ${escapeCell(room.warnings.join(', '))} |`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function escapeCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replace(/\s+/gu, ' ').trim();
}

let output;
try {
  const [health, roomsPayload] = await Promise.all([
    getJson('/api/health'),
    getJson('/api/rooms?platform=all'),
  ]);
  const rooms = roomsPayload.rooms || [];
  const issues = [];
  const roomReports = [];
  const platformCounts = {};
  let totalAdjacentDuplicates = 0;
  let totalGlobalDuplicates = 0;
  let totalEmptyText = 0;
  let totalOutgoingUnknown = 0;
  let totalOutgoingNonMe = 0;
  let totalIncomingMe = 0;
  let missingTranslations = 0;
  let lowConfidence = 0;
  let textReview = 0;
  let nonText = 0;
  let nonTextReview = 0;
  let sourceReview = 0;
  let reviewRequired = 0;
  let riskNotes = 0;
  let translationRisk = 0;
  let emojiReview = 0;
  let quoteReview = 0;
  let speakerVisualReview = 0;
  let ocrNoteReview = 0;
  let kakaoSplitFragmentPairs = 0;
  let kakaoSpeakerFallback = 0;

  for (let index = 0; index < rooms.length; index++) {
    const room = rooms[index];
    platformCounts[room.platform] = (platformCounts[room.platform] || 0) + 1;
    const [detail, messagesPayload] = await Promise.all([
      getJson(`/api/rooms/${encodeURIComponent(room.id)}`),
      getJson(`/api/rooms/${encodeURIComponent(room.id)}/messages?limit=50000`),
    ]);
    const publicRoom = detail.room || room;
    const messages = messagesPayload.messages || [];
    const dup = duplicateFindings(messages);
    totalAdjacentDuplicates += dup.adjacentExact;
    totalGlobalDuplicates += dup.globalExact;
    totalEmptyText += dup.emptyText;
    totalOutgoingUnknown += dup.outgoingUnknown;
    totalOutgoingNonMe += dup.outgoingNonMe;
    totalIncomingMe += dup.incomingMe;
    missingTranslations += n(publicRoom.wechat?.missing_translation_count);
    lowConfidence += n(publicRoom.wechat?.low_confidence_count);
    textReview += n(publicRoom.wechat?.text_review_count);
    nonText += n(publicRoom.wechat?.non_text_count);
    nonTextReview += n(publicRoom.wechat?.non_text_review_count);
    sourceReview += n(publicRoom.wechat?.source_review_count ?? publicRoom.wechat?.review_message_count);
    reviewRequired += n(publicRoom.wechat?.review_required_count);
    riskNotes += n(publicRoom.wechat?.risk_note_count);
    translationRisk += n(publicRoom.wechat?.translation_risk_count);
    emojiReview += n(publicRoom.wechat?.emoji_review_count);
    quoteReview += n(publicRoom.wechat?.quote_review_count);
    speakerVisualReview += n(publicRoom.wechat?.speaker_visual_review_count);
    ocrNoteReview += n(publicRoom.wechat?.ocr_note_review_count);
    kakaoSplitFragmentPairs += n(publicRoom.kakao?.split_fragment_pairs);
    kakaoSpeakerFallback += n(publicRoom.kakao?.speaker_room_label_fallback_messages);

    const warnings = roomWarnings(publicRoom);
    roomReports.push({
      id: publicRoom.id,
      platform: publicRoom.platform,
      label: label(publicRoom, index),
      status: publicRoom.status || 'review',
      message_count: n(publicRoom.message_count),
      unknown_count: n(publicRoom.unknown_count),
      unknown_ratio: ratio(publicRoom.unknown_count, publicRoom.message_count),
      dedupe_count: n(publicRoom.dedupe_count),
      missing_translation_count: n(publicRoom.wechat?.missing_translation_count),
      low_confidence_count: n(publicRoom.wechat?.low_confidence_count),
      text_review_count: n(publicRoom.wechat?.text_review_count),
      non_text_count: n(publicRoom.wechat?.non_text_count),
      non_text_review_count: n(publicRoom.wechat?.non_text_review_count),
      screenshot_review_count: n(publicRoom.wechat?.source_review_count ?? publicRoom.wechat?.review_message_count),
      source_review_count: n(publicRoom.wechat?.source_review_count ?? publicRoom.wechat?.review_message_count),
      review_required_count: n(publicRoom.wechat?.review_required_count),
      risk_note_count: n(publicRoom.wechat?.risk_note_count),
      translation_risk_count: n(publicRoom.wechat?.translation_risk_count),
      emoji_review_count: n(publicRoom.wechat?.emoji_review_count),
      quote_review_count: n(publicRoom.wechat?.quote_review_count),
      speaker_visual_review_count: n(publicRoom.wechat?.speaker_visual_review_count),
      ocr_note_review_count: n(publicRoom.wechat?.ocr_note_review_count),
      kakao_split_fragment_pairs: n(publicRoom.kakao?.split_fragment_pairs),
      kakao_speaker_fallback_messages: n(publicRoom.kakao?.speaker_room_label_fallback_messages),
      adjacent_exact_duplicates: dup.adjacentExact,
      global_exact_duplicates: dup.globalExact,
      empty_text_messages: dup.emptyText,
      outgoing_unknown: dup.outgoingUnknown,
      outgoing_non_me: dup.outgoingNonMe,
      incoming_me: dup.incomingMe,
      warnings,
    });
  }

  issue(issues, 'fail', 'viewer_no_rooms', rooms.length === 0 ? 1 : 0, 'viewer returned no rooms');
  issue(issues, 'fail', 'viewer_no_messages', n(health.counts?.messages) === 0 ? 1 : 0, 'viewer returned no messages');
  issue(issues, 'fail', 'empty_text_messages', totalEmptyText, 'text messages with empty text');
  issue(issues, 'fail', 'outgoing_unknown', totalOutgoingUnknown, 'right-side/outgoing messages labeled Unknown');
  issue(issues, 'fail', 'outgoing_non_me', totalOutgoingNonMe, 'right-side/outgoing messages not labeled Me');
  issue(issues, 'fail', 'incoming_me', totalIncomingMe, 'left-side/incoming messages labeled Me');
  issue(issues, 'review', 'speaker_review', n(health.counts?.unknown), 'messages need speaker review');
  issue(issues, 'review', 'missing_translations', missingTranslations, 'WeChat messages without stored Korean translation');
  issue(issues, 'review', 'low_confidence_text', lowConfidence, 'WeChat low-confidence text messages');
  issue(issues, 'review', 'text_review', textReview, 'WeChat text messages below review confidence threshold');
  issue(issues, 'review', 'non_text_review', nonTextReview, 'attachment/media-card entries needing source review');
  issue(issues, 'review', 'translation_risk', translationRisk, 'messages with translation risk notes');
  issue(issues, 'review', 'emoji_review', emojiReview, 'messages with emoji rendering uncertainty');
  issue(issues, 'review', 'quote_review', quoteReview, 'messages with reply/quote preview uncertainty');
  issue(issues, 'review', 'speaker_visual_review', speakerVisualReview, 'messages with visually uncertain sender display notes');
  issue(issues, 'review', 'ocr_note_review', ocrNoteReview, 'messages with text/OCR uncertainty notes');
  issue(issues, 'review', 'source_review', sourceReview, 'messages needing original screenshot/app review after specific causes are separated');
  issue(issues, 'review', 'kakao_split_fragments', kakaoSplitFragmentPairs, 'Kakao OCR lines that may still be split from the same bubble');
  issue(issues, 'review', 'kakao_speaker_fallback', kakaoSpeakerFallback, 'Kakao messages whose speaker was filled from the room label because the sender name was not visible');

  for (const [platform, minCount] of options.expectPlatforms) {
    issue(issues, 'fail', `missing_platform_${platform}`, platformCounts[platform] >= minCount ? 0 : minCount - n(platformCounts[platform]), `expected at least ${minCount} ${platform} room(s)`);
  }
  if (options.maxUnknownRatio > 0) {
    const overLimit = roomReports.filter((room) => room.unknown_ratio > options.maxUnknownRatio).length;
    issue(issues, 'review', 'unknown_ratio_limit', overLimit, `rooms exceed unknown speaker ratio ${options.maxUnknownRatio}`);
  }

  const failCount = issues.filter((item) => item.severity === 'fail').length;
  const reviewCount = issues.filter((item) => item.severity === 'review').length;
  const status = failCount ? 'fail' : (reviewCount ? 'review' : 'pass');
  output = {
    schema: 'chat_artifact_quality_audit.v1',
    generated_at: new Date().toISOString(),
    status,
    url: baseUrl(),
    counts: {
      ...(health.counts || {}),
      adjacent_exact_duplicates: totalAdjacentDuplicates,
      global_exact_duplicates: totalGlobalDuplicates,
      empty_text_messages: totalEmptyText,
      outgoing_unknown: totalOutgoingUnknown,
      outgoing_non_me: totalOutgoingNonMe,
      incoming_me: totalIncomingMe,
      missing_translations: missingTranslations,
      low_confidence_text: lowConfidence,
      text_review: textReview,
      non_text: nonText,
      non_text_review: nonTextReview,
      risk_notes: riskNotes,
      translation_risk: translationRisk,
      emoji_review: emojiReview,
      quote_review: quoteReview,
      speaker_visual_review: speakerVisualReview,
      ocr_note_review: ocrNoteReview,
      source_review: sourceReview,
      screenshot_review: sourceReview,
      review_required: reviewRequired,
      kakao_split_fragment_pairs: kakaoSplitFragmentPairs,
      kakao_speaker_fallback_messages: kakaoSpeakerFallback,
    },
    platform_counts: platformCounts,
    issues,
    top_review_rooms: roomReports
      .filter((room) => room.status !== 'pass' || room.unknown_count || room.warnings.length || room.adjacent_exact_duplicates || room.missing_translation_count)
      .sort((a, b) => b.unknown_count - a.unknown_count || b.screenshot_review_count - a.screenshot_review_count || b.message_count - a.message_count)
      .slice(0, 25),
    rooms: roomReports,
  };
} catch (err) {
  output = {
    schema: 'chat_artifact_quality_audit.v1',
    generated_at: new Date().toISOString(),
    status: 'fail',
    url: baseUrl(),
    counts: {},
    platform_counts: {},
    issues: [{ severity: 'fail', code: 'viewer_unreachable', count: 1, message: err.message || String(err) }],
    top_review_rooms: [],
    rooms: [],
  };
}

if (options.outJson) writeFileSync(options.outJson, `${JSON.stringify(output, null, 2)}\n`);
if (options.outMd) writeFileSync(options.outMd, markdown(output));

if (options.json) {
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} else {
  console.log(`Chat artifact quality audit: ${output.status.toUpperCase()}`);
  console.log(`URL: ${output.url}`);
  console.log(`Rooms/messages: ${n(output.counts.rooms)}/${n(output.counts.messages)}`);
  console.log(`Platforms: ${Object.entries(output.platform_counts).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
  console.log(`Review counters: speaker ${n(output.counts.unknown)}, missing translations ${n(output.counts.missing_translations)}, low text ${n(output.counts.low_confidence_text)}, non-text ${n(output.counts.non_text)}, duplicates ${n(output.counts.adjacent_exact_duplicates)}`);
  if (output.issues.length) {
    console.log('');
    console.log('Issues:');
    for (const item of output.issues) console.log(`  - [${item.severity}] ${item.code}: ${item.count} ${item.message}`);
  }
  if (output.top_review_rooms.length) {
    console.log('');
    console.log('Top review rooms:');
    for (const room of output.top_review_rooms.slice(0, 10)) {
      console.log(`  - [${room.platform}] ${room.label}: messages=${room.message_count}, speaker_review=${room.unknown_count}, status=${room.status}, warnings=${room.warnings.join(', ') || 'none'}`);
    }
  }
}

if (options.check && output.status !== 'pass') {
  process.exit(output.status === 'fail' ? 2 : 1);
}
