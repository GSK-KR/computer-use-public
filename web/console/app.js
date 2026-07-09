const tokenFromUrl = new URL(location.href).searchParams.get('token');
if (tokenFromUrl) {
  const cleanUrl = new URL(location.href);
  cleanUrl.searchParams.delete('token');
  history.replaceState(null, '', `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
}
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
let authenticated = false;
let localAuthTried = false;
let activeJobId = '';
let activeJobLabel = '';
let activeJobClearTimer = 0;
let eventSource = null;
let wechatBatchPreviewSignature = '';
let kakaoBatchPreviewSignature = '';
let dashboardRenderToken = 0;
let backupRenderToken = 0;
let chatsRenderToken = 0;
let resultsWide = false;
let queuedDoctorReport = null;
let backupReturnNotice = '';

const view = document.querySelector('#view');
const title = document.querySelector('#pageTitle');
const meta = document.querySelector('#pageMeta');
const healthText = document.querySelector('#healthText');
const providerBadge = document.querySelector('#providerBadge');
const activeJobBadge = document.querySelector('#activeJobBadge');
const refreshBtn = document.querySelector('#refreshBtn');
const stopBtn = document.querySelector('#stopBtn');
const quickWechatBtn = document.querySelector('#quickWechatBtn');
const quickChatsBtn = document.querySelector('#quickChatsBtn');

const routes = {
  '/': dashboardView,
  '/backup': backupView,
  '/doctor': doctorView,
  '/jobs': jobsView,
  '/agent': agentView,
  '/chats': chatsView,
  '/settings': settingsView,
};

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['content-type']) headers['content-type'] = 'application/json';
  const res = await fetch(path, { ...options, headers });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

async function tryLocalAuth() {
  if (localAuthTried) return false;
  localAuthTried = true;
  try {
    const res = await fetch('/auth/local', { cache: 'no-store', redirect: 'follow' });
    return res.ok;
  } catch {
    return false;
  }
}

function routePath() {
  return routes[location.pathname] ? location.pathname : '/';
}

function hashTargetId() {
  if (!location.hash) return '';
  try {
    return decodeURIComponent(location.hash.slice(1));
  } catch {
    return location.hash.slice(1);
  }
}

function selectedJobFromHash() {
  const raw = location.hash ? location.hash.slice(1) : '';
  if (!raw) return '';
  try {
    const params = new URLSearchParams(raw);
    return params.get('job') || '';
  } catch {
    return '';
  }
}

function scrollToHashTarget() {
  const targetId = hashTargetId();
  if (!targetId) return;
  const target = document.getElementById(targetId);
  if (!target) {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    return;
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const rect = target.getBoundingClientRect();
      if (rect.top >= 0 && rect.top < window.innerHeight * 0.75) return;
      const topOffset = window.matchMedia('(max-width: 820px)').matches ? 14 : 92;
      const top = Math.max(0, window.scrollY + rect.top - topOffset);
      window.scrollTo({ top, left: 0, behavior: 'auto' });
    });
  });
}

function setChrome(name, detail) {
  title.textContent = name;
  meta.textContent = detail || '이 컴퓨터에서만 열리는 백업 화면';
  const path = routePath();
  const hash = location.hash || '';
  const links = Array.from(document.querySelectorAll('.nav a'));
  const exactHashLink = links.some((a) => {
    const url = new URL(a.getAttribute('href') || '/', location.origin);
    return url.pathname === path && url.hash && url.hash === hash;
  });
  links.forEach((a) => {
    const url = new URL(a.getAttribute('href') || '/', location.origin);
    const active = url.hash
      ? url.pathname === path && url.hash === hash
      : url.pathname === path && (!exactHashLink || !hash);
    a.classList.toggle('active', active);
  });
}

function statusClass(status) {
  return `status-${String(status || '').toLowerCase()}`;
}

function statusLabel(status) {
  const labels = {
    ready: '준비됨',
    offline: '오프라인',
    pass: '정상',
    review: '확인 필요',
    fail: '실패',
    running: '실행 중',
    stopped: '중지됨',
    stopping: '중지 중',
    locked: '잠김',
  };
  return labels[String(status || '').toLowerCase()] || String(status || '-');
}

function displayNumber(value) {
  return new Intl.NumberFormat('ko-KR').format(Number(value || 0));
}

function parseDisplayNumber(value) {
  return Number(String(value || '0').replace(/[^\d]/gu, '')) || 0;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(path, options = {}, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(path, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithTimeout(path, options = {}, timeoutMs = 1500) {
  try {
    const res = await fetchWithTimeout(path, options, timeoutMs);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function friendlyFailureLogLine(text) {
  const message = String(text || '').replace(/^FAIL\s+/iu, '').trim();
  if (/Windows OCR language 'zh/i.test(message)) {
    return '확인 필요: 위챗 백업에 필요한 중국어 문자 인식이 없습니다. 문자 인식 설정을 열고 중국어(간체, 중국) 또는 중국어(번체, 대만/홍콩) 중 하나를 기본 선택 그대로 설치한 뒤 상태 새로고침을 누르세요.';
  }
  if (/Windows OCR language 'ko/i.test(message)) {
    return '확인 필요: 카카오톡 백업에 필요한 한국어 문자 인식이 없습니다. 문자 인식 설정을 열고 한국어를 기본 선택 그대로 설치한 뒤 상태 새로고침을 누르세요.';
  }
  if (/Windows OCR language .* is not installed|no OCR engine|Windows OCR failed|OCR failed/iu.test(message)) {
    return '확인 필요: 화면 문자 인식에 실패했습니다. Windows 언어 설정에서 필요한 언어 기능을 확인한 뒤 다시 시도하세요.';
  }
  if (/WeChat capture failed|no frame_.*captured|capture failed hwnd|GetWindowRect failed/iu.test(message)) {
    return '확인 필요: 위챗 화면을 캡처하지 못했습니다. 위챗을 열고 백업할 방을 선택한 뒤 창을 가리지 말고 다시 시작하세요.';
  }
  if (/KakaoTalk.*(?:capture|window|room list|click) failed|could not capture KakaoTalk|failed to resolve KakaoTalk|scrape_capture\.ps1 failed/iu.test(message)) {
    return '확인 필요: 카카오톡 화면을 찾거나 캡처하지 못했습니다. 카카오톡을 열고 백업할 방을 앞에 둔 뒤 다시 시작하세요.';
  }
  if (/no usable WeChat message OCR detected|no usable message pane/iu.test(message)) {
    return '확인 필요: 위챗 대화 내용을 읽지 못했습니다. 목록, 설정, 광고 화면이 아니라 대화방 본문을 선택했는지 확인하고 다시 시도하세요.';
  }
  if (/no usable KakaoTalk open-chat OCR detected/iu.test(message)) {
    return '확인 필요: 카카오톡 오픈채팅 내용을 읽지 못했습니다. 오픈채팅 방을 열고 본문이 보이는 상태에서 다시 시작하세요.';
  }
  if (/requires --confirm-local-backup|confirmation required/iu.test(message)) {
    return '확인 필요: 화면을 조작하는 백업입니다. 방 선택 완료, 앱 창 앞에 둠 표시를 한 뒤 다시 시작하세요.';
  }
  if (/stitch failed|structure failed|audit failed/iu.test(message)) {
    return '확인 필요: 백업 결과 정리에 실패했습니다. 백업 폴더가 쓰기 가능한지 확인하고 진행 기록을 다시 확인하세요.';
  }
  return '확인 필요: 백업이 끝나지 않았습니다. 앱 실행 상태, 문자 인식 설정, 진행 기록을 확인한 뒤 다시 시도하세요.';
}

function friendlyLogLine(line) {
  const text = String(line || '');
  if (/^FAIL\s+/iu.test(text)) return friendlyFailureLogLine(text);
  if (/^STOPPED\b/iu.test(text)) return '중지 상태가 남아 있어 작업을 시작하지 않았습니다. 진행 기록에서 상태를 확인한 뒤 새로 시작하세요.';
  if (/^WARN:\s*capture failed/iu.test(text)) return '일부 화면 캡처에 실패했습니다. 계속 실패하면 앱 창을 앞으로 가져온 뒤 다시 시도하세요.';
  if (/^WARN:\s*OCR failed/iu.test(text)) return '일부 화면 문자 인식에 실패했습니다. 필요한 언어 기능을 확인한 뒤 다시 시도하세요.';
  if (/^WARN:\s*comment thread/iu.test(text)) return '일부 댓글창을 읽지 못했습니다. 결과에서 빠진 댓글이 있으면 해당 방을 열고 다시 시도하세요.';
  if (/^WARN:\s*stopping main loop|^WARN:.*structure failed/iu.test(text)) return '일부 화면 읽기가 중간에 멈췄습니다. 결과를 확인하고 빠진 내용이 있으면 앱 창을 앞에 둔 뒤 다시 시도하세요.';
  if (/^중지 이유:\s*방 개수 상한/u.test(text)) return '확인 필요: 방 개수 상한에 도달했습니다. 모든 방을 확인하지 못했을 수 있습니다. 완료 카드의 상한 늘려 전체 목록 다시 확인을 누르세요.';
  if (/^중지 이유:\s*페이지 상한/u.test(text)) return '확인 필요: 페이지 상한에 도달했습니다. 모든 방을 확인하지 못했을 수 있습니다. 완료 카드의 상한 늘려 전체 목록 다시 확인을 누르세요.';
  if (/^중지 이유:\s*새 방이 더 이상 나오지 않아 목록 순회를 멈췄습니다/u.test(text)) return '목록 끝까지 확인했습니다. 새 방이 더 이상 나오지 않아 자동으로 멈췄습니다.';
  if (/^>>\s*(?:capturing|.*캡처)/iu.test(text)) return '화면을 캡처하는 중입니다...';
  if (/^>>\s*(?:Windows OCR|.*글자)/iu.test(text)) return '화면 글자를 읽는 중입니다...';
  if (/^(BATCH_MANIFEST|MANIFEST)=/u.test(text)) return '';
  if (/^(BATCH_DIR|DIR)=/u.test(text)) return '저장 위치: 백업 폴더에 저장했습니다.';
  if (/^고급 정보:\s*(CANDIDATES|ROOMS)=/u.test(text)) return '';
  const transcript = text.match(/^TRANSCRIPT=.*?\((\d+)\s+lines?\)/iu);
  if (transcript) return `대화 읽기 결과를 저장했습니다. (${displayNumber(transcript[1])}줄)`;
  const candidates = text.match(/^(?:고급 정보:\s*)?CANDIDATES=(\d+)/u);
  if (candidates) return `후보 요약: ${displayNumber(candidates[1])}개`;
  const rooms = text.match(/^(?:고급 정보:\s*)?ROOMS=(\d+)\s+PASS=(\d+)\s+REVIEW=(\d+)\s+FAIL_OR_MISSING=(\d+)/u);
  if (rooms) {
    return `백업 요약: 처리 ${displayNumber(rooms[1])}개, 정상 ${displayNumber(rooms[2])}개, 확인 필요 ${displayNumber(rooms[3])}개, 실패 ${displayNumber(rooms[4])}개`;
  }
  return text;
}

function friendlyLogText(text) {
  const raw = String(text || '');
  const trailing = /\r?\n$/u.test(raw);
  const lines = raw.split(/\r?\n/u);
  if (trailing) lines.pop();
  const converted = lines.map(friendlyLogLine).filter((line) => line !== '');
  return converted.length ? `${converted.join('\n')}${trailing ? '\n' : ''}` : '';
}

function friendlyEventText(event, { hasAfterExit = false } = {}) {
  const type = String(event?.type || '');
  const status = String(event?.status || '');
  if (type === 'start') return '시작했습니다.\n';
  if (type === 'stopping') return '중지 요청을 보냈습니다.\n';
  if (type === 'exit') {
    if (hasAfterExit) return '';
    if (status === 'pass') return '완료했습니다.\n';
    if (status === 'fail') return '확인 필요: 마지막 안내를 확인하세요.\n';
    if (status === 'stopped') return '중지했습니다.\n';
    return `${statusLabel(status)} 상태로 끝났습니다.\n`;
  }
  return '';
}

function riskLabel(risk) {
  const labels = {
    read: '읽기',
    foreground: '앱 화면 사용',
    write: '쓰기',
    destructive: '파괴적',
    cloud: '클라우드',
  };
  return (risk || []).map((item) => labels[item] || item).join(', ');
}

function jobActionLabel(job) {
  const key = `${job?.module || ''}.${job?.action || ''}`;
  if (key === 'kakao.visible_batch' && job?.params?.dryRun) return job?.params?.allVisible ? '카카오톡 전체 목록 확인' : '카카오톡 목록 확인';
  if (key === 'wechat.visible_batch' && job?.params?.dryRun) return job?.params?.allVisible ? '위챗 전체 목록 확인' : '위챗 목록 확인';
  const labels = {
    'setup.wsl_tools': '선택 도구 설치',
    'setup.open_kakaotalk': '카카오톡 열기',
    'setup.open_kakaotalk_download': '카카오톡 공식 설치 페이지 열기',
    'setup.open_wechat': '위챗 열기',
    'setup.open_wechat_download': '위챗 공식 설치 페이지 열기',
    'setup.open_backup_tool_download': '백업 화면 실행 도구 설치 페이지 열기',
    'setup.open_backup_folder': '백업 폴더 열기',
    'setup.open_language_settings': 'Windows 언어 설정 열기',
    'setup.create_live_validation_report': '검증 보고서 만들기',
    'setup.create_readiness_report': '준비 보고서 만들기',
    'setup.install_ocr_ko': '한국어 문자 인식 설치',
    'setup.install_ocr_zh': '중국어 문자 인식 설치',
    'doctor.run': '준비 상태 확인',
    'agent.preview': '고급 자동 실행 미리보기',
    'agent.run': '고급 자동 실행',
    'chat.viewer': '결과 화면 열기',
    'chat.audit': '결과 품질 확인',
    'kakao.open_windows': '카카오톡 열린 방 백업',
    'kakao.visible_room': '카카오톡 목록 방 백업',
    'kakao.visible_batch': job?.params?.allVisible ? '카카오톡 목록 백업 실행' : '카카오톡 왼쪽 목록 백업',
    'kakao.openchat': '카카오톡 오픈채팅 백업',
    'wechat.current_room': '지금 열린 위챗 방 백업',
    'wechat.visible_batch': job?.params?.allVisible ? '위챗 목록 백업 실행' : '위챗 왼쪽 목록 백업',
    'wechat.validate_db': '예전 위챗 백업 파일 검사',
    'selftest.pass': '테스트 확인 작업',
    'selftest.slow': '테스트 실행 작업',
  };
  return labels[key] || job?.description || '작업';
}

function jobActionDetail(job) {
  const key = `${job?.module || ''}.${job?.action || ''}`;
  if (key === 'kakao.visible_batch' && job?.params?.dryRun) {
    return job?.params?.allVisible
      ? '카카오톡 왼쪽 목록을 끝까지 확인하고 후보 방 이름을 표시했습니다.'
      : '카카오톡 왼쪽 목록에 현재 보이는 후보 방 이름을 표시했습니다.';
  }
  if (key === 'wechat.visible_batch' && job?.params?.dryRun) {
    return '클릭 없이 화면에 보이는 위챗 방 후보만 확인합니다.';
  }
  const details = {
    'setup.wsl_tools': '기본 백업에는 없어도 되지만, 예전 백업 파일 검사나 추가 검수에 필요한 도구를 준비합니다.',
    'setup.open_kakaotalk': '카카오톡 앱을 열고 앞으로 가져옵니다.',
    'setup.open_kakaotalk_download': '카카오톡 공식 PC 다운로드 페이지를 엽니다.',
    'setup.open_wechat': '위챗 앱을 열고 앞으로 가져옵니다.',
    'setup.open_wechat_download': '위챗 Windows 공식 설치 페이지를 엽니다.',
    'setup.open_backup_tool_download': '백업 화면 실행 도구 설치 페이지를 엽니다. 설치가 끝나면 1_백업_시작.bat를 다시 실행하세요.',
    'setup.open_backup_folder': '백업 결과가 저장되는 폴더를 Windows Explorer로 엽니다.',
    'setup.open_language_settings': '화면 글자를 읽기 위한 Windows 언어 설정을 엽니다.',
    'setup.create_live_validation_report': '백업 결과 개수와 준비 상태만 담은 보고서를 만들고 엽니다.',
    'setup.create_readiness_report': '채팅 내용 없이 앱, 문자 인식, 저장 폴더 준비 상태만 담은 보고서를 만들고 엽니다.',
    'setup.install_ocr_ko': '카카오톡 백업에 필요한 한국어 Windows 문자 인식 설치를 시도합니다.',
    'setup.install_ocr_zh': '위챗 백업에 필요한 중국어 Windows 문자 인식 설치를 시도합니다.',
    'doctor.run': 'Windows, 앱 실행, 문자 인식 상태를 다시 확인합니다.',
    'agent.preview': '입력한 목표를 실행하기 전에 계획만 확인합니다.',
    'agent.run': '입력한 목표를 실제로 실행합니다.',
    'chat.viewer': '읽기 전용 결과 화면을 엽니다.',
    'chat.audit': '백업 결과가 화면에 잘 보이는지 확인합니다.',
    'kakao.open_windows': '현재 열려 있는 카카오톡 채팅방을 화면 문자 인식으로 저장합니다.',
    'kakao.visible_room': '카카오톡 목록에서 입력한 방을 찾아 저장합니다.',
    'kakao.visible_batch': job?.params?.allVisible ? '카카오톡 왼쪽 목록을 끝까지 스크롤하며 새 방이 안 나올 때까지 저장합니다.' : '카카오톡 왼쪽 목록에 보이는 방들을 순서대로 저장합니다.',
    'kakao.openchat': '카카오톡 오픈채팅과 댓글창을 저장합니다.',
    'wechat.current_room': '위챗에서 지금 열어 둔 방을 화면 문자 인식으로 저장합니다.',
    'wechat.visible_batch': job?.params?.allVisible ? '위챗 왼쪽 목록을 끝까지 스크롤하며 새 방이 안 나올 때까지 저장합니다.' : '위챗 왼쪽 목록에 보이는 방들을 순서대로 저장합니다.',
    'wechat.validate_db': '고급 사용자를 위한 예전 위챗 백업 파일 상태 확인입니다.',
    'selftest.pass': '테스트용으로 바로 끝나는 확인 작업입니다.',
    'selftest.slow': '테스트용으로 잠시 실행되는 작업입니다.',
  };
  return details[key] || job?.description || '실행 기록과 로그를 확인합니다.';
}

function jobStatusHint(status) {
  const hints = {
    running: '지금 실행 중입니다',
    stopping: '중지하는 중입니다',
    stopped: '사용자가 중지했습니다',
    pass: '정상적으로 끝났습니다',
    fail: '확인이 필요합니다',
    review: '확인이 필요합니다',
  };
  return hints[String(status || '').toLowerCase()] || '상태를 확인하세요';
}

function jobStartedAt(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function jobLogHeading(job) {
  const label = jobActionLabel(job);
  if (job?.status === 'running') return `${label} 진행 중`;
  if (job?.status === 'stopping') return `${label} 중지 중`;
  return `${label} 진행 기록`;
}

function jobDirectUrl(id) {
  const url = new URL(location.href);
  url.pathname = '/jobs';
  url.search = '';
  url.hash = `job=${encodeURIComponent(id)}`;
  return url.toString();
}

function safeFileName(value) {
  return String(value || 'job')
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'job';
}

async function copyToClipboard(text) {
  await navigator.clipboard.writeText(text);
}

function downloadTextFile(name, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function fetchJobArtifactText(id, file) {
  const res = await fetch(`/api/jobs/${encodeURIComponent(id)}/artifact?file=${encodeURIComponent(file)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`artifact ${file} failed`);
  return res.text();
}

async function downloadRawJobBundle(id, job) {
  const files = ['manifest.json', 'stdout.log', 'stderr.log', 'events.jsonl'];
  const parts = [];
  for (const file of files) {
    const text = await fetchJobArtifactText(id, file).catch((err) => `원본 기록을 불러오지 못했습니다: ${err.message}\n`);
    parts.push([
      `===== ${file} =====`,
      text.trimEnd(),
      '',
    ].join('\n'));
  }
  const titleText = job ? jobActionLabel(job) : '진행 기록';
  const body = [
    `진행 항목: ${titleText}`,
    `상태: ${job ? statusLabel(job.status) : '-'}`,
    `시작 시각: ${job?.started_at || '-'}`,
    `기록 ID: ${id}`,
    '',
    '아래 내용은 원본 지원 묶음입니다.',
    '개인 대화 일부, 오류 원문, 내 컴퓨터의 폴더 경로가 포함될 수 있습니다.',
    '지원 담당자가 따로 요청했을 때만 신뢰하는 사람에게 전달하세요.',
    '',
    parts.join('\n'),
  ].join('\n');
  downloadTextFile(`computer-use-${safeFileName(id)}-raw-support.txt`, body);
}

function looksLikeRedactedPath(value) {
  return /\$HOME|<user>/u.test(String(value || ''));
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[ch]));
}

const OCR_CHECK_IDS = new Set(['windows_ocr', 'windows_ocr_ko', 'windows_ocr_zh', 'ocr_any']);

function isOcrCheck(checkOrId) {
  const id = typeof checkOrId === 'string' ? checkOrId : String(checkOrId?.id || '');
  return OCR_CHECK_IDS.has(id);
}

function ocrSetupTarget(checkOrId) {
  const id = typeof checkOrId === 'string' ? checkOrId : String(checkOrId?.id || '');
  if (id === 'windows_ocr_zh') {
    return {
      app: '위챗',
      installLabel: '중국어 문자 인식 설치',
      choice: '중국어(간체, 중국) 또는 중국어(번체, 대만/홍콩) 중 하나',
      search: '중국어',
    };
  }
  if (id === 'windows_ocr_ko') {
    return {
      app: '카카오톡',
      installLabel: '한국어 문자 인식 설치',
      choice: '한국어',
      search: '한국어',
    };
  }
  return {
    app: '카카오톡/위챗',
    installLabel: '중국어 문자 인식 설치 또는 한국어 문자 인식 설치',
    choice: '카카오톡은 한국어, 위챗은 중국어(간체, 중국) 또는 중국어(번체, 대만/홍콩) 중 하나',
    search: '한국어 또는 중국어 중 필요한 언어',
  };
}

function ocrSetupGuideHtml(checkOrId = '') {
  const target = ocrSetupTarget(checkOrId);
  return `
    <ol class="setup-steps">
      <li><strong>${esc(target.installLabel)}</strong>가 보이면 먼저 누릅니다. Windows 권한 확인 창이 뜨면 <strong>예</strong>를 누릅니다. 창이 보이지 않으면 작업 표시줄의 <strong>새 권한 확인 창</strong> 또는 <strong>방패 아이콘</strong>을 확인합니다.</li>
      <li>자동 설치가 막히면 <strong>Windows 언어 설정 열기</strong>를 누르고, 열린 Windows 설정에서 <strong>언어 추가</strong>를 누릅니다.</li>
      <li>검색창에는 <strong>${esc(target.search)}</strong>를 입력합니다. <strong>${esc(target.app)}</strong> 백업에 필요한 언어는 <strong>${esc(target.choice)}</strong>입니다.</li>
      <li>설치할 기능을 묻는 화면이 나오면 기본 선택 그대로 설치합니다. 표시 언어와 키보드는 바꾸지 않아도 되고, 문자 인식 기능은 선택 해제하지 않습니다.</li>
      <li>설치가 끝날 때까지 기다린 뒤 이 화면으로 돌아와 <strong>상태 새로고침</strong>을 누릅니다. 바로 바뀌지 않으면 1~2분 뒤 한 번 더 누릅니다.</li>
    </ol>`;
}

function ocrInstallActionForCheck(checkOrId) {
  const id = typeof checkOrId === 'string' ? checkOrId : String(checkOrId?.id || '');
  if (id === 'windows_ocr_zh') return { action: 'install_ocr_zh', homeAction: 'install-ocr-zh', label: '중국어 문자 인식 설치' };
  if (id === 'windows_ocr_ko') return { action: 'install_ocr_ko', homeAction: 'install-ocr-ko', label: '한국어 문자 인식 설치' };
  return { action: 'open_language_settings', homeAction: 'open-ocr-settings', label: '문자 인식 설정' };
}

function firstOcrCheck(items) {
  const checks = Array.isArray(items) ? items : [];
  return checks.find((check) => String(check?.id || '') === 'windows_ocr_zh')
    || checks.find((check) => String(check?.id || '') === 'windows_ocr_ko')
    || checks.find(isOcrCheck)
    || null;
}

function compactSetupGuideText(check) {
  const id = String(check?.id || '');
  if (id === 'windows_ocr_zh') {
    return '중국어 문자 인식 설치를 먼저 누릅니다. Windows 권한 확인 창이 뜨면 예를 누릅니다. 창이 보이지 않으면 작업 표시줄의 새 권한 확인 창 또는 방패 아이콘을 확인합니다. 자동 설치가 막히면 Windows 언어 설정 열기 -> 언어 추가 -> 중국어 검색 -> 중국어(간체, 중국) 또는 중국어(번체, 대만/홍콩) 중 하나 추가 -> 기본 선택 그대로 설치 -> 상태 새로고침을 누릅니다. 바로 바뀌지 않으면 1~2분 뒤 한 번 더 누릅니다.';
  }
  if (id === 'windows_ocr_ko') {
    return '한국어 문자 인식 설치를 먼저 누릅니다. Windows 권한 확인 창이 뜨면 예를 누릅니다. 창이 보이지 않으면 작업 표시줄의 새 권한 확인 창 또는 방패 아이콘을 확인합니다. 자동 설치가 막히면 Windows 언어 설정 열기 -> 언어 추가 -> 한국어 검색 -> 한국어 추가 -> 기본 선택 그대로 설치 -> 상태 새로고침을 누릅니다. 바로 바뀌지 않으면 1~2분 뒤 한 번 더 누릅니다.';
  }
  if (id === 'windows_ocr' || id === 'ocr_any') {
    return '중국어 문자 인식 설치 또는 한국어 문자 인식 설치를 먼저 누릅니다. Windows 권한 확인 창이 뜨면 예를 누릅니다. 창이 보이지 않으면 작업 표시줄의 새 권한 확인 창 또는 방패 아이콘을 확인합니다. 자동 설치가 막히면 Windows 언어 설정 열기 -> 언어 추가 -> 카카오톡은 한국어, 위챗은 중국어(간체, 중국) 또는 중국어(번체, 대만/홍콩) 중 하나 추가 -> 기본 선택 그대로 설치 -> 상태 새로고침을 누릅니다. 바로 바뀌지 않으면 1~2분 뒤 한 번 더 누릅니다.';
  }
  if (id === 'gui_apps') {
    return '위챗 열기 또는 카카오톡 열기를 누릅니다. 앱이 없으면 위챗 공식 설치 페이지 또는 카카오톡 공식 설치 페이지를 열어 설치와 로그인을 마친 뒤 상태 새로고침을 누릅니다.';
  }
  if (id === 'node') {
    return '압축을 푼 폴더의 1_백업_시작.bat를 다시 실행합니다. 설치 창이 뜨면 허용하고, 막히면 시작하기.bat를 실행합니다.';
  }
  if (id === 'powershell') {
    return 'Windows 기본 자동 실행 기능이 꺼져 있으면 회사 보안 정책이나 실행 권한을 확인한 뒤 1_백업_시작.bat를 다시 실행합니다.';
  }
  if (id === 'wechat_db') {
    return '일반 위챗 백업에는 없어도 됩니다. 먼저 위챗 백업 화면의 지금 열린 방 또는 왼쪽 목록 백업을 사용합니다.';
  }
  if (id === 'shots_writable' || id === 'state_writable' || id === 'runs_writable') {
    return '압축을 푼 폴더를 바탕화면이나 문서처럼 내가 저장할 수 있는 일반 폴더로 옮긴 뒤 1_백업_시작.bat를 다시 실행합니다. OneDrive 동기화 오류가 난 폴더, 회사 보안 폴더, 읽기 전용 폴더는 피합니다.';
  }
  if (id === 'wsl' || /^wsl_/u.test(id)) {
    return '기본 위챗/카카오톡 백업에는 없어도 됩니다. 예전 백업 파일 검사나 추가 검수가 필요할 때만 선택 기능 도구를 준비합니다.';
  }
  return '';
}

function currentRoomStepsHtml(appLabel, openText, selectText) {
  return `
    <ol class="current-room-steps" aria-label="${esc(appLabel)} 지금 열린 방 백업 순서">
      <li><span>1</span><strong>${esc(openText)}</strong></li>
      <li><span>2</span><strong>${esc(selectText)}</strong></li>
      <li><span>3</span><strong>브라우저로 돌아와 선택 완료 표시</strong></li>
    </ol>`;
}

function currentRoomConfirmHtml(inputId, errorId, selectedText) {
  return `
    <div class="confirm-block">
      <label class="confirm-line confirm-line-prominent">
        <input id="${esc(inputId)}" type="checkbox">
        <span class="confirm-copy">
          <strong>방 선택 완료, 앱 창 앞에 둠</strong>
          <small>${esc(selectedText)}. 이 표시를 체크한 뒤 백업 버튼을 누릅니다. 백업이 끝날 때까지 앱 창을 최소화하거나 다른 창으로 가리지 않습니다.</small>
        </span>
      </label>
      <div id="${esc(errorId)}" class="field-error confirm-error" role="alert" hidden></div>
    </div>`;
}

function batchListConfirmHtml(inputId, errorId, appLabel) {
  return `
    <div class="confirm-block">
      <label class="confirm-line confirm-line-prominent">
        <input id="${esc(inputId)}" type="checkbox">
        <span class="confirm-copy">
          <strong>전체 목록 확인 준비 완료</strong>
          <small>${esc(appLabel)} 앱 창을 앞에 두고 왼쪽 채팅 목록이 보입니다. 이 표시를 체크한 뒤 전체 목록 확인을 누릅니다. 백업이 끝날 때까지 앱 창을 최소화하거나 다른 창으로 가리지 않습니다.</small>
        </span>
      </label>
      <div id="${esc(errorId)}" class="field-error confirm-error" role="alert" hidden></div>
    </div>`;
}

function localPrivacyStripHtml() {
  return `<div class="privacy-strip privacy-strip-compact" aria-label="저장과 개인정보 안내">
      <div>
        <strong>내 컴퓨터에 저장</strong>
        <span>기본 백업은 이 컴퓨터에 저장됩니다.</span>
      </div>
      <div>
        <strong>외부 전송 기본 꺼짐</strong>
        <span>추가 검수/번역 기능은 선택할 때만 씁니다.</span>
      </div>
      <div>
        <strong>입력할 내용 없음</strong>
        <span>아무 값도 입력하지 않고 같은 화면 안에서 이어집니다.</span>
      </div>
      <span class="visually-hidden">AI 보정은 선택 기능입니다. 처음 백업은 Windows 문자 인식으로 시작하고, 추가 검수는 필요할 때만 사용합니다. Windows 기본 백업은 고급 실행 환경 없이 시작하고, 앱 화면을 읽어 저장하며 내부 DB를 직접 열지 않습니다. 외부 검수/번역 기능은 기본으로 꺼져 있습니다.</span>
    </div>`;
}

async function refreshHealth() {
  try {
    const health = await (await fetch('/api/health')).json();
    healthText.textContent = statusLabel(health.status || 'ready');
  } catch {
    healthText.textContent = '오프라인';
  }
  try {
    await api('/api/config');
    authenticated = true;
    providerBadge.textContent = '내 컴퓨터';
  } catch (err) {
    if (err.status === 401 && await tryLocalAuth()) {
      authenticated = true;
      providerBadge.textContent = '내 컴퓨터';
      return;
    }
    authenticated = false;
    providerBadge.textContent = '다시 연결';
  }
}

async function dashboardView() {
  setChrome('위챗/카카오톡 백업', '따로 입력할 내용 없이 이 화면 하나에서 백업합니다');
  const renderToken = ++dashboardRenderToken;
  const queuedDoctor = queuedDoctorReport;
  if (queuedDoctor) queuedDoctorReport = null;
  const doctorPromise = queuedDoctor
    ? null
    : api('/api/doctor').catch((err) => ({ status: 'locked', counts: { pass: 0, review: 0, fail: 0 }, checks: [], error: err.message }));
  const doctorResult = queuedDoctor
    ? { ready: true, report: queuedDoctor }
    : await Promise.race([
      doctorPromise.then((report) => ({ ready: true, report })),
      delay(500).then(() => ({ ready: false, report: null })),
    ]);
  const doctorPending = !doctorResult.ready;
  if (doctorPending && doctorPromise) {
    doctorPromise.then((report) => {
      queuedDoctorReport = report;
      if (dashboardRenderToken === renderToken && routePath() === '/') render();
    }).catch(() => {});
  }
  const doctor = doctorResult.ready
    ? doctorResult.report
    : { status: 'checking', counts: { pass: 0, review: 0, fail: 0 }, checks: [], pending: true };
  const checkById = (id) => doctor?.checks?.find((check) => check.id === id);
  const runningApps = new Set((checkById('gui_apps')?.details?.running || []).map((name) => String(name)));
  const windowsOcrReady = checkById('windows_ocr')?.status === 'pass';
  const kakaoOcrReady = checkById('windows_ocr_ko') ? checkById('windows_ocr_ko')?.status === 'pass' : windowsOcrReady;
  const wechatOcrReady = checkById('windows_ocr_zh') ? checkById('windows_ocr_zh')?.status === 'pass' : windowsOcrReady;
  const chatOcrReady = kakaoOcrReady && wechatOcrReady;
  const anyChatOcrReady = kakaoOcrReady || wechatOcrReady;
  const coreToolReady = ['powershell', 'node', 'shots_writable', 'state_writable', 'runs_writable', 'windows_ocr']
    .every((id) => checkById(id)?.status === 'pass');
  const fullBackupReady = coreToolReady && chatOcrReady;
  const coreBackupReady = coreToolReady && anyChatOcrReady;
  const kakaoRunning = runningApps.has('KakaoTalk');
  const wechatRunning = runningApps.has('Weixin') || runningApps.has('WeChat');
  const kakaoReady = kakaoRunning && kakaoOcrReady;
  const wechatReady = wechatRunning && wechatOcrReady;
  const platformStatus = (ready, appName, ocrReady) => {
    if (doctorPending) return { label: '상태 확인 중', status: 'ready' };
    if (ready) return { label: '백업 가능', status: 'pass' };
    if (!ocrReady) return { label: `${appName} 문자 인식 확인 필요`, status: 'review' };
    return { label: `${appName} 실행 필요`, status: 'review' };
  };
  const platformActions = ({ ready, running, ocrReady, openAction, installAction, backupAction, openLabel, installLabel, ocrAction = 'open-ocr-settings', ocrLabel = '문자 인식 설정' }) => {
    if (doctorPending) {
      return `
        <button data-action="${backupAction}" class="primary" type="button">백업 시작</button>
        <button data-action="${openAction}" type="button">${esc(openLabel)}</button>
        <button data-action="${installAction}" type="button">${esc(installLabel)}</button>`;
    }
    if (!ocrReady) {
      return `
        <button data-action="${esc(ocrAction)}" class="primary" type="button">${esc(ocrLabel)}</button>
        <button data-action="${openAction}" type="button">${esc(openLabel)}</button>
        <button data-action="${installAction}" type="button">${esc(installLabel)}</button>
        <button data-action="${backupAction}" type="button">막힌 항목 보기</button>`;
    }
    if (!running) {
      return `
        <button data-action="${openAction}" class="primary" type="button">${esc(openLabel)}</button>
        <button data-action="${installAction}" type="button">${esc(installLabel)}</button>
        <button data-action="${backupAction}" type="button">백업 시작</button>`;
    }
    return `
      <button data-action="${backupAction}" class="${ready ? 'primary' : ''}" type="button">백업 시작</button>
      <button data-action="${openAction}" type="button">${esc(openLabel)}</button>
      <button data-action="${installAction}" type="button">${esc(installLabel)}</button>`;
  };
  const kakaoStatus = platformStatus(kakaoReady, '카카오톡', kakaoOcrReady);
  const wechatStatus = platformStatus(wechatReady, '위챗', wechatOcrReady);
  const primaryOcrAction = !wechatOcrReady
    ? ocrInstallActionForCheck('windows_ocr_zh')
    : (!kakaoOcrReady ? ocrInstallActionForCheck('windows_ocr_ko') : ocrInstallActionForCheck('windows_ocr'));
  const readinessText = doctorPending
    ? '준비 상태를 확인하는 중입니다. 기다리지 않아도 위챗 백업 또는 카카오톡 백업을 열 수 있습니다.'
    : fullBackupReady
    ? '카카오톡과 위챗 모두 바로 시작할 수 있습니다.'
    : (coreBackupReady
      ? '한쪽 앱은 바로 시작할 수 있고, 다른 앱은 화면에 보이는 준비 항목만 끝내면 됩니다.'
      : '사용할 앱의 막힌 항목만 확인하면 됩니다.');
  const doctorBadgeText = doctorPending
    ? '준비 확인 중'
    : fullBackupReady
    ? '기본 도구 준비됨'
    : (coreBackupReady ? '준비할 항목 있음' : '먼저 할 일 있음');
  const doctorBadgeClass = doctorPending ? 'ready' : (fullBackupReady ? 'pass' : (coreBackupReady ? 'partial' : 'review'));
  const ocrText = doctorPending
    ? '잠시 뒤 자동으로 문자 인식 상태가 갱신됩니다.'
    : chatOcrReady
    ? '한국어/중국어 문자 인식 준비가 확인됐습니다.'
    : kakaoOcrReady
      ? '한국어 문자 인식은 준비됐고, 위챗용 중국어 문자 인식 확인이 필요합니다.'
      : wechatOcrReady
        ? '중국어 문자 인식은 준비됐고, 카카오톡용 한국어 확인이 필요합니다.'
        : '카카오톡은 한국어, 위챗은 중국어 문자 인식을 사용합니다.';
  const ocrSettingsButton = doctorPending || chatOcrReady
    ? ''
    : `<button data-action="${esc(primaryOcrAction.homeAction)}" class="primary" type="button">${esc(primaryOcrAction.label)}</button>`;
  const dashboardOcrGuide = doctorPending || chatOcrReady
    ? ''
    : `<div class="home-setup-guide">
        <strong>문자 인식 설정 순서</strong>
        <p>카카오톡만 먼저 백업할 때는 한국어, 위챗을 백업할 때는 중국어(간체, 중국) 또는 중국어(번체, 대만/홍콩) 중 하나를 준비하면 됩니다.</p>
        ${ocrSetupGuideHtml()}
      </div>`;
  const resultButtonClass = doctorPending || coreBackupReady ? 'primary' : '';
  const homeHint = doctorPending
    ? '준비 상태를 확인하는 중입니다. 위챗 백업 또는 카카오톡 백업을 먼저 열어도 됩니다.'
    : !anyChatOcrReady
    ? '먼저 문자 인식 설정에서 사용할 앱에 맞는 언어 기능을 확인하세요.'
    : (!kakaoRunning || !wechatRunning)
      ? '앱이 꺼져 있으면 아래 카드에서 카카오톡 열기 또는 위챗 열기를 누르세요.'
      : '앱에서 백업할 방을 선택한 뒤 백업 시작을 누르세요.';
  const nextAction = (() => {
    if (doctorPending) {
      return {
        status: 'ready',
        title: '지금 할 일',
        text: '준비 확인을 기다리지 않아도 됩니다. 위챗 앱에서 방을 선택했으면 1번 위챗 백업으로 들어가세요.',
        actions: `
          <button data-action="backup-wechat" class="primary" type="button">1번 위챗 백업</button>
          <button data-action="open-wechat" type="button">위챗 열기</button>
          <button data-action="chats" type="button">결과 보기</button>`,
      };
    }
    if (wechatReady) {
      return {
        status: 'pass',
        title: '지금 할 일',
        text: '위챗 실행과 중국어 문자 인식이 확인됐습니다. 위챗에서 백업할 방을 선택한 뒤 백업을 시작하세요.',
        actions: `
          <button data-action="backup-wechat" class="primary" type="button">1번 위챗 백업</button>
          <button data-action="chats" type="button">결과 보기</button>
          <button data-action="backup-kakao" type="button">카카오톡 백업</button>`,
      };
    }
    if (kakaoReady && !wechatReady) {
      const wechatFix = ocrInstallActionForCheck('windows_ocr_zh');
      const wechatFixAction = wechatOcrReady ? 'open-wechat' : wechatFix.homeAction;
      const wechatFixLabel = wechatOcrReady ? '위챗 열기' : wechatFix.label;
      const wechatBlockText = wechatOcrReady
        ? '위챗은 앱을 열고 로그인하면 이어서 백업할 수 있습니다.'
        : '위챗은 중국어(간체, 중국) 또는 중국어(번체, 대만/홍콩) 중 하나를 설치하면 이어서 백업할 수 있습니다.';
      return {
        status: 'partial',
        title: '지금 할 일',
        text: `위챗은 사라진 것이 아닙니다. ${wechatBlockText} 카카오톡은 바로 백업할 수 있습니다.`,
        actions: `
          <button data-action="${wechatFixAction}" class="primary" type="button">${wechatFixLabel}</button>
          <button data-action="backup-wechat" type="button">1번 위챗 백업</button>
          <button data-action="backup-kakao" type="button">카카오톡 백업</button>`,
      };
    }
    if (!wechatOcrReady) {
      return {
        status: 'review',
        title: '지금 할 일',
        text: '위챗 백업에는 중국어 화면 글자 읽기가 필요합니다. 설정을 열어 중국어(간체, 중국) 또는 중국어(번체, 대만/홍콩) 중 하나를 추가하세요.',
        actions: `
          <button data-action="install-ocr-zh" class="primary" type="button">중국어 문자 인식 설치</button>
          <button data-action="backup-wechat" type="button">1번 위챗 백업</button>
          <button data-action="doctor" type="button">준비 확인</button>`,
      };
    }
    if (!wechatRunning) {
      return {
        status: 'review',
        title: '지금 할 일',
        text: '위챗 앱을 열고 로그인한 뒤 백업할 방을 선택하세요. 선택이 끝나면 브라우저로 돌아오면 됩니다.',
        actions: `
          <button data-action="open-wechat" class="primary" type="button">위챗 열기</button>
          <button data-action="backup-wechat" type="button">위챗 백업 화면</button>
          <button data-action="install-wechat" type="button">공식 설치 페이지</button>`,
      };
    }
    return {
      status: coreBackupReady ? 'ready' : 'review',
      title: '지금 할 일',
      text: '앱에서 백업할 방을 선택한 뒤 1번 위챗 백업 또는 카카오톡 백업을 시작하세요.',
      actions: `
        <button data-action="backup-wechat" class="primary" type="button">1번 위챗 백업</button>
        <button data-action="backup-kakao" type="button">카카오톡 백업</button>
        <button data-action="refresh-home" type="button">상태 새로고침</button>`,
    };
  })();
  const progressBadge = (state) => ({ pass: '완료', partial: '준비할 항목', review: '확인 필요', ready: '다음 단계' }[state] || '확인');
  const progressItem = ({ step, state, title, text, actions }) => `
    <li class="progress-card ${statusClass(state)}">
      <span class="progress-index">${esc(step)}</span>
      <div class="progress-body">
        <div class="progress-title">
          <strong>${esc(title)}</strong>
          <span class="badge ${statusClass(state)}">${esc(progressBadge(state))}</span>
        </div>
        <p>${esc(text)}</p>
        <div class="progress-actions">${actions}</div>
      </div>
    </li>`;
  const progressItems = [
    progressItem({
      step: '1',
      state: doctorPending ? 'ready' : (chatOcrReady ? 'pass' : (anyChatOcrReady ? 'partial' : 'review')),
      title: '문자 인식 준비',
      text: doctorPending
        ? '잠시 뒤 자동으로 확인됩니다.'
        : chatOcrReady
        ? '한국어/중국어 화면 글자 읽기를 사용할 수 있습니다.'
        : anyChatOcrReady
          ? '한쪽 앱은 시작할 수 있고, 다른 앱은 화면에 보이는 언어 설정만 끝내면 됩니다.'
          : '사용할 앱에 맞는 문자 인식 언어를 확인합니다.',
      actions: doctorPending
        ? '<button data-action="refresh-home" type="button">상태 새로고침</button>'
        : chatOcrReady
        ? '<button data-action="refresh-home" type="button">상태 새로고침</button>'
        : `<button data-action="${esc(primaryOcrAction.homeAction)}" class="primary" type="button">${esc(primaryOcrAction.label)}</button>`,
    }),
    progressItem({
      step: '2',
      state: doctorPending ? 'ready' : ((kakaoRunning || wechatRunning) ? 'pass' : 'review'),
      title: '앱 열기',
      text: doctorPending
        ? '확인 중에도 앱을 먼저 열 수 있습니다.'
        : (kakaoRunning || wechatRunning) ? '실행 중인 채팅 앱이 확인됐습니다.' : '카카오톡 또는 위챗을 열고 로그인합니다.',
      actions: `
        <button data-action="open-kakao" type="button">카카오톡 열기</button>
        <button data-action="open-wechat" type="button">위챗 열기</button>`,
    }),
    progressItem({
      step: '3',
      state: doctorPending ? 'ready' : ((kakaoReady || wechatReady) ? 'ready' : 'review'),
      title: '방 선택 후 백업',
      text: doctorPending
        ? '앱에서 방을 선택한 뒤 백업 화면으로 이동합니다.'
        : (kakaoReady || wechatReady) ? '앱에서 백업할 방을 선택한 뒤 이 브라우저로 돌아옵니다.' : '앱 실행과 문자 인식 준비가 끝나면 백업을 시작합니다.',
      actions: `
        <button data-action="backup-wechat" class="${(doctorPending || kakaoReady || wechatReady) ? 'primary' : ''}" type="button">위챗 백업</button>
        <button data-action="backup-kakao" type="button">카카오톡 백업</button>`,
    }),
    progressItem({
      step: '4',
      state: 'ready',
      title: '결과 확인',
      text: '결과가 비어 있으면 먼저 백업을 실행한 뒤 새로고침합니다.',
      actions: `
        <button data-action="chats" class="primary" type="button">결과 보기</button>
        <button data-action="open-folder" type="button">백업 폴더 열기</button>`,
    }),
  ].join('');
  view.innerHTML = `
    <div class="grid">
      <section class="panel span-12 start-panel">
        <div class="start-heading simple-start-heading">
          <div>
            <span class="guide-kicker">처음 화면</span>
            <h2>1번 위챗 백업부터 시작하세요</h2>
            <p>무엇을 백업할까요? 위챗은 첫 번째 큰 버튼입니다. 카카오톡과 결과 확인도 같은 웹 화면 안에서 이어집니다.</p>
            <span class="visually-hidden">1번 위챗 백업부터 시작하세요. 위챗은 첫 번째 큰 버튼입니다.</span>
          </div>
          <div class="start-heading-side">
            <span class="badge ${statusClass(doctorBadgeClass)}">${esc(doctorBadgeText)}</span>
            <div class="start-shortcuts" aria-label="빠른 시작">
              <button data-action="backup-wechat" class="primary" type="button">1번 위챗 바로 시작</button>
              <button data-action="backup-kakao" type="button">카카오톡 바로 시작</button>
              <button data-action="chats" type="button">결과 보기</button>
            </div>
          </div>
        </div>
        <div class="choice-strip" aria-label="백업 선택">
          <button data-action="backup-wechat" class="choice-action primary-choice" type="button">
            <span class="choice-kicker">1번</span>
            <strong>위챗 백업</strong>
            <small>지금 열린 방부터 시작</small>
          </button>
          <button data-action="backup-kakao" class="choice-action" type="button">
            <span class="choice-kicker">2번</span>
            <strong>카카오톡 백업</strong>
            <small>열린 채팅방부터 시작</small>
          </button>
          <button data-action="chats" class="choice-action" type="button">
            <span class="choice-kicker">확인</span>
            <strong>결과 보기</strong>
            <small>백업한 대화 확인</small>
          </button>
        </div>
        <div class="full-backup-strip" aria-label="여러 방 통째 백업">
          <div>
            <strong>여러 방을 한 번에 저장</strong>
            <span>통째 백업은 전체 목록 확인으로 후보 방을 먼저 본 뒤 실행합니다.</span>
          </div>
          <div class="full-backup-strip-actions">
            <button data-action="batch-wechat" class="primary" type="button">위챗 통째 백업 확인</button>
            <button data-action="batch-kakao" type="button">카카오톡 통째 백업 확인</button>
          </div>
          <ol class="full-backup-mini-steps" aria-label="통째 백업 순서">
            <li><span>1</span><strong>전체 목록 확인</strong></li>
            <li><span>2</span><strong>후보 확인</strong></li>
            <li><span>3</span><strong>목록 백업 실행</strong></li>
            <li><span>4</span><strong>결과 보기와 전체 저장</strong></li>
          </ol>
        </div>
        <div class="wechat-anchor-note">
          <strong>위챗은 1번입니다</strong>
          <span><strong>위챗은 여기 있습니다.</strong> 첫 번째 초록색 <strong>1번 위챗 백업</strong> 또는 왼쪽 메뉴의 1번 위챗 백업이 같은 화면으로 이어집니다.</span>
        </div>
        ${localPrivacyStripHtml()}
        <div class="next-action-panel ${statusClass(nextAction.status)}" aria-label="지금 할 일">
          <div>
            <strong>${esc(nextAction.title)}</strong>
            <p>${esc(nextAction.text)}</p>
          </div>
          <div class="next-action-buttons">
            ${nextAction.actions}
          </div>
        </div>
        <details class="home-detail-drawer">
          <summary>
            <span>
              <strong>막힐 때만 자세히 보기</strong>
              <small>앱 열기, 문자 인식, 저장 폴더 확인 버튼을 모아 둔 곳입니다.</small>
            </span>
          </summary>
          <div class="platform-grid">
            <section class="platform-card wechat-card">
              <span class="badge ${statusClass(wechatStatus.status)}">1번 ${esc(wechatStatus.label)}</span>
              <strong>위챗 백업</strong>
              <small>지금 열린 방을 먼저 백업하고, 필요하면 통째 백업(왼쪽 목록 전체 순회)을 이어서 실행합니다</small>
              <div class="card-actions">
                ${platformActions({ ready: wechatReady, running: wechatRunning, ocrReady: wechatOcrReady, openAction: 'open-wechat', installAction: 'install-wechat', backupAction: 'backup-wechat', openLabel: '위챗 열기', installLabel: '공식 설치 페이지', ocrAction: 'install-ocr-zh', ocrLabel: '중국어 문자 인식 설치' })}
              </div>
            </section>
            <section class="platform-card kakao-card">
              <span class="badge ${statusClass(kakaoStatus.status)}">${esc(kakaoStatus.label)}</span>
              <strong>카카오톡 백업</strong>
              <small>열린 채팅방을 먼저 백업하고, 필요하면 목록/오픈채팅을 사용합니다</small>
              <div class="card-actions">
                ${platformActions({ ready: kakaoReady, running: kakaoRunning, ocrReady: kakaoOcrReady, openAction: 'open-kakao', installAction: 'install-kakao', backupAction: 'backup-kakao', openLabel: '카카오톡 열기', installLabel: '공식 설치 페이지', ocrAction: 'install-ocr-ko', ocrLabel: '한국어 문자 인식 설치' })}
              </div>
            </section>
            <section class="platform-card result-card">
              <span class="badge">읽기 전용</span>
              <strong>결과 보기</strong>
              <small>카카오톡/위챗 백업 결과 통합 조회</small>
              <div class="card-actions">
                <button data-action="chats" class="primary" type="button">결과 보기</button>
              </div>
            </section>
          </div>
          <ol class="setup-progress" aria-label="백업 진행 체크리스트">
            ${progressItems}
          </ol>
          <div class="method-note" aria-label="기본 사용 기준">
            <strong>기본 사용 기준</strong>
            <p>AI 보정은 선택 기능입니다. 처음 백업은 Windows 문자 인식으로 시작하고, 추가 검수는 필요할 때만 사용합니다. Windows 기본 백업은 고급 실행 환경 없이 시작하고, 앱 화면을 읽어 저장하며 내부 DB를 직접 열지 않습니다. 외부 검수/번역 기능은 기본으로 꺼져 있습니다.</p>
          </div>
          <div class="home-recovery" aria-label="막힐 때 확인">
            <div>
              <strong>위챗 찾기 / 막힐 때</strong>
              <p>위챗은 첫 번째 초록색 버튼과 왼쪽 메뉴에 있습니다. 화면이 오래된 주소처럼 보이면 브라우저와 검은 창을 닫고 1_백업_시작.bat를 다시 실행하세요.</p>
            </div>
            <div class="home-recovery-actions">
              <button data-action="backup-wechat" class="primary" type="button">위챗 백업으로 이동</button>
              <button data-action="refresh-home" type="button">상태 새로고침</button>
              <button data-action="doctor" type="button">준비 확인</button>
              <button data-action="readiness-report" type="button">준비 보고서</button>
              <button data-action="jobs" type="button">진행 기록</button>
              <button data-action="validation-report" type="button">검증 보고서</button>
              <button data-action="open-folder" type="button">백업 폴더 열기</button>
            </div>
          </div>
        </details>
        <div id="homeLog" class="home-log">${esc(homeHint)}</div>
      </section>

      <section class="panel span-12 helper-panel beginner-help-panel">
        <details>
          <summary>
            <span>
              <strong>사용 순서와 준비 상태 보기</strong>
              <small>처음 선택 버튼으로 충분하지 않을 때만 펼칩니다.</small>
            </span>
          </summary>
          <div class="help-columns">
            <div>
              <div class="toolbar"><strong>사용 순서</strong></div>
              <ol class="use-steps">
                <li><span>1</span><div><strong>앱을 엽니다</strong><p>위챗 또는 카카오톡에 로그인합니다.</p></div></li>
                <li><span>2</span><div><strong>방을 선택합니다</strong><p>앱에서 백업할 방을 누른 뒤 이 브라우저로 돌아옵니다.</p></div></li>
                <li><span>3</span><div><strong>백업을 시작합니다</strong><p>처음에는 기본값 그대로 시작하고, 길이 조정은 필요할 때만 고급 옵션을 엽니다.</p></div></li>
                <li><span>4</span><div><strong>결과를 확인합니다</strong><p>백업이 끝나면 결과 보기에서 대화와 품질 표시를 확인합니다.</p></div></li>
              </ol>
            </div>
            <div>
              <div class="toolbar">
                <strong>준비 상태</strong>
                <span class="badge ${statusClass(doctorBadgeClass)}">${esc(doctorBadgeText)}</span>
              </div>
              <div class="ready-summary">
                <strong>${esc(readinessText)}</strong>
                <p>${esc(ocrText)} 선택 기능 상태는 준비 확인에서 따로 볼 수 있습니다.</p>
                ${dashboardOcrGuide}
                <div class="ready-actions">
                  ${ocrSettingsButton}
                  <button data-action="refresh-home" type="button">상태 새로고침</button>
                  <button data-action="doctor" type="button">준비 확인</button>
                  <button data-action="chats" class="${resultButtonClass}" type="button">결과 보기</button>
                </div>
              </div>
            </div>
          </div>
        </details>
      </section>
    </div>`;
  view.querySelector('[data-action="jobs"]')?.addEventListener('click', () => navigate('/jobs'));
  view.querySelector('[data-action="backup"]')?.addEventListener('click', () => navigate('/backup'));
  view.querySelectorAll('[data-action="open-kakao"]').forEach((button) => button.addEventListener('click', () => startHomeSetupJob('open_kakaotalk', '카카오톡 열기', {
    failureMessage: '카카오톡을 열지 못했습니다. 설치되어 있는지 확인하고 로그인한 뒤 다시 시도하세요.',
  })));
  view.querySelectorAll('[data-action="open-wechat"]').forEach((button) => button.addEventListener('click', () => startHomeSetupJob('open_wechat', '위챗 열기', {
    failureMessage: '위챗을 열지 못했습니다. 설치되어 있는지 확인하고 로그인한 뒤 다시 시도하세요.',
  })));
  view.querySelectorAll('[data-action="install-kakao"]').forEach((button) => button.addEventListener('click', () => startHomeSetupJob('open_kakaotalk_download', '카카오톡 공식 설치 페이지 열기', {
    successMessage: '카카오톡 공식 설치 페이지가 열렸습니다. 설치와 로그인이 끝나면 상태 새로고침을 누르세요.',
    failureMessage: '카카오톡 공식 설치 페이지를 열지 못했습니다. 브라우저를 확인한 뒤 다시 시도하세요.',
  })));
  view.querySelectorAll('[data-action="install-wechat"]').forEach((button) => button.addEventListener('click', () => startHomeSetupJob('open_wechat_download', '위챗 공식 설치 페이지 열기', {
    successMessage: '위챗 Windows 공식 설치 페이지가 열렸습니다. 설치와 로그인이 끝나면 상태 새로고침을 누르세요.',
    failureMessage: '위챗 공식 설치 페이지를 열지 못했습니다. 브라우저를 확인한 뒤 다시 시도하세요.',
  })));
  view.querySelectorAll('[data-action="open-ocr-settings"]').forEach((button) => button.addEventListener('click', () => startHomeSetupJob('open_language_settings', '문자 인식 설정 열기', {
    successMessage: 'Windows 언어 설정이 열렸습니다. 언어 추가를 누른 뒤 카카오톡은 한국어, 위챗은 중국어(간체, 중국) 또는 중국어(번체, 대만/홍콩) 중 하나를 추가하세요. 기본 선택 그대로 설치하고, 끝나면 상태 새로고침을 누르세요.',
  })));
  view.querySelectorAll('[data-action="install-ocr-zh"]').forEach((button) => button.addEventListener('click', () => startHomeSetupJob('install_ocr_zh', '중국어 문자 인식 설치', {
    successMessage: '중국어 문자 인식 설치를 시도했습니다. Windows 권한 확인 창이 떴다면 예를 누르고, 창이 보이지 않으면 작업 표시줄의 새 권한 확인 창 또는 방패 아이콘을 확인하세요. 끝나면 상태 새로고침을 눌러 위챗 백업 준비 상태를 다시 확인하세요.',
    failureMessage: '자동 설치가 끝나지 않았습니다. Windows 언어 설정에서 중국어(간체, 중국) 또는 중국어(번체, 대만/홍콩) 중 하나를 기본 선택 그대로 설치한 뒤 상태 새로고침을 누르세요.',
  })));
  view.querySelectorAll('[data-action="install-ocr-ko"]').forEach((button) => button.addEventListener('click', () => startHomeSetupJob('install_ocr_ko', '한국어 문자 인식 설치', {
    successMessage: '한국어 문자 인식 설치를 시도했습니다. Windows 권한 확인 창이 떴다면 예를 누르고, 창이 보이지 않으면 작업 표시줄의 새 권한 확인 창 또는 방패 아이콘을 확인하세요. 끝나면 상태 새로고침을 눌러 카카오톡 백업 준비 상태를 다시 확인하세요.',
    failureMessage: '자동 설치가 끝나지 않았습니다. Windows 언어 설정에서 한국어를 기본 선택 그대로 설치한 뒤 상태 새로고침을 누르세요.',
  })));
  view.querySelectorAll('[data-action="refresh-home"]').forEach((button) => button.addEventListener('click', render));
  view.querySelectorAll('[data-action="backup-kakao"]').forEach((button) => button.addEventListener('click', () => navigate('/backup#kakao')));
  view.querySelectorAll('[data-action="backup-wechat"]').forEach((button) => button.addEventListener('click', () => navigate('/backup#wechat')));
  view.querySelectorAll('[data-action="batch-kakao"]').forEach((button) => button.addEventListener('click', () => navigate('/backup#kakao-full')));
  view.querySelectorAll('[data-action="batch-wechat"]').forEach((button) => button.addEventListener('click', () => navigate('/backup#wechat-full')));
  view.querySelectorAll('[data-action="chats"]').forEach((button) => button.addEventListener('click', () => navigate('/chats')));
  view.querySelectorAll('[data-action="open-folder"]').forEach((button) => button.addEventListener('click', () => startHomeSetupJob('open_backup_folder', '백업 폴더 열기', {
    successMessage: '백업 폴더를 열었습니다.',
    failureMessage: '백업 폴더를 열지 못했습니다. 결과 보기 화면에서 다시 시도하세요.',
  })));
  view.querySelectorAll('[data-action="readiness-report"]').forEach((button) => button.addEventListener('click', () => startHomeSetupJob('create_readiness_report', '준비 보고서 만들기', {
    successMessage: '준비 보고서를 만들었습니다. 채팅 내용 없이 앱, 문자 인식, 저장 폴더 상태만 담았습니다.',
    failureMessage: '준비 보고서를 만들지 못했습니다. 브라우저와 검은 창을 닫고 1_백업_시작.bat를 다시 실행하세요.',
  })));
  view.querySelectorAll('[data-action="validation-report"]').forEach((button) => button.addEventListener('click', () => startHomeSetupJob('create_live_validation_report', '검증 보고서 만들기', {
    successMessage: '검증 보고서를 만들었습니다. 결과 개수와 준비 상태만 담고, 채팅 본문이나 방 이름은 넣지 않습니다.',
    failureMessage: '검증 보고서를 만들지 못했습니다. 먼저 위챗 백업과 카카오톡 백업을 한 번 실행한 뒤 진행 기록을 확인하세요.',
  })));
  view.querySelector('[data-action="agent"]')?.addEventListener('click', () => navigate('/agent'));
  view.querySelectorAll('[data-action="doctor"]').forEach((button) => button.addEventListener('click', () => navigate('/doctor')));
}

function inputValue(selector) {
  return String(view.querySelector(selector)?.value || '').trim();
}

function numberValue(selector, fallback) {
  const value = Number(view.querySelector(selector)?.value || fallback);
  return Number.isInteger(value) ? value : fallback;
}

function checked(selector) {
  return Boolean(view.querySelector(selector)?.checked);
}

function requireTextInput(selector, message, errorSelector = '') {
  const el = view.querySelector(selector);
  const error = errorSelector ? view.querySelector(errorSelector) : null;
  if (String(el?.value || '').trim()) {
    if (error) {
      error.textContent = '';
      error.hidden = true;
    }
    return true;
  }
  const log = view.querySelector('#backupLog');
  if (log) log.textContent = `${message}\n`;
  if (error) {
    error.textContent = message;
    error.hidden = false;
  }
  el?.focus();
  return false;
}

function clearFieldErrorOnInput(inputSelector, errorSelector) {
  const input = view.querySelector(inputSelector);
  const error = view.querySelector(errorSelector);
  if (!input || !error) return;
  input.addEventListener('input', () => {
    if (!String(input.value || '').trim()) return;
    error.textContent = '';
    error.hidden = true;
  });
}

function clearCheckErrorOnChange(inputSelector, errorSelector) {
  const input = view.querySelector(inputSelector);
  const error = view.querySelector(errorSelector);
  if (!input || !error) return;
  input.addEventListener('change', () => {
    if (!input.checked) return;
    error.textContent = '';
    error.hidden = true;
  });
}

function requireChecked(selector, message, errorSelector = '', options = {}) {
  const el = view.querySelector(selector);
  const error = errorSelector ? view.querySelector(errorSelector) : null;
  if (el?.checked) {
    if (error) {
      error.textContent = '';
      error.hidden = true;
    }
    return true;
  }
  const log = view.querySelector('#backupLog');
  if (log) log.textContent = `${message}\n`;
  if (error) {
    error.textContent = message;
    error.hidden = false;
  }
  setBackupNextActions('need-selection', options.openJob || null, {
    selection: {
      focusSelector: selector,
      buttonLabel: options.buttonLabel || '방 선택 완료 표시로 이동',
      title: options.title || '',
      text: options.text || '',
    },
  });
  const line = el?.closest('.confirm-line');
  line?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  line?.classList.add('attention');
  if (line) setTimeout(() => line.classList.remove('attention'), 2200);
  el?.focus();
  return false;
}

function activeJobStatusText(status) {
  const key = String(status || '').toLowerCase();
  if (key === 'starting') return '시작 중:';
  if (key === 'stopping') return '중지 중:';
  if (key === 'pass') return '완료:';
  if (key === 'fail' || key === 'review') return '확인 필요:';
  if (key === 'stopped') return '중지됨:';
  return '진행 중:';
}

function activeJobStatusClass(status) {
  const key = String(status || '').toLowerCase();
  if (key === 'pass') return 'status-pass';
  if (key === 'fail' || key === 'review' || key === 'stopped') return 'status-fail';
  return 'status-running';
}

function setActiveJob(label, status = 'running') {
  if (!activeJobBadge) return;
  const nextLabel = String(label || activeJobLabel || '작업').trim();
  activeJobLabel = nextLabel;
  if (activeJobClearTimer) {
    clearTimeout(activeJobClearTimer);
    activeJobClearTimer = 0;
  }
  const text = `${activeJobStatusText(status)} ${nextLabel}`;
  activeJobBadge.textContent = text;
  activeJobBadge.title = text;
  activeJobBadge.className = `active-job-badge ${activeJobStatusClass(status)}`;
  activeJobBadge.hidden = false;
  setStopEnabled(status === 'running' || status === 'starting');
  if (['pass', 'fail', 'review', 'stopped'].includes(String(status || '').toLowerCase())) {
    activeJobClearTimer = setTimeout(() => {
      if (activeJobBadge.textContent !== text) return;
      activeJobBadge.hidden = true;
      activeJobBadge.removeAttribute('title');
      activeJobLabel = '';
    }, 6000);
  }
}

function setStopEnabled(enabled) {
  stopBtn.disabled = !enabled;
  stopBtn.title = enabled && activeJobLabel ? `${activeJobLabel} 중지` : '실행 중인 작업 중지';
}

function watchJobExit(id, { afterExit, activeLabel = '' } = {}) {
  eventSource?.close();
  eventSource = new EventSource(`/api/jobs/${encodeURIComponent(id)}/events`);
  for (const type of ['start', 'stopping', 'exit']) {
    eventSource.addEventListener(type, (evt) => {
      const data = JSON.parse(evt.data);
      if (data.type === 'start') {
        if (activeLabel) setActiveJob(activeLabel, 'running');
        else setStopEnabled(true);
      }
      if (data.type === 'stopping') {
        if (activeLabel) setActiveJob(activeLabel, 'stopping');
        setStopEnabled(false);
      }
      if (data.type === 'exit') {
        eventSource?.close();
        if (activeLabel) setActiveJob(activeLabel, data.status || 'fail');
        setStopEnabled(false);
        afterExit?.(data);
      }
    });
  }
}

async function startHomeSetupJob(action, label, { successMessage, failureMessage } = {}) {
  const log = view.querySelector('#homeLog');
  if (log) log.textContent = `${label} 중입니다...`;
  setActiveJob(label, 'starting');
  try {
    const { job } = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ module: 'setup', action, params: { confirmRisk: true } }),
    });
    activeJobId = job.id;
    setActiveJob(label, 'running');
    watchJobExit(job.id, {
      activeLabel: label,
      afterExit: (event) => {
        if (event.status === 'pass') {
          if (log) log.textContent = successMessage || `${label}가 끝났습니다. 앱에서 백업할 방을 선택한 뒤 이 브라우저로 돌아와 백업 시작을 누르세요.`;
          setTimeout(() => { render(); }, 700);
        } else if (log) {
          log.textContent = failureMessage || `${label}에 실패했습니다. 준비 확인에서 막힌 항목을 확인하세요.`;
        }
      },
    });
  } catch (err) {
    if (log) log.textContent = friendlyJobError(err);
    setActiveJob(label, 'fail');
  }
}

function friendlyJobError(err) {
  if (err.data?.code === 'FOREGROUND_BUSY') return '다른 화면 사용 작업이 끝난 뒤 다시 시작하세요.';
  if (err.data?.code === 'CONFIRMATION_REQUIRED') return '이 작업은 화면을 조작하므로 확인이 필요합니다. 다시 시도해 주세요.';
  if (err.data?.code === 'BAD_PARAMS') return err.message;
  if (err.data?.code === 'UNKNOWN_JOB' || err.data?.code === 'BAD_JOB_NAME') return '요청한 작업을 찾지 못했습니다. 화면을 새로고침한 뒤 다시 시도하세요.';
  if (err.data?.code === 'NOT_FOUND') return '요청한 진행 기록을 찾지 못했습니다. 진행 기록을 새로고침하세요.';
  if (err.data?.code === 'BAD_COMMAND') return '작업을 시작하지 못했습니다. 준비 확인을 실행한 뒤 다시 시도하세요.';
  if (err.data?.code === 'MISSING_WSL' || err.data?.code === 'MISSING_WSL_TOOL') {
    return '이 선택 기능은 고급 실행 환경이 필요합니다. 기본 카카오톡/위챗 백업은 이 화면의 기본 버튼으로 먼저 진행하세요.';
  }
  if (/wsl|wsl\.exe/iu.test(err.message)) return '고급 실행 환경을 찾지 못했습니다. 기본 백업은 그대로 사용할 수 있고, 선택 기능은 준비 확인에서 확인하세요.';
  return '작업을 시작하지 못했습니다. 준비 확인과 진행 기록을 확인하세요.';
}

function compactBackupRoomLine(value) {
  const text = String(value || '').replace(/\s+/gu, ' ').trim();
  return text.length > 96 ? `${text.slice(0, 95)}...` : text;
}

function backupAttentionRooms(logText) {
  const lines = String(logText || '').split(/\r?\n/u);
  const markerIndex = lines.findIndex((line) => /^확인 필요 방:\s*[\d,]+개/u.test(line.trim()));
  if (markerIndex < 0) return { count: 0, rooms: [], more: 0 };
  const countMatch = lines[markerIndex].match(/^확인 필요 방:\s*([\d,]+)개/u);
  const count = parseDisplayNumber(countMatch?.[1] || 0);
  const rooms = [];
  let explicitMore = 0;
  for (const line of lines.slice(markerIndex + 1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const room = trimmed.match(/^\d+\.\s+(.+)$/u);
    if (room) {
      rooms.push(compactBackupRoomLine(room[1]));
      continue;
    }
    const more = trimmed.match(/^\.\.\.\s*([\d,]+)개 더/u);
    if (more) {
      explicitMore = parseDisplayNumber(more[1]);
      continue;
    }
    if (/^저장된 결과/u.test(trimmed)) break;
    if (rooms.length) break;
  }
  const more = explicitMore || Math.max(0, count - rooms.length);
  return { count, rooms, more };
}

function backupCandidateRooms(logText) {
  const lines = String(logText || '').split(/\r?\n/u);
  const rooms = [];
  let inCandidateList = false;
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    const summary = trimmed.match(/^후보 요약:\s*([\d,]+)개/u);
    if (summary) {
      count = parseDisplayNumber(summary[1]);
      inCandidateList = false;
      continue;
    }
    if (/^후보 목록:/u.test(trimmed)) {
      inCandidateList = true;
      continue;
    }
    if (!inCandidateList) continue;
    const room = trimmed.match(/^\d+\.\s+(.+)$/u);
    if (room) {
      const label = compactBackupRoomLine(room[1]);
      if (label && !rooms.includes(label)) rooms.push(label);
      continue;
    }
    if (/^후보가 맞으면|^새 후보가 없습니다|^후보를 찾지 못했습니다/u.test(trimmed)) {
      inCandidateList = false;
      continue;
    }
    if (trimmed && !/^후보/u.test(trimmed)) inCandidateList = false;
  }
  const total = count || rooms.length;
  return { count: total, rooms, more: Math.max(0, total - rooms.length) };
}

function attentionRoomsHtml(attention) {
  if (!attention?.count || !attention.rooms?.length) return '';
  const visibleRooms = attention.rooms.slice(0, 6);
  const hiddenCount = Math.max(0, attention.rooms.length - visibleRooms.length) + Math.max(0, attention.more || 0);
  const items = visibleRooms.map((room) => `<li>${esc(room)}</li>`).join('');
  const more = hiddenCount > 0 ? `<li>그 외 ${displayNumber(hiddenCount)}개는 진행 로그에서 이어서 확인하세요.</li>` : '';
  return `
    <div class="attention-room-list" aria-label="확인 필요 방 목록">
      <span>확인 필요 방 ${displayNumber(attention.count)}개</span>
      <ol>${items}${more}</ol>
    </div>
  `;
}

function attentionFollowupHtml({ listLimit = false, partialResults = false, attention = null } = {}) {
  if (!listLimit && !partialResults && !attention?.count) return '';
  return `
    <div class="attention-followup" aria-label="확인 필요 방 처리 순서">
      <strong>다음 순서</strong>
      <ol>
        <li>먼저 저장된 결과 보기로 이미 저장된 방을 확인합니다.</li>
        <li>확인 필요 방 보기에서 빠진 방이나 실패한 방을 확인합니다.</li>
        <li>빠진 방이 있으면 같은 백업 다시 실행으로 다시 시도합니다.</li>
      </ol>
    </div>
  `;
}

function candidateRoomsHtml(candidates) {
  if (!candidates?.count || !candidates.rooms?.length) return '';
  const visibleRooms = candidates.rooms.slice(0, 6);
  const hiddenCount = Math.max(0, candidates.rooms.length - visibleRooms.length) + Math.max(0, candidates.more || 0);
  const items = visibleRooms.map((room) => `<li>${esc(room)}</li>`).join('');
  const more = hiddenCount > 0 ? `<li>그 외 ${displayNumber(hiddenCount)}개는 진행 로그에서 이어서 확인하세요.</li>` : '';
  return `
    <div class="candidate-room-list" aria-label="후보 방 목록">
      <span>후보 방 ${displayNumber(candidates.count)}개</span>
      <ol>${items}${more}</ol>
    </div>
  `;
}

function setBackupNextActions(mode, retryJob = null, options = {}) {
  const target = view.querySelector('#backupNextActions');
  if (!target) return;
  if (mode === 'clear') {
    target.innerHTML = '';
    return;
  }
  const pass = mode === 'pass';
  const preview = mode === 'preview';
  const listComplete = Boolean(options.listComplete);
  const missingResults = mode === 'missing-results';
  const setupRecovery = mode === 'setup-recovery';
  const needSelection = mode === 'need-selection';
  const needPreview = mode === 'need-preview';
  const previewListLimit = mode === 'preview-list-limit';
  const listLimit = mode === 'list-limit';
  const partialResults = mode === 'partial-results';
  const candidateEmpty = mode === 'candidate-empty';
  const attention = options.attention || { count: 0, rooms: [], more: 0 };
  const candidates = options.candidates || { count: 0, rooms: [], more: 0 };
  const selection = options.selection || {};
  const alternateJob = options.alternateJob || null;
  const hasCandidateRooms = Boolean(candidates.count && candidates.rooms?.length);
  const canRetry = Boolean(retryJob?.module && retryJob?.action);
  const canAlternate = Boolean(alternateJob?.module && alternateJob?.action);
  const candidateOpenAction = candidateEmpty && retryJob?.module === 'kakao'
    ? { action: 'open_kakaotalk', label: '카카오톡 열기' }
    : (candidateEmpty && retryJob?.module === 'wechat' ? { action: 'open_wechat', label: '위챗 열기' } : null);
  const outcome = (() => {
    if (pass) {
      return {
        status: 'pass',
        title: listComplete ? '왼쪽 목록 끝까지 백업했습니다' : '백업이 끝났습니다',
        text: listComplete
          ? '새 방이 더 이상 나오지 않아 자동으로 멈췄습니다. 결과 보기에서 대화를 확인하고 필요한 경우 전체 표 파일 저장 또는 전체 텍스트 저장을 누릅니다.'
          : '결과 보기를 눌러 대화를 확인하세요. 결과가 비어 있으면 결과 새로고침을 먼저 누릅니다.',
      };
    }
    if (preview) {
      return {
        status: 'ready',
        title: '목록 확인이 끝났습니다',
        text: hasCandidateRooms
          ? '아래 후보 방이 맞으면 목록 백업 실행을 누르고, 다르면 앱에서 목록 위치를 다시 맞춥니다.'
          : '번호가 붙은 후보 목록이 맞으면 목록 백업 실행을 누르고, 다르면 앱에서 목록 위치를 다시 맞춥니다.',
      };
    }
    if (needSelection) {
      return {
        status: 'review',
        title: selection.title || '방 선택 완료 표시가 필요합니다',
        text: selection.text || '앱에서 백업할 방을 선택하고 앱 창을 앞에 둔 뒤 이 화면으로 돌아와 방 선택 완료, 앱 창 앞에 둠 체크박스를 선택하고 백업을 누르세요.',
      };
    }
    if (needPreview) {
      return {
        status: 'review',
        title: '먼저 전체 목록 확인이 필요합니다',
        text: '목록 백업 실행은 후보 방을 확인한 뒤 시작합니다. 전체 목록 확인으로 번호가 붙은 후보 방 이름을 먼저 확인하세요.',
      };
    }
    if (previewListLimit) {
      return {
        status: 'review',
        title: '전체 목록을 더 확인해야 합니다',
        text: canRetry
          ? '아직 방을 클릭하지 않았습니다. 전체 목록 끝을 보장하려면 상한 늘려 전체 목록 다시 확인을 눌러 후보 확인부터 다시 진행하세요.'
          : '아직 방을 클릭하지 않았습니다. 가능한 상한을 이미 최대로 올린 상태입니다. 현재 후보만 백업할 수 있지만 전체 목록이 끝났다고 보장하기 어렵습니다.',
      };
    }
    if (candidateEmpty) {
      return {
        status: 'review',
        title: '후보 방을 찾지 못했습니다',
        text: '카카오톡 또는 위챗 창의 왼쪽 채팅 목록이 보이게 한 뒤 목록 확인 다시를 누르세요. 앱이 꺼져 있으면 먼저 앱 열기를 누릅니다.',
      };
    }
    if (missingResults) {
      return {
        status: 'review',
        title: '백업은 끝났지만 결과를 아직 찾지 못했습니다',
        text: '결과 새로고침을 누르고, 계속 비어 있으면 같은 백업 다시 실행 또는 백업 폴더 열기를 확인하세요.',
      };
    }
    if (listLimit) {
      return {
        status: 'review',
        title: '목록을 더 확인해야 할 수 있습니다',
        text: canRetry
          ? '방 개수 또는 페이지 상한에 도달했습니다. 저장된 결과는 볼 수 있지만, 전체 목록이 끝났다고 보장하기 어렵습니다. 상한 늘려 전체 목록 다시 확인을 누르면 더 큰 상한으로 후보 확인부터 다시 시작합니다.'
          : '방 개수 또는 페이지 상한에 도달했습니다. 가능한 상한을 이미 최대로 올린 상태입니다. 저장된 결과를 먼저 보고, 확인 필요 방 보기에서 빠진 방을 확인한 뒤 다시 백업하세요.',
      };
    }
    if (partialResults) {
      return {
        status: 'review',
        title: '일부 방은 확인이 필요합니다',
        text: attention.count
          ? '저장된 대화는 결과 보기에서 먼저 확인할 수 있습니다. 아래 방은 확인 필요 방 보기에서 확인한 뒤 다시 실행하세요.'
          : '저장된 대화는 결과 보기에서 확인할 수 있습니다. 빠진 방이나 실패한 방이 있으면 같은 백업 다시 실행 또는 진행 기록을 확인하세요.',
      };
    }
    if (setupRecovery) {
      return {
        status: 'review',
        title: '앱을 열지 못했습니다',
        text: '설치되어 있지 않으면 공식 설치 페이지를 열어 설치와 로그인을 마친 뒤 상태 새로고침을 누르세요.',
      };
    }
    return {
      status: 'fail',
      title: '백업이 끝나지 않았습니다',
      text: '마지막 안내를 확인하고, 준비 확인 또는 진행 기록에서 막힌 항목을 확인하세요.',
    };
  })();
  const retryPrimary = mode === 'fail' || setupRecovery || preview || needPreview || previewListLimit || listLimit;
  const retryButton = canRetry
    ? `<button data-next="retry" class="${retryPrimary ? 'primary' : ''}" type="button">${esc(retryJob.buttonLabel || '같은 백업 다시 실행')}</button>`
    : '';
  const alternateButton = canAlternate
    ? `<button data-next="alternate" class="${previewListLimit && !canRetry ? 'primary' : ''}" type="button">${esc(alternateJob.buttonLabel || '현재 후보로 목록 백업 실행')}</button>`
    : '';
  const openAppButton = candidateOpenAction
    ? `<button data-next="open-app" class="primary" type="button">${esc(candidateOpenAction.label)}</button>`
    : '';
  const selectRoomButton = needSelection
    ? `<button data-next="select-room" class="primary" type="button">${esc(selection.buttonLabel || '방 선택 완료 표시로 이동')}</button>`
    : '';
  const chatsButtonLabel = missingResults ? '결과 새로고침' : ((listLimit || partialResults) ? '저장된 결과 보기' : '결과 보기');
  const jobsButtonLabel = (listLimit || partialResults || attention.count) ? '확인 필요 방 보기' : '진행 기록';
  target.innerHTML = `
    <div class="next-actions-summary ${statusClass(outcome.status)}">
      <strong>${esc(outcome.title)}</strong>
      <p>${esc(outcome.text)}</p>
      ${candidateRoomsHtml(candidates)}
      ${attentionRoomsHtml(attention)}
      ${attentionFollowupHtml({ listLimit, partialResults, attention })}
    </div>
    <div class="next-actions-buttons">
      <button data-next="ready" class="${pass || preview || missingResults || previewListLimit || listLimit || partialResults || candidateEmpty || canRetry ? '' : 'primary'}" type="button">준비 확인</button>
      <button data-next="refresh" class="${missingResults && !canRetry ? 'primary' : ''}" type="button">상태 새로고침</button>
      ${openAppButton}
      ${selectRoomButton}
      ${retryButton}
      ${alternateButton}
      <button data-next="jobs" type="button">${esc(jobsButtonLabel)}</button>
      <button data-next="chats" class="${pass || missingResults || listLimit || partialResults ? 'primary' : ''}" type="button">${esc(chatsButtonLabel)}</button>
      <button data-next="folder" type="button">백업 폴더 열기</button>
    </div>
  `;
  target.querySelector('[data-next="ready"]').addEventListener('click', () => navigate('/doctor'));
  target.querySelector('[data-next="refresh"]').addEventListener('click', render);
  target.querySelector('[data-next="open-app"]')?.addEventListener('click', () => startBackupJob('setup', candidateOpenAction.action, {}, candidateOpenAction.label));
  target.querySelector('[data-next="select-room"]')?.addEventListener('click', () => {
    const input = selection.focusSelector ? view.querySelector(selection.focusSelector) : null;
    const line = input?.closest('.confirm-line');
    line?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    input?.focus();
    line?.classList.add('attention');
    if (line) setTimeout(() => line.classList.remove('attention'), 2200);
  });
  target.querySelector('[data-next="retry"]')?.addEventListener('click', () => startBackupJob(retryJob.module, retryJob.action, retryJob.params || {}, retryJob.label || '백업 다시 실행'));
  target.querySelector('[data-next="alternate"]')?.addEventListener('click', () => startBackupJob(alternateJob.module, alternateJob.action, alternateJob.params || {}, alternateJob.label || '목록 백업 실행'));
  target.querySelector('[data-next="jobs"]').addEventListener('click', () => navigate('/jobs'));
  target.querySelector('[data-next="chats"]').addEventListener('click', () => navigate('/chats'));
  target.querySelector('[data-next="folder"]').addEventListener('click', () => startBackupJob('setup', 'open_backup_folder', {}, '백업 폴더 열기'));
}

function retryableBackupJob(module, action, params, label) {
  if (module !== 'kakao' && module !== 'wechat') return null;
  if (module === 'wechat' && action === 'validate_db') return null;
  return { module, action, params, label };
}

function setupRecoveryJob(action) {
  if (action === 'open_wechat') {
    return { module: 'setup', action: 'open_wechat_download', params: {}, label: '위챗 공식 설치 페이지 열기', buttonLabel: '위챗 공식 설치 페이지' };
  }
  if (action === 'open_kakaotalk') {
    return { module: 'setup', action: 'open_kakaotalk_download', params: {}, label: '카카오톡 공식 설치 페이지 열기', buttonLabel: '카카오톡 공식 설치 페이지' };
  }
  return null;
}

function backupRunningGuardText(module, action) {
  if (module !== 'kakao' && module !== 'wechat') return '';
  if (module === 'wechat' && action === 'validate_db') return '';
  return '백업 중에는 앱 창을 최소화하거나 다른 창으로 가리지 마세요. 화면 글자를 읽는 동안 채팅방이 앞에 보여야 합니다.\n';
}

function backupListLimitHit(logText) {
  return /확인 필요:\s*(?:방 개수|페이지) 상한에 도달했습니다/u.test(String(logText || ''));
}

function backupListCompleteHit(logText) {
  return /목록 끝까지 확인했습니다\. 새 방이 더 이상 나오지 않아 자동으로 멈췄습니다/u.test(String(logText || ''));
}

function backupLimitKind(logText) {
  const text = String(logText || '');
  if (/방 개수 상한/u.test(text)) return 'room';
  if (/페이지 상한/u.test(text)) return 'page';
  return 'both';
}

function batchLimitValue(value, fallback, max, step) {
  const parsed = Number(value);
  const current = Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  if (current >= max) return max;
  return Math.min(max, Math.max(current + step, Math.ceil(current * 1.5)));
}

function expandedBatchPreviewJob(module, params = {}, limitKind = 'both') {
  if (module !== 'kakao' && module !== 'wechat') return null;
  const platformLabel = module === 'wechat' ? '위챗' : '카카오톡';
  const currentPages = Number.isInteger(Number(params.pages)) && Number(params.pages) > 0 ? Number(params.pages) : 80;
  const currentRoomLimit = Number.isInteger(Number(params.roomLimit)) && Number(params.roomLimit) > 0 ? Number(params.roomLimit) : 200;
  const nextPages = limitKind === 'room' ? currentPages : batchLimitValue(currentPages, 80, 200, 40);
  const nextRoomLimit = limitKind === 'page' ? currentRoomLimit : batchLimitValue(currentRoomLimit, 200, 500, 100);
  if (nextPages === currentPages && nextRoomLimit === currentRoomLimit) return null;
  return {
    module,
    action: 'visible_batch',
    params: {
      ...params,
      dryRun: true,
      allVisible: true,
      pages: nextPages,
      roomLimit: nextRoomLimit,
    },
    label: `${platformLabel} 전체 목록 다시 확인`,
    buttonLabel: '상한 늘려 전체 목록 다시 확인',
  };
}

function backupPartialResultsHit(logText) {
  const text = String(logText || '');
  const friendly = text.match(/백업 요약:\s*처리\s*([\d,]+)개,\s*정상\s*([\d,]+)개,\s*확인 필요\s*([\d,]+)개,\s*실패\s*([\d,]+)개/u);
  if (friendly) return (parseDisplayNumber(friendly[3]) + parseDisplayNumber(friendly[4])) > 0;
  const batch = text.match(/백업 요약:\s*처리\s*([\d,]+)개,\s*정상\s*([\d,]+)개,\s*검토\s*([\d,]+)개,\s*확인 필요\s*([\d,]+)개/u);
  if (batch) return (parseDisplayNumber(batch[3]) + parseDisplayNumber(batch[4])) > 0;
  return false;
}

async function startBackupJob(module, action, params, label) {
  const log = view.querySelector('#backupLog');
  const titleEl = view.querySelector('#backupJobTitle');
  const guardText = backupRunningGuardText(module, action);
  if (log) log.textContent = `작업을 시작하는 중입니다...\n${guardText}`;
  if (titleEl) titleEl.textContent = label;
  setActiveJob(label, 'starting');
  setBackupNextActions('clear');
  try {
    const { job } = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ module, action, params: { ...params, confirmRisk: true } }),
    });
    activeJobId = job.id;
    setActiveJob(label, 'running');
    if (titleEl) titleEl.textContent = `${label} 진행 중`;
    streamJob(job.id, {
      title: `${label} 진행 중`,
      activeLabel: label,
      initialText: guardText,
      afterExit: (event, logEl) => handleBackupJobExit({ module, action, params, label, event, logEl }),
    });
  } catch (err) {
    if (log) log.textContent = `${friendlyJobError(err)}\n`;
    setActiveJob(label, 'fail');
    setBackupNextActions('fail', retryableBackupJob(module, action, params, label));
  }
}

async function handleBackupJobExit({ module, action, params, label, event, logEl }) {
  const titleEl = view.querySelector('#backupJobTitle');
  if (event.status !== 'pass') {
    if (titleEl) titleEl.textContent = `${label} 확인 필요`;
    const recoveryJob = module === 'setup' ? setupRecoveryJob(action) : null;
    if (logEl) {
      if (module === 'setup' && action === 'open_kakaotalk') {
        logEl.textContent += '카카오톡을 열지 못했습니다. 설치되어 있지 않으면 아래 카카오톡 공식 설치 페이지 버튼을 누르세요.\n';
      } else if (module === 'setup' && action === 'open_wechat') {
        logEl.textContent += '위챗을 열지 못했습니다. 설치되어 있지 않으면 아래 위챗 공식 설치 페이지 버튼을 누르세요.\n';
      } else {
        logEl.textContent += '작업이 끝나지 않았습니다. 준비 상태와 진행 기록을 확인하세요.\n';
      }
    }
    setBackupNextActions(recoveryJob ? 'setup-recovery' : 'fail', recoveryJob || retryableBackupJob(module, action, params, label));
    return;
  }
  if (module === 'setup' && action === 'open_backup_folder') {
    if (titleEl) titleEl.textContent = '백업 폴더 열림';
    if (logEl) logEl.textContent += '백업 폴더를 열었습니다.\n';
    setBackupNextActions('pass');
    return;
  }
  if (module === 'setup') {
    if (titleEl) titleEl.textContent = `${label} 완료`;
    if (logEl) logEl.textContent += '준비 상태를 다시 확인합니다...\n';
    backupReturnNotice = setupReturnNotice(action);
    setTimeout(() => { render(); }, 700);
    return;
  }
  if (params?.dryRun) {
    let previewJob = null;
    let retryPreviewJob = null;
    const candidates = (module === 'wechat' || module === 'kakao') && action === 'visible_batch'
      ? backupCandidateRooms(logEl?.textContent || '')
      : { count: 0, rooms: [], more: 0 };
    if ((module === 'wechat' || module === 'kakao') && action === 'visible_batch') {
      const batchParams = { ...(params || {}) };
      delete batchParams.dryRun;
      const platformLabel = module === 'wechat' ? '위챗' : '카카오톡';
      if (candidates.count > 0) {
        if (module === 'wechat') wechatBatchPreviewSignature = JSON.stringify(batchParams);
        if (module === 'kakao') kakaoBatchPreviewSignature = JSON.stringify(batchParams);
      }
      previewJob = candidates.count > 0 ? {
        module,
        action: 'visible_batch',
        params: batchParams,
        label: `${platformLabel} 목록 백업 실행`,
        buttonLabel: '목록 백업 실행',
      } : null;
      retryPreviewJob = {
        module,
        action: 'visible_batch',
        params,
        label,
        buttonLabel: '목록 확인 다시',
      };
    }
    if (titleEl) titleEl.textContent = `${label} 완료`;
    if ((module === 'wechat' || module === 'kakao') && action === 'visible_batch' && backupListLimitHit(logEl?.textContent || '')) {
      const retryJob = expandedBatchPreviewJob(module, params, backupLimitKind(logEl?.textContent || ''));
      if (logEl) logEl.textContent += retryJob
        ? '후보는 찾았지만 전체 목록 끝을 확인하지 못했습니다. 상한 늘려 전체 목록 다시 확인을 누른 뒤 후보를 다시 확인하세요.\n'
        : '후보는 찾았지만 전체 목록 끝을 확인하지 못했습니다. 현재 상한을 더 올릴 수 없으므로 현재 후보로 목록 백업 실행을 누를 수 있습니다.\n';
      setBackupNextActions('preview-list-limit', retryJob, { candidates, alternateJob: retryJob ? null : previewJob });
      return;
    }
    if (logEl) logEl.textContent += candidates.count && candidates.rooms?.length
      ? '목록 확인이 끝났습니다. 아래 후보 방이 맞으면 목록 백업 실행 버튼을 누르세요.\n'
      : '후보 방을 찾지 못했습니다. 앱의 왼쪽 채팅 목록이 보이게 한 뒤 목록 확인 다시를 누르세요.\n';
    setBackupNextActions(candidates.count > 0 ? 'preview' : 'candidate-empty', candidates.count > 0 ? previewJob : retryPreviewJob, { candidates });
    return;
  }
  const producedChatArtifact = (module === 'kakao') || (module === 'wechat' && action !== 'validate_db');
  if (!producedChatArtifact) {
    if (titleEl) titleEl.textContent = `${label} 완료`;
    setBackupNextActions('pass');
    return;
  }
  if (titleEl) titleEl.textContent = `${label} 완료`;
  const backupLogText = logEl?.textContent || '';
  const attention = action === 'visible_batch' ? backupAttentionRooms(backupLogText) : { count: 0, rooms: [], more: 0 };
  const listComplete = action === 'visible_batch' && backupListCompleteHit(backupLogText);
  if (action === 'visible_batch' && backupListLimitHit(backupLogText)) {
    if (titleEl) titleEl.textContent = `${label} 확인 필요`;
    const retryJob = expandedBatchPreviewJob(module, params, backupLimitKind(backupLogText));
    if (logEl) logEl.textContent += retryJob
      ? '저장된 결과는 볼 수 있습니다. 전체 목록이 끝났다고 보장하려면 아래 상한 늘려 전체 목록 다시 확인을 누른 뒤 후보를 다시 확인하세요.\n'
      : '저장된 결과는 볼 수 있습니다. 현재 상한을 더 올릴 수 없으므로 확인 필요 방 보기에서 빠진 방을 보고 다시 백업하세요.\n';
    setBackupNextActions('list-limit', retryJob, { attention });
    return;
  }
  const partialResults = action === 'visible_batch' && backupPartialResultsHit(backupLogText);
  try {
    const refreshRes = await fetch('/chat-viewer/api/refresh', { cache: 'no-store' });
    const refreshData = await refreshRes.json().catch(() => ({}));
    if (Number(refreshData?.rooms || 0) > 0) {
      if (partialResults) {
        if (titleEl) titleEl.textContent = `${label} 확인 필요`;
        if (logEl) logEl.textContent += '저장된 결과는 볼 수 있습니다. 일부 방은 확인이 필요하므로 결과 보기와 진행 기록에서 빠진 방을 확인하세요.\n';
        setBackupNextActions('partial-results', { module, action, params, label }, { attention });
      } else {
        if (logEl) logEl.textContent += '완료했습니다. 결과 보기에서 확인할 수 있습니다.\n';
        setBackupNextActions('pass', { module, action, params, label }, { listComplete });
      }
    } else {
      if (logEl) logEl.textContent += '작업은 끝났지만 아직 결과 화면에서 찾을 수 있는 백업이 없습니다. 결과 새로고침을 누르고, 그래도 비어 있으면 같은 백업 다시 실행 또는 백업 폴더를 확인하세요.\n';
      setBackupNextActions('missing-results', { module, action, params, label });
    }
  } catch {
    if (partialResults) {
      if (titleEl) titleEl.textContent = `${label} 확인 필요`;
      if (logEl) logEl.textContent += '저장된 결과는 볼 수 있습니다. 일부 방은 확인이 필요하므로 결과 보기와 진행 기록에서 빠진 방을 확인하세요.\n';
      setBackupNextActions('partial-results', { module, action, params, label }, { attention });
    } else {
      if (logEl) logEl.textContent += '완료했습니다. 결과 보기에서 새로고침을 눌러 확인하세요.\n';
      setBackupNextActions('pass', { module, action, params, label }, { listComplete });
    }
    return;
  }
}

function setupReturnNotice(action) {
  const notices = {
    open_language_settings: 'Windows 언어 설정이 열렸습니다. 언어 추가를 누르고 카카오톡은 한국어, 위챗은 중국어(간체, 중국) 또는 중국어(번체, 대만/홍콩) 중 하나를 추가하세요. 기본 선택 그대로 설치하고, 끝나면 이 화면으로 돌아와 상태 새로고침을 누르세요.',
    install_ocr_zh: '중국어 문자 인식 설치를 시도했습니다. Windows 권한 확인 창이 떴다면 예를 누르고, 창이 보이지 않으면 작업 표시줄의 새 권한 확인 창 또는 방패 아이콘을 확인하세요. 끝나면 상태 새로고침을 눌러 위챗 백업 준비 상태를 다시 확인하세요. 자동 설치가 막혔다면 Windows 언어 설정 열기로 직접 설치하세요.',
    install_ocr_ko: '한국어 문자 인식 설치를 시도했습니다. Windows 권한 확인 창이 떴다면 예를 누르고, 창이 보이지 않으면 작업 표시줄의 새 권한 확인 창 또는 방패 아이콘을 확인하세요. 끝나면 상태 새로고침을 눌러 카카오톡 백업 준비 상태를 다시 확인하세요. 자동 설치가 막혔다면 Windows 언어 설정 열기로 직접 설치하세요.',
    open_wechat: '위챗이 열렸습니다. 위챗에서 백업할 방을 선택하고 위챗 창을 앞에 둔 뒤 이 브라우저로 돌아와 방 선택 완료, 앱 창 앞에 둠 표시를 하고 백업을 누르세요.',
    open_kakaotalk: '카카오톡이 열렸습니다. 카카오톡에서 백업할 방을 열고 카카오톡 창을 앞에 둔 뒤 이 브라우저로 돌아와 방 선택 완료, 앱 창 앞에 둠 표시를 하고 백업을 누르세요.',
    open_wechat_download: '위챗 공식 설치 페이지가 열렸습니다. 설치와 로그인이 끝나면 이 화면의 상태 새로고침을 누르세요.',
    open_kakaotalk_download: '카카오톡 공식 설치 페이지가 열렸습니다. 설치와 로그인이 끝나면 이 화면의 상태 새로고침을 누르세요.',
    wsl_tools: '고급 기능 도구 준비가 끝났습니다. 기본 카카오톡/위챗 백업은 지금 열린 방 백업 카드에서 계속 진행하세요.',
  };
  return notices[action] || '';
}

async function backupView() {
  await api('/api/config');
  const renderToken = ++backupRenderToken;
  const queuedDoctor = queuedDoctorReport;
  if (queuedDoctor) queuedDoctorReport = null;
  const doctorPromise = queuedDoctor
    ? null
    : api('/api/doctor').catch(() => null);
  const doctorResult = queuedDoctor
    ? { ready: true, report: queuedDoctor }
    : await Promise.race([
      doctorPromise.then((report) => ({ ready: true, report })),
      delay(500).then(() => ({ ready: false, report: null })),
    ]);
  const doctorPending = !doctorResult.ready;
  if (doctorPending && doctorPromise) {
    doctorPromise.then((report) => {
      queuedDoctorReport = report;
      if (backupRenderToken === renderToken && routePath() === '/backup') render();
    }).catch(() => {});
  }
  const doctor = doctorResult.ready
    ? doctorResult.report
    : { status: 'checking', counts: { pass: 0, review: 0, fail: 0 }, checks: [], pending: true };
  const checkById = (id) => doctor?.checks?.find((check) => check.id === id);
  const kakaoOcrCheckId = checkById('windows_ocr_ko') ? 'windows_ocr_ko' : 'windows_ocr';
  const wechatOcrCheckId = checkById('windows_ocr_zh') ? 'windows_ocr_zh' : 'windows_ocr';
  const chatOcrReady = checkById(kakaoOcrCheckId)?.status === 'pass' && checkById(wechatOcrCheckId)?.status === 'pass';
  const anyChatOcrReady = checkById(kakaoOcrCheckId)?.status === 'pass' || checkById(wechatOcrCheckId)?.status === 'pass';
  const coreToolReady = ['powershell', 'node', 'shots_writable', 'state_writable', 'runs_writable', 'windows_ocr']
    .every((id) => checkById(id)?.status === 'pass');
  const fullBackupReady = coreToolReady && chatOcrReady;
  const coreBackupReady = coreToolReady && anyChatOcrReady;
  const hasWslToolChecks = Boolean(checkById('wsl_node'));
  const kakaoOpenRequired = ['powershell', kakaoOcrCheckId];
  const kakaoVisibleRequired = ['powershell', kakaoOcrCheckId];
  const kakaoOpenchatRequired = ['powershell', kakaoOcrCheckId];
  const wechatCurrentRequired = ['powershell', wechatOcrCheckId];
  const wechatBatchRequired = ['powershell', wechatOcrCheckId];
  const wechatValidateRequired = hasWslToolChecks
    ? ['wsl', 'wsl_node', 'wsl_sqlite3']
    : ['wsl', 'node', 'sqlite3'];
  const missingChecks = (ids) => ids.map(checkById).filter((check) => check && check.status !== 'pass');
  const runningApps = new Set((checkById('gui_apps')?.details?.running || []).map((name) => String(name)));
  const appCheck = (id, label, message) => ({ id, label, status: 'review', message });
  const kakaoAppMissing = doctorPending || runningApps.has('KakaoTalk')
    ? []
    : [appCheck('app_kakaotalk', '카카오톡', '카카오톡을 실행하고 로그인하세요. 설치되어 있지 않으면 먼저 설치하세요.')];
  const wechatAppMissing = doctorPending || runningApps.has('Weixin') || runningApps.has('WeChat')
    ? []
    : [appCheck('app_wechat', '위챗', '위챗을 실행하고 로그인하세요. 설치되어 있지 않으면 먼저 설치하세요.')];
  const kakaoOpenToolMissing = missingChecks(kakaoOpenRequired);
  const kakaoVisibleToolMissing = missingChecks(kakaoVisibleRequired);
  const kakaoOpenchatToolMissing = missingChecks(kakaoOpenchatRequired);
  const wechatCurrentToolMissing = missingChecks(wechatCurrentRequired);
  const wechatBatchToolMissing = missingChecks(wechatBatchRequired);
  const wechatValidateMissing = missingChecks(wechatValidateRequired);
  const kakaoMissing = [...kakaoOpenToolMissing, ...kakaoAppMissing];
  const kakaoVisibleMissing = [...kakaoVisibleToolMissing, ...kakaoAppMissing];
  const kakaoBatchMissing = [...kakaoVisibleToolMissing, ...kakaoAppMissing];
  const kakaoOpenchatMissing = [...kakaoOpenchatToolMissing, ...kakaoAppMissing];
  const wechatMissing = [...wechatCurrentToolMissing, ...wechatAppMissing];
  const wechatBatchMissing = [...wechatBatchToolMissing, ...wechatAppMissing];
  const environmentMissing = [...new Map([...kakaoOpenToolMissing, ...kakaoVisibleToolMissing, ...kakaoOpenchatToolMissing, ...wechatCurrentToolMissing, ...wechatBatchToolMissing].map((check) => [check.id, check])).values()];
  const allMissing = [...new Map([...kakaoMissing, ...kakaoVisibleMissing, ...kakaoOpenchatMissing, ...wechatMissing, ...wechatBatchMissing].map((check) => [check.id, check])).values()];
  const backupHash = hashTargetId();
  const backupTarget = backupHash.startsWith('kakao') ? 'kakao' : (backupHash.startsWith('wechat') ? 'wechat' : '');
  const fullBackupTarget = backupHash === 'kakao-full' ? 'kakao' : (backupHash === 'wechat-full' ? 'wechat' : '');
  const targetLabel = backupTarget === 'wechat' ? '위챗' : (backupTarget === 'kakao' ? '카카오톡' : '');
  const targetMissing = backupTarget === 'wechat'
    ? wechatMissing
    : (backupTarget === 'kakao' ? kakaoMissing : []);
  const backupBadge = (() => {
    if (doctorPending) return { label: '준비 확인 중', status: 'ready' };
    if (!doctor) return { label: '준비 확인 필요', status: 'review' };
    if (targetLabel) {
      return targetMissing.length
        ? { label: `${targetLabel} 준비 확인`, status: 'review' }
        : { label: `${targetLabel} 백업 가능`, status: 'pass' };
    }
    if (fullBackupReady) return { label: '기본 도구 준비됨', status: 'pass' };
    if (coreBackupReady) return { label: '준비할 항목 있음', status: 'partial' };
    return { label: '먼저 할 일 있음', status: 'review' };
  })();
  const doctorBadge = doctor
    ? `<span class="badge ${statusClass(backupBadge.status)}">${esc(backupBadge.label)}</span>`
    : '<span class="badge status-review">준비 확인 필요</span>';
  const backupCheckLabel = (check) => {
    if (check.id === 'app_kakaotalk') return '카카오톡 실행 또는 설치 필요';
    if (check.id === 'app_wechat') return '위챗 실행 또는 설치 필요';
    if (check.id === 'powershell') return 'Windows 기본 실행 확인 필요';
    if (check.id === 'windows_ocr') return 'Windows 문자 인식 언어 확인 필요';
    if (check.id === 'windows_ocr_ko') return '한국어 문자 인식 언어 확인 필요';
    if (check.id === 'windows_ocr_zh') return '중국어 문자 인식 언어 확인 필요';
    if (check.id === 'wsl') return '고급 기능 실행 환경 확인 필요';
    if (check.id === 'wsl_node') return '고급 기능 실행 도구 설치 필요';
    if (check.id === 'wsl_jq') return '고급 기능 보조 도구 설치 필요';
    if (check.id === 'wsl_sqlite3') return '고급 기능 저장 도구 설치 필요';
    if (check.id === 'wsl_tesseract') return '고급 기능용 문자 인식 도구 설치 필요';
    if (check.id === 'wsl_imagemagick') return '고급 기능용 이미지 처리 도구 설치 필요';
    if (check.id === 'ocr_any') return '화면 문자 인식 가능 여부 확인 필요';
    if (check.id === 'node') return '백업 화면 실행 도구 설치 필요';
    if (check.id === 'jq') return '백업 보조 도구 설치 필요';
    if (check.id === 'sqlite3') return '예전 백업 파일 확인 도구 설치 필요';
    if (check.id === 'tesseract') return '문자 인식 도구 설치 필요';
    if (check.id === 'imagemagick') return '이미지 처리 도구 설치 필요';
    return `${check.label} 확인 필요`;
  };
  const noticeItems = targetMissing.map(backupCheckLabel);
  const kakaoOpenDisabled = kakaoMissing.length ? 'disabled' : '';
  const kakaoVisibleDisabled = kakaoVisibleMissing.length ? 'disabled' : '';
  const kakaoBatchDisabled = kakaoBatchMissing.length ? 'disabled' : '';
  const kakaoOpenchatDisabled = kakaoOpenchatMissing.length ? 'disabled' : '';
  const wechatCurrentDisabled = wechatMissing.length ? 'disabled' : '';
  const wechatBatchDisabled = wechatBatchMissing.length ? 'disabled' : '';
  const wechatValidateDisabled = wechatValidateMissing.length ? 'disabled' : '';
  const disabledTitle = (missing) => missing.length ? `title="${esc(missing.map(backupCheckLabel).join(' · '))}"` : '';
  const backupFixText = (check) => {
    const id = String(check?.id || '');
    if (id === 'windows_ocr_zh') return '문자 인식 설정을 열어 중국어(간체, 중국) 또는 중국어(번체, 대만/홍콩) 중 하나를 설치합니다';
    if (id === 'windows_ocr_ko') return '문자 인식 설정을 열어 한국어를 설치합니다';
    if (id === 'windows_ocr' || id === 'ocr_any') return '문자 인식 설정에서 사용할 앱의 언어를 설치합니다';
    if (id === 'app_wechat') return '위챗 열기 또는 공식 설치 페이지로 위챗을 열고 로그인합니다';
    if (id === 'app_kakaotalk') return '카카오톡 열기 또는 공식 설치 페이지로 카카오톡을 열고 로그인합니다';
    return `${backupCheckLabel(check)} 항목을 준비 확인에서 확인합니다`;
  };
  const blockedNote = (missing) => missing.length
    ? `<div class="blocked-note">먼저 ${esc([...new Set(missing.map(backupFixText))].join(', '))}. 완료 후 상태 새로고침을 누르세요.</div>`
    : '';
  const ocrFixAction = (missing) => ocrInstallActionForCheck(firstOcrCheck(missing));
  const ocrFixButton = (missing) => {
    if (!missing.some(isOcrCheck)) return '';
    const action = ocrFixAction(missing);
    return `<button type="button" data-ocr-setup-action="${esc(action.action)}" data-ocr-setup-label="${esc(action.label)}" class="primary">${esc(action.label)}</button>`;
  };
  const setupPowershellCommand = 'wsl --install -d Ubuntu';
  const setupUbuntuCommand = 'sudo apt update && sudo apt install -y nodejs npm jq sqlite3 tesseract-ocr tesseract-ocr-kor tesseract-ocr-chi-sim imagemagick';
  const wslReady = checkById('wsl')?.status === 'pass';
  const missingWslTools = environmentMissing.some((check) => String(check.id || '').startsWith('wsl_'));
  const missingWslSetup = environmentMissing.some((check) => check.id === 'wsl' || String(check.id || '').startsWith('wsl_'));
  const missingWindowsOcrSetup = environmentMissing.some(isOcrCheck);
  const installButton = wslReady && missingWslTools
    ? '<button id="installWslTools" class="primary" type="button">고급 기능 도구 설치</button>'
    : '';
  const ocrSettingsButton = missingWindowsOcrSetup
    ? '<button id="openLanguageSettings" type="button">Windows 언어 설정 열기</button>'
    : '';
  const wslSetupCommands = missingWslSetup
    ? `${installButton}
        <p>기본 백업은 준비된 버튼으로 먼저 진행하세요. 예전 백업 파일 검사나 추가 검수 같은 선택 기능이 필요할 때만 아래 수동 설치 방법을 펼칩니다.</p>
        <details class="setup-advanced">
          <summary>고급 기능 설치 명령 보기</summary>
          <label>1단계: Windows 관리자 창<pre>${esc(setupPowershellCommand)}</pre></label>
          <button data-copy-setup="powershell" type="button">1단계 명령 복사</button>
          <label>2단계: 고급 기능 창<pre>${esc(setupUbuntuCommand)}</pre></label>
          <button data-copy-setup="ubuntu" type="button">2단계 명령 복사</button>
        </details>
        ${ocrSettingsButton}`
    : `<p>문자 인식에 확인이 필요하면 아래 순서대로 언어 기능을 확인한 뒤 상태를 새로고침하세요.</p>
        ${missingWindowsOcrSetup ? ocrSetupGuideHtml() : ''}
        ${ocrSettingsButton}`;
  const captureNotice = environmentMissing.length
    ? `<section class="panel span-12 setup-help-panel">
        <details class="setup-callout setup-callout-compact">
          <summary>
            <span>
              <strong>막힌 버튼이 있으면 여기만 확인하세요</strong>
              <small>준비된 위챗/카카오톡 백업 버튼은 바로 사용할 수 있습니다.</small>
            </span>
          </summary>
          <p>버튼이 비활성화되어 있을 때만 아래 안내를 확인한 뒤 상태를 새로고침하세요.</p>
        ${missingWindowsOcrSetup && missingWslSetup ? ocrSetupGuideHtml() : ''}
        ${wslSetupCommands}
        </details>
      </section>`
    : '';
  const fallbackNotice = !doctorPending && !hasWslToolChecks
    ? `<details class="recovery-details">
        <summary>버튼이 보이지 않거나 막힐 때</summary>
        <p>브라우저를 닫고 압축을 푼 폴더의 1_백업_시작.bat를 다시 더블클릭하세요. Windows가 파일 확장자를 숨기면 1_백업_시작으로 보일 수 있습니다. 보이지 않으면 시작하기 또는 시작하기.bat를 사용해도 됩니다.</p>
      </details>`
    : '';
  const fullBackupTargetMissing = fullBackupTarget === 'kakao'
    ? kakaoBatchMissing
    : (fullBackupTarget === 'wechat' ? wechatBatchMissing : []);
  const fullBackupTargetActionText = (() => {
    if (!fullBackupTarget) return '';
    if (doctorPending) return '준비 상태를 확인하는 중입니다. 잠시 뒤 상태가 갱신되면 앱 창과 왼쪽 목록 준비를 체크하고 전체 목록 확인으로 후보 방을 먼저 봅니다.';
    if (!fullBackupTargetMissing.length) return '앱 창을 앞에 두고 왼쪽 채팅 목록이 보이게 한 뒤 전체 목록 확인 준비 완료 체크박스를 선택하세요. 그 다음 전체 목록 확인으로 후보 방을 먼저 봅니다.';
    if (fullBackupTargetMissing.some(isOcrCheck)) {
      const action = ocrFixAction(fullBackupTargetMissing);
      const language = fullBackupTarget === 'wechat' ? '중국어 문자 인식' : '한국어 문자 인식';
      return `먼저 ${action.label}로 ${language}을 준비한 뒤 상태 새로고침을 누르세요. 준비되면 앱 창과 왼쪽 목록 준비를 체크하고 전체 목록 확인으로 후보 방을 먼저 봅니다.`;
    }
    if (fullBackupTargetMissing.some((check) => String(check.id || '').startsWith('app_'))) {
      return `먼저 ${targetLabel} 열기 또는 공식 설치 페이지로 앱을 열고 로그인하세요. 완료 후 상태 새로고침을 누르면 앱 창과 왼쪽 목록 준비를 체크하고 전체 목록 확인을 시작할 수 있습니다.`;
    }
    return '준비 확인에서 막힌 항목을 먼저 해결하세요. 준비되면 앱 창과 왼쪽 목록 준비를 체크하고 전체 목록 확인으로 후보 방을 먼저 봅니다.';
  })();
  const batchGuideActionLabel = (platform, missing) => {
    if (!fullBackupTarget) return `${platform} 통째 백업 확인`;
    if (doctorPending) return `${platform} 전체 목록 확인 시작`;
    if (missing.some(isOcrCheck)) return ocrFixAction(missing).label;
    if (missing.some((check) => String(check.id || '').startsWith('app_'))) return `${platform} 열기`;
    if (missing.length) return '준비 확인';
    return `${platform} 전체 목록 확인 시작`;
  };
  const targetNotice = fullBackupTarget
    ? `<div class="notice focus-notice"><strong>${esc(targetLabel)} 통째 백업 위치입니다.</strong> ${esc(fullBackupTargetActionText)}</div>`
    : targetLabel
    ? `<div class="notice focus-notice"><strong>${esc(targetLabel)} 백업 위치입니다.</strong> 앱에서 방을 선택하고 앱 창을 앞에 둔 뒤 이 브라우저로 돌아와 방 선택 완료, 앱 창 앞에 둠 표시를 하고 백업을 누르세요.</div>`
    : '';
  const returnNotice = backupReturnNotice
    ? `<div class="notice return-notice"><strong>다음 단계</strong> ${esc(backupReturnNotice)}</div>`
    : '';
  backupReturnNotice = '';
  const notice = noticeItems.length
    ? `<div class="notice">${esc(noticeItems.join(' · '))}</div>`
    : (!targetLabel && allMissing.length
      ? '<div class="notice focus-notice">준비된 카드는 바로 사용할 수 있습니다. 막힌 카드는 카드 아래 안내를 확인하세요.</div>'
      : '');
  const readinessLine = (label, missing, readyText) => `
    <div class="readiness-line ${doctorPending ? 'status-ready' : (missing.length ? 'status-review' : 'status-pass')}">
      <span>${esc(label)} 준비</span>
      <small>${doctorPending ? '준비 상태를 확인 중입니다. 기다리지 않아도 지금 열린 방 백업 화면을 열 수 있습니다.' : (missing.length ? esc(missing.map(backupCheckLabel).join(' · ')) : esc(readyText))}</small>
    </div>`;
  const starterText = (appName, missing, readyText) => {
    if (doctorPending) return `${appName} 앱을 열고 방을 선택해도 됩니다. 준비 상태는 곧 갱신됩니다.`;
    if (!missing.length) return readyText;
    if (missing.some(isOcrCheck)) {
      const language = appName === '위챗' ? '중국어(간체, 중국) 또는 중국어(번체, 대만/홍콩) 중 하나' : '한국어';
      const action = ocrFixAction(missing);
      return `먼저 ${action.label}를 누른 뒤 ${language}를 기본 선택 그대로 설치하세요.`;
    }
    if (missing.some((check) => String(check.id || '').startsWith('app_'))) return `먼저 ${appName} 열기 또는 공식 설치 페이지를 누르고 로그인하세요.`;
    return '막힌 항목 확인을 누른 뒤 안내된 조치를 먼저 끝내세요.';
  };
  const starterCta = (appName, missing) => {
    if (doctorPending) return '지금 열린 방 백업으로 이동';
    if (!missing.length) return '선택 완료로 이동';
    if (missing.some(isOcrCheck)) return ocrFixAction(missing).label;
    if (missing.some((check) => String(check.id || '').startsWith('app_'))) return `${appName} 열기`;
    return '막힌 항목 확인';
  };
  const firstBackupGuideTarget = backupTarget === 'kakao'
    ? {
      key: 'kakao',
      label: '카카오톡',
      openLabel: '카카오톡 열기',
      openAction: 'open_kakaotalk',
      roomText: '카카오톡에서 백업할 채팅방을 엽니다.',
      confirmText: '카카오톡에서 백업할 방을 열었다고 표시합니다.',
      focusSelector: '#kakaoOpenReady',
      sectionSelector: '#kakao',
    }
    : {
      key: 'wechat',
      label: '위챗',
      openLabel: '위챗 열기',
      openAction: 'open_wechat',
      roomText: '위챗에서 백업할 방을 선택합니다.',
      confirmText: '위챗에서 백업할 방을 선택했다고 표시합니다.',
      focusSelector: '#wechatCurrentReady',
      sectionSelector: '#wechat',
    };
  const firstBackupGuideMissing = firstBackupGuideTarget.key === 'kakao' ? kakaoMissing : wechatMissing;
  const firstBackupGuidePrimary = !doctorPending && firstBackupGuideMissing.some(isOcrCheck)
    ? 'ocr'
    : ((doctorPending || firstBackupGuideMissing.some((check) => String(check.id || '').startsWith('app_')))
      ? 'open'
      : 'target');
  const firstBackupGuideActions = [
    { key: 'open', attrs: `data-guide-open-app="${esc(firstBackupGuideTarget.openAction)}"`, label: firstBackupGuideTarget.openLabel },
    { key: 'target', attrs: `data-guide-target-app="${esc(firstBackupGuideTarget.key)}"`, label: '선택 완료 위치로 이동' },
    { key: 'ocr', attrs: 'data-guide-ocr-settings', label: '문자 인식 설정' },
  ];
  const firstBackupGuideActionHtml = [
    firstBackupGuideActions.find((action) => action.key === firstBackupGuidePrimary),
    ...firstBackupGuideActions.filter((action) => action.key !== firstBackupGuidePrimary),
  ].filter(Boolean).map((action) => (
    `<button ${action.attrs}${action.key === firstBackupGuidePrimary ? ' class="primary"' : ''} type="button">${esc(action.label)}</button>`
  )).join('');
  const firstBackupGuideHtml = `
    <section class="panel span-12 first-backup-guide" aria-label="첫 백업 가이드">
      <div class="first-backup-copy">
        <span class="guide-kicker">3분 첫 백업</span>
        <h2>${esc(firstBackupGuideTarget.label)}용 첫 백업 순서</h2>
        <p>처음이면 이 순서만 따라가세요. 기술 설정은 막혔을 때만 열면 됩니다.</p>
      </div>
      <ol class="first-backup-steps">
        <li><span>1</span><strong>앱 열기</strong><small>${esc(firstBackupGuideTarget.openLabel)}를 누르고 로그인합니다.</small></li>
        <li><span>2</span><strong>방 선택</strong><small>${esc(firstBackupGuideTarget.roomText)}</small></li>
        <li><span>3</span><strong>선택 완료 표시</strong><small>${esc(firstBackupGuideTarget.confirmText)}</small></li>
        <li><span>4</span><strong>백업 버튼</strong><small>백업을 누르고 끝나면 결과 보기를 엽니다.</small></li>
      </ol>
      <div class="first-backup-tip"><strong>백업 중에는 앱 창을 최소화하거나 다른 창으로 가리지 않습니다.</strong><span>화면 글자를 읽어 저장하므로 백업이 끝날 때까지 채팅방이 앞에 보여야 합니다.</span></div>
      <div class="first-backup-actions">
        ${firstBackupGuideActionHtml}
      </div>
    </section>`;
  const fullBackupGuideHtml = `
    <section class="panel span-12 full-backup-guide ${fullBackupTarget ? 'target-focus' : ''}" aria-label="여러 방 통째 백업">
      <div class="full-backup-copy">
        <span class="guide-kicker">여러 방 저장</span>
        <h2>통째 백업은 전체 목록 확인부터 시작합니다</h2>
        <p>왼쪽 채팅 목록을 끝까지 읽고, 새 방이 더 이상 나오지 않으면 자동으로 멈춥니다.</p>
      </div>
      <div class="batch-preflight-note">
        <strong>시작 전 확인</strong>
        <span>앱 창을 앞에 두고 왼쪽 채팅 목록이 보이게 둔 뒤 전체 목록 확인을 누르세요. 백업 중에는 앱 창을 가리거나 최소화하지 않습니다.</span>
      </div>
      <ol class="full-backup-steps">
        <li><span>1</span><strong>전체 목록 확인</strong><small>클릭 없이 후보 방 이름을 먼저 봅니다.</small></li>
        <li><span>2</span><strong>후보 확인</strong><small>번호가 붙은 후보가 맞는지 확인합니다.</small></li>
        <li><span>3</span><strong>목록 백업 실행</strong><small>맞으면 완료 카드의 실행 버튼을 누릅니다.</small></li>
        <li><span>4</span><strong>끝 판정</strong><small>상한이나 확인 필요 방은 같은 카드에 표시됩니다.</small></li>
      </ol>
      <div class="full-backup-actions">
        <button data-batch-starter-wechat class="${fullBackupTarget !== 'kakao' ? 'primary' : ''}" type="button">${esc(batchGuideActionLabel('위챗', wechatBatchMissing))}</button>
        <button data-batch-starter-kakao class="${fullBackupTarget === 'kakao' ? 'primary' : ''}" type="button">${esc(batchGuideActionLabel('카카오톡', kakaoBatchMissing))}</button>
      </div>
    </section>`;
  const kakaoReadyText = '카카오톡 실행과 한국어 문자 인식이 확인됐습니다';
  const wechatReadyText = '위챗 실행과 중국어 문자 인식이 확인됐습니다';
  setChrome('위챗/카카오톡 백업', '위챗을 1번으로, 카카오톡과 결과 확인을 같은 화면에서 진행합니다');
  view.innerHTML = `
    <div class="grid">
      ${firstBackupGuideHtml}

      <section class="panel span-12 backup-head">
        <div class="toolbar">
          <strong>1번 위챗 / 2번 카카오톡 백업</strong>
          ${doctorBadge}
          <button id="backupDoctor" type="button">준비 확인</button>
          <button id="backupJobs" type="button">진행 기록</button>
          <button id="backupChats" class="primary" type="button">결과 보기</button>
        </div>
        ${targetNotice}
        ${returnNotice}
        ${notice}
        ${fallbackNotice}
        <div class="backup-switcher" aria-label="백업 종류 바로가기">
          <button data-jump-backup="wechat" class="${backupTarget === 'wechat' ? 'primary' : ''}" type="button">1번 위챗 바로 시작</button>
          <button data-jump-backup="kakao" class="${backupTarget === 'kakao' ? 'primary' : ''}" type="button">카카오톡 바로 시작</button>
          <button data-jump-backup="chats" type="button">결과 보기</button>
        </div>
        <div class="step-strip" aria-label="백업 진행 순서">
          <strong>진행 순서</strong>
          <ol>
            <li><span>1</span>앱 실행</li>
            <li><span>2</span>대상 방 선택</li>
            <li><span>3</span>백업 시작</li>
            <li><span>4</span>결과 보기</li>
          </ol>
        </div>
      </section>

      <section class="panel span-12 backup-privacy-panel">
        ${localPrivacyStripHtml()}
      </section>

      <section class="panel span-12 beginner-backup">
        <div class="section-heading compact">
          <div>
            <h2>처음이면 지금 열린 방 백업부터 시작하세요</h2>
            <p>앱에서 원하는 방을 열어 둔 뒤, 아래 추천 버튼으로 선택 완료 표시까지 이동합니다.</p>
          </div>
          <span class="badge">추천 경로</span>
        </div>
        <div class="starter-grid">
          <button data-starter-wechat class="primary-starter wechat-starter" type="button">
            <span class="badge ${statusClass(wechatMissing.length ? 'review' : 'pass')}">${wechatMissing.length ? '준비 확인' : '추천'}</span>
            <strong>지금 열린 위챗 방 백업</strong>
            <span>${esc(starterText('위챗', wechatMissing, '위챗에서 방을 선택한 뒤 브라우저로 돌아와 확인하고 백업합니다.'))}</span>
            <span class="starter-cta">${esc(starterCta('위챗', wechatMissing))}</span>
          </button>
          <button data-starter-kakao class="kakao-starter" type="button">
            <span class="badge ${statusClass(kakaoMissing.length ? 'review' : 'pass')}">${kakaoMissing.length ? '준비 확인' : '추천'}</span>
            <strong>카카오톡 열린 방 백업</strong>
            <span>${esc(starterText('카카오톡', kakaoMissing, '카카오톡에서 방을 연 뒤 브라우저로 돌아와 확인하고 백업합니다.'))}</span>
            <span class="starter-cta">${esc(starterCta('카카오톡', kakaoMissing))}</span>
          </button>
          <button data-quick-chats type="button"><strong>결과 확인</strong><span>백업 결과를 한 번에 보기</span><span class="starter-cta">결과 보기</span></button>
          <button data-quick-ready type="button"><strong>막힌 항목 확인</strong><span>설치와 문자 인식 상태만 점검</span><span class="starter-cta">준비 확인 열기</span></button>
        </div>
      </section>

      ${fullBackupGuideHtml}

      ${captureNotice}

      <section id="wechat" class="panel span-6 workflow-panel wechat-workflow ${backupTarget === 'wechat' ? 'target-focus' : ''}">
        <div class="section-heading">
          <div>
            <h2>위챗 백업</h2>
            <p>지금 열린 방과 왼쪽 목록 전체 순회(통째 백업)를 화면 문자 인식으로 백업합니다</p>
          </div>
          <span class="badge">앱 화면 읽기</span>
        </div>
        ${readinessLine('위챗', wechatMissing, wechatReadyText)}
        <div class="app-quick-actions">
          ${ocrFixButton(wechatMissing)}
          <button id="openWechatApp" type="button">위챗 열기</button>
          <button id="installWechatApp" type="button">공식 설치 페이지</button>
          <button type="button" data-refresh-ready>상태 새로고침</button>
        </div>

        <div class="backup-row">
          <div>
            <strong>지금 열린 위챗 방</strong>
            <p>위챗에서 열어 둔 대화방을 내 컴퓨터에 백업</p>
          </div>
          <button id="wechatCurrent" class="primary" type="button" ${wechatCurrentDisabled} ${disabledTitle(wechatMissing)}>백업</button>
        </div>
        ${currentRoomStepsHtml('위챗', '위챗 열기', '백업할 방 선택')}
        ${currentRoomConfirmHtml('wechatCurrentReady', 'wechatCurrentReadyError', '위챗에서 백업할 방을 선택했고 위챗 창을 앞에 두었습니다')}
        ${blockedNote(wechatMissing)}
        <details class="advanced-options">
          <summary>고급 옵션</summary>
          <div class="field-grid">
            <label>방 이름<input id="wechatRoomLabel" type="text" maxlength="120" placeholder="비워 두면 화면에서 추정"></label>
            <label>상대 이름<input id="wechatIncomingSpeaker" type="text" maxlength="120" placeholder="비워 두면 자동"></label>
            <label>캡처 수<input id="wechatCurrentFrames" type="number" min="1" max="800" value="120"></label>
          </div>
        </details>

        <div class="backup-row with-fields">
          <div>
            <strong>통째 백업(왼쪽 목록 전체 순회)</strong>
            <p>위챗 왼쪽 목록을 끝까지 스크롤하며 새 방이 안 나올 때까지 백업합니다</p>
          </div>
          <div class="row-actions">
            <button id="wechatBatchPreview" class="primary" type="button" ${wechatBatchDisabled} ${disabledTitle(wechatBatchMissing)}>전체 목록 확인</button>
            <button id="wechatBatch" type="button" ${wechatBatchDisabled} ${disabledTitle(wechatBatchMissing)}>목록 백업 실행</button>
          </div>
        </div>
        <p class="helper-note">이 기능이 위챗 통째 백업입니다. 시작 전에는 위챗 앱 창을 앞에 두고 왼쪽 채팅 목록이 보이게 둡니다. 처음에는 전체 목록 확인으로 후보 이름을 보고, 괜찮으면 목록 백업 실행을 누릅니다. 방 하나가 일시적으로 실패하면 기본 1회 다시 시도합니다. 현재 화면에 보이는 몇 개만 백업하려면 고급 옵션에서 끝까지 자동 스크롤을 끄세요.</p>
        ${batchListConfirmHtml('wechatBatchReady', 'wechatBatchReadyError', '위챗')}
        ${blockedNote(wechatBatchMissing)}
        <details class="advanced-options">
          <summary>고급 옵션</summary>
          <div class="field-grid">
            <label>페이지 상한<input id="wechatPages" type="number" min="1" max="200" value="80"></label>
            <label>방 개수 상한<input id="wechatRoomLimit" type="number" min="1" max="500" value="200"></label>
            <label>캡처 수<input id="wechatBatchFrames" type="number" min="1" max="800" value="120"></label>
            <label>방 재시도 횟수<input id="wechatRoomRetries" type="number" min="0" max="5" value="1"></label>
            <label class="check-label"><input id="wechatDirectAuto" type="checkbox" checked> 1:1방 이름 자동 적용</label>
            <label class="check-label"><input id="wechatAllVisible" type="checkbox" checked> 끝까지 자동 스크롤</label>
          </div>
        </details>

        <details class="advanced-options">
          <summary>고급: 예전 위챗 백업 파일 검사</summary>
          <div class="backup-row">
            <div>
              <strong>예전 위챗 백업 파일 검사</strong>
              <p>예전에 만들어 둔 저장형 결과를 확인할 때만 사용</p>
            </div>
            <button id="wechatValidate" type="button" ${wechatValidateDisabled} ${disabledTitle(wechatValidateMissing)}>검사</button>
          </div>
          ${blockedNote(wechatValidateMissing)}
        </details>
      </section>

      <section id="kakao" class="panel span-6 workflow-panel kakao-workflow ${backupTarget === 'kakao' ? 'target-focus' : ''}">
        <div class="section-heading">
          <div>
            <h2>카카오톡 백업</h2>
            <p>열린 방, 왼쪽 목록, 오픈채팅을 화면 문자 인식으로 백업합니다</p>
          </div>
          <span class="badge">앱 화면 읽기</span>
        </div>
        ${readinessLine('카카오톡', kakaoMissing, kakaoReadyText)}
        <div class="app-quick-actions">
          ${ocrFixButton(kakaoMissing)}
          <button id="openKakaoApp" type="button">카카오톡 열기</button>
          <button id="installKakaoApp" type="button">공식 설치 페이지</button>
          <button type="button" data-refresh-ready>상태 새로고침</button>
        </div>

        <div class="backup-row">
          <div>
            <strong>열린 채팅방</strong>
            <p>현재 떠 있는 채팅창을 그대로 백업</p>
          </div>
          <button id="kakaoOpen" class="primary" type="button" ${kakaoOpenDisabled} ${disabledTitle(kakaoMissing)}>백업</button>
        </div>
        ${currentRoomStepsHtml('카카오톡', '카카오톡 열기', '백업할 방 열기')}
        ${currentRoomConfirmHtml('kakaoOpenReady', 'kakaoOpenReadyError', '카카오톡에서 백업할 방을 열었고 카카오톡 창을 앞에 두었습니다')}
        ${blockedNote(kakaoMissing)}
        <details class="advanced-options">
          <summary>고급 옵션</summary>
          <div class="field-grid compact">
            <label>캡처 수<input id="kakaoOpenFrames" type="number" min="1" max="500" value="40"></label>
            <label class="check-label"><input id="kakaoOpenBottom" type="checkbox" checked> 아래까지 스크롤</label>
          </div>
        </details>

        <div class="backup-row with-fields">
          <div>
            <strong>통째 백업(왼쪽 목록 전체 순회)</strong>
            <p>카카오톡 왼쪽 목록을 끝까지 스크롤하며 새 방이 안 나올 때까지 백업합니다</p>
          </div>
          <div class="row-actions">
            <button id="kakaoBatchPreview" class="primary" type="button" ${kakaoBatchDisabled} ${disabledTitle(kakaoBatchMissing)}>전체 목록 확인</button>
            <button id="kakaoBatch" type="button" ${kakaoBatchDisabled} ${disabledTitle(kakaoBatchMissing)}>목록 백업 실행</button>
          </div>
        </div>
        <p class="helper-note">이 기능이 카카오톡 통째 백업입니다. 시작 전에는 카카오톡 앱 창을 앞에 두고 왼쪽 채팅 목록이 보이게 둡니다. 처음에는 전체 목록 확인으로 후보 이름을 보고, 괜찮으면 목록 백업 실행을 누릅니다. 목록 백업은 방마다 기본 120장까지 과거 대화를 읽고, 방 하나가 일시적으로 실패하면 기본 1회 다시 시도합니다. 특정 방 하나만 열려면 아래 목록에서 찾기를 사용하세요.</p>
        ${batchListConfirmHtml('kakaoBatchReady', 'kakaoBatchReadyError', '카카오톡')}
        ${blockedNote(kakaoBatchMissing)}
        <details class="advanced-options">
          <summary>고급 옵션</summary>
          <div class="field-grid">
            <label>페이지 상한<input id="kakaoPages" type="number" min="1" max="200" value="80"></label>
            <label>방 개수 상한<input id="kakaoRoomLimit" type="number" min="1" max="500" value="200"></label>
            <label>캡처 수<input id="kakaoBatchFrames" type="number" min="1" max="500" value="120"></label>
            <label>방 재시도 횟수<input id="kakaoRoomRetries" type="number" min="0" max="5" value="1"></label>
            <label class="check-label"><input id="kakaoBatchBottom" type="checkbox" checked> 아래까지 스크롤</label>
            <label class="check-label"><input id="kakaoAllVisible" type="checkbox" checked> 끝까지 자동 스크롤</label>
          </div>
        </details>

        <div class="backup-row with-fields">
          <div>
            <strong>목록에서 찾기</strong>
            <p>왼쪽 목록에 보이는 방 이름으로 열기</p>
          </div>
          <button id="kakaoVisible" type="button" ${kakaoVisibleDisabled} ${disabledTitle(kakaoVisibleMissing)}>찾아서 백업</button>
        </div>
        <div class="field-grid single">
          <label>방 이름<input id="kakaoPattern" type="text" maxlength="80" placeholder="예: 브릴CS"></label>
          <div id="kakaoPatternError" class="field-error" role="alert" hidden></div>
        </div>
        ${blockedNote(kakaoVisibleMissing)}
        <details class="advanced-options">
          <summary>고급 옵션</summary>
          <div class="field-grid compact">
            <label>캡처 수<input id="kakaoVisibleFrames" type="number" min="1" max="500" value="40"></label>
          </div>
        </details>

        <div class="backup-row with-fields">
          <div>
            <strong>오픈채팅</strong>
            <p>댓글/답글 창까지 함께 백업</p>
          </div>
          <button id="kakaoOpenchat" type="button" ${kakaoOpenchatDisabled} ${disabledTitle(kakaoOpenchatMissing)}>오픈채팅 백업</button>
        </div>
        <div class="field-grid single">
          <label>오픈채팅 제목<input id="kakaoOpenchatTitle" type="text" maxlength="120" placeholder="예: 엘디유오_브릴CS"></label>
          <div id="kakaoOpenchatTitleError" class="field-error" role="alert" hidden></div>
        </div>
        ${blockedNote(kakaoOpenchatMissing)}
        <details class="advanced-options">
          <summary>고급 옵션</summary>
          <div class="field-grid">
            <label>본문 캡처 수<input id="kakaoOpenchatFrames" type="number" min="1" max="500" value="80"></label>
            <label>댓글 캡처 수<input id="kakaoThreadFrames" type="number" min="1" max="200" value="20"></label>
            <label class="check-label"><input id="kakaoOpenchatBottom" type="checkbox" checked> 아래까지 스크롤</label>
          </div>
        </details>
      </section>

      <section class="panel span-12 backup-progress-panel">
        <div class="toolbar">
          <strong id="backupJobTitle">진행 상황</strong>
          <button id="backupOpenJobs" type="button">진행 기록</button>
          <button id="backupOpenChats" class="primary" type="button">결과 보기</button>
        </div>
        <div id="backupLog" class="log backup-log-empty">백업을 시작하면 진행 내용이 여기에 표시됩니다.
처음이면 위의 지금 열린 방 백업 카드에서 방 선택 완료, 앱 창 앞에 둠 체크박스를 먼저 선택하세요.</div>
        <div id="backupNextActions" class="next-actions"></div>
      </section>
    </div>`;

  view.querySelector('#backupDoctor').addEventListener('click', () => navigate('/doctor'));
  view.querySelector('#backupJobs').addEventListener('click', () => navigate('/jobs'));
  view.querySelector('#backupChats').addEventListener('click', () => navigate('/chats'));
  view.querySelector('#backupOpenJobs').addEventListener('click', () => navigate('/jobs'));
  view.querySelector('#backupOpenChats').addEventListener('click', () => navigate('/chats'));
  view.querySelectorAll('[data-open-language-settings]').forEach((button) => button.addEventListener('click', () => startBackupJob('setup', 'open_language_settings', {}, '문자 인식 설정 열기')));
  view.querySelectorAll('[data-ocr-setup-action]').forEach((button) => button.addEventListener('click', () => {
    startBackupJob('setup', button.dataset.ocrSetupAction || 'open_language_settings', {}, button.dataset.ocrSetupLabel || '문자 인식 설정');
  }));
  view.querySelectorAll('[data-jump-backup]').forEach((button) => button.addEventListener('click', () => {
    const target = button.dataset.jumpBackup;
    if (target === 'chats') navigate('/chats');
    else navigate(`/backup#${target}`);
  }));
  const jumpToBackupTarget = (sectionSelector, focusSelector, message) => {
    view.querySelector(sectionSelector)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const log = view.querySelector('#backupLog');
    if (log) log.textContent = `${message}\n`;
    setTimeout(() => {
      const input = view.querySelector(focusSelector);
      const line = input?.closest('.confirm-line');
      input?.focus();
      line?.classList.add('attention');
      if (line) setTimeout(() => line.classList.remove('attention'), 2200);
    }, 250);
  };
  view.querySelectorAll('[data-guide-open-app]').forEach((button) => button.addEventListener('click', () => {
    const action = button.dataset.guideOpenApp;
    const label = action === 'open_kakaotalk' ? '카카오톡 열기' : '위챗 열기';
    startBackupJob('setup', action, {}, label);
  }));
  view.querySelectorAll('[data-guide-target-app]').forEach((button) => button.addEventListener('click', () => {
    if (button.dataset.guideTargetApp === 'kakao') {
      jumpToBackupTarget('#kakao', '#kakaoOpenReady', '카카오톡에서 백업할 방을 열고 카카오톡 창을 앞에 둔 뒤 방 선택 완료, 앱 창 앞에 둠 표시를 하고 백업을 누르세요.');
      return;
    }
    jumpToBackupTarget('#wechat', '#wechatCurrentReady', '위챗에서 백업할 방을 선택하고 위챗 창을 앞에 둔 뒤 방 선택 완료, 앱 창 앞에 둠 표시를 하고 백업을 누르세요.');
  }));
  view.querySelectorAll('[data-guide-ocr-settings]').forEach((button) => button.addEventListener('click', () => {
    startBackupJob('setup', 'open_language_settings', {}, '문자 인식 설정 열기');
  }));
  const starterAction = ({ missing, sectionSelector, focusSelector, readyMessage, openAction, openLabel }) => {
    if (!doctorPending && missing.some(isOcrCheck)) {
      const action = ocrFixAction(missing);
      startBackupJob('setup', action.action, {}, action.label);
      return;
    }
    if (!doctorPending && missing.some((check) => String(check.id || '').startsWith('app_'))) {
      startBackupJob('setup', openAction, {}, openLabel);
      return;
    }
    if (!doctorPending && missing.length) {
      navigate('/doctor');
      return;
    }
    jumpToBackupTarget(sectionSelector, focusSelector, readyMessage);
  };
  const batchStarterAction = ({ missing, sectionSelector, readySelector, platformLabel, openAction, openLabel }) => {
    if (!doctorPending && missing.some(isOcrCheck)) {
      const action = ocrFixAction(missing);
      startBackupJob('setup', action.action, {}, action.label);
      return;
    }
    if (!doctorPending && missing.some((check) => String(check.id || '').startsWith('app_'))) {
      startBackupJob('setup', openAction, {}, openLabel);
      return;
    }
    if (!doctorPending && missing.length) {
      navigate('/doctor');
      return;
    }
    view.querySelector(sectionSelector)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const log = view.querySelector('#backupLog');
    if (!stopBtn.disabled) {
      if (log) log.textContent = '이미 실행 중인 작업이 있습니다. 끝난 뒤 전체 목록 확인 준비 표시를 다시 확인해 주세요.\n';
      return;
    }
    if (log) {
      log.textContent = `${platformLabel} 앱 창을 앞에 두고 왼쪽 채팅 목록이 보이게 한 뒤 전체 목록 확인 준비 완료를 체크하고 전체 목록 확인을 누르세요.\n`;
    }
    setTimeout(() => {
      const input = view.querySelector(readySelector);
      const line = input?.closest('.confirm-line');
      input?.focus();
      line?.classList.add('attention');
      if (line) setTimeout(() => line.classList.remove('attention'), 2200);
    }, 250);
  };
  view.querySelector('[data-starter-kakao]')?.addEventListener('click', () => starterAction({
    missing: kakaoMissing,
    sectionSelector: '#kakao',
    focusSelector: '#kakaoOpenReady',
    readyMessage: '카카오톡에서 백업할 방을 열고 카카오톡 창을 앞에 둔 뒤 이 브라우저로 돌아와 방 선택 완료, 앱 창 앞에 둠 표시를 하고 백업을 누르세요.',
    openAction: 'open_kakaotalk',
    openLabel: '카카오톡 열기',
  }));
  view.querySelector('[data-starter-wechat]')?.addEventListener('click', () => starterAction({
    missing: wechatMissing,
    sectionSelector: '#wechat',
    focusSelector: '#wechatCurrentReady',
    readyMessage: '위챗에서 백업할 방을 선택하고 위챗 창을 앞에 둔 뒤 이 브라우저로 돌아와 방 선택 완료, 앱 창 앞에 둠 표시를 하고 백업을 누르세요.',
    openAction: 'open_wechat',
    openLabel: '위챗 열기',
  }));
  view.querySelector('[data-batch-starter-wechat]')?.addEventListener('click', () => batchStarterAction({
    missing: wechatBatchMissing,
    sectionSelector: '#wechat',
    readySelector: '#wechatBatchReady',
    platformLabel: '위챗',
    openAction: 'open_wechat',
    openLabel: '위챗 열기',
  }));
  view.querySelector('[data-batch-starter-kakao]')?.addEventListener('click', () => batchStarterAction({
    missing: kakaoBatchMissing,
    sectionSelector: '#kakao',
    readySelector: '#kakaoBatchReady',
    platformLabel: '카카오톡',
    openAction: 'open_kakaotalk',
    openLabel: '카카오톡 열기',
  }));
  view.querySelector('[data-quick-chats]')?.addEventListener('click', () => navigate('/chats'));
  view.querySelector('[data-quick-ready]')?.addEventListener('click', () => navigate('/doctor'));
  view.querySelector('#installWslTools')?.addEventListener('click', () => startBackupJob('setup', 'wsl_tools', {}, '고급 기능 도구 준비'));
  view.querySelector('#openLanguageSettings')?.addEventListener('click', () => startBackupJob('setup', 'open_language_settings', {}, 'Windows 언어 설정 열기'));
  view.querySelector('#openKakaoApp').addEventListener('click', () => startBackupJob('setup', 'open_kakaotalk', {}, '카카오톡 열기'));
  view.querySelector('#installKakaoApp').addEventListener('click', () => startBackupJob('setup', 'open_kakaotalk_download', {}, '카카오톡 공식 설치 페이지 열기'));
  view.querySelector('#openWechatApp').addEventListener('click', () => startBackupJob('setup', 'open_wechat', {}, '위챗 열기'));
  view.querySelector('#installWechatApp').addEventListener('click', () => startBackupJob('setup', 'open_wechat_download', {}, '위챗 공식 설치 페이지 열기'));
  clearFieldErrorOnInput('#kakaoPattern', '#kakaoPatternError');
  clearFieldErrorOnInput('#kakaoOpenchatTitle', '#kakaoOpenchatTitleError');
  clearCheckErrorOnChange('#kakaoOpenReady', '#kakaoOpenReadyError');
  clearCheckErrorOnChange('#wechatCurrentReady', '#wechatCurrentReadyError');
  clearCheckErrorOnChange('#kakaoBatchReady', '#kakaoBatchReadyError');
  clearCheckErrorOnChange('#wechatBatchReady', '#wechatBatchReadyError');
  view.querySelectorAll('[data-refresh-ready]').forEach((button) => button.addEventListener('click', render));
  view.querySelectorAll('[data-copy-setup]').forEach((button) => button.addEventListener('click', async () => {
    const log = view.querySelector('#backupLog');
    const text = button.dataset.copySetup === 'ubuntu' ? setupUbuntuCommand : setupPowershellCommand;
    try {
      await navigator.clipboard.writeText(text);
      if (log) log.textContent = '설치 명령을 클립보드에 복사했습니다.\n';
    } catch {
      if (log) log.textContent = `${text}\n`;
    }
  }));

  view.querySelector('#kakaoOpen').addEventListener('click', () => {
    if (!requireChecked('#kakaoOpenReady', '카카오톡에서 백업할 채팅방을 열고 카카오톡 창을 앞에 둔 뒤 방 선택 완료 표시를 해 주세요. 백업이 시작되면 앱 창을 가리지 않습니다.', '#kakaoOpenReadyError', {
      openJob: { module: 'setup', action: 'open_kakaotalk', params: {}, label: '카카오톡 열기', buttonLabel: '카카오톡 열기' },
    })) return;
    startBackupJob('kakao', 'open_windows', {
      maxFrames: numberValue('#kakaoOpenFrames', 40),
      toBottom: checked('#kakaoOpenBottom'),
    }, '카카오톡 열린 채팅방 백업');
  });
  const requireBatchReady = (selector, errorSelector, platformLabel) => requireChecked(
    selector,
    `${platformLabel} 앱 창을 앞에 두고 왼쪽 채팅 목록이 보이게 한 뒤 전체 목록 확인 준비 완료 표시를 해 주세요.`,
    errorSelector,
    {
      buttonLabel: '준비 완료 표시로 이동',
      title: '전체 목록 확인 준비가 필요합니다',
      text: `${platformLabel} 앱 창을 앞에 두고 왼쪽 채팅 목록이 보이게 한 뒤 전체 목록 확인 준비 완료 체크박스를 선택하고 전체 목록 확인을 누르세요.`,
    },
  );
  const kakaoBatchParams = (dryRun = false) => ({
    pages: numberValue('#kakaoPages', checked('#kakaoAllVisible') ? 80 : 1),
    roomLimit: numberValue('#kakaoRoomLimit', checked('#kakaoAllVisible') ? 200 : 5),
    maxFrames: numberValue('#kakaoBatchFrames', 120),
    roomRetries: numberValue('#kakaoRoomRetries', 1),
    toBottom: checked('#kakaoBatchBottom'),
    allVisible: checked('#kakaoAllVisible'),
    ...(dryRun ? { dryRun: true } : {}),
  });
  const kakaoBatchSignature = () => JSON.stringify(kakaoBatchParams(false));
  view.querySelector('#kakaoBatchPreview').addEventListener('click', () => {
    if (!requireBatchReady('#kakaoBatchReady', '#kakaoBatchReadyError', '카카오톡')) return;
    const params = kakaoBatchParams(true);
    startBackupJob('kakao', 'visible_batch', params, params.allVisible ? '카카오톡 전체 목록 확인' : '카카오톡 목록 확인');
  });
  view.querySelector('#kakaoBatch').addEventListener('click', () => {
    if (!requireBatchReady('#kakaoBatchReady', '#kakaoBatchReadyError', '카카오톡')) return;
    if (kakaoBatchPreviewSignature !== kakaoBatchSignature()) {
      const log = view.querySelector('#backupLog');
      if (log) log.textContent = '먼저 전체 목록 확인을 눌러 번호가 붙은 후보 목록을 확인하세요. 후보가 맞으면 목록 백업 실행을 누릅니다.\n';
      setBackupNextActions('need-preview', {
        module: 'kakao',
        action: 'visible_batch',
        params: kakaoBatchParams(true),
        label: '카카오톡 전체 목록 확인',
        buttonLabel: '전체 목록 확인',
      });
      view.querySelector('#kakaoBatchPreview')?.focus();
      return;
    }
    const params = kakaoBatchParams(false);
    startBackupJob('kakao', 'visible_batch', params, '카카오톡 목록 백업 실행');
  });
  view.querySelector('#kakaoVisible').addEventListener('click', () => {
    if (!requireTextInput('#kakaoPattern', '목록에서 찾을 방 이름을 입력하세요.', '#kakaoPatternError')) return;
    startBackupJob('kakao', 'visible_room', {
      pattern: inputValue('#kakaoPattern'),
      maxFrames: numberValue('#kakaoVisibleFrames', 40),
      toBottom: true,
    }, '카카오톡 목록 방 백업');
  });
  view.querySelector('#kakaoOpenchat').addEventListener('click', () => {
    if (!requireTextInput('#kakaoOpenchatTitle', '오픈채팅 제목을 입력하세요.', '#kakaoOpenchatTitleError')) return;
    startBackupJob('kakao', 'openchat', {
      title: inputValue('#kakaoOpenchatTitle'),
      maxFrames: numberValue('#kakaoOpenchatFrames', 80),
      threadMaxFrames: numberValue('#kakaoThreadFrames', 20),
      toBottom: checked('#kakaoOpenchatBottom'),
    }, '카카오톡 오픈채팅 백업');
  });
  view.querySelector('#wechatCurrent').addEventListener('click', () => {
    if (!requireChecked('#wechatCurrentReady', '위챗에서 백업할 방을 선택하고 위챗 창을 앞에 둔 뒤 방 선택 완료 표시를 해 주세요. 백업이 시작되면 앱 창을 가리지 않습니다.', '#wechatCurrentReadyError', {
      openJob: { module: 'setup', action: 'open_wechat', params: {}, label: '위챗 열기', buttonLabel: '위챗 열기' },
    })) return;
    startBackupJob('wechat', 'current_room', {
      roomLabel: inputValue('#wechatRoomLabel'),
      incomingSpeaker: inputValue('#wechatIncomingSpeaker'),
      maxFrames: numberValue('#wechatCurrentFrames', 120),
    }, '지금 열린 위챗 방 백업');
  });
  const wechatBatchParams = (dryRun = false) => ({
    pages: numberValue('#wechatPages', checked('#wechatAllVisible') ? 80 : 1),
    roomLimit: numberValue('#wechatRoomLimit', checked('#wechatAllVisible') ? 200 : 5),
    maxFrames: numberValue('#wechatBatchFrames', 120),
    roomRetries: numberValue('#wechatRoomRetries', 1),
    directChatAuto: checked('#wechatDirectAuto'),
    allVisible: checked('#wechatAllVisible'),
    ...(dryRun ? { dryRun: true } : {}),
  });
  const wechatBatchSignature = () => JSON.stringify(wechatBatchParams(false));
  view.querySelector('#wechatBatchPreview').addEventListener('click', () => {
    if (!requireBatchReady('#wechatBatchReady', '#wechatBatchReadyError', '위챗')) return;
    const params = wechatBatchParams(true);
    startBackupJob('wechat', 'visible_batch', params, params.allVisible ? '위챗 전체 목록 확인' : '위챗 목록 확인');
  });
  view.querySelector('#wechatBatch').addEventListener('click', () => {
    if (!requireBatchReady('#wechatBatchReady', '#wechatBatchReadyError', '위챗')) return;
    if (wechatBatchPreviewSignature !== wechatBatchSignature()) {
      const log = view.querySelector('#backupLog');
      if (log) log.textContent = '먼저 전체 목록 확인을 눌러 번호가 붙은 후보 목록을 확인하세요. 후보가 맞으면 목록 백업 실행을 누릅니다.\n';
      setBackupNextActions('need-preview', {
        module: 'wechat',
        action: 'visible_batch',
        params: wechatBatchParams(true),
        label: '위챗 전체 목록 확인',
        buttonLabel: '전체 목록 확인',
      });
      view.querySelector('#wechatBatchPreview')?.focus();
      return;
    }
    const params = wechatBatchParams(false);
    startBackupJob('wechat', 'visible_batch', params, '위챗 목록 백업 실행');
  });
  view.querySelector('#wechatValidate').addEventListener('click', () => startBackupJob('wechat', 'validate_db', {}, '예전 위챗 백업 파일 검사'));
  if (fullBackupTarget) {
    requestAnimationFrame(() => {
      const guide = view.querySelector('.full-backup-guide');
      guide?.scrollIntoView({ behavior: 'auto', block: 'start' });
      const readySelector = fullBackupTarget === 'kakao' ? '#kakaoBatchReady' : '#wechatBatchReady';
      const input = view.querySelector(readySelector);
      const log = view.querySelector('#backupLog');
      if (log) {
        log.textContent = `${fullBackupTarget === 'kakao' ? '카카오톡' : '위챗'} 통째 백업은 ${fullBackupTargetActionText}\n`;
      }
      setTimeout(() => {
        const line = input?.closest('.confirm-line');
        input?.focus();
        line?.classList.add('attention');
        if (line) setTimeout(() => line.classList.remove('attention'), 2200);
      }, 250);
    });
  } else if (!['wechat', 'kakao'].includes(backupTarget)) {
    scrollToHashTarget();
  }
}

async function doctorView() {
  setChrome('준비 확인', '백업에 필요한 앱과 도구 상태를 확인합니다');
  const report = await api('/api/doctor');
  const needs = (report.checks || []).filter((check) => check.status !== 'pass' && check.id !== 'gui_apps');
  const important = needs.filter((check) => !check.optional);
  const optional = needs.filter((check) => check.optional);
  const doctorReadyLabel = important.length ? `먼저 할 일 ${important.length}개` : '기본 백업 준비됨';
  const doctorReadyText = important.length
    ? '아래 바로 필요한 조치만 처리하면 됩니다. 준비된 앱은 먼저 백업할 수 있습니다.'
    : '카카오톡/위챗 지금 열린 방 백업을 시작할 수 있습니다.';
  const optionalLabel = optional.length ? `선택 기능 ${optional.length}개` : '선택 기능 준비됨';
  const optionalText = optional.length
    ? '예전 백업 파일 검사나 추가 검수가 필요할 때만 준비하세요. 첫 백업에는 건너뛰어도 됩니다.'
    : '추가 조치 없이 선택 기능도 사용할 수 있습니다.';
  const beginnerCheckLabel = (check) => {
    const id = String(check.id || '');
    if (id === 'windows_ocr_zh') return '위챗 문자 인식 언어';
    if (id === 'windows_ocr_ko') return '카카오톡 문자 인식 언어';
    if (id === 'windows_ocr' || id === 'ocr_any') return '화면 문자 인식';
    if (id === 'wechat_db') return '예전 위챗 백업 파일';
    if (id === 'gui_apps') return '채팅 앱 실행 상태';
    if (id === 'app_kakaotalk') return '카카오톡 실행 상태';
    if (id === 'app_wechat') return '위챗 실행 상태';
    if (id === 'shots_writable') return '백업 저장 폴더';
    if (id === 'state_writable') return '설정 저장 폴더';
    if (id === 'runs_writable') return '진행 기록 폴더';
    if (id === 'wsl') return '고급 기능 실행 환경';
    if (/^wsl_/u.test(id)) return '고급 기능 도구';
    return String(check.label || '준비 항목')
      .replace(/Windows\s+Korean\s+OCR/giu, '카카오톡 문자 인식 언어')
      .replace(/Windows\s+Chinese\s+OCR/giu, '위챗 문자 인식 언어')
      .replace(/Windows\s+OCR/giu, '화면 문자 인식')
      .replace(/WeChat\s+SQLite\s+DB/giu, '예전 위챗 백업 파일');
  };
  const beginnerCheckAction = (check) => {
    const id = String(check.id || '');
    if (id === 'windows_ocr_zh') return '위챗 백업에는 중국어 화면 글자 읽기가 필요합니다. Windows 언어 설정에서 중국어(간체, 중국) 또는 중국어(번체, 대만/홍콩) 중 하나를 기본 선택 그대로 설치한 뒤 다시 확인하세요.';
    if (id === 'windows_ocr_ko') return '카카오톡 백업에는 한국어 화면 글자 읽기가 필요합니다. Windows 언어 설정에서 한국어를 기본 선택 그대로 설치한 뒤 다시 확인하세요.';
    if (id === 'windows_ocr' || id === 'ocr_any') return '채팅 화면 글자를 읽기 위한 Windows 언어를 설치한 뒤 다시 확인하세요.';
    if (id === 'app_kakaotalk') return '카카오톡 백업을 하려면 카카오톡을 열고 로그인하세요. 설치되어 있지 않으면 공식 설치 페이지를 누르세요.';
    if (id === 'app_wechat') return '위챗 백업을 하려면 위챗을 열고 로그인하세요. 설치되어 있지 않으면 공식 설치 페이지를 누르세요.';
    if (id === 'wechat_db') return '예전 백업 파일이 없어도 지금 열린 위챗 방/왼쪽 목록 백업은 결과 보기에서 확인할 수 있습니다. 예전 파일 검사가 필요할 때만 준비하세요.';
    if (id === 'shots_writable') return '백업을 저장할 수 없습니다. 압축을 푼 폴더를 바탕화면이나 문서처럼 내가 저장할 수 있는 일반 폴더로 옮긴 뒤 1_백업_시작.bat를 다시 실행하세요.';
    if (id === 'state_writable') return '설정과 실행 상태를 저장할 수 없습니다. 압축을 푼 폴더를 바탕화면이나 문서처럼 내가 저장할 수 있는 일반 폴더로 옮긴 뒤 1_백업_시작.bat를 다시 실행하세요.';
    if (id === 'runs_writable') return '진행 기록을 저장할 수 없습니다. 압축을 푼 폴더를 바탕화면이나 문서처럼 내가 저장할 수 있는 일반 폴더로 옮긴 뒤 1_백업_시작.bat를 다시 실행하세요.';
    if (id === 'wsl' || /^wsl_/u.test(id)) return '기본 백업에는 없어도 됩니다. 예전 백업 파일 검사나 추가 검수 같은 선택 기능이 필요할 때만 준비하세요.';
    if (id === 'node') return '자동 설치가 막혔다면 설치 페이지를 열고 LTS 버전을 설치한 뒤 1_백업_시작.bat를 다시 실행하세요.';
    return check.action || check.message || '상태를 다시 확인하세요.';
  };
  const setupActionsForCheck = (check) => {
    const id = String(check.id || '');
    const structuredJob = check?.action_job;
    const structuredAction = structuredJob?.module === 'setup' && structuredJob?.action
      ? { action: structuredJob.action, label: structuredJob.label || jobActionLabel(structuredJob), primary: true }
      : null;
    if (isOcrCheck(id)) {
      const installAction = ocrInstallActionForCheck(id);
      const actions = structuredAction
        ? [structuredAction]
        : (installAction.action === 'open_language_settings'
        ? []
        : [{ action: installAction.action, label: installAction.label, primary: true }]);
      if (!actions.some((action) => action.action === 'open_language_settings')) {
        actions.push({ action: 'open_language_settings', label: 'Windows 언어 설정 열기', primary: actions.length === 0 });
      }
      return actions;
    }
    if (structuredAction) return [structuredAction];
    if (id === 'gui_apps') {
      return [
        { action: 'open_wechat', label: '위챗 열기', primary: true },
        { action: 'open_wechat_download', label: '위챗 공식 설치 페이지' },
        { action: 'open_kakaotalk', label: '카카오톡 열기' },
        { action: 'open_kakaotalk_download', label: '카카오톡 공식 설치 페이지' },
      ];
    }
    if (id === 'app_wechat') {
      return [
        { action: 'open_wechat', label: '위챗 열기', primary: true },
        { action: 'open_wechat_download', label: '위챗 공식 설치 페이지' },
      ];
    }
    if (id === 'app_kakaotalk') {
      return [
        { action: 'open_kakaotalk', label: '카카오톡 열기', primary: true },
        { action: 'open_kakaotalk_download', label: '카카오톡 공식 설치 페이지' },
      ];
    }
    if (id === 'node') {
      return [{ action: 'open_backup_tool_download', label: '실행 도구 설치 페이지', primary: true }];
    }
    if (/^wsl_(?:node|jq|sqlite3|tesseract|imagemagick)$/u.test(id)) {
      return [{ action: 'wsl_tools', label: '고급 기능 도구 설치' }];
    }
    if (id === 'wechat_db') {
      return [{ action: 'open_backup_folder', label: '백업 폴더 열기' }];
    }
    return [];
  };
  const actionRows = (items, emptyText) => items.length
    ? items.map((check) => {
      const setupActions = setupActionsForCheck(check);
      const guideText = compactSetupGuideText(check);
      const actionButtons = setupActions.length ? `
        <div class="doctor-row-actions">
          ${setupActions.map((action) => `<button data-doctor-setup="${esc(action.action)}" data-doctor-label="${esc(action.label)}" class="${action.primary ? 'primary' : ''}" type="button">${esc(action.label)}</button>`).join('')}
        </div>` : '';
      const guideDetails = guideText ? `
        <details class="doctor-guide">
          <summary>해결 순서 보기</summary>
          <p>${esc(guideText)}</p>
        </details>` : '';
      const commandDetails = check.action_command ? `
        <details class="doctor-command">
          <summary>고급 명령 보기</summary>
          <code>${esc(check.action_command)}</code>
          <button data-copy-command="${esc(check.action_command)}" type="button">명령 복사</button>
        </details>` : '';
      return `
      <div class="doctor-action ${statusClass(check.status)}">
        <div>
          <strong>${esc(beginnerCheckLabel(check))}</strong>
          <p>${esc(beginnerCheckAction(check))}</p>
          ${isOcrCheck(check) ? ocrSetupGuideHtml(check) : ''}
          ${guideDetails}
          ${commandDetails}
        </div>
        ${actionButtons}
      </div>`;
    }).join('')
    : `<div class="empty">${esc(emptyText)}</div>`;
  view.innerHTML = `
    <div class="grid">
      <section class="panel span-12">
        <div class="toolbar doctor-toolbar">
          <span class="toolbar-spacer"></span>
          <button id="doctorWechat" class="primary" type="button">위챗 백업</button>
          <button id="doctorKakao" type="button">카카오톡 백업</button>
          <button id="doctorRefresh" type="button">상태 새로고침</button>
          <button id="doctorReadinessReport" type="button">준비 보고서</button>
        </div>
        <div class="doctor-status-summary" aria-label="준비 요약">
          <div class="${important.length ? 'status-review' : 'status-pass'}">
            <strong>${esc(doctorReadyLabel)}</strong>
            <span>${esc(doctorReadyText)}</span>
          </div>
          <div class="${optional.length ? 'status-review' : 'status-pass'}">
            <strong>${esc(optionalLabel)}</strong>
            <span>${esc(optionalText)}</span>
          </div>
        </div>
        <div class="doctor-summary">
          <div>
            <strong>바로 필요한 조치</strong>
            ${actionRows(important, '카카오톡/위챗 지금 열린 방 백업에 필요한 핵심 항목은 준비됐습니다')}
          </div>
          <div>
            <strong>선택 기능 조치</strong>
            ${actionRows(optional, '선택 기능도 추가 조치 없이 사용할 수 있습니다')}
          </div>
        </div>
      </section>
      <section class="panel span-12">
        <div class="toolbar"><strong id="doctorJobTitle">준비 작업</strong></div>
        <div id="doctorLog" class="log compact-log">위 조치 버튼을 누르면 진행 내용이 여기에 표시됩니다.</div>
      </section>
      <section class="panel span-12 doctor-detail-panel">
        <details>
          <summary>
            <span>
              <strong>전체 기술 진단 보기</strong>
              <small>지원 요청이나 고급 확인이 필요할 때만 펼치세요</small>
            </span>
          </summary>
          <table class="table"><thead><tr><th>상태</th><th>항목</th><th>결과</th><th>다음 조치</th></tr></thead><tbody>
            ${report.checks.map((check) => `<tr><td class="${statusClass(check.status)}">${esc(statusLabel(check.status))}</td><td>${esc(check.label)}</td><td>${esc(check.message)}</td><td>${esc(check.action || '')}</td></tr>`).join('')}
          </tbody></table>
        </details>
      </section>
    </div>`;
  view.querySelector('#doctorWechat').addEventListener('click', () => navigate('/backup#wechat'));
  view.querySelector('#doctorKakao').addEventListener('click', () => navigate('/backup#kakao'));
  view.querySelector('#doctorRefresh').addEventListener('click', () => doctorView());
  view.querySelector('#doctorReadinessReport').addEventListener('click', () => startDoctorSetupJob('create_readiness_report', '준비 보고서 만들기'));
  view.querySelectorAll('[data-doctor-setup]').forEach((button) => button.addEventListener('click', () => {
    startDoctorSetupJob(button.dataset.doctorSetup || '', button.dataset.doctorLabel || button.textContent || '준비 작업');
  }));
  view.querySelectorAll('[data-copy-command]').forEach((button) => button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copyCommand || '');
      button.textContent = '복사됨';
    } catch {
      button.textContent = '복사 실패';
    }
  }));
}

async function startDoctorSetupJob(action, label) {
  const log = view.querySelector('#doctorLog');
  const titleEl = view.querySelector('#doctorJobTitle');
  if (log) log.textContent = `${label}을 시작하는 중입니다...\n`;
  if (titleEl) titleEl.textContent = label;
  setActiveJob(label, 'starting');
  try {
    const { job } = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ module: 'setup', action, params: { confirmRisk: true } }),
    });
    activeJobId = job.id;
    setActiveJob(label, 'running');
    streamJob(job.id, {
      title: `${label} 진행 중`,
      activeLabel: label,
      afterExit: (event, logEl) => {
        const currentTitle = view.querySelector('#doctorJobTitle');
        if (event.status === 'pass') {
          if (currentTitle) currentTitle.textContent = `${label} 완료`;
          if (logEl) {
            const nextStep = action === 'install_ocr_zh' || action === 'install_ocr_ko'
              ? 'Windows 권한 확인 창이 떴다면 예를 누르세요. 창이 보이지 않으면 작업 표시줄의 새 권한 확인 창 또는 방패 아이콘을 확인하세요. 설치가 끝났으면 상태 새로고침을 눌러 문자 인식 상태를 다시 확인하세요. 자동 설치가 막혔다면 Windows 언어 설정 열기로 직접 설치하세요.'
              : action === 'open_language_settings'
              ? 'Windows 언어 설정에서 언어 추가를 누르고 필요한 언어를 기본 선택 그대로 설치한 뒤 상태 새로고침을 누르세요.'
              : action === 'open_backup_tool_download'
                ? '설치가 끝나면 브라우저와 검은 창을 닫고 1_백업_시작.bat를 다시 실행하세요.'
              : action === 'open_wechat_download' || action === 'open_kakaotalk_download'
                ? '설치와 로그인이 끝나면 상태 새로고침을 누르세요.'
              : '상태 새로고침을 눌러 다시 확인하세요.';
            logEl.textContent += `${nextStep}\n`;
          }
        } else {
          if (currentTitle) currentTitle.textContent = `${label} 확인 필요`;
          if (logEl) logEl.textContent += '작업이 끝나지 않았습니다. 화면 안내를 확인한 뒤 다시 시도하세요.\n';
        }
      },
    });
  } catch (err) {
    if (log) log.textContent = `${friendlyJobError(err)}\n`;
    if (titleEl) titleEl.textContent = `${label} 확인 필요`;
    setActiveJob(label, 'fail');
  }
}

function jobTable(jobs) {
  jobs = Array.isArray(jobs) ? jobs : [];
  if (!jobs.length) {
    return `<div class="empty job-empty">
      <strong>아직 진행 기록이 없습니다</strong>
      <span>백업이나 준비 확인을 실행하면 진행 기록이 여기에 표시됩니다.</span>
    </div>`;
  }
  return `<table class="table job-table"><thead><tr><th>상태</th><th>진행 항목</th><th>분류</th><th>시작 시각</th></tr></thead><tbody>
    ${jobs.map((job) => `<tr data-job="${esc(job.id)}">
      <td>
        <span class="badge ${statusClass(job.status)}">${esc(statusLabel(job.status))}</span>
        <small>${esc(jobStatusHint(job.status))}</small>
      </td>
      <td>
        <strong>${esc(jobActionLabel(job))}</strong>
        <p>${esc(jobActionDetail(job))}</p>
        <details class="job-technical">
          <summary>지원 받을 때만 내부 정보 보기</summary>
          <code>내부 작업: ${esc(job.module)}.${esc(job.action)}</code>
          <code>기록 ID: ${esc(job.id)}</code>
        </details>
      </td>
      <td>${esc(riskLabel(job.risk) || '일반')}</td>
      <td>${esc(jobStartedAt(job.started_at))}</td>
    </tr>`).join('')}
  </tbody></table>`;
}

function defaultJobSelection(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  for (const statuses of [['running', 'stopping'], ['fail', 'review', 'stopped'], ['pass']]) {
    const job = list.find((item) => statuses.includes(String(item?.status || '').toLowerCase()));
    if (job?.id) return job.id;
  }
  return '';
}

async function jobsView() {
  setChrome('진행 기록', '백업이 실제로 실행됐는지 확인하고 필요하면 다시 실행합니다');
  const jobs = await api('/api/jobs');
  const jobList = Array.isArray(jobs.jobs) ? jobs.jobs : [];
  const jobById = new Map((jobs.jobs || []).map((job) => [job.id, job]));
  const hasJobs = jobList.length > 0;
  const requestedJobId = selectedJobFromHash();
  const requestedMissing = requestedJobId && !jobById.has(requestedJobId);
  view.innerHTML = `
    <section class="panel job-history-panel">
      <div class="toolbar job-toolbar">
        <div class="toolbar-title">
          <strong>최근 진행 기록</strong>
          <span>백업 결과가 비어 있으면 여기에서 실행 여부와 오류를 확인하세요.</span>
        </div>
        <button id="doctorJob" type="button">준비 다시 확인</button>
        <button id="jobsWechat" class="primary" type="button">위챗 백업</button>
        <button id="jobsKakao" type="button">카카오톡 백업</button>
        <button id="jobsChats" type="button">결과 보기</button>
        <button id="jobsReadinessReport" type="button">준비 보고서</button>
        <button id="jobsValidationReport" type="button">검증 보고서</button>
      </div>
      ${jobTable(jobList)}
    </section>
    <section class="panel" style="margin-top:12px">
      <div class="toolbar job-toolbar">
        <div class="toolbar-title">
          <strong id="jobLogTitle">${hasJobs ? '최근 진행 항목을 여는 중입니다' : '진행 항목을 선택하면 기록이 여기에 표시됩니다'}</strong>
          <span id="jobLogHint">${hasJobs ? '최근 항목을 자동으로 열어 둡니다. 다른 항목은 목록에서 선택하세요.' : '오류가 있으면 마지막 줄부터 확인하면 됩니다.'}</span>
        </div>
        <button id="rerunJob" type="button" disabled>다시 실행</button>
      </div>
      <details class="support-actions">
        <summary>지원 요청이 필요할 때만</summary>
        <div class="support-warning">
          먼저 보기용 기록만 저장해 전달하세요. 원본 지원 묶음에는 오류 원문, 일부 대화 내용, 내 컴퓨터의 폴더 경로가 포함될 수 있으므로 담당자가 요청할 때만 저장합니다.
        </div>
        <div class="support-action-row">
          <button id="copyJobLink" type="button" disabled>기록 링크 복사</button>
          <button id="saveJobLog" type="button" disabled>보기용 기록 저장</button>
        </div>
        <label class="support-raw-confirm">
          <span>
            <input id="confirmRawSupport" type="checkbox" disabled>
            원본 묶음에는 개인 정보가 들어갈 수 있음을 확인했습니다.
          </span>
        </label>
        <div class="support-action-row">
          <button id="saveJobRaw" class="danger" type="button" disabled>원본 지원 묶음 저장</button>
        </div>
      </details>
      <div id="jobLog" class="log">${requestedMissing ? '요청한 진행 기록을 찾지 못했습니다. 최근 진행 기록을 선택하세요.' : (hasJobs ? '최근 진행 항목을 불러오는 중입니다...' : '위 진행 기록에서 확인할 항목을 선택하세요.')}</div>
    </section>`;
  view.querySelector('#doctorJob').addEventListener('click', async () => {
    const label = '준비 다시 확인';
    setActiveJob(label, 'starting');
    try {
      const { job } = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ module: 'doctor', action: 'run', params: {} }) });
      activeJobId = job.id;
      setActiveJob(label, 'running');
      await jobsView();
    } catch (err) {
      const log = view.querySelector('#jobLog');
      if (log) log.textContent = `${friendlyJobError(err)}\n`;
      setActiveJob(label, 'fail');
    }
  });
  view.querySelector('#jobsWechat').addEventListener('click', () => navigate('/backup#wechat'));
  view.querySelector('#jobsKakao').addEventListener('click', () => navigate('/backup#kakao'));
  view.querySelector('#jobsChats').addEventListener('click', () => navigate('/chats'));
  view.querySelector('#jobsReadinessReport').addEventListener('click', async () => {
    const label = '준비 보고서 만들기';
    const log = view.querySelector('#jobLog');
    if (log) {
      log.textContent = '채팅 내용 없이 앱, 문자 인식, 저장 폴더 준비 상태만 담은 보고서를 만듭니다.\n백업 전에도 만들 수 있고 방 이름이나 원본 스크린샷 경로는 넣지 않습니다.\n';
    }
    setActiveJob(label, 'starting');
    try {
      const { job } = await api('/api/jobs', {
        method: 'POST',
        body: JSON.stringify({
          module: 'setup',
          action: 'create_readiness_report',
          params: { confirmRisk: true },
        }),
      });
      activeJobId = job.id;
      setActiveJob(label, 'running');
      await jobsView();
    } catch (err) {
      if (log) log.textContent = `${friendlyJobError(err)}\n`;
      setActiveJob(label, 'fail');
    }
  });
  view.querySelector('#jobsValidationReport').addEventListener('click', async () => {
    const label = '검증 보고서 만들기';
    const log = view.querySelector('#jobLog');
    if (log) {
      log.textContent = '백업 결과 개수와 준비 상태만 확인하는 보고서를 만듭니다.\n채팅 본문, 방 이름, 스크린샷 경로는 보고서에 넣지 않습니다.\n';
    }
    setActiveJob(label, 'starting');
    try {
      const { job } = await api('/api/jobs', {
        method: 'POST',
        body: JSON.stringify({
          module: 'setup',
          action: 'create_live_validation_report',
          params: { url: window.location.origin, confirmRisk: true },
        }),
      });
      activeJobId = job.id;
      setActiveJob(label, 'running');
      await jobsView();
    } catch (err) {
      if (log) log.textContent = `${friendlyJobError(err)}\n`;
      setActiveJob(label, 'fail');
    }
  });
  const rerunButton = view.querySelector('#rerunJob');
  const copyJobLinkButton = view.querySelector('#copyJobLink');
  const saveJobLogButton = view.querySelector('#saveJobLog');
  const saveJobRawButton = view.querySelector('#saveJobRaw');
  const confirmRawSupport = view.querySelector('#confirmRawSupport');
  let selectedJobId = '';
  const updateSupportButtons = () => {
    const hasSelection = Boolean(selectedJobId);
    copyJobLinkButton.disabled = !hasSelection;
    saveJobLogButton.disabled = !hasSelection;
    confirmRawSupport.disabled = !hasSelection;
    saveJobRawButton.disabled = !hasSelection || !confirmRawSupport.checked;
  };
  const selectJob = (id, { automatic = false, keepUrl = false } = {}) => {
    const job = jobById.get(id);
    if (!job) return false;
    activeJobId = id;
    selectedJobId = id;
    rerunButton.disabled = false;
    confirmRawSupport.checked = false;
    updateSupportButtons();
    if (!automatic && !keepUrl) history.replaceState(null, '', `/jobs#job=${encodeURIComponent(id)}`);
    view.querySelectorAll('[data-job]').forEach((row) => row.classList.toggle('selected', row.dataset.job === id));
    const hint = view.querySelector('#jobLogHint');
    if (hint) {
      hint.textContent = automatic
        ? '최근 진행 항목을 자동으로 열었습니다. 오류가 있으면 마지막 안내부터 확인하세요.'
        : '오류가 있으면 마지막 안내부터 확인하세요.';
    }
    const running = ['running', 'stopping'].includes(String(job.status || '').toLowerCase());
    const terminal = ['pass', 'fail', 'review', 'stopped'].includes(String(job.status || '').toLowerCase());
    if (activeJobLabel && activeJobId === id && terminal) setActiveJob(jobActionLabel(job), job.status);
    streamJob(id, { title: jobLogHeading(job), activeLabel: running ? jobActionLabel(job) : '' });
    return true;
  };
  view.querySelectorAll('[data-job]').forEach((row) => row.addEventListener('click', () => {
    selectJob(row.dataset.job || '');
  }));
  copyJobLinkButton.addEventListener('click', async () => {
    if (!selectedJobId) return;
    const originalText = copyJobLinkButton.textContent;
    try {
      await copyToClipboard(jobDirectUrl(selectedJobId));
      copyJobLinkButton.textContent = '링크 복사됨';
    } catch {
      copyJobLinkButton.textContent = '복사 실패';
    }
    setTimeout(() => { copyJobLinkButton.textContent = originalText; }, 1400);
  });
  saveJobLogButton.addEventListener('click', () => {
    if (!selectedJobId) return;
    const job = jobById.get(selectedJobId);
    const logText = view.querySelector('#jobLog')?.textContent || '';
    const titleText = job ? jobActionLabel(job) : '진행 기록';
    const body = [
      `진행 항목: ${titleText}`,
      `상태: ${job ? statusLabel(job.status) : '-'}`,
      `시작 시각: ${job?.started_at || '-'}`,
      `기록 ID: ${selectedJobId}`,
      '',
      logText,
    ].join('\n');
    downloadTextFile(`computer-use-${safeFileName(selectedJobId)}.txt`, body);
  });
  confirmRawSupport.addEventListener('change', updateSupportButtons);
  saveJobRawButton.addEventListener('click', async () => {
    if (!selectedJobId || !confirmRawSupport.checked) return;
    const job = jobById.get(selectedJobId);
    const originalText = saveJobRawButton.textContent;
    saveJobRawButton.disabled = true;
    saveJobRawButton.textContent = '저장 중';
    try {
      await downloadRawJobBundle(selectedJobId, job);
      saveJobRawButton.textContent = '원본 묶음 저장됨';
    } catch {
      saveJobRawButton.textContent = '저장 실패';
    }
    setTimeout(() => {
      saveJobRawButton.textContent = originalText;
      updateSupportButtons();
    }, 1400);
  });
  rerunButton.addEventListener('click', async () => {
    if (!activeJobId) return;
    const oldJob = jobById.get(activeJobId);
    const label = oldJob ? jobActionLabel(oldJob) : '다시 실행';
    setActiveJob(label, 'starting');
    try {
      const { job } = await api(`/api/jobs/${encodeURIComponent(activeJobId)}/rerun`, { method: 'POST' });
      activeJobId = job.id;
      setActiveJob(label, 'running');
      await jobsView();
    } catch (err) {
      const log = view.querySelector('#jobLog');
      if (log) log.textContent = `${friendlyJobError(err)}\n`;
      setActiveJob(label, 'fail');
    }
  });
  const initialJobId = requestedJobId && jobById.has(requestedJobId)
    ? requestedJobId
    : (activeJobId && jobById.has(activeJobId) ? activeJobId : defaultJobSelection(jobList));
  if (initialJobId) selectJob(initialJobId, { automatic: initialJobId !== activeJobId && initialJobId !== requestedJobId, keepUrl: initialJobId === requestedJobId });
  else activeJobId = '';
}

function streamJob(id, options = {}) {
  const log = document.querySelector('#jobLog') || document.querySelector('#agentLog') || document.querySelector('#backupLog') || document.querySelector('#doctorLog');
  const label = document.querySelector('#jobLogTitle') || document.querySelector('#backupJobTitle') || document.querySelector('#doctorJobTitle');
  if (label) label.textContent = options.title || '진행 기록';
  if (!log) return;
  log.textContent = options.initialText || '';
  eventSource?.close();
  const qs = '';
  eventSource = new EventSource(`/api/jobs/${encodeURIComponent(id)}/events${qs}`);
  eventSource.onmessage = appendEvent;
  for (const type of ['start', 'stdout', 'stderr', 'exit', 'stopping']) {
    eventSource.addEventListener(type, appendEvent);
  }
  function appendEvent(evt) {
    const data = JSON.parse(evt.data);
    if (data.text) log.textContent += friendlyLogText(data.text);
    else log.textContent += friendlyEventText(data, { hasAfterExit: Boolean(options.afterExit) });
    log.scrollTop = log.scrollHeight;
    if (data.type === 'start') {
      if (options.activeLabel) setActiveJob(options.activeLabel, 'running');
      else setStopEnabled(true);
    }
    if (data.type === 'stopping') {
      if (options.activeLabel) setActiveJob(options.activeLabel, 'stopping');
      setStopEnabled(false);
    }
    if (data.type === 'exit') {
      eventSource?.close();
      if (options.activeLabel) setActiveJob(options.activeLabel, data.status || 'fail');
      setStopEnabled(false);
      options.afterExit?.(data, log);
    }
  }
}

async function agentView() {
  const modules = await api('/api/modules').catch(() => ({ modules: [] }));
  const hasAgent = Array.isArray(modules.modules) && modules.modules.some((item) => item.module === 'agent');
  if (!hasAgent) {
    setChrome('카카오톡/위챗 백업', '백업과 결과 확인을 바로 이어서 진행합니다');
    view.innerHTML = `
      <div class="grid">
        <section class="panel span-12 unavailable-panel">
          <div>
            <h2>백업 화면으로 이동하세요</h2>
            <p>이 화면에서는 카카오톡/위챗 백업과 결과 확인만 제공합니다. 아래 버튼으로 바로 이어서 진행하세요.</p>
          </div>
          <div class="unavailable-actions">
            <button data-agent-fallback="wechat" class="primary" type="button">위챗 백업</button>
            <button data-agent-fallback="kakao" type="button">카카오톡 백업</button>
            <button data-agent-fallback="chats" type="button">결과 보기</button>
            <button data-agent-fallback="doctor" type="button">준비 확인</button>
          </div>
        </section>
      </div>`;
    view.querySelector('[data-agent-fallback="wechat"]').addEventListener('click', () => navigate('/backup#wechat'));
    view.querySelector('[data-agent-fallback="kakao"]').addEventListener('click', () => navigate('/backup#kakao'));
    view.querySelector('[data-agent-fallback="chats"]').addEventListener('click', () => navigate('/chats'));
    view.querySelector('[data-agent-fallback="doctor"]').addEventListener('click', () => navigate('/doctor'));
    return;
  }
  setChrome('고급 자동 실행', '작업 목표를 맡기기 전에 미리 확인합니다');
  const cfg = await api('/api/config').catch(() => ({ agentProvider: 'auto' }));
  view.innerHTML = `
    <div class="grid">
      <section class="panel span-5">
        <form id="agentForm" class="form">
          <label>목표<textarea id="goalInput" required placeholder="예: 현재 데스크톱 상태를 확인하고 실행 계획을 작성해줘"></textarea></label>
          <label>실행 방식<select id="providerInput"><option value="auto">자동 추천</option><option value="codex">Codex</option><option value="claude">Claude</option></select></label>
          <div class="segmented"><button type="button" data-mode="preview" class="active">미리보기</button><button type="button" data-mode="run">실행</button></div>
          <label><span><input id="confirmRisk" type="checkbox"> 외부 자동화 또는 쓰기 작업 위험을 확인했습니다</span></label>
          <button class="primary" type="submit">작업 시작</button>
        </form>
      </section>
      <section class="panel span-7">
        <div class="toolbar"><strong>실시간 로그</strong></div>
        <div id="agentLog" class="log"></div>
      </section>
    </div>`;
  view.querySelector('#providerInput').value = cfg.agentProvider || 'auto';
  let mode = 'preview';
  view.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => {
    mode = button.dataset.mode;
    view.querySelectorAll('[data-mode]').forEach((it) => it.classList.toggle('active', it === button));
  }));
  view.querySelector('#agentForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const goal = view.querySelector('#goalInput').value.trim();
    const provider = view.querySelector('#providerInput').value;
    const confirmRisk = view.querySelector('#confirmRisk').checked;
    const label = mode === 'run' ? '고급 자동 실행' : '고급 자동 실행 미리보기';
    setActiveJob(label, 'starting');
    try {
      const { job } = await api('/api/agent/jobs', { method: 'POST', body: JSON.stringify({ goal, mode, provider, confirmRisk }) });
      activeJobId = job.id;
      setActiveJob(label, 'running');
      streamJob(job.id, { activeLabel: label });
    } catch (err) {
      document.querySelector('#agentLog').textContent = `${friendlyJobError(err)}\n`;
      setActiveJob(label, 'fail');
    }
  });
}

async function chatsView() {
  await api('/api/config');
  setChrome('결과 보기', '위챗과 카카오톡 백업 결과를 한 화면에서 확인합니다');
  const frameUrl = '/chat-viewer/?scope=chat';
  const renderToken = ++chatsRenderToken;
  const healthPromise = fetchJsonWithTimeout('/chat-viewer/api/health?platform=chat', { cache: 'no-store' }, 1200);
  const healthResult = await Promise.race([
    healthPromise.then((health) => health
      ? ({ ready: true, health })
      : ({ ready: false, health: null, stopped: true })),
    delay(500).then(() => ({ ready: false, health: null })),
  ]);
  const viewerPending = !healthResult.ready;
  if (viewerPending && !healthResult.stopped) {
    healthPromise.then((health) => {
      if (health && chatsRenderToken === renderToken && routePath() === '/chats') render();
    }).catch(() => {});
  }
  const viewerHealth = healthResult.health;
  const noResults = viewerHealth && Number(viewerHealth?.counts?.rooms || 0) === 0;
  const chatHelp = (() => {
    if (viewerPending) {
      return `<div class="chat-empty-help chat-loading-help" role="status">
        <div>
          <strong>결과 화면을 준비하는 중입니다</strong>
          <p>기다리지 않고 위챗 백업이나 카카오톡 백업으로 바로 갈 수 있습니다.</p>
          <ol class="empty-next-steps">
            <li>백업할 앱에서 방을 열어 둡니다.</li>
            <li>위챗 백업 또는 카카오톡 백업을 누릅니다.</li>
            <li>이미 백업했다면 결과 새로고침, 백업 폴더 열기, 진행 기록 순서로 확인합니다.</li>
          </ol>
        </div>
        <div class="empty-actions">
          <button data-empty-wechat class="primary" type="button">위챗 백업</button>
          <button data-empty-kakao type="button">카카오톡 백업</button>
          <button data-empty-refresh type="button">결과 새로고침</button>
          <button data-empty-folder type="button">백업 폴더 열기</button>
          <button data-empty-jobs type="button">진행 기록</button>
        </div>
      </div>`;
    }
    if (!noResults) return '';
    return `<div class="chat-empty-help" role="status">
        <div>
          <strong>아직 백업 결과가 없습니다</strong>
          <p>실패가 아니라 아직 이 화면에서 읽을 백업 파일이 없다는 뜻입니다.</p>
          <ol class="empty-next-steps">
            <li>처음이면 지금 열린 위챗 방 백업부터 시작하는 것이 가장 쉽습니다.</li>
            <li>카카오톡만 쓰면 카카오톡 백업을 누릅니다.</li>
            <li>이미 실행했다면 결과 새로고침, 백업 폴더 열기, 진행 기록 순서로 확인합니다.</li>
          </ol>
        </div>
        <div class="empty-actions">
          <button data-empty-wechat class="primary" type="button">위챗 백업</button>
          <button data-empty-kakao type="button">카카오톡 백업</button>
          <button data-empty-refresh type="button">결과 새로고침</button>
          <button data-empty-folder type="button">백업 폴더 열기</button>
          <button data-empty-jobs type="button">진행 기록</button>
        </div>
      </div>`;
  })();
  const showFrame = !viewerPending && !noResults;
  view.innerHTML = `
    <section class="panel chat-console ${noResults ? 'no-results' : ''} ${viewerPending ? 'loading-results' : ''} ${resultsWide ? 'wide-results' : ''}">
      <div class="toolbar">
        <strong>백업 결과</strong>
        <button id="chatWechat" class="primary" type="button">위챗 백업</button>
        <button id="chatKakao" type="button">카카오톡 백업</button>
        <button id="chatRefresh" type="button">결과 새로고침</button>
        <button id="chatFolder" type="button">백업 폴더 열기</button>
        <button id="chatJobs" type="button">진행 기록</button>
        ${showFrame ? `<button id="chatResize" type="button" aria-controls="chatFrame" aria-pressed="${resultsWide ? 'true' : 'false'}" title="새 창을 열지 않고 이 화면에서 결과 영역을 넓힙니다">${resultsWide ? '기본 크기로 보기' : '결과 영역 크게 보기'}</button>` : ''}
      </div>
      <div class="unified-result-note">
        <strong>웹 화면은 하나입니다</strong>
        <span>결과는 이 화면 안에서 열립니다. 정상은 읽을 수 있는 백업, 확인 필요는 실패가 아니라 발신자/글자/원본만 대조할 결과입니다.</span>
      </div>
      ${chatHelp}
      ${showFrame ? `<iframe id="chatFrame" title="백업 결과" src="${esc(frameUrl)}"></iframe>` : ''}
    </section>`;
  const refreshChatResults = async () => {
    await fetchWithTimeout('/chat-viewer/api/refresh', { cache: 'no-store' }, 5000).catch(() => null);
    render();
  };
  const openBackupFolder = async (button = view.querySelector('#chatFolder')) => {
    const label = '백업 폴더 열기';
    const originalText = button.textContent;
    button.textContent = '여는 중';
    button.disabled = true;
    setActiveJob(label, 'starting');
    try {
      const { job } = await api('/api/jobs', {
        method: 'POST',
        body: JSON.stringify({ module: 'setup', action: 'open_backup_folder', params: { confirmRisk: true } }),
      });
      activeJobId = job.id;
      setActiveJob(label, 'running');
      watchJobExit(job.id, {
        activeLabel: label,
        afterExit: (event) => {
          button.disabled = false;
          button.textContent = event.status === 'pass' ? '백업 폴더 열림' : originalText;
        },
      });
    } catch {
      button.disabled = false;
      button.textContent = originalText;
      setActiveJob(label, 'fail');
    }
  };
  view.querySelector('#chatWechat').addEventListener('click', () => navigate('/backup#wechat'));
  view.querySelector('#chatKakao').addEventListener('click', () => navigate('/backup#kakao'));
  view.querySelector('[data-empty-kakao]')?.addEventListener('click', () => navigate('/backup#kakao'));
  view.querySelector('[data-empty-wechat]')?.addEventListener('click', () => navigate('/backup#wechat'));
  view.querySelector('[data-empty-refresh]')?.addEventListener('click', refreshChatResults);
  view.querySelector('[data-empty-folder]')?.addEventListener('click', () => openBackupFolder(view.querySelector('[data-empty-folder]')));
  view.querySelector('[data-empty-jobs]')?.addEventListener('click', () => navigate('/jobs'));
  view.querySelector('#chatResize')?.addEventListener('click', (event) => {
    resultsWide = !resultsWide;
    view.querySelector('.chat-console')?.classList.toggle('wide-results', resultsWide);
    event.currentTarget.textContent = resultsWide ? '기본 크기로 보기' : '결과 영역 크게 보기';
    event.currentTarget.setAttribute('aria-pressed', resultsWide ? 'true' : 'false');
  });
  view.querySelector('#chatRefresh').addEventListener('click', refreshChatResults);
  view.querySelector('#chatFolder').addEventListener('click', () => openBackupFolder());
  view.querySelector('#chatJobs').addEventListener('click', () => navigate('/jobs'));
}

async function settingsView() {
  setChrome('저장 위치', '백업 파일과 작업 기록이 저장되는 위치입니다');
  const cfg = await api('/api/config');
  const pathLabels = {
    repoRootWsl: '프로그램 폴더(지원용 보조 경로)',
    repoRootWin: '프로그램 폴더',
    mirrorRootWsl: 'Windows 복사본 폴더(지원용 보조 경로)',
    mirrorRootWin: 'Windows 복사본 폴더',
    shotsDirWsl: '백업 저장 폴더(지원용 보조 경로)',
    shotsDirWin: '백업 저장 폴더',
    stateDirWsl: '설정/상태 폴더(지원용 보조 경로)',
    stateDirWin: '설정/상태 폴더',
    runsDirWsl: '진행 기록 폴더(지원용 보조 경로)',
    runsDirWin: '진행 기록 폴더',
    wechatDbWsl: '예전 위챗 백업 파일(지원용 보조 경로)',
    wechatDbWin: '예전 위챗 백업 파일',
  };
  const backupFolder = cfg.paths.shotsDirWin || cfg.paths.shotsDirWsl || '아직 정해지지 않았습니다';
  const otherRows = [
    ['문제가 생겼을 때 확인할 진행 기록 폴더', cfg.paths.runsDirWin || cfg.paths.runsDirWsl],
    ['설정 저장 폴더', cfg.paths.stateDirWin || cfg.paths.stateDirWsl],
    ['프로그램이 들어 있는 폴더', cfg.paths.repoRootWin || cfg.paths.repoRootWsl],
  ].filter(([, value]) => value);
  view.innerHTML = `
    <section class="panel storage-panel">
      <div class="toolbar">
        <strong>저장 위치</strong>
        <button id="settingsOpenFolder" class="primary" type="button">백업 폴더 열기</button>
        <button id="settingsOpenChats" type="button">결과 보기</button>
        <button id="settingsOpenJobs" type="button">진행 기록</button>
      </div>
      <div class="storage-summary">
        <span>평소에는 이 폴더 하나만 기억하면 됩니다. 카카오톡과 위챗 백업 결과가 여기에 저장됩니다.</span>
        <strong>${esc(backupFolder)}</strong>
      </div>
      <div class="storage-help">
        <div><strong>결과 확인</strong><span>백업이 끝나면 결과 보기에서 먼저 확인합니다.</span></div>
        <div><strong>파일 확인</strong><span>직접 파일을 보고 싶을 때만 백업 폴더 열기를 누릅니다.</span></div>
        <div><strong>위치 변경</strong><span>폴더를 바꾼 뒤에는 1_백업_시작.bat를 다시 실행합니다.</span></div>
      </div>
      <form id="settingsForm" class="settings-form">
        <label>백업 저장 폴더 변경
          <input id="shotsDirInput" type="text" autocomplete="off" placeholder="예: D:\\KakaoBackups">
        </label>
        <p>C:\\ 또는 D:\\처럼 드라이브 문자로 시작하는 Windows 폴더를 입력합니다. 저장할 때 가능한 경우 폴더를 만들고 쓸 수 있는지 확인합니다. 새 위치를 저장한 뒤에는 이 화면을 닫고 <strong>1_백업_시작.bat</strong>를 다시 실행해야 적용됩니다.</p>
        <div class="settings-actions">
          <button id="settingsSave" type="submit">다음 실행부터 적용</button>
        </div>
        <div id="settingsMessage" class="settings-message" role="status" hidden></div>
      </form>
      <details class="advanced-options storage-more">
        <summary>문제가 생겼을 때 저장 위치 보기</summary>
        <table class="table"><tbody>
          ${otherRows.map(([label, value]) => `<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>`).join('')}
        </tbody></table>
      </details>
      <details class="advanced-options">
        <summary>지원 받을 때만 자세한 위치 보기</summary>
        <table class="table"><tbody>
          ${Object.entries(cfg.paths).map(([key, value]) => `<tr><th>${esc(pathLabels[key] || key)}</th><td>${esc(value)}</td></tr>`).join('')}
          <tr><th>백업 화면 주소 번호</th><td>${esc(cfg.defaultConsolePort)}</td></tr>
          <tr><th>브라우저 연결 번호</th><td>${esc(cfg.chromeCdpPort)}</td></tr>
        </tbody></table>
      </details>
    </section>`;
  const settingsForm = view.querySelector('#settingsForm');
  const settingsMessage = view.querySelector('#settingsMessage');
  settingsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = view.querySelector('#shotsDirInput');
    const value = String(input?.value || '').trim();
    if (!value) {
      settingsMessage.textContent = '변경할 폴더를 입력하지 않아 현재 저장 위치를 그대로 둡니다.';
      settingsMessage.hidden = false;
      return;
    }
    if (looksLikeRedactedPath(value)) {
      settingsMessage.textContent = '화면에 보이는 <user>나 $HOME 표시는 개인정보 보호용입니다. 실제 Windows 폴더 경로를 입력하세요.';
      settingsMessage.hidden = false;
      input?.focus();
      return;
    }
    const button = view.querySelector('#settingsSave');
    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = '저장 중';
    try {
      const result = await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ shotsDir: value }),
      });
      const checkedText = result.writableChecked ? ' 새 폴더에 쓸 수 있는지도 확인했습니다.' : '';
      settingsMessage.textContent = result.restartRequired
        ? `저장했습니다.${checkedText} 브라우저를 닫고 1_백업_시작.bat를 다시 실행하면 새 백업 저장 폴더가 적용됩니다.`
        : '저장했습니다.';
      settingsMessage.hidden = false;
      input.value = '';
    } catch (err) {
      settingsMessage.textContent = err.message || '저장하지 못했습니다. 폴더 경로를 확인한 뒤 다시 시도하세요.';
      settingsMessage.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  });
  view.querySelector('#settingsOpenChats').addEventListener('click', () => navigate('/chats'));
  view.querySelector('#settingsOpenJobs').addEventListener('click', () => navigate('/jobs'));
  view.querySelector('#settingsOpenFolder').addEventListener('click', async () => {
    const label = '백업 폴더 열기';
    const button = view.querySelector('#settingsOpenFolder');
    const originalText = button.textContent;
    button.textContent = '여는 중';
    button.disabled = true;
    setActiveJob(label, 'starting');
    try {
      const { job } = await api('/api/jobs', {
        method: 'POST',
        body: JSON.stringify({ module: 'setup', action: 'open_backup_folder', params: { confirmRisk: true } }),
      });
      activeJobId = job.id;
      setActiveJob(label, 'running');
      watchJobExit(job.id, {
        activeLabel: label,
        afterExit: (event) => {
          button.disabled = false;
          button.textContent = event.status === 'pass' ? '백업 폴더 열림' : originalText;
        },
      });
    } catch {
      button.disabled = false;
      button.textContent = originalText;
      setActiveJob(label, 'fail');
    }
  });
}

function navigate(path) {
  history.pushState(null, '', path);
  render();
}

async function render() {
  await refreshHealth();
  const fn = routes[routePath()] || dashboardView;
  try {
    await fn();
  } catch (err) {
    if (err.status === 401 && await tryLocalAuth()) {
      render();
      return;
    }
    view.innerHTML = `<section class="panel auth-panel">
      <h2>백업 화면을 새로 열어 주세요</h2>
      <p>지금 열린 화면은 오래된 주소입니다. 따로 입력할 내용이 없습니다. 아무 값도 입력하지 않습니다. 영어 오류 화면이 보여도 값을 찾지 말고, 브라우저와 검은 창을 닫은 뒤 압축을 푼 폴더의 <strong>1_백업_시작.bat</strong>를 다시 더블클릭하세요. Windows가 파일 확장자를 숨기면 <strong>1_백업_시작</strong>으로 보일 수 있습니다. 보조 실행 파일은 <strong>시작하기.bat</strong>입니다.</p>
      <div class="auth-wechat-note">
        <strong>위챗은 1번입니다</strong>
        <span>위챗은 사라진 것이 아닙니다. 새로 열린 첫 화면에서 첫 번째 초록색 버튼, 상단 버튼, 왼쪽 메뉴의 <strong>1번 위챗 백업</strong>을 누르면 됩니다. 결과 보기도 같은 웹 화면 안에 있습니다.</span>
      </div>
      <ol class="auth-steps">
        <li><span>1</span><strong>브라우저와 검은 창 닫기</strong></li>
        <li><span>2</span><strong>1_백업_시작.bat 더블클릭</strong></li>
        <li><span>3</span><strong>위챗 백업 버튼 확인</strong></li>
      </ol>
      <div class="auth-actions">
        <button id="localAuth" class="primary" type="button">백업 화면 다시 열기</button>
        <button id="authHome" type="button">처음 화면으로 이동</button>
      </div>
    </section>`;
    view.querySelector('#localAuth').addEventListener('click', async () => {
      localAuthTried = false;
      if (await tryLocalAuth()) {
        render();
        return;
      }
      location.href = '/';
    });
    view.querySelector('#authHome').addEventListener('click', () => { location.href = '/'; });
  }
}

document.querySelectorAll('.nav a').forEach((a) => a.addEventListener('click', (event) => {
  event.preventDefault();
  navigate(a.getAttribute('href'));
}));
window.addEventListener('popstate', render);
refreshBtn.addEventListener('click', render);
quickWechatBtn.addEventListener('click', () => navigate('/backup#wechat'));
quickChatsBtn.addEventListener('click', () => navigate('/chats'));
stopBtn.addEventListener('click', async () => {
  if (!activeJobId || stopBtn.disabled) return;
  setActiveJob(activeJobLabel || '실행 중인 작업', 'stopping');
  stopBtn.disabled = true;
  await api(`/api/jobs/${encodeURIComponent(activeJobId)}/stop`, { method: 'POST' });
});

render();
