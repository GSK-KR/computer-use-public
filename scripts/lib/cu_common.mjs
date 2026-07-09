import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { dirname, join, resolve, relative, sep, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i];
    if (cur.startsWith('--') && cur.includes('=')) {
      const [key, ...rest] = cur.slice(2).split('=');
      setArg(args, key, rest.join('='));
    } else if (cur.startsWith('--')) {
      const key = cur.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        setArg(args, key, true);
      } else {
        setArg(args, key, next);
        i++;
      }
    } else {
      args._.push(cur);
    }
  }
  return args;
}

function setArg(args, key, value) {
  if (args[key] === undefined) {
    args[key] = value;
  } else if (Array.isArray(args[key])) {
    args[key].push(value);
  } else {
    args[key] = [args[key], value];
  }
}

export function asArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function timestamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function isoNow() {
  return new Date().toISOString();
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureParent(file) {
  mkdirSync(dirname(file), { recursive: true });
  return file;
}

export function defaultRunDir(pack, base = 'runs') {
  return resolve(`${base}/${pack}_${timestamp()}`);
}

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw err;
  }
}

export function writeJson(file, value) {
  ensureParent(file);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function appendJsonl(file, value) {
  ensureParent(file);
  appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

export function run(cmd, args = [], opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    windowsHide: true,
    ...opts,
  });
  return {
    cmd,
    args,
    status: res.status,
    signal: res.signal,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    ok: res.status === 0,
    error: res.error,
  };
}

export function sha256File(file) {
  const hash = createHash('sha256');
  hash.update(readFileSync(file));
  return hash.digest('hex');
}

export function safeStat(file) {
  try {
    return statSync(file);
  } catch {
    return null;
  }
}

export function listFilesRecursive(root, opts = {}) {
  const out = [];
  const rootAbs = resolve(root);
  const stack = [rootAbs];
  const maxEntries = Number(opts.maxEntries || 200000);
  while (stack.length) {
    if (out.length > maxEntries) throw new Error(`too many files under ${rootAbs}`);
    const cur = stack.pop();
    let st;
    try { st = statSync(cur); } catch { continue; }
    if (st.isSymbolicLink?.()) continue;
    if (st.isDirectory()) {
      let entries = [];
      try { entries = readdirSync(cur); } catch { continue; }
      for (const entry of entries) stack.push(join(cur, entry));
    } else if (st.isFile()) {
      out.push(cur);
    }
  }
  return out.sort();
}

export function isPathInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !rel.includes(`..${sep}`) && !isAbsolute(rel));
}

export function assertInside(child, parent, label = 'path') {
  if (!isPathInside(child, parent)) throw new Error(`${label} outside allowed root: ${child}`);
}

export function sanitizeFileName(name) {
  const cleaned = String(name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .replace(/^[. ]+/g, '')
    .trim();
  return (cleaned || 'unnamed').slice(0, 180);
}

export function classifyStatus(issues) {
  if (issues.some((it) => it.severity === 'fail')) return 'FAIL';
  if (issues.some((it) => it.severity === 'review')) return 'REVIEW';
  if (issues.some((it) => it.severity === 'skip')) return 'SKIP';
  return 'PASS';
}

export function makeManifest(pack, mode, inputs = {}, options = {}) {
  return {
    schema: `${pack}.run.v1`,
    pack,
    mode,
    started_at: isoNow(),
    ended_at: null,
    status: 'RUNNING',
    inputs,
    options,
    counts: {},
    warnings: [],
    errors: [],
    artifacts: {},
  };
}

export function finishManifest(manifest, status, counts = {}, artifacts = {}) {
  manifest.ended_at = isoNow();
  manifest.status = status;
  manifest.counts = { ...(manifest.counts || {}), ...counts };
  manifest.artifacts = { ...(manifest.artifacts || {}), ...artifacts };
  return manifest;
}

export function parseCsv(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let rowNo = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push({ rowNo, values: row });
      row = [];
      field = '';
      rowNo++;
    } else if (ch === '\r') {
      // Ignore CR. LF handles row finalization.
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push({ rowNo, values: row });
  }
  return rows;
}

export function toCsv(rows) {
  return rows.map((row) => row.map((v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n') + '\n';
}

export function readTextFile(file) {
  const buf = readFileSync(file);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString('utf8');
  }
  return buf.toString('utf8');
}

export function failUsage(message, usage) {
  console.error(message);
  if (usage) console.error(usage);
  process.exit(2);
}

export function printSummary(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

export function commandExists(cmd) {
  const res = run('bash', ['-lc', `command -v ${JSON.stringify(cmd)} >/dev/null 2>&1`]);
  return res.ok;
}

export function repoRootFromScript(importMetaUrl) {
  const here = dirname(new URL(importMetaUrl).pathname);
  return resolve(here, '..');
}

export function pathForDisplay(file) {
  return file.replace(process.cwd(), '.');
}
