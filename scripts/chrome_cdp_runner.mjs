#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPathConfig } from './lib/path_config.mjs';

const reqPath = process.argv[2];
if (!reqPath) {
  console.log(JSON.stringify({ ok: false, error: '요청 파일이 없습니다.' }));
  process.exit(2);
}

const spec = JSON.parse(readFileSync(reqPath, 'utf8'));
const {
  action,
  port = 9224,
  url = null,
  selector = null,
  text = null,
  value = null,
  out = null,
  timeout = 15000,
  targetId = null,
} = spec;
const pathConfig = loadPathConfig();

function emit(value) {
  console.log(JSON.stringify(value));
}

function playwrightEntry(root) {
  if (!root) return [];
  const value = String(root).trim();
  if (!value) return [];
  if (/\.(?:mjs|js)$/iu.test(value)) return [value];
  return [join(value, 'index.mjs'), join(value, 'index.js')];
}

async function importPlaywright(file) {
  if (!file || !existsSync(file)) return null;
  try { return await import(pathToFileURL(file).href); } catch { return null; }
}

async function loadPlaywright() {
  try { return await import('playwright-core'); } catch {}

  const runtimeRoot = join(pathConfig.stateDirWin, 'browser-runtime');
  const candidates = [
    ...playwrightEntry(process.env.CU_PLAYWRIGHT_CORE_PATH),
    join(runtimeRoot, 'node_modules', 'playwright-core', 'index.mjs'),
    join(runtimeRoot, 'node_modules', 'playwright-core', 'index.js'),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'claude-cdp', 'node_modules', 'playwright-core', 'index.mjs') : '',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'claude-cdp', 'node_modules', 'playwright-core', 'index.js') : '',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const loaded = await importPlaywright(candidate);
    if (loaded) return loaded;
  }

  mkdirSync(runtimeRoot, { recursive: true });
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const installed = spawnSync(npm, [
    'install',
    '--prefix', runtimeRoot,
    '--no-save',
    '--no-audit',
    '--no-fund',
    'playwright-core@1.60.0',
  ], { encoding: 'utf8', timeout: 180000, windowsHide: true });
  if (installed.status !== 0) {
    throw new Error(`Playwright 실행 도구 자동 준비 실패: ${installed.stderr || installed.stdout || `exit ${installed.status}`}`);
  }
  for (const candidate of playwrightEntry(join(runtimeRoot, 'node_modules', 'playwright-core'))) {
    const loaded = await importPlaywright(candidate);
    if (loaded) return loaded;
  }
  throw new Error('Playwright 실행 도구를 준비했지만 불러오지 못했습니다.');
}

function outputPath(file, fallback) {
  const candidate = String(file || fallback || '').trim();
  return isAbsolute(candidate) ? candidate : resolve(candidate);
}

async function screenshot(page, file) {
  const target = outputPath(file, join(pathConfig.shotsDirWin, 'web_last.png'));
  mkdirSync(dirname(target), { recursive: true });
  await page.bringToFront();
  await page.screenshot({ path: target, timeout: 15000, animations: 'disabled' });
  return target;
}

async function pageTargetId(context, page) {
  const session = await context.newCDPSession(page);
  try {
    const info = await session.send('Target.getTargetInfo');
    return String(info?.targetInfo?.targetId || '');
  } finally {
    await session.detach().catch(() => {});
  }
}

let browser;
try {
  if (process.platform !== 'win32') throw new Error('이 러너는 Windows Node에서 실행해야 합니다.');
  const playwright = await loadPlaywright();
  const chromium = playwright.chromium || playwright.default?.chromium;
  if (!chromium) throw new Error('Playwright Chromium 연결 기능을 찾지 못했습니다.');

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error('Chrome 기본 프로필 컨텍스트를 찾지 못했습니다.');
  const livePages = () => context.pages().filter((page) => !page.url().startsWith('devtools://'));
  const pages = livePages();
  const pageEntries = [];
  for (const candidate of pages) {
    let candidateTargetId = '';
    try { candidateTargetId = await pageTargetId(context, candidate); } catch {}
    pageEntries.push({ page: candidate, targetId: candidateTargetId });
  }
  let selectedEntry = targetId ? pageEntries.find((entry) => entry.targetId === targetId) : null;
  if (targetId && !selectedEntry && action !== 'goto' && action !== 'pages') {
    throw new Error('이전에 선택한 Chrome 탭이 닫혔습니다. pages 또는 goto로 대상을 다시 선택하세요.');
  }
  if (selectedEntry && url && action !== 'goto' && !selectedEntry.page.url().includes(url)) {
    throw new Error(`선택한 Chrome 탭의 주소가 요청과 다릅니다: ${url}`);
  }
  const matchingPages = url ? pages.filter((candidate) => candidate.url().includes(url)) : [];
  if (!selectedEntry && url && action !== 'goto' && action !== 'pages' && matchingPages.length > 1) {
    throw new Error(`요청한 주소에 일치하는 탭이 여러 개입니다. 더 구체적인 주소를 지정하세요: ${url}`);
  }
  let page = selectedEntry?.page || (action === 'goto' ? matchingPages.at(-1) : matchingPages[0]) || null;
  if (!page && url && action !== 'goto' && action !== 'pages') {
    throw new Error(`요청한 주소가 열린 탭을 찾지 못했습니다: ${url}`);
  }
  if (!page && action === 'goto') page = await context.newPage();
  if (!page) page = pages.findLast((candidate) => candidate.url() !== 'about:blank') || pages.at(-1) || await context.newPage();
  let result = {};
  let evidence = null;

  switch (action) {
    case 'pages': {
      const list = [];
      for (const candidate of livePages()) {
        let title = '';
        try { title = await candidate.title(); } catch {}
        list.push({ url: candidate.url().slice(0, 240), title: String(title || '').slice(0, 120) });
      }
      result = { count: list.length, pages: list };
      break;
    }
    case 'goto': {
      const target = text || url;
      if (!target) throw new Error('이동할 주소가 없습니다.');
      await page.goto(target, { timeout, waitUntil: 'domcontentloaded' });
      evidence = await screenshot(page, spec.evidenceOut);
      result = { url: page.url() };
      break;
    }
    case 'reload': {
      await page.reload({ timeout, waitUntil: 'domcontentloaded' });
      evidence = await screenshot(page, spec.evidenceOut);
      result = { url: page.url() };
      break;
    }
    case 'read': {
      const bodyText = await page.evaluate(() => document.body?.innerText || '');
      result = { url: page.url(), title: await page.title().catch(() => ''), text: bodyText.slice(0, 12000) };
      break;
    }
    case 'find': {
      const locator = page.getByText(text || '');
      const count = await locator.count();
      const sample = [];
      for (let index = 0; index < Math.min(count, 8); index++) {
        try {
          const item = locator.nth(index);
          sample.push({ index, text: (await item.innerText()).slice(0, 120), box: await item.boundingBox() });
        } catch {}
      }
      result = { query: text, count, sample };
      break;
    }
    case 'click': {
      await page.locator(selector).first().click({ timeout });
      evidence = await screenshot(page, spec.evidenceOut);
      result = { clicked: selector, url: page.url() };
      break;
    }
    case 'clicktext': {
      await page.getByText(text || '').first().click({ timeout });
      evidence = await screenshot(page, spec.evidenceOut);
      result = { clicked: text, url: page.url() };
      break;
    }
    case 'type': {
      await page.locator(selector).first().fill(value ?? text ?? '', { timeout });
      evidence = await screenshot(page, spec.evidenceOut);
      result = { typed: selector };
      break;
    }
    case 'select': {
      const chosen = await page.locator(selector).first().evaluate((element, requested) => {
        if (!(element instanceof HTMLSelectElement)) return null;
        const option = [...element.options].find((item) => item.value === requested || item.textContent.trim() === requested);
        return option ? option.value : null;
      }, value ?? text ?? '');
      if (chosen === null) throw new Error(`정확히 일치하는 선택 항목을 찾지 못했습니다: ${value ?? text ?? ''}`);
      await page.locator(selector).first().selectOption(chosen);
      evidence = await screenshot(page, spec.evidenceOut);
      result = { selected: selector, value: chosen };
      break;
    }
    case 'check': {
      await page.locator(selector).first().check({ timeout });
      evidence = await screenshot(page, spec.evidenceOut);
      result = { checked: selector };
      break;
    }
    case 'upload': {
      await page.locator(selector).first().setInputFiles(value ?? text ?? '', { timeout });
      evidence = await screenshot(page, spec.evidenceOut);
      result = { uploaded: selector };
      break;
    }
    case 'eval': {
      result = { result: await page.evaluate((code) => globalThis.eval(code), text || '') };
      break;
    }
    case 'assert': {
      const bodyText = await page.evaluate(() => document.body?.innerText || '');
      const verified = bodyText.includes(text || '');
      result = { verified, want: text, url: page.url() };
      if (!verified) process.exitCode = 1;
      break;
    }
    case 'waittext': {
      await page.getByText(text || '').first().waitFor({ timeout });
      result = { appeared: text };
      break;
    }
    case 'validate': {
      result = await page.evaluate((submitSelector) => {
        const submit = submitSelector ? document.querySelector(submitSelector) : null;
        if (submitSelector && !submit) return { ok: false, error: 'submit_not_found', invalid: [], maxlength: [] };
        const root = submitSelector ? submit.form : document;
        if (!root) return { ok: false, error: 'form_not_found', invalid: [], maxlength: [] };
        const fields = [...root.querySelectorAll('input,select,textarea')]
          .filter((field) => field.type !== 'hidden' && !field.disabled);
        const invalid = fields.filter((field) => !field.checkValidity()).map((field) => ({
          id: field.id || '',
          name: field.name || '',
          message: field.validationMessage || '',
        }));
        const maxlength = fields.filter((field) => field.maxLength >= 0 && String(field.value || '').length > field.maxLength).map((field) => ({
          id: field.id || '',
          name: field.name || '',
          length: String(field.value || '').length,
          maxlength: field.maxLength,
        }));
        return { ok: invalid.length === 0 && maxlength.length === 0, invalid, maxlength };
      }, selector || '');
      if (!result.ok) process.exitCode = 1;
      break;
    }
    case 'identify': {
      await page.evaluate((label) => {
        document.getElementById('computer-use-cdp-identity')?.remove();
        const badge = document.createElement('div');
        badge.id = 'computer-use-cdp-identity';
        badge.textContent = label;
        Object.assign(badge.style, {
          position: 'fixed', top: '12px', right: '12px', zIndex: '2147483647',
          padding: '10px 14px', background: '#106b4f', color: '#fff',
          border: '2px solid #fff', borderRadius: '6px', font: '600 14px sans-serif',
          boxShadow: '0 4px 16px rgba(0,0,0,.3)',
        });
        document.documentElement.appendChild(badge);
      }, text || `Computer-Use 자동화 Chrome · 연결 ${port}`);
      evidence = await screenshot(page, spec.evidenceOut);
      result = { identified: true, url: page.url() };
      break;
    }
    case 'shot': {
      evidence = await screenshot(page, out);
      result = { file: evidence, url: page.url() };
      break;
    }
    default:
      throw new Error(`지원하지 않는 브라우저 작업입니다: ${action}`);
  }

  const selectedTargetId = action === 'pages' ? '' : await pageTargetId(context, page).catch(() => '');
  emit({
    ok: process.exitCode !== 1,
    port: Number(port),
    ...result,
    ...(selectedTargetId ? { targetId: selectedTargetId, targetUrl: page.url() } : {}),
    ...(evidence ? { evidence } : {}),
  });
} catch (error) {
  emit({ ok: false, error: String(error?.message || error).slice(0, 1200) });
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
}
