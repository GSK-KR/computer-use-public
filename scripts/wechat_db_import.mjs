#!/usr/bin/env node
// Import local WeChat OCR exports into a local SQLite database.
//
// This stores private chat text only in the requested local DB file. Console
// output is metrics-only unless SQLite itself fails.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const batchDirs = [];
const roomDirs = [];
const flags = new Set();
const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const cur = process.argv[i];
  if (cur === '--batch-dir') {
    batchDirs.push(process.argv[++i]);
  } else if (cur.startsWith('--batch-dir=')) {
    batchDirs.push(cur.slice('--batch-dir='.length));
  } else if (cur === '--dir' || cur === '--room-dir') {
    roomDirs.push(process.argv[++i]);
  } else if (cur.startsWith('--dir=')) {
    roomDirs.push(cur.slice('--dir='.length));
  } else if (cur.startsWith('--room-dir=')) {
    roomDirs.push(cur.slice('--room-dir='.length));
  } else if (cur.startsWith('--') && cur.includes('=')) {
    const [key, ...rest] = cur.slice(2).split('=');
    args.set(key, rest.join('='));
  } else if (cur.startsWith('--')) {
    const key = cur.slice(2);
    if (['json', 'stats'].includes(key)) {
      flags.add(key);
    } else {
      args.set(key, process.argv[++i]);
    }
  } else {
    batchDirs.push(cur);
  }
}

const dbArg = args.get('db');
if (!dbArg) {
  console.error('usage: node scripts/wechat_db_import.mjs --db <sqlite.db> [--batch-dir <dir> ...] [--dir <room-dir> ...] [--write-exclude <file>] [--stats] [--json]');
  process.exit(2);
}

const dbPath = resolve(dbArg);
const sqlite3 = process.env.SQLITE3 || 'sqlite3';
mkdirSync(dirname(dbPath), { recursive: true });

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function readJson(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function titleKey(label) {
  return String(label || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function sqlString(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/\u0000/g, '').replace(/'/g, "''")}'`;
}

function sqlNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : 'NULL';
}

function sqlBool(value) {
  if (value === null || value === undefined) return 'NULL';
  return value ? '1' : '0';
}

function runSql(sql, { capture = false } = {}) {
  const result = spawnSync(sqlite3, ['-batch', dbPath], {
    input: `.timeout 10000\n${sql}`,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `sqlite3 exited ${result.status}`).trim());
  }
  return capture ? result.stdout : '';
}

const schemaSql = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS batches (
  batch_dir TEXT PRIMARY KEY,
  created_at TEXT,
  imported_at TEXT NOT NULL,
  manifest_path TEXT NOT NULL,
  processed_rooms INTEGER,
  pass INTEGER,
  review INTEGER,
  skipped_non_chat INTEGER,
  skipped_duplicate_title INTEGER,
  fail_or_missing INTEGER
);

CREATE TABLE IF NOT EXISTS rooms (
  room_key TEXT PRIMARY KEY,
  label TEXT,
  label_key TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  latest_status TEXT,
  latest_room_dir TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_label_key ON rooms(label_key) WHERE label_key IS NOT NULL AND label_key != '';

CREATE TABLE IF NOT EXISTS batch_rooms (
  batch_dir TEXT NOT NULL,
  room_index INTEGER NOT NULL,
  room_key TEXT NOT NULL,
  label TEXT,
  list_label TEXT,
  audit_status TEXT,
  scrape_status TEXT,
  skip_reason TEXT,
  room_dir TEXT,
  PRIMARY KEY (batch_dir, room_index),
  FOREIGN KEY (batch_dir) REFERENCES batches(batch_dir),
  FOREIGN KEY (room_key) REFERENCES rooms(room_key)
);

CREATE TABLE IF NOT EXISTS room_audits (
  room_dir TEXT PRIMARY KEY,
  room_key TEXT NOT NULL,
  batch_dir TEXT NOT NULL,
  audit_status TEXT,
  frames INTEGER,
  max_frames INTEGER,
  messages INTEGER,
  unknown_speaker_messages INTEGER,
  low_confidence_messages INTEGER,
  non_text_messages INTEGER,
  ocr_artifacts_dropped INTEGER,
  elapsed_s REAL,
  seconds_per_message REAL,
  FOREIGN KEY (room_key) REFERENCES rooms(room_key),
  FOREIGN KEY (batch_dir) REFERENCES batches(batch_dir)
);

CREATE TABLE IF NOT EXISTS messages (
  message_key TEXT PRIMARY KEY,
  room_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  occurrence_index INTEGER NOT NULL,
  kind TEXT,
  speaker TEXT,
  speaker_source TEXT,
  side TEXT,
  text TEXT,
  translation_ko TEXT,
  translation_risk_note_ko TEXT,
  context_marker TEXT,
  conf REAL,
  requires_screenshot_review INTEGER,
  frame_first INTEGER,
  frame_last INTEGER,
  x REAL,
  y REAL,
  w REAL,
  h REAL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  source_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (room_key) REFERENCES rooms(room_key)
);

CREATE INDEX IF NOT EXISTS idx_messages_room_key ON messages(room_key);
CREATE INDEX IF NOT EXISTS idx_messages_fingerprint ON messages(fingerprint);

CREATE TABLE IF NOT EXISTS message_sources (
  source_key TEXT PRIMARY KEY,
  message_key TEXT NOT NULL,
  batch_dir TEXT NOT NULL,
  room_dir TEXT NOT NULL,
  source_message_id TEXT,
  imported_at TEXT NOT NULL,
  FOREIGN KEY (message_key) REFERENCES messages(message_key),
  FOREIGN KEY (batch_dir) REFERENCES batches(batch_dir)
);

CREATE INDEX IF NOT EXISTS idx_message_sources_message_key ON message_sources(message_key);
CREATE INDEX IF NOT EXISTS idx_message_sources_batch_dir ON message_sources(batch_dir);
`;

runSql(schemaSql);

function tableColumns(table) {
  const out = runSql(`.mode tabs\nPRAGMA table_info(${table});\n`, { capture: true }).trim();
  if (!out) return new Set();
  return new Set(out.split('\n').map((line) => line.split('\t')[1]).filter(Boolean));
}

const messageColumns = tableColumns('messages');
if (!messageColumns.has('translation_risk_note_ko')) {
  runSql('ALTER TABLE messages ADD COLUMN translation_risk_note_ko TEXT;');
}

function countRows(table) {
  const out = runSql(`SELECT COUNT(*) FROM ${table};\n`, { capture: true }).trim();
  return Number(out || 0);
}

function groupedCounts(table, column) {
  const out = runSql(`.mode tabs\nSELECT COALESCE(${column}, ''), COUNT(*) FROM ${table} GROUP BY ${column} ORDER BY ${column};\n`, { capture: true }).trim();
  const result = {};
  if (!out) return result;
  for (const line of out.split('\n')) {
    const [key, count] = line.split('\t');
    result[key || '(null)'] = Number(count || 0);
  }
  return result;
}

function dbStats() {
  return {
    db: dbPath,
    batches: countRows('batches'),
    rooms: countRows('rooms'),
    batch_rooms: countRows('batch_rooms'),
    messages: countRows('messages'),
    message_sources: countRows('message_sources'),
    rooms_by_status: groupedCounts('batch_rooms', 'audit_status'),
  };
}

const excludePath = args.get('write-exclude');
if (excludePath && batchDirs.length === 0 && roomDirs.length === 0 && !flags.has('stats')) {
  const out = runSql(`.mode list\nSELECT DISTINCT label FROM rooms WHERE label IS NOT NULL AND label != '' ORDER BY lower(label);\n`, { capture: true });
  mkdirSync(dirname(resolve(excludePath)), { recursive: true });
  writeFileSync(resolve(excludePath), out);
  if (flags.has('json')) {
    process.stdout.write(`${JSON.stringify({ db: dbPath, exclude_path: resolve(excludePath), labels: out.trim() ? out.trim().split('\n').length : 0 }, null, 2)}\n`);
  } else {
    console.log(`EXCLUDE_FILE=${resolve(excludePath)}`);
    console.log(`LABELS=${out.trim() ? out.trim().split('\n').length : 0}`);
  }
  process.exit(0);
}

function roomKeyFor(label, fallback) {
  const key = titleKey(label);
  return hash(key ? `title:${key}` : `fallback:${fallback || ''}`);
}

function messageFingerprint(message) {
  const parts = [
    message.kind || '',
    message.speaker || '',
    message.speaker_source || '',
    message.side || '',
    normalizeText(message.text),
    normalizeText(message.context_marker),
  ];
  return hash(parts.join('\u0000'));
}

function sourceMessageId(message, fallback) {
  if (message.id === null || message.id === undefined || message.id === '') return fallback;
  return message.id;
}

function importBatchManifest(batchDirArg, manifestPath, manifest) {
  const batchDir = resolve(batchDirArg);
  const importedAt = nowIso();
  const beforeMessages = countRows('messages');
  const beforeSources = countRows('message_sources');
  const batchDirValue = manifest.output_dir || batchDir;
  const stats = manifest.stats || {};
  const sql = [];
  let roomCount = 0;
  let attemptedMessages = 0;

  sql.push('BEGIN;');
  sql.push(`INSERT INTO batches (
    batch_dir, created_at, imported_at, manifest_path, processed_rooms, pass, review,
    skipped_non_chat, skipped_duplicate_title, fail_or_missing
  ) VALUES (
    ${sqlString(batchDirValue)}, ${sqlString(manifest.created_at || null)}, ${sqlString(importedAt)}, ${sqlString(manifestPath)},
    ${sqlNumber(stats.processed_rooms)}, ${sqlNumber(stats.pass)}, ${sqlNumber(stats.review)},
    ${sqlNumber(stats.skipped_non_chat)}, ${sqlNumber(stats.skipped_duplicate_title)}, ${sqlNumber(stats.fail_or_missing)}
  )
  ON CONFLICT(batch_dir) DO UPDATE SET
    imported_at=excluded.imported_at,
    manifest_path=excluded.manifest_path,
    processed_rooms=excluded.processed_rooms,
    pass=excluded.pass,
    review=excluded.review,
    skipped_non_chat=excluded.skipped_non_chat,
    skipped_duplicate_title=excluded.skipped_duplicate_title,
    fail_or_missing=excluded.fail_or_missing;`);

  sql.push('DROP TABLE IF EXISTS temp.affected_message_keys;');
  sql.push('CREATE TEMP TABLE affected_message_keys(message_key TEXT PRIMARY KEY);');
  sql.push(`INSERT OR IGNORE INTO affected_message_keys(message_key)
    SELECT message_key FROM message_sources WHERE batch_dir=${sqlString(batchDirValue)};`);
  sql.push(`DELETE FROM message_sources WHERE batch_dir=${sqlString(batchDirValue)};`);
  sql.push(`DELETE FROM room_audits WHERE batch_dir=${sqlString(batchDirValue)};`);
  sql.push(`DELETE FROM batch_rooms WHERE batch_dir=${sqlString(batchDirValue)};`);

  for (const room of Array.isArray(manifest.rooms) ? manifest.rooms : []) {
    roomCount += 1;
    const label = room.label || room.room_label || room.list_label || '';
    const labelKey = titleKey(label);
    const roomKey = roomKeyFor(label, room.room_dir || `${batchDirValue}:${room.index}`);
    const auditPath = room.room_dir ? join(room.room_dir, 'wechat_audit.json') : '';
    const messagesPath = room.room_dir ? join(room.room_dir, 'wechat_messages.json') : '';
    const audit = readJson(auditPath);
    const messagesDoc = readJson(messagesPath);
    const auditMetrics = audit?.metrics || {};
    const auditMessages = auditMetrics.messages || {};
    const auditFrames = auditMetrics.frames || {};
    const timings = auditMetrics.timings || {};

    sql.push(`INSERT INTO rooms (
      room_key, label, label_key, first_seen_at, last_seen_at, latest_status, latest_room_dir
    ) VALUES (
      ${sqlString(roomKey)}, ${sqlString(label)}, ${sqlString(labelKey)}, ${sqlString(importedAt)}, ${sqlString(importedAt)},
      ${sqlString(room.audit_status || null)}, ${sqlString(room.room_dir || null)}
    )
    ON CONFLICT(room_key) DO UPDATE SET
      label=excluded.label,
      label_key=excluded.label_key,
      last_seen_at=excluded.last_seen_at,
      latest_status=CASE
        WHEN excluded.latest_status IN ('pass', 'review') THEN excluded.latest_status
        ELSE rooms.latest_status
      END,
      latest_room_dir=CASE
        WHEN excluded.latest_status IN ('pass', 'review') AND excluded.latest_room_dir IS NOT NULL AND excluded.latest_room_dir != '' THEN excluded.latest_room_dir
        ELSE rooms.latest_room_dir
      END;`);

    sql.push(`INSERT OR REPLACE INTO batch_rooms (
      batch_dir, room_index, room_key, label, list_label, audit_status, scrape_status, skip_reason, room_dir
    ) VALUES (
      ${sqlString(batchDirValue)}, ${sqlNumber(room.index)}, ${sqlString(roomKey)}, ${sqlString(label)},
      ${sqlString(room.list_label || null)}, ${sqlString(room.audit_status || null)}, ${sqlString(room.scrape_status || null)},
      ${sqlString(room.skip_reason || null)}, ${sqlString(room.room_dir || null)}
    );`);

    if (room.room_dir && audit) {
      sql.push(`INSERT OR REPLACE INTO room_audits (
        room_dir, room_key, batch_dir, audit_status, frames, max_frames, messages,
        unknown_speaker_messages, low_confidence_messages, non_text_messages,
        ocr_artifacts_dropped, elapsed_s, seconds_per_message
      ) VALUES (
        ${sqlString(room.room_dir)}, ${sqlString(roomKey)}, ${sqlString(batchDirValue)}, ${sqlString(audit.status || room.audit_status || null)},
        ${sqlNumber(auditFrames.captured)}, ${sqlNumber(auditFrames.max_frames)}, ${sqlNumber(auditMessages.structured)},
        ${sqlNumber(auditMessages.unknown_speaker_messages)}, ${sqlNumber(auditMessages.low_confidence_messages)},
        ${sqlNumber(auditMessages.non_text_messages)}, ${sqlNumber(auditMessages.ocr_artifacts_dropped)},
        ${sqlNumber(timings.total_elapsed_s)}, ${sqlNumber(timings.seconds_per_message)}
      );`);
    }

    const shouldImportMessages = room.audit_status === 'pass' || room.audit_status === 'review';
    const seenFingerprints = new Map();
    for (const message of shouldImportMessages && Array.isArray(messagesDoc?.messages) ? messagesDoc.messages : []) {
      attemptedMessages += 1;
      const fp = messageFingerprint(message);
      const occurrence = (seenFingerprints.get(fp) || 0) + 1;
      seenFingerprints.set(fp, occurrence);
      const messageKey = hash([roomKey, fp, occurrence].join('\u0000'));
      const sourceId = sourceMessageId(message, attemptedMessages);
      const sourceKey = hash([batchDirValue, room.room_dir || '', sourceId].join('\u0000'));
      sql.push(`INSERT INTO messages (
        message_key, room_key, fingerprint, occurrence_index, kind, speaker, speaker_source, side,
        text, translation_ko, translation_risk_note_ko, context_marker, conf, requires_screenshot_review,
        frame_first, frame_last, x, y, w, h, first_seen_at, last_seen_at
      ) VALUES (
        ${sqlString(messageKey)}, ${sqlString(roomKey)}, ${sqlString(fp)}, ${sqlNumber(occurrence)},
        ${sqlString(message.kind || null)}, ${sqlString(message.speaker || null)}, ${sqlString(message.speaker_source || null)},
        ${sqlString(message.side || null)}, ${sqlString(message.text || null)}, ${sqlString(message.translation_ko || null)},
        ${sqlString(message.translation_risk_note_ko || null)}, ${sqlString(message.context_marker || null)}, ${sqlNumber(message.conf)}, ${sqlBool(message.requires_screenshot_review)},
        ${sqlNumber(message.frame_first)}, ${sqlNumber(message.frame_last)}, ${sqlNumber(message.x)}, ${sqlNumber(message.y)},
        ${sqlNumber(message.w)}, ${sqlNumber(message.h)}, ${sqlString(importedAt)}, ${sqlString(importedAt)}
      )
      ON CONFLICT(message_key) DO UPDATE SET
        kind=excluded.kind,
        speaker=excluded.speaker,
        speaker_source=excluded.speaker_source,
        side=excluded.side,
        text=excluded.text,
        translation_ko=excluded.translation_ko,
        translation_risk_note_ko=excluded.translation_risk_note_ko,
        context_marker=excluded.context_marker,
        conf=excluded.conf,
        requires_screenshot_review=excluded.requires_screenshot_review,
        frame_first=excluded.frame_first,
        frame_last=excluded.frame_last,
        x=excluded.x,
        y=excluded.y,
        w=excluded.w,
        h=excluded.h,
        last_seen_at=excluded.last_seen_at;`);
      sql.push(`INSERT OR IGNORE INTO message_sources (
        source_key, message_key, batch_dir, room_dir, source_message_id, imported_at
      ) VALUES (
        ${sqlString(sourceKey)}, ${sqlString(messageKey)}, ${sqlString(batchDirValue)}, ${sqlString(room.room_dir || '')},
        ${sqlString(sourceId)}, ${sqlString(importedAt)}
      );`);
    }
  }

  sql.push(`INSERT OR IGNORE INTO affected_message_keys(message_key)
    SELECT message_key FROM message_sources WHERE batch_dir=${sqlString(batchDirValue)};`);
  sql.push(`UPDATE messages SET
    last_seen_at=${sqlString(importedAt)},
    source_count=(SELECT COUNT(*) FROM message_sources WHERE message_sources.message_key=messages.message_key)
  WHERE message_key IN (SELECT message_key FROM affected_message_keys);`);
  sql.push('DELETE FROM messages WHERE source_count = 0 AND message_key IN (SELECT message_key FROM affected_message_keys);');
  sql.push('DROP TABLE IF EXISTS temp.affected_message_keys;');
  sql.push('COMMIT;');
  runSql(sql.join('\n'));

  return {
    batch_dir: batchDirValue,
    rooms_seen: roomCount,
    message_rows_seen: attemptedMessages,
    new_messages: countRows('messages') - beforeMessages,
    new_message_sources: countRows('message_sources') - beforeSources,
  };
}

function importBatch(batchDirArg) {
  const batchDir = resolve(batchDirArg);
  const manifestPath = join(batchDir, 'wechat_batch_manifest.json');
  const manifest = readJson(manifestPath);
  if (!manifest) {
    throw new Error(`missing or invalid batch manifest: ${manifestPath}`);
  }
  return importBatchManifest(batchDir, manifestPath, manifest);
}

function importRoom(roomDirArg) {
  const roomDir = resolve(roomDirArg);
  const manifestPath = join(roomDir, 'wechat_scrape_manifest.json');
  const manifest = readJson(manifestPath) || {};
  const audit = readJson(join(roomDir, 'wechat_audit.json')) || {};
  const messagesDoc = readJson(join(roomDir, 'wechat_messages.json')) || {};
  const label = manifest.room_label || messagesDoc.room || basename(roomDir);
  const status = audit.status || manifest.quality?.status || (Array.isArray(messagesDoc.messages) && messagesDoc.messages.length ? 'review' : 'fail');
  const stats = {
    processed_rooms: 1,
    pass: status === 'pass' ? 1 : 0,
    review: status === 'review' ? 1 : 0,
    skipped_non_chat: status === 'skip' ? 1 : 0,
    skipped_duplicate_title: 0,
    fail_or_missing: status === 'fail' ? 1 : 0,
  };
  return importBatchManifest(roomDir, manifestPath, {
    schema: 'wechat_single_room_import.v1',
    output_dir: roomDir,
    created_at: manifest.generated_at || manifest.created_at || null,
    stats,
    rooms: [{
      index: 0,
      label,
      room_label: label,
      list_label: label,
      audit_status: status,
      scrape_status: manifest.status || status,
      skip_reason: null,
      room_dir: roomDir,
    }],
  });
}

const imports = [];
for (const batchDir of batchDirs) {
  imports.push(importBatch(batchDir));
}
for (const roomDir of roomDirs) {
  imports.push(importRoom(roomDir));
}

if (excludePath) {
  const out = runSql(`.mode list\nSELECT DISTINCT label FROM rooms WHERE label IS NOT NULL AND label != '' ORDER BY lower(label);\n`, { capture: true });
  mkdirSync(dirname(resolve(excludePath)), { recursive: true });
  writeFileSync(resolve(excludePath), out);
}

const result = {
  db: dbPath,
  imports,
  stats: dbStats(),
  exclude_path: excludePath ? resolve(excludePath) : null,
};

if (flags.has('json')) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else if (flags.has('stats') && imports.length === 0) {
  console.log(JSON.stringify(result.stats, null, 2));
} else {
  console.log(`DB=${dbPath}`);
  for (const item of imports) {
    console.log(`IMPORTED batch=${item.batch_dir} rooms=${item.rooms_seen} message_rows=${item.message_rows_seen} new_messages=${item.new_messages} new_sources=${item.new_message_sources}`);
  }
  console.log(`STATS batches=${result.stats.batches} rooms=${result.stats.rooms} messages=${result.stats.messages} message_sources=${result.stats.message_sources}`);
  if (excludePath) console.log(`EXCLUDE_FILE=${resolve(excludePath)}`);
}
