// 범용 웹 조작 도구 모음. Playwright Page 또는 Frame(scope)을 받아 JSON으로 결과를 돌려준다.
// chrome_cdp_runner.mjs의 고정 명령과 `web script` 스니펫이 같은 구현을 공유한다.
// 사이트 전용 로직은 넣지 않는다. 반복해서 필요했던 일반 패턴만 둔다:
// 글자로 클릭, React 호환 입력, 확인창 정책, iframe, 숨은 업로드, 다운로드, 응답 캡처, 화면 상태 복구.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const WEB_HELPERS_VERSION = 'computer-use.web-helpers.v1';

const CLICKABLE = [
  'a', 'button', 'summary', 'label', 'select', 'option',
  'input[type=button]', 'input[type=submit]', 'input[type=reset]', 'input[type=checkbox]', 'input[type=radio]', 'input[type=image]',
  '[role=button]', '[role=link]', '[role=tab]', '[role=menuitem]', '[role=menuitemcheckbox]', '[role=menuitemradio]',
  '[role=option]', '[role=checkbox]', '[role=radio]', '[role=switch]', '[role=treeitem]', '[role=gridcell]',
  '[onclick]', '[tabindex]:not([tabindex="-1"])',
].join(',');

const INTERACTIVE = [
  'a[href]', 'button', 'input', 'select', 'textarea', 'summary', '[contenteditable=""]', '[contenteditable=true]',
  '[role=button]', '[role=link]', '[role=tab]', '[role=menuitem]', '[role=option]', '[role=checkbox]', '[role=radio]',
  '[role=switch]', '[role=combobox]', '[role=textbox]', '[role=searchbox]', '[role=listbox]', '[role=slider]',
  '[onclick]', '[tabindex]:not([tabindex="-1"])',
].join(',');

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export function pageOf(scope) {
  return typeof scope?.page === 'function' ? scope.page() : scope;
}

// "/패턴/플래그" 형태면 정규식, 아니면 일반 글자로 본다.
export function parseTextQuery(text) {
  const value = String(text ?? '');
  const match = value.match(/^\/(.+)\/([dgimsuy]*)$/su);
  if (match) return { source: match[1], flags: match[2].replace(/g/gu, ''), raw: value };
  return { text: value.replace(/\s+/gu, ' ').trim(), raw: value };
}

export async function waitFor(fn, { timeout = 15000, interval = 250, message = '조건을 기다리다 시간이 초과됐습니다' } = {}) {
  const deadline = Date.now() + Math.max(0, Number(timeout) || 0);
  let lastError = null;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const detail = lastError ? ` (${String(lastError.message || lastError).slice(0, 200)})` : '';
      throw new Error(`${message}${detail}`);
    }
    await sleep(interval);
  }
}

export async function bodyText(scope, maxChars = 12000) {
  const text = await scope.evaluate(() => document.body?.innerText || '');
  return String(text).slice(0, maxChars);
}

export async function waitText(scope, text, { timeout = 15000, gone = false } = {}) {
  const query = parseTextQuery(text);
  const started = Date.now();
  await waitFor(async () => {
    const present = await scope.evaluate((q) => {
      const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
      if (q.source) return new RegExp(q.source, q.flags).test(body);
      return body.includes(q.text);
    }, query);
    return gone ? !present : present;
  }, { timeout, message: gone ? `글자가 사라지지 않았습니다: ${query.raw}` : `글자가 나타나지 않았습니다: ${query.raw}` });
  return { text: query.raw, gone, waitedMs: Date.now() - started };
}

// --- frames ---

export function listFrames(page) {
  const frames = page.frames();
  const main = page.mainFrame();
  return frames.map((frame, index) => ({
    index,
    name: frame.name(),
    url: frame.url().slice(0, 300),
    main: frame === main,
    parent: frame.parentFrame() ? frames.indexOf(frame.parentFrame()) : null,
    detached: frame.isDetached(),
  }));
}

// 힌트: 프레임 번호, name, 주소 일부, 또는 "selector:CSS"(iframe 요소).
export async function resolveFrame(page, hint) {
  if (hint === undefined || hint === null || String(hint).trim() === '') return page;
  const value = String(hint).trim();
  if (value.startsWith('selector:')) {
    const handle = await page.locator(value.slice('selector:'.length)).first().elementHandle({ timeout: 5000 });
    const frame = handle ? await handle.contentFrame() : null;
    if (!frame) throw new Error(`iframe 요소에서 프레임을 찾지 못했습니다: ${value}`);
    return frame;
  }
  const frames = page.frames().filter((frame) => frame !== page.mainFrame() && !frame.isDetached());
  if (/^#?\d+$/u.test(value)) {
    const index = Number(value.replace('#', ''));
    const frame = page.frames()[index];
    if (!frame) throw new Error(`프레임 번호가 없습니다: ${value}`);
    return frame;
  }
  const byName = frames.filter((frame) => frame.name() === value);
  if (byName.length === 1) return byName[0];
  const matches = frames.filter((frame) => frame.url().includes(value) || (frame.name() && frame.name().includes(value)));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`프레임을 찾지 못했습니다: ${value}. frames 명령으로 목록을 확인하세요.`);
  throw new Error(`일치하는 프레임이 여러 개입니다(${matches.length}). 더 구체적인 주소 일부나 프레임 번호를 지정하세요: ${value}`);
}

// --- dialogs (alert / confirm / prompt / beforeunload) ---

// 정책 문자열: dismiss(기본) | accept | accept:<prompt 입력값> | expect:<정규식>
// expect는 메시지가 정규식과 맞는 confirm/prompt만 수락하고 나머지는 취소한다(예상하지 못한 삭제 확인창 방지).
export function parseDialogPolicy(policy = 'dismiss') {
  const value = String(policy || 'dismiss');
  if (value === 'accept') return { mode: 'accept' };
  if (value.startsWith('accept:')) return { mode: 'accept', promptText: value.slice('accept:'.length) };
  if (value.startsWith('expect:')) {
    const source = value.slice('expect:'.length);
    if (!source) throw new Error('expect: 뒤에 확인창 문구 정규식이 필요합니다.');
    return { mode: 'expect', regex: new RegExp(source, 'u'), source };
  }
  if (value === 'dismiss') return { mode: 'dismiss' };
  throw new Error(`지원하지 않는 확인창 정책입니다: ${value} (dismiss|accept|accept:값|expect:정규식)`);
}

// Playwright는 처리기가 없는 탭의 확인창을 조용히 닫는다. 그러면 "저장"을 눌렀는데 아무 일도 없는 것처럼 보이고,
// 사람이 보던 다른 탭의 확인창까지 닫힌다. 그래서 작업 탭(과 그 탭이 연 팝업)에만 정책을 적용하고 기록한다.
// 나머지 탭에는 아무것도 하지 않는 처리기를 달아 사람의 확인창을 건드리지 않는다.
export function installDialogPolicy(context, page, policy = 'dismiss', log = []) {
  const rule = parseDialogPolicy(policy);
  const owned = new Set([page]);
  const decide = async (dialog) => {
    const entry = {
      type: dialog.type(),
      message: String(dialog.message() || '').slice(0, 500),
      at: new Date().toISOString(),
    };
    try {
      const matchesExpect = rule.mode === 'expect' ? rule.regex.test(entry.message) : null;
      if (dialog.type() === 'alert') {
        await dialog.accept();
        entry.action = 'accepted';
      } else if (rule.mode === 'accept' || matchesExpect) {
        await dialog.accept(dialog.type() === 'prompt' ? rule.promptText : undefined);
        entry.action = 'accepted';
      } else {
        await dialog.dismiss();
        entry.action = 'dismissed';
        if (rule.mode === 'expect') entry.expectMismatch = rule.source;
      }
    } catch (error) {
      // 다른 CDP 사용자가 먼저 닫으면 "No dialog is showing"이 난다. 기록만 하고 죽지 않는다.
      entry.action = 'error';
      entry.error = String(error?.message || error).slice(0, 200);
    }
    log.push(entry);
  };
  const ignore = () => {};
  const attached = new Map();
  const attach = (candidate) => {
    if (attached.has(candidate)) return;
    const handler = owned.has(candidate) ? decide : ignore;
    attached.set(candidate, handler);
    candidate.on('dialog', handler);
  };
  const onPopup = (popup) => {
    owned.add(popup);
    const previous = attached.get(popup);
    if (previous) popup.off('dialog', previous);
    attached.delete(popup);
    attach(popup);
  };
  for (const candidate of context.pages()) attach(candidate);
  context.on('page', attach);
  page.on('popup', onPopup);
  return {
    log,
    dispose() {
      context.off('page', attach);
      page.off('popup', onPopup);
      for (const [candidate, handler] of attached) candidate.off('dialog', handler);
    },
  };
}

// confirm/prompt/beforeunload를 취소했다면 의도한 변경이 일어나지 않았을 가능성이 높다. alert은 거절로 세지 않는다.
export function dismissedDecisions(log) {
  return log.filter((entry) => entry.action === 'dismissed' && entry.type !== 'alert');
}

// 작업 중 페이지가 보낸 쓰기 요청(POST/PUT/PATCH/DELETE)을 기록한다. 화면 반응이 없어도 서버에 반영됐을 수 있다는 신호다.
export function watchWriteRequests(page, log = []) {
  const onRequest = (request) => {
    const method = request.method();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return;
    const type = request.resourceType();
    if (!['xhr', 'fetch', 'document', 'other'].includes(type)) return;
    const url = request.url();
    if (/\/(?:collect|log|logs|beacon|analytics|track|metrics)(?:[/?]|$)|google-analytics|doubleclick|googletagmanager/iu.test(url)) return;
    const entry = { method, url: url.replace(/\?.*$/u, '').slice(0, 300), type, at: new Date().toISOString(), status: null };
    log.push(entry);
    request.response().then((response) => { entry.status = response ? response.status() : null; }).catch(() => {});
  };
  page.on('request', onRequest);
  return { log, dispose: () => page.off('request', onRequest) };
}

// 작업 중 이 탭이 연 새 탭(팝업)을 모은다. context 전체의 새 탭은 다른 프로그램 것일 수 있어 opener 기준으로만 본다.
export function watchPopups(page, log = []) {
  const onPopup = (popup) => {
    log.push({ url: popup.url().slice(0, 300), at: new Date().toISOString(), page: popup });
  };
  page.on('popup', onPopup);
  return { log, dispose: () => page.off('popup', onPopup) };
}

// --- session / login wall ---

const LOGIN_URL = /(?:^|[/.?&=_-])(?:login|log-in|signin|sign-in|sign_in|nidlogin|auth|oauth|sso|account[s]?\/(?:login|signin)|servicelogin|challenge|2fa|mfa|otp|captcha|checkpoint|two-?factor)(?:[/.?&=_-]|$)/iu;

// 로그인 벽 판정은 주소·비밀번호 칸·로그인 글자를 함께 본다. identity 글자가 주어지면 계정까지 확인한다.
export async function sessionState(scope, { identity = null, loginTexts = ['로그인', 'Log in', 'Sign in', 'Login'] } = {}) {
  const page = pageOf(scope);
  const url = page.url();
  const parsed = (() => { try { return new URL(url); } catch { return null; } })();
  const pathOnly = parsed ? `${parsed.hostname}${parsed.pathname}` : url;
  const info = await scope.evaluate(({ identity, loginTexts }) => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const password = [...document.querySelectorAll('input[type=password]')].some(visible);
    const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
    const loginButton = [...document.querySelectorAll('button,input[type=submit],a,[role=button]')]
      .filter(visible)
      .some((el) => loginTexts.includes((el.innerText || el.value || '').replace(/\s+/g, ' ').trim()));
    return {
      password,
      loginButton,
      identityFound: identity ? body.includes(identity) : null,
      bodyChars: body.length,
    };
  }, { identity, loginTexts });
  const urlLooksLogin = LOGIN_URL.test(pathOnly);
  // identity 없이 "로그인됨"을 단정하지 않는다. 벽이 안 보인다는 사실만 NO_LOGIN_WALL로 알린다.
  let status = 'NO_LOGIN_WALL';
  // 비밀번호 칸만으로는 판단하지 않는다(로그인된 화면의 비밀번호 변경 폼). 로그인 버튼이 함께 보여야 벽으로 본다.
  if (info.identityFound === true && !urlLooksLogin) status = 'LOGGED_IN';
  else if (urlLooksLogin || (info.password && info.loginButton)) status = 'LOGIN_WALL';
  else if (identity && info.identityFound === false) status = 'WRONG_ACCOUNT';
  return { status, url: url.slice(0, 300), urlLooksLogin, passwordField: info.password, loginButton: info.loginButton, identity: identity || null, identityFound: info.identityFound, bodyChars: info.bodyChars };
}

// --- window state ---

// 최소화되거나 너무 작게 줄어든 Chrome 창은 캡처가 비거나, 사이트가 목록을 0개로 그린다(innerHeight 107 사례).
// CDP로 창 상태와 크기만 복구한다. 좌표는 환경마다 이상값(-32000 등)이 나와 판단 근거로 쓰지 않는다. 포커스는 뺏지 않는다.
export async function normalizeWindow(page, { maximize = false, minWidth = 900, minHeight = 600 } = {}) {
  let session;
  try {
    session = await page.context().newCDPSession(page);
    const { windowId, bounds } = await session.send('Browser.getWindowForTarget');
    const before = bounds?.windowState || 'unknown';
    const changes = [];
    if (before === 'minimized' || before === 'fullscreen' || (maximize && before !== 'maximized')) {
      await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      changes.push('restore');
    }
    if (maximize) {
      await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
      changes.push('maximize');
    } else {
      const now = (await session.send('Browser.getWindowBounds', { windowId })).bounds || {};
      const tooSmall = (now.width ?? 0) < minWidth || (now.height ?? 0) < minHeight;
      if (tooSmall && now.windowState === 'normal') {
        await session.send('Browser.setWindowBounds', { windowId, bounds: { width: Math.max(now.width ?? 0, 1280), height: Math.max(now.height ?? 0, 900) } });
        changes.push('resize');
      }
    }
    const after = ((await session.send('Browser.getWindowBounds', { windowId })).bounds || {}).windowState || 'unknown';
    return { ok: true, windowId, before, after, changes };
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 200) };
  } finally {
    if (session) await session.detach().catch(() => {});
  }
}

// Playwright 캡처가 웹폰트 대기 등으로 멈추면 CDP Page.captureScreenshot으로 한 번 더 시도한다.
export async function screenshot(page, file, { fullPage = false, selector = null, scope = null, front = true } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  await normalizeWindow(page);
  if (front) await page.bringToFront();
  if (selector) {
    await (scope || page).locator(selector).first().screenshot({ path: file, timeout: 15000, animations: 'disabled' });
    return file;
  }
  try {
    await page.screenshot({ path: file, timeout: 15000, animations: 'disabled', fullPage: Boolean(fullPage) });
  } catch (error) {
    const session = await page.context().newCDPSession(page);
    try {
      const shot = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: Boolean(fullPage) });
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
    } catch {
      throw error;
    } finally {
      await session.detach().catch(() => {});
    }
  }
  return file;
}

// --- text targeting ---

// 보이는 요소 중 글자가 일치하는 가장 안쪽 요소를 찾아 표시(data-cu-hit)한다.
// 정확히 일치하는 후보가 있으면 그것만 쓰고, 없을 때만 포함 일치로 넓힌다.
export async function findByText(scope, text, { exact = false, contains = false, within = null, includeHidden = false, limit = 30 } = {}) {
  const query = parseTextQuery(text);
  if (!query.source && !query.text) throw new Error('찾을 글자가 비어 있습니다.');
  const token = `cu${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const result = await scope.evaluate(({ query, exact, contains, within, includeHidden, limit, token, CLICKABLE }) => {
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const regex = query.source ? new RegExp(query.source, query.flags) : null;
    const root = within ? document.querySelector(within) : document.body;
    if (!root) return { error: 'within_not_found' };
    for (const old of document.querySelectorAll('[data-cu-hit]')) old.removeAttribute('data-cu-hit');
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return false;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < 0.05) return false;
      if (el.closest('[aria-hidden="true"],[inert]')) return false;
      return true;
    };
    const ownLabel = (el) => {
      if (el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type)) return norm(el.value);
      const text = norm(el.innerText);
      if (text) return text;
      return norm(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || '');
    };
    const prefilter = (el) => {
      if (regex) return true;
      const raw = norm(el.textContent) + ' ' + norm(el.getAttribute?.('aria-label')) + ' ' + norm(el.getAttribute?.('title')) + ' ' + norm(el.value);
      return raw.includes(query.text);
    };
    const kind = (label) => {
      if (regex) return regex.test(label) ? 'regex' : '';
      if (label === query.text) return 'exact';
      if (!exact && label.includes(query.text)) return 'contains';
      return '';
    };
    const leaves = [];
    const all = root.querySelectorAll('*');
    for (const el of all) {
      if (el.matches('script,style,noscript,template,head,meta,link,svg *')) continue;
      if (!prefilter(el)) continue;
      const label = ownLabel(el);
      if (!label || label.length > 400) continue;
      const how = kind(label);
      if (!how) continue;
      let childHit = false;
      for (const child of el.children) {
        if (!prefilter(child)) continue;
        if (kind(ownLabel(child))) { childHit = true; break; }
      }
      if (childHit) continue;
      if (!includeHidden && !visible(el)) continue;
      leaves.push({ el, label, how });
    }
    let pool = leaves;
    if (!regex && !contains && leaves.some((item) => item.how === 'exact')) pool = leaves.filter((item) => item.how === 'exact');
    // 같은 클릭 대상(버튼 안의 span 여러 개 등)은 한 후보로 묶는다.
    const groups = new Map();
    for (const item of pool) {
      const target = item.el.closest(CLICKABLE) || item.el;
      if (!groups.has(target)) groups.set(target, item);
    }
    const candidates = [...groups.entries()].map(([target, item]) => {
      const rect = item.el.getBoundingClientRect();
      return {
        target,
        leaf: item.el,
        label: item.label.slice(0, 120),
        how: item.how,
        tag: target.tagName.toLowerCase(),
        role: target.getAttribute('role') || '',
        disabled: Boolean(target.disabled || target.getAttribute('aria-disabled') === 'true'),
        rect: { x: Math.round(rect.left + scrollX), y: Math.round(rect.top + scrollY), w: Math.round(rect.width), h: Math.round(rect.height) },
      };
    });
    candidates.sort((a, b) => (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x));
    const out = candidates.slice(0, limit).map((item, index) => {
      item.leaf.setAttribute('data-cu-hit', `${token}-${index}`);
      return {
        index: index + 1,
        hit: `${token}-${index}`,
        label: item.label,
        how: item.how,
        tag: item.tag,
        role: item.role,
        disabled: item.disabled,
        rect: item.rect,
      };
    });
    return { total: candidates.length, candidates: out };
  }, { query, exact, contains, within, includeHidden, limit, token, CLICKABLE });
  if (result.error === 'within_not_found') throw new Error(`범위 선택자를 찾지 못했습니다: ${within}`);
  return { query: query.raw, ...result };
}

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function chooseCandidate(found, { nth = 0, first = false, query }) {
  const list = found.candidates;
  if (!list.length) throw codedError(`보이는 요소 중 글자가 일치하는 대상을 찾지 못했습니다: ${query}`, 'not_found');
  if (nth > 0) {
    const pick = list[nth - 1];
    if (!pick) throw codedError(`${nth}번째 대상이 없습니다(후보 ${found.total}개): ${query}`, 'not_found');
    return pick;
  }
  if (list.length > 1 && !first) {
    const summary = list.slice(0, 8).map((item) => `${item.index}) <${item.tag}> "${item.label}" @${item.rect.x},${item.rect.y}`).join(' | ');
    const error = new Error(`글자가 일치하는 대상이 ${found.total}개입니다. --nth N으로 하나를 고르세요: ${summary}`);
    error.code = 'ambiguous';
    error.candidates = list.slice(0, 8);
    throw error;
  }
  return list[0];
}

// 클릭 지점을 실제로 덮고 있는 요소를 확인한다. 숨은 확인 모달이나 오버레이가 덮고 있으면 바로 알려 준다.
async function coverCheck(scope, hit) {
  return scope.evaluate((hitId) => {
    const el = document.querySelector(`[data-cu-hit="${hitId}"]`);
    if (!el) return { missing: true };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const top = document.elementFromPoint(x, y);
    if (!top || top === el || el.contains(top) || top.contains(el)) return { covered: false };
    const label = (top.innerText || top.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return { covered: true, by: { tag: top.tagName.toLowerCase(), id: top.id || '', cls: String(top.className || '').slice(0, 80), text: label } };
  }, hit);
}

export const pickTextCandidate = chooseCandidate;
export const hitCovered = coverCheck;

export async function selectorCovered(scope, selector) {
  const mark = `sc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const exists = await scope.locator(selector).first().evaluate((el, value) => { el.setAttribute('data-cu-hit', value); return true; }, mark).catch(() => false);
  if (!exists) return { missing: true };
  return coverCheck(scope, mark);
}

export async function clickText(scope, text, options = {}) {
  const { nth = 0, first = false, double = false, force = false, timeout = 15000 } = options;
  const found = await findByText(scope, text, options);
  const pick = chooseCandidate(found, { nth: Number(nth) || 0, first, query: found.query });
  if (pick.disabled && !force) throw codedError(`대상이 비활성 상태입니다: "${pick.label}"`, 'disabled');
  const cover = await coverCheck(scope, pick.hit);
  if (cover.missing) throw codedError(`대상이 화면에서 사라졌습니다: "${pick.label}"`, 'not_found');
  let method = 'mouse';
  if (cover.covered && !force) {
    const by = cover.by;
    const error = new Error(`다른 요소가 클릭 지점을 덮고 있습니다: <${by.tag}${by.id ? `#${by.id}` : ''}> "${by.text}". modals 명령으로 열린 창을 확인하세요. 의도한 경우에만 --force를 사용합니다.`);
    error.code = 'covered';
    error.coveredBy = by;
    throw error;
  }
  const locator = scope.locator(`[data-cu-hit="${pick.hit}"]`);
  if (force) {
    method = 'dom';
    await locator.evaluate((el) => {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
    });
  } else if (double) {
    await locator.dblclick({ timeout });
  } else {
    await locator.click({ timeout });
  }
  return { clicked: { label: pick.label, tag: pick.tag, role: pick.role, how: pick.how, rect: pick.rect, index: pick.index, of: found.total }, method };
}

export async function clickSelector(scope, selector, { double = false, force = false, timeout = 15000 } = {}) {
  const locator = scope.locator(selector).first();
  if (force) {
    await locator.evaluate((el) => {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
    }, undefined, { timeout });
    return { clicked: selector, method: 'dom' };
  }
  if (double) await locator.dblclick({ timeout });
  else await locator.click({ timeout });
  return { clicked: selector, method: 'mouse' };
}

export async function hover(scope, { selector = null, text = null, nth = 0, first = false, timeout = 15000 } = {}) {
  if (selector) {
    await scope.locator(selector).first().hover({ timeout });
    return { hovered: selector };
  }
  const found = await findByText(scope, text);
  const pick = chooseCandidate(found, { nth: Number(nth) || 0, first, query: found.query });
  await scope.locator(`[data-cu-hit="${pick.hit}"]`).hover({ timeout });
  return { hovered: pick.label };
}

// --- labels / signals / overlays ---

// 화면에 보이는 라벨 글자로 입력 칸을 찾는다(for=id, 감싼 label, aria-labelledby, 같은 줄의 다음 칸 순서).
export async function fieldByLabel(scope, label, { exact = false, nth = 0 } = {}) {
  const token = `cf${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const found = await scope.evaluate(({ label, exact, token }) => {
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim().replace(/[*:：]+$/u, '').trim();
    const want = norm(label);
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const FIELD = 'input:not([type=hidden]),textarea,select,[contenteditable=""],[contenteditable=true],[role=textbox],[role=combobox],[role=spinbutton]';
    const labelMatch = (text) => (exact ? norm(text) === want : norm(text) === want || norm(text).includes(want));
    const hits = new Set();
    for (const field of document.querySelectorAll(FIELD)) {
      if (!visible(field) && field.type !== 'file') continue;
      const aria = field.getAttribute('aria-label');
      if (aria && labelMatch(aria)) hits.add(field);
      const labelledBy = field.getAttribute('aria-labelledby');
      if (labelledBy && labelMatch(labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' '))) hits.add(field);
      if (field.labels) for (const own of field.labels) if (labelMatch(own.innerText)) hits.add(field);
      if (field.getAttribute('placeholder') && labelMatch(field.getAttribute('placeholder'))) hits.add(field);
    }
    if (!hits.size) {
      // 표나 div 레이아웃: 라벨 글자가 있는 요소에서 위로 4단계까지 올라가며 처음 만나는 입력 칸.
      const labels = [...document.querySelectorAll('label,th,dt,span,div,p,strong,b,td')].filter((el) => visible(el) && el.children.length <= 3 && labelMatch(el.innerText) && norm(el.innerText).length <= want.length + 12);
      for (const el of labels) {
        let node = el;
        for (let depth = 0; depth < 4 && node; depth++) {
          const field = [...node.querySelectorAll(FIELD)].find((candidate) => visible(candidate) && !el.contains(candidate));
          const next = node.nextElementSibling ? [...node.nextElementSibling.querySelectorAll(FIELD), node.nextElementSibling].find((candidate) => candidate.matches?.(FIELD) && visible(candidate)) : null;
          const pick = next || field;
          if (pick) { hits.add(pick); break; }
          node = node.parentElement;
        }
      }
    }
    const list = [...hits].sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return (ra.top - rb.top) || (ra.left - rb.left);
    });
    for (const old of document.querySelectorAll('[data-cu-field]')) old.removeAttribute('data-cu-field');
    return list.slice(0, 10).map((field, index) => {
      field.setAttribute('data-cu-field', `${token}-${index}`);
      return { index: index + 1, selector: `[data-cu-field="${token}-${index}"]`, tag: field.tagName.toLowerCase(), type: field.type || '', name: field.name || '' };
    });
  }, { label, exact, token });
  if (!found.length) throw codedError(`라벨로 입력 칸을 찾지 못했습니다: ${label}. inspect로 라벨과 선택자를 확인하세요.`, 'not_found');
  if (nth > 0) {
    if (!found[nth - 1]) throw codedError(`${nth}번째 입력 칸이 없습니다(후보 ${found.length}개): ${label}`, 'not_found');
    return found[nth - 1];
  }
  if (found.length > 1) {
    const error = codedError(`라벨이 일치하는 입력 칸이 ${found.length}개입니다. --nth N으로 고르세요: ${label}`, 'ambiguous');
    error.candidates = found;
    throw error;
  }
  return found[0];
}

// 지금 보이는 알림(role=alert/status, 토스트)과 검증 오류 문구.
export async function pageSignals(scope) {
  return scope.evaluate(() => {
    const norm = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
    };
    const texts = (selector, max) => [...new Set([...document.querySelectorAll(selector)].filter(visible).map((el) => norm(el.innerText, 200)).filter(Boolean))].slice(0, max);
    return {
      alerts: texts('[role=alert],[role=status],[aria-live=assertive],[aria-live=polite],.toast,[class*="toast" i],[class*="snackbar" i],[class*="notification" i],[class*="message" i][class*="success" i]', 10),
      errors: texts('[aria-invalid=true] ~ *,.error,.invalid-feedback,[class*="error-message" i],[class*="errorMessage" i],[class*="err_msg" i],[class*="validation" i]', 10),
    };
  });
}

// 클릭 전에 걸어 두면 잠깐 떴다 사라지는 토스트·알림 글자도 잡는다.
export async function startToastWatch(scope) {
  await scope.evaluate(() => {
    window.__cuToasts = [];
    window.__cuToastObserver?.disconnect();
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          const holder = node.closest?.('[role=alert],[role=status],[aria-live],[class*="toast" i],[class*="snackbar" i],[class*="notification" i],[class*="alert" i],[class*="message" i]')
            || node.querySelector?.('[role=alert],[role=status],[aria-live],[class*="toast" i],[class*="snackbar" i],[class*="notification" i]');
          const text = String((holder || {}).innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
          if (text && !window.__cuToasts.includes(text)) window.__cuToasts.push(text);
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.__cuToastObserver = observer;
  }).catch(() => {});
}

export async function stopToastWatch(scope) {
  return scope.evaluate(() => {
    window.__cuToastObserver?.disconnect();
    const list = Array.isArray(window.__cuToasts) ? window.__cuToasts.slice(0, 10) : [];
    delete window.__cuToasts;
    delete window.__cuToastObserver;
    return list;
  }).catch(() => []);
}

const REJECT_WORDS = ['닫기', '취소', '종료', '나중에', '거절', '아니요', '아니오', '다음에', 'Close', 'Cancel', 'No', 'Not now', 'Later', '×', 'X', '✕'];

// 가장 위 모달을 거절 쪽 버튼으로만 닫는다. 승인·저장·전송 단어는 누르지 않는다.
export async function dismissTopModal(scope, { words = REJECT_WORDS } = {}) {
  const modals = await visibleModals(scope);
  if (!modals.length) return { dismissed: false, reason: 'no_modal' };
  const top = modals[0];
  for (const word of words) {
    const found = await findByText(scope, word, { exact: true, within: `[data-cu-modal="${top.index}"]` }).catch(() => null);
    if (found?.total === 1) {
      await scope.locator(`[data-cu-hit="${found.candidates[0].hit}"]`).click({ timeout: 5000 });
      return { dismissed: true, button: word, modal: top.text.slice(0, 120) };
    }
  }
  const closeIcon = await scope.evaluate((index) => {
    const modal = document.querySelector(`[data-cu-modal="${index}"]`);
    const icon = modal && [...modal.querySelectorAll('[aria-label*="close" i],[aria-label*="닫기"],[class*="close" i],[title*="닫기"]')].find((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (!icon) return false;
    icon.setAttribute('data-cu-close', '1');
    return true;
  }, top.index);
  if (closeIcon) {
    await scope.locator(`[data-cu-modal="${top.index}"] [data-cu-close="1"]`).first().click({ timeout: 5000 });
    return { dismissed: true, button: 'close-icon', modal: top.text.slice(0, 120) };
  }
  return { dismissed: false, reason: 'no_reject_button', modal: top.text.slice(0, 120), buttons: top.buttons };
}

// 글자나 선택자가 있는 프레임을 찾는다(메인 문서 먼저). 여러 프레임에 있으면 고르지 않는다.
export async function findFrameWith(page, { text = null, selector = null } = {}) {
  const frames = page.frames().filter((frame) => !frame.isDetached());
  const hits = [];
  for (const frame of frames) {
    try {
      if (selector) {
        if (await frame.locator(selector).count() > 0) hits.push(frame);
      } else if (text) {
        const found = await findByText(frame, text, { limit: 3 });
        if (found.total > 0) hits.push(frame);
      }
    } catch {}
    if (hits.length && frame === page.mainFrame()) return page;
  }
  if (!hits.length) throw codedError(`어느 프레임에서도 대상을 찾지 못했습니다: ${text || selector}`, 'not_found');
  if (hits.length > 1) throw codedError(`대상이 여러 프레임에 있습니다(${hits.length}개). --frame으로 지정하세요: ${hits.map((frame) => frame.url().slice(0, 80)).join(' | ')}`, 'ambiguous');
  return hits[0] === page.mainFrame() ? page : hits[0];
}

// --- values ---

function isSecretField(info) {
  return info?.type === 'password' || /password|passwd|pwd|비밀번호|otp|인증번호/iu.test(`${info?.name || ''} ${info?.id || ''} ${info?.autocomplete || ''}`);
}

async function describeField(locator) {
  return locator.evaluate((el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.type || '',
    name: el.name || '',
    id: el.id || '',
    autocomplete: el.autocomplete || '',
    editable: el.isContentEditable,
    readOnly: Boolean(el.readOnly),
    disabled: Boolean(el.disabled),
    maxLength: typeof el.maxLength === 'number' ? el.maxLength : -1,
  }));
}

async function readBackValue(locator) {
  return locator.evaluate((el) => (el.isContentEditable ? el.innerText : String(el.value ?? '')));
}

function normalizeForCompare(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/[ \s]+/gu, ' ').trim();
}

// 글자 수 표시("12/1000")의 앞 숫자를 읽는다. 일부 화면은 바이트로 세므로(한글 2) 길이~3배를 허용한다.
async function readCounter(scope, counterSelector) {
  const raw = await scope.locator(counterSelector).first().innerText({ timeout: 5000 }).catch(() => null);
  if (raw === null) return { counter: null, counterText: null };
  const match = String(raw).replace(/,/g, '').match(/(\d+)/u);
  return { counter: match ? Number(match[1]) : null, counterText: String(raw).trim().slice(0, 40) };
}

// mode: fill(Playwright 기본) | native(React·Vue 제어 입력용 setter + input/change) | keys(키 입력 하나씩, 마스킹 입력용)
// requireEmpty: 이미 다른 사람이 쓰던 초안이 있으면 덮어쓰지 않는다. counter: 화면의 글자 수 표시로 앱 반영 여부를 확인한다.
export async function setValue(scope, selector, value, { mode = 'fill', timeout = 15000, verify = true, requireEmpty = false, counter = null, allowSecret = false, numeric = false } = {}) {
  const locator = scope.locator(selector).first();
  await locator.waitFor({ state: 'attached', timeout });
  const info = await describeField(locator);
  if (info.disabled) throw codedError(`입력 칸이 비활성 상태입니다: ${selector}`, 'disabled');
  // 스크립트 로그인은 계정 잠금으로 이어진 사례가 있다. 비밀번호는 사람이 보이는 창에서 직접 넣는다.
  if (info.type === 'password' && !allowSecret) {
    throw codedError('비밀번호 칸에는 자동으로 입력하지 않습니다. 로그인은 사람이 보이는 Chrome에서 직접 하고(handoff), 정말 필요한 경우에만 --allow-secret을 씁니다.', 'secret_field');
  }
  const text = String(value ?? '');
  if (requireEmpty) {
    const existing = normalizeForCompare(await readBackValue(locator));
    if (existing) {
      const error = new Error(`입력 칸에 이미 내용이 있습니다(${existing.length}자). 다른 사람이 쓰던 초안일 수 있어 덮어쓰지 않습니다: ${selector}`);
      error.code = 'not_empty';
      throw error;
    }
  }
  if (mode === 'native') {
    await locator.evaluate((el, next) => {
      el.scrollIntoView({ block: 'center' });
      el.focus();
      if (el.isContentEditable) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
        if (!document.execCommand('insertText', false, next)) el.innerText = next;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : (el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, next);
      else el.value = next;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    }, text);
  } else if (mode === 'keys') {
    await locator.click({ timeout });
    const page = pageOf(scope);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await locator.pressSequentially(text, { delay: 15, timeout: Math.max(timeout, text.length * 60) });
  } else {
    await locator.fill(text, { timeout });
  }
  const secret = isSecretField(info);
  if (!verify) return { selector, mode, secret, verified: null };
  const actual = await readBackValue(locator);
  // 금액·수량처럼 화면이 쉼표·단위를 붙이는 칸은 숫자만 비교한다.
  let verified = numeric
    ? String(actual).replace(/[^0-9.-]/gu, '') === String(text).replace(/[^0-9.-]/gu, '')
    : normalizeForCompare(actual) === normalizeForCompare(text);
  const extra = {};
  if (counter) {
    Object.assign(extra, await readCounter(scope, counter));
    const length = text.length;
    const counterOk = length === 0 ? extra.counter === 0 : (extra.counter !== null && extra.counter >= length && extra.counter <= length * 3);
    extra.counterVerified = counterOk;
    verified = verified && counterOk;
  }
  return {
    selector,
    mode,
    secret,
    verified,
    length: actual.length,
    ...(secret ? {} : { value: actual.slice(0, 200) }),
    ...(info.maxLength > 0 && text.length > info.maxLength ? { truncatedByMaxLength: info.maxLength } : {}),
    ...extra,
  };
}

export async function selectExact(scope, selector, requested, { timeout = 15000 } = {}) {
  const locator = scope.locator(selector).first();
  const chosen = await locator.evaluate((element, requested) => {
    if (!(element instanceof HTMLSelectElement)) return { error: 'not_select' };
    const option = [...element.options].find((item) => item.value === requested || item.textContent.trim() === requested);
    return option ? { value: option.value, label: option.textContent.trim() } : { error: 'no_exact_option', options: [...element.options].slice(0, 30).map((item) => item.textContent.trim()) };
  }, String(requested ?? ''));
  if (chosen.error === 'not_select') throw new Error(`선택 목록(select)이 아닙니다. 사용자 정의 목록이면 pick 명령을 사용하세요: ${selector}`);
  if (chosen.error) throw new Error(`정확히 일치하는 선택 항목을 찾지 못했습니다: ${requested} (항목: ${chosen.options.join(', ')})`);
  await locator.selectOption(chosen.value, { timeout });
  const actual = await locator.evaluate((el) => el.value);
  return { selected: selector, value: chosen.value, label: chosen.label, verified: actual === chosen.value };
}

// 사용자 정의 드롭다운: 여는 요소를 누른 뒤 새로 보이는 목록 안에서 항목 글자를 정확히 고른다.
async function pickByKeyboard(scope, { trigger, triggerText, option, timeout, maxSteps = 80 }) {
  const page = pageOf(scope);
  if (trigger) await scope.locator(trigger).first().click({ timeout });
  else await clickText(scope, triggerText, { timeout });
  const wanted = String(option).replace(/\s+/gu, ' ').trim();
  for (let step = 0; step < maxSteps; step++) {
    await page.keyboard.press('ArrowDown');
    await sleep(80);
    const active = await scope.evaluate(() => {
      const el = document.activeElement;
      const id = el?.getAttribute?.('aria-activedescendant');
      const item = (id && document.getElementById(id)) || document.querySelector('[role=option][aria-selected=true],[role=option].active,[role=option][data-highlighted]');
      return String(item?.innerText || item?.textContent || '').replace(/\s+/g, ' ').trim();
    });
    if (active === wanted) {
      await page.keyboard.press('Enter');
      return { picked: option, method: 'keyboard', steps: step + 1 };
    }
  }
  throw codedError(`키보드로 항목을 찾지 못했습니다(${maxSteps}칸): ${option}`, 'not_found');
}

// via: click(기본) | keyboard(ARIA 콤보박스처럼 키보드에만 반응하는 목록)
export async function pickOption(scope, { trigger = null, triggerText = null, option, timeout = 15000, settleMs = 350, via = 'click' } = {}) {
  if (!option) throw new Error('고를 항목 글자가 없습니다.');
  if (via === 'keyboard') {
    const result = await pickByKeyboard(scope, { trigger, triggerText, option, timeout });
    let verified = null;
    if (trigger) {
      const shown = await scope.locator(trigger).first().evaluate((el) => (el.innerText || el.value || '').replace(/\s+/g, ' ').trim()).catch(() => '');
      verified = shown.includes(String(option).replace(/\s+/gu, ' ').trim());
    }
    return { ...result, verified };
  }
  if (trigger) await scope.locator(trigger).first().click({ timeout });
  else if (triggerText) await clickText(scope, triggerText, { timeout });
  else throw new Error('목록을 여는 선택자나 글자가 필요합니다.');
  await sleep(settleMs);
  const popupScope = await scope.evaluate(() => {
    const selectors = '[role=listbox],[role=menu],[role=dialog],[role=tooltip],[role=tree],[class*="dropdown" i],[class*="select" i],[class*="option" i],[class*="popover" i],[class*="layer" i],[class*="menu" i]';
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    let index = 0;
    for (const el of document.querySelectorAll(selectors)) {
      if (!visible(el)) continue;
      el.setAttribute('data-cu-popup', String(index++));
    }
    return index;
  });
  let result = null;
  let lastError = null;
  for (let index = popupScope - 1; index >= 0 && !result; index--) {
    try {
      result = await clickText(scope, option, { exact: true, within: `[data-cu-popup="${index}"]`, timeout });
    } catch (error) {
      lastError = error;
      if (error.code === 'ambiguous') throw error;
    }
  }
  if (!result) {
    try {
      result = await clickText(scope, option, { exact: true, timeout });
    } catch (error) {
      throw lastError && lastError.code === 'covered' ? lastError : error;
    }
  }
  await scope.evaluate(() => { for (const el of document.querySelectorAll('[data-cu-popup]')) el.removeAttribute('data-cu-popup'); });
  let verified = null;
  if (trigger) {
    const shown = await scope.locator(trigger).first().evaluate((el) => (el.innerText || el.value || '').replace(/\s+/g, ' ').trim()).catch(() => '');
    verified = shown.includes(String(option).replace(/\s+/gu, ' ').trim());
  }
  return { picked: option, ...result, verified };
}

export async function setChecked(scope, selector, checked = true, { timeout = 15000 } = {}) {
  const locator = scope.locator(selector).first();
  if (checked) await locator.check({ timeout });
  else await locator.uncheck({ timeout });
  const actual = await locator.isChecked();
  return { selector, checked: actual, verified: actual === Boolean(checked) };
}

// --- uploads / downloads ---

export function describeLocalFiles(files) {
  return files.map((file) => {
    if (!existsSync(file)) throw codedError(`업로드할 파일이 없습니다: ${file}`, 'file_missing');
    const st = statSync(file);
    if (!st.isFile()) throw codedError(`파일이 아닙니다: ${file}`, 'file_missing');
    return { path: file, size: st.size };
  });
}

async function inputFiles(locator) {
  return locator.evaluate((el) => (el.files ? [...el.files].map((file) => ({ name: file.name, size: file.size, type: file.type })) : null));
}

// 숨은 input[type=file]은 setInputFiles로 바로 넣는다. 클릭해야 input이 생기는 화면은 파일 선택 창 이벤트를 가로챈다.
export async function uploadFiles(scope, { selector = null, chooserSelector = null, chooserText = null, files = [], timeout = 30000 } = {}) {
  const list = (Array.isArray(files) ? files : [files]).filter(Boolean).map(String);
  if (!list.length) throw new Error('업로드할 파일 경로가 없습니다.');
  const local = describeLocalFiles(list);
  if (selector) {
    const locator = scope.locator(selector).first();
    const large = local.some((item) => item.size > 45 * 1024 * 1024);
    let mode = 'input';
    if (large && scope === pageOf(scope)) {
      // 원격 연결로 파일 내용을 보내는 방식은 50MB 근처에서 실패한다. Chrome이 Windows 경로를 직접 읽게 한다.
      const page = pageOf(scope);
      const mark = `up${Date.now().toString(36)}`;
      await locator.evaluate((el, value) => el.setAttribute('data-cu-upload', value), mark);
      const session = await page.context().newCDPSession(page);
      try {
        const { root } = await session.send('DOM.getDocument', { depth: 0 });
        const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-cu-upload="${mark}"]` });
        if (!nodeId) throw new Error('파일 입력 요소를 CDP에서 찾지 못했습니다.');
        await session.send('DOM.setFileInputFiles', { nodeId, files: list });
        mode = 'cdp-path';
      } finally {
        await session.detach().catch(() => {});
      }
    } else {
      await locator.setInputFiles(list, { timeout });
    }
    const attached = await inputFiles(locator);
    return { mode, selector, local, attached, verified: Array.isArray(attached) && attached.length === list.length };
  }
  const page = pageOf(scope);
  const chooserPromise = page.waitForEvent('filechooser', { timeout });
  if (chooserSelector) await scope.locator(chooserSelector).first().click({ timeout });
  else if (chooserText) await clickText(scope, chooserText, { timeout });
  else throw new Error('파일 입력 선택자 또는 파일 선택 창을 여는 대상이 필요합니다.');
  const chooser = await chooserPromise;
  if (!chooser.isMultiple() && list.length > 1) throw new Error('이 파일 선택 창은 파일 하나만 받습니다.');
  await chooser.setFiles(list);
  const attached = await chooser.element().evaluate((el) => (el.files ? [...el.files].map((file) => ({ name: file.name, size: file.size, type: file.type })) : null)).catch(() => null);
  return { mode: 'chooser', local, attached, multiple: chooser.isMultiple(), verified: Array.isArray(attached) ? attached.length === list.length : null };
}

export function sniffFileKind(buffer) {
  const head = buffer.subarray(0, 8);
  const ascii = head.toString('latin1');
  if (ascii.startsWith('%PDF-')) return 'pdf';
  if (head[0] === 0x89 && ascii.slice(1, 4) === 'PNG') return 'png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (ascii.startsWith('GIF8')) return 'gif';
  if (ascii.startsWith('PK\u0003\u0004')) return 'zip-or-office';
  if (ascii.startsWith('RIFF')) return 'riff';
  const text = buffer.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if (text.startsWith('<!doctype html') || text.startsWith('<html')) return 'html';
  if (text.startsWith('{') || text.startsWith('[')) return 'json-or-text';
  return 'unknown';
}

// target: 문자열(저장 파일 경로) 또는 { file } / { dir }. dir이면 사이트가 준 파일 이름을 그대로 쓴다.
export async function downloadVia(page, trigger, target, { timeout = 60000 } = {}) {
  const downloadPromise = page.waitForEvent('download', { timeout });
  await trigger();
  const download = await downloadPromise;
  const failure = await download.failure();
  if (failure) throw new Error(`다운로드 실패: ${failure}`);
  const suggested = download.suggestedFilename() || `download_${Date.now()}`;
  const safeName = suggested.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_').slice(0, 180);
  const outPath = typeof target === 'string' ? target : (target.file || join(target.dir, safeName));
  mkdirSync(dirname(outPath), { recursive: true });
  await download.saveAs(outPath);
  const buffer = readFileSync(outPath);
  const kind = sniffFileKind(buffer);
  return {
    file: outPath,
    size: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    suggestedFilename: download.suggestedFilename(),
    kind,
    ...(kind === 'html' ? { warning: '파일 대신 HTML 화면이 내려왔습니다. 로그인 만료나 권한 문제일 수 있습니다.' } : {}),
  };
}

// --- network ---

const SECRET_PARAM = /token|auth|key|secret|sig|signature|session|password|passwd|code|ticket|jwt|otp/iu;

// 주소 쿼리에 실린 토큰류 값을 가린다. 경로와 일반 파라미터는 API를 알아보는 데 필요해 남긴다.
export function redactUrl(raw) {
  try {
    const url = new URL(raw);
    for (const name of [...url.searchParams.keys()]) {
      if (SECRET_PARAM.test(name)) url.searchParams.set(name, '[REDACTED]');
    }
    return url.toString();
  } catch {
    return String(raw || '');
  }
}

export function urlMatcher(match) {
  if (!match) return () => true;
  const value = String(match);
  const regex = value.match(/^\/(.+)\/([dgimsuy]*)$/su);
  if (regex) {
    const compiled = new RegExp(regex[1], regex[2].replace(/g/gu, ''));
    return (url) => compiled.test(url);
  }
  return (url) => url.includes(value);
}

// 사이트가 화면에 그리기 전에 받는 JSON 응답을 가로채 읽는다. 본문은 파일로만 남기고 요약만 돌려준다.
// bodies는 기본 꺼짐이다(개인정보). 데이터가 필요할 때만 켠다.
export async function captureResponses(page, { match = '', during = null, durationMs = 0, max = 50, bodies = false, maxBody = 500000, types = ['xhr', 'fetch', 'document'], stopAfter = 0 } = {}) {
  const matches = urlMatcher(match);
  const entries = [];
  const pending = [];
  let wake = null;
  const enough = new Promise((resolveEnough) => { wake = resolveEnough; });
  const onResponse = (response) => {
    const url = response.url();
    if (!matches(url) || entries.length >= max) return;
    const request = response.request();
    const type = request.resourceType();
    if (types.length && !types.includes(type)) return;
    const headers = response.headers();
    const entry = {
      url: redactUrl(url).slice(0, 600),
      method: request.method(),
      status: response.status(),
      type,
      contentType: String(headers['content-type'] || '').slice(0, 120),
      at: new Date().toISOString(),
    };
    entries.push(entry);
    if (stopAfter > 0 && entries.length >= stopAfter) wake();
    if (bodies && /json|text\/plain|javascript/iu.test(entry.contentType)) {
      pending.push(response.text().then((text) => {
        entry.chars = text.length;
        try {
          entry.json = JSON.parse(text);
        } catch {
          entry.text = text.slice(0, maxBody);
        }
      }).catch((error) => {
        entry.bodyError = String(error?.message || error).slice(0, 160);
      }));
    }
  };
  page.on('response', onResponse);
  try {
    if (during) await during();
    if (durationMs > 0) {
      let timer;
      await Promise.race([enough, new Promise((resolveWait) => { timer = setTimeout(resolveWait, durationMs); })]);
      clearTimeout(timer);
    }
  } finally {
    page.off('response', onResponse);
  }
  await Promise.allSettled(pending);
  return entries;
}

export function summarizeResponses(entries) {
  return entries.map((entry) => ({
    url: entry.url.slice(0, 200),
    method: entry.method,
    status: entry.status,
    type: entry.type,
    contentType: entry.contentType,
    chars: entry.chars ?? null,
    jsonKeys: entry.json && typeof entry.json === 'object' && !Array.isArray(entry.json) ? Object.keys(entry.json).slice(0, 20) : (Array.isArray(entry.json) ? [`array(${entry.json.length})`] : null),
  }));
}

const SECOND_LEVEL = new Set(['co', 'or', 'go', 'ne', 'ac', 're', 'pe', 'com', 'net', 'org', 'gov', 'edu']);

export function siteOf(hostname) {
  const parts = String(hostname || '').toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const keep = SECOND_LEVEL.has(parts.at(-2)) && parts.at(-1).length === 2 ? 3 : 2;
  return parts.slice(-keep).join('.');
}

// 로그인된 탭의 세션으로 같은 사이트의 JSON API를 읽는다. 다른 사이트 주소는 거부한다.
export async function fetchInPage(scope, url, { method = 'GET', body = undefined, headers = {}, timeout = 30000 } = {}) {
  const pageUrl = new URL(pageOf(scope).url());
  const target = new URL(url, pageUrl);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error(`http(s) 주소만 요청할 수 있습니다: ${target.href}`);
  if (siteOf(target.hostname) !== siteOf(pageUrl.hostname)) {
    throw new Error(`현재 탭과 다른 사이트에는 요청하지 않습니다: ${target.hostname} (현재 ${pageUrl.hostname})`);
  }
  return scope.evaluate(async ({ href, method, body, headers, timeout }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(href, {
        method,
        headers: { accept: 'application/json, text/plain, */*', ...(body !== undefined && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
        credentials: 'include',
        signal: controller.signal,
      });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return {
        status: response.status,
        ok: response.ok,
        url: response.url.slice(0, 600),
        redirected: response.redirected,
        contentType: response.headers.get('content-type') || '',
        chars: text.length,
        json,
        text: json === null ? text.slice(0, 20000) : undefined,
      };
    } finally {
      clearTimeout(timer);
    }
  }, { href: target.href, method: String(method || 'GET').toUpperCase(), body, headers, timeout }).then((result) => {
    // "ok"는 응답을 받았다는 뜻일 뿐이다. 로그아웃 상태의 401 JSON이나 로그인 HTML을 0건으로 오해하지 않게 따로 표시한다.
    const finalPath = (() => { try { const u = new URL(result.url); return `${u.hostname}${u.pathname}`; } catch { return result.url; } })();
    const loginSuspected = result.status === 401 || result.status === 403 || LOGIN_URL.test(finalPath)
      || (/text\/html/iu.test(result.contentType) && /type=["']?password|로그인|log ?in|sign ?in/iu.test(result.text || ''));
    return { ...result, loginSuspected };
  });
}

// --- reading ---

export async function readTable(scope, selector = 'table', { maxRows = 2000 } = {}) {
  const rows = await scope.evaluate(({ selector, maxRows }) => {
    const table = document.querySelector(selector);
    if (!table) return null;
    if (table.rows) return [...table.rows].slice(0, maxRows).map((row) => [...row.cells].map((cell) => cell.innerText.replace(/\s+/g, ' ').trim()));
    // role=grid / role=table 같은 div 표
    const rowEls = table.querySelectorAll('[role=row]');
    return [...rowEls].slice(0, maxRows).map((row) => [...row.querySelectorAll('[role=cell],[role=gridcell],[role=columnheader],[role=rowheader]')].map((cell) => cell.innerText.replace(/\s+/g, ' ').trim()));
  }, { selector, maxRows });
  if (rows === null) throw new Error(`표를 찾지 못했습니다: ${selector}`);
  return rows;
}

export async function readList(scope, itemSelector, fields = {}, { limit = 500 } = {}) {
  return scope.evaluate(({ itemSelector, fields, limit }) => {
    const items = [...document.querySelectorAll(itemSelector)].slice(0, limit);
    return items.map((item) => {
      const row = {};
      const entries = Object.entries(fields || {});
      if (!entries.length) return { text: item.innerText.replace(/\s+/g, ' ').trim() };
      for (const [key, sel] of entries) {
        const [css, attr] = String(sel).split('@');
        const el = css ? item.querySelector(css) : item;
        row[key] = el ? (attr ? el.getAttribute(attr) : el.innerText.replace(/\s+/g, ' ').trim()) : null;
      }
      return row;
    });
  }, { itemSelector, fields, limit });
}

// 화면을 처음 보는 AI가 선택자를 고를 수 있도록 상호작용 요소를 요약한다. 비밀번호 값은 싣지 않는다.
export async function inspectPage(scope, { within = null, limit = 150, includeHidden = false } = {}) {
  return scope.evaluate(({ within, limit, includeHidden, INTERACTIVE }) => {
    const norm = (value, max = 80) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
    const root = within ? document.querySelector(within) : document.body;
    if (!root) return { error: 'within_not_found' };
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.closest('[aria-hidden="true"]');
    };
    const cssEscape = (value) => (window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
    const unique = (selector) => {
      try { return document.querySelectorAll(selector).length === 1; } catch { return false; }
    };
    const labelFor = (el) => {
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ');
        if (text.trim()) return text;
      }
      if (el.id) {
        const label = document.querySelector(`label[for="${cssEscape(el.id)}"]`);
        if (label) return label.innerText;
      }
      const wrap = el.closest('label');
      if (wrap) return wrap.innerText;
      return el.getAttribute('placeholder') || el.getAttribute('title') || '';
    };
    const suggest = (el) => {
      const tag = el.tagName.toLowerCase();
      if (el.id && !/\d{4,}|[:.]/.test(el.id) && unique(`#${cssEscape(el.id)}`)) return `#${cssEscape(el.id)}`;
      for (const attr of ['data-testid', 'data-test', 'data-qa', 'name', 'aria-label', 'placeholder']) {
        const value = el.getAttribute(attr);
        if (value && value.length < 80) {
          const selector = `${tag}[${attr}="${value.replace(/"/g, '\\"')}"]`;
          if (unique(selector)) return selector;
        }
      }
      return '';
    };
    const headings = [...document.querySelectorAll('h1,h2,h3,[role=heading]')].filter(visible).slice(0, 12).map((el) => norm(el.innerText, 100)).filter(Boolean);
    const elements = [];
    let total = 0;
    for (const el of root.querySelectorAll(INTERACTIVE)) {
      if (!includeHidden && !visible(el)) continue;
      total++;
      if (elements.length >= limit) continue;
      const rect = el.getBoundingClientRect();
      const type = (el.getAttribute('type') || '').toLowerCase();
      const secret = type === 'password';
      const item = {
        i: elements.length + 1,
        tag: el.tagName.toLowerCase(),
        type: type || undefined,
        role: el.getAttribute('role') || undefined,
        text: norm(el.innerText || el.value && ['button', 'submit'].includes(type) ? (el.innerText || el.value) : el.innerText),
        label: norm(labelFor(el)),
        selector: suggest(el),
        rect: { x: Math.round(rect.left + scrollX), y: Math.round(rect.top + scrollY), w: Math.round(rect.width), h: Math.round(rect.height) },
      };
      if (el.matches('input,textarea,select')) item.value = secret ? (el.value ? '[비밀값]' : '') : norm(el.value, 60);
      if (el.matches('input[type=checkbox],input[type=radio]')) item.checked = el.checked;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') item.disabled = true;
      if (el.required) item.required = true;
      if (el.tagName === 'A') item.href = norm(el.getAttribute('href'), 160);
      if (el.tagName === 'SELECT') item.options = [...el.options].slice(0, 15).map((option) => norm(option.textContent, 40));
      if (el.tagName === 'IFRAME') item.src = norm(el.src, 160);
      for (const key of Object.keys(item)) if (item[key] === undefined || item[key] === '') delete item[key];
      elements.push(item);
    }
    const frames = [...document.querySelectorAll('iframe,frame')].filter(visible).slice(0, 10).map((el) => ({ name: el.name || '', src: norm(el.src, 160) }));
    return { url: location.href.slice(0, 300), title: norm(document.title, 120), headings, total, shown: elements.length, elements, iframes: frames };
  }, { within, limit, includeHidden, INTERACTIVE });
}

export async function ariaSnapshot(scope, { within = null, maxChars = 60000 } = {}) {
  const locator = scope.locator(within || 'body').first();
  if (typeof locator.ariaSnapshot !== 'function') throw new Error('이 Playwright 버전은 ariaSnapshot을 지원하지 않습니다.');
  const text = await locator.ariaSnapshot({ timeout: 15000 });
  return { chars: text.length, truncated: text.length > maxChars, snapshot: text.slice(0, maxChars) };
}

// 열린 모달·확인창·오버레이를 찾는다. "버튼이 안 눌린다"의 상당수는 보이지 않던 확인 모달 때문이다.
export async function visibleModals(scope) {
  return scope.evaluate(() => {
    const norm = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 20 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
    };
    const found = new Set();
    for (const el of document.querySelectorAll('dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]')) if (visible(el)) found.add(el);
    const vw = innerWidth;
    const vh = innerHeight;
    let scanned = 0;
    // 실측 기준: z-index 1000으로 거르면 z-index 150짜리 확인 모달을 놓쳤다. 100 이상, 150x60 이상을 본다.
    for (const el of document.body.querySelectorAll('*')) {
      if (++scanned > 8000) break;
      const style = getComputedStyle(el);
      if (!['fixed', 'absolute', 'sticky'].includes(style.position)) continue;
      const z = Number.parseInt(style.zIndex, 10);
      if (!Number.isFinite(z) || z < 100) continue;
      if (!visible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 150 || rect.height < 60) continue;
      const area = (Math.min(rect.right, vw) - Math.max(rect.left, 0)) * (Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
      if (area <= 0) continue;
      if (!norm(el.innerText, 10) && area / (vw * vh) < 0.5) continue;
      found.add(el);
    }
    const list = [...found].filter((el) => ![...found].some((other) => other !== el && other.contains(el) && norm(other.innerText, 2000) === norm(el.innerText, 2000)));
    for (const old of document.querySelectorAll('[data-cu-modal]')) old.removeAttribute('data-cu-modal');
    return list.map((el, index) => {
      el.setAttribute('data-cu-modal', String(index));
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const buttons = [...el.querySelectorAll('button,[role=button],a,input[type=button],input[type=submit]')].filter(visible).slice(0, 12).map((btn) => norm(btn.innerText || btn.value || btn.getAttribute('aria-label'), 40)).filter(Boolean);
      return {
        index,
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        role: el.getAttribute('role') || '',
        cls: norm(el.className, 80),
        zIndex: Number.parseInt(style.zIndex, 10) || 0,
        coversViewport: Math.round(((Math.min(rect.right, vw) - Math.max(rect.left, 0)) * (Math.min(rect.bottom, vh) - Math.max(rect.top, 0)) / (vw * vh)) * 100),
        text: norm(el.innerText, 300),
        buttons,
      };
    }).sort((a, b) => b.zIndex - a.zIndex).slice(0, 10);
  });
}

// --- scrolling ---

// 지연 로딩·가상 목록을 끝까지 내린다. 높이가 몇 번 연속 그대로면 끝에 닿은 것으로 본다.
export async function scrollUntil(scope, { container = null, stepPx = 800, maxSteps = 30, untilText = null, idleRounds = 3, waitMs = 600, wheel = false } = {}) {
  const page = pageOf(scope);
  const query = untilText ? parseTextQuery(untilText) : null;
  let idle = 0;
  let lastHeight = -1;
  let found = false;
  let steps = 0;
  let state = null;
  for (; steps < maxSteps; steps++) {
    if (wheel) {
      const box = container ? await scope.locator(container).first().boundingBox() : null;
      const size = page.viewportSize() || { width: 1200, height: 800 };
      await page.mouse.move(box ? box.x + box.width / 2 : size.width / 2, box ? box.y + box.height / 2 : size.height / 2);
      await page.mouse.wheel(0, stepPx);
    }
    state = await scope.evaluate(({ container, stepPx, wheel, query }) => {
      const el = container ? document.querySelector(container) : (document.scrollingElement || document.documentElement);
      if (!el) return { error: 'container_not_found' };
      const before = el.scrollTop;
      if (!wheel) el.scrollTop = before + stepPx;
      const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
      const hit = query ? (query.source ? new RegExp(query.source, query.flags).test(body) : body.includes(query.text)) : false;
      return { before, after: el.scrollTop, height: el.scrollHeight, client: el.clientHeight, hit };
    }, { container, stepPx, wheel, query });
    if (state.error) throw new Error(`스크롤 영역을 찾지 못했습니다: ${container}`);
    if (state.hit) { found = true; break; }
    await sleep(waitMs);
    const atBottom = state.after + state.client >= state.height - 2;
    if (state.height === lastHeight && (atBottom || state.after === state.before)) idle++;
    else idle = 0;
    lastHeight = state.height;
    if (idle >= idleRounds) break;
  }
  return { steps, found, reachedEnd: idle >= idleRounds, scrollTop: state?.after ?? null, scrollHeight: state?.height ?? null };
}

// 가상 목록은 스크롤하면 앞 항목이 DOM에서 사라진다. 그래서 내리는 동안 매번 읽어 키로 중복을 지운다.
// key: 'css@속성' | '@속성'(항목 자신) | 'css'(글자) | 생략(행 전체 글자)
export async function collectWhileScrolling(scope, { item, fields = {}, key = null, container = null, stepPx = 700, maxSteps = 40, waitMs = 700, idleRounds = 3, max = 5000, wheel = false } = {}) {
  if (!item) throw new Error('수집할 항목 선택자(item)가 필요합니다.');
  const page = pageOf(scope);
  const seen = new Map();
  let idle = 0;
  let steps = 0;
  let lastHeight = -1;
  for (; steps <= maxSteps; steps++) {
    const batch = await scope.evaluate(({ item, fields, key }) => {
      const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const pick = (root, spec) => {
        const [css, attr] = String(spec).split('@');
        const el = css ? root.querySelector(css) : root;
        if (!el) return null;
        return attr ? el.getAttribute(attr) : norm(el.innerText);
      };
      return [...document.querySelectorAll(item)].map((el) => {
        const row = {};
        const entries = Object.entries(fields || {});
        if (!entries.length) row.text = norm(el.innerText);
        for (const [name, spec] of entries) row[name] = pick(el, spec);
        row.__key = key ? pick(el, key) : JSON.stringify(row);
        return row;
      });
    }, { item, fields, key });
    let added = 0;
    for (const row of batch) {
      const id = row.__key ?? JSON.stringify(row);
      if (id === null || seen.has(id)) continue;
      const { __key, ...clean } = row;
      seen.set(id, clean);
      added++;
    }
    if (seen.size >= max || steps === maxSteps) break;
    if (wheel) {
      const box = container ? await scope.locator(container).first().boundingBox() : null;
      const size = page.viewportSize() || { width: 1200, height: 800 };
      await page.mouse.move(box ? box.x + box.width / 2 : size.width / 2, box ? box.y + box.height / 2 : size.height / 2);
      await page.mouse.wheel(0, stepPx);
    }
    const state = await scope.evaluate(({ container, stepPx, wheel }) => {
      const el = container ? document.querySelector(container) : (document.scrollingElement || document.documentElement);
      if (!el) return { error: true };
      const before = el.scrollTop;
      if (!wheel) el.scrollTop = before + stepPx;
      return { before, after: el.scrollTop, height: el.scrollHeight };
    }, { container, stepPx, wheel });
    if (state.error) throw new Error(`스크롤 영역을 찾지 못했습니다: ${container}`);
    await sleep(waitMs);
    const stuck = state.after === state.before && state.height === lastHeight;
    idle = added === 0 && stuck ? idle + 1 : (added === 0 ? idle + 1 : 0);
    lastHeight = state.height;
    if (idle >= idleRounds) break;
  }
  const items = [...seen.values()].slice(0, max);
  return { count: items.length, steps, reachedEnd: idle >= idleRounds, truncated: seen.size >= max, items };
}

// 페이지 품질 점검: 깨진 이미지, 가로 넘침, 너무 작은 글자. 콘솔 오류·실패 요청은 호출자가 모아 넘긴다.
export async function auditPage(scope, { checks = ['images', 'overflow', 'tiny-text'], minFontPx = 11 } = {}) {
  const found = await scope.evaluate(({ checks, minFontPx }) => {
    const norm = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
    const strip = (value) => String(value || '').replace(/[?#].*$/u, '').slice(0, 160);
    const out = {};
    if (checks.includes('images')) {
      out.images = [...document.images].filter((img) => img.complete && img.naturalWidth === 0 && (img.currentSrc || img.src)).slice(0, 30).map((img) => strip(img.currentSrc || img.src));
    }
    if (checks.includes('overflow')) {
      const width = document.documentElement.clientWidth;
      const pageOverflow = document.documentElement.scrollWidth - width;
      const wide = [];
      if (pageOverflow > 1) {
        for (const el of document.body.querySelectorAll('*')) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.right > width + 1 && getComputedStyle(el).position !== 'fixed') {
            wide.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className ? `.${el.className.split(/\s+/)[0]}` : ''} → ${Math.round(rect.right - width)}px`);
            if (wide.length >= 10) break;
          }
        }
      }
      out.overflow = pageOverflow > 1 ? { px: pageOverflow, elements: wide } : null;
    }
    if (checks.includes('tiny-text')) {
      const tiny = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      let scanned = 0;
      while ((node = walker.nextNode()) && scanned < 20000) {
        scanned++;
        const text = norm(node.textContent, 40);
        if (!text) continue;
        const el = node.parentElement;
        if (!el) continue;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
        const size = Number.parseFloat(style.fontSize);
        if (size < minFontPx) tiny.push(`${size}px "${text}"`);
        if (tiny.length >= 15) break;
      }
      out.tinyText = tiny;
    }
    return out;
  }, { checks, minFontPx });
  const failures = [];
  if (found.images?.length) failures.push({ check: 'images', count: found.images.length, sample: found.images.slice(0, 10) });
  if (found.overflow) failures.push({ check: 'overflow', count: found.overflow.elements.length || 1, px: found.overflow.px, sample: found.overflow.elements });
  if (found.tinyText?.length) failures.push({ check: 'tiny-text', count: found.tinyText.length, sample: found.tinyText.slice(0, 10) });
  return { failures, details: found };
}

// 캡처 전 준비: 지연 이미지를 불러오도록 끝까지 천천히 내렸다가 맨 위로 돌아오고, 이미지 로딩을 기다린다.
export async function primeForCapture(page, { stepPx = 600, waitMs = 250, maxSteps = 60, hideFixed = false, timeout = 15000 } = {}) {
  await page.evaluate(async ({ stepPx, waitMs, maxSteps }) => {
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    for (let index = 0; index < maxSteps; index++) {
      const before = scrollY;
      scrollBy(0, stepPx);
      await pause(waitMs);
      if (scrollY === before) break;
    }
    scrollTo(0, 0);
    await pause(waitMs);
  }, { stepPx, waitMs, maxSteps });
  await page.waitForFunction(() => [...document.images].every((img) => img.complete), null, { timeout }).catch(() => {});
  if (hideFixed) {
    await page.addStyleTag({ content: '[data-cu-fixed-hidden]{visibility:hidden !important}' });
    await page.evaluate(() => {
      for (const el of document.body.querySelectorAll('*')) {
        const position = getComputedStyle(el).position;
        if ((position === 'fixed' || position === 'sticky') && el.getBoundingClientRect().height < innerHeight * 0.6) el.setAttribute('data-cu-fixed-hidden', '1');
      }
    });
  }
  return page.evaluate(() => ({ cssHeight: document.documentElement.scrollHeight, cssWidth: document.documentElement.clientWidth, url: location.href }));
}

// --- validation (기존 validate 명령과 같은 규칙) ---

export async function validateForm(scope, submitSelector = '') {
  return scope.evaluate((selector) => {
    const submit = selector ? document.querySelector(selector) : null;
    if (selector && !submit) return { ok: false, error: 'submit_not_found', invalid: [], maxlength: [] };
    const root = selector ? submit.form : document;
    if (!root) return { ok: false, error: 'form_not_found', invalid: [], maxlength: [] };
    const fields = [...root.querySelectorAll('input,select,textarea')].filter((field) => field.type !== 'hidden' && !field.disabled);
    const invalid = fields.filter((field) => !field.checkValidity()).map((field) => ({ id: field.id || '', name: field.name || '', message: field.validationMessage || '' }));
    const maxlength = fields.filter((field) => field.maxLength >= 0 && String(field.value || '').length > field.maxLength).map((field) => ({ id: field.id || '', name: field.name || '', length: String(field.value || '').length, maxlength: field.maxLength }));
    return { ok: invalid.length === 0 && maxlength.length === 0, invalid, maxlength };
  }, submitSelector || '');
}

// 스니펫에 넘기는 묶음. 스니펫은 helpers.clickText(page, '저장')처럼 쓴다.
export const helpers = {
  version: WEB_HELPERS_VERSION,
  sleep,
  waitFor,
  waitText,
  bodyText,
  listFrames,
  resolveFrame,
  parseDialogPolicy,
  dismissedDecisions,
  watchWriteRequests,
  watchPopups,
  sessionState,
  normalizeWindow,
  screenshot,
  findByText,
  pickTextCandidate,
  hitCovered,
  selectorCovered,
  clickText,
  clickSelector,
  hover,
  setValue,
  selectExact,
  pickOption,
  setChecked,
  fieldByLabel,
  pageSignals,
  startToastWatch,
  stopToastWatch,
  dismissTopModal,
  findFrameWith,
  collectWhileScrolling,
  auditPage,
  primeForCapture,
  redactUrl,
  uploadFiles,
  downloadVia,
  captureResponses,
  summarizeResponses,
  fetchInPage,
  readTable,
  readList,
  inspectPage,
  ariaSnapshot,
  visibleModals,
  scrollUntil,
  validateForm,
  sniffFileKind,
  urlMatcher,
  siteOf,
};
