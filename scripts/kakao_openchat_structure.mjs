#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildKakaoOpenchatMessages } from './lib/kakao_openchat_structure_core.mjs';

const args = {
  dir: '',
  write: false,
  json: false,
  check: false,
};

for (let i = 2; i < process.argv.length; i++) {
  const cur = process.argv[i];
  if (cur === '--dir') args.dir = process.argv[++i];
  else if (cur.startsWith('--dir=')) args.dir = cur.slice('--dir='.length);
  else if (cur === '--write') args.write = true;
  else if (cur === '--json') args.json = true;
  else if (cur === '--check') args.check = true;
  else if (cur === '-h' || cur === '--help') usage(0);
  else if (!args.dir) args.dir = cur;
  else {
    console.error(`unknown option: ${cur}`);
    usage(2);
  }
}

function usage(code) {
  console.error(`usage:
  node scripts/kakao_openchat_structure.mjs DIR [--write] [--json] [--check]

Creates or previews kakao_openchat_messages.json by grouping OCR lines into
message-like bubbles and removing scroll-overlap duplicates.`);
  process.exit(code);
}

if (!args.dir) usage(2);
const dir = resolve(args.dir);
if (!existsSync(dir)) {
  console.error(`missing dir: ${dir}`);
  process.exit(2);
}

const doc = buildKakaoOpenchatMessages(dir, { write: args.write });
const summary = {
  schema: 'kakao_openchat_structure.summary.v1',
  dir,
  wrote: args.write,
  provider: doc.provider,
  stats: doc.stats,
};

if (args.json) {
  process.stdout.write(`${JSON.stringify(args.write ? summary : doc, null, 2)}\n`);
} else {
  console.log(`KAKAO_OPENCHAT_STRUCTURE provider=${doc.provider}`);
  console.log(`MESSAGES=${doc.stats.messages}`);
  console.log(`MAIN_CANDIDATES=${doc.stats.main_candidates}`);
  console.log(`THREAD_CANDIDATES=${doc.stats.thread_candidates}`);
  console.log(`DUPLICATES_REMOVED=${doc.stats.duplicates_removed}`);
  console.log(`UNKNOWN=${doc.stats.unknown_speaker_messages}`);
}

if (args.check && (!doc.stats.messages || doc.stats.unknown_speaker_messages > doc.stats.messages * 0.6)) {
  process.exit(1);
}
