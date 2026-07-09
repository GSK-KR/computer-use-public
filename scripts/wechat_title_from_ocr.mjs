#!/usr/bin/env node
// Pick the active WeChat room title from OCR lines over the right-pane header.
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
if (!jsonPath) {
  console.error('usage: node wechat_title_from_ocr.mjs --json <header_ocr.json> [--region WxH+X+Y --absolute-coords]');
  process.exit(2);
}
const region = args.get('region') || '';
const absoluteCoords = args.has('absolute-coords') && args.get('absolute-coords') !== 'false';
let regionSpec = null;
if (region) {
  const match = String(region).match(/^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/u);
  if (!match) {
    console.error(`invalid region: ${region}`);
    process.exit(2);
  }
  regionSpec = {
    width: Number(match[1]),
    height: Number(match[2]),
    x: Number(match[3]),
    y: Number(match[4]),
  };
}

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
  .replace(/([\p{Script=Han}\p{Script=Hangul}])\s+(?=[\p{Script=Han}\p{Script=Hangul}])/gu, '$1')
  .replace(/\s+(?:Or|Qr|O)\s*[&|._<>-].*$/iu, '')
  .replace(/[\s<>&|._-]+$/gu, '')
  .trim();
const charLen = (text) => [...clean(text).replace(/\s+/g, '')].length;

function badTitle(text) {
  const t = clean(text);
  if (!t) return true;
  if (charLen(t) < 2 || charLen(t) > 60) return true;
  if (/^(WeChat|微信|Chats?|Contacts?|Search|검색)$/iu.test(t)) return true;
  if (/^(发送|按住说话|表情|메시지 입력)$/u.test(t)) return true;
  if (/^\d{1,2}:\d{2}$/.test(t)) return true;
  if (/^\d+(?:\.\d+)?[KMG]$/i.test(t)) return true;
  if (/^[\p{P}\p{S}\p{Number}\s]+$/u.test(t)) return true;
  return false;
}

function score(line) {
  const text = clean(line.text);
  let s = 0;
  const len = charLen(text);
  if (line.y <= 90) s += 30;
  if (line.x <= 500) s += 20;
  if (len >= 2 && len <= 36) s += 20;
  if (/[\p{Script=Han}\p{Script=Hangul}A-Za-z0-9]/u.test(text)) s += 20;
  if (Number.isFinite(Number(line.conf))) s += Math.max(0, Math.min(20, Math.round(Number(line.conf) / 5)));
  if (/[。.!?？！]$/.test(text)) s -= 15;
  if (/https?:\/\//i.test(text)) s -= 30;
  return s;
}

const candidates = lines
  .filter((line) => line && typeof line.text === 'string')
  .map((line) => {
    const rawX = Number(line.x) || 0;
    const rawY = Number(line.y) || 0;
    const w = Number(line.w) || 0;
    const h = Number(line.h) || 0;
    return {
      text: clean(line.text),
      x: absoluteCoords && regionSpec ? rawX - regionSpec.x : rawX,
      y: absoluteCoords && regionSpec ? rawY - regionSpec.y : rawY,
      w,
      h,
      raw_x: rawX,
      raw_y: rawY,
      conf: Number.isFinite(Number(line.conf)) ? Number(line.conf) : null,
    };
  })
  .filter((line) => !regionSpec || (
    line.x <= regionSpec.width &&
    line.x + line.w >= 0 &&
    line.y <= regionSpec.height &&
    line.y + line.h >= 0
  ))
  .filter((line) => !badTitle(line.text))
  .sort((a, b) => score(b) - score(a));

const title = candidates[0]?.text || '';
process.stdout.write(`${JSON.stringify({
  title,
  region: region || null,
  coordinates: absoluteCoords ? 'absolute-window' : 'region-relative',
  candidates: candidates.slice(0, 5),
}, null, 2)}\n`);
