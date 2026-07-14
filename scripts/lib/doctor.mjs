import { constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadPathConfig } from './path_config.mjs';

const severity = { pass: 0, review: 1, fail: 2 };

function statusFrom(checks) {
  let status = 'pass';
  for (const check of checks) {
    if (severity[check.status] > severity[status]) status = check.status;
  }
  return status;
}

export function redactPath(value) {
  let text = String(value ?? '');
  const home = homedir();
  if (home) text = text.replaceAll(home, '$HOME');
  text = text.replace(/\/home\/[^/\s]+/gu, '/home/<user>');
  text = text.replace(/\/mnt\/([A-Za-z])\/Users\/[^/\s]+/gu, '/mnt/$1/Users/<user>');
  text = text.replace(/[A-Za-z]:\\Users\\[^\\\s]+/gu, (m) => `${m.slice(0, 9)}<user>`);
  text = text.replace(/\\\\wsl\.localhost\\([^\\]+)\\home\\[^\\\s]+/giu, '\\\\wsl.localhost\\$1\\home\\<user>');
  return text;
}

function friendlyRedactedPath(value) {
  return String(value ?? '')
    .replaceAll('$HOME', '내 사용자 폴더')
    .replaceAll('<user>', '내이름');
}

function check(id, label, status, message, details = {}) {
  return { id, label, status, message, details };
}

const actionGuides = {
  wsl: {
    action: '일반 콘솔과 카카오톡/위챗 화면 백업은 WSL 없이 사용할 수 있습니다. 예전 위챗 백업 파일 검사 같은 고급 기능이 필요할 때만 WSL을 설치하세요.',
    action_command: 'wsl --install -d Ubuntu',
  },
  wsl_node: {
    action: '예전 백업 파일 검사나 추가 검수 같은 선택 기능을 쓸 때만 고급 기능 도구를 준비하세요.',
    action_command: 'sudo apt update && sudo apt install -y nodejs npm jq sqlite3 tesseract-ocr tesseract-ocr-kor tesseract-ocr-chi-sim imagemagick',
  },
  wsl_jq: {
    action: '예전 백업 파일 검사나 추가 검수 같은 선택 기능을 쓸 때만 고급 기능 도구를 준비하세요. 지금 열린 위챗 방/왼쪽 목록 백업에는 필요하지 않습니다.',
    action_command: 'sudo apt update && sudo apt install -y jq',
  },
  wsl_sqlite3: {
    action: '예전 위챗 백업 파일 검사에만 필요한 도구입니다. 지금 열린 위챗 방/왼쪽 목록 백업에는 없어도 됩니다.',
    action_command: 'sudo apt update && sudo apt install -y sqlite3',
  },
  wsl_tesseract: {
    action: '고급 문자 인식 배치를 쓸 때만 준비하세요. 기본 백업은 Windows 문자 인식을 우선 사용합니다.',
    action_command: 'sudo apt update && sudo apt install -y tesseract-ocr tesseract-ocr-kor tesseract-ocr-chi-sim',
  },
  wsl_imagemagick: {
    action: '고급 이미지 처리 작업을 쓸 때만 준비하세요.',
    action_command: 'sudo apt update && sudo apt install -y imagemagick',
  },
  powershell: {
    action: 'Windows 기본 실행 상태를 확인한 뒤 압축을 푼 폴더의 1_백업_시작.bat를 다시 실행하세요. 보이지 않으면 시작하기.bat를 사용하세요.',
  },
  node: {
    action: '백업 화면 실행 도구를 설치한 뒤 압축을 푼 폴더의 1_백업_시작.bat를 다시 실행하세요. 보이지 않으면 시작하기.bat를 사용하세요.',
    action_command: 'winget install OpenJS.NodeJS.LTS',
  },
  jq: {
    action: '기본 백업에는 보통 필요하지 않습니다. 예전 백업 파일 검사나 추가 검수 같은 선택 기능을 쓸 때만 준비하세요.',
  },
  sqlite3: {
    action: '예전 위챗 백업 파일 검사에만 필요한 도구입니다. 지금 열린 위챗 방/왼쪽 목록 백업에는 없어도 됩니다.',
  },
  codex: {
    action: '고급 문자 인식, 번역, 자동 실행을 쓸 때만 고급 자동 실행 도구를 설치하고 로그인하세요.',
  },
  claude: {
    action: '고급 자동 실행을 쓸 때만 고급 자동 실행 도구를 설치하고 로그인하세요.',
  },
  imagemagick: {
    action: '고급 이미지 처리 작업을 쓸 때만 준비하세요.',
  },
  windows_ocr: {
    action: '백업 화면의 Windows 언어 설정 열기를 누르거나, Windows 설정의 언어 기능에서 한국어/중국어 문자 인식을 사용할 수 있게 한 뒤 다시 확인하세요.',
    action_command: 'start ms-settings:regionlanguage',
    action_job: { module: 'setup', action: 'open_language_settings', label: 'Windows 언어 설정 열기' },
  },
  windows_ocr_ko: {
    action: '카카오톡 백업에는 Windows 한국어 문자 인식이 필요합니다. 백업 화면의 한국어 문자 인식 설치를 먼저 누르고, 자동 설치가 막히면 Windows 언어 설정에서 한국어를 기본 선택 그대로 설치한 뒤 다시 확인하세요.',
    action_command: 'start ms-settings:regionlanguage',
    action_job: { module: 'setup', action: 'install_ocr_ko', label: '한국어 문자 인식 설치' },
  },
  windows_ocr_zh: {
    action: '위챗 백업에는 Windows 중국어 문자 인식이 필요합니다. 백업 화면의 중국어 문자 인식 설치를 먼저 누르고, 자동 설치가 막히면 Windows 언어 설정에서 중국어(간체, 중국) 또는 중국어(번체, 대만/홍콩) 중 하나를 기본 선택 그대로 설치한 뒤 다시 확인하세요.',
    action_command: 'start ms-settings:regionlanguage',
    action_job: { module: 'setup', action: 'install_ocr_zh', label: '중국어 문자 인식 설치' },
  },
  tesseract: {
    action: '기본 백업은 Windows 문자 인식을 우선 사용합니다. 고급 문자 인식 작업이 필요할 때만 준비하세요.',
  },
  shots_writable: {
    action: '백업을 저장할 수 없습니다. 압축을 푼 폴더를 바탕화면이나 문서처럼 내가 저장할 수 있는 일반 폴더로 옮긴 뒤 1_백업_시작.bat를 다시 실행하세요. OneDrive 동기화 오류가 난 폴더, 회사 보안 폴더, 읽기 전용 폴더는 피하세요.',
  },
  state_writable: {
    action: '설정과 실행 상태를 저장할 수 없습니다. 압축을 푼 폴더를 바탕화면이나 문서처럼 내가 저장할 수 있는 일반 폴더로 옮긴 뒤 1_백업_시작.bat를 다시 실행하세요. OneDrive 동기화 오류가 난 폴더, 회사 보안 폴더, 읽기 전용 폴더는 피하세요.',
  },
  runs_writable: {
    action: '진행 기록을 저장할 수 없습니다. 압축을 푼 폴더를 바탕화면이나 문서처럼 내가 저장할 수 있는 일반 폴더로 옮긴 뒤 1_백업_시작.bat를 다시 실행하세요. OneDrive 동기화 오류가 난 폴더, 회사 보안 폴더, 읽기 전용 폴더는 피하세요.',
  },
  wechat_db: {
    action: '예전 백업 파일이 없어도 지금 열린 위챗 방/왼쪽 목록 백업은 결과 보기에서 볼 수 있습니다. 예전 파일 검사가 필요할 때만 준비하세요.',
  },
  chrome_cdp: {
    action: '웹 자동화를 시작하면 전용 Windows Chrome이 자동으로 열립니다. 열리지 않을 때만 Google Chrome 설치 여부를 확인한 뒤 다시 실행하세요.',
  },
  gui_apps: {
    action: '백업하려면 카카오톡 또는 위챗을 실행하고 로그인하세요. 설치되어 있지 않으면 먼저 설치한 뒤 백업 화면의 앱 열기 버튼을 누르세요.',
  },
  app_kakaotalk: {
    action: '카카오톡 백업을 하려면 카카오톡을 열고 로그인하세요. 설치되어 있지 않으면 백업 화면의 카카오톡 공식 설치 페이지를 누르세요.',
  },
  app_wechat: {
    action: '위챗 백업을 하려면 위챗을 열고 로그인하세요. 설치되어 있지 않으면 백업 화면의 위챗 공식 설치 페이지를 누르세요.',
  },
  ocr_any: {
    action: '카카오톡/위챗 화면 백업에는 문자 인식이 필요합니다. Windows 언어 기능을 먼저 확인하세요.',
  },
  agent_provider: {
    action: '고급 자동 실행을 쓸 때만 고급 자동 실행 도구를 설치하고 로그인하세요. 채팅 백업에는 필수는 아닙니다.',
  },
};

function withAction(item) {
  const guide = actionGuides[item.id] || {};
  const requiredForBeginnerBackup = beginnerCheckIds.has(item.id) || item.id === 'windows_ocr' || item.id === 'ocr_any';
  if (item.status === 'pass') {
    return {
      ...item,
      action: item.id.startsWith('wsl') ? '준비됨. 고급 기능에서 사용할 수 있습니다.' : '준비됐습니다.',
      optional: !requiredForBeginnerBackup,
    };
  }
  return {
    ...item,
    action: guide.action || '필요한 경우 설치 또는 권한을 확인한 뒤 다시 검사하세요.',
    action_command: guide.action_command,
    action_job: guide.action_job,
    optional: !requiredForBeginnerBackup,
  };
}

function run(cmd, args = [], opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeout ?? 3000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    error: result.error?.message || '',
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

function firstLine(text) {
  return String(text || '').split(/\r?\n/u).find(Boolean) || '';
}

function commandCheck(id, label, cmd, args = ['--version'], opts = {}) {
  const result = run(cmd, args, { timeout: opts.timeout ?? 3000 });
  if (result.ok) {
    return check(id, label, 'pass', opts.readyMessage || '준비됐습니다', {
      command: redactPath(cmd),
      version: firstLine(result.stdout || result.stderr) || '',
    });
  }
  const status = opts.required ? 'fail' : 'review';
  return check(id, label, status, '사용할 수 없음', {
    command: cmd,
    error: redactPath(result.error || result.stderr || result.stdout || `exit ${result.status}`),
  });
}

function wslCommandCheck(id, label, command, opts = {}) {
  if (process.platform !== 'win32') return null;
  const result = run('wsl.exe', ['-e', 'bash', '-lc', command], { timeout: opts.timeout ?? 5000 });
  if (result.ok) {
    return check(id, label, 'pass', '고급 기능에서 사용할 수 있습니다', {
      command: 'wsl.exe',
      version: firstLine(result.stdout || result.stderr) || '',
    });
  }
  const status = opts.required ? 'fail' : 'review';
  return check(id, label, status, 'WSL에서 사용할 수 없음', {
    command: 'wsl.exe',
    error: redactPath(result.error || result.stderr || result.stdout || `exit ${result.status}`),
  });
}

function powershellCheck() {
  const result = run('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']);
  if (!result.ok) {
    return check('powershell', 'Windows 기본 실행', 'fail', 'Windows 기본 실행을 사용할 수 없음', {
      error: redactPath(result.error || result.stderr || result.stdout),
    });
  }
  return check('powershell', 'Windows 기본 실행', 'pass', '준비됐습니다', { version: firstLine(result.stdout) || '' });
}

function wslCheck() {
  if (process.platform === 'win32') {
    const result = run('wsl.exe', ['-e', 'sh', '-lc', 'uname -a'], { timeout: 3000 });
    if (result.ok) return check('wsl', '고급 기능 실행 환경', 'pass', '고급 기능에서 사용할 수 있습니다', { version: firstLine(result.stdout) || '' });
    return check('wsl', '고급 기능 실행 환경', 'review', '설치되지 않았거나 기본 실행 환경이 없음. 백업 화면과 Windows 문자 인식 백업에는 선택 항목입니다.', {
      error: redactPath(result.error || result.stderr || result.stdout),
    });
  }
  const interop = existsSync('/proc/sys/fs/binfmt_misc/WSLInterop') || Boolean(process.env.WSL_DISTRO_NAME);
  if (!interop) return check('wsl', '고급 기능 실행 환경', 'review', '고급 기능 실행 환경 표시를 찾지 못함');
  return check('wsl', '고급 기능 실행 환경', 'pass', '고급 기능에서 사용할 수 있습니다', { distribution: process.env.WSL_DISTRO_NAME || '' });
}

function writableCheck(id, label, dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `.doctor_write_${process.pid}`);
    writeFileSync(file, 'ok\n', 'utf8');
    rmSync(file, { force: true });
    return check(id, label, 'pass', '쓰기 가능', { path: redactPath(dir) });
  } catch (err) {
    return check(id, label, 'fail', '쓰기 불가', { path: redactPath(dir), error: redactPath(err.message) });
  }
}

function windowsOcrCheck() {
  const script = `
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $langs = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) { Write-Output 'missing'; exit 1 }
  Write-Output ('available ' + $engine.RecognizerLanguage.LanguageTag + ' / installed ' + ($langs -join ','))
} catch {
  Write-Output $_.Exception.Message
  exit 1
}`;
  const result = run('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { timeout: 5000 });
  if (!result.ok) return check('windows_ocr', 'Windows 문자 인식', 'review', '사용할 수 없음', { error: redactPath(result.stdout || result.stderr || result.error) });
  return check('windows_ocr', 'Windows 문자 인식', 'pass', '문자 인식 사용 가능', { languages: firstLine(result.stdout) || '' });
}

function windowsOcrLanguageCheck(id, label, prefixes, displayName) {
  const prefixList = prefixes.map((it) => String(it).toLowerCase());
  const script = `
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $langs = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
  if ($langs.Count -eq 0) { Write-Output 'none'; exit 1 }
  Write-Output ($langs -join ',')
} catch {
  Write-Output $_.Exception.Message
  exit 1
}`;
  const result = run('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { timeout: 5000 });
  if (!result.ok) {
    return check(id, label, 'review', `${displayName} OCR 언어를 확인하지 못함`, {
      error: redactPath(result.stdout || result.stderr || result.error),
    });
  }
  const langs = firstLine(result.stdout)
    .split(',')
    .map((it) => it.trim())
    .filter(Boolean);
  const ok = langs.some((tag) => {
    const lower = tag.toLowerCase();
    return prefixList.some((prefix) => lower === prefix || lower.startsWith(`${prefix}-`));
  });
  if (ok) return check(id, label, 'pass', `${displayName} 문자 인식 사용 가능`, { languages: langs });
  return check(id, label, 'review', `${displayName} 문자 인식 언어팩 필요`, { languages: langs });
}

function tesseractCheck() {
  return commandCheck('tesseract', '고급 문자 인식 도구', 'tesseract', ['--version'], { required: false });
}

function imagemagickCheck() {
  const magick = commandCheck('imagemagick', '고급 이미지 처리 도구', 'magick', ['-version'], { required: false });
  if (magick.status === 'pass') return magick;
  const convert = commandCheck('imagemagick', '고급 이미지 처리 도구', 'convert', ['-version'], { required: false });
  if (convert.status === 'pass') return convert;
  return magick;
}

function chromeCdpCheck(pathConfig) {
  const stateFile = join(process.platform === 'win32' ? pathConfig.stateDirWin : pathConfig.stateDirWsl, 'chrome_cdp.json');
  let state = {};
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch {}
  const statePort = Number(state.port);
  const port = Number.isInteger(statePort) && statePort >= 1024 && statePort <= 65535
    ? statePort
    : pathConfig.chromeCdpPort;
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    `try { $v = Invoke-RestMethod -Uri 'http://127.0.0.1:${port}/json/version' -TimeoutSec 1; $v | ConvertTo-Json -Compress; exit 0 } catch { exit 1 }`,
  ].join('; ');
  const probe = run('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 4000 });
  if (!probe.ok) {
    return check('chrome_cdp', 'Windows Chrome 웹 자동화', 'review', '웹 작업을 시작하면 Windows Chrome이 자동으로 열립니다', {
      port,
      autoStart: true,
    });
  }
  let version = {};
  try { version = JSON.parse(firstLine(probe.stdout)); } catch {}
  const browser = String(version.Browser || '');
  const userAgent = String(version['User-Agent'] || '');
  const nativeWindowsChrome = /^Chrome\//u.test(browser)
    && userAgent.includes('Windows NT')
    && !userAgent.includes('HeadlessChrome')
    && !userAgent.includes('X11; Linux');
  if (!nativeWindowsChrome) {
    return check('chrome_cdp', 'Windows Chrome 웹 자동화', 'review', 'Windows 화면에 보이는 Chrome이 아닌 연결은 사용하지 않습니다', {
      browser,
      port,
      autoStart: true,
    });
  }
  return check('chrome_cdp', 'Windows Chrome 웹 자동화', 'pass', 'Windows Chrome 자동 실행 연결이 준비됐습니다', {
    browser,
    port,
    visible: state.visible === true,
    autoStart: true,
  });
}

function guiProcessCheck() {
  const script = `
$names = @('KakaoTalk','Weixin','WeChat')
$found = Get-Process -ErrorAction SilentlyContinue | Where-Object { $names -contains $_.ProcessName } | Select-Object -ExpandProperty ProcessName -Unique
$found -join ','
`;
  const result = run('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 5000 });
  if (!result.ok) return check('gui_apps', '앱 실행 상태', 'review', 'Windows 프로세스 목록을 확인하지 못함');
  const found = result.stdout.split(',').map((s) => s.trim()).filter(Boolean).sort();
  if (!found.length) return check('gui_apps', '앱 실행 상태', 'review', '카카오톡/위챗이 실행 중이 아님');
  const displayNames = [...new Set(found.map((name) => ({
    KakaoTalk: '카카오톡',
    Weixin: '위챗',
    WeChat: '위챗',
  }[name] || name)))];
  return check('gui_apps', '앱 실행 상태', 'pass', `실행 중: ${displayNames.join(', ')}`, { running: found });
}

function pathSummary(pathConfig) {
  return {
    configLoaded: pathConfig.configLoaded,
    repoRoot: redactPath(pathConfig.repoRootWsl),
    repoRootWin: redactPath(pathConfig.repoRootWin),
    mirrorRoot: redactPath(pathConfig.mirrorRootWsl),
    scriptsDirWin: redactPath(pathConfig.scriptsDirWin),
    shotsDir: redactPath(pathConfig.shotsDirWsl),
    shotsDirWin: redactPath(pathConfig.shotsDirWin),
    stateDir: redactPath(pathConfig.stateDirWsl),
    stateDirWin: redactPath(pathConfig.stateDirWin),
    runsDir: redactPath(pathConfig.runsDirWsl),
    runsDirWin: redactPath(pathConfig.runsDirWin),
    wechatDb: redactPath(pathConfig.wechatDbWsl),
    wechatDbWin: redactPath(pathConfig.wechatDbWin),
    defaultConsolePort: pathConfig.defaultConsolePort,
    chromeCdpPort: pathConfig.chromeCdpPort,
    agentProvider: pathConfig.agentProvider,
  };
}

async function accessCheck(id, label, file) {
  try {
    await access(file, constants.R_OK);
    return check(id, label, 'pass', '읽기 가능', { path: redactPath(file) });
  } catch {
    return check(id, label, 'review', '없거나 읽을 수 없음', { path: redactPath(file) });
  }
}

const beginnerCheckIds = new Set([
  'node',
  'powershell',
  'windows_ocr_ko',
  'windows_ocr_zh',
  'shots_writable',
  'state_writable',
  'runs_writable',
  'app_kakaotalk',
  'app_wechat',
]);

const commonBackupCheckIds = ['node', 'powershell', 'shots_writable', 'state_writable', 'runs_writable'];

function statusForIds(checks, ids) {
  const selected = ids
    .map((id) => checks.find((item) => item.id === id))
    .filter(Boolean);
  return selected.length ? statusFrom(selected) : 'review';
}

function appRunningStatus(checks, appNames) {
  const gui = checks.find((item) => item.id === 'gui_apps');
  const running = new Set((gui?.details?.running || []).map((name) => String(name)));
  return appNames.some((name) => running.has(name)) ? 'pass' : 'review';
}

function beginnerLabel(item) {
  const labels = {
    node: '백업 화면 실행 도구',
    powershell: 'Windows 기본 실행',
    windows_ocr_ko: '카카오톡 문자 인식',
    windows_ocr_zh: '위챗 문자 인식',
    shots_writable: '백업 저장 폴더',
    state_writable: '설정 저장 폴더',
    runs_writable: '진행 기록 폴더',
    app_kakaotalk: '카카오톡 실행 상태',
    app_wechat: '위챗 실행 상태',
  };
  return labels[item.id] || item.label;
}

function beginnerMessage(item) {
  if (item.id === 'app_kakaotalk' && item.status !== 'pass') return '카카오톡을 열고 로그인하세요.';
  if (item.id === 'app_wechat' && item.status !== 'pass') return '위챗을 열고 로그인하세요.';
  return item.message;
}

function beginnerAction(item) {
  if (item.id === 'node') return '압축을 푼 폴더의 1_백업_시작.bat를 다시 실행하거나 백업 화면 실행 도구를 설치하세요. 보이지 않으면 시작하기.bat를 사용하세요.';
  if (item.id === 'powershell') return 'Windows 기본 실행 상태를 확인한 뒤 1_백업_시작.bat를 다시 실행하세요. 보이지 않으면 시작하기.bat를 사용하세요.';
  if (item.id === 'windows_ocr_ko') return '카카오톡 백업에는 한국어 문자 인식 설치를 먼저 누르고, 막히면 Windows 언어 설정에서 한국어를 기본 선택 그대로 설치하세요.';
  if (item.id === 'windows_ocr_zh') return '위챗 백업에는 중국어 문자 인식 설치를 먼저 누르고, 막히면 Windows 언어 설정에서 중국어(간체, 중국) 또는 중국어(번체, 대만/홍콩) 중 하나를 기본 선택 그대로 설치하세요.';
  if (item.id === 'shots_writable') return '백업을 저장할 수 없습니다. 압축을 푼 폴더를 바탕화면이나 문서처럼 내가 저장할 수 있는 일반 폴더로 옮긴 뒤 1_백업_시작.bat를 다시 실행하세요. OneDrive 동기화 오류가 난 폴더, 회사 보안 폴더, 읽기 전용 폴더는 피하세요.';
  if (item.id === 'state_writable') return '설정과 실행 상태를 저장할 수 없습니다. 압축을 푼 폴더를 바탕화면이나 문서처럼 내가 저장할 수 있는 일반 폴더로 옮긴 뒤 1_백업_시작.bat를 다시 실행하세요. OneDrive 동기화 오류가 난 폴더, 회사 보안 폴더, 읽기 전용 폴더는 피하세요.';
  if (item.id === 'runs_writable') return '진행 기록을 저장할 수 없습니다. 압축을 푼 폴더를 바탕화면이나 문서처럼 내가 저장할 수 있는 일반 폴더로 옮긴 뒤 1_백업_시작.bat를 다시 실행하세요. OneDrive 동기화 오류가 난 폴더, 회사 보안 폴더, 읽기 전용 폴더는 피하세요.';
  if (item.id === 'app_kakaotalk') return '카카오톡을 열고 로그인한 뒤 준비 확인을 다시 누르세요.';
  if (item.id === 'app_wechat') return '위챗을 열고 로그인한 뒤 준비 확인을 다시 누르세요.';
  return item.action;
}

function formatCheckLine(item, label) {
  const mark = label(item.status).padEnd(7);
  return `${mark} ${beginnerLabel(item)}: ${beginnerMessage(item)}`;
}

function formatFullDoctor(report, label) {
  const lines = [];
  const statePath = friendlyRedactedPath(report.paths.stateDirWin || report.paths.stateDir);
  const shotsPath = friendlyRedactedPath(report.paths.shotsDirWin || report.paths.shotsDir);
  const runsPath = friendlyRedactedPath(report.paths.runsDirWin || report.paths.runsDir);
  lines.push(`Computer-Use 준비 확인: ${label(report.status)} (정상 ${report.counts.pass}, 확인 ${report.counts.review}, 실패 ${report.counts.fail})`);
  lines.push(`저장 위치: 설정=${statePath} 백업=${shotsPath} 진행기록=${runsPath}`);
  for (const item of report.checks) {
    const mark = label(item.status).padEnd(7);
    lines.push(`${mark} ${item.label}: ${item.message}`);
    if (item.status !== 'pass' && item.action) lines.push(`       조치: ${item.action}`);
  }
  return lines;
}

export async function runDoctor() {
  const pathConfig = loadPathConfig();
  const shotsDir = process.platform === 'win32' ? pathConfig.shotsDirWin : pathConfig.shotsDirWsl;
  const stateDir = process.platform === 'win32' ? pathConfig.stateDirWin : pathConfig.stateDirWsl;
  const runsDir = process.platform === 'win32' ? pathConfig.runsDirWin : pathConfig.runsDirWsl;
  const wechatDb = process.platform === 'win32' ? pathConfig.wechatDbWin : pathConfig.wechatDbWsl;
  const unixToolsRequired = process.platform !== 'win32';
  const wslToolChecks = [
    wslCommandCheck('wsl_node', '고급 기능 실행 도구', 'node --version'),
    wslCommandCheck('wsl_jq', '고급 기능 자료 처리 도구', 'jq --version'),
    wslCommandCheck('wsl_sqlite3', '예전 파일 확인 도구', 'sqlite3 --version'),
    wslCommandCheck('wsl_tesseract', '고급 기능 문자 인식 도구', 'tesseract --version'),
    wslCommandCheck('wsl_imagemagick', '고급 기능 이미지 처리 도구', 'command -v magick >/dev/null 2>&1 && magick -version || convert -version'),
  ].filter(Boolean);
  const checks = [
    wslCheck(),
    ...wslToolChecks,
    powershellCheck(),
    commandCheck('node', '백업 화면 실행 도구', process.execPath, ['--version'], { required: true }),
    commandCheck('jq', '고급 기능 자료 처리 도구', 'jq', ['--version'], { required: unixToolsRequired }),
    commandCheck('sqlite3', '예전 파일 확인 도구', pathConfig.sqlite3Path || 'sqlite3', ['--version'], { required: unixToolsRequired }),
    commandCheck('codex', '고급 자동 실행 선택 기능', 'codex', ['--version'], { required: false }),
    commandCheck('claude', '고급 자동 실행 선택 기능', 'claude', ['--version'], { required: false }),
    imagemagickCheck(),
    windowsOcrCheck(),
    windowsOcrLanguageCheck('windows_ocr_ko', '카카오톡 문자 인식 언어', ['ko'], '한국어'),
    windowsOcrLanguageCheck('windows_ocr_zh', '위챗 문자 인식 언어', ['zh'], '중국어'),
    tesseractCheck(),
    writableCheck('shots_writable', '백업 저장 폴더', shotsDir),
    writableCheck('state_writable', '설정 저장 폴더', stateDir),
    writableCheck('runs_writable', '진행 기록 폴더', runsDir),
    await accessCheck('wechat_db', '예전 위챗 백업 파일', wechatDb),
    chromeCdpCheck(pathConfig),
    guiProcessCheck(),
  ];
  const kakaoAppStatus = appRunningStatus(checks, ['KakaoTalk']);
  const wechatAppStatus = appRunningStatus(checks, ['Weixin', 'WeChat']);
  checks.push(check(
    'app_kakaotalk',
    '카카오톡 실행 상태',
    kakaoAppStatus,
    kakaoAppStatus === 'pass' ? '카카오톡 실행 중' : '카카오톡 실행 또는 로그인 필요',
  ));
  checks.push(check(
    'app_wechat',
    '위챗 실행 상태',
    wechatAppStatus,
    wechatAppStatus === 'pass' ? '위챗 실행 중' : '위챗 실행 또는 로그인 필요',
  ));

  const ocrChecks = checks.filter((it) => it.id === 'windows_ocr' || it.id === 'tesseract');
  checks.push(check(
    'ocr_any',
    '문자 인식 사용 가능 여부',
    ocrChecks.some((it) => it.status === 'pass') ? 'pass' : 'review',
    ocrChecks.some((it) => it.status === 'pass') ? '문자 인식 경로가 하나 이상 준비됨' : '사용할 앱의 문자 인식 언어를 확인해야 합니다',
  ));
  checks.push(check(
    'agent_provider',
    '자동 실행 도구',
    checks.some((it) => (it.id === 'codex' || it.id === 'claude') && it.status === 'pass') ? 'pass' : 'review',
    checks.some((it) => (it.id === 'codex' || it.id === 'claude') && it.status === 'pass') ? '고급 자동 실행 도구가 준비됨' : '고급 자동 실행은 선택 기능입니다',
  ));

  const enrichedChecks = checks.map(withAction);
  const backupStatus = statusForIds(enrichedChecks, [...commonBackupCheckIds, 'windows_ocr_ko', 'windows_ocr_zh', 'app_kakaotalk', 'app_wechat']);
  const kakaoStatus = statusForIds(enrichedChecks, [...commonBackupCheckIds, 'windows_ocr_ko', 'app_kakaotalk']);
  const wechatStatus = statusForIds(enrichedChecks, [...commonBackupCheckIds, 'windows_ocr_zh', 'app_wechat']);
  const optionalChecks = enrichedChecks.filter((item) => item.optional);
  const optionalStatus = optionalChecks.length ? statusFrom(optionalChecks) : 'pass';
  const status = backupStatus;
  return {
    schema: 'computer-use.doctor.v1',
    generated_at: new Date().toISOString(),
    status,
    backupStatus,
    kakaoStatus,
    wechatStatus,
    optionalStatus,
    paths: pathSummary(pathConfig),
    counts: {
      pass: checks.filter((it) => it.status === 'pass').length,
      review: checks.filter((it) => it.status === 'review').length,
      fail: checks.filter((it) => it.status === 'fail').length,
    },
    checks: enrichedChecks,
  };
}

export function formatDoctor(report, options = {}) {
  const label = (status) => ({
    pass: '준비됨',
    review: '확인 필요',
    fail: '시작 불가',
  }[String(status || '').toLowerCase()] || String(status || '확인'));
  if (options.full) return `${formatFullDoctor(report, label).join('\n')}\n`;

  const checks = Array.isArray(report.checks) ? report.checks : [];
  const beginnerChecks = [...beginnerCheckIds]
    .map((id) => checks.find((item) => item.id === id))
    .filter(Boolean);
  const beginnerStatus = statusFrom(beginnerChecks);
  const beginnerNeeds = beginnerChecks.filter((item) => item.status !== 'pass');
  const optionalChecks = checks.filter((item) => !beginnerCheckIds.has(item.id));
  const optionalReady = optionalChecks.filter((item) => item.status === 'pass').length;
  const optionalNeeds = optionalChecks.filter((item) => item.status !== 'pass').length;
  const shotsPath = friendlyRedactedPath(report.paths.shotsDirWin || report.paths.shotsDir);
  const runsPath = friendlyRedactedPath(report.paths.runsDirWin || report.paths.runsDir);
  const lines = [];

  lines.push(`Computer-Use 준비 확인: ${label(beginnerStatus)} (기본 항목 ${beginnerChecks.length - beginnerNeeds.length}/${beginnerChecks.length}개 준비)`);
  lines.push(`저장 위치: 백업=${shotsPath} 진행기록=${runsPath}`);
  lines.push('');
  lines.push('바로 필요한 항목');
  for (const item of beginnerChecks) {
    lines.push(formatCheckLine(item, label));
    if (item.status !== 'pass') lines.push(`       조치: ${beginnerAction(item)}`);
  }
  lines.push('');
  lines.push(`선택 기능: 준비 ${optionalReady}개, 필요할 때 확인 ${optionalNeeds}개`);
  lines.push('예전 백업 파일 검사나 추가 검수 같은 특별한 작업을 쓸 때만 선택 기능을 준비하면 됩니다.');
  lines.push('선택 기능 상세는 백업 화면의 전체 기술 진단 보기에서 확인합니다.');
  return `${lines.join('\n')}\n`;
}
