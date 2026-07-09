// ============================================================================
// stitch.mjs <scrapeDir> — fuzzy-stitch per-frame OCR JSON into a transcript.
//   Reads frame_*.json ({text,x,y,w,h}[]) oldest->newest (reverse filename),
//   Y-sorts each, drops UI chrome, and fuzzy-dedups overlap between adjacent
//   frames (Levenshtein over a recent window) so legitimate far-apart repeats
//   (e.g. "완료입니다") survive while scroll-overlap duplicates are merged.
//   Prints transcript to stdout (UTF-8).
// ============================================================================
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) { console.error('usage: node stitch.mjs <scrapeDir>'); process.exit(1); }

const DEDUP_WINDOW = 60;   // only merge near-dups within the recent overlap region
const SIM_THRESHOLD = 0.82;

const norm = (s) => s.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}
const sim = (a, b) => { const m = Math.max(a.length, b.length); return m ? 1 - lev(a, b) / m : 1; };

const CHROME = [/환영합니다/, /메시지 입력/, /Q 9/, /오픈[재채]팅방/];
const isChrome = (s) =>
  s.length < 3 ||
  CHROME.some((r) => r.test(s)) ||
  /^[\s\d口十㉭OCO€Ⅲ:.,]+$/u.test(s);

const files = readdirSync(dir).filter((f) => /^frame_\d+\.json$/.test(f)).sort().reverse();

// Pass 1: load frames + count how many frames each normalized line appears in.
//   Fixed chrome (room-name header, pinned banner, search box) shows up in ~every frame;
//   a real message only appears in the few frames it scrolls through. So a high
//   frame-frequency key is chrome and gets dropped — generic, no per-app hardcoding.
const parsed = [];
const frameCount = new Map();
for (const f of files) {
  let arr;
  try { arr = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
  if (!Array.isArray(arr)) continue;
  arr.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  parsed.push(arr);
  const inFrame = new Set();
  for (const it of arr) { const k = norm((it.text || '').trim()); if (k.length >= 2) inFrame.add(k); }
  for (const k of inFrame) frameCount.set(k, (frameCount.get(k) || 0) + 1);
}
const CHROME_FRAC = 0.5;
const chromeFreq = Math.max(4, Math.ceil(parsed.length * CHROME_FRAC));  // appears in >=half the frames -> fixed UI

// Pass 2: emit in chronological order, dropping chrome + scroll-overlap fuzzy dups.
const seenKeys = [];   // normalized keys, in output order
const out = [];
for (const arr of parsed) {
  for (const it of arr) {
    const t = (it.text || '').trim();
    if (isChrome(t)) continue;
    const k = norm(t);
    if (k.length < 2) continue;
    if ((frameCount.get(k) || 0) >= chromeFreq) continue;   // fixed across frames = chrome
    let dup = false;
    for (let i = seenKeys.length - 1; i >= 0 && i >= seenKeys.length - DEDUP_WINDOW; i--) {
      if (sim(k, seenKeys[i]) >= SIM_THRESHOLD) { dup = true; break; }
    }
    if (dup) continue;
    seenKeys.push(k);
    out.push(t);
  }
}
process.stdout.write(out.join('\n') + '\n');
