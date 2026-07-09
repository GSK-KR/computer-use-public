#!/usr/bin/env node
// Detect KakaoTalk open-chat message comment/reply entry points from OCR lines.
//
// This is intentionally conservative: it only marks short UI-like labels such
// as "댓글 3" / "답글 2개" / "3개의 댓글". Message text that merely contains
// the word "댓글" in a sentence is ignored.
import { existsSync, readFileSync } from 'node:fs';

const args = new Map();
const flags = new Set();
for (let i = 2; i < process.argv.length; i++) {
  const cur = process.argv[i];
  if (cur.startsWith('--') && cur.includes('=')) {
    const [key, ...rest] = cur.slice(2).split('=');
    args.set(key, rest.join('='));
  } else if (cur.startsWith('--')) {
    const key = cur.slice(2);
    if (['json'].includes(key)) flags.add(key);
    else args.set(key, process.argv[++i]);
  }
}

const ocrPath = args.get('ocr') || args.get('json') || process.argv[2];
if (!ocrPath || !existsSync(ocrPath)) {
  console.error('usage: node scripts/kakao_openchat_threads.mjs --ocr frame.json [--frame-index N --window-width W --window-height H]');
  process.exit(2);
}

const frameIndex = Number(args.get('frame-index') || 0);
const windowWidth = Number(args.get('window-width') || 0);
const windowHeight = Number(args.get('window-height') || 0);
const minY = Number(args.get('min-y') || Math.max(72, Math.floor(windowHeight * 0.08)));
const maxY = Number(args.get('max-y') || (windowHeight ? Math.floor(windowHeight * 0.92) : 99999));

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function norm(text) {
  return String(text || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

function cleanText(text) {
  return String(text || '')
    .replace(/[|｜]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function markerInfo(rawText) {
  const text = cleanText(rawText);
  const compact = text.replace(/\s+/g, '');
  if (!text || text.length > 18) return null;

  const patterns = [
    { re: /^(댓글|답글|대댓글)\s*[:：]?\s*(\d{1,4})?\s*(개)?$/u, type: 'comment_label' },
    { re: /^(\d{1,4})\s*(개의?)?\s*(댓글|답글|대댓글)$/u, type: 'comment_count' },
    { re: /^(댓글|답글|대댓글)\s*(보기|열기)$/u, type: 'comment_open' },
    { re: /^(\d{1,4})\s*$/u, type: 'bare_count' },
  ];

  for (const p of patterns) {
    const match = text.match(p.re) || compact.match(p.re);
    if (!match) continue;
    if (p.type === 'bare_count') return null;
    return {
      type: p.type,
      text,
      count: Number((match.find((v) => /^\d+$/.test(String(v || ''))) || 0)) || null,
      confidence: p.type === 'comment_count' ? 0.82 : 0.9,
    };
  }

  if (/^(댓글|답글|대댓글)\s*\d{1,4}/u.test(text) && text.length <= 12) {
    return { type: 'comment_label_prefix', text, count: Number(text.match(/\d+/)?.[0] || 0) || null, confidence: 0.78 };
  }

  // Kakao's small comment icon is often OCR'd as a stray Korean/quote symbol:
  // e.g. "나 댓글 5", "“댓글 1 91 €". Keep this short-label only so normal
  // sentences like "댓글 달아주세요" are not treated as buttons.
  const noisyLabel = text.match(/(?:^|[^\p{L}\p{N}])(댓글|답글|대댓글)\s*(\d{1,4})/u)
    || compact.match(/(?:^|[^\p{L}\p{N}])(댓글|답글|대댓글)(\d{1,4})/u);
  if (noisyLabel && text.length <= 16) {
    return {
      type: 'comment_label_noisy',
      text,
      count: Number(noisyLabel[2] || 0) || null,
      confidence: 0.74,
    };
  }

  return null;
}

function center(line) {
  return {
    x: Number(line.x || 0) + Number(line.w || 0) / 2,
    y: Number(line.y || 0) + Number(line.h || 0) / 2,
  };
}

function clickPoint(line, info) {
  const w = Number(line.w || 0);
  const h = Number(line.h || 0);
  if (info.type === 'comment_label_noisy') {
    return {
      x: Math.round(Number(line.x || 0) + Math.min(w / 2, 46)),
      y: Math.round(Number(line.y || 0) + h / 2),
    };
  }
  return {
    x: Math.round(Number(line.x || 0) + w / 2),
    y: Math.round(Number(line.y || 0) + h / 2),
  };
}

function parentAnchor(lines, marker) {
  const markerCenter = center(marker);
  const nearby = lines
    .filter((line) => line !== marker)
    .filter((line) => {
      const t = cleanText(line.text);
      if (!t || markerInfo(t)) return false;
      if (line.y >= marker.y + marker.h + 16) return false;
      if (line.y < marker.y - 260) return false;
      const c = center(line);
      const sameColumn = Math.abs(c.x - markerCenter.x) < Math.max(220, windowWidth * 0.28);
      const broadChat = !windowWidth || (c.x > windowWidth * 0.18 && c.x < windowWidth * 0.96);
      return sameColumn || broadChat;
    })
    .sort((a, b) => (a.y - b.y) || (a.x - b.x))
    .slice(-4)
    .map((line) => cleanText(line.text));
  return nearby.join(' / ');
}

function detect(lines) {
  const sorted = [...lines]
    .filter((line) => line && typeof line.text === 'string')
    .map((line) => ({
      text: cleanText(line.text),
      x: Number(line.x || 0),
      y: Number(line.y || 0),
      w: Number(line.w || 0),
      h: Number(line.h || 0),
    }))
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));

  const candidates = [];
  for (const line of sorted) {
    if (line.y < minY || line.y > maxY) continue;
    const info = markerInfo(line.text);
    if (!info) continue;
    const anchor = parentAnchor(sorted, line);
    const click = clickPoint(line, info);
    const anchorKey = norm(anchor).slice(-100);
    const keyParts = anchorKey
      ? ['kakao-thread', anchorKey, norm(info.text)]
      : ['kakao-thread', norm(info.text), Math.round(line.y / 24), Math.round(line.x / 40)];
    candidates.push({
      frame_index: frameIndex,
      marker_text: info.text,
      marker_type: info.type,
      count: info.count,
      confidence: info.confidence,
      x: line.x,
      y: line.y,
      w: line.w,
      h: line.h,
      click_x: click.x,
      click_y: click.y,
      parent_anchor: anchor,
      dedupe_key: keyParts.join(':'),
    });
  }
  return candidates;
}

const lines = readJson(ocrPath);
const candidates = detect(Array.isArray(lines) ? lines : []);
process.stdout.write(`${JSON.stringify({
  schema: 'kakao_openchat_thread_candidates.v1',
  frame_index: frameIndex,
  ocr_path: ocrPath,
  window: { width: windowWidth || null, height: windowHeight || null },
  candidates,
}, null, 2)}\n`);
