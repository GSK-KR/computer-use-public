#!/usr/bin/env node
// Extract visible WeChat room-row click candidates from OCR lines over the left list.
// The output is intentionally small: label + window-relative click coordinates.
import { readFileSync } from 'node:fs';

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const cur = process.argv[i];
  if (cur.startsWith('--') && cur.includes('=')) {
    const [key, ...rest] = cur.slice(2).split('=');
    args.set(key, rest.join('='));
  } else if (cur.startsWith('--')) {
    const next = process.argv[i + 1];
    if (!next || next.startsWith('--')) {
      args.set(cur.slice(2), true);
    } else {
      args.set(cur.slice(2), next);
      i++;
    }
  } else if (!args.has('json')) {
    args.set('json', cur);
  }
}

const jsonPath = args.get('json');
const crop = args.get('crop') || '560x1200+0+100';
const maxRooms = Number(args.get('max-rooms') || 30);
const minY = Number(args.get('min-y') || 30);
const rowGap = Number(args.get('row-gap') || 120);
const absoluteCoords = args.has('absolute-coords') && args.get('absolute-coords') !== 'false';

if (!jsonPath) {
  console.error('usage: node wechat_rooms_from_ocr.mjs --json <list_ocr.json> --crop WxH+X+Y [--max-rooms N]');
  process.exit(2);
}

const cropMatch = crop.match(/^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/);
if (!cropMatch) {
  console.error(`invalid crop: ${crop}`);
  process.exit(2);
}
const cropWidth = Number(cropMatch[1]);
const cropHeight = Number(cropMatch[2]);
const cropX = Number(cropMatch[3]);
const cropY = Number(cropMatch[4]);

let lines = [];
try {
  lines = JSON.parse(readFileSync(jsonPath, 'utf8'));
} catch (err) {
  console.error(`failed to read ${jsonPath}: ${err.message}`);
  process.exit(1);
}
if (!Array.isArray(lines)) lines = [];

const clean = (text) => String(text || '')
  .replace(/\s+/g, ' ')
  .replace(/^[\s:：|·,，.。]+|[\s:：|·,，.。]+$/gu, '')
  .trim();
const cleanLabel = (text) => clean(text)
  .replace(/([\p{Script=Han}\p{Script=Hangul}])\s+(?=[\p{Script=Han}\p{Script=Hangul}])/gu, '$1')
  .replace(/\b(?:Today|Yesterday|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b.*$/iu, '')
  .replace(/\b(?:今天|昨天|前天|오늘|어제)\b.*$/u, '')
  .replace(/\b\d{1,2}:\d{2}.*$/u, '')
  .replace(/\b\d{1,2}[./-]\d{1,2}.*$/u, '')
  .replace(/\s+/g, ' ')
  .trim();
const norm = (text) => clean(text).replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
const charLen = (text) => [...clean(text).replace(/\s+/g, '')].length;

function isUiOrPreview(text) {
  const t = clean(text);
  if (!t) return true;
  if (/^(WeChat|微信|Chats?|Contacts?|Discover|Me|Search|검색)$/iu.test(t)) return true;
  if (/^(今天|昨天|前天|오전|오후|오늘|어제)$/u.test(t)) return true;
  if (/^\d{1,2}:\d{2}$/.test(t)) return true;
  if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/i.test(t)) return true;
  if (/^[0-9]+$/.test(t)) return true;
  if (/^\d+(?:\.\d+)?[KMG]$/i.test(t)) return true;
  if (/^(new message|draft|typing)/i.test(t)) return true;
  return false;
}

const usable = lines
  .filter((line) => line && typeof line.text === 'string')
  .map((line) => {
    const rawX = Number(line.x) || 0;
    const rawY = Number(line.y) || 0;
    const w = Number(line.w) || 0;
    const h = Number(line.h) || 0;
    return {
      text: clean(line.text),
      x: absoluteCoords ? rawX - cropX : rawX,
      y: absoluteCoords ? rawY - cropY : rawY,
      w,
      h,
      raw_x: rawX,
      raw_y: rawY,
      conf: Number.isFinite(Number(line.conf)) ? Number(line.conf) : null,
    };
  })
  .filter((line) => line.x <= cropWidth && line.x + line.w >= 0 && line.y <= cropHeight && line.y + line.h >= 0)
  .filter((line) => line.text && line.y >= minY && line.y <= cropHeight - 20)
  .filter((line) => !isUiOrPreview(line.text))
  .filter((line) => !(line.x < 80 && charLen(line.text) <= 3))
  .filter((line) => line.x >= 35 && line.x <= cropWidth * 0.88)
  .sort((a, b) => (a.y - b.y) || (a.x - b.x));

const clusters = [];
for (const line of usable) {
  const cy = line.y + line.h / 2;
  let cluster = clusters.find((item) => Math.abs(item.anchorCy - cy) <= rowGap / 2);
  if (!cluster) {
    cluster = { cy, anchorCy: cy, minCy: cy, maxCy: cy, lines: [] };
    clusters.push(cluster);
  }
  cluster.lines.push(line);
  cluster.cy = cluster.lines.reduce((sum, item) => sum + item.y + item.h / 2, 0) / cluster.lines.length;
  cluster.minCy = Math.min(cluster.minCy, cy);
  cluster.maxCy = Math.max(cluster.maxCy, cy);
}

function lineScore(line) {
  let score = 0;
  const len = charLen(line.text);
  if (line.x >= 65 && line.x <= cropWidth * 0.70) score += 30;
  if (len >= 2 && len <= 28) score += 25;
  if (/[\p{Script=Han}\p{Script=Hangul}A-Za-z]/u.test(line.text)) score += 20;
  if (line.conf !== null) score += Math.max(0, Math.min(20, Math.round(line.conf / 5)));
  if (/\b(?:Today|Yesterday|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b|\b\d{1,2}:\d{2}\b|(?:今天|昨天|前天|오늘|어제)/iu.test(line.text)) score -= 12;
  if (/\[(?:File|Image|Video|Voice)\]/i.test(line.text)) score -= 25;
  if (/[。.!?？！]$/.test(line.text)) score -= 20;
  if (/https?:\/\//i.test(line.text)) score -= 30;
  return score;
}

const seen = new Set();
const rooms = [];
for (const cluster of clusters.sort((a, b) => a.cy - b.cy)) {
  const sorted = [...cluster.lines].sort((a, b) => lineScore(b) - lineScore(a));
  const labelLine = sorted[0];
  if (!labelLine) continue;
  const label = cleanLabel(labelLine.text) || clean(labelLine.text);
  const key = norm(label);
  if (!key || key.length < 2 || seen.has(key)) continue;
  seen.add(key);
  const clusterTop = Math.min(...cluster.lines.map((line) => line.y));
  const clusterBottom = Math.max(...cluster.lines.map((line) => line.y + line.h));
  const clickY = Math.round(cropY + Math.max(cluster.cy, clusterTop + 24, Math.min(clusterBottom + 20, cropHeight - 20)));
  rooms.push({
    label,
    confidence: labelLine.conf,
    source: {
      x: labelLine.x,
      y: labelLine.y,
      w: labelLine.w,
      h: labelLine.h,
      raw_x: absoluteCoords ? labelLine.raw_x : null,
      raw_y: absoluteCoords ? labelLine.raw_y : null,
      cluster_lines: cluster.lines.length,
    },
    click_x: Math.round(cropX + Math.min(Math.max(180, cropWidth * 0.42), cropWidth - 80)),
    click_y: clickY,
  });
  if (rooms.length >= maxRooms) break;
}

process.stdout.write(`${JSON.stringify({
  schema: 'wechat_room_candidates.v1',
  crop,
  coordinates: absoluteCoords ? 'absolute-window' : 'crop-relative',
  rooms,
}, null, 2)}\n`);
