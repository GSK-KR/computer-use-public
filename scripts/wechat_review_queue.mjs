#!/usr/bin/env node
// Build a metrics-only review queue for WeChat OCR exports.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const batchDirs = [];
const args = new Map();
const flags = new Set();
for (let i = 2; i < process.argv.length; i++) {
  const cur = process.argv[i];
  if (cur === '--batch-dir') {
    batchDirs.push(process.argv[++i]);
  } else if (cur.startsWith('--batch-dir=')) {
    batchDirs.push(cur.slice('--batch-dir='.length));
  } else if (cur.startsWith('--') && cur.includes('=')) {
    const [key, ...rest] = cur.slice(2).split('=');
    args.set(key, rest.join('='));
  } else if (cur.startsWith('--')) {
    const key = cur.slice(2);
    if (['json'].includes(key)) flags.add(key);
    else args.set(key, process.argv[++i]);
  } else {
    batchDirs.push(cur);
  }
}

function readJson(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function confidenceFromDb(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n > 1 ? Math.round(n) / 100 : n;
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
  const confidence = confidenceFromDb(msg?.conf);
  if (confidence !== null && Number(confidence) < 0.82) return false;
  const text = String(note || '');
  return !/(OCR|저신뢰|낮은\s*신뢰|low[-\s]?confidence|발신자|보낸 사람|sender|speaker|잘려|잘림|가려|가림|부분|일부|흐림|흐릿)/iu.test(text);
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
    confidence: confidenceFromDb(msg?.conf),
  })) {
    return '';
  }
  return note;
}

function isAttachmentReviewMessage({ kind, speaker, confidence, riskNote }) {
  if ((kind || 'text') === 'text') return false;
  if (!speaker || speaker === 'Unknown') return true;
  if (confidence !== null && confidence !== undefined && Number(confidence) < 0.82) return true;
  const note = String(riskNote || '').trim();
  if (!note) return false;
  return !isGenericAttachmentRiskNote(note);
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
  const first = Number(msg?.frame_first);
  const last = Number(msg?.frame_last ?? first);
  if (!Number.isFinite(first)) return null;
  return {
    first: Math.floor(first),
    last: Number.isFinite(last) ? Math.floor(last) : Math.floor(first),
  };
}

function addFrameWindow(set, range, radius = 0) {
  if (!range) return;
  for (let frame = range.first - radius; frame <= range.last + radius; frame++) set.add(frame);
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

  if (textKey.length >= 30 && knownLongTexts.some((known) => known.includes(textKey))) return true;

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
          for (let frame = range.first; frame <= range.last; frame++) knownShortTextFrames.get(shortKey).push(frame);
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
  const n = Number(msg?.frame_first);
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
  return { messages: out, removed };
}

function runSqlJson(dbPath, sql) {
  const result = spawnSync(process.env.SQLITE3 || 'sqlite3', ['-readonly', '-json', '-cmd', '.timeout 5000', dbPath, sql], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `sqlite3 exit ${result.status}`).trim());
  const text = result.stdout.trim();
  return text ? JSON.parse(text) : [];
}

function reasonsFromAudit(audit) {
  const metrics = audit?.metrics || {};
  const messages = metrics.messages || {};
  const frames = metrics.frames || {};
  const reasons = [];
  if (frames.stopped_at_max_frames === true) reasons.push('capture_hit_max_frames');
  if (num(messages.unknown_speaker_messages) > 0) reasons.push('unknown_speaker');
  if (num(messages.low_confidence_messages) > 0) reasons.push('low_confidence_text');
  if (num(messages.non_text_messages) > 0) reasons.push('attachment_or_media_card');
  if (num(messages.ocr_artifacts_dropped) > 0) reasons.push('ocr_artifacts_dropped');
  for (const issue of Array.isArray(audit?.issues) ? audit.issues : []) {
    if (issue.severity === 'review') reasons.push(String(issue.message || 'review_issue'));
  }
  return [...new Set(reasons)];
}

function roomEntry(batch, room) {
  const audit = readJson(room.room_dir ? join(room.room_dir, 'wechat_audit.json') : '');
  const metrics = audit?.metrics || {};
  return {
    batch_dir: batch.output_dir,
    index: room.index,
    label: room.label || '',
    audit_status: room.audit_status || 'missing',
    scrape_status: room.scrape_status || null,
    room_dir: room.room_dir || null,
    frames: metrics.frames?.captured ?? null,
    max_frames: metrics.frames?.max_frames ?? null,
    messages: metrics.messages?.structured ?? null,
    unknown_speaker_messages: metrics.messages?.unknown_speaker_messages ?? null,
    low_confidence_messages: metrics.messages?.low_confidence_messages ?? null,
    non_text_messages: metrics.messages?.non_text_messages ?? null,
    ocr_artifacts_dropped: metrics.messages?.ocr_artifacts_dropped ?? null,
    elapsed_s: metrics.timings?.total_elapsed_s ?? null,
    seconds_per_message: metrics.timings?.seconds_per_message ?? null,
    reasons: reasonsFromAudit(audit),
  };
}

function dbReasonList(row) {
  const reasons = [];
  const frames = num(row.frames);
  const maxFrames = num(row.max_frames);
  if (maxFrames > 0 && frames >= maxFrames) reasons.push('capture_hit_max_frames');
  if (num(row.missing_translations) > 0) reasons.push('missing_translation');
  if (num(row.unknown_text_messages) > 0) reasons.push('unknown_speaker_text');
  if (num(row.text_review_messages) > 0) reasons.push('text_review');
  if (num(row.low_confidence_messages) > 0) reasons.push('low_confidence_text');
  if (num(row.non_text_review_messages) > 0) reasons.push('attachment_or_media_review');
  if (num(row.translation_risk_messages) > 0) reasons.push('translation_risk');
  if (num(row.emoji_review_messages) > 0) reasons.push('emoji_review');
  if (num(row.quote_review_messages) > 0) reasons.push('quote_review');
  if (num(row.speaker_visual_review_messages) > 0) reasons.push('speaker_visual_review');
  if (num(row.ocr_note_review_messages) > 0) reasons.push('ocr_note_review');
  if (num(row.source_review_messages) > 0) reasons.push('source_review');
  if (num(row.source_count_mismatch) > 0) reasons.push('source_count_mismatch');
  return [...new Set(reasons)];
}

function dbRooms(dbPath) {
  if (!existsSync(dbPath)) throw new Error(`missing DB: ${dbPath}`);
  const rows = runSqlJson(dbPath, `
    WITH current_audit AS (
      SELECT ra.*
      FROM room_audits ra
      JOIN rooms r ON r.room_key = ra.room_key AND r.latest_room_dir = ra.room_dir
    ),
    source_counts AS (
      SELECT message_key, COUNT(*) AS actual_source_count
      FROM message_sources
      GROUP BY message_key
    )
    SELECT
      r.room_key,
      r.label,
      r.latest_status,
      r.latest_room_dir,
      ca.batch_dir,
      ca.room_dir,
      ca.audit_status AS stored_audit_status,
      ca.frames,
      ca.max_frames,
      ca.elapsed_s,
      ca.seconds_per_message,
      COUNT(m.message_key) AS raw_messages,
      SUM(CASE WHEN COALESCE(m.source_count, 0) != COALESCE(sc.actual_source_count, 0) THEN 1 ELSE 0 END) AS source_count_mismatch
    FROM rooms r
    JOIN messages m ON m.room_key = r.room_key
    LEFT JOIN current_audit ca ON ca.room_key = r.room_key
    LEFT JOIN source_counts sc ON sc.message_key = m.message_key
    GROUP BY r.room_key
    ORDER BY LOWER(r.label);
  `);

  const messageRows = runSqlJson(dbPath, `
    WITH source_counts AS (
      SELECT message_key, COUNT(*) AS actual_source_count
      FROM message_sources
      GROUP BY message_key
    )
    SELECT
      m.room_key,
      m.message_key,
      m.kind,
      m.speaker,
      m.speaker_source,
      m.side,
      m.text,
      m.translation_ko,
      m.translation_risk_note_ko,
      m.conf,
      m.requires_screenshot_review,
      m.frame_first,
      m.frame_last,
      m.occurrence_index,
      m.source_count,
      COALESCE(sc.actual_source_count, 0) AS actual_source_count
    FROM messages m
    LEFT JOIN source_counts sc ON sc.message_key = m.message_key
    ORDER BY m.room_key, m.frame_first, m.y, m.occurrence_index, m.message_key;
  `);
  const messagesByRoom = new Map();
  for (const row of messageRows) {
    const roomKey = row.room_key || '';
    if (!messagesByRoom.has(roomKey)) messagesByRoom.set(roomKey, []);
    const kind = row.kind || 'text';
    const speaker = row.speaker || 'Unknown';
    const confidence = confidenceFromDb(row.conf);
    const requiresReview = Boolean(Number(row.requires_screenshot_review || 0));
    const effectiveRiskNote = effectiveWechatRiskNote(row, {
      kind,
      speaker,
      speakerSource: row.speaker_source,
      side: row.side,
      requiresReview,
    });
    const riskCategory = riskNoteCategory(effectiveRiskNote, kind);
    const speakerUnknown = speaker === 'Unknown' && kind === 'text';
    const textReview = kind === 'text' && confidence !== null && Number(confidence) < 0.82;
    const lowConfidence = kind === 'text' && confidence !== null && Number(confidence) < 0.55;
    const attachmentReview = isAttachmentReviewMessage({ kind, speaker, confidence, riskNote: effectiveRiskNote });
    const textRequiresReview = kind === 'text' && (
      speakerUnknown ||
      (requiresReview && textReview) ||
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
    messagesByRoom.get(roomKey).push({
      ...row,
      kind,
      speaker,
      confidence,
      translation_risk_note_ko: effectiveRiskNote,
      requires_review: effectiveRequiresReview,
      flags: {
        speakerUnknown,
        textReview,
        lowConfidence,
        attachmentReview,
        translationRisk,
        emojiReview,
        quoteReview,
        speakerVisualReview,
        ocrNoteReview,
        sourceReview,
      },
    });
  }

  function effectiveRoomMetrics(roomKey) {
    const all = messagesByRoom.get(roomKey) || [];
    const nonMessageArtifacts = filterWechatNonMessageArtifacts(all);
    const visualDedupe = dedupeVisualOverlapMessages(nonMessageArtifacts.messages);
    const visible = visualDedupe.messages;
    return {
      messages: visible.length,
      raw_messages: all.length,
      hidden_artifact_count: nonMessageArtifacts.hidden,
      dedupe_removed: visualDedupe.removed,
      unknown_speaker_messages: visible.filter((m) => m.speaker === 'Unknown').length,
      unknown_text_messages: visible.filter((m) => m.speaker === 'Unknown' && m.kind === 'text').length,
      unknown_non_text_messages: visible.filter((m) => m.speaker === 'Unknown' && m.kind !== 'text').length,
      low_confidence_messages: visible.filter((m) => m.flags.lowConfidence).length,
      text_review_messages: visible.filter((m) => m.flags.textReview).length,
      non_text_messages: visible.filter((m) => m.kind !== 'text').length,
      non_text_review_messages: visible.filter((m) => m.flags.attachmentReview).length,
      screenshot_review_messages: visible.filter((m) => m.requires_review).length,
      source_review_messages: visible.filter((m) => m.flags.sourceReview).length,
      missing_translations: visible.filter((m) => !String(m.translation_ko || '').trim()).length,
      translation_risk_notes: visible.filter((m) => String(m.translation_risk_note_ko || '').trim()).length,
      translation_risk_messages: visible.filter((m) => m.flags.translationRisk).length,
      emoji_review_messages: visible.filter((m) => m.flags.emojiReview).length,
      quote_review_messages: visible.filter((m) => m.flags.quoteReview).length,
      speaker_visual_review_messages: visible.filter((m) => m.flags.speakerVisualReview).length,
      ocr_note_review_messages: visible.filter((m) => m.flags.ocrNoteReview).length,
    };
  }

  return rows.map((row) => {
    const effective = effectiveRoomMetrics(row.room_key);
    const merged = { ...row, ...effective };
    const reasons = dbReasonList(merged);
    return {
      source: 'db',
      db: dbPath,
      batch_dir: row.batch_dir || null,
      index: null,
      label: row.label || '',
      audit_status: reasons.length ? 'review' : 'pass',
      stored_audit_status: row.stored_audit_status || row.latest_status || null,
      latest_status: row.latest_status || null,
      room_dir: row.room_dir || row.latest_room_dir || null,
      frames: row.frames ?? null,
      max_frames: row.max_frames ?? null,
      messages: num(merged.messages),
      raw_messages: num(merged.raw_messages),
      hidden_artifact_count: num(merged.hidden_artifact_count),
      dedupe_removed: num(merged.dedupe_removed),
      unknown_speaker_messages: num(merged.unknown_speaker_messages),
      unknown_text_messages: num(merged.unknown_text_messages),
      unknown_non_text_messages: num(merged.unknown_non_text_messages),
      low_confidence_messages: num(merged.low_confidence_messages),
      text_review_messages: num(merged.text_review_messages),
      non_text_messages: num(merged.non_text_messages),
      non_text_review_messages: num(merged.non_text_review_messages),
      screenshot_review_messages: num(merged.screenshot_review_messages),
      source_review_messages: num(merged.source_review_messages),
      missing_translations: num(merged.missing_translations),
      translation_risk_notes: num(merged.translation_risk_notes),
      translation_risk_messages: num(merged.translation_risk_messages),
      emoji_review_messages: num(merged.emoji_review_messages),
      quote_review_messages: num(merged.quote_review_messages),
      speaker_visual_review_messages: num(merged.speaker_visual_review_messages),
      ocr_note_review_messages: num(merged.ocr_note_review_messages),
      source_count_mismatch: num(row.source_count_mismatch),
      elapsed_s: row.elapsed_s ?? null,
      seconds_per_message: row.seconds_per_message ?? null,
      reasons,
    };
  });
}

const dbArg = args.get('db');
const dbPath = dbArg ? resolve(dbArg) : '';

const batches = batchDirs.map((dir) => {
  const batchDir = resolve(dir);
  const manifest = readJson(join(batchDir, 'wechat_batch_manifest.json'));
  if (!manifest) throw new Error(`missing batch manifest: ${batchDir}`);
  return manifest;
});

if (!batches.length && !dbPath) {
  console.error('usage: node scripts/wechat_review_queue.mjs [--batch-dir DIR ...] [--db FILE] [--out-json FILE] [--out-md FILE] [--json]');
  process.exit(2);
}

const rooms = [
  ...batches.flatMap((batch) => (Array.isArray(batch.rooms) ? batch.rooms : []).map((room) => roomEntry(batch, room))),
  ...(dbPath ? dbRooms(dbPath) : []),
];
const reviewRooms = rooms.filter((room) => room.audit_status === 'review');
const reasonCounts = {};
for (const room of reviewRooms) {
  for (const reason of room.reasons) reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
}

const output = {
  schema: 'wechat_review_queue.v1',
  generated_at: new Date().toISOString(),
  scope: 'metrics-only queue; no message text',
  stats: {
    batches: batches.length,
    dbs: dbPath ? 1 : 0,
    rooms: rooms.length,
    review: reviewRooms.length,
    pass: rooms.filter((room) => room.audit_status === 'pass').length,
    skipped_non_chat: rooms.filter((room) => room.audit_status === 'skipped_non_chat').length,
    skipped_duplicate_title: rooms.filter((room) => room.audit_status === 'skipped_duplicate_title').length,
    fail_or_missing: rooms.filter((room) => !['pass', 'review', 'skipped_non_chat', 'skipped_duplicate_title'].includes(room.audit_status)).length,
    reason_counts: reasonCounts,
  },
  review_rooms: reviewRooms,
};

const outJson = args.get('out-json');
if (outJson) {
  const path = resolve(outJson);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`);
}

const outMd = args.get('out-md');
if (outMd) {
  const path = resolve(outMd);
  mkdirSync(dirname(path), { recursive: true });
  const lines = [];
  lines.push('# WeChat Review Queue');
  lines.push('');
  lines.push(`- Generated: ${output.generated_at}`);
  lines.push(`- Rooms: ${output.stats.rooms}`);
  lines.push(`- DBs: ${output.stats.dbs}`);
  lines.push(`- Batches: ${output.stats.batches}`);
  lines.push(`- Review: ${output.stats.review}`);
  lines.push(`- Pass: ${output.stats.pass}`);
  lines.push(`- Skipped non-chat: ${output.stats.skipped_non_chat}`);
  lines.push(`- Skipped duplicate title: ${output.stats.skipped_duplicate_title}`);
  lines.push(`- Fail/missing: ${output.stats.fail_or_missing}`);
  lines.push('');
  lines.push('## Reason Counts');
  lines.push('');
  for (const [reason, count] of Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${reason}: ${count}`);
  }
  lines.push('');
  lines.push('## Rooms');
  lines.push('');
  lines.push('| # | Source | Label | Frames | Messages | Hidden | Dedupe | Unknown Text | Text Review | Media Review | Source Review | Seconds | Reasons |');
  lines.push('|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|');
  for (const room of reviewRooms) {
    const sourceName = room.source === 'db' ? String(room.db || '').split('/').pop() : String(room.batch_dir || '').split('/').pop();
    const cell = (value) => String(value ?? '').replace(/\|/g, '\\|');
    const reviewCount = (room.screenshot_review_messages ?? room.ocr_artifacts_dropped ?? '');
    lines.push(`| ${room.index ?? ''} | ${cell(sourceName)} | ${cell(room.label)} | ${room.frames ?? ''}/${room.max_frames ?? ''} | ${room.messages ?? ''} | ${room.hidden_artifact_count ?? ''} | ${room.dedupe_removed ?? ''} | ${room.unknown_text_messages ?? room.unknown_speaker_messages ?? ''} | ${room.text_review_messages ?? room.low_confidence_messages ?? ''} | ${room.non_text_review_messages ?? ''} | ${room.source_review_messages ?? reviewCount} | ${room.elapsed_s ?? ''} | ${cell(room.reasons.join(', '))} |`);
  }
  lines.push('');
  writeFileSync(path, `${lines.join('\n')}\n`);
}

if (flags.has('json') || (!outJson && !outMd)) {
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} else {
  console.log(`REVIEW_QUEUE rooms=${output.stats.rooms} review=${output.stats.review} pass=${output.stats.pass} skipped_non_chat=${output.stats.skipped_non_chat} skipped_duplicate_title=${output.stats.skipped_duplicate_title} fail_or_missing=${output.stats.fail_or_missing}`);
  if (outJson) console.log(`OUT_JSON=${resolve(outJson)}`);
  if (outMd) console.log(`OUT_MD=${resolve(outMd)}`);
}
