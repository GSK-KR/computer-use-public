#!/usr/bin/env node
// Extract visible KakaoTalk room-row click candidates from Windows OCR lines.
// Output coordinates are window-relative physical pixels so the Windows click
// helper can select each row without typing into KakaoTalk.
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
const crop = args.get('crop') || '520x900+0+80';
const maxRooms = Number(args.get('max-rooms') || 30);
const minY = Number(args.get('min-y') || 20);
const rowGap = Number(args.get('row-gap') || 92);
const absoluteCoords = args.has('absolute-coords') && args.get('absolute-coords') !== 'false';

if (!jsonPath) {
  console.error('usage: node kakao_rooms_from_ocr.mjs --json <list_ocr.json> --crop WxH+X+Y [--max-rooms N]');
  process.exit(2);
}

const cropMatch = crop.match(/^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/u);
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
  .replace(/\s+/gu, ' ')
  .replace(/^[\s:：|·,，.。]+|[\s:：|·,，.。]+$/gu, '')
  .trim();
const cleanLabel = (text) => clean(text)
  .replace(/\b(?:오전|오후)\s*\d{1,2}\s*[:：]\s*\d{2}.*$/u, '')
  .replace(/\b\d{1,2}\s*[:：]\s*\d{2}.*$/u, '')
  .replace(/\b(?:오늘|어제|그제)\b.*$/u, '')
  .replace(/\b(?:월|화|수|목|금|토|일)요일\b.*$/u, '')
  .replace(/\b\d{1,4}[./-]\d{1,2}(?:[./-]\d{1,2})?.*$/u, '')
  .replace(/\s+/gu, ' ')
  .trim();
const norm = (text) => clean(text).replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
const charLen = (text) => [...clean(text).replace(/\s+/gu, '')].length;

function isTimestampOrDate(text) {
  const t = clean(text);
  return /^(오전|오후)\s*\d{1,2}\s*[:：]\s*\d{2}$/u.test(t) ||
    /^\d{1,2}\s*[:：]\s*\d{2}$/u.test(t) ||
    /^(오늘|어제|그제)$/u.test(t) ||
    /^(월|화|수|목|금|토|일)요일$/u.test(t) ||
    /^\d{1,4}[./-]\d{1,2}(?:[./-]\d{1,2})?$/u.test(t);
}

function isUiOrPreview(text, line = {}) {
  const t = clean(text);
  const x = Number(line.x || 0);
  if (!t) return true;
  if (isTimestampOrDate(t)) return true;
  if (/^(카카오톡|KakaoTalk|친구|채팅|오픈채팅|쇼핑|더보기|검색|설정|프로필|내\s*프로필|톡서랍|톡캘린더|전체|채널|뷰|게임|지갑)$/iu.test(t)) return true;
  if (/^(말풍선|대화|채팅방|읽음|안읽음|알림|메뉴|편집|새로운 채팅|새 채팅)$/u.test(t)) return true;
  if (/^(광고|추천|업데이트|공지|이벤트|카카오프렌즈)$/u.test(t)) return true;
  if (/^(사진|동영상|이모티콘|파일|보이스톡|페이스톡|지도|연락처)$/u.test(t)) return true;
  if (/^\d+$/u.test(t)) return true;
  if (/^[(){}\[\]<>+\-_=~.,:;|/\\'"!?]+$/u.test(t)) return true;
  if (x < 48 && charLen(t) <= 4) return true;
  return false;
}

function lineLooksLikePreview(text) {
  const t = clean(text);
  if (/^(사진|동영상|이모티콘|파일|투표|일정|송금|선물|지도|연락처)(?:\s|$)/u.test(t)) return true;
  if (/^(나|저|me)\s*:/iu.test(t)) return true;
  if (/^https?:\/\//iu.test(t)) return true;
  if (/[.?!。？！…]$/u.test(t) && charLen(t) > 10) return true;
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
  .filter((line) => line.text && line.y >= minY && line.y <= cropHeight - 18)
  .filter((line) => !isUiOrPreview(line.text, line))
  .filter((line) => line.x >= 45 && line.x <= cropWidth * 0.92)
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

function lineScore(line, cluster) {
  let score = 0;
  const len = charLen(line.text);
  const clusterTop = Math.min(...cluster.lines.map((item) => item.y));
  if (line.x >= 64 && line.x <= cropWidth * 0.76) score += 30;
  if (len >= 2 && len <= 30) score += 26;
  if (/[\p{Script=Hangul}\p{Script=Han}A-Za-z0-9]/u.test(line.text)) score += 18;
  if (line.y <= clusterTop + 26) score += 16;
  if (line.conf !== null) score += Math.max(0, Math.min(18, Math.round(line.conf / 6)));
  if (lineLooksLikePreview(line.text)) score -= 28;
  if (charLen(line.text) > 42) score -= 24;
  if (line.x > cropWidth * 0.78) score -= 22;
  if (isTimestampOrDate(line.text)) score -= 40;
  return score;
}

const seen = new Set();
const rooms = [];
for (const cluster of clusters.sort((a, b) => a.cy - b.cy)) {
  const sorted = [...cluster.lines].sort((a, b) => lineScore(b, cluster) - lineScore(a, cluster));
  const labelLine = sorted[0];
  if (!labelLine) continue;
  const label = cleanLabel(labelLine.text) || clean(labelLine.text);
  const key = norm(label);
  if (!key || key.length < 2 || seen.has(key)) continue;
  seen.add(key);
  const clusterTop = Math.min(...cluster.lines.map((line) => line.y));
  const clusterBottom = Math.max(...cluster.lines.map((line) => line.y + line.h));
  const clickY = Math.round(cropY + Math.max(cluster.cy, clusterTop + 22, Math.min(clusterBottom + 18, cropHeight - 18)));
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
    click_x: Math.round(cropX + Math.min(Math.max(150, cropWidth * 0.44), cropWidth - 55)),
    click_y: clickY,
  });
  if (rooms.length >= maxRooms) break;
}

process.stdout.write(`${JSON.stringify({
  schema: 'kakao_room_candidates.v1',
  crop,
  coordinates: absoluteCoords ? 'absolute-window' : 'crop-relative',
  rooms,
}, null, 2)}\n`);
