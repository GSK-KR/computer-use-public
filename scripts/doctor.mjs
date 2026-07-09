#!/usr/bin/env node
import { formatDoctor, runDoctor } from './lib/doctor.mjs';

const json = process.argv.includes('--json');
const full = process.argv.includes('--full');
const help = process.argv.includes('-h') || process.argv.includes('--help');

if (help) {
  console.log(`usage:
  node scripts/doctor.mjs [--json] [--full]

Runs local install/runtime checks without printing private chat contents.
Default text output shows beginner backup readiness. Use --full for advanced optional checks.`);
  process.exit(0);
}

const report = await runDoctor();
if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  process.stdout.write(formatDoctor(report, { full }));
}

process.exit(report.status === 'fail' ? 1 : 0);
