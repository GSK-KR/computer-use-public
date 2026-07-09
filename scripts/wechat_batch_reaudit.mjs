#!/usr/bin/env node
// Recompute a wechat_batch_manifest.json from per-room audit files.
// Keeps message text out of stdout; only status/metrics are summarized.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const cur = process.argv[i];
  if (cur.startsWith('--') && cur.includes('=')) {
    const [key, ...rest] = cur.slice(2).split('=');
    args.set(key, rest.join('='));
  } else if (cur.startsWith('--')) {
    args.set(cur.slice(2), process.argv[++i]);
  } else if (!args.has('dir')) {
    args.set('dir', cur);
  }
}

const dirArg = args.get('dir');
if (!dirArg) {
  console.error('usage: node scripts/wechat_batch_reaudit.mjs --dir <wechat_batch_dir>');
  process.exit(2);
}

const dir = resolve(dirArg);
const manifestPath = args.get('manifest') || join(dir, 'wechat_batch_manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`missing batch manifest: ${manifestPath}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const rooms = Array.isArray(manifest.rooms) ? manifest.rooms : [];
const seenTitles = new Set();

function titleKey(label) {
  return String(label || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

for (const room of rooms) {
  room.skip_reason = room.skip_reason ?? null;
  const key = titleKey(room.label);

  if (room.audit_status === 'skipped_duplicate_title') {
    if (key) seenTitles.add(key);
    continue;
  }

  if (key && seenTitles.has(key)) {
    room.scrape_status = 'skipped';
    room.audit_status = 'skipped_duplicate_title';
    room.skip_reason = 'selected room title was already processed';
    continue;
  }
  if (key) seenTitles.add(key);

  const auditPath = room.room_dir ? join(room.room_dir, 'wechat_audit.json') : '';
  const audit = auditPath ? readJson(auditPath) : null;
  if (!audit) {
    if (room.audit_status === 'skipped_non_chat' && room.scrape_status === 'skipped') {
      room.skip_reason = room.skip_reason || 'no usable message pane; likely service panel, blank pane, or non-chat row';
      continue;
    }
    if (room.scrape_status === 'skipped' && (!room.room_dir || !existsSync(room.room_dir))) {
      room.audit_status = 'skipped_duplicate_title';
      room.skip_reason = room.skip_reason || 'selected room title was already processed';
      continue;
    }
    room.audit_status = 'missing';
    room.skip_reason = null;
    continue;
  }

  const messages = Number(audit.metrics?.messages?.structured ?? 0);
  const rawLines = Number(audit.metrics?.ocr?.raw_lines ?? 0);
  const frames = Number(audit.metrics?.frames?.captured ?? 0);
  const looksLikeNonChatPane = frames <= 2 && (
    (messages <= 1 && rawLines <= 1) ||
    (messages === 0 && rawLines <= 5)
  );
  if (audit.status === 'fail' && looksLikeNonChatPane) {
    room.scrape_status = 'skipped';
    room.audit_status = 'skipped_non_chat';
    room.skip_reason = 'no usable message pane; likely service panel, blank pane, or non-chat row';
  } else {
    room.audit_status = audit.status || 'missing';
    if (room.scrape_status === 'skipped' && room.audit_status !== 'skipped_non_chat') room.scrape_status = 'ok';
    room.skip_reason = null;
  }
}

const stats = {
  ...(manifest.stats || {}),
  processed_rooms: rooms.length,
  pass: rooms.filter((room) => room.audit_status === 'pass').length,
  review: rooms.filter((room) => room.audit_status === 'review').length,
  skipped_non_chat: rooms.filter((room) => room.audit_status === 'skipped_non_chat').length,
  skipped_duplicate_title: rooms.filter((room) => room.audit_status === 'skipped_duplicate_title').length,
  fail_or_missing: rooms.filter((room) => !['pass', 'review', 'skipped_non_chat', 'skipped_duplicate_title'].includes(room.audit_status)).length,
};
manifest.stats = stats;
manifest.rooms = rooms;
manifest.reaudited_at = new Date().toISOString();

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`REAUDITED ${manifestPath}`);
console.log(`SUMMARY processed=${stats.processed_rooms} pass=${stats.pass} review=${stats.review} skipped_non_chat=${stats.skipped_non_chat} skipped_duplicate_title=${stats.skipped_duplicate_title} fail_or_missing=${stats.fail_or_missing}`);
