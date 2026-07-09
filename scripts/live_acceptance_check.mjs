#!/usr/bin/env node
// Redacted end-to-end acceptance check for a real Windows KakaoTalk/WeChat run.
//
// This checks the local web console and result counts without printing chat
// text, screenshots, local paths, or room names. Use it after a fresh Windows
// PC runs at least one KakaoTalk backup and one WeChat backup.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const options = {
  url: process.env.CU_CONSOLE_URL || 'http://127.0.0.1:8766',
  json: false,
  check: false,
  requireLiveChats: false,
  minWechatRooms: 1,
  minKakaoRooms: 1,
  packageDir: process.env.CU_PUBLIC_PACKAGE_DIR || '',
  outJson: '',
  outMd: '',
};

const requestTimeoutMs = (() => {
  const value = Number(process.env.CU_LIVE_ACCEPTANCE_TIMEOUT_MS || 20000);
  return Number.isFinite(value) && value > 0 ? value : 20000;
})();

for (let i = 2; i < process.argv.length; i++) {
  const cur = process.argv[i];
  if (cur === '--url') options.url = process.argv[++i];
  else if (cur.startsWith('--url=')) options.url = cur.slice('--url='.length);
  else if (cur === '--json') options.json = true;
  else if (cur === '--check') options.check = true;
  else if (cur === '--require-live-chats') options.requireLiveChats = true;
  else if (cur === '--min-wechat-rooms') options.minWechatRooms = Number(process.argv[++i]);
  else if (cur.startsWith('--min-wechat-rooms=')) options.minWechatRooms = Number(cur.slice('--min-wechat-rooms='.length));
  else if (cur === '--min-kakao-rooms') options.minKakaoRooms = Number(process.argv[++i]);
  else if (cur.startsWith('--min-kakao-rooms=')) options.minKakaoRooms = Number(cur.slice('--min-kakao-rooms='.length));
  else if (cur === '--package-dir') options.packageDir = process.argv[++i];
  else if (cur.startsWith('--package-dir=')) options.packageDir = cur.slice('--package-dir='.length);
  else if (cur === '--out-json') options.outJson = process.argv[++i];
  else if (cur.startsWith('--out-json=')) options.outJson = cur.slice('--out-json='.length);
  else if (cur === '--out-md') options.outMd = process.argv[++i];
  else if (cur.startsWith('--out-md=')) options.outMd = cur.slice('--out-md='.length);
  else if (cur === '-h' || cur === '--help') {
    usage();
    process.exit(0);
  } else {
    console.error(`알 수 없는 옵션입니다: ${cur}`);
    usage();
    process.exit(2);
  }
}

if (!Number.isFinite(options.minWechatRooms) || options.minWechatRooms < 0) {
  console.error('--min-wechat-rooms 값은 0 이상의 숫자여야 합니다.');
  process.exit(2);
}
if (!Number.isFinite(options.minKakaoRooms) || options.minKakaoRooms < 0) {
  console.error('--min-kakao-rooms 값은 0 이상의 숫자여야 합니다.');
  process.exit(2);
}

function usage() {
  console.error(`사용법:
  node scripts/live_acceptance_check.mjs [--url http://127.0.0.1:8766]
    [--json] [--check] [--require-live-chats]
    [--min-wechat-rooms 1] [--min-kakao-rooms 1]
    [--package-dir DIR]
    [--out-json FILE] [--out-md FILE]

실제 Windows PC에서 공개 ZIP 설치 후 카카오톡/위챗 백업을 각각 한 번 실행한 뒤 사용합니다.
채팅 본문, 방 이름, 스크린샷 경로는 출력하지 않습니다.`);
}

function baseUrl() {
  return String(options.url || '').replace(/\/+$/u, '');
}

function addCheck(checks, id, status, message, details = {}) {
  checks.push({ id, status, message, details });
}

const restartConsoleText = '브라우저와 검은 창을 닫고 압축을 푼 폴더의 1_백업_시작.bat를 다시 실행하세요.';

function consoleConnectionMessage(prefix, err) {
  const detail = String(err?.message || '응답하지 않습니다');
  return `${prefix}: ${detail}. ${restartConsoleText}`;
}

function statusFrom(checks) {
  if (checks.some((check) => check.status === 'fail')) return 'fail';
  if (checks.some((check) => check.status === 'review')) return 'review';
  return 'pass';
}

async function fetchText(path, fetchOptions = {}) {
  const controller = new AbortController();
  const requestedTimeoutMs = Number(fetchOptions.timeoutMs || requestTimeoutMs);
  const effectiveTimeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0 ? requestedTimeoutMs : requestTimeoutMs;
  const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);
  const { signal: callerSignal, timeoutMs: _timeoutMs, ...rest } = fetchOptions;
  if (callerSignal) callerSignal.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      cache: 'no-store',
      ...rest,
      signal: controller.signal,
    });
    return { res, text: await res.text() };
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`요청 시간이 초과됐습니다(${effectiveTimeoutMs}ms): ${path}`);
    throw new Error(`요청에 실패했습니다: ${path}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(path, fetchOptions = {}) {
  const { res, text } = await fetchText(path, fetchOptions);
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`JSON 응답이 아닙니다: ${path}`);
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status} ${path}`);
  return { res, data };
}

function n(value) {
  return Number(value || 0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chatRoomCount(data) {
  const counts = data?.counts || {};
  return n(counts.kakao_rooms) + n(counts.kakao_openchat_rooms) + n(counts.wechat_rooms);
}

function healthFromRooms(data) {
  const rooms = Array.isArray(data?.rooms) ? data.rooms : [];
  const counts = {
    rooms: rooms.length,
    messages: 0,
    kakao_rooms: 0,
    kakao_openchat_rooms: 0,
    wechat_rooms: 0,
    discord_rooms: 0,
  };
  for (const room of rooms) {
    const platform = String(room?.platform || '').toLowerCase();
    counts.messages += n(room?.message_count ?? room?.messages ?? room?.messageCount);
    if (platform === 'kakao_openchat') counts.kakao_openchat_rooms += 1;
    else if (platform === 'kakao') counts.kakao_rooms += 1;
    else if (platform === 'wechat') counts.wechat_rooms += 1;
    else if (platform === 'discord') counts.discord_rooms += 1;
  }
  return {
    schema: 'chat_artifact_viewer.health.v1',
    counts,
    derivedFrom: 'rooms',
  };
}

async function fetchResultViewerRoomsHealth() {
  const { data } = await fetchJson('/chat-viewer/api/rooms?platform=chat', {
    timeoutMs: requestTimeoutMs,
  });
  if (!Array.isArray(data?.rooms)) throw new Error('결과 방 목록 응답 형식이 예상과 다릅니다.');
  return { res: null, data: healthFromRooms(data) };
}

async function fetchResultViewerHealth() {
  let lastError = null;
  let lastResult = null;
  const attempts = 6;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await fetchJson('/chat-viewer/api/health?platform=chat', {
        timeoutMs: Math.min(requestTimeoutMs, 3500),
      });
      if (result.data?.schema !== 'chat_artifact_viewer.health.v1' || chatRoomCount(result.data) > 0) {
        return result;
      }
      lastResult = result;
    } catch (err) {
      lastError = err;
    }
    await sleep(650);
  }
  try {
    const fallback = await fetchResultViewerRoomsHealth();
    if (chatRoomCount(fallback.data) > 0 || !lastResult) return fallback;
  } catch (err) {
    if (lastError) throw lastError;
  }
  if (lastResult) return lastResult;
  if (lastError) throw lastError;
  throw new Error('결과 보기 API를 확인하지 못했습니다.');
}

function latestSuccessfulChatJobs(jobs = []) {
  const successful = (module, actions) => jobs.find((job) => (
    job?.module === module
    && actions.includes(job?.action)
    && job?.status === 'pass'
  ));
  return {
    kakao: successful('kakao', ['open_windows', 'visible_room', 'visible_batch', 'openchat']) || null,
    wechat: successful('wechat', ['current_room', 'visible_batch']) || null,
  };
}

function liveStatus(ok) {
  if (ok) return 'pass';
  return options.requireLiveChats ? 'fail' : 'review';
}

function liveJobStatus(ok, ready) {
  if (ok) return 'pass';
  if (ready === false) return 'review';
  return liveStatus(false);
}

function liveJobMessage(appName, ok, ready) {
  if (ok) return `${appName} 백업 성공 기록이 있습니다.`;
  if (ready === false) return `${appName} 백업 전 준비가 아직 끝나지 않아 성공 기록 확인 전 단계입니다.`;
  return `${appName} 백업 성공 기록이 아직 확인되지 않습니다.`;
}

function liveMissingMessage(appName, min, actual) {
  const prefix = `${appName} 결과 ${actual}/${min}`;
  if (options.requireLiveChats) return `${prefix}: 새 Windows PC 실사용 검증 기준을 만족하지 못했습니다.`;
  return `${prefix}: 실제 앱 백업 후 --require-live-chats로 다시 확인하세요.`;
}

function checkStatus(checks, id) {
  return checks.find((check) => check.id === id)?.status || '';
}

function isLoopbackTarget() {
  try {
    const parsed = new URL(baseUrl());
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
  } catch {
    return false;
  }
}

function doctorCheck(report, id) {
  return (Array.isArray(report?.checks) ? report.checks : []).find((check) => check?.id === id) || null;
}

function doctorStatus(report, id) {
  return String(doctorCheck(report, id)?.status || '');
}

const commonBackupCheckIds = ['node', 'powershell', 'shots_writable', 'state_writable', 'runs_writable', 'gui_apps'];

function doctorStatusForIds(report, ids) {
  const checks = ids
    .map((id) => doctorCheck(report, id))
    .filter(Boolean);
  return checks.length ? statusFrom(checks) : '';
}

function nextStepsFor(checks, summary) {
  const steps = [];
  const add = (text) => {
    if (text && !steps.includes(text)) steps.push(text);
  };

  if (checkStatus(checks, 'package_dir_exists') === 'fail' || checkStatus(checks, 'package_required_entries') === 'fail') {
    add('GitHub Release의 computer-use-public.zip을 다시 내려받아 압축을 푼 폴더를 --package-dir로 지정하세요.');
  }
  const consoleFailed = checkStatus(checks, 'console_health') === 'fail'
    || checkStatus(checks, 'console_beginner_ui') === 'fail'
    || checkStatus(checks, 'console_backup_routes') === 'fail';
  const likelyWindowsLoopbackMismatch = consoleFailed && process.platform !== 'win32' && isLoopbackTarget();
  if (likelyWindowsLoopbackMismatch) {
    add('Windows에서 열린 백업 화면을 검증할 때는 WSL 터미널이 아니라 Windows PowerShell에서 live_acceptance_check.mjs를 실행하세요. WSL의 127.0.0.1은 Windows 브라우저가 보는 백업 화면 주소와 다를 수 있습니다.');
    return steps;
  }
  if (consoleFailed) {
    add(restartConsoleText);
  }
  if (checkStatus(checks, 'result_viewer_health') === 'fail') {
    add('웹 화면의 결과 보기를 한 번 연 뒤 결과 새로고침을 누르고 검증을 다시 실행하세요.');
  }

  const readiness = summary.readiness || {};
  const kakaoOcrReady = !readiness.kakaoOcr || readiness.kakaoOcr === 'pass';
  const wechatOcrReady = !readiness.wechatOcr || readiness.wechatOcr === 'pass';
  if (!wechatOcrReady) {
    add('위챗 백업 성공 기록을 남기려면 먼저 웹 화면의 중국어 문자 인식 설치를 누르세요. Windows 권한 확인 창이 뜨면 예를 누르고, 창이 보이지 않으면 작업 표시줄의 새 권한 확인 창 또는 방패 아이콘을 확인하세요. 자동 설치가 막히면 Windows 언어 추가에서 중국어를 검색하고 중국어(간체, 중국) 또는 중국어(번체, 대만/홍콩) 중 하나를 기본 선택 그대로 설치하세요. 문자 인식 기능은 선택 해제하지 말고, 끝나면 상태 새로고침을 누르세요. 바로 바뀌지 않으면 1~2분 뒤 한 번 더 누르세요.');
  }
  if (!kakaoOcrReady) {
    add('카카오톡 백업 성공 기록을 남기려면 먼저 웹 화면의 한국어 문자 인식 설치를 누르세요. Windows 권한 확인 창이 뜨면 예를 누르고, 창이 보이지 않으면 작업 표시줄의 새 권한 확인 창 또는 방패 아이콘을 확인하세요. 자동 설치가 막히면 Windows 언어 추가에서 한국어를 검색하고 기본 선택 그대로 설치하세요. 문자 인식 기능은 선택 해제하지 말고, 끝나면 상태 새로고침을 누르세요. 바로 바뀌지 않으면 1~2분 뒤 한 번 더 누르세요.');
  }

  const hasKakaoResult = Number(summary.kakaoRooms || 0) >= Number(options.minKakaoRooms || 0);
  const hasWechatResult = Number(summary.wechatRooms || 0) >= Number(options.minWechatRooms || 0);
  if (!hasWechatResult && wechatOcrReady) {
    add('위챗 앱에서 백업할 방을 선택한 뒤 웹 화면의 1번 위챗 백업에서 지금 열린 위챗 방 백업을 실행하세요.');
  }
  if (!hasKakaoResult && kakaoOcrReady) {
    add('카카오톡 앱에서 백업할 방을 연 뒤 웹 화면의 카카오톡 백업에서 열린 채팅방 백업을 실행하세요.');
  }

  if (hasWechatResult && wechatOcrReady && checkStatus(checks, 'latest_wechat_job') !== 'pass') {
    add('위챗 결과는 보이지만 이번 웹 실행 성공 기록이 없습니다. 새 Windows PC 검증이면 1번 위챗 백업을 한 번 더 실행하세요.');
  }
  if (hasKakaoResult && kakaoOcrReady && checkStatus(checks, 'latest_kakao_job') !== 'pass') {
    add('카카오톡 결과는 보이지만 이번 웹 실행 성공 기록이 없습니다. 새 Windows PC 검증이면 카카오톡 열린 채팅방 백업을 한 번 더 실행하세요.');
  }

  if (steps.length === 0 && checks.some((check) => check.status === 'review')) {
    add('확인 필요 항목의 문장을 확인한 뒤 해당 화면에서 상태 새로고침 또는 결과 새로고침을 누르세요.');
  }
  return steps;
}

function readFileSafe(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function inspectPublicPackage(checks) {
  const dir = String(options.packageDir || '').trim();
  if (!dir) return;
  if (!existsSync(dir)) {
    addCheck(checks, 'package_dir_exists', 'fail', '공개 ZIP을 압축 해제한 폴더를 찾지 못했습니다.');
    return;
  }
  let isDirectory = false;
  try { isDirectory = statSync(dir).isDirectory(); } catch {}
  if (!isDirectory) {
    addCheck(checks, 'package_dir_exists', 'fail', '공개 ZIP 확인 대상이 폴더가 아닙니다.');
    return;
  }

  let rootEntries = [];
  try { rootEntries = readdirSync(dir).sort(); } catch {}
  addCheck(checks, 'package_dir_exists', 'pass', '공개 ZIP 압축 해제 폴더를 확인했습니다.', {
    entryCount: rootEntries.length,
  });

  const required = [
    '00_처음_여기부터.txt',
    '1_백업_시작.bat',
    '시작하기.bat',
    '3_문제_확인.txt',
    '4_준비_보고서.bat',
    '4_검증_보고서.bat',
    '5_정리_삭제.bat',
    'README.md',
    'docs',
    'scripts',
    'web',
  ];
  const missing = required.filter((name) => !existsSync(join(dir, name)));
  addCheck(
    checks,
    'package_required_entries',
    missing.length === 0 ? 'pass' : 'fail',
    missing.length === 0 ? '처음 실행에 필요한 파일과 폴더가 있습니다.' : '처음 실행에 필요한 파일이나 폴더가 빠졌습니다.',
    { missing },
  );

  const forbidden = [
    'START_HERE.txt',
    '0_처음_읽기.txt',
    '처음_읽기.txt',
    'PUBLIC_RELEASE_NOTES.md',
    'Computer-Use-Web.bat',
    'HANDOFF.md',
    'findings',
  ];
  const presentForbidden = forbidden.filter((name) => existsSync(join(dir, name)));
  const forbiddenScripts = [
    'Computer-Use-Web.bat',
    'test_live_acceptance_check.mjs',
    'release_readiness.mjs',
    'test_distribution_tools.sh',
  ].filter((name) => existsSync(join(dir, 'scripts', name)));
  addCheck(
    checks,
    'package_no_developer_entrypoints',
    presentForbidden.length === 0 && forbiddenScripts.length === 0 ? 'pass' : 'fail',
    presentForbidden.length === 0 && forbiddenScripts.length === 0
      ? '중복 안내 파일과 개발자용 진입점이 공개 폴더에 보이지 않습니다.'
      : '공개 폴더에 일반 사용자를 헷갈리게 할 파일이 남아 있습니다.',
    { root: presentForbidden, scripts: forbiddenScripts },
  );

  const firstGuide = readFileSafe(join(dir, '00_처음_여기부터.txt'));
  const troubleshootingGuide = readFileSafe(join(dir, '3_문제_확인.txt'));
  const readme = readFileSafe(join(dir, 'README.md'));
  const publicQuickstart = readFileSafe(join(dir, 'docs', 'public_quickstart.md'));
  const jobRunner = readFileSafe(join(dir, 'scripts', 'lib', 'job_runner.mjs'));
  const consoleIndex = readFileSafe(join(dir, 'web', 'console', 'index.html'));
  const consoleStyles = readFileSafe(join(dir, 'web', 'console', 'styles.css'));
  const chatViewerIndex = readFileSafe(join(dir, 'web', 'chat-viewer', 'index.html'));
  const chatViewerApp = readFileSafe(join(dir, 'web', 'chat-viewer', 'app.js'));
  const chatViewerStyles = readFileSafe(join(dir, 'web', 'chat-viewer', 'styles.css'));
  const launcher = readFileSafe(join(dir, '1_백업_시작.bat'));
  const startLauncher = readFileSafe(join(dir, '시작하기.bat'));
  const readinessLauncher = readFileSafe(join(dir, '4_준비_보고서.bat'));
  const reportLauncher = readFileSafe(join(dir, '4_검증_보고서.bat'));
  const bootstrap = readFileSafe(join(dir, 'scripts', '백업_화면_실행.bat'));
  const liveAcceptance = readFileSafe(join(dir, 'scripts', 'live_acceptance_check.mjs'));
  const startConsole = readFileSafe(join(dir, 'scripts', 'start_console.ps1'));
  const installWindows = readFileSafe(join(dir, 'scripts', 'install_windows.ps1'));
  const fullListText = `${firstGuide}\n${readme}\n${publicQuickstart}`;
  const launcherText = `${launcher}\n${startLauncher}`;
  const recoveryText = `${startConsole}\n${installWindows}`;
  const fullBackupTextOk = fullListText.includes('여러 방 저장')
    && fullListText.includes('위챗 통째 백업 확인')
    && fullListText.includes('카카오톡 통째 백업 확인')
    && fullListText.includes('통째 백업(왼쪽 목록 전체 순회)')
    && fullListText.includes('앱 창을 앞에 두고 왼쪽 채팅 목록이 보이게')
    && fullListText.includes('전체 목록 확인 준비 완료')
    && fullListText.includes('체크박스를 선택하고 `전체 목록 확인`')
    && fullListText.includes('목록 백업 실행');
  const roomSelectionTextOk = fullListText.includes('방 선택 완료')
    && fullListText.includes('방 선택 완료 표시가 필요합니다')
    && fullListText.includes('방 선택 완료 표시로 이동')
    && fullListText.includes('체크 위치로 돌아가고 잠깐 강조됩니다');
  const beginnerTextOk = firstGuide.includes('처음 볼 것은 두 개뿐입니다')
    && firstGuide.includes('1_백업_시작.bat를 더블클릭')
    && firstGuide.includes('4_준비_보고서.bat와 4_검증_보고서.bat는 지원용 보고서를 만들 때만 사용합니다. 처음 백업 시작 파일이 아닙니다')
    && firstGuide.includes('브라우저를 열기 어려운 상태에서 준비 상태만 보내야 하면 4_준비_보고서.bat를 실행합니다')
    && firstGuide.includes('첫 화면의 위챗 찾기 / 막힐 때 영역에서 검증 보고서를 누르거나, 진행 기록에서 검증 보고서를 누릅니다')
    && firstGuide.includes('브라우저를 찾기 어려울 때만 4_검증_보고서.bat를 실행합니다')
    && firstGuide.includes('1번 위챗 백업부터 시작하세요')
    && firstGuide.includes('아무 값도 입력하지 않습니다')
    && readme.includes('Windows에서 더블클릭')
    && readme.includes('computer-use-public.zip')
    && readme.includes('검증 보고서')
    && readme.includes('요청 시간이 초과됐습니다')
    && readme.includes('브라우저와 검은 창을 닫고')
    && fullBackupTextOk
    && roomSelectionTextOk
    && troubleshootingGuide.includes('카카오톡/위챗 백업 문제 확인')
    && troubleshootingGuide.includes('대부분은 아래 3가지만 하면 해결됩니다')
    && troubleshootingGuide.includes('아무 값도 입력하지 않습니다')
    && troubleshootingGuide.includes('위챗은 사라진 것이 아닙니다')
    && troubleshootingGuide.includes('방 선택 완료, 앱 창 앞에 둠 체크박스')
    && !/START_HERE\.txt|0_처음_읽기\.txt|처음_읽기\.txt|PUBLIC_RELEASE_NOTES|Computer-Use-Web\.bat/u.test(`${firstGuide}\n${readme}`);
  addCheck(
    checks,
    'package_beginner_text',
    beginnerTextOk ? 'pass' : 'fail',
    beginnerTextOk ? '첫 안내와 README가 일반 사용자용 흐름을 안내합니다.' : '첫 안내 또는 README에 중복/개발자용 안내가 남아 있습니다.',
    { fullBackupTextOk, roomSelectionTextOk },
  );

  const initialDashboardRequired = [
    'loading-dashboard',
    '1번 위챗 백업부터 시작하세요',
    '1번 위챗 바로 시작',
    '카카오톡 바로 시작',
    '위챗 통째 백업 확인',
    '카카오톡 통째 백업 확인',
    '통째 백업 순서',
    '앱을 앞에 두고 왼쪽 채팅 목록이 보이게 한 뒤',
    '후보 확인',
    '목록 백업 실행',
    '결과 보기와 전체 저장',
    '위챗은 1번입니다',
    '내 컴퓨터에 저장',
    '외부 전송 기본 꺼짐',
    'Windows 기본 백업',
    '입력할 내용 없음',
    '막힐 때만 자세히 보기',
  ];
  const missingInitialDashboard = initialDashboardRequired.filter((text) => !consoleIndex.includes(text));
  const initialDashboardStyleOk = consoleStyles.includes('.loading-panel.loading-dashboard')
    && consoleStyles.includes('.loading-choice')
    && consoleStyles.includes('.loading-action.primary')
    && consoleStyles.includes('.full-backup-mini-steps');
  addCheck(
    checks,
    'package_initial_dashboard',
    missingInitialDashboard.length === 0 && initialDashboardStyleOk ? 'pass' : 'fail',
    missingInitialDashboard.length === 0 && initialDashboardStyleOk
      ? '브라우저 준비 중에도 첫 화면에 위챗/카카오톡 백업 선택, 통째 백업 순서, 안전 안내가 보입니다.'
      : '브라우저 준비 중 첫 화면에 초보자용 백업 선택, 통째 백업 순서, 안전 안내 중 빠진 부분이 있습니다.',
    { missing: missingInitialDashboard, styleOk: initialDashboardStyleOk },
  );

  const fullListFiles = [
    'scripts/kakao_windows_batch.mjs',
    'scripts/kakao_rooms_from_ocr.mjs',
    'scripts/wechat_windows_batch.mjs',
    'scripts/lib/job_runner.mjs',
  ];
  const missingFullListFiles = fullListFiles.filter((name) => !existsSync(join(dir, name)));
  const kakaoBatch = readFileSafe(join(dir, 'scripts', 'kakao_windows_batch.mjs'));
  const wechatBatch = readFileSafe(join(dir, 'scripts', 'wechat_windows_batch.mjs'));
  const fullListDefaultCount = (jobRunner.match(/const fullList = allVisible !== false;/g) || []).length;
  const retryOk = kakaoBatch.includes('--room-retries')
    && kakaoBatch.includes('retry_attempts')
    && wechatBatch.includes('--room-retries')
    && wechatBatch.includes('retry_attempts')
    && jobRunner.includes("'--room-retries'")
    && fullListText.includes('방 재시도 횟수')
    && fullListText.includes('기본 1회 자동');
  const fullListTextOk = (
    (fullListText.includes('카카오톡/위챗 `왼쪽 목록 전체 순회`') || fullListText.includes('카카오톡이나 위챗에서 여러 방을 한 번에 저장'))
    && fullListText.includes('여러 방 저장')
    && fullListText.includes('위챗 통째 백업 확인')
    && fullListText.includes('카카오톡 통째 백업 확인')
    && fullListText.includes('통째 백업(왼쪽 목록 전체 순회)')
    && fullListText.includes('전체 목록 확인 준비 완료')
    && fullListText.includes('체크하고 전체 목록 확인을 누르면 후보 방 이름을 먼저 보여 줍니다')
    && fullListText.includes('전체 목록 확인')
    && fullListText.includes('전체 목록 확인 -> 후보 확인 -> 목록 백업 실행 -> 결과 보기와 전체 저장')
    && fullListText.includes('목록 백업 실행')
    && fullListText.includes('먼저 전체 목록 확인이 필요합니다')
    && fullListText.includes('후보를 찾지 못했다는 카드')
    && fullListText.includes('목록 확인 다시')
    && fullListText.includes('상한 늘려 전체 목록 다시 확인')
    && fullListText.includes('가능한 상한을 이미 최대로 올린 상태')
    && fullListText.includes('현재 후보로 목록 백업 실행')
    && fullListText.includes('확인 필요 방 보기')
    && fullListText.includes('앱 화면을 읽어 순회하는 백업')
    && fullListText.includes('내부 DB를 직접')
    && !fullListText.includes('카카오톡 목록 끝까지 순회는 아직')
  );
  addCheck(
    checks,
    'package_full_list_backups',
    missingFullListFiles.length === 0 && fullListTextOk && fullListDefaultCount >= 2 && retryOk ? 'pass' : 'fail',
    missingFullListFiles.length === 0 && fullListTextOk && fullListDefaultCount >= 2 && retryOk
      ? '카카오톡/위챗 통째 백업 파일, 기본값, 자동 재시도 안내가 공개 패키지에 들어 있습니다.'
      : '공개 패키지에 카카오톡/위챗 통째 백업 파일, 기본값, 자동 재시도 안내 중 빠진 부분이 있습니다.',
    { missingFiles: missingFullListFiles, fullListTextOk, fullListDefaultCount, retryOk },
  );

  const resultExportText = `${fullListText}\n${chatViewerIndex}\n${chatViewerApp}\n${chatViewerStyles}`;
  const resultExportUiOk = chatViewerIndex.includes('id="exportAllCsvButton"')
    && chatViewerIndex.includes('id="exportAllTextButton"')
    && chatViewerIndex.includes('전체 표 파일 저장')
    && chatViewerIndex.includes('전체 텍스트 저장')
    && chatViewerIndex.includes('전체 저장은 현재 왼쪽 목록 기준입니다')
    && chatViewerIndex.includes('검색이나 필터를 바꾸면 저장 범위도 바뀝니다')
    && chatViewerIndex.includes('표 파일 저장')
    && chatViewerIndex.includes('텍스트 저장');
  const resultExportCodeOk = chatViewerApp.includes('function exportAllRoomsCsv')
    && chatViewerApp.includes('function exportAllRoomsText')
    && chatViewerApp.includes('function allRoomExportData')
    && chatViewerApp.includes('방 번호')
    && chatViewerApp.includes('방 상태');
  const resultExportStyleOk = chatViewerStyles.includes('.export-actions')
    && chatViewerStyles.includes('.export-scope-hint')
    && chatViewerStyles.includes('#exportAllCsvButton')
    && chatViewerStyles.includes('#exportAllTextButton');
  const resultExportDocsOk = resultExportText.includes('현재 왼쪽 목록 전체')
    && resultExportText.includes('전체 표 파일 저장')
    && resultExportText.includes('전체 텍스트 저장')
    && resultExportText.includes('전체 저장은 현재 왼쪽 목록 기준')
    && resultExportText.includes('표 파일 저장')
    && resultExportText.includes('텍스트 저장');
  addCheck(
    checks,
    'package_result_exports',
    resultExportUiOk && resultExportCodeOk && resultExportStyleOk && resultExportDocsOk ? 'pass' : 'fail',
    resultExportUiOk && resultExportCodeOk && resultExportStyleOk && resultExportDocsOk
      ? '결과 보기에서 선택한 방과 현재 목록 전체를 표/텍스트로 저장할 수 있습니다.'
      : '공개 패키지 결과 보기에는 선택 방 저장과 현재 목록 전체 저장 버튼이 모두 있어야 합니다.',
    { resultExportUiOk, resultExportCodeOk, resultExportStyleOk, resultExportDocsOk },
  );

  const resultRecoveryOk = fullListText.includes('백업 폴더 열기')
    && chatViewerApp.includes('백업 폴더 열기')
    && chatViewerApp.includes('data-empty-folder')
    && chatViewerApp.includes('function openConsoleBackupFolder')
    && chatViewerApp.includes("action: 'open_backup_folder'")
    && chatViewerApp.includes("consoleUrl('/jobs')");
  addCheck(
    checks,
    'package_result_empty_recovery',
    resultRecoveryOk ? 'pass' : 'fail',
    resultRecoveryOk
      ? '결과가 비어 있을 때 결과 새로고침, 백업 폴더 열기, 진행 기록으로 바로 복구할 수 있습니다.'
      : '결과가 비어 있을 때 일반 사용자가 백업 폴더와 진행 기록을 바로 확인하는 흐름이 부족합니다.',
    { resultRecoveryOk },
  );

  const directRouteLauncherOk = startConsole.includes('Invoke-WebRequest -Uri "$baseUrl/backup"')
    && startConsole.includes('$wechatUrl = "$baseUrl/backup#wechat"')
    && startConsole.includes('$kakaoUrl = "$baseUrl/backup#kakao"')
    && startConsole.includes('2_1_위챗_백업.url')
    && startConsole.includes('2_2_카카오톡_백업.url')
    && startConsole.includes('2_3_위챗_통째백업.url')
    && startConsole.includes('2_4_카카오톡_통째백업.url');
  const launcherOk = launcher.includes('카카오톡/위챗 백업 화면을 준비합니다')
    && startLauncher.includes('카카오톡/위챗 백업 화면을 준비합니다')
    && launcher.includes('scripts\\백업_화면_실행.bat')
    && startLauncher.includes('scripts\\백업_화면_실행.bat')
    && launcherText.includes('여러 방을 한 번에 저장하려면 첫 화면의 위챗 통째 백업 확인 또는 카카오톡 통째 백업 확인을 누르세요')
    && bootstrap.includes('카카오톡/위챗 백업 화면을 여는 중입니다')
    && bootstrap.includes('아무 값도 입력하지 않습니다')
    && directRouteLauncherOk;
  addCheck(
    checks,
    'package_windows_launcher',
    launcherOk ? 'pass' : 'fail',
    launcherOk ? 'Windows 더블클릭 실행 파일이 한글 백업 화면 실행으로 연결됩니다.' : 'Windows 더블클릭 실행 파일 구성이 예상과 다릅니다.',
    { directRouteLauncherOk },
  );

  const launcherRequiredFileGuardOk = launcherText.includes('필수 실행 파일이 빠졌습니다')
    && launcherText.includes('scripts\\lib\\path_config.ps1')
    && launcherText.includes('computer_use_console_server.mjs')
    && bootstrap.includes('필수 실행 파일이 빠졌습니다')
    && bootstrap.includes('lib\\path_config.ps1')
    && bootstrap.includes('computer_use_console_server.mjs')
    && fullListText.includes('필수 실행 파일이 빠졌습니다');
  addCheck(
    checks,
    'package_launcher_required_file_guard',
    launcherRequiredFileGuardOk ? 'pass' : 'fail',
    launcherRequiredFileGuardOk
      ? '부분 압축 해제나 필수 파일 누락을 실행 초기에 한국어로 안내합니다.'
      : '부분 압축 해제나 필수 파일 누락 때 일반 사용자용 안내가 부족합니다.',
    { launcherRequiredFileGuardOk },
  );

  const reportLauncherOk = reportLauncher.includes('카카오톡/위챗 백업 검증 보고서를 만듭니다')
    && reportLauncher.includes('scripts\\live_acceptance_check.mjs')
    && reportLauncher.includes('--require-live-chats')
    && reportLauncher.includes('--package-dir')
    && reportLauncher.includes('--out-md')
    && reportLauncher.includes('실사용_검증_보고서.md')
    && reportLauncher.includes('채팅 본문, 방 이름, 스크린샷 경로는 보고서에 넣지 않습니다')
    && reportLauncher.includes('아무 값도 입력하지 않습니다')
    && reportLauncher.includes('state\\console_url.txt')
    && liveAcceptance.includes('computer-use.live-acceptance.v1')
    && liveAcceptance.includes('채팅 본문, 방 이름, 스크린샷 경로는 이 보고서에 포함하지 않습니다.');
  const readinessLauncherOk = readinessLauncher.includes('카카오톡/위챗 백업 준비 보고서를 만듭니다')
    && readinessLauncher.includes('scripts\\readiness_report.mjs')
    && readinessLauncher.includes('준비_확인_보고서.md')
    && readinessLauncher.includes('채팅 본문, 방 이름, 원본 스크린샷 파일 경로는 보고서에 넣지 않습니다')
    && readinessLauncher.includes('아무 값도 입력하지 않습니다');
  addCheck(
    checks,
    'package_live_report_launcher',
    reportLauncherOk && readinessLauncherOk ? 'pass' : 'fail',
    reportLauncherOk && readinessLauncherOk ? '더블클릭 준비/검증 보고서가 공개 패키지 안에서 한글/비공개 방식으로 실행됩니다.' : '더블클릭 준비/검증 보고서 실행 파일 또는 비공개 보고서 스크립트가 빠졌습니다.',
    { reportLauncherOk, readinessLauncherOk },
  );

  const recoveryOk = recoveryText.includes('여러 방을 한 번에 저장하려면 백업 화면의 "여러 방 저장" 영역에서 위챗 통째 백업 확인 또는 카카오톡 통째 백업 확인을 누릅니다')
    && recoveryText.includes('백업 화면의 준비 체크 위치로 이동합니다')
    && recoveryText.includes('앱 창과 왼쪽 목록 준비를 체크한 뒤 전체 목록 확인을 누릅니다')
    && recoveryText.includes('바로 클릭하지 않고 전체 목록 확인으로 후보 방 이름을 먼저 보여 준 뒤, 후보가 맞을 때 목록 백업 실행으로 이어집니다')
    && recoveryText.includes('위챗 문자 인식 준비가 필요하다고 나오면 백업 화면의 중국어 문자 인식 설치를 먼저 누릅니다')
    && recoveryText.includes('중국어(간체, 중국) 또는 중국어(번체, 대만/홍콩) 중 하나를 기본 선택 그대로 설치하고 문자 인식 기능은 선택 해제하지 않습니다');
  addCheck(
    checks,
    'package_windows_recovery_guidance',
    recoveryOk ? 'pass' : 'fail',
    recoveryOk ? 'Windows 문제 확인 안내가 여러 방 저장과 중국어 문자 인식 복구 흐름을 설명합니다.' : 'Windows 문제 확인 안내에 여러 방 저장 또는 중국어 문자 인식 복구 흐름이 빠졌습니다.',
    {
      startConsolePresent: Boolean(startConsole),
      installWindowsPresent: Boolean(installWindows),
    },
  );

  const storageRecoveryOk = fullListText.includes('백업 저장 폴더를 준비하지 못했습니다')
    && troubleshootingGuide.includes('백업 저장 폴더를 준비하지 못했습니다')
    && startConsole.includes('Assert-ConsoleStorageReady')
    && installWindows.includes('Assert-LocalStorageReady')
    && recoveryText.includes('압축을 푼 폴더 전체를 바탕화면이나 문서처럼 내가 저장할 수 있는 일반 폴더로 옮긴 뒤 1_백업_시작.bat를 다시 실행하세요');
  addCheck(
    checks,
    'package_storage_recovery',
    storageRecoveryOk ? 'pass' : 'fail',
    storageRecoveryOk
      ? '저장 폴더를 만들거나 쓸 수 없을 때 일반 사용자용 복구 안내를 보여줍니다.'
      : '저장 폴더 생성/쓰기 실패 때 일반 사용자용 복구 안내가 부족합니다.',
    { storageRecoveryOk },
  );
}

async function run() {
  const checks = [];
  let consoleHealth = null;
  let resultHealth = null;
  let doctorReport = null;
  let jobs = [];
  let readinessSummary = {};

  inspectPublicPackage(checks);

  try {
    const { data } = await fetchJson('/api/health');
    consoleHealth = data;
    addCheck(
      checks,
      'console_health',
      data?.ok && data?.schema === 'computer-use.console-health.v1' ? 'pass' : 'fail',
      data?.ok ? '로컬 백업 화면이 응답합니다.' : '로컬 백업 화면 상태가 정상으로 보이지 않습니다.',
      {
        tokenRequired: Boolean(data?.tokenRequired),
        rootHash: data?.instance?.rootHash || '',
      },
    );
    addCheck(
      checks,
      'local_no_token',
      data?.tokenRequired === false ? 'pass' : 'fail',
      data?.tokenRequired === false ? '기본 로컬 접속은 따로 입력할 내용이 없습니다.' : '기본 사용자가 추가 입력을 해야 하는 상태입니다.',
    );
  } catch (err) {
    addCheck(checks, 'console_health', 'fail', consoleConnectionMessage('로컬 백업 화면에 연결하지 못했습니다', err));
  }

  try {
    const { text } = await fetchText('/');
    const required = [
      '위챗/카카오톡 백업',
      'quickWechatBtn',
      '1번 위챗 바로 시작',
      '카카오톡 바로 시작',
      '결과 보기',
      'loading-dashboard',
      '위챗 통째 백업 확인',
      '카카오톡 통째 백업 확인',
      '앱을 앞에 두고 왼쪽 채팅 목록이 보이게 한 뒤',
      '위챗은 1번입니다',
      '내 컴퓨터에 저장',
      '외부 전송 기본 꺼짐',
      'Windows 기본 백업',
      '입력할 내용 없음',
    ];
    const missing = required.filter((value) => !text.includes(value));
    const ok = missing.length === 0;
    addCheck(
      checks,
      'console_beginner_ui',
      ok ? 'pass' : 'fail',
      ok ? '첫 화면에 위챗/카카오톡 백업 진입점과 기본 안전 안내가 있습니다.' : '첫 화면에서 초보자용 백업 진입점이나 기본 안전 안내를 확인하지 못했습니다.',
      { missing },
    );
  } catch (err) {
    addCheck(checks, 'console_beginner_ui', 'fail', consoleConnectionMessage('첫 화면을 읽지 못했습니다', err));
  }

  try {
    const routes = ['/backup', '/backup#wechat', '/backup#kakao', '/backup#wechat-full', '/backup#kakao-full'];
    const results = [];
    for (const route of routes) {
      try {
        const { res, text } = await fetchText(route);
        const ok = res.ok && text.includes('위챗/카카오톡 백업') && text.includes('quickWechatBtn');
        results.push({ route, ok, status: res.status });
      } catch (err) {
        results.push({ route, ok: false, error: String(err?.message || err || '요청 실패') });
      }
    }
    const failed = results.filter((result) => !result.ok);
    addCheck(
      checks,
      'console_backup_routes',
      failed.length === 0 ? 'pass' : 'fail',
      failed.length === 0
        ? '위챗/카카오톡/통째백업 직접 주소가 모두 같은 백업 화면으로 열립니다.'
        : '위챗/카카오톡/통째백업 직접 주소 중 열리지 않는 주소가 있습니다.',
      { routes: results },
    );
  } catch (err) {
    addCheck(checks, 'console_backup_routes', 'fail', consoleConnectionMessage('백업 직접 주소를 확인하지 못했습니다', err));
  }

  try {
    const { data } = await fetchJson('/api/doctor');
    doctorReport = data;
    const readiness = {
      status: String(data?.status || ''),
      backupStatus: String(data?.backupStatus || doctorStatusForIds(data, [...commonBackupCheckIds, 'windows_ocr_ko', 'windows_ocr_zh']) || data?.status || ''),
      kakaoStatus: String(data?.kakaoStatus || doctorStatusForIds(data, [...commonBackupCheckIds, 'windows_ocr_ko']) || ''),
      wechatStatus: String(data?.wechatStatus || doctorStatusForIds(data, [...commonBackupCheckIds, 'windows_ocr_zh']) || ''),
      optionalStatus: String(data?.optionalStatus || ''),
      kakaoOcr: doctorStatus(data, 'windows_ocr_ko') || doctorStatus(data, 'windows_ocr'),
      wechatOcr: doctorStatus(data, 'windows_ocr_zh') || doctorStatus(data, 'windows_ocr'),
      apps: doctorStatus(data, 'gui_apps'),
      node: doctorStatus(data, 'node'),
      shotsWritable: doctorStatus(data, 'shots_writable'),
    };
    const missing = [];
    if (readiness.node && readiness.node !== 'pass') missing.push('백업 화면 실행 도구');
    if (readiness.shotsWritable && readiness.shotsWritable !== 'pass') missing.push('백업 저장 폴더');
    if (readiness.kakaoOcr && readiness.kakaoOcr !== 'pass') missing.push('카카오톡 한국어 문자 인식');
    if (readiness.wechatOcr && readiness.wechatOcr !== 'pass') missing.push('위챗 중국어 문자 인식');
    readinessSummary = readiness;
    addCheck(
      checks,
      'backup_readiness',
      missing.length ? 'review' : 'pass',
      missing.length ? `백업 준비 확인 필요: ${missing.join(', ')}` : '카카오톡/위챗 기본 백업 준비가 확인됐습니다.',
      readiness,
    );
    if (options.requireLiveChats) {
      addCheck(
        checks,
        'live_prerequisites',
        missing.length ? 'fail' : 'pass',
        missing.length
          ? `실사용 검증 전 준비가 끝나지 않았습니다: ${missing.join(', ')}`
          : '실사용 검증 전 준비가 끝났습니다.',
        readiness,
      );
    }
  } catch (err) {
    addCheck(checks, 'backup_readiness', 'review', `준비 확인을 읽지 못했습니다: ${err.message}`);
  }

  try {
    const { data } = await fetchJson('/api/jobs');
    jobs = Array.isArray(data.jobs) ? data.jobs : [];
    const successful = latestSuccessfulChatJobs(jobs);
    const kakaoReadyForLive = readinessSummary.kakaoOcr ? readinessSummary.kakaoOcr === 'pass' : true;
    const wechatReadyForLive = readinessSummary.wechatOcr ? readinessSummary.wechatOcr === 'pass' : true;
    addCheck(
      checks,
      'latest_kakao_job',
      liveJobStatus(Boolean(successful.kakao), kakaoReadyForLive),
      liveJobMessage('카카오톡', Boolean(successful.kakao), kakaoReadyForLive),
    );
    addCheck(
      checks,
      'latest_wechat_job',
      liveJobStatus(Boolean(successful.wechat), wechatReadyForLive),
      liveJobMessage('위챗', Boolean(successful.wechat), wechatReadyForLive),
    );
  } catch (err) {
    addCheck(checks, 'job_history', 'review', `진행 기록을 확인하지 못했습니다: ${err.message}`);
  }

  try {
    const { res } = await fetchText('/chat-viewer/', { redirect: 'manual' });
    const location = res.headers.get('location') || '';
    addCheck(
      checks,
      'direct_result_scope',
      res.status === 302 && location.includes('scope=chat') ? 'pass' : 'fail',
      res.status === 302 && location.includes('scope=chat')
        ? '직접 결과 주소도 카카오톡/위챗 범위로 들어갑니다.'
        : '직접 결과 주소가 카카오톡/위챗 범위로 제한되지 않았습니다.',
    );
  } catch (err) {
    addCheck(checks, 'direct_result_scope', 'fail', `결과 주소 범위를 확인하지 못했습니다: ${err.message}`);
  }

  try {
    const { data } = await fetchResultViewerHealth();
    resultHealth = data;
    const counts = data.counts || {};
    const kakaoRooms = n(counts.kakao_rooms) + n(counts.kakao_openchat_rooms);
    const wechatRooms = n(counts.wechat_rooms);
    addCheck(
      checks,
      'result_viewer_health',
      data?.schema === 'chat_artifact_viewer.health.v1' ? 'pass' : 'fail',
      data?.schema === 'chat_artifact_viewer.health.v1' ? '결과 보기 API가 응답합니다.' : '결과 보기 API 형식이 예상과 다릅니다.',
      {
        rooms: n(counts.rooms),
        messages: n(counts.messages),
        kakaoRooms,
        wechatRooms,
        discordRooms: n(counts.discord_rooms),
      },
    );
    addCheck(
      checks,
      'kakao_result_present',
      kakaoRooms >= options.minKakaoRooms ? 'pass' : liveStatus(false),
      kakaoRooms >= options.minKakaoRooms
        ? `카카오톡 결과가 ${kakaoRooms}개 이상 확인됐습니다.`
        : liveMissingMessage('카카오톡', options.minKakaoRooms, kakaoRooms),
    );
    addCheck(
      checks,
      'wechat_result_present',
      wechatRooms >= options.minWechatRooms ? 'pass' : liveStatus(false),
      wechatRooms >= options.minWechatRooms
        ? `위챗 결과가 ${wechatRooms}개 이상 확인됐습니다.`
        : liveMissingMessage('위챗', options.minWechatRooms, wechatRooms),
    );
    addCheck(
      checks,
      'discord_hidden_in_chat_scope',
      n(counts.discord_rooms) === 0 ? 'pass' : 'fail',
      n(counts.discord_rooms) === 0 ? '기본 결과 범위에 디스코드 결과가 섞이지 않았습니다.' : '기본 결과 범위에 디스코드 결과가 섞였습니다.',
    );
  } catch (err) {
    addCheck(checks, 'result_viewer_health', 'fail', `결과 보기 API를 확인하지 못했습니다: ${err.message}`);
  }

  try {
    const { data } = await fetchJson('/chat-viewer/api/rooms?platform=discord');
    const discordRooms = (data.rooms || []).filter((room) => room?.platform === 'discord').length;
    addCheck(
      checks,
      'forced_discord_query_hidden',
      discordRooms === 0 ? 'pass' : 'fail',
      discordRooms === 0 ? '강제로 디스코드를 요청해도 기본 콘솔에서는 보이지 않습니다.' : '강제 디스코드 요청에서 디스코드 방이 노출됐습니다.',
      { returnedRooms: Array.isArray(data.rooms) ? data.rooms.length : 0 },
    );
  } catch (err) {
    addCheck(checks, 'forced_discord_query_hidden', 'fail', `강제 디스코드 요청을 확인하지 못했습니다: ${err.message}`);
  }

  const summary = {
    tokenRequired: Boolean(consoleHealth?.tokenRequired),
    packageChecked: Boolean(String(options.packageDir || '').trim()),
    rooms: n(resultHealth?.counts?.rooms),
    messages: n(resultHealth?.counts?.messages),
    kakaoRooms: n(resultHealth?.counts?.kakao_rooms) + n(resultHealth?.counts?.kakao_openchat_rooms),
    wechatRooms: n(resultHealth?.counts?.wechat_rooms),
    discordRooms: n(resultHealth?.counts?.discord_rooms),
    jobs: jobs.length,
    readiness: {
      status: String(doctorReport?.status || ''),
      backupStatus: String(doctorReport?.backupStatus || doctorStatusForIds(doctorReport, [...commonBackupCheckIds, 'windows_ocr_ko', 'windows_ocr_zh']) || doctorReport?.status || ''),
      kakaoStatus: String(doctorReport?.kakaoStatus || doctorStatusForIds(doctorReport, [...commonBackupCheckIds, 'windows_ocr_ko']) || ''),
      wechatStatus: String(doctorReport?.wechatStatus || doctorStatusForIds(doctorReport, [...commonBackupCheckIds, 'windows_ocr_zh']) || ''),
      optionalStatus: String(doctorReport?.optionalStatus || ''),
      kakaoOcr: doctorStatus(doctorReport, 'windows_ocr_ko') || doctorStatus(doctorReport, 'windows_ocr'),
      wechatOcr: doctorStatus(doctorReport, 'windows_ocr_zh') || doctorStatus(doctorReport, 'windows_ocr'),
      apps: doctorStatus(doctorReport, 'gui_apps'),
      node: doctorStatus(doctorReport, 'node'),
      shotsWritable: doctorStatus(doctorReport, 'shots_writable'),
    },
  };

  const report = {
    schema: 'computer-use.live-acceptance.v1',
    generated_at: new Date().toISOString(),
    url: baseUrl(),
    requireLiveChats: options.requireLiveChats,
    status: statusFrom(checks),
    summary,
    nextSteps: nextStepsFor(checks, summary),
    checks,
  };
  return report;
}

function markdown(report) {
  const lines = [];
  const statusLabel = (status) => ({
    pass: '정상',
    review: '확인 필요',
    fail: '실패',
  }[String(status || '').toLowerCase()] || String(status || '확인 불가'));
  lines.push('# Windows 실사용 검증 결과');
  lines.push('');
  lines.push(`- 상태: ${statusLabel(report.status)} (${report.status})`);
  lines.push(`- 주소: ${report.url}`);
  lines.push(`- 기본 추가 입력 요구: ${report.summary.tokenRequired ? '예' : '아니오'}`);
  lines.push(`- 공개 ZIP 폴더 확인: ${report.summary.packageChecked ? '예' : '아니오'}`);
  lines.push(`- 카카오톡 결과: ${report.summary.kakaoRooms}`);
  lines.push(`- 위챗 결과: ${report.summary.wechatRooms}`);
  lines.push(`- 전체 메시지 수: ${report.summary.messages}`);
  lines.push(`- 디스코드 노출: ${report.summary.discordRooms}`);
  if (report.summary.readiness?.status) {
    const backupStatus = report.summary.readiness.backupStatus || report.summary.readiness.status;
    lines.push(`- 백업 준비: ${statusLabel(backupStatus)} (${backupStatus})`);
    if (report.summary.readiness.kakaoStatus) lines.push(`- 카카오톡 준비: ${statusLabel(report.summary.readiness.kakaoStatus)} (${report.summary.readiness.kakaoStatus})`);
    if (report.summary.readiness.wechatStatus) lines.push(`- 위챗 준비: ${statusLabel(report.summary.readiness.wechatStatus)} (${report.summary.readiness.wechatStatus})`);
    lines.push(`- 전체 준비 확인: ${statusLabel(report.summary.readiness.status)} (${report.summary.readiness.status})`);
  }
  if (Array.isArray(report.nextSteps) && report.nextSteps.length) {
    lines.push('');
    lines.push('## 다음 행동');
    lines.push('');
    for (const step of report.nextSteps) lines.push(`- ${step}`);
  }
  lines.push('');
  lines.push('| 항목 | 상태 | 결과 |');
  lines.push('| --- | --- | --- |');
  for (const check of report.checks) {
    lines.push(`| ${check.id} | ${statusLabel(check.status)} (${check.status}) | ${String(check.message || '').replace(/\|/gu, '/')} |`);
  }
  lines.push('');
  lines.push('채팅 본문, 방 이름, 스크린샷 경로는 이 보고서에 포함하지 않습니다.');
  return `${lines.join('\n')}\n`;
}

const report = await run();
const md = markdown(report);
if (options.outJson) writeFileSync(options.outJson, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
if (options.outMd) writeFileSync(options.outMd, `\uFEFF${md}`, 'utf8');

if (options.json) console.log(JSON.stringify(report, null, 2));
else process.stdout.write(md);

if (options.check && report.status === 'fail') process.exit(1);
