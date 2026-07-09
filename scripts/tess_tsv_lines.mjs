#!/usr/bin/env node
// Convert Tesseract TSV stdin into the {text,x,y,w,h}[] shape consumed by stitch.mjs.
// Groups word-level rows by block/paragraph/line and preserves left-to-right word order.
import { readFileSync } from 'node:fs';

let minConf = 15;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--min-conf') {
    minConf = Number(process.argv[++i] ?? minConf);
  } else if (process.argv[i].startsWith('--min-conf=')) {
    minConf = Number(process.argv[i].slice('--min-conf='.length));
  }
}
if (!Number.isFinite(minConf)) minConf = 15;

const raw = readFileSync(0, 'utf8').trim();
if (!raw) {
  console.log('[]');
  process.exit(0);
}

const rows = raw.split(/\r?\n/);
const header = rows.shift();
if (!header) {
  console.log('[]');
  process.exit(0);
}

const columns = header.split('\t');
const idx = Object.fromEntries(columns.map((name, i) => [name, i]));
const required = ['level', 'block_num', 'par_num', 'line_num', 'left', 'top', 'width', 'height', 'conf', 'text'];
for (const key of required) {
  if (!(key in idx)) {
    console.error(`missing TSV column: ${key}`);
    process.exit(2);
  }
}

const groups = new Map();
for (const row of rows) {
  const cells = row.split('\t');
  if (cells[idx.level] !== '5') continue;

  const text = (cells[idx.text] || '').trim();
  if (!text) continue;

  const conf = Number(cells[idx.conf] || -1);
  if (conf < minConf) continue;

  const left = Number(cells[idx.left]);
  const top = Number(cells[idx.top]);
  const width = Number(cells[idx.width]);
  const height = Number(cells[idx.height]);
  if (![left, top, width, height].every(Number.isFinite)) continue;

  const key = [cells[idx.block_num], cells[idx.par_num], cells[idx.line_num]].join(':');
  let group = groups.get(key);
  if (!group) {
    group = { words: [], x: left, y: top, r: left + width, b: top + height, confs: [] };
    groups.set(key, group);
  }

  group.words.push({ text, left, conf });
  group.confs.push(conf);
  group.x = Math.min(group.x, left);
  group.y = Math.min(group.y, top);
  group.r = Math.max(group.r, left + width);
  group.b = Math.max(group.b, top + height);
}

const out = [...groups.values()]
  .sort((a, b) => (a.y - b.y) || (a.x - b.x))
  .map((group) => {
    group.words.sort((a, b) => a.left - b.left);
    return {
      text: group.words.map((word) => word.text).join(' ').replace(/\s+/g, ' ').trim(),
      x: Math.round(group.x),
      y: Math.round(group.y),
      w: Math.round(group.r - group.x),
      h: Math.round(group.b - group.y),
      conf: Math.round(group.confs.reduce((sum, conf) => sum + conf, 0) / group.confs.length),
      min_conf: Math.round(Math.min(...group.confs)),
      words: group.words.length,
    };
  })
  .filter((line) => line.text.length > 1);

console.log(JSON.stringify(out));
