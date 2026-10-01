#!/usr/bin/env node
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  appendJsonl,
  classifyStatus,
  defaultRunDir,
  ensureDir,
  finishManifest,
  makeManifest,
  parseArgs,
  printSummary,
  readJson,
  writeJson,
  toCsv,
  isoNow,
} from './lib/cu_common.mjs';
import { loadPathConfig, wslPathToWindows } from './lib/path_config.mjs';
import { runWebAction } from './lib/web_client.mjs';

const args = parseArgs();
const cmd = args._[0] || 'help';
const pathConfig = loadPathConfig();

function usage() {
  console.log(`usage:
  node scripts/browser_workflow.mjs doctor
  node scripts/browser_workflow.mjs pages
  node scripts/browser_workflow.mjs login-check --recipe FILE --out DIR
  node scripts/browser_workflow.mjs scrape --recipe FILE --out DIR
  node scripts/browser_workflow.mjs run --recipe FILE --out DIR [--confirm-browser-write]
  node scripts/browser_workflow.mjs audit DIR [--check]`);
}

// 화면이나 데이터를 바꾸는 단계. 쓰기 레시피와 --confirm-browser-write가 모두 있어야 실행한다.
const WRITE_STEPS = new Set(['type', 'setValue', 'select', 'pick', 'check', 'uncheck', 'upload', 'click', 'clickSubmit', 'press', 'dismiss', 'download', 'script']);

function rejectBroadDomains(domains) {
  if (!Array.isArray(domains) || domains.length === 0) throw new Error('recipe allowed_domains must be non-empty');
  for (const d of domains) {
    const v = String(d || '').trim().toLowerCase();
    if (!v || v === '*' || v === 'com' || v === '*.com' || !v.includes('.')) {
      throw new Error(`broad/invalid allowed domain rejected: ${d}`);
    }
  }
}

function urlAllowed(url, domains) {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  return domains.some((d) => {
    const v = String(d).toLowerCase();
    if (v.startsWith('*.')) return host.endsWith(v.slice(1)) && host !== v.slice(2);
    return host === v || host.endsWith(`.${v}`);
  });
}

function loadRecipe(file) {
  const recipe = readJson(file);
  if (recipe.schema !== 'browser.recipe.v1') throw new Error('recipe schema must be browser.recipe.v1');
  rejectBroadDomains(recipe.allowed_domains);
  if (!recipe.start_url) throw new Error('recipe start_url is required');
  if (!urlAllowed(recipe.start_url, recipe.allowed_domains)) throw new Error(`start_url outside allowed_domains: ${recipe.start_url}`);
  if (!Array.isArray(recipe.steps)) recipe.steps = [];
  if (!Array.isArray(recipe.extract)) recipe.extract = [];
  return recipe;
}

async function fetchPage(url) {
  const res = await fetch(url);
  const text = await res.text();
  return {
    url: res.url,
    status: res.status,
    ok: res.ok,
    title: (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim(),
    html: text,
    text: htmlToText(text),
  };
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTables(html) {
  const tables = [];
  for (const tableMatch of html.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    const tableHtml = tableMatch[0];
    const rows = [];
    for (const rowMatch of tableHtml.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
      const rowHtml = rowMatch[0];
      const cells = [];
      for (const cellMatch of rowHtml.matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)) {
        cells.push(htmlToText(cellMatch[1]));
      }
      if (cells.length) rows.push(cells);
    }
    tables.push(rows);
  }
  return tables;
}

function redactStep(step) {
  const clean = { ...step };
  if (clean.sensitive) {
    if ('value' in clean) clean.value = '[REDACTED]';
    if ('text' in clean) clean.text = '[REDACTED]';
  }
  return clean;
}

// Windows Chrome 러너 호출(cu_web.ps1). Windows 네이티브·WSL 모두 같은 요청 파일 방식을 쓴다.
function cdpCall(action, positional, options = {}, { url = '', profile = '', timeoutMs = 300000 } = {}) {
  const request = { action, arg1: positional[0] ?? '', arg2: positional[1] ?? '', options: { ...options } };
  if (positional.length > 2) request.options.rest = positional.slice(2);
  if (url) request.url = url;
  if (profile) request.profile = profile;
  return runWebAction(request, { timeoutMs, config: pathConfig });
}

// 레시피 단계의 snake_case 옵션을 러너 옵션으로 옮긴다.
function stepOptions(step) {
  const map = {
    frame: 'frame', label: 'label', nth: 'nth', exact: 'exact', within: 'within', dialog: 'dialog',
    confirm_dialog: 'confirmDialog', modal_confirm: 'modalConfirm', modal_button: 'modalButton',
    expect_gone: 'expectGone', expect_url: 'expectUrl', idem_key: 'idemKey', mode: 'mode',
    require_empty: 'requireEmpty', numeric: 'numeric', counter: 'counter', via: 'via', timeout: 'timeout',
    identity: 'identity', until_url: 'untilUrl', count: 'count', state: 'state', force: 'force',
  };
  const options = {};
  for (const [from, to] of Object.entries(map)) if (step[from] !== undefined) options[to] = step[from];
  if (step.expect?.text) options.expect = step.expect.text;
  return options;
}

function cdpFilePath(file) {
  if (process.platform === 'win32' || !String(file || '').startsWith('/')) return file;
  return wslPathToWindows(file);
}

async function executeRecipe(recipeFile, mode) {
  const recipe = loadRecipe(recipeFile);
  const driver = args.driver || recipe.driver || 'static';
  const profile = args.profile || recipe.profile || '';
  let cdpTarget = new URL(recipe.start_url).hostname;
  // cdp('동작', 인자..., {옵션})
  const cdp = (action, ...argv) => {
    const options = argv.length && argv.at(-1) && typeof argv.at(-1) === 'object' ? argv.pop() : {};
    return cdpCall(action, argv, options, { url: cdpTarget, profile, timeoutMs: action === 'handoff' ? Number(options.timeout || 600000) + 120000 : 300000 });
  };
  const outDir = resolve(args.out || defaultRunDir('browser', 'shots'));
  ensureDir(outDir);
  ensureDir(join(outDir, 'extracted'));
  ensureDir(join(outDir, 'screenshots'));
  const issues = [];
  const manifest = makeManifest('browser', mode, { recipe: recipeFile }, { mode: recipe.mode || 'read_only', driver });
  writeJson(join(outDir, 'recipe.json'), recipe);
  let page;
  if (driver === 'cdp') {
    const goto = cdp('goto', recipe.start_url);
    if (!goto.ok) issues.push({ severity: 'fail', message: `cdp goto failed: ${goto.stderr || goto.stdout}` });
    const read = cdp('read');
    page = { url: read.parsed?.url || recipe.start_url, status: goto.ok ? 200 : 500, ok: goto.ok, title: read.parsed?.title || '', html: '', text: read.parsed?.text || read.stdout || '' };
    cdpTarget = new URL(page.url).hostname;
  } else {
    page = await fetchPage(recipe.start_url);
  }
  writeJson(join(outDir, 'pages.json'), [{ url: page.url, status: page.status, title: page.title }]);
  if (!page.ok) issues.push({ severity: 'fail', message: `start_url returned HTTP ${page.status}` });
  if (!urlAllowed(page.url, recipe.allowed_domains)) issues.push({ severity: 'fail', message: `final URL outside allowlist: ${page.url}` });

  for (const step of recipe.steps) {
    const safeStep = redactStep(step);
    let ok = true;
    let message = '';
    const opts = stepOptions(step);
    if (WRITE_STEPS.has(step.action)) {
      if (!args['confirm-browser-write'] || recipe.mode === 'read_only') {
        ok = false;
        message = `write action rejected without explicit non-read-only recipe and --confirm-browser-write: ${step.id || step.action}`;
        issues.push({ severity: 'fail', message });
      } else if (driver !== 'cdp') {
        ok = false;
        message = `write action requires --driver cdp: ${step.id || step.action}`;
        issues.push({ severity: 'fail', message });
      } else {
        let r = null;
        if (step.action === 'type') r = cdp('type', step.selector || '', step.value || '', opts);
        else if (step.action === 'setValue') r = cdp('setvalue', step.selector || '', step.value || '', opts);
        else if (step.action === 'select') r = cdp('select', step.selector || '', step.value || step.text || '', opts);
        else if (step.action === 'pick') r = cdp('pick', step.selector || '', step.value || step.text || '', opts);
        else if (step.action === 'check') r = cdp('check', step.selector || '', opts);
        else if (step.action === 'uncheck') r = cdp('uncheck', step.selector || '', opts);
        else if (step.action === 'upload') r = cdp('upload', step.selector || '', ...[].concat(step.value || step.files || []).map(cdpFilePath), opts);
        else if (step.action === 'press') r = cdp('press', step.key || step.text || '', { ...opts, ...(step.selector ? { selector: step.selector } : {}) });
        else if (step.action === 'dismiss') r = cdp('dismiss', opts);
        else if (step.action === 'download') {
          const target = cdpFilePath(join(outDir, 'downloads', step.out || `${step.id || 'download'}`));
          r = cdp('download', step.url || '', { ...opts, ...(step.selector ? { click: step.selector } : {}), ...(step.text ? { clicktext: step.text } : {}), out: target });
        } else if (step.action === 'script') {
          r = cdp('script', cdpFilePath(resolve(dirname(recipeFile), step.file || '')), ...(step.args || []).map(String), { ...opts, write: step.writes !== false });
        } else if (step.action === 'click') {
          if (!step.selector && !step.text) r = { ok: false, parsed: { error: 'click requires selector or text' } };
          else r = step.selector ? cdp('click', step.selector, opts) : cdp('clicktext', step.text, opts);
        } else if (step.action === 'clickSubmit') {
          const validation = cdp('validate', step.selector || '', { frame: opts.frame });
          if (!validation.ok || validation.parsed?.ok === false) {
            const invalidCount = Number(validation.parsed?.invalid?.length || 0);
            const maxlengthCount = Number(validation.parsed?.maxlength?.length || 0);
            r = { ok: false, parsed: { error: `submit blocked by live form validation: invalid=${invalidCount}, maxlength=${maxlengthCount}` } };
          } else {
            r = cdp('click', step.selector || '', opts);
          }
        }
        ok = Boolean(r?.ok) && r?.parsed?.ok !== false;
        if (ok && r.parsed?.url) {
          try {
            page.url = r.parsed.url;
            cdpTarget = new URL(page.url).hostname;
          } catch {}
        }
        message = ok ? `cdp ${step.action} ok${r.parsed?.outcome ? ` (${r.parsed.outcome})` : ''}` : `cdp ${step.action} failed: ${r?.parsed?.error || r?.stderr || r?.stdout || ''}`.slice(0, 600);
        if (!ok) issues.push({ severity: 'fail', message });
        else if (r.parsed?.outcome === 'unknown') issues.push({ severity: 'review', message: `${step.id || step.action}: 결과 불명 — ${r.parsed.hint || '반영 여부를 다시 확인하세요'}` });
      }
    } else if (step.action === 'goto') {
      if (!urlAllowed(step.url || recipe.start_url, recipe.allowed_domains)) {
        ok = false;
        message = `goto outside allowlist: ${step.url}`;
        issues.push({ severity: 'fail', message });
      } else if (driver === 'cdp') {
        const r = cdp('goto', step.url || recipe.start_url);
        ok = r.ok;
        message = r.ok ? 'cdp goto ok' : `cdp goto failed: ${r.stderr || r.stdout}`;
        if (ok) {
          page.url = r.parsed?.url || step.url || recipe.start_url;
          cdpTarget = new URL(page.url).hostname;
        }
        if (!ok) issues.push({ severity: 'fail', message });
      } else {
        page = await fetchPage(step.url || recipe.start_url);
        ok = page.ok;
        message = ok ? 'static goto ok' : `static goto failed: HTTP ${page.status}`;
        if (!ok) issues.push({ severity: 'fail', message });
      }
    } else if (step.action === 'reload') {
      if (driver === 'cdp') {
        const r = cdp('reload');
        ok = r.ok;
        if (ok && r.parsed?.url) {
          page.url = r.parsed.url;
          cdpTarget = new URL(page.url).hostname;
        }
        message = ok ? 'cdp reload ok' : `cdp reload failed: ${r.stderr || r.stdout}`;
      } else {
        page = await fetchPage(page.url);
        ok = page.ok;
        message = ok ? 'static reload ok' : `static reload failed: HTTP ${page.status}`;
      }
      if (!ok) issues.push({ severity: 'fail', message });
    } else if (step.action === 'hover' || step.action === 'scroll' || step.action === 'waitSelector') {
      if (driver !== 'cdp') {
        ok = false;
        message = `${step.action} requires --driver cdp`;
      } else {
        const r = step.action === 'hover'
          ? (step.selector ? cdp('hover', step.selector, opts) : cdp('hover', { ...opts, text: step.text || '' }))
          : (step.action === 'scroll'
            ? cdp('scroll', step.direction || 'down', { ...opts, ...(step.selector ? { selector: step.selector } : {}), ...(step.until_text ? { untilText: step.until_text } : {}) })
            : cdp('waitsel', step.selector || '', opts));
        ok = r.ok;
        message = ok ? `cdp ${step.action} ok` : `cdp ${step.action} failed: ${r.parsed?.error || r.stderr || r.stdout}`.slice(0, 600);
      }
      if (!ok) issues.push({ severity: 'fail', message });
    } else if (step.action === 'session' || step.action === 'handoff') {
      if (driver !== 'cdp') {
        ok = false;
        message = `${step.action} requires --driver cdp`;
      } else if (step.action === 'session') {
        const r = cdp('session', step.identity || '', opts);
        const status = r.parsed?.status || 'UNKNOWN';
        ok = step.identity ? status === 'LOGGED_IN' : status !== 'LOGIN_WALL';
        message = ok ? `session ${status}` : `session not ready: ${status}. 사람이 로그인한 뒤 handoff 단계로 이어서 진행합니다.`;
      } else {
        const r = cdp('handoff', step.reason || '', { ...opts, timeout: Number(step.timeout || 600000) });
        ok = r.ok;
        message = ok ? `handoff done after ${r.parsed?.waitedMs ?? 0}ms` : `handoff failed: ${r.parsed?.error || r.stderr || r.stdout}`.slice(0, 600);
      }
      if (!ok) issues.push({ severity: 'fail', message });
    } else if (step.action === 'validate') {
      if (driver === 'cdp') {
        const r = cdp('validate', step.selector || '');
        ok = r.ok && r.parsed?.ok !== false;
        message = ok ? 'live form validation ok' : `live form validation failed: ${r.stderr || r.stdout}`;
      } else {
        ok = false;
        message = 'validate requires --driver cdp';
      }
      if (!ok) issues.push({ severity: 'fail', message });
    } else if (step.action === 'identify') {
      if (driver === 'cdp') {
        const r = cdp('identify', step.text || 'Computer-Use 작업 창');
        ok = r.ok;
        message = ok ? 'target browser window identified' : `identify failed: ${r.stderr || r.stdout}`;
      } else {
        message = 'identify skipped by static driver';
      }
      if (!ok) issues.push({ severity: 'review', message });
    } else if (step.action === 'assertText') {
      if (driver === 'cdp') {
        const r = cdp('assert', step.text || '');
        ok = r.ok;
      } else {
        ok = page.text.includes(step.text || '');
      }
      if (!ok) {
        message = `assertText missing: ${step.id || step.text}`;
        issues.push({ severity: 'fail', message });
      }
    } else if (step.action === 'assertTextAny') {
      if (driver === 'cdp') {
        ok = (step.texts || []).some((t) => cdp('assert', t).ok);
      } else {
        ok = (step.texts || []).some((t) => page.text.includes(t));
      }
      if (!ok) {
        message = `assertTextAny missing: ${step.id || ''}`;
        issues.push({ severity: 'review', message });
      }
    } else if (step.action === 'waitText') {
      ok = driver === 'cdp' ? cdp('waittext', step.text || '').ok : page.text.includes(step.text || '');
      if (!ok) {
        message = `waitText missing: ${step.id || step.text}`;
        issues.push({ severity: 'fail', message });
      }
    } else if (step.action === 'screenshot') {
      if (driver === 'cdp') {
        const shotPath = join(outDir, 'screenshots', `${step.id || 'page'}.png`);
        const r = cdp('shot', cdpFilePath(shotPath));
        ok = r.ok;
        message = r.ok ? `screenshot saved: ${shotPath}` : `screenshot failed: ${r.stderr || r.stdout}`;
        if (!ok) issues.push({ severity: 'review', message });
      } else {
        writeFileSync(join(outDir, 'screenshots', `${step.id || 'page'}.html`), page.html, 'utf8');
        message = 'static runner saved HTML evidence instead of bitmap screenshot';
      }
    } else if (!['extractText', 'extractTable', 'extractLinks'].includes(step.action)) {
      issues.push({ severity: 'review', message: `unsupported read-only action skipped: ${step.action}` });
      ok = false;
    }
    if (ok && !urlAllowed(page.url, recipe.allowed_domains)) {
      ok = false;
      message = `step ended outside allowlist: ${page.url}`;
      issues.push({ severity: 'fail', message });
    }
    if (ok && step.expect?.text) {
      const verified = driver === 'cdp' ? cdp('assert', step.expect.text).ok : page.text.includes(step.expect.text);
      if (!verified) {
        ok = false;
        message = `step expectation failed: ${step.expect.text}`;
        issues.push({ severity: 'fail', message });
      }
    }
    appendJsonl(join(outDir, 'steps.jsonl'), { ts: isoNow(), step: safeStep, ok, message, url: page.url, allowlist_match: urlAllowed(page.url, recipe.allowed_domains) });
  }

  if (driver === 'cdp') {
    const current = cdp('read');
    if (current.ok && current.parsed?.ok !== false) {
      page.url = current.parsed?.url || page.url;
      page.title = current.parsed?.title || page.title;
      page.text = current.parsed?.text || '';
      cdpTarget = new URL(page.url).hostname;
      if (!urlAllowed(page.url, recipe.allowed_domains)) issues.push({ severity: 'fail', message: `extraction page outside allowlist: ${page.url}` });
    } else {
      issues.push({ severity: 'fail', message: `failed to refresh page before extraction: ${current.stderr || current.stdout}` });
    }
  }

  const extracted = {};
  for (const ex of recipe.extract) {
    if (ex.type === 'text') {
      let text = page.text;
      if (driver === 'cdp' && ex.selector) {
        const code = `(() => { const el = document.querySelector(${JSON.stringify(ex.selector)}); return el ? el.innerText : ''; })()`;
        const r = cdp('eval', code);
        text = r.parsed?.result || '';
      }
      extracted[ex.id] = text;
      writeFileSync(join(outDir, 'extracted', `${ex.id}.txt`), text, 'utf8');
    } else if (ex.type === 'table') {
      if (driver === 'cdp') {
        const code = `(() => {
          const table = document.querySelector(${JSON.stringify(ex.selector || 'table')});
          if (!table) return [];
          return Array.from(table.rows).map(row => Array.from(row.cells).map(cell => cell.innerText.trim()));
        })()`;
        const r = cdp('eval', code);
        const table = Array.isArray(r.parsed?.result) ? r.parsed.result : [];
        extracted[ex.id] = table;
        writeJson(join(outDir, 'extracted', `${ex.id}.json`), table);
        writeFileSync(join(outDir, 'extracted', `${ex.id}.csv`), toCsv(table), 'utf8');
        if (ex.expect_nonzero && table.length === 0) issues.push({ severity: 'review', message: `extracted table has zero rows: ${ex.id}` });
        continue;
      }
      const table = extractTables(page.html)[0] || [];
      extracted[ex.id] = table;
      writeJson(join(outDir, 'extracted', `${ex.id}.json`), table);
      writeFileSync(join(outDir, 'extracted', `${ex.id}.csv`), toCsv(table), 'utf8');
      if (ex.expect_nonzero && table.length === 0) issues.push({ severity: 'review', message: `extracted table has zero rows: ${ex.id}` });
    } else if (ex.type === 'fetch') {
      if (driver !== 'cdp') {
        issues.push({ severity: 'fail', message: `fetch extract requires --driver cdp: ${ex.id}` });
        continue;
      }
      const absolute = new URL(ex.url || '', page.url).href;
      if (!urlAllowed(absolute, recipe.allowed_domains)) {
        issues.push({ severity: 'fail', message: `fetch extract outside allowlist: ${ex.id}` });
        continue;
      }
      const r = cdp('fetch', absolute, { out: cdpFilePath(join(outDir, 'extracted', `${ex.id}.response.json`)) });
      extracted[ex.id] = r.parsed?.json ?? null;
      writeJson(join(outDir, 'extracted', `${ex.id}.json`), extracted[ex.id]);
      if (!r.ok || r.parsed?.loginSuspected) issues.push({ severity: 'fail', message: `fetch extract failed or login required: ${ex.id} (HTTP ${r.parsed?.status ?? '?'})` });
      continue;
    } else if (ex.type === 'collect') {
      if (driver !== 'cdp') {
        issues.push({ severity: 'fail', message: `collect extract requires --driver cdp: ${ex.id}` });
        continue;
      }
      const fieldList = Object.entries(ex.fields || {}).map(([name, spec]) => `${name}=${spec}`);
      const r = cdp('collect', ex.item || '', { field: fieldList, ...(ex.key ? { key: ex.key } : {}), ...(ex.container ? { selector: ex.container } : {}), maxSteps: Number(ex.max_steps || 40), out: cdpFilePath(join(outDir, 'extracted', `${ex.id}.json`)) });
      extracted[ex.id] = { count: r.parsed?.count ?? 0, reachedEnd: r.parsed?.reachedEnd ?? false };
      if (!r.ok) issues.push({ severity: 'fail', message: `collect extract failed: ${ex.id}: ${r.parsed?.error || r.stderr}`.slice(0, 400) });
      else if (ex.expect_nonzero && !r.parsed?.count) issues.push({ severity: 'review', message: `collected zero items: ${ex.id}` });
      else if (!r.parsed?.reachedEnd) issues.push({ severity: 'review', message: `collect stopped before list end: ${ex.id}` });
      continue;
    } else if (ex.type === 'links') {
      let links;
      if (driver === 'cdp') {
        const code = `Array.from(document.querySelectorAll(${JSON.stringify(ex.selector || 'a')})).map(a => ({ href: a.href, text: a.innerText.trim() }))`;
        const r = cdp('eval', code);
        links = Array.isArray(r.parsed?.result) ? r.parsed.result : [];
      } else {
        links = [...page.html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({ href: m[1], text: htmlToText(m[2]) }));
      }
      extracted[ex.id] = links;
      writeJson(join(outDir, 'extracted', `${ex.id}.json`), links);
    }
  }
  if (driver === 'cdp') {
    const finalScreenshot = join(outDir, 'screenshots', 'final.png');
    const finalShot = cdp('shot', cdpFilePath(finalScreenshot));
    if (!finalShot.ok) issues.push({ severity: 'review', message: `final screenshot failed: ${finalShot.stderr || finalShot.stdout}` });
  }
  const status = classifyStatus(issues);
  finishManifest(manifest, status, { steps: recipe.steps.length, extracts: recipe.extract.length }, {
    recipe: 'recipe.json',
    pages: 'pages.json',
    steps: 'steps.jsonl',
    extracted: 'extracted/',
  });
  manifest.warnings = issues.filter((i) => i.severity !== 'fail').map((i) => i.message);
  manifest.errors = issues.filter((i) => i.severity === 'fail').map((i) => i.message);
  writeJson(join(outDir, 'manifest.json'), manifest);
  audit(outDir, false);
}

function audit(dir, check = false) {
  const issues = [];
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) issues.push({ severity: 'fail', message: 'missing manifest.json' });
  let manifest = {};
  try { manifest = readJson(manifestPath); } catch (err) { issues.push({ severity: 'fail', message: `invalid manifest: ${err.message}` }); }
  if (manifest.status === 'RUNNING') issues.push({ severity: 'fail', message: 'manifest still RUNNING' });
  if (!existsSync(join(dir, 'pages.json'))) issues.push({ severity: 'fail', message: 'missing pages.json' });
  if (!existsSync(join(dir, 'steps.jsonl'))) issues.push({ severity: 'review', message: 'missing steps.jsonl' });
  const status = classifyStatus(issues);
  const out = { schema: 'browser.audit.v1', audited_at: isoNow(), status, issues, counts: manifest.counts || {} };
  writeJson(join(dir, 'audit.json'), out);
  printSummary(out);
  if (check && status !== 'PASS') process.exit(1);
}

try {
  if (cmd === 'help' || args.help) {
    usage();
  } else if (cmd === 'doctor') {
    const res = cdpCall('pages', [], {}, { profile: args.profile || '' });
    printSummary({
      schema: 'browser.doctor.v1',
      status: res.ok ? 'PASS' : 'FAIL',
      node: process.version,
      windows_chrome_auto_start: true,
      profile: args.profile || 'default',
      cdp_port: res.parsed?.port || null,
      pages: res.parsed?.count || 0,
      ...(res.ok ? {} : { error: res.parsed?.error || res.stderr.trim().slice(0, 300) }),
    });
    if (!res.ok) process.exitCode = 1;
  } else if (cmd === 'pages') {
    const res = cdpCall('pages', [], {}, { profile: args.profile || '' });
    process.stdout.write(res.stdout || res.stderr);
    process.exit(res.status || 0);
  } else if (['login-check', 'scrape', 'run'].includes(cmd)) {
    const recipe = args.recipe || args._[1];
    if (!recipe) throw new Error('missing --recipe FILE');
    await executeRecipe(resolve(recipe), cmd);
  } else if (cmd === 'audit') {
    const dir = args._[1] || args.dir;
    if (!dir) throw new Error('missing DIR');
    audit(resolve(dir), !!args.check);
  } else {
    usage();
    process.exit(2);
  }
} catch (err) {
  console.error(`FAIL ${err.message}`);
  process.exit(1);
}
