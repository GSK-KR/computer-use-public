#!/usr/bin/env node
// Read-only adversarial validator for the local WeChat SQLite backup.
//
// It reports counts and invariant violations only. It does not print message
// text, translations, or speaker names from private chats.
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPathConfig } from './lib/path_config.mjs';

const pathConfig = loadPathConfig();

const options = {
  db: process.env.WECHAT_DB || pathConfig.wechatDbWsl,
  json: false,
  check: false,
};

for (let i = 2; i < process.argv.length; i++) {
  const cur = process.argv[i];
  if (cur === '--db') options.db = process.argv[++i];
  else if (cur.startsWith('--db=')) options.db = cur.slice('--db='.length);
  else if (cur === '--json') options.json = true;
  else if (cur === '--check') options.check = true;
  else if (cur === '-h' || cur === '--help') {
    usage();
    process.exit(0);
  } else {
    console.error(`unknown option: ${cur}`);
    usage();
    process.exit(2);
  }
}

options.db = resolve(options.db);
if (!existsSync(options.db)) {
  console.error(`missing DB: ${options.db}`);
  process.exit(2);
}

function usage() {
  console.error('usage: node scripts/wechat_db_validate.mjs --db FILE [--json] [--check]');
}

function runSql(sql) {
  const result = spawnSync(pathConfig.sqlite3Path || 'sqlite3', ['-readonly', '-json', '-cmd', '.timeout 5000', options.db, sql], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `sqlite3 exit ${result.status}`).trim());
  const text = result.stdout.trim();
  return text ? JSON.parse(text) : [];
}

function scalar(sql) {
  const rows = runSql(sql);
  const row = rows[0] || {};
  const firstKey = Object.keys(row)[0];
  return Number(row[firstKey] || 0);
}

function issue(issues, severity, code, count, message) {
  if (Number(count || 0) <= 0) return;
  issues.push({ severity, code, count: Number(count), message });
}

function missingPaths(sql, column) {
  const rows = runSql(sql);
  return rows.filter((row) => {
    const value = row[column];
    return value && !existsSync(value);
  });
}

function effectiveReviewStats() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const result = spawnSync(process.execPath, [join(scriptDir, 'wechat_review_queue.mjs'), '--db', options.db, '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return {
      error: result.error?.message || (result.stderr || result.stdout || `review queue exit ${result.status}`).trim(),
      rooms: 0,
      review_rooms: 0,
    };
  }
  const queue = JSON.parse(result.stdout || '{}');
  const reviewRooms = Array.isArray(queue.review_rooms) ? queue.review_rooms : [];
  const sum = (field) => reviewRooms.reduce((total, room) => total + Number(room[field] || 0), 0);
  return {
    error: '',
    rooms: Number(queue.stats?.rooms || 0),
    review_rooms: Number(queue.stats?.review || 0),
    pass_rooms: Number(queue.stats?.pass || 0),
    reason_counts: queue.stats?.reason_counts || {},
    missing_translations: sum('missing_translations'),
    unknown_text: sum('unknown_text_messages'),
    low_confidence_text: sum('low_confidence_messages'),
    text_review: sum('text_review_messages'),
    non_text_review: sum('non_text_review_messages'),
    source_review: sum('source_review_messages'),
    review_required: sum('screenshot_review_messages'),
    translation_risk: sum('translation_risk_messages'),
    emoji_review: sum('emoji_review_messages'),
    quote_review: sum('quote_review_messages'),
    speaker_visual_review: sum('speaker_visual_review_messages'),
    ocr_note_review: sum('ocr_note_review_messages'),
    hidden_artifacts: sum('hidden_artifact_count'),
    visual_overlap_duplicates_removed: sum('dedupe_removed'),
  };
}

const groupWhere = "r.label LIKE '%群%' OR r.label GLOB '*([0-9])*' OR r.label GLOB '*（[0-9]*）*'";
const directWhere = `NOT (${groupWhere})`;
const effective = effectiveReviewStats();

const counts = {
  rooms: scalar('SELECT COUNT(*) AS n FROM rooms;'),
  chat_rooms: scalar('SELECT COUNT(DISTINCT room_key) AS n FROM messages;'),
  batches: scalar('SELECT COUNT(*) AS n FROM batches;'),
  messages: scalar('SELECT COUNT(*) AS n FROM messages;'),
  translated: scalar("SELECT COUNT(*) AS n FROM messages WHERE translation_ko IS NOT NULL AND translation_ko != '';"),
  source_rows: scalar('SELECT COUNT(*) AS n FROM message_sources;'),
  direct_like_messages: scalar(`SELECT COUNT(*) AS n FROM messages m JOIN rooms r ON r.room_key = m.room_key WHERE ${directWhere};`),
  group_like_messages: scalar(`SELECT COUNT(*) AS n FROM messages m JOIN rooms r ON r.room_key = m.room_key WHERE ${groupWhere};`),
  unknown: scalar("SELECT COUNT(*) AS n FROM messages WHERE speaker = 'Unknown';"),
  direct_like_unknown: scalar(`SELECT COUNT(*) AS n FROM messages m JOIN rooms r ON r.room_key = m.room_key WHERE m.speaker = 'Unknown' AND ${directWhere};`),
  group_like_unknown: scalar(`SELECT COUNT(*) AS n FROM messages m JOIN rooms r ON r.room_key = m.room_key WHERE m.speaker = 'Unknown' AND (${groupWhere});`),
  unknown_text: scalar("SELECT COUNT(*) AS n FROM messages WHERE speaker = 'Unknown' AND kind = 'text';"),
  unknown_non_text: scalar("SELECT COUNT(*) AS n FROM messages WHERE speaker = 'Unknown' AND kind != 'text';"),
  direct_like_unknown_text: scalar(`SELECT COUNT(*) AS n FROM messages m JOIN rooms r ON r.room_key = m.room_key WHERE m.speaker = 'Unknown' AND m.kind = 'text' AND ${directWhere};`),
  group_like_unknown_text: scalar(`SELECT COUNT(*) AS n FROM messages m JOIN rooms r ON r.room_key = m.room_key WHERE m.speaker = 'Unknown' AND m.kind = 'text' AND (${groupWhere});`),
  group_like_unknown_non_text: scalar(`SELECT COUNT(*) AS n FROM messages m JOIN rooms r ON r.room_key = m.room_key WHERE m.speaker = 'Unknown' AND m.kind != 'text' AND (${groupWhere});`),
  invalid_visible_speakers: scalar("SELECT COUNT(*) AS n FROM messages WHERE speaker_source = 'invalid-visible-name-candidate';"),
  low_confidence_text: scalar("SELECT COUNT(*) AS n FROM messages WHERE kind = 'text' AND conf < 55;"),
  non_text: scalar("SELECT COUNT(*) AS n FROM messages WHERE kind != 'text';"),
  effective_review_rooms: effective.review_rooms || 0,
  effective_unknown_text: effective.unknown_text || 0,
  effective_low_confidence_text: effective.low_confidence_text || 0,
  effective_text_review: effective.text_review || 0,
  effective_non_text_review: effective.non_text_review || 0,
  effective_source_review: effective.source_review || 0,
  effective_review_required: effective.review_required || 0,
  effective_translation_risk: effective.translation_risk || 0,
  effective_emoji_review: effective.emoji_review || 0,
  effective_quote_review: effective.quote_review || 0,
  effective_speaker_visual_review: effective.speaker_visual_review || 0,
  effective_ocr_note_review: effective.ocr_note_review || 0,
  effective_hidden_artifacts: effective.hidden_artifacts || 0,
  effective_visual_overlap_duplicates_removed: effective.visual_overlap_duplicates_removed || 0,
};

const violations = {
  missing_translations: counts.messages - counts.translated,
  empty_text_messages: scalar("SELECT COUNT(*) AS n FROM messages WHERE kind = 'text' AND (text IS NULL OR TRIM(text) = '');"),
  outgoing_unknown: scalar("SELECT COUNT(*) AS n FROM messages WHERE side = 'outgoing' AND speaker = 'Unknown';"),
  outgoing_non_me: scalar("SELECT COUNT(*) AS n FROM messages WHERE side = 'outgoing' AND speaker != 'Me';"),
  incoming_me: scalar("SELECT COUNT(*) AS n FROM messages WHERE side = 'incoming' AND speaker = 'Me';"),
  invalid_speaker_without_review: scalar("SELECT COUNT(*) AS n FROM messages WHERE speaker_source = 'invalid-visible-name-candidate' AND COALESCE(requires_screenshot_review, 0) != 1;"),
  duplicate_source_keys: scalar('SELECT COUNT(*) AS n FROM (SELECT source_key FROM message_sources GROUP BY source_key HAVING COUNT(*) > 1);'),
  orphan_sources: scalar('SELECT COUNT(*) AS n FROM message_sources ms LEFT JOIN messages m ON m.message_key = ms.message_key WHERE m.message_key IS NULL;'),
  orphan_messages: scalar('SELECT COUNT(*) AS n FROM messages m LEFT JOIN rooms r ON r.room_key = m.room_key WHERE r.room_key IS NULL;'),
  dryrun_sources: scalar("SELECT COUNT(*) AS n FROM message_sources WHERE batch_dir LIKE '%dry_run%' OR room_dir LIKE '%dry_run%';"),
  skipped_room_sources: scalar(`
    SELECT COUNT(*) AS n
    FROM message_sources ms
    JOIN batch_rooms br ON br.batch_dir = ms.batch_dir AND br.room_dir = ms.room_dir
    WHERE br.audit_status LIKE 'skipped%' OR br.scrape_status = 'skipped';
  `),
  source_count_mismatch: scalar(`
    SELECT COUNT(*) AS n
    FROM messages m
    LEFT JOIN (
      SELECT message_key, COUNT(*) AS actual_count
      FROM message_sources
      GROUP BY message_key
    ) src ON src.message_key = m.message_key
    WHERE COALESCE(m.source_count, 0) != COALESCE(src.actual_count, 0);
  `),
  chat_rooms_without_audit: scalar(`
    SELECT COUNT(*) AS n
    FROM (SELECT DISTINCT room_key FROM messages) mr
    LEFT JOIN room_audits ra ON ra.room_key = mr.room_key
    WHERE ra.room_key IS NULL;
  `),
};
violations.latest_room_dir_missing = missingPaths(`
  SELECT DISTINCT r.latest_room_dir
  FROM rooms r
  JOIN messages m ON m.room_key = r.room_key
  WHERE r.latest_room_dir IS NOT NULL AND r.latest_room_dir != '';
`, 'latest_room_dir').length;

const issues = [];
issue(issues, 'fail', 'no_messages', counts.messages === 0 ? 1 : 0, 'DB has no messages');
issue(issues, 'fail', 'empty_text_messages', violations.empty_text_messages, 'text messages with empty text');
issue(issues, 'fail', 'outgoing_unknown', violations.outgoing_unknown, 'outgoing messages labeled Unknown');
issue(issues, 'fail', 'outgoing_non_me', violations.outgoing_non_me, 'outgoing messages not labeled Me');
issue(issues, 'fail', 'incoming_me', violations.incoming_me, 'incoming messages labeled Me');
issue(issues, 'fail', 'direct_like_unknown_text', counts.direct_like_unknown_text, 'direct-like text messages still have Unknown speakers');
issue(issues, 'fail', 'invalid_speaker_without_review', violations.invalid_speaker_without_review, 'invalid speaker candidates not flagged for screenshot review');
issue(issues, 'fail', 'duplicate_source_keys', violations.duplicate_source_keys, 'duplicate message source keys');
issue(issues, 'fail', 'orphan_sources', violations.orphan_sources, 'message_sources rows without messages');
issue(issues, 'fail', 'orphan_messages', violations.orphan_messages, 'messages rows without rooms');
issue(issues, 'fail', 'dryrun_sources', violations.dryrun_sources, 'dry-run sources imported into DB');
issue(issues, 'fail', 'skipped_room_sources', violations.skipped_room_sources, 'skipped rooms imported message sources');
issue(issues, 'fail', 'source_count_mismatch', violations.source_count_mismatch, 'messages.source_count does not match message_sources');
issue(issues, 'fail', 'latest_room_dir_missing', violations.latest_room_dir_missing, 'message-bearing rooms point to missing latest_room_dir paths');
issue(issues, 'review', 'effective_review_queue_failed', effective.error ? 1 : 0, effective.error || 'effective review queue failed');
issue(issues, 'review', 'missing_translations', effective.missing_translations, 'visible messages without Korean translation');
issue(issues, 'review', 'unknown_text', counts.effective_unknown_text, 'visible text messages with unknown speakers after artifact filtering');
issue(issues, 'review', 'invalid_visible_speakers', counts.invalid_visible_speakers, 'visible sender candidates sanitized and requiring review');
issue(issues, 'review', 'low_confidence_text', counts.effective_low_confidence_text, 'visible low-confidence text OCR messages');
issue(issues, 'review', 'text_review', counts.effective_text_review, 'visible text messages below review confidence threshold');
issue(issues, 'review', 'attachment_or_media_review', counts.effective_non_text_review, 'visible attachment/media-card entries needing source review');
issue(issues, 'review', 'translation_risk', counts.effective_translation_risk, 'visible messages with translation risk notes');
issue(issues, 'review', 'emoji_review', counts.effective_emoji_review, 'visible messages with emoji rendering uncertainty');
issue(issues, 'review', 'quote_review', counts.effective_quote_review, 'visible messages with reply/quote preview uncertainty');
issue(issues, 'review', 'speaker_visual_review', counts.effective_speaker_visual_review, 'visible messages with sender-name visual uncertainty');
issue(issues, 'review', 'ocr_note_review', counts.effective_ocr_note_review, 'visible messages with OCR text uncertainty notes');
issue(issues, 'review', 'source_review', counts.effective_source_review, 'visible messages needing original screenshot/app review after specific causes are separated');
issue(issues, 'review', 'chat_rooms_without_audit', violations.chat_rooms_without_audit, 'chat rooms without room audit rows');

const failCount = issues.filter((item) => item.severity === 'fail').length;
const reviewCount = issues.filter((item) => item.severity === 'review').length;
const status = failCount ? 'fail' : (reviewCount ? 'review' : 'pass');
const output = {
  schema: 'wechat_db_validate.v1',
  generated_at: new Date().toISOString(),
  status,
  db: options.db,
  db_mtime: statSync(options.db).mtime.toISOString(),
  counts,
  violations,
  effective_review: effective,
  issues,
};

if (options.json) {
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} else {
  console.log(`WeChat DB validation: ${status.toUpperCase()}`);
  console.log(`DB: ${output.db}`);
  console.log(`Rooms/messages: ${counts.chat_rooms}/${counts.messages}, translated ${counts.translated}/${counts.messages}`);
  console.log(`Sources: ${counts.source_rows}, batches ${counts.batches}`);
  console.log(`Direct-like text Unknown: ${counts.direct_like_unknown_text}/${counts.direct_like_messages}`);
  console.log(`Group-like text Unknown: ${counts.group_like_unknown_text}/${counts.group_like_messages} raw, ${counts.effective_unknown_text} visible/actionable`);
  console.log(`Unknown split: text ${counts.unknown_text}, non-text ${counts.unknown_non_text}`);
  console.log(`Review flags: invalid speakers ${counts.invalid_visible_speakers}, low-confidence text ${counts.effective_low_confidence_text}, text review ${counts.effective_text_review}, media review ${counts.effective_non_text_review}, source review ${counts.effective_source_review}`);
  console.log(`Filtered artifacts: hidden ${counts.effective_hidden_artifacts}, visual duplicates ${counts.effective_visual_overlap_duplicates_removed}`);
  if (issues.length) {
    console.log('');
    console.log('Issues:');
    for (const item of issues) {
      console.log(`  - [${item.severity}] ${item.code}: ${item.count} ${item.message}`);
    }
  } else {
    console.log('');
    console.log('Issues: none');
  }
}

if (options.check && status !== 'pass') {
  process.exit(status === 'fail' ? 2 : 1);
}
